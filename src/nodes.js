'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');
const { save } = require('./config');

// A hub keeps a registry of other machines running Remota ("devices") and relays the phone's
// requests to them, so the phone needs only one URL, one login and one push subscription.

const POLL_MS = 3000;
const TIMEOUT_MS = 5000;

function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('URLの形式が正しくありません（例: http://192.168.1.20:7681）');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('http:// または https:// で始まるURLを指定してください');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function friendlyError(err) {
  const code = err.code || '';
  if (code === 'ECONNREFUSED') return 'Remota が起動していません';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'ホスト名が見つかりません';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'ネットワークに到達できません';
  if (code === 'ECONNRESET') return '接続が切断されました';
  if (/certificate|SSL|TLS/i.test(err.message)) return 'HTTPS証明書のエラー';
  return err.message;
}

class NodeRegistry {
  constructor(config, notifier, localSessions) {
    this.config = config;
    this.notifier = notifier;
    this.local = localSessions;
    if (!Array.isArray(config.nodes)) config.nodes = [];
    // Live state per remote device: reachability, latency, last known sessions.
    this.live = new Map();
    this.timer = null;
  }

  start() {
    this.pollAll();
    this.timer = setInterval(() => this.pollAll(), POLL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  get(id) {
    return this.config.nodes.find((n) => n.id === id);
  }

  persist() {
    save(this.config);
  }

  async add({ name, url, token }) {
    const node = { id: crypto.randomBytes(4).toString('hex'), name: String(name || '').trim().slice(0, 40), url: normalizeUrl(url), token: String(token || '').trim() };
    if (!node.token) throw new Error('アクセストークンを入力してください');
    if (this.config.nodes.some((n) => n.url === node.url)) throw new Error('このURLの機器はすでに登録されています');
    // Verify before saving so a typo shows up right away rather than as a mysterious offline device.
    const info = await this.request(node, 'GET', '/api/info').catch((err) => {
      throw new Error(`接続できませんでした: ${friendlyError(err)}`);
    });
    if (info.status === 401) throw new Error('トークンが違います');
    if (info.status !== 200) throw new Error(`接続できませんでした (HTTP ${info.status})`);
    if (!node.name) node.name = info.json.hostname || new URL(node.url).hostname;
    this.config.nodes.push(node);
    this.persist();
    await this.poll(node);
    return this.describe(node);
  }

  update(id, { name, url, token }) {
    const node = this.get(id);
    if (!node) return null;
    if (name !== undefined) node.name = String(name).trim().slice(0, 40) || node.name;
    if (url !== undefined) node.url = normalizeUrl(url);
    if (token) node.token = String(token).trim();
    this.persist();
    this.poll(node);
    return this.describe(node);
  }

  remove(id) {
    const before = this.config.nodes.length;
    this.config.nodes = this.config.nodes.filter((n) => n.id !== id);
    this.live.delete(id);
    this.persist();
    return this.config.nodes.length !== before;
  }

  describe(node) {
    const live = this.live.get(node.id) || {};
    return {
      id: node.id,
      name: node.name,
      url: node.url,
      local: false,
      online: Boolean(live.online),
      latency: live.latency ?? null,
      error: live.error || null,
      hostname: live.info ? live.info.hostname : null,
      user: live.info ? live.info.user : null,
      lastSeen: live.lastSeen || null,
    };
  }

  // Devices and every session on them, for the phone's overview screen.
  overview(localInfo) {
    const nodes = [
      { id: 'local', name: this.config.localName || localInfo.hostname, url: null, local: true, online: true, latency: 0, error: null, hostname: localInfo.hostname, user: localInfo.user, lastSeen: Date.now() },
      ...this.config.nodes.map((n) => this.describe(n)),
    ];
    const sessions = this.local.list().map((s) => ({ ...s, node: 'local' }));
    for (const node of this.config.nodes) {
      const live = this.live.get(node.id);
      if (live && live.sessions) sessions.push(...live.sessions.map((s) => ({ ...s, node: node.id, stale: !live.online })));
    }
    return { nodes, sessions };
  }

  async pollAll() {
    await Promise.all(this.config.nodes.map((n) => this.poll(n)));
  }

  async poll(node) {
    const live = this.live.get(node.id) || { alerts: new Map() };
    this.live.set(node.id, live);
    const started = Date.now();
    try {
      const res = await this.request(node, 'GET', '/api/sessions');
      if (res.status !== 200) throw new Error(res.status === 401 ? 'トークンが違います' : `HTTP ${res.status}`);
      live.latency = Date.now() - started;
      live.online = true;
      live.error = null;
      live.lastSeen = Date.now();
      this.relayAlerts(node, live, res.json);
      live.sessions = res.json;
      if (!live.info || Date.now() - (live.infoAt || 0) > 60000) {
        const info = await this.request(node, 'GET', '/api/info').catch(() => null);
        if (info && info.status === 200) {
          live.info = info.json;
          live.infoAt = Date.now();
        }
      }
    } catch (err) {
      live.online = false;
      live.error = friendlyError(err);
    }
  }

  // Each device counts the alerts it raised (waiting / finished / hook messages); a rising count
  // is forwarded to the phone as a push from the hub, labelled with the device name.
  relayAlerts(node, live, sessions) {
    const first = !live.alertsPrimed;
    live.alertsPrimed = true;
    for (const s of sessions) {
      const seen = live.alerts.get(s.id);
      live.alerts.set(s.id, s.alertSeq || 0);
      if (first || seen === undefined || !s.alertSeq || s.alertSeq <= seen || !s.lastAlert) continue;
      this.notifier
        .send({ title: `${node.name} / ${s.lastAlert.title || s.name}`, body: s.lastAlert.body || '', sessionId: s.id, node: node.id })
        .catch(() => {});
    }
  }

  request(node, method, path, body) {
    return new Promise((resolve, reject) => {
      const target = new URL(node.url + path);
      const lib = target.protocol === 'https:' ? https : http;
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = lib.request(target, {
        method,
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${node.token}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('タイムアウト')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  // Streams an API request from the phone to the device (uploads included), swapping in the device's token.
  proxyHttp(node, req, res, apiPath) {
    const target = new URL(node.url + apiPath);
    const lib = target.protocol === 'https:' ? https : http;
    const headers = { Authorization: `Bearer ${node.token}` };
    for (const h of ['content-type', 'content-length', 'x-filename']) if (req.headers[h]) headers[h] = req.headers[h];
    const upstream = lib.request(target, { method: req.method, headers, timeout: 60000 }, (up) => {
      res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' });
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `機器に接続できません: ${err.message}` }));
    });
    req.pipe(upstream);
  }

  // Relays a terminal WebSocket between the phone and the device, message for message.
  proxyWs(node, client, query) {
    const target = new URL(`${node.url.replace(/^http/, 'ws')}/ws`);
    for (const [k, v] of query) if (k !== 'node') target.searchParams.set(k, v);
    const upstream = new WebSocket(target, { headers: { Authorization: `Bearer ${node.token}` }, handshakeTimeout: TIMEOUT_MS });
    const queue = [];
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (queue.length < 1000) queue.push([data, isBinary]);
    });
    upstream.on('open', () => {
      for (const [data, isBinary] of queue) upstream.send(data, { binary: isBinary });
      queue.length = 0;
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    const closeCode = (code) => (code === 4404 ? 4404 : 1011);
    upstream.on('close', (code) => client.readyState <= 1 && client.close(closeCode(code), 'device closed'));
    upstream.on('error', () => client.readyState <= 1 && client.close(1011, 'device unreachable'));
    client.on('close', () => upstream.readyState <= 1 && upstream.terminate());
  }
}

module.exports = { NodeRegistry, normalizeUrl };
