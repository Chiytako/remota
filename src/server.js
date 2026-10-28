'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { CONFIG_DIR } = require('./config');
const { Notifier } = require('./notify');
const { SessionManager } = require('./sessions');
const { NodeRegistry } = require('./nodes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MODULES_DIR = path.join(__dirname, '..', 'node_modules');
const UPLOAD_DIR = path.join(CONFIG_DIR, 'uploads');
const MAX_UPLOAD = 25 * 1024 * 1024;
const COOKIE = 'remota_auth';

// Browser bundles served from node_modules so the app works without internet access.
const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The cookie stores a digest of the token, not the token itself.
function cookieValue(token) {
  return crypto.createHmac('sha256', token).update('remota-session').digest('base64url');
}

function createServer(config) {
  const notifier = new Notifier(config);
  const sessions = new SessionManager(config, notifier);
  sessions.restore();
  const nodes = new NodeRegistry(config, notifier, sessions);
  nodes.start();
  const localInfo = () => ({ hostname: os.hostname(), user: os.userInfo().username });
  const failures = new Map();

  function isAuthed(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), config.token)) return true;
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    return Boolean(cookie) && safeEqual(cookie, cookieValue(config.token));
  }

  function rateLimited(req) {
    const ip = req.socket.remoteAddress;
    const entry = failures.get(ip);
    return entry && entry.count >= 10 && Date.now() - entry.at < 10 * 60 * 1000;
  }

  function recordFailure(req) {
    const ip = req.socket.remoteAddress;
    const entry = failures.get(ip) || { count: 0, at: 0 };
    if (Date.now() - entry.at > 10 * 60 * 1000) entry.count = 0;
    entry.count += 1;
    entry.at = Date.now();
    failures.set(ip, entry);
  }

  function setAuthCookie(req, res) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${cookieValue(config.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`);
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('payload too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJsonBody(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
  }

  function serveFile(res, file, cache = 'no-cache') {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(data);
    });
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /api/login') {
      if (rateLimited(req)) return send(res, 429, { error: 'too many attempts' });
      const { token } = await readJsonBody(req);
      if (!token || !safeEqual(token, config.token)) {
        recordFailure(req);
        return send(res, 401, { error: 'invalid token' });
      }
      setAuthCookie(req, res);
      return send(res, 200, { ok: true });
    }

    if (!isAuthed(req)) return send(res, 401, { error: 'unauthorized' });

    if (route === 'POST /api/logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
      return send(res, 200, { ok: true });
    }
    if (route === 'GET /api/info') {
      return send(res, 200, {
        hostname: os.hostname(),
        user: os.userInfo().username,
        tmux: sessions.useTmux,
        defaultCwd: config.defaultCwd,
        presets: config.presets,
        vapidPublicKey: notifier.publicKey,
      });
    }
    if (route === 'GET /api/sessions') return send(res, 200, sessions.list());

    // ----- multiple devices (this server acting as the hub) -----
    if (route === 'GET /api/overview') return send(res, 200, nodes.overview(localInfo()));
    if (route === 'GET /api/nodes') return send(res, 200, nodes.overview(localInfo()).nodes);
    if (route === 'POST /api/nodes') {
      try {
        return send(res, 201, await nodes.add(await readJsonBody(req)));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    const nm = url.pathname.match(/^\/api\/nodes\/([0-9a-z]+)$/);
    if (nm) {
      if (nm[1] === 'local') {
        if (req.method !== 'PATCH') return send(res, 400, { error: 'この機器は削除できません' });
        const { name } = await readJsonBody(req);
        config.localName = String(name || '').trim().slice(0, 40);
        require('./config').save(config);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') {
        try {
          const updated = nodes.update(nm[1], await readJsonBody(req));
          return updated ? send(res, 200, updated) : send(res, 404, { error: 'no such device' });
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      if (req.method === 'DELETE') return send(res, nodes.remove(nm[1]) ? 200 : 404, { ok: true });
    }
    // /api/n/<device>/<path> is relayed to that device's /api/<path>.
    const pm = url.pathname.match(/^\/api\/n\/([0-9a-z]+)\/(.+)$/);
    if (pm) {
      const node = nodes.get(pm[1]);
      if (!node) return send(res, 404, { error: 'no such device' });
      return nodes.proxyHttp(node, req, res, `/api/${pm[2]}${url.search}`);
    }
    if (route === 'POST /api/sessions') {
      const body = await readJsonBody(req);
      try {
        return send(res, 201, sessions.create(body).toJSON());
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    const m = url.pathname.match(/^\/api\/sessions\/([0-9a-f]+)(\/[a-z]+)?$/);
    if (m) {
      const session = sessions.get(m[1]);
      if (!session) return send(res, 404, { error: 'no such session' });
      const action = m[2] || '';
      if (req.method === 'PATCH' && !action) {
        const { name } = await readJsonBody(req);
        return send(res, 200, sessions.rename(session.id, name).toJSON());
      }
      if (req.method === 'DELETE' && !action) {
        sessions.remove(session.id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === '/scroll') {
        const { direction, lines } = await readJsonBody(req);
        return send(res, 200, { ok: session.scroll(direction, lines) });
      }
      if (req.method === 'GET' && action === '/text') {
        const text = session.text(Number(url.searchParams.get('lines')) || 3000);
        return send(res, 200, { text });
      }
      if (req.method === 'POST' && action === '/input') {
        // Lets scripts and shortcuts type into a session without a WebSocket.
        const { data } = await readJsonBody(req);
        session.write(String(data || ''));
        return send(res, 200, { ok: true });
      }
    }

    if (route === 'POST /api/upload') {
      let rawName = String(req.headers['x-filename'] || 'upload');
      try {
        rawName = decodeURIComponent(rawName);
      } catch {
        // keep as sent
      }
      const name = path.basename(rawName).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80) || 'upload';
      const buf = await readBody(req, MAX_UPLOAD);
      const sessionId = url.searchParams.get('session');
      const session = sessionId && sessions.get(sessionId);
      // Files go next to the session's work so the agent can read them by a short relative path.
      const dir = session ? path.join(session.cwd, '.remota-uploads') : UPLOAD_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const ignore = path.join(dir, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      return send(res, 201, { path: file, relative: session ? path.relative(session.cwd, file) : file, size: buf.length });
    }

    if (route === 'POST /api/push/subscribe') {
      notifier.subscribe(await readJsonBody(req));
      return send(res, 201, { ok: true });
    }
    if (route === 'POST /api/push/unsubscribe') {
      const { endpoint } = await readJsonBody(req);
      notifier.unsubscribe(endpoint);
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/push/test') {
      await notifier.send({ title: 'Remota', body: 'テスト通知です 🎉', tag: 'test' });
      return send(res, 200, { ok: true, subscribers: notifier.subscriptions.length });
    }

    // For agent hooks (e.g. Claude Code's Stop / Notification hooks): `remota notify "..."`.
    if (route === 'POST /api/notify') {
      const body = await readJsonBody(req);
      const session = body.session && sessions.get(body.session);
      const title = String(body.title || (session ? session.name : 'Remota')).slice(0, 120);
      const message = String(body.message || body.body || '完了しました').slice(0, 500);
      if (session && body.status) session.setStatus(body.status === 'waiting' ? 'waiting' : 'idle');
      if (session) session.recordAlert(title, message);
      await notifier.send({ title, body: message, sessionId: session ? session.id : undefined });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);

      // A login link from the QR code: set the cookie, then drop the token from the address bar.
      if (url.pathname === '/' && url.searchParams.has('token')) {
        if (!rateLimited(req) && safeEqual(url.searchParams.get('token'), config.token)) {
          setAuthCookie(req, res);
          res.writeHead(302, { Location: '/' });
          return res.end();
        }
        recordFailure(req);
      }

      if (url.pathname.startsWith('/vendor/')) {
        const rel = VENDOR[url.pathname.slice('/vendor/'.length)];
        if (!rel) return send(res, 404, 'not found');
        return serveFile(res, path.join(MODULES_DIR, rel), 'public, max-age=86400');
      }

      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
      return serveFile(res, file);
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    }
  }

  const useTls = Boolean(config.tls && config.tls.cert && config.tls.key);
  const server = useTls
    ? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, handler)
    : http.createServer(handler);

  // Terminal output is highly compressible text; deflate makes a big difference on mobile data.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 6 } },
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // Reject cross-site WebSocket hijacking: the page must come from this same host.
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try {
      sameOrigin = sameOrigin || new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (url.pathname !== '/ws' || !sameOrigin || !isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  });

  wss.on('connection', (ws, url) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const nodeId = url.searchParams.get('node');
    if (nodeId && nodeId !== 'local') {
      const node = nodes.get(nodeId);
      if (!node) return ws.close(4404, 'no such device');
      return nodes.proxyWs(node, ws, url.searchParams);
    }
    const session = sessions.get(url.searchParams.get('session'));
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', error: 'no such session' }));
      return ws.close(4404, 'no such session');
    }
    const cols = Number(url.searchParams.get('cols'));
    const rows = Number(url.searchParams.get('rows'));
    if (cols && rows) session.resize(cols, rows);
    const clientId = (url.searchParams.get('client') || '').slice(0, 64);
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
    const resumed = session.attach(ws, { since, epoch: url.searchParams.get('epoch'), clientId });
    if (!resumed) setTimeout(() => session.redraw(), 50);

    let ackTimer = null;
    let lastAck = 0;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        session.input(clientId, msg.n, msg.data);
        if (Number.isInteger(msg.n)) {
          lastAck = Math.max(lastAck, msg.n);
          ackTimer = ackTimer || setTimeout(() => {
            ackTimer = null;
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ack', n: lastAck }));
          }, 20);
        }
      }
      else if (msg.type === 'resize') session.resize(msg.cols, msg.rows);
      else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
    });
    ws.on('close', () => session.detach(ws));
  });

  // Drop connections that silently died (phone went to sleep, network changed).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  server.on('close', () => {
    clearInterval(heartbeat);
    nodes.stop();
  });

  return { server, sessions, notifier, useTls };
}

module.exports = { createServer, cookieValue };
