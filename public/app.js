'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

const $ = (sel) => document.querySelector(sel);

// ---------- persisted per-device preferences ----------

const DEFAULT_KEYS = `Esc=\\e
Tab=\\t
⇧Tab=\\e[Z
Ctrl=@ctrl
^C=\\x03
↑=\\e[A
↓=\\e[B
←=\\e[D
→=\\e[C
⏎=\\r
⌫=\\x7f
1=1
2=2
3=3
y=y
n=n
PgUp=@pgup
PgDn=@pgdn
/=/
Esc×2=\\e\\e
^O=\\x0f
^R=\\x12
^L=\\x0c
^D=\\x04
^Z=\\x1a`;

const DEFAULT_SNIPPETS = `続けてください
/compact
/clear
/cost
git status
git diff --stat
テストを実行して、失敗したら直してください
変更内容を要約して`;

// Keys that repeat while held, like a hardware keyboard.
const REPEATABLE = new Set(['\\e[A', '\\e[B', '\\e[C', '\\e[D', '\\x7f', '@pgup', '@pgdn']);

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`remota.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`remota.${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode); settings just won't persist
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(`remota.${key}`);
    } catch {
      // ignore
    }
  },
};

const THEMES = {
  midnight: { background: '#05080c', foreground: '#e6edf3', cursor: '#5aa9ff', cursorAccent: '#05080c', selectionBackground: '#264f78' },
  dracula: {
    background: '#1e1f29', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  solarized: {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  light: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#1f6feb', selectionBackground: '#b6d4fe',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};

function unescapeSeq(s) {
  return s
    .replace(/\\e/g, '\x1b')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\\/g, '\\');
}

function parseKeys(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=', 1);
      if (i < 0) return { label: line, seq: line };
      return { label: line.slice(0, i), seq: line.slice(i + 1) };
    });
}

function randomId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- small helpers ----------

let toastTimer;
function toast(msg, { ms = 2200, onClick = null } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('clickable', Boolean(onClick));
  el.onclick = () => {
    el.hidden = true;
    if (onClick) onClick();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function haptic(ms = 8) {
  if (prefs.get('haptics', true) && navigator.vibrate) navigator.vibrate(ms);
}

function timeAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分前`;
  if (s < 86400) return `${Math.round(s / 3600)}時間前`;
  return `${Math.round(s / 86400)}日前`;
}

const STATUS_LABEL = { running: '実行中', idle: '待機', waiting: '承認待ち', exited: '終了' };
const STATUS_ORDER = { waiting: 0, running: 1, idle: 2, exited: 3 };

function showView(name) {
  // The lock screen is an overlay managed on its own, never by navigation.
  for (const v of document.querySelectorAll('.view:not(#view-lock)')) v.hidden = v.id !== `view-${name}`;
}

// Keep the layout above the on-screen keyboard (iOS doesn't resize the layout viewport).
function trackViewport() {
  const vv = window.visualViewport;
  const update = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${h}px`);
    document.body.classList.toggle('keyboard-open', vv ? window.innerHeight - vv.height > 120 : false);
    window.scrollTo(0, 0);
    if (term.instance) term.fitSoon();
  };
  (vv || window).addEventListener('resize', update);
  if (vv) vv.addEventListener('scroll', () => window.scrollTo(0, 0));
  update();
}

// Agents print a lot of dim grey text; on a small, bright-lit phone screen it needs a contrast boost.
function readabilityOptions() {
  return {
    minimumContrastRatio: Number(prefs.get('contrast', highContrastDefault() ? 7 : 4.5)),
    lineHeight: Number(prefs.get('lineHeight', 1.15)),
    fontWeight: prefs.get('boldText', false) ? '500' : 'normal',
    fontWeightBold: prefs.get('boldText', false) ? '800' : 'bold',
  };
}

function highContrastDefault() {
  return window.matchMedia && matchMedia('(prefers-contrast: more)').matches;
}

function applyReadability() {
  document.documentElement.style.setProperty('--ui-scale', prefs.get('uiScale', 1));
  document.documentElement.dataset.contrast = Number(prefs.get('contrast', highContrastDefault() ? 7 : 4.5)) >= 7 ? 'high' : 'normal';
  if (term.instance) {
    Object.assign(term.instance.options, readabilityOptions());
    term.fitSoon();
  }
}

function applyTheme() {
  const name = prefs.get('theme', 'midnight');
  document.documentElement.dataset.theme = name;
  const theme = THEMES[name] || THEMES.midnight;
  document.querySelector('meta[name="theme-color"]').content = name === 'light' ? '#ffffff' : '#0b0f14';
  if (term.instance) term.instance.options.theme = theme;
}

// ---------- devices: the machines this phone talks to, stored on the phone ----------

// There is no central server: each machine runs Remota on its own and the app talks to every one
// of them directly, authenticating with that machine's token.
const devices = {
  list: prefs.get('devices', []),
  get(id) {
    return this.list.find((d) => d.id === id);
  },
  save() {
    prefs.set('devices', this.list);
    publishDeviceNames();
  },
};

function normalizeDeviceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('URLの形式が正しくありません（機器で `remota url` を実行すると表示されます）');
  }
  // Pairing link from the machine's QR code: every address, the token and the key pin.
  if (url.protocol === 'remota:') {
    const q = url.searchParams;
    const port = q.get('p') || '7681';
    const host = (h) => (h.includes(':') ? `[${h}]` : h);
    const alts = (q.get('a') || '').split(',').filter(Boolean).map((h) => `https://${host(h)}:${port}`);
    if (!alts.length) throw new Error('ペアリングリンクにアドレスがありません');
    return { url: alts[0], alts, token: q.get('t') || '', pin: q.get('k') || '', name: q.get('n') || '' };
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('http:// または https:// で始まるURLを指定してください');
  const params = new URLSearchParams(url.hash.slice(1));
  const token = params.get('token') || url.searchParams.get('token') || '';
  // A machine's QR code points at its certificate setup page (http://host:7680/setup#…&https=7681);
  // the app talks to the HTTPS port named there.
  if (url.pathname === '/setup') {
    const https = `https://${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${params.get('https') || Number(url.port || 80) + 1}`;
    return { url: https, alts: [https], token, pin: params.get('k') || '' };
  }
  // An HTTPS page may not call plain-HTTP machines (mixed content); Remota serves HTTPS by default.
  if (location.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:';
  return { url: url.origin, token };
}

class DeviceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(dev, path, opts = {}) {
  if (!dev) throw new DeviceError('機器が見つかりません', 404);
  // A machine may answer on several addresses (home LAN, VPN…); try the others when one is unreachable
  // and remember the one that worked.
  const urls = [dev.url, ...(dev.alts || []).filter((u) => u !== dev.url)];
  // While a machine is being added we don't know which address works yet: ask them all at once.
  if (urls.length > 1 && !devices.get(dev.id) && (opts.method || 'GET').toUpperCase() === 'GET') {
    const errors = [];
    try {
      const hit = await Promise.any(urls.map((u) => requestAt(dev, u, path, opts).then((data) => ({ u, data }), (e) => {
        errors.push(`${new URL(u).host}: ${e.message}`);
        throw e;
      })));
      dev.url = hit.u;
      return hit.data;
    } catch (agg) {
      const real = (agg.errors || []).find((x) => x.status !== 0 || /鍵が登録時と一致/.test(x.message));
      if (real) throw real;
      throw new DeviceError(`${errors.join(' / ')}。機器と同じネットワーク（Wi-Fi や VPN）にいるか、機器で \`remota doctor\` を実行して確認してください。`, 0);
    }
  }
  try {
    return await requestAt(dev, urls[0], path, opts);
  } catch (ex) {
    if (ex.status !== 0 || urls.length === 1 || /鍵が登録時と一致/.test(ex.message)) throw ex;
    // The usual address is unreachable (e.g. away from home): ask all the others at once and keep
    // the first that answers. Only reads go out in parallel; writes must never be sent twice.
    const method = (opts.method || 'GET').toUpperCase();
    const errors = [`${new URL(urls[0]).host}: ${ex.message}`];
    const attempt = (u) =>
      requestAt(dev, u, path, opts).then(
        (data) => ({ u, data }),
        (e) => {
          errors.push(`${new URL(u).host}: ${e.message}`);
          throw e;
        }
      );
    let hit = null;
    if (method === 'GET') {
      try {
        hit = await Promise.any(urls.slice(1).map(attempt));
      } catch (agg) {
        const real = agg.errors.find((x) => x.status !== 0 || /鍵が登録時と一致/.test(x.message));
        if (real) throw real;
      }
    } else {
      for (const u of urls.slice(1)) {
        try {
          hit = await attempt(u);
          break;
        } catch (e) {
          if (e.status !== 0) throw e;
        }
      }
    }
    if (!hit) {
      // Say which addresses were tried, so a firewall or wrong network is easy to spot.
      throw new DeviceError(`${errors.join(' / ')}。機器と同じネットワーク（Wi-Fi や VPN）にいるか、機器で \`remota doctor\` を実行して確認してください。`, 0);
    }
    // Remember the address that answered (also while a machine is being added, before it is saved).
    dev.url = hit.u;
    if (devices.get(dev.id)) devices.save();
    return hit.data;
  }
}

async function requestAt(dev, base, path, opts) {
  if (NATIVE) {
    const headers = { ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) };
    const res = await nativeFetch(dev, base, `/api/${path}`, { method: opts.method || 'GET', headers, body: opts.body, timeout: opts.timeout || 20000 });
    let data = {};
    try {
      data = JSON.parse(new TextDecoder().decode(res.bytes));
    } catch {
      // not JSON
    }
    if (res.status === 401) throw new DeviceError('トークンが違います', 401);
    if (res.status === 429) throw new DeviceError('試行回数が多すぎます。しばらく待ってください', 429);
    if (res.status >= 400) throw new DeviceError(data.error || `HTTP ${res.status}`, res.status);
    return data;
  }
  let res;
  try {
    res = await fetch(`${base}/api/${path}`, {
      method: opts.method || 'GET',
      body: opts.body,
      headers: {
        Authorization: `Bearer ${dev.token}`,
        ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(opts.timeout || 20000) : undefined,
    });
  } catch (ex) {
    throw new DeviceError(ex.name === 'TimeoutError' ? '応答がありません' : '接続できません', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new DeviceError('トークンが違います', 401);
  if (res.status === 429) throw new DeviceError('試行回数が多すぎます。しばらく待ってください', 429);
  if (!res.ok) throw new DeviceError(data.error || `HTTP ${res.status}`, res.status);
  return data;
}

function devApi(id, path, opts) {
  return request(devices.get(id), path, opts);
}

// The service worker shows pushes from every machine and needs their names; it can't read
// localStorage, so the names are handed over through the Cache API.
function publishDeviceNames() {
  const names = Object.fromEntries(devices.list.map((d) => [d.id, d.name]));
  if (NATIVE) return NATIVE.setDeviceNames(JSON.stringify(names));
  if (!('caches' in window)) return;
  caches.open('remota-meta').then((c) => c.put('/__remota/devices.json', new Response(JSON.stringify(names)))).catch(() => {});
}

// ---------- running inside the Android app ----------

// In the Android app the UI runs from bundled files and talks to machines through the native
// side (window.RemotaNative), which pins each machine's key — no certificate to install. In a
// browser NATIVE is null and the usual fetch/WebSocket paths are used.
const NATIVE = window.RemotaNative || null;
const nativeCalls = new Map();
const nativeSockets = new Map();
let nativeSeq = 0;

function bytesFromB64(b64) {
  const s = atob(b64 || '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function bodyToB64(body) {
  if (body == null) return null;
  const bytes = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new TextEncoder().encode(String(body));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const nativeDevice = (dev, url = dev.url) => JSON.stringify({ url, token: dev.token, pin: dev.pin || '' });

// One HTTP request through the pinned native client: resolves { status, type, bytes } or rejects.
function nativeFetch(dev, url, path, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `r${++nativeSeq}`;
    const timer = setTimeout(() => {
      nativeCalls.delete(id);
      reject(new DeviceError('応答がありません', 0));
    }, timeout);
    nativeCalls.set(id, (status, type, b64, error) => {
      clearTimeout(timer);
      if (error) reject(new DeviceError(error, 0));
      else resolve({ status, type, bytes: bytesFromB64(b64) });
    });
    bodyToB64(body).then((b64) => NATIVE.request(id, nativeDevice(dev, url), method, path, JSON.stringify(headers), b64));
  });
}

// WebSocket look-alike over the native client, so the terminal code doesn't care where it runs.
class NativeSocket {
  constructor(dev, pathAndQuery) {
    this.id = `w${++nativeSeq}`;
    this.readyState = 0;
    nativeSockets.set(this.id, this);
    NATIVE.wsOpen(this.id, nativeDevice(dev), pathAndQuery);
  }
  send(text) {
    if (this.readyState === 1) NATIVE.wsSend(this.id, text);
  }
  close() {
    if (this.readyState > 1) return;
    this.readyState = 2;
    NATIVE.wsClose(this.id);
  }
  event(type, data) {
    if (type === 'open') {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    } else if (type === 'message') {
      if (this.onmessage) this.onmessage({ data });
    } else if (type === 'error') {
      this.lastError = data;
    } else if (type === 'close') {
      this.readyState = 3;
      nativeSockets.delete(this.id);
      if (this.onclose) this.onclose({ code: Number(data) || 1006 });
    }
  }
}

function copyText(text) {
  if (NATIVE) {
    NATIVE.copyText(text);
    return Promise.resolve();
  }
  return navigator.clipboard.writeText(text);
}

window.RemotaBridge = {
  onResponse(id, status, type, b64, error) {
    const cb = nativeCalls.get(id);
    nativeCalls.delete(id);
    if (cb) cb(status, type, b64, error);
  },
  onWs(id, type, data) {
    const s = nativeSockets.get(id);
    if (s) s.event(type, data);
  },
  onPush() {
    registerPush(devices.list).catch(() => {});
    if (state.tab === 'settings') updatePushState();
  },
  onAuth(id, ok) {
    const cb = nativeCalls.get(id);
    nativeCalls.delete(id);
    if (cb) cb(ok);
  },
  onIntent(ev) {
    handleNativeIntent(ev);
  },
  onResume() {
    term.reconnectNow();
    if (devices.list.length) refreshSessions();
  },
  // Android back button: close a sheet, leave the terminal, or go to the first tab; false lets the app close.
  back() {
    const open = [...document.querySelectorAll('dialog[open]')].pop();
    if (open) {
      open.close('cancel');
      return true;
    }
    if (!$('#view-term').hidden) {
      location.hash = '#/';
      return true;
    }
    if (!$('#view-home').hidden && state.tab && state.tab !== 'sessions') {
      switchTab('sessions');
      return true;
    }
    return false;
  },
};

async function handleNativeIntent(ev) {
  if (!ev) return;
  if (ev.type === 'open' && ev.device && ev.session && devices.get(ev.device)) {
    openSession(ev.device, ev.session);
  } else if (ev.type === 'pair') {
    try {
      const dev = await addDevice({ url: ev.link });
      toast(`「${dev.name}」を追加しました`);
      if (!$('#view-login').hidden) await boot();
      else refreshSessions();
    } catch (ex) {
      toast(ex.message, { ms: 5000 });
    }
  }
}

function nativeAuthenticate() {
  return new Promise((resolve) => {
    const id = `a${++nativeSeq}`;
    nativeCalls.set(id, (ok) => resolve(Boolean(ok)));
    NATIVE.authenticate(id);
  });
}

// ---------- state ----------

const state = {
  sessions: [],
  statuses: new Map(),
  nodes: [],
  // Per-device reachability, latency, info and sessions from the last poll.
  live: new Map(),
  newNode: null,
  pollTimer: null,
  presetIndex: 0,
};

// ---------- first run: register the machine this app was opened from ----------

function showLogin() {
  stopPolling();
  term.close();
  showView('login');
}

// Adds a machine after checking that it answers and the token is right; updates it if already known.
async function addDevice({ name, url, token }) {
  const target = normalizeDeviceUrl(url);
  const dev = { id: randomId().slice(0, 8), name: '', url: target.url, token: String(token || target.token || '').trim() };
  if (target.pin) dev.pin = target.pin;
  if (target.alts) dev.alts = target.alts;
  if (!name && target.name) name = target.name;
  if (!dev.token) throw new Error('アクセストークンを入力してください（`remota token` で表示されます）');
  // The app trusts a machine only by the key in its pairing QR code.
  if (NATIVE && !dev.pin) {
    throw new Error('このリンクには機器の鍵の指紋が含まれていません。機器で `remota url` を実行し、表示された QR コードを「QRで追加」で読み取るか、「ペアリングリンク: remota://pair?…」の remota:// から始まる部分を貼り付けてください。');
  }
  const info = await request(dev, 'info', { timeout: 8000 }).catch((ex) => {
    // In a browser, most first-time failures over HTTPS are a certificate the phone doesn't trust yet.
    if (!NATIVE && ex.status === 0 && dev.url.startsWith('https:')) {
      const u = new URL(dev.url);
      throw new Error(`接続できません。この機器の証明書がまだスマホに登録されていない可能性があります。http://${u.hostname}:${Number(u.port || 443) - 1}/setup を開いて証明書を登録してください（各機器で同じ証明書を使えば登録は1回: remota ca export / import）。`);
    }
    throw ex;
  });
  const existing = devices.list.find((d) => d.url === dev.url || (dev.pin && d.pin === dev.pin));
  if (existing) {
    existing.token = dev.token;
    if (dev.pin) existing.pin = dev.pin;
    if (dev.alts) existing.alts = dev.alts;
    existing.url = dev.url;
    if (name) existing.name = String(name).trim().slice(0, 40);
    devices.save();
    return existing;
  }
  dev.name = String(name || '').trim().slice(0, 40) || info.hostname || new URL(dev.url).hostname;
  devices.list.push(dev);
  devices.save();
  state.live.set(dev.id, { online: true, info, infoAt: Date.now() });
  registerPush([dev]).catch(() => {});
  return dev;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    await addDevice({ url: location.origin, token: $('#login-token').value });
    $('#login-token').value = '';
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ---------- home: devices and their sessions ----------

const keyOf = (node, id) => `${node}:${id}`;

function nodeById(id) {
  return state.nodes.find((n) => n.id === id);
}

function sortedSessions(list = state.sessions) {
  return [...list].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.lastOutputAt - a.lastOutputAt);
}

const AGENT_KINDS = [
  ['claude', /claude/i],
  ['codex', /codex/i],
  ['opencode', /opencode/i],
  ['gemini', /gemini/i],
  ['copilot', /copilot/i],
  ['cursor', /cursor/i],
  ['droid', /droid/i],
  ['aider', /aider/i],
  ['qwen', /qwen/i],
  ['pi', /^\s*pi(\s|$)/],
];

function agentKind(command) {
  const hit = AGENT_KINDS.find(([, re]) => re.test(command || ''));
  return hit ? hit[0] : 'shell';
}

// Claude, Codex and the shell have drawn icons; other agents get a lettered tile in their colour.
function agentIcon(kind) {
  if (kind === 'claude' || kind === 'codex' || kind === 'shell') return `<span class="agent ${kind}"><svg class="ico"><use href="#i-${kind}"/></svg></span>`;
  const letter = { opencode: 'oc', gemini: 'G', copilot: 'Co', cursor: 'Cu', droid: 'D', aider: 'Ai', qwen: 'Q', pi: 'π' }[kind] || '?';
  return `<span class="agent ${kind}"><b>${letter}</b></span>`;
}

function sessionCard(s) {
  const li = document.createElement('li');
  li.className = `session-card ${s.status}${s.stale ? ' stale' : ''}`;
  const kind = agentKind(s.command);
  li.innerHTML = `
    ${agentIcon(kind)}
    <span class="name"></span>
    <span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
    <span class="meta"></span>
    ${s.preview ? '<span class="preview"></span>' : ''}`;
  li.querySelector('.name').textContent = s.name;
  li.querySelector('.meta').textContent = `${s.command || 'shell'} · ${s.cwd} · ${timeAgo(s.lastOutputAt)}`;
  if (s.preview) li.querySelector('.preview').textContent = s.preview;
  li.addEventListener('click', () => openSession(s.node, s.id));
  return li;
}

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  const multi = state.nodes.length > 1;
  $('#empty-state').hidden = state.sessions.length > 0 || multi;
  const only = state.nodes[0];
  const info = only && (state.live.get(only.id) || {}).info;
  $('#host-label').textContent = multi ? `${state.nodes.length}台の機器` : info ? `${info.user}@${info.hostname}` : '';
  $('#home-offline').hidden = multi || !only || only.online !== false;
  if (!multi && only && only.online === false) $('#home-offline').textContent = `${only.name} に接続できません（${only.error || '不明なエラー'}）— 再試行中…`;

  // One section per device, devices needing attention first.
  const rank = (n) => {
    const own = state.sessions.filter((s) => s.node === n.id);
    return own.some((s) => s.status === 'waiting') ? 0 : n.online === false ? 2 : own.length ? 1 : 3;
  };
  const nodes = [...state.nodes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const n of multi ? nodes : []) {
    const own = sortedSessions(state.sessions.filter((s) => s.node === n.id));
    const head = document.createElement('li');
    head.className = `device-head${n.online === false ? ' offline' : ''}`;
    const waiting = own.filter((s) => s.status === 'waiting').length;
    head.innerHTML = `
      <span class="device-dot"></span>
      <span class="device-name"></span>
      <span class="device-meta"></span>
      <button class="icon-btn device-add" aria-label="この機器で新規セッション"><svg class="ico"><use href="#i-plus"/></svg></button>`;
    head.querySelector('.device-name').textContent = n.name;
    head.querySelector('.device-meta').textContent = n.online === false
      ? `オフライン${n.error ? `（${n.error}）` : ''}`
      : n.online === undefined
        ? '接続中…'
        : `${own.length}セッション${waiting ? ` · 承認待ち${waiting}` : ''} · ${n.latency ?? '–'}ms`;
    head.querySelector('.device-add').addEventListener('click', () => openNewDialog(n.id));
    head.querySelector('.device-add').disabled = n.online === false;
    list.append(head);
    for (const s of own) list.append(sessionCard(s));
    if (!own.length && n.online) {
      const empty = document.createElement('li');
      empty.className = 'device-empty';
      empty.textContent = 'セッションなし';
      list.append(empty);
    }
  }
  if (!multi) for (const s of sortedSessions()) list.append(sessionCard(s));
  renderQuick();
  renderWaitingBanner();
}

// Sessions waiting for approval, summarised at the top with a jump to the first one.
function renderWaitingBanner() {
  const waiting = sortedSessions(state.sessions.filter((s) => s.status === 'waiting'));
  const banner = $('#waiting-banner');
  banner.hidden = !waiting.length;
  if (!waiting.length) return;
  banner.textContent = waiting.length === 1 ? `「${waiting[0].name}」が承認を待っています` : `${waiting.length}件のセッションが承認を待っています`;
  banner.onclick = () => openSession(waiting[0].node, waiting[0].id);
}

function openSession(node, id) {
  haptic();
  location.hash = `#/s/${node}/${id}`;
}

// Asks every machine for its sessions in parallel; one slow or dead machine never holds up the rest.
async function pollDevice(dev) {
  const live = state.live.get(dev.id) || {};
  state.live.set(dev.id, live);
  const started = performance.now();
  try {
    const sessions = await request(dev, 'sessions', { timeout: 6000 });
    live.latency = Math.round(performance.now() - started);
    live.online = true;
    live.error = null;
    live.sessions = sessions;
    if (!live.info || Date.now() - (live.infoAt || 0) > 60000) {
      live.info = await request(dev, 'info', { timeout: 6000 }).catch(() => live.info);
      live.infoAt = Date.now();
    }
  } catch (ex) {
    live.online = false;
    live.error = ex.message;
  }
}

async function refreshSessions() {
  await Promise.all(devices.list.map(pollDevice));
  state.nodes = devices.list.map((d) => {
    const live = state.live.get(d.id) || {};
    return { id: d.id, name: d.name, url: d.url, online: live.online, latency: live.latency, error: live.error, info: live.info };
  });
  state.sessions = devices.list.flatMap((d) => {
    const live = state.live.get(d.id) || {};
    return (live.sessions || []).map((s) => ({ ...s, node: d.id, stale: live.online === false }));
  });
  if (term.sessionId) updateDeviceLabel();
  notifyTransitions();
  if (!$('#view-home').hidden) renderSessions();
  if (state.tab === 'devices') renderDevices();
  updateBadges();
}

// In-app heads-up when another session starts waiting for approval.
function notifyTransitions() {
  for (const s of state.sessions) {
    const key = keyOf(s.node, s.id);
    const prev = state.statuses.get(key);
    if (prev && prev !== 'waiting' && s.status === 'waiting' && key !== term.key()) {
      haptic(30);
      const where = state.nodes.length > 1 ? `${(nodeById(s.node) || {}).name} / ` : '';
      toast(`⏳ ${where}${s.name} が承認待ちです（タップで開く）`, { ms: 6000, onClick: () => openSession(s.node, s.id) });
    }
    state.statuses.set(key, s.status);
  }
}

function updateBadges() {
  const waiting = state.sessions.filter((s) => s.status === 'waiting');
  if ('setAppBadge' in navigator) (waiting.length ? navigator.setAppBadge(waiting.length) : navigator.clearAppBadge()).catch(() => {});
  document.title = waiting.length ? `(${waiting.length}) Remota` : 'Remota';
  const others = waiting.filter((s) => keyOf(s.node, s.id) !== term.key()).length;
  $('#back-badge').hidden = !others;
  $('#back-badge').textContent = others;
  $('#tab-badge').hidden = !waiting.length;
  $('#tab-badge').textContent = waiting.length;
}

function startPolling(interval) {
  stopPolling();
  refreshSessions();
  state.pollTimer = setInterval(() => !document.hidden && refreshSessions(), interval);
}

function stopPolling() {
  clearInterval(state.pollTimer);
}

$('#btn-new').addEventListener('click', () => (state.tab === 'devices' ? openAddDevice() : openNewDialog()));
// ----- tabs -----

const TAB_TITLES = { sessions: 'セッション', devices: '機器', settings: '設定' };

function switchTab(tab) {
  state.tab = tab;
  prefs.set('tab', tab);
  for (const b of document.querySelectorAll('#tabbar button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${tab}`;
  $('#home-title').textContent = TAB_TITLES[tab];
  $('#btn-new').hidden = tab === 'settings';
  $('#host-label').hidden = tab === 'settings';
  $('.tab-panels').scrollTop = 0;
  if (tab === 'devices') renderDevices();
  if (tab === 'settings') openSettings();
}

for (const b of document.querySelectorAll('#tabbar button')) {
  b.addEventListener('click', () => {
    haptic();
    switchTab(b.dataset.tab);
  });
}

// ----- new session -----

async function openNewDialog(nodeId) {
  const online = state.nodes.filter((n) => n.online !== false);
  const nodeChips = $('#node-list');
  nodeChips.replaceChildren();
  $('#node-field').hidden = state.nodes.length < 2;
  const pickNode = async (id) => {
    state.newNode = id;
    nodeChips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.id === id));
    prefs.set('lastNode', id);
    await loadNodeDefaults(id);
  };
  for (const n of online) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.id = n.id;
    b.textContent = n.name;
    b.addEventListener('click', () => pickNode(n.id));
    nodeChips.append(b);
  }
  $('#new-name').value = '';
  $('#new-fav').checked = false;
  $('#new-error').hidden = true;
  $('#dlg-new').showModal();
  const preferred = [nodeId, prefs.get('lastNode')].find((id) => online.some((n) => n.id === id)) || (online[0] && online[0].id);
  if (preferred) await pickNode(preferred);
}

// Presets and the default directory come from the chosen machine itself.
async function loadNodeDefaults(id) {
  const live = state.live.get(id) || {};
  const info = live.info || (await devApi(id, 'info').catch(() => null));
  // Only agents installed on that machine are offered.
  const presets = ((info && info.presets) || [{ name: 'Shell', command: '' }]).filter((p) => p.available !== false);
  const chips = $('#preset-list');
  chips.replaceChildren();
  const pick = (i) => {
    state.presetIndex = i;
    state.presetCommand = presets[i].command;
    $('#new-command').value = presets[i].command;
    chips.querySelectorAll('.chip').forEach((c, j) => c.classList.toggle('on', i === j));
  };
  presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.name;
    b.addEventListener('click', () => pick(i));
    chips.append(b);
  });
  const last = presets.findIndex((p) => p.command === prefs.get('lastPresetCommand', 'claude'));
  pick(last >= 0 ? last : Math.min(1, presets.length - 1));

  const history = prefs.get(`cwdHistory.${id}`, []);
  $('#new-cwd').value = history[0] || (info && info.defaultCwd) || '';
  const cwdChips = $('#cwd-chips');
  cwdChips.replaceChildren();
  for (const dir of history.slice(0, 6)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = dir;
    b.addEventListener('click', () => ($('#new-cwd').value = dir));
    cwdChips.append(b);
  }
}

