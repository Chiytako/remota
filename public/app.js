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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

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
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
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

// ---------- state ----------

const state = {
  info: null,
  sessions: [],
  statuses: new Map(),
  pollTimer: null,
  presetIndex: 0,
};

// ---------- login ----------

function showLogin() {
  stopPolling();
  term.close();
  showView('login');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('#login-token').value.trim() }) });
    $('#login-token').value = '';
    await boot();
  } catch (ex) {
    err.textContent = ex.message === 'too many attempts' ? '試行回数が多すぎます。しばらく待ってください。' : 'トークンが違います';
    err.hidden = false;
  }
});

// ---------- home ----------

function sortedSessions() {
  return [...state.sessions].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.lastOutputAt - a.lastOutputAt);
}

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  $('#empty-state').hidden = state.sessions.length > 0;
  for (const s of sortedSessions()) {
    const li = document.createElement('li');
    li.className = `session-card ${s.status}`;
    li.innerHTML = `
      <span class="status-dot ${s.status}"></span>
      <span class="name"></span>
      <span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
      <span class="meta"></span>
      ${s.preview ? '<span class="preview"></span>' : ''}`;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.meta').textContent = `${s.command || 'shell'} · ${s.cwd} · ${timeAgo(s.lastOutputAt)}`;
    if (s.preview) li.querySelector('.preview').textContent = s.preview;
    li.addEventListener('click', () => openSession(s.id));
    list.append(li);
  }
}

function openSession(id) {
  haptic();
  location.hash = `#/s/${id}`;
}

async function refreshSessions() {
  try {
    state.sessions = await api('/api/sessions');
    $('#home-offline').hidden = true;
  } catch (ex) {
    if (ex.message !== 'unauthorized') $('#home-offline').hidden = false;
    return;
  }
  notifyTransitions();
  if (!$('#view-home').hidden) renderSessions();
  updateBadges();
}

// In-app heads-up when another session starts waiting for approval.
function notifyTransitions() {
  for (const s of state.sessions) {
    const prev = state.statuses.get(s.id);
    if (prev && prev !== 'waiting' && s.status === 'waiting' && s.id !== term.sessionId) {
      haptic(30);
      toast(`⏳ ${s.name} が承認待ちです（タップで開く）`, { ms: 6000, onClick: () => openSession(s.id) });
    }
    state.statuses.set(s.id, s.status);
  }
}

function updateBadges() {
  const waiting = state.sessions.filter((s) => s.status === 'waiting');
  if ('setAppBadge' in navigator) (waiting.length ? navigator.setAppBadge(waiting.length) : navigator.clearAppBadge()).catch(() => {});
  document.title = waiting.length ? `(${waiting.length}) Remota` : 'Remota';
  const others = waiting.filter((s) => s.id !== term.sessionId).length;
  $('#back-badge').hidden = !others;
  $('#back-badge').textContent = others;
}

function startPolling(interval) {
  stopPolling();
  refreshSessions();
  state.pollTimer = setInterval(() => !document.hidden && refreshSessions(), interval);
}

function stopPolling() {
  clearInterval(state.pollTimer);
}

$('#btn-new').addEventListener('click', openNewDialog);
$('#btn-settings').addEventListener('click', openSettings);

function openNewDialog() {
  const presets = (state.info && state.info.presets) || [{ name: 'Shell', command: '' }];
  const chips = $('#preset-list');
  chips.replaceChildren();
  const pick = (i) => {
    state.presetIndex = i;
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
  pick(Math.min(prefs.get('lastPreset', 1), presets.length - 1));

  const history = prefs.get('cwdHistory', []);
  $('#new-cwd').value = history[0] || (state.info && state.info.defaultCwd) || '';
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
  $('#new-name').value = '';
  $('#new-error').hidden = true;
  $('#dlg-new').showModal();
}

$('#new-form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const cwd = $('#new-cwd').value.trim();
  try {
    const s = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: $('#new-name').value, cwd, command: $('#new-command').value.trim() }),
    });
    prefs.set('lastPreset', state.presetIndex);
    prefs.set('cwdHistory', [cwd, ...prefs.get('cwdHistory', []).filter((d) => d !== cwd)].slice(0, 10));
    $('#dlg-new').close();
    state.sessions.push(s);
    openSession(s.id);
  } catch (ex) {
    $('#new-error').textContent = ex.message;
    $('#new-error').hidden = false;
  }
});

// ---------- terminal & connection ----------

// Identifies this browser tab to the server so inputs re-sent after a reconnect are applied once.
const CLIENT_ID = randomId();

