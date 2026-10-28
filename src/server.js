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
const workspace = require('./workspace');

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
  'jsqr.js': 'jsqr/dist/jsQR.js',
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

const RAW_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
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
  const failures = new Map();

  // How a request proved itself: a token (header, or WebSocket subprotocol since browsers can't set
  // headers there) works from any origin, so the app opened from one machine can drive the others.
  // The cookie is same-origin only.
  function authKind(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), config.token)) return 'token';
    const proto = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((p) => p.trim())
      .find((p) => p.startsWith('auth.'));
    if (proto && safeEqual(proto.slice(5), config.token)) return 'token';
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    if (cookie && safeEqual(cookie, cookieValue(config.token))) return 'cookie';
    return null;
  }

  function isAuthed(req) {
    return authKind(req) !== null;
  }

  // Requests from other origins carry the token themselves (no cookies), so any origin may ask.
  function setCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    // Chrome's Private Network Access: allow a page on one LAN machine to call another.
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
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

    if (rateLimited(req)) return send(res, 429, { error: 'too many attempts' });
    if (!isAuthed(req)) {
      if (req.headers.authorization) recordFailure(req);
      return send(res, 401, { error: 'unauthorized' });
    }

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
        stats: await workspace.machineStats(),
      });
    }
    if (route === 'GET /api/sessions') return send(res, 200, sessions.list());

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
      if (req.method === 'GET' && action === '/git') {
        return send(res, 200, await workspace.gitChanges(session.cwd, url.searchParams.get('file') || ''));
      }
      if (req.method === 'GET' && action === '/files') {
        try {
          return send(res, 200, workspace.browse(session.cwd, url.searchParams.get('path') || ''));
        } catch (err) {
          return send(res, err.status || 500, { error: err.message });
        }
      }
      if (req.method === 'GET' && action === '/raw') {
        let file;
        try {
          file = workspace.rawFile(session.cwd, url.searchParams.get('path') || '');
        } catch (err) {
          return send(res, err.status || 500, { error: err.message });
        }
        const type = RAW_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        // Never let a served file run as a page on this origin.
        res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
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
      const body = await readJsonBody(req);
      try {
        // New form: { subscription, vapid, device }; the bare subscription is still accepted.
        if (body.subscription) notifier.subscribe(body.subscription, { vapid: body.vapid, device: body.device });
        else notifier.subscribe(body);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
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
      if (url.pathname.startsWith('/api/')) {
        setCors(req, res);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        return await api(req, res, url);
      }

      // Older login links put the token in the query; move it to the fragment, which the app
      // reads and which never reaches server logs.
      if (url.pathname === '/' && url.searchParams.has('token')) {
        res.writeHead(302, { Location: `/#token=${encodeURIComponent(url.searchParams.get('token'))}` });
        return res.end();
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
    // Echo the plain protocol name; the auth.<token> entry is never sent back.
    handleProtocols: (protocols) => (protocols.has('remota') ? 'remota' : false),
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
    // Cross-site WebSocket hijacking only works with ambient cookies; a token-authenticated
    // socket may come from the app opened on another machine.
    const kind = authKind(req);
    if (url.pathname !== '/ws' || !kind || (kind === 'cookie' && !sameOrigin)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  });

  wss.on('connection', (ws, url) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
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
  server.on('close', () => clearInterval(heartbeat));

  return { server, sessions, notifier, useTls };
}

module.exports = { createServer, cookieValue };