$('#new-form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const cwd = $('#new-cwd').value.trim();
  const node = state.newNode;
  try {
    const s = await devApi(node, 'sessions', {
      method: 'POST',
      body: JSON.stringify({ name: $('#new-name').value, cwd, command: $('#new-command').value.trim() }),
    });
    prefs.set('lastPresetCommand', state.presetCommand);
    if ($('#new-fav').checked) addFavorite({ node, cwd, command: $('#new-command').value.trim(), name: $('#new-name').value.trim() });
    prefs.set(`cwdHistory.${node}`, [cwd, ...prefs.get(`cwdHistory.${node}`, []).filter((d) => d !== cwd)].slice(0, 10));
    $('#dlg-new').close();
    state.sessions.push({ ...s, node });
    openSession(node, s.id);
  } catch (ex) {
    $('#new-error').textContent = ex.message;
    $('#new-error').hidden = false;
  }
});

// ----- device management (the 機器 tab) -----

function openAddDevice(prefill = '') {
  $('#dev-error').hidden = true;
  $('#dev-url').value = prefill;
  $('#dlg-add-device').showModal();
}

const pct = (n) => `${Math.max(0, Math.min(100, Math.round(n)))}%`;
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1)}GB`;

function meter(label, ratio, detail) {
  const level = ratio > 0.9 ? 'crit' : ratio > 0.7 ? 'hot' : '';
  return `<div class="stat"><div class="stat-top"><span>${label}</span><b>${detail}</b></div><div class="meter"><i class="${level}" style="width:${pct(ratio * 100)}"></i></div></div>`;
}

function uptimeText(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d}日${h}時間` : `${h}時間${Math.floor((sec % 3600) / 60)}分`;
}

// Machine health at a glance: is the GPU box busy, is the disk filling up?
function statsHtml(stats) {
  if (!stats) return '';
  const parts = [];
  const load = stats.load[0] / stats.cpus;
  parts.push(meter('CPU', load, `${stats.load[0].toFixed(1)} / ${stats.cpus}コア`));
  const used = stats.mem.total - stats.mem.free;
  parts.push(meter('メモリ', used / stats.mem.total, `${gb(used)} / ${gb(stats.mem.total)}`));
  if (stats.disk) {
    const dUsed = stats.disk.total - stats.disk.free;
    parts.push(meter('ディスク', dUsed / stats.disk.total, `空き ${gb(stats.disk.free)}`));
  }
  for (const g of stats.gpus || []) {
    parts.push(meter(`GPU ${g.util}%`, g.memUsed / g.memTotal, `${(g.memUsed / 1024).toFixed(1)} / ${(g.memTotal / 1024).toFixed(0)}GB · ${g.temp}℃`));
  }
  return `<div class="stats">${parts.join('')}</div>`;
}

function renderDevices() {
  const list = $('#device-list');
  list.replaceChildren();
  for (const n of state.nodes) {
    const li = document.createElement('li');
    li.className = 'device-card';
    const sessions = state.sessions.filter((s) => s.node === n.id).length;
    li.innerHTML = `
      <div class="device-card-head">
        <span class="device-dot ${n.online === false ? 'off' : 'on'}"></span>
        <div class="device-info"><strong></strong><small></small></div>
        <span class="badge ${n.online === false ? '' : 'idle'}"></span>
      </div>
      ${n.online === false ? '<p class="error"></p>' : statsHtml(n.info && n.info.stats)}
      <div class="device-actions">
        <button type="button" class="btn small" data-act="new"${n.online === false ? ' disabled' : ''}>＋ 新規</button>
        <button type="button" class="btn small" data-act="agents"${n.online === false ? ' disabled' : ''}>通知連携</button>
        <button type="button" class="btn small" data-act="rename">名前</button>
        <button type="button" class="btn small" data-act="remove">外す</button>
      </div>`;
    li.querySelector('strong').textContent = n.name;
    const who = n.info ? `${n.info.user}@${n.info.hostname} · ` : '';
    const up = n.info && n.info.stats ? ` · 稼働 ${uptimeText(n.info.stats.uptime)}` : '';
    li.querySelector('small').textContent = `${who}${n.url}${up}`;
    li.querySelector('.badge').textContent = n.online === false ? 'オフライン' : `${sessions}件 · ${n.latency ?? '–'}ms`;
    if (n.online === false) li.querySelector('.error').textContent = n.error || '接続できません';
    li.querySelector('[data-act="new"]').addEventListener('click', () => openNewDialog(n.id));
    li.querySelector('[data-act="agents"]').addEventListener('click', () => openAgents(n.id));
    li.querySelector('[data-act="rename"]').addEventListener('click', () => {
      const name = prompt('機器の名前', n.name);
      const dev = devices.get(n.id);
      if (!name || !dev) return;
      dev.name = name.trim().slice(0, 40);
      devices.save();
      refreshSessions();
    });
    li.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      if (!confirm(`「${n.name}」をこのアプリから外しますか？（その機器のセッションは止まりません）`)) return;
      await unregisterPush([devices.get(n.id)]).catch(() => {});
      devices.list = devices.list.filter((d) => d.id !== n.id);
      devices.save();
      state.live.delete(n.id);
      if (!devices.list.length) return showLogin();
  if (prefs.get('lockCredential', null)) {
    showLock();
    unlock();
  }
      refreshSessions();
    });
    list.append(li);
  }
}

$('#btn-add-url').addEventListener('click', () => openAddDevice());
$('#btn-add-qr').addEventListener('click', () => scanQr(onScannedDevice));