const term = {
  instance: null,
  fit: null,
  ws: null,
  sessionId: null,
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

  open(id) {
    this.ensure();
    if (this.sessionId === id && this.ws && this.ws.readyState <= 1) return;
    this.close();
    this.sessionId = id;
    this.retry = 0;
    this.epoch = null;
    this.seq = null;
    this.pending = [];
    this.instance.reset();
    hideChoices();
    const s = state.sessions.find((x) => x.id === id);
    $('#term-name').textContent = s ? s.name : '';
    restoreDraft();
    this.connect();
  },

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.sessionId) return;
    this.fitSoon();
    const { cols, rows } = this.instance;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ session: this.sessionId, cols, rows, client: CLIENT_ID });
    if (this.epoch && this.seq !== null) {
      params.set('epoch', this.epoch);
      params.set('since', this.seq);
    }
    const ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
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
  bar.hidden = !prefs.get('showSnippets', true);
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
    await api(`/api/sessions/${term.sessionId}/scroll`, {
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
  api(`/api/sessions/${term.sessionId}/scroll`, { method: 'POST', body: JSON.stringify({ direction: 'exit' }) }).catch(() => {});
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
  if (input.value) prefs.set(`draft.${term.sessionId}`, input.value);
  else prefs.remove(`draft.${term.sessionId}`);
}

function restoreDraft() {
  input.value = prefs.get(`draft.${term.sessionId}`, '');
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
    const res = await api(`/api/upload?session=${term.sessionId}`, {
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
    if (s.id === term.sessionId) li.className = 'current';
    li.innerHTML = `<span class="status-dot ${s.status}"></span><span class="name"></span><span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
    li.querySelector('.name').textContent = s.name;
    li.addEventListener('click', () => {
      $('#dlg-switch').close();
      openSession(s.id);
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
  if (action === 'text') {
    openTextView();
  } else if (action === 'history') {
    openHistory();
  } else if (action === 'snippets') {
    prefs.set('showSnippets', !prefs.get('showSnippets', true));
    renderSnippets();
    term.fitSoon();
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
      await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      $('#term-name').textContent = name;
    }
  } else if (action === 'kill') {
    if (confirm('このセッションを終了しますか？実行中のプロセスも終了します。')) {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      prefs.remove(`draft.${id}`);
      location.hash = '#/';
    }
  }
});

// Native text view: selecting text inside a canvas terminal on a phone is painful, so show it as plain text.
async function openTextView() {
  let text = null;
  try {
    ({ text } = await api(`/api/sessions/${term.sessionId}/text?lines=3000`));
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
  view.textContent = text.replace(/\s+$/, '');
  $('#dlg-text').showModal();
  view.scrollTop = view.scrollHeight;
}

$('#btn-copy-all').addEventListener('click', () => {
  const view = $('#text-view');
  navigator.clipboard.writeText(view.textContent).then(
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
  updatePushState();
  $('#dlg-settings').showModal();
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
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  $('#dlg-settings').close();
  showLogin();
});

function pushSupported() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function updatePushState() {
  const el = $('#push-state');
  const btn = $('#btn-push');
  if (!pushSupported()) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    el.textContent = !window.isSecureContext
      ? 'HTTPS接続が必要です（READMEのTailscale手順を参照）'
      : ios
        ? 'iOSはホーム画面に追加したアプリから有効化できます'
        : 'このブラウザは非対応です';
    btn.disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  el.textContent = sub ? '有効：完了・承認待ちを通知します' : Notification.permission === 'denied' ? 'ブラウザ設定で通知が拒否されています' : '無効';
  btn.disabled = false;
  btn.textContent = sub ? '無効化' : '有効化';
}

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

$('#btn-push').addEventListener('click', async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: existing.endpoint }) });
      await existing.unsubscribe();
    } else {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('通知が許可されませんでした');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.info.vapidPublicKey) });
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
      toast('通知を有効にしました');
    }
  } catch (ex) {
    toast(ex.message);
  }
  updatePushState();
});

$('#btn-push-test').addEventListener('click', async () => {
  try {
    const r = await api('/api/push/test', { method: 'POST' });
    toast(r.subscribers ? '送信しました' : '通知先が未登録です（Webhookのみ送信）');
  } catch (ex) {
    toast(ex.message);
  }
});

// ---------- routing & boot ----------

function route() {
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
  const m = location.hash.match(/^#\/s\/([0-9a-f]+)/);
  if (m) {
    showView('term');
    term.open(m[1]);
    term.fitSoon();
    // Slower poll in the terminal: only for the back-button badge and heads-up toasts.
    startPolling(5000);
  } else {
    saveDraft();
    term.close();
    showView('home');
    startPolling(3000);
  }
}

async function boot() {
  try {
    state.info = await api('/api/info');
  } catch (ex) {
    if (ex.message !== 'unauthorized') {
      // Server unreachable: keep trying rather than showing a dead screen.
      showView('home');
      $('#home-offline').hidden = false;
      setTimeout(boot, 3000);
    }
    return;
  }
  $('#host-label').textContent = `${state.info.user}@${state.info.hostname}`;
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('online', () => term.reconnectNow());
window.addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveDraft();
    return;
  }
  term.reconnectNow();
  if (state.info) refreshSessions();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.sessionId) openSession(e.data.sessionId);
  });
}

applyTheme();
applyReadability();
renderKeybar();
renderSnippets();
trackViewport();
boot();