$('#dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#dev-error');
  err.hidden = true;
  const btn = $('#dev-add');
  btn.disabled = true;
  btn.textContent = '確認中…';
  try {
    const dev = await addDevice({ name: $('#dev-name').value, url: $('#dev-url').value, token: $('#dev-token').value });
    $('#dev-name').value = '';
    $('#dev-url').value = '';
    $('#dev-token').value = '';
    $('#dlg-add-device').close();
    toast(`「${dev.name}」を追加しました`);
    // First machine added from the welcome screen: go on into the app.
    if (!$('#view-login').hidden) return boot();
    await refreshSessions();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '追加';
  }
});

// A scanned QR is a login link (http://host:port/#token=…): register that machine right away.
async function onScannedDevice(text) {
  try {
    const dev = await addDevice({ url: text });
    toast(`「${dev.name}」を追加しました`);
    if (!$('#view-login').hidden) return boot();
    await refreshSessions();
  } catch (ex) {
    // Let the user see and fix what was read (e.g. a URL without a token).
    openAddDevice(text);
    $('#dev-error').textContent = ex.message;
    $('#dev-error').hidden = false;
  }
}

// The machine list lives on this phone; export/import moves it to another phone or browser.
$('#btn-dev-export').addEventListener('click', async () => {
  const text = JSON.stringify(devices.list.map(({ name, url, token }) => ({ name, url, token })));
  try {
    await copyText(text);
    toast('機器リストをコピーしました（トークンを含むので取り扱いに注意）', { ms: 3500 });
  } catch {
    prompt('この内容をコピーしてください（トークンを含みます）', text);
  }
});

$('#btn-dev-import').addEventListener('click', async () => {
  const text = prompt('エクスポートした機器リストを貼り付けてください');
  if (!text) return;
  let items;
  try {
    items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error();
  } catch {
    toast('形式が正しくありません');
    return;
  }
  let added = 0;
  for (const item of items) {
    try {
      await addDevice(item);
      added++;
    } catch (ex) {
      toast(`${item.name || item.url}: ${ex.message}`, { ms: 3000 });
    }
  }
  toast(`${added}台の機器を取り込みました`);
  refreshSessions();
});

// ---------- terminal & connection ----------


// Identifies this browser tab to the server so inputs re-sent after a reconnect are applied once.
const CLIENT_ID = randomId();

const term = {
  instance: null,
  fit: null,
  ws: null,
  sessionId: null,
  node: null,
  retry: 0,
  retryTimer: null,
  pingTimer: null,
  lastPong: 0,
  // Resume point within the session's output stream.
  epoch: null,
  seq: null,
  // Numbered inputs not yet confirmed by the server; replayed after a reconnect.
  inputN: 0,
  pending: [],
  ctrl: false,
  scrolledBack: false,
  replaying: false,
  direct: prefs.get('directInput', false),
  fontSize: prefs.get('fontSize', 13),

  ensure() {
    if (this.instance) return;
    const t = new Terminal({
      fontFamily: 'ui-monospace, Menlo, "SF Mono", "Cascadia Mono", "Noto Sans Mono CJK JP", monospace',
      fontSize: this.fontSize,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: THEMES[prefs.get('theme', 'midnight')] || THEMES.midnight,
      ...readabilityOptions(),
    });
    this.fit = new FitAddon.FitAddon();
    t.loadAddon(this.fit);
    t.loadAddon(new WebLinksAddon.WebLinksAddon());
    t.open($('#terminal'));
    t.textarea.setAttribute('autocorrect', 'off');
    t.textarea.setAttribute('autocapitalize', 'off');
    t.onData((data) => {
      // Replayed output can contain terminal queries; their answers must not reach the shell again.
      if (this.replaying) return;
      if (this.ctrl && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        this.setCtrl(false);
      }
      this.send(data);
    });
    t.onResize(({ cols, rows }) => this.sendJson({ type: 'resize', cols, rows }));
    t.onScroll(() => updateJumpButton());
    t.onWriteParsed(() => scheduleChoiceScan());
    this.instance = t;
    this.setDirect(this.direct, false);
    new ResizeObserver(() => this.fitSoon()).observe($('#terminal-wrap'));
    setupTouch();
  },

  fitSoon() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      try {
        this.fit.fit();
      } catch {
        // not visible yet
      }
    });
  },

  key() {
    return this.sessionId ? keyOf(this.node, this.sessionId) : null;
  },

  open(node, id) {
    this.ensure();
    if (this.sessionId === id && this.node === node && this.ws && this.ws.readyState <= 1) return;
    this.close();
    this.sessionId = id;
    this.node = node;
    this.retry = 0;
    this.epoch = null;
    this.seq = null;
    this.pending = [];
    this.instance.reset();
    hideChoices();
    const s = state.sessions.find((x) => x.id === id && x.node === node);
    $('#term-name').textContent = s ? s.name : '';
    updateDeviceLabel();
    restoreDraft();
    this.connect();
  },

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.sessionId) return;
    this.fitSoon();
    const { cols, rows } = this.instance;
    const dev = devices.get(this.node);
    if (!dev) return;
    const params = new URLSearchParams({ session: this.sessionId, cols, rows, client: CLIENT_ID });
    if (this.epoch && this.seq !== null) {
      params.set('epoch', this.epoch);
      params.set('since', this.seq);
    }
    // Browsers can't set headers on a WebSocket, so the token rides in the subprotocol list.
    const ws = NATIVE
      ? new NativeSocket(dev, `/ws?${params}`)
      : new WebSocket(`${dev.url.replace(/^http/, 'ws')}/ws?${params}`, ['remota', `auth.${dev.token}`]);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastPong = Date.now();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.heartbeat(), 3000);
      this.ping();
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      if (ev.code === 4404) {
        toast('セッションは終了しています');
        location.hash = '#/';
        return;
      }
      this.scheduleReconnect();
    };
  },

  scheduleReconnect() {
    setStatus('offline');
    this.updateBanner();
    const delay = Math.min(4000, 250 * 2 ** this.retry++);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  },

  // A socket can look open long after the network under it died (common on iOS after a network switch).
  // Missing pongs mean it's dead: drop it and reconnect instead of waiting for TCP to notice.
  heartbeat() {
    if (document.hidden) return;
    if (Date.now() - this.lastPong > 7000) return this.forceReconnect();
    this.ping();
  },

  ping() {
    this.sendJson({ type: 'ping', t: performance.now() });
  },

  forceReconnect() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.retry = 0;
    this.scheduleReconnect();
  },

  // Network switched or app came back to the foreground.
  reconnectNow() {
    if (!this.sessionId) return;
    if (!this.ws || this.ws.readyState > 1) {
      this.retry = 0;
      this.connect();
      return;
    }
    // The socket claims to be open; verify quickly rather than trusting it.
    const before = this.lastPong;
    this.ping();
    setTimeout(() => {
      if (this.sessionId && this.lastPong === before) this.forceReconnect();
    }, 2500);
  },

  updateBanner() {
    const banner = $('#conn-banner');
    const offline = !this.ws || this.ws.readyState !== 1;
    banner.hidden = !offline;
    if (offline) {
      const queued = this.pending.length;
      banner.textContent = `再接続中…${queued ? `（未送信の入力 ${queued} 件は接続後に送信されます）` : ''}`;
    }
  },

  onMessage(msg) {
    const t = this.instance;
    if (msg.type === 'hello') {
      if (!msg.resume) t.reset();
      if (msg.replay) {
        this.replaying = true;
        t.write(msg.replay, () => (this.replaying = false));
      }
      this.epoch = msg.epoch;
      this.seq = msg.seq;
      $('#term-name').textContent = msg.session.name;
      $('#menu-title').textContent = msg.session.name;
      this.tmux = msg.session.tmux;
      setStatus(msg.session.status);
      this.sendJson({ type: 'resize', cols: t.cols, rows: t.rows });
      // Re-send whatever the server never received.
      this.pending = this.pending.filter((p) => p.n > msg.inputAck);
      for (const p of this.pending) this.sendJson({ type: 'input', n: p.n, data: p.data });
      this.updateBanner();
    } else if (msg.type === 'output') {
      t.write(msg.data);
      if (typeof msg.seq === 'number') this.seq = msg.seq;
    } else if (msg.type === 'ack') {
      this.pending = this.pending.filter((p) => p.n > msg.n);
    } else if (msg.type === 'status') {
      setStatus(msg.status);
    } else if (msg.type === 'exit') {
      setStatus('exited');
      t.write('\r\n\x1b[90m[セッションが終了しました]\x1b[0m\r\n');
    } else if (msg.type === 'pong') {
      this.lastPong = Date.now();
      const ms = Math.round(performance.now() - msg.t);
      const el = $('#term-latency');
      el.textContent = `${ms}ms`;
      el.className = `latency${ms > 1000 ? ' bad' : ms > 300 ? ' slow' : ''}`;
    }
  },

  sendJson(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  },

  send(data) {
    if (!this.sessionId) return;
    if (this.scrolledBack) exitScrollback();
    if (this.instance.buffer.active.viewportY < this.instance.buffer.active.baseY) this.instance.scrollToBottom();
    const n = ++this.inputN;
    this.pending.push({ n, data });
    if (this.pending.length > 2000) this.pending.shift();
    this.sendJson({ type: 'input', n, data });
    if (!this.ws || this.ws.readyState !== 1) this.updateBanner();
    hideChoices();
  },

  // Bracketed paste lets agents receive multi-line text as one message instead of many Enters.
  sendText(text, enter) {
    if (!text) return;
    const t = this.instance;
    const bracketed = t.modes.bracketedPasteMode;
    const body = text.replace(/\r?\n/g, '\r');
    this.send(bracketed ? `\x1b[200~${body}\x1b[201~` : body);
    if (enter) setTimeout(() => this.send('\r'), 40);
  },

  setCtrl(on) {
    this.ctrl = on;
    document.querySelectorAll('.key[data-seq="@ctrl"]').forEach((k) => k.classList.toggle('on', on));
  },

  setDirect(on, focus = true) {
    this.direct = on;
    prefs.set('directInput', on);
    $('#btn-kbd').setAttribute('aria-pressed', String(on));
    if (!this.instance) return;
    // inputmode=none: tapping the terminal (to scroll, select, pick a choice) won't pop the keyboard.
    this.instance.textarea.setAttribute('inputmode', on ? 'text' : 'none');
    if (on && focus) this.instance.focus();
    if (!on) this.instance.blur();
  },

  setFont(size, fit = true) {
    this.fontSize = Math.max(7, Math.min(32, Math.round(size)));
    prefs.set('fontSize', this.fontSize);
    if (this.instance) {
      this.instance.options.fontSize = this.fontSize;
      if (fit) this.fitSoon();
    }
  },

  close() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.sessionId = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    $('#conn-banner').hidden = true;
    hideChoices();
  },
};

const PILL_LABEL = { ...STATUS_LABEL, offline: '再接続中' };

// The status is shown three ways (dot, labelled pill, coloured edge) so it reads at a glance.
// With several devices, the header says which machine this terminal is on.
function updateDeviceLabel() {
  const n = state.nodes.length > 1 && nodeById(term.node);
  $('#term-device').textContent = n ? n.name : '';
}

function setStatus(status) {
  $('#term-status').className = `status-dot ${status}`;
  const pill = $('#term-pill');
  pill.className = `status-pill ${status}`;
  pill.textContent = PILL_LABEL[status] || status;
  $('#view-term').dataset.status = status;
  if (status === 'waiting') scheduleChoiceScan();
}

// ---------- approval choices read from the screen ----------

const OPTION_RE = /^[\s│┃|]*(?:([❯›>▶→●])\s*)?(\d{1,2})[.)]\s+(.+?)[\s│┃|]*$/;
const YN_RE = /[[(]\s*([yY])\s*\/\s*([nN])\s*[\])]\s*:?\s*$/;
let choiceTimer = null;

function scheduleChoiceScan() {
  clearTimeout(choiceTimer);
  choiceTimer = setTimeout(scanChoices, 120);
}

function screenLines() {
  const buf = term.instance.buffer.active;
  const lines = [];
  for (let i = buf.baseY; i < buf.baseY + term.instance.rows; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

// Finds a numbered menu (Claude Code / Codex approval prompts) or a [y/n] prompt near the bottom of the screen.
function findChoices(lines) {
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last--;
  const tail = lines[last] || '';
  const yn = tail.match(YN_RE);
  if (yn) {
    return {
      title: tail.trim().slice(0, 120),
      options: [
        { key: yn[1], label: 'Yes', kind: 'yes' },
        { key: yn[2], label: 'No', kind: 'no' },
      ],
    };
  }

  const found = [];
  let gap = 0;
  // Lines between two options are the upper option's label wrapped onto the next row.
  let wrapped = [];
  const clean = (l) => l.replace(/[│┃|]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = last; i >= Math.max(0, last - 18); i--) {
    const m = lines[i].match(OPTION_RE);
    if (m) {
      const num = Number(m[2]);
      if (found.length && num !== found[0].num - 1) break;
      const label = [clean(m[3]), ...(found.length ? wrapped : [])].join(' ');
      found.unshift({ num, label, selected: Boolean(m[1]), row: i });
      gap = 0;
      wrapped = [];
      if (num === 1) break;
    } else if (found.length && ++gap > 2) {
      break;
    } else if (found.length) {
      if (clean(lines[i])) wrapped.unshift(clean(lines[i]));
    } else if (!found.length && lines.slice(i, last + 1).filter((l) => l.trim()).length > 3) {
      // The menu must sit near the bottom of the screen.
      return null;
    }
  }
  if (found.length < 2 || found[0].num !== 1) return null;

  let title = '';
  for (let i = found[0].row - 1; i >= Math.max(0, found[0].row - 8); i--) {
    const text = lines[i].replace(/[│┃|╭╮╰╯─━]+/g, ' ').trim();
    if (text) {
      title = text;
      if (/[?？]/.test(text)) break;
    }
  }
  if (!/[?？]/.test(title) && $('#term-status').className.indexOf('waiting') < 0) return null;
  return {
    title: title.slice(0, 120),
    options: found.map((o) => ({
      key: String(o.num),
      label: o.label.replace(/\s{2,}/g, ' '),
      selected: o.selected,
      kind: /^(yes|はい|allow|approve|proceed)/i.test(o.label) ? 'yes' : /^(no|いいえ|deny|reject|cancel)/i.test(o.label) ? 'no' : '',
    })),
  };
}

function scanChoices() {
  if (!term.instance || !term.sessionId || !prefs.get('choices', true)) return hideChoices();
  const found = findChoices(screenLines());
  if (!found) return hideChoices();
  const sig = JSON.stringify(found);
  const bar = $('#choice-bar');
  if (!bar.hidden && bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  $('#choice-title').textContent = found.title || '選択してください';
  const list = $('#choice-list');
  list.replaceChildren();
  for (const opt of found.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `choice ${opt.kind || ''}${opt.selected ? ' selected' : ''}`;
    b.innerHTML = '<span class="num"></span><span class="label"></span>';
    b.querySelector('.num').textContent = opt.key;
    b.querySelector('.label').textContent = opt.label;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      haptic(15);
      term.send(opt.key);
    });
    list.append(b);
  }
  const esc = document.createElement('button');
  esc.type = 'button';
  esc.className = 'choice esc';
  esc.innerHTML = '<span class="num">Esc</span><span class="label">キャンセル</span>';
  esc.addEventListener('pointerdown', (e) => e.preventDefault());
  esc.addEventListener('click', () => term.send('\x1b'));
  list.append(esc);
  if (bar.hidden) haptic(20);
  bar.hidden = false;
}

function hideChoices() {
  const bar = $('#choice-bar');
  if (!bar.hidden) {
    bar.hidden = true;
    bar.dataset.sig = '';
  }
}

// ---------- key bar & snippets ----------

function renderKeybar() {
  const bar = $('#keybar');
  bar.replaceChildren();
  for (const { label, seq } of parseKeys(prefs.get('keys', DEFAULT_KEYS))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key';
    if (label === '1' || label === 'y') b.classList.add('approve');
    if (label === 'n' || label === '^C') b.classList.add('reject');
    b.textContent = label;
    b.dataset.seq = seq;
    // preventDefault on pointerdown keeps the soft keyboard (and compose focus) in place.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    if (REPEATABLE.has(seq)) attachRepeat(b, () => pressKey(seq));
    else b.addEventListener('click', () => pressKey(seq));
    bar.append(b);
  }
}

// Hold to auto-repeat; a horizontal swipe over the bar scrolls instead of pressing.
function attachRepeat(el, fire) {
  let holdTimer = null;
  let repeatTimer = null;
  let repeated = false;
  let startX = 0;
  const stop = () => {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = repeatTimer = null;
    el.classList.remove('pressed');
  };
  el.addEventListener('pointerdown', (e) => {
    repeated = false;
    startX = e.clientX;
    el.classList.add('pressed');
    holdTimer = setTimeout(() => {
      repeated = true;
      fire();
      repeatTimer = setInterval(fire, 70);
    }, 380);
  });
  el.addEventListener('pointermove', (e) => Math.abs(e.clientX - startX) > 10 && stop());
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('click', () => !repeated && fire());
}

function pressKey(seq) {
  haptic();
  if (seq === '@ctrl') return term.setCtrl(!term.ctrl);
  if (seq === '@pgup' || seq === '@pgdn') return pageScroll(seq === '@pgup' ? 'up' : 'down');
  let data = unescapeSeq(seq);
  // Full-screen apps (vim, less, agents' TUIs) may expect application-mode arrow keys.
  if (term.instance && term.instance.modes.applicationCursorKeysMode) data = data.replace(/^\x1b\[([ABCD])$/, '\x1bO$1');
  term.send(data);
}

function renderSnippets() {
  const bar = $('#snippet-bar');
  bar.replaceChildren();
  bar.hidden = !prefs.get('showSnippets', false);
  $('#btn-snippets').setAttribute('aria-pressed', String(!bar.hidden));
  const historyBtn = document.createElement('button');
  historyBtn.type = 'button';
  historyBtn.className = 'key snippet';
  historyBtn.innerHTML = '<svg class="ico tiny" style="opacity:1"><use href="#i-history"/></svg>';
  historyBtn.setAttribute('aria-label', '送信履歴');
  historyBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  historyBtn.addEventListener('click', openHistory);
  bar.append(historyBtn);
  for (const text of prefs.get('snippets', DEFAULT_SNIPPETS).split('\n').filter((l) => l.trim())) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key snippet';
    b.textContent = text;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      haptic();
      term.sendText(text, prefs.get('autoEnter', true));
    });
    bar.append(b);
  }
}

// ---------- touch: scroll with momentum, pinch to zoom ----------

let scrollQueue = 0;
let scrollFlush = null;

function queueScroll(lines) {
  if (!term.tmux) {
    term.instance.scrollLines(lines);
    return;
  }
  scrollQueue += lines;
  if (scrollFlush) return;
  scrollFlush = setTimeout(async () => {
    const n = scrollQueue;
    scrollQueue = 0;
    scrollFlush = null;
    if (!n) return;
    term.scrolledBack = true;
    updateJumpButton();
    await devApi(term.node, `sessions/${term.sessionId}/scroll`, {
      method: 'POST',
      body: JSON.stringify({ direction: n < 0 ? 'up' : 'down', lines: Math.abs(n) }),
    }).catch(() => {});
  }, 50);
}

function pageScroll(direction) {
  const lines = Math.max(1, term.instance.rows - 2);
  if (!term.tmux) return term.instance.scrollPages(direction === 'up' ? -1 : 1);
  queueScroll(direction === 'up' ? -lines : lines);
}

function exitScrollback() {
  term.scrolledBack = false;
  updateJumpButton();
  devApi(term.node, `sessions/${term.sessionId}/scroll`, { method: 'POST', body: JSON.stringify({ direction: 'exit' }) }).catch(() => {});
}

function updateJumpButton() {
  if (!term.instance) return;
  const buf = term.instance.buffer.active;
  $('#btn-jump').hidden = !(term.scrolledBack || buf.viewportY < buf.baseY);
}

$('#btn-jump').addEventListener('click', () => {
  if (term.scrolledBack) exitScrollback();
  term.instance.scrollToBottom();
  updateJumpButton();
});

function setupTouch() {
  const el = $('#terminal-wrap');
  const hud = $('#zoom-hud');
  let lastY = null;
  let lastT = 0;
  let acc = 0;
  let velocity = 0;
  let momentum = null;
  let pinch = null;
  let hudTimer = null;

  const lineHeight = () => term.fontSize * 1.2;
  const scrollBy = (px) => {
    acc += px;
    const lines = Math.trunc(acc / lineHeight());
    if (lines) {
      acc -= lines * lineHeight();
      queueScroll(lines);
    }
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  el.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(momentum);
    if (e.touches.length === 2) {
      pinch = { d: dist(e.touches), size: term.fontSize };
      lastY = null;
    } else if (e.touches.length === 1) {
      lastY = e.touches[0].clientY;
      lastT = performance.now();
      acc = 0;
      velocity = 0;
    }
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const size = pinch.size * (dist(e.touches) / pinch.d);
      if (Math.round(size) !== term.fontSize) {
        term.setFont(size, false);
        hud.textContent = `文字サイズ ${term.fontSize}`;
        hud.hidden = false;
      }
      return;
    }
    if (lastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    const dy = lastY - y;
    velocity = 0.7 * (dy / Math.max(1, now - lastT)) + 0.3 * velocity;
    lastY = y;
    lastT = now;
    scrollBy(dy);
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      term.fitSoon();
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => (hud.hidden = true), 700);
      return;
    }
    if (lastY === null) return;
    lastY = null;
    // Flick: keep scrolling and slow down, like native lists.
    if (Math.abs(velocity) < 0.3 || performance.now() - lastT > 80) return;
    let v = velocity * 16;
    const step = () => {
      v *= 0.94;
      if (Math.abs(v) < 0.6) return;
      scrollBy(v);
      momentum = requestAnimationFrame(step);
    };
    momentum = requestAnimationFrame(step);
  }, { passive: true });

  // Desktop browsers: mouse wheel scrolls tmux history too.
  el.addEventListener('wheel', (e) => {
    if (!term.tmux) return;
    e.preventDefault();
    queueScroll(Math.sign(e.deltaY) * 3);
  }, { passive: false });
}

// ---------- compose box, voice, attachments ----------

const input = $('#compose-input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.3)}px`;
}

let draftTimer = null;
input.addEventListener('input', () => {
  autosize();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 300);
});

// Unsent text survives app restarts and session switches.
function saveDraft() {
  if (!term.sessionId) return;
  if (input.value) prefs.set(`draft.${term.key()}`, input.value);
  else prefs.remove(`draft.${term.key()}`);
}

function restoreDraft() {
  input.value = prefs.get(`draft.${term.key()}`, '');
  autosize();
}

input.addEventListener('keydown', (e) => {
  // keyCode 229 = IME composition on Safari, where isComposing is not always set.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && prefs.get('enterSends', true)) {
    e.preventDefault();
    submitCompose(prefs.get('autoEnter', true));
  }
});

function submitCompose(enter) {
  const text = input.value;
  if (!text) {
    // Empty send acts as a plain Enter, handy for confirming prompts.
    term.send('\r');
    return;
  }
  term.sendText(text, enter);
  const history = prefs.get('history', []);
  prefs.set('history', [text, ...history.filter((h) => h !== text)].slice(0, 100));
  input.value = '';
  saveDraft();
  autosize();
}

$('#compose').addEventListener('submit', (e) => e.preventDefault());

// Tap = send (+Enter per settings); long-press = send without Enter.
(() => {
  const btn = $('#btn-send');
  let timer = null;
  let longPressed = false;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    longPressed = false;
    btn.classList.add('held');
    timer = setTimeout(() => {
      longPressed = true;
      haptic(25);
      submitCompose(false);
      toast('Enterなしで送信しました', { ms: 1200 });
    }, 500);
  });
  const end = () => {
    clearTimeout(timer);
    btn.classList.remove('held');
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('pointerleave', end);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (longPressed) return;
    haptic();
    submitCompose(prefs.get('autoEnter', true));
  });
})();

$('#btn-kbd').addEventListener('pointerdown', (e) => e.preventDefault());
$('#btn-kbd').addEventListener('click', () => {
  term.setDirect(!term.direct);
  toast(term.direct ? '直接入力モード: ターミナルをタップして入力' : '入力欄モード', { ms: 1500 });
});

let recognition = null;
$('#btn-mic').addEventListener('click', () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    input.focus();
    toast('キーボードのマイクボタンで音声入力できます', { ms: 3000 });
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }
  const base = input.value ? `${input.value} ` : '';
  recognition = new SR();
  recognition.lang = prefs.get('lang', 'ja-JP');
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.onresult = (ev) => {
    let text = '';
    for (const r of ev.results) text += r[0].transcript;
    input.value = base + text;
    autosize();
    saveDraft();
  };
  recognition.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      input.focus();
      toast('音声認識が使えません。キーボードのマイクボタンを使ってください', { ms: 3500 });
    } else if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
      toast(`音声認識エラー: ${ev.error}`);
    }
  };
  recognition.onend = () => {
    recognition = null;
    $('#btn-mic').classList.remove('listening');
  };
  try {
    recognition.start();
    haptic(15);
    $('#btn-mic').classList.add('listening');
  } catch {
    recognition = null;
    input.focus();
  }
});

$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) await uploadFile(file);
  e.target.value = '';
});

// Pasting a screenshot into the compose box uploads it, like dragging an image into the agent.
input.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) await uploadFile(f);
});

async function uploadFile(file) {
  if (!term.sessionId) return;
  toast(`アップロード中: ${file.name}`, { ms: 10000 });
  try {
    const res = await devApi(term.node, `upload?session=${term.sessionId}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image.png') },
    });
    input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}${res.relative} `;
    autosize();
    saveDraft();
    input.focus();
    toast('添付しました（パスを入力欄に挿入）');
  } catch (ex) {
    toast(`アップロード失敗: ${ex.message}`);
  }
}

// ---------- terminal header, switcher & menu ----------

$('#btn-back').addEventListener('click', () => (location.hash = '#/'));

$('#btn-switch').addEventListener('click', async () => {
  await refreshSessions();
  const list = $('#switch-list');
  list.replaceChildren();
  for (const s of sortedSessions()) {
    const li = document.createElement('li');
    if (keyOf(s.node, s.id) === term.key()) li.className = 'current';
    li.innerHTML = `<span class="status-dot ${s.status}"></span><span class="name"></span><span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
    const device = state.nodes.length > 1 && nodeById(s.node);
    li.querySelector('.name').textContent = device ? `${s.name}` : s.name;
    if (device) {
      const tag = document.createElement('span');
      tag.className = 'device-tag';
      tag.textContent = device.name;
      li.querySelector('.name').after(tag);
    }
    li.addEventListener('click', () => {
      $('#dlg-switch').close();
      openSession(s.node, s.id);
    });
    list.append(li);
  }
  $('#dlg-switch').showModal();
});

$('#dlg-switch').addEventListener('close', () => {
  if ($('#dlg-switch').returnValue === 'new') openNewDialog();
  $('#dlg-switch').returnValue = '';
});

$('#btn-term-menu').addEventListener('click', () => $('#dlg-menu').showModal());

$('#dlg-menu').addEventListener('close', async () => {
  const action = $('#dlg-menu').returnValue;
  $('#dlg-menu').returnValue = '';
  const id = term.sessionId;
  const node = term.node;
  if (action === 'text') {
    openTextView();
  } else if (action === 'history') {
    openHistory();
  } else if (action === 'fav') {
    const s = state.sessions.find((x) => x.node === node && x.id === id);
    if (s) addFavorite({ node, cwd: s.cwd, command: s.command, name: s.name });
  } else if (action === 'edit-snippets') {
    editText('定型文', '1行に1つ。タップで送信します。', 'snippets', DEFAULT_SNIPPETS, renderSnippets);
  } else if (action === 'edit-keys') {
    editText('キーバー', '「ラベル=送信内容」を1行に1つ。\\e=Esc, \\r=Enter, \\t=Tab, \\x7f=Backspace, \\xNN=制御文字。@ctrl / @pgup / @pgdn は特殊動作。', 'keys', DEFAULT_KEYS, renderKeybar);
  } else if (action === 'font-up' || action === 'font-down') {
    term.setFont(term.fontSize + (action === 'font-up' ? 1 : -1));
    toast(`文字サイズ ${term.fontSize}`, { ms: 1000 });
  } else if (action === 'rename') {
    const name = prompt('新しい名前', $('#term-name').textContent);
    if (name) {
      await devApi(node, `sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      $('#term-name').textContent = name;
    }
  } else if (action === 'kill') {
    if (confirm('このセッションを終了しますか？実行中のプロセスも終了します。')) {
      await devApi(node, `sessions/${id}`, { method: 'DELETE' });
      prefs.remove(`draft.${keyOf(node, id)}`);
      location.hash = '#/';
    }
  }
});

// Native text view: selecting text inside a canvas terminal on a phone is painful, so show it as plain text.
async function openTextView() {
  let text = null;
  try {
    ({ text } = await devApi(term.node, `sessions/${term.sessionId}/text?lines=3000`));
  } catch {
    // use the local buffer
  }
  if (!text) {
    const buf = term.instance.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
    text = lines.join('\n');
  }
  const view = $('#text-view');
  view.dataset.raw = text.replace(/\s+$/, '');
  view.textContent = view.dataset.raw;
  $('#text-search').value = '';
  $('#text-count').textContent = '';
  $('#dlg-text').showModal();
  view.scrollTop = view.scrollHeight;
}

$('#btn-copy-all').addEventListener('click', () => {
  const view = $('#text-view');
  copyText(view.textContent).then(
    () => toast('コピーしました'),
    () => {
      // Clipboard API needs HTTPS; select everything so the native copy menu can be used.
      const range = document.createRange();
      range.selectNodeContents(view);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('全選択しました。メニューからコピーしてください');
    }
  );
});

function openHistory() {
  const items = prefs.get('history', []);
  $('#list-title').textContent = '送信履歴';
  const list = $('#list-items');
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = 'まだ履歴はありません';
    list.append(li);
  }
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    li.addEventListener('click', () => {
      $('#dlg-list').close();
      input.value = text;
      autosize();
      saveDraft();
      input.focus();
    });
    list.append(li);
  }
  $('#dlg-list').showModal();
}

function editText(title, help, key, fallback, after) {
  $('#edit-title').textContent = title;
  $('#edit-help').textContent = help;
  $('#edit-text').value = prefs.get(key, fallback);
  const dlg = $('#dlg-edit');
  dlg.onclose = () => {
    if (dlg.returnValue === 'ok') prefs.set(key, $('#edit-text').value);
    if (dlg.returnValue === 'reset') prefs.set(key, fallback);
    dlg.returnValue = '';
    after();
    term.fitSoon();
  };
  dlg.showModal();
}

// Tapping the dimmed backdrop closes any sheet.
for (const dlg of document.querySelectorAll('dialog.sheet')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dlg.close('cancel');
    }
  });
}

// ---------- settings & push ----------

function openSettings() {
  $('#set-theme').value = prefs.get('theme', 'midnight');
  $('#set-contrast').value = String(prefs.get('contrast', highContrastDefault() ? 7 : 4.5));
  $('#set-line-height').value = String(prefs.get('lineHeight', 1.15));
  $('#set-ui-scale').value = String(prefs.get('uiScale', 1));
  $('#set-bold').checked = prefs.get('boldText', false);
  $('#set-lang').value = prefs.get('lang', 'ja-JP');
  $('#set-enter-send').checked = prefs.get('enterSends', true);
  $('#set-auto-enter').checked = prefs.get('autoEnter', true);
  $('#set-choices').checked = prefs.get('choices', true);
  $('#set-haptics').checked = prefs.get('haptics', true);
  $('#set-wake').checked = prefs.get('wakeLock', false);
  $('#set-lock').checked = Boolean(prefs.get('lockCredential', null));
  updatePushState();
}

$('#set-theme').addEventListener('change', (e) => {
  prefs.set('theme', e.target.value);
  applyTheme();
});
for (const [id, key] of [['#set-contrast', 'contrast'], ['#set-line-height', 'lineHeight'], ['#set-ui-scale', 'uiScale']]) {
  $(id).addEventListener('change', (e) => {
    prefs.set(key, Number(e.target.value));
    applyReadability();
  });
}
$('#set-bold').addEventListener('change', (e) => {
  prefs.set('boldText', e.target.checked);
  applyReadability();
});
$('#set-lang').addEventListener('change', (e) => prefs.set('lang', e.target.value));
$('#set-enter-send').addEventListener('change', (e) => prefs.set('enterSends', e.target.checked));
$('#set-auto-enter').addEventListener('change', (e) => prefs.set('autoEnter', e.target.checked));
$('#set-choices').addEventListener('change', (e) => prefs.set('choices', e.target.checked));
$('#set-haptics').addEventListener('change', (e) => prefs.set('haptics', e.target.checked));
$('#btn-logout').addEventListener('click', async () => {
  if (!confirm('このアプリに登録したすべての機器とトークンを削除しますか？（機器側のセッションは止まりません）')) return;
  await unregisterPush(devices.list).catch(() => {});
  devices.list = [];
  devices.save();
  state.live.clear();
  showLogin();
});

function pushSupported() {
  if (NATIVE) return true;
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const NTFY_URL = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';

// Android: notifications reach the app through a UnifiedPush distributor app (e.g. ntfy) even
// when Remota is closed; no Google account or server of ours is involved.
function nativePush() {
  try {
    return JSON.parse(NATIVE.pushStatus());
  } catch {
    return {};
  }
}

async function updatePushState() {
  const el = $('#push-state');
  const btn = $('#btn-push');
  if (NATIVE) {
    const st = nativePush();
    const noDistributor = !st.distributors || !st.distributors.length;
    btn.disabled = false;
    if (st.endpoint) {
      el.textContent = `有効：${devices.list.length}台の完了・承認待ちを、アプリを閉じていても通知します`;
      btn.textContent = '無効化';
    } else if (noDistributor || st.error === 'NO_DISTRIBUTOR') {
      el.textContent = '受信用アプリが必要です（ntfy など UnifiedPush 対応アプリ。無料）';
      btn.textContent = 'ntfy を入手';
    } else {
      el.textContent = st.error ? `登録できませんでした（${st.error}）` : '無効';
      btn.textContent = '有効化';
    }
    return;
  }
  if (!pushSupported()) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    el.textContent = !window.isSecureContext
      ? 'HTTPS接続が必要です（機器の設定ページで証明書を登録してください）'
      : ios
        ? 'iOSはホーム画面に追加したアプリから有効化できます'
        : 'このブラウザは非対応です';
    btn.disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  el.textContent = sub
    ? `有効：登録済みの${devices.list.length}台すべての完了・承認待ちを通知します`
    : Notification.permission === 'denied'
      ? 'ブラウザ設定で通知が拒否されています'
      : '無効';
  btn.disabled = false;
  btn.textContent = sub ? '無効化' : '有効化';
}

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The phone's own VAPID key pair. Push services accept messages only from the key a subscription
// was made with, so every machine signs with this same pair, handed to it when it is registered.
async function ensureVapid() {
  const saved = prefs.get('vapid', null);
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapid = {
    publicKey: bytesToB64(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d,
  };
  prefs.set('vapid', vapid);
  return vapid;
}

async function currentSubscription() {
  if (NATIVE) {
    const st = nativePush();
    return st.endpoint ? { endpoint: st.endpoint, toJSON: () => ({ endpoint: st.endpoint, keys: { p256dh: st.p256dh, auth: st.auth } }) } : null;
  }
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Tells each machine where and how to push; safe to repeat (machines replace by endpoint).
async function registerPush(list) {
  const sub = await currentSubscription();
  // In the app the distributor's endpoint accepts each machine's own VAPID signature, so no shared key.
  const vapid = NATIVE ? undefined : prefs.get('vapid', null);
  if (!sub || (!NATIVE && !vapid)) return;
  await Promise.all(list.map((dev) =>
    request(dev, 'push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), vapid, device: dev.id }) }).catch(() => {})
  ));
}

async function unregisterPush(list) {
  const sub = await currentSubscription();
  if (!sub) return;
  await Promise.all(list.map((dev) =>
    request(dev, 'push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }), timeout: 5000 }).catch(() => {})
  ));
}

$('#btn-push').addEventListener('click', async () => {
  if (NATIVE) {
    const st = nativePush();
    if (st.endpoint) {
      await unregisterPush(devices.list);
      NATIVE.pushDisable();
      toast('通知を無効にしました');
    } else if (!st.distributors || !st.distributors.length) {
      NATIVE.openExternal(NTFY_URL);
    } else {
      // The endpoint arrives through RemotaBridge.onPush, which registers it with every machine.
      NATIVE.pushEnable();
    }
    setTimeout(updatePushState, 500);
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await unregisterPush(devices.list);
      await existing.unsubscribe();
      toast('通知を無効にしました');
    } else {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('通知が許可されませんでした');
      const vapid = await ensureVapid();
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapid.publicKey) });
      await registerPush(devices.list);
      toast(`通知を有効にしました（${devices.list.length}台）`);
    }
  } catch (ex) {
    toast(ex.message);
  }
  updatePushState();
});

$('#btn-push-test').addEventListener('click', async () => {
  const results = await Promise.all(devices.list.map((dev) => request(dev, 'push/test', { method: 'POST' }).then(() => true, () => false)));
  const ok = results.filter(Boolean).length;
  toast(`${ok}/${devices.list.length}台からテスト通知を送信しました`);
});

// ---------- sheets: shared bits ----------

for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());

$('#btn-snippets').addEventListener('pointerdown', (e) => e.preventDefault());
$('#btn-snippets').addEventListener('click', () => {
  prefs.set('showSnippets', !prefs.get('showSnippets', false));
  renderSnippets();
  term.fitSoon();
});

// ---------- QR code scanning ----------

// Reads a QR code with the camera (BarcodeDetector when the browser has it, jsQR otherwise).
// Cameras need HTTPS or localhost; on plain HTTP a photo of the code works everywhere.
let qrStop = null;

function scanQr(onResult) {
  const dlg = $('#dlg-qr');
  const video = $('#qr-video');
  const status = $('#qr-status');
  let stream = null;
  let raf = 0;
  let done = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;

  const finish = (text) => {
    if (done) return;
    done = true;
    haptic(30);
    dlg.close();
    onResult(text);
  };
  const decode = async (source, w, h) => {
    if (detector) {
      const codes = await detector.detect(source).catch(() => []);
      if (codes[0]) return codes[0].rawValue;
    }
    if (!window.jsQR || !w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(source, 0, 0, w, h);
    const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    return code ? code.data : null;
  };
  const tick = async () => {
    if (done || !stream) return;
    if (video.readyState >= 2) {
      const scale = Math.min(1, 640 / video.videoWidth);
      const text = await decode(video, Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale));
      if (text) return finish(text);
    }
    raf = requestAnimationFrame(tick);
  };
  qrStop = () => {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  };
  dlg.onclose = () => qrStop && qrStop();

  $('#qr-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    status.textContent = '読み取り中…';
    const img = await createImageBitmap(file).catch(() => null);
    const scale = img ? Math.min(1, 1200 / Math.max(img.width, img.height)) : 1;
    const text = img && (await decode(img, Math.round(img.width * scale), Math.round(img.height * scale)));
    if (text) finish(text);
    else status.textContent = 'QRコードが見つかりませんでした。もう一度お試しください';
  };
  $('#btn-qr-photo').onclick = () => $('#qr-file').click();

  dlg.showModal();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
    status.textContent = 'この接続ではカメラを使えません。「写真から読み取る」を使ってください';
    return;
  }
  status.textContent = 'カメラを起動しています…';
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then((s) => {
      if (done || !dlg.open) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      video.srcObject = s;
      video.play().catch(() => {});
      status.textContent = '機器に表示された QR コードを枠に合わせてください';
      tick();
    })
    .catch(() => {
      status.textContent = 'カメラを使えませんでした。「写真から読み取る」を使ってください';
    });
}

$('#btn-login-url').addEventListener('click', () => openAddDevice());

$('#btn-login-qr').addEventListener('click', () =>
  scanQr(async (text) => {
    const err = $('#login-error');
    err.hidden = true;
    try {
      await addDevice({ url: text });
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  })
);

// ---------- quick launch (favourites) ----------

function favorites() {
  return prefs.get('favorites', []).filter((f) => devices.get(f.node));
}

function addFavorite({ node, cwd, command, name }) {
  const list = prefs.get('favorites', []).filter((f) => !(f.node === node && f.cwd === cwd && f.command === command));
  list.unshift({ id: randomId().slice(0, 8), node, cwd, command, name: name || cwd.split('/').filter(Boolean).pop() || cwd });
  prefs.set('favorites', list.slice(0, 12));
  toast('クイック起動に追加しました');
  renderQuick();
}

function renderQuick() {
  const favs = favorites();
  $('#quick-section').hidden = !favs.length;
  const list = $('#quick-list');
  list.replaceChildren();
  for (const f of favs) {
    const dev = devices.get(f.node);
    const kind = agentKind(f.command);
    const b = document.createElement('button');
    b.className = 'quick';
    b.innerHTML = `${agentIcon(kind)}<strong></strong><small></small>`;
    b.querySelector('strong').textContent = f.name;
    b.querySelector('small').textContent = `${state.nodes.length > 1 ? `${dev.name} · ` : ''}${f.command || 'shell'}`;
    let timer = null;
    let removed = false;
    // Long-press to remove, tap to launch.
    b.addEventListener('pointerdown', () => {
      removed = false;
      timer = setTimeout(() => {
        removed = true;
        if (confirm(`「${f.name}」をクイック起動から外しますか？`)) {
          prefs.set('favorites', prefs.get('favorites', []).filter((x) => x.id !== f.id));
          renderQuick();
        }
      }, 600);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
    b.addEventListener('click', () => !removed && launchFavorite(f));
    list.append(b);
  }
}

async function launchFavorite(f) {
  haptic(15);
  try {
    const s = await devApi(f.node, 'sessions', { method: 'POST', body: JSON.stringify({ name: f.name, cwd: f.cwd, command: f.command }) });
    state.sessions.push({ ...s, node: f.node });
    openSession(f.node, s.id);
  } catch (ex) {
    toast(`起動できませんでした: ${ex.message}`);
  }
}

// ---------- reviewing an agent's work: git changes ----------

function diffLines(diff, container) {
  const frag = document.createDocumentFragment();
  for (const line of diff.split('\n')) {
    const el = document.createElement('span');
    el.className = 'ln';
    if (line.startsWith('diff --git')) {
      el.classList.add('fileh');
      el.textContent = line.replace(/^diff --git a\/(.*) b\/.*$/, '$1');
    } else if (line.startsWith('@@')) {
      el.classList.add('hunk');
      el.textContent = line;
    } else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) {
      continue;
    } else {
      if (line.startsWith('+')) el.classList.add('add');
      else if (line.startsWith('-')) el.classList.add('del');
      el.textContent = line || ' ';
    }
    frag.append(el);
  }
  container.replaceChildren(frag);
}

async function openGit(file = '') {
  const dlg = $('#dlg-git');
  if (!dlg.open) dlg.showModal();
  const view = $('#git-diff');
  view.innerHTML = '<div class="note">読み込み中…</div>';
  let g;
  try {
    g = await devApi(term.node, `sessions/${term.sessionId}/git${file ? `?file=${encodeURIComponent(file)}` : ''}`);
  } catch (ex) {
    view.innerHTML = '';
    view.append(Object.assign(document.createElement('div'), { className: 'note', textContent: ex.message }));
    return;
  }
  const summary = $('#git-summary');
  const files = $('#git-files');
  if (!g.repo) {
    summary.replaceChildren();
    files.replaceChildren();
    view.innerHTML = '<div class="note">この作業フォルダは git リポジトリではありません。</div>';
    return;
  }
  summary.innerHTML = '<span class="branch"></span><span></span>';
  summary.querySelector('.branch').textContent = g.branch;
  summary.lastChild.textContent = g.files.length ? `${g.files.length}ファイル変更${g.commits[0] ? ` · 最新: ${g.commits[0].subject} (${g.commits[0].when})` : ''}` : '変更はありません';
  if (!file) {
    files.replaceChildren();
    const all = document.createElement('li');
    all.className = 'on';
    all.innerHTML = '<span class="gcode">∑</span><span class="fname">すべての変更</span>';
    all.addEventListener('click', () => openGit());
    files.append(all);
    for (const f of g.files) {
      const li = document.createElement('li');
      const code = f.code === '??' ? 'N' : f.code[0];
      li.innerHTML = `<span class="gcode ${code}"></span><span class="fname"></span>`;
      li.querySelector('.gcode').textContent = code;
      li.querySelector('.fname').textContent = f.path;
      li.addEventListener('click', () => {
        files.querySelectorAll('li').forEach((x) => x.classList.remove('on'));
        li.classList.add('on');
        openGit(f.path);
      });
      files.append(li);
    }
  }
  if (!g.diff) view.innerHTML = '<div class="note">差分はありません。</div>';
  else diffLines(g.diff + (g.truncated ? '\n… (長いため省略)' : ''), view);
  view.scrollTop = 0;
}

$('#btn-git').addEventListener('click', () => openGit());
$('#btn-git-refresh').addEventListener('click', () => openGit());

// ---------- reviewing an agent's work: files ----------

let filePath = '';

async function openFiles(rel = filePath) {
  const dlg = $('#dlg-files');
  if (!dlg.open) dlg.showModal();
  const list = $('#file-list');
  const view = $('#file-view');
  let r;
  try {
    r = await devApi(term.node, `sessions/${term.sessionId}/files?path=${encodeURIComponent(rel)}`);
  } catch (ex) {
    if (rel) return openFiles('');
    toast(ex.message);
    return;
  }
  filePath = r.path;
  renderCrumbs(r.path, r.type === 'dir');
  $('#btn-file-insert').hidden = r.type === 'dir';
  if (r.type === 'dir') {
    view.hidden = true;
    list.hidden = false;
    list.replaceChildren();
    for (const e of r.entries) {
      const li = document.createElement('li');
      li.className = e.dir ? 'dir' : '';
      li.innerHTML = `<svg class="ico"><use href="#i-${e.dir ? 'folder' : 'file'}"/></svg><span class="fname"></span><small></small>`;
      li.querySelector('.fname').textContent = e.name;
      li.querySelector('.fname').style.direction = 'ltr';
      li.querySelector('small').textContent = e.dir ? '' : `${e.size < 1024 ? `${e.size}B` : `${Math.round(e.size / 1024)}KB`} · ${timeAgo(e.mtime)}`;
      li.addEventListener('click', () => openFiles(r.path ? `${r.path}/${e.name}` : e.name));
      list.append(li);
    }
    if (!r.entries.length) list.innerHTML = '<li class="text-3">空のフォルダ</li>';
    return;
  }
  list.hidden = true;
  view.hidden = false;
  view.replaceChildren();
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(r.path)) {
    // Images need the token, so fetch them as blobs instead of pointing <img> at the URL.
    const dev = devices.get(term.node);
    const rawPath = `/api/sessions/${term.sessionId}/raw?path=${encodeURIComponent(r.path)}`;
    const blob = NATIVE
      ? await nativeFetch(dev, dev.url, rawPath).then((x) => new Blob([x.bytes], { type: x.type }))
      : await fetch(`${dev.url}${rawPath}`, { headers: { Authorization: `Bearer ${dev.token}` } }).then((x) => x.blob());
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    view.append(img);
  } else if (r.binary) {
    view.innerHTML = '<div class="note">バイナリファイルのため表示できません。</div>';
  } else {
    const frag = document.createDocumentFragment();
    r.content.split('\n').forEach((line, i) => {
      const el = document.createElement('span');
      el.className = 'ln';
      el.innerHTML = '<span class="num"></span>';
      el.firstChild.textContent = i + 1;
      el.append(line || ' ');
      frag.append(el);
    });
    view.append(frag);
    if (r.truncated) view.append(Object.assign(document.createElement('div'), { className: 'note', textContent: '… 大きいファイルのため先頭のみ表示しています' }));
  }
  view.scrollTop = 0;
}

function renderCrumbs(rel, isDir) {
  const crumbs = $('#file-crumbs');
  crumbs.replaceChildren();
  const parts = rel ? rel.split('/') : [];
  const add = (label, target) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => openFiles(target));
    crumbs.append(b);
  };
  add('作業フォルダ', '');
  parts.forEach((p, i) => {
    crumbs.append(Object.assign(document.createElement('span'), { textContent: '/' }));
    if (i === parts.length - 1 && !isDir) crumbs.append(Object.assign(document.createElement('span'), { textContent: p }));
    else add(p, parts.slice(0, i + 1).join('/'));
  });
}

$('#btn-files').addEventListener('click', () => openFiles(''));

// Referencing a file for the agent: `@path` is how Claude Code attaches a file to a message.
$('#btn-file-insert').addEventListener('click', () => {
  input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}@${filePath} `;
  autosize();
  saveDraft();
  $('#dlg-files').close();
  input.focus();
});

// ---------- keep the screen on while watching an agent ----------

let wakeLock = null;

async function updateWakeLock() {
  const want = prefs.get('wakeLock', false) && !$('#view-term').hidden && !document.hidden;
  if (want && !wakeLock && 'wakeLock' in navigator) {
    wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    if (wakeLock) wakeLock.addEventListener('release', () => (wakeLock = null));
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

$('#set-wake').addEventListener('change', (e) => {
  prefs.set('wakeLock', e.target.checked);
  if (e.target.checked && !('wakeLock' in navigator)) toast('このブラウザは画面ロック防止に対応していません');
  updateWakeLock();
});

// ---------- app lock with Face ID / fingerprint (WebAuthn platform authenticator) ----------

// A local gate only: the device's biometrics must succeed before the app shows anything.
const LOCK_AFTER_MS = 60 * 1000;
let hiddenAt = 0;

function lockSupported() {
  if (NATIVE) return NATIVE.canAuthenticate();
  return window.isSecureContext && window.PublicKeyCredential && navigator.credentials;
}

async function verifyUser() {
  const cred = prefs.get('lockCredential', null);
  if (!cred) return true;
  if (NATIVE) return nativeAuthenticate();
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: b64ToBytes(cred) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function showLock() {
  $('#view-lock').hidden = false;
  document.body.classList.add('locked');
}

async function unlock() {
  if (await verifyUser()) {
    $('#view-lock').hidden = true;
    document.body.classList.remove('locked');
    return true;
  }
  toast('認証できませんでした');
  return false;
}

$('#btn-unlock').addEventListener('click', unlock);

$('#set-lock').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    if (!(await verifyUser())) {
      e.target.checked = true;
      return;
    }
    prefs.remove('lockCredential');
    toast('ロックを解除しました');
    return;
  }
  if (!lockSupported()) {
    e.target.checked = false;
    toast(NATIVE ? 'この端末では生体認証・画面ロックが設定されていません' : 'HTTPS 接続のときに使えます');
    return;
  }
  if (NATIVE) {
    if (await nativeAuthenticate()) {
      prefs.set('lockCredential', 'native');
      toast('生体認証でのロックを有効にしました');
    } else e.target.checked = false;
    return;
  }
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Remota' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'remota', displayName: 'Remota' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
      },
    });
    prefs.set('lockCredential', bytesToB64(cred.rawId));
    toast('Face ID / 指紋でのロックを有効にしました');
  } catch {
    e.target.checked = false;
    toast('登録できませんでした');
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (prefs.get('lockCredential', null) && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
    showLock();
    unlock();
  }
  updateWakeLock();
});

// ---------- text view search ----------

let textMatches = [];
let textIndex = 0;

function runTextSearch() {
  const view = $('#text-view');
  const raw = view.dataset.raw || '';
  const q = $('#text-search').value;
  textMatches = [];
  if (!q) {
    view.textContent = raw;
    $('#text-count').textContent = '';
    return;
  }
  const frag = document.createDocumentFragment();
  const lower = raw.toLowerCase();
  const needle = q.toLowerCase();
  let pos = 0;
  for (let i = lower.indexOf(needle); i !== -1 && textMatches.length < 2000; i = lower.indexOf(needle, i + needle.length)) {
    frag.append(raw.slice(pos, i));
    const mark = document.createElement('mark');
    mark.textContent = raw.slice(i, i + q.length);
    frag.append(mark);
    textMatches.push(mark);
    pos = i + q.length;
  }
  frag.append(raw.slice(pos));
  view.replaceChildren(frag);
  textIndex = textMatches.length - 1;
  focusMatch();
}

function focusMatch() {
  $('#text-count').textContent = textMatches.length ? `${textIndex + 1}/${textMatches.length}` : '0件';
  textMatches.forEach((m, i) => m.classList.toggle('cur', i === textIndex));
  if (textMatches[textIndex]) textMatches[textIndex].scrollIntoView({ block: 'center' });
}

let searchTimer = null;
$('#text-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runTextSearch, 150);
});
$('#btn-text-prev').addEventListener('click', () => {
  if (!textMatches.length) return;
  textIndex = (textIndex - 1 + textMatches.length) % textMatches.length;
  focusMatch();
});
$('#btn-text-next').addEventListener('click', () => {
  if (!textMatches.length) return;
  textIndex = (textIndex + 1) % textMatches.length;
  focusMatch();
});

// ---------- coding agent notification integration ----------

// Each agent's own hook/plugin tells Remota when it finishes or needs approval — more reliable
// than reading the screen. This sheet turns that on per machine, from the phone.
async function openAgents(nodeId) {
  const dlg = $('#dlg-agents');
  const dev = devices.get(nodeId);
  $('#agents-device').textContent = dev ? dev.name : '';
  const list = $('#agent-list');
  list.innerHTML = '<li class="text-3">読み込み中…</li>';
  if (!dlg.open) dlg.showModal();
  let items;
  try {
    items = await devApi(nodeId, 'agents');
  } catch (ex) {
    list.innerHTML = '';
    list.append(Object.assign(document.createElement('li'), { className: 'error', textContent: ex.message }));
    return;
  }
  // Installed agents first, then ones found on the machine, then the rest.
  items.sort((a, b) => Number(b.installed) - Number(a.installed) || Number(b.present) - Number(a.present));
  list.replaceChildren();
  for (const a of items) {
    const li = document.createElement('li');
    li.className = `agent-row${a.present || a.installed ? '' : ' absent'}`;
    li.innerHTML = `${agentIcon(a.id)}<div class="row-main"><span></span><small></small></div><input type="checkbox" class="switch">`;
    li.querySelector('.row-main span').textContent = a.name;
    li.querySelector('small').textContent = a.error ? a.error : `${a.present ? '' : '未検出 · '}${a.via}`;
    const toggle = li.querySelector('input');
    toggle.checked = a.installed;
    toggle.setAttribute('aria-label', `${a.name} の通知連携`);
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try {
        await devApi(nodeId, `agents/${a.id}/${toggle.checked ? 'install' : 'uninstall'}`, { method: 'POST' });
        toast(toggle.checked ? `${a.name}: 連携しました（起動中なら再起動で反映）` : `${a.name}: 連携を外しました`, { ms: 3000 });
      } catch (ex) {
        toggle.checked = !toggle.checked;
        toast(ex.message, { ms: 4000 });
      } finally {
        toggle.disabled = false;
      }
    });
    list.append(li);
  }
}

// ---------- routing & boot ----------

function route() {
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
  const m = location.hash.match(/^#\/s\/([0-9a-z]+)\/([0-9a-f]+)$/);
  if (m && devices.get(m[1])) {
    showView('term');
    term.open(m[1], m[2]);
    term.fitSoon();
    updateWakeLock();
    // Slower poll in the terminal: only for the back-button badge and heads-up toasts.
    startPolling(5000);
  } else {
    saveDraft();
    term.close();
    showView('home');
    switchTab(state.tab || prefs.get('tab', 'sessions'));
    updateWakeLock();
    startPolling(3000);
  }
}

async function boot() {
  if (NATIVE) {
    document.body.classList.add('native');
    const pending = NATIVE.takePending();
    if (pending) setTimeout(() => handleNativeIntent(JSON.parse(pending)), 0);
  }
  // A login link (`remota url` / QR code) carries the token in the fragment: register this machine.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('token')) {
    const token = hash.get('token');
    history.replaceState(null, '', location.pathname);
    try {
      await addDevice({ url: location.origin, token });
    } catch (ex) {
      showLogin();
      $('#login-error').textContent = ex.message;
      $('#login-error').hidden = false;
      return;
    }
  }
  if (!devices.list.length) return showLogin();
  publishDeviceNames();
  route();
  // Machines may have been reinstalled or restarted with fresh state; re-register quietly.
  registerPush(devices.list).catch(() => {});
}

// A login link opened while the app is already showing only changes the fragment; handle it too.
window.addEventListener('hashchange', () => (/[#&]token=/.test(location.hash) ? boot() : route()));
window.addEventListener('online', () => term.reconnectNow());
window.addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveDraft();
    return;
  }
  term.reconnectNow();
  if (devices.list.length) refreshSessions();
});

if (!NATIVE && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.sessionId && e.data.device) openSession(e.data.device, e.data.sessionId);
  });
}

applyTheme();
applyReadability();
renderKeybar();
renderSnippets();
trackViewport();
boot();
