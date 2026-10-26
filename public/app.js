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
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分前`;
  if (s < 86400) return `${Math.round(s / 3600)}時間前`;
  return `${Math.round(s / 86400)}日前`;
}

const STATUS_LABEL = { running: '実行中', idle: '待機', waiting: '承認待ち', exited: '終了' };

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

// ---------- state ----------

const state = {
  info: null,
  sessions: [],
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

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  $('#empty-state').hidden = state.sessions.length > 0;
  for (const s of state.sessions) {
    const li = document.createElement('li');
    li.className = 'session-card';
    li.innerHTML = `
      <span class="status-dot ${s.status}"></span>
      <span class="name"></span>
      <span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
      <span class="meta"></span>
      ${s.preview ? '<span class="preview"></span>' : ''}`;
    li.querySelector('.name').textContent = s.name;
    li.querySelector('.meta').textContent = `${s.command || 'shell'} · ${s.cwd} · ${timeAgo(s.lastOutputAt)}`;
    if (s.preview) li.querySelector('.preview').textContent = s.preview;
    li.addEventListener('click', () => (location.hash = `#/s/${s.id}`));
    list.append(li);
  }
}

async function refreshSessions() {
  try {
    state.sessions = await api('/api/sessions');
    renderSessions();
    updateBadge();
  } catch {
    // shown via login redirect or next poll
  }
}

function updateBadge() {
  const waiting = state.sessions.filter((s) => s.status === 'waiting').length;
  if ('setAppBadge' in navigator) (waiting ? navigator.setAppBadge(waiting) : navigator.clearAppBadge()).catch(() => {});
  document.title = waiting ? `(${waiting}) Remota` : 'Remota';
}

function startPolling() {
  stopPolling();
  refreshSessions();
  state.pollTimer = setInterval(() => !document.hidden && refreshSessions(), 3000);
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
  $('#cwd-history').replaceChildren(...history.map((d) => Object.assign(document.createElement('option'), { value: d })));
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
    location.hash = `#/s/${s.id}`;
  } catch (ex) {
    $('#new-error').textContent = ex.message;
    $('#new-error').hidden = false;
  }
});

// ---------- terminal ----------

const term = {
  instance: null,
  fit: null,
  ws: null,
  sessionId: null,
  retry: 0,
  retryTimer: null,
  pingTimer: null,
  ctrl: false,
  scrolledBack: false,
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
      theme: { background: '#000000', foreground: '#e6edf3', cursor: '#58a6ff', selectionBackground: '#264f78' },
    });
    this.fit = new FitAddon.FitAddon();
    t.loadAddon(this.fit);
    t.loadAddon(new WebLinksAddon.WebLinksAddon());
    t.open($('#terminal'));
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
    this.instance = t;
    new ResizeObserver(() => this.fitSoon()).observe($('#terminal-wrap'));
    setupTouchScroll();
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
    this.instance.reset();
    const s = state.sessions.find((x) => x.id === id);
    $('#term-name').textContent = s ? s.name : '';
    this.connect();
  },

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.sessionId) return;
    this.fitSoon();
    const { cols, rows } = this.instance;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${this.sessionId}&cols=${cols}&rows=${rows}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      $('#conn-banner').hidden = true;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.sendJson({ type: 'ping', t: performance.now() }), 5000);
      this.sendJson({ type: 'ping', t: performance.now() });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      if (ev.code === 4404) {
        toast('セッションは終了しています');
        location.hash = '#/';
        return;
      }
      setStatus('offline');
      $('#conn-banner').hidden = false;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  },

  // Network switched or app came back to the foreground: don't wait for the backoff timer.
  reconnectNow() {
    if (!this.sessionId) return;
    if (!this.ws || this.ws.readyState > 1) {
      this.retry = 0;
      this.connect();
    } else {
      this.sendJson({ type: 'ping', t: performance.now() });
    }
  },

  onMessage(msg) {
    const t = this.instance;
    if (msg.type === 'hello') {
      t.reset();
      if (msg.replay) {
        this.replaying = true;
        t.write(msg.replay, () => (this.replaying = false));
      }
      $('#term-name').textContent = msg.session.name;
      $('#menu-title').textContent = msg.session.name;
      this.tmux = msg.session.tmux;
      setStatus(msg.session.status);
      this.sendJson({ type: 'resize', cols: t.cols, rows: t.rows });
    } else if (msg.type === 'output') {
      t.write(msg.data);
    } else if (msg.type === 'status') {
      setStatus(msg.status);
    } else if (msg.type === 'exit') {
      setStatus('exited');
      t.write('\r\n\x1b[90m[セッションが終了しました]\x1b[0m\r\n');
    } else if (msg.type === 'pong') {
      $('#term-latency').textContent = `${Math.round(performance.now() - msg.t)}ms`;
    }
  },

  sendJson(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  },

  send(data) {
    if (this.scrolledBack) exitScrollback();
    this.sendJson({ type: 'input', data });
  },

  // Bracketed paste lets agents receive multi-line text as one message instead of many Enters.
  sendText(text, enter) {
    if (!text) return;
    this.instance.paste(text);
    if (enter) setTimeout(() => this.send('\r'), 40);
  },

  setCtrl(on) {
    this.ctrl = on;
    document.querySelectorAll('.key[data-seq="@ctrl"]').forEach((k) => k.classList.toggle('on', on));
  },

  setFont(delta) {
    this.fontSize = Math.max(8, Math.min(28, this.fontSize + delta));
    prefs.set('fontSize', this.fontSize);
    if (this.instance) {
      this.instance.options.fontSize = this.fontSize;
      this.fitSoon();
    }
  },

  close() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.sessionId = null;
    if (ws) ws.close();
    $('#conn-banner').hidden = true;
  },
};

function setStatus(status) {
  $('#term-status').className = `status-dot ${status}`;
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
    // pointerdown + preventDefault keeps the soft keyboard open while tapping keys.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => pressKey(seq));
    bar.append(b);
  }
}

function pressKey(seq) {
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
  for (const text of prefs.get('snippets', DEFAULT_SNIPPETS).split('\n').filter((l) => l.trim())) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key snippet';
    b.textContent = text;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => term.sendText(text, prefs.get('autoEnter', true)));
    bar.append(b);
  }
}

// ---------- scrolling (tmux history via copy-mode, otherwise xterm's own buffer) ----------

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
    await api(`/api/sessions/${term.sessionId}/scroll`, {
      method: 'POST',
      body: JSON.stringify({ direction: n < 0 ? 'up' : 'down', lines: Math.abs(n) }),
    }).catch(() => {});
  }, 60);
}

function pageScroll(direction) {
  const lines = Math.max(1, term.instance.rows - 2);
  if (!term.tmux) return term.instance.scrollPages(direction === 'up' ? -1 : 1);
  queueScroll(direction === 'up' ? -lines : lines);
}

function exitScrollback() {
  term.scrolledBack = false;
  api(`/api/sessions/${term.sessionId}/scroll`, { method: 'POST', body: JSON.stringify({ direction: 'exit' }) }).catch(() => {});
}

function setupTouchScroll() {
  const el = $('#terminal-wrap');
  let lastY = null;
  let acc = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      lastY = e.touches[0].clientY;
      acc = 0;
    }
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (lastY === null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    acc += lastY - y;
    lastY = y;
    const lineH = term.fontSize * 1.2;
    const lines = Math.trunc(acc / lineH);
    if (lines) {
      acc -= lines * lineH;
      if (term.tmux) queueScroll(lines);
    }
  }, { passive: true });
  el.addEventListener('touchend', () => (lastY = null), { passive: true });
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
input.addEventListener('input', autosize);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && prefs.get('enterSends', true)) {
    e.preventDefault();
    $('#compose').requestSubmit();
  }
});

$('#compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  if (!text) {
    // Empty send acts as plain Enter, handy for confirming prompts.
    term.send('\r');
    return;
  }
  term.sendText(text, prefs.get('autoEnter', true));
  const history = prefs.get('history', []);
  prefs.set('history', [text, ...history.filter((h) => h !== text)].slice(0, 50));
  input.value = '';
  autosize();
});

let recognition = null;
$('#btn-mic').addEventListener('click', () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    input.focus();
    toast('このブラウザは音声認識APIに非対応です。キーボードのマイクボタンで音声入力できます。', 3500);
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
  };
  recognition.onerror = (ev) => toast(`音声認識エラー: ${ev.error}`);
  recognition.onend = () => {
    recognition = null;
    $('#btn-mic').classList.remove('listening');
  };
  recognition.start();
  $('#btn-mic').classList.add('listening');
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
  toast(`アップロード中: ${file.name}`);
  try {
    const res = await api(`/api/upload?session=${term.sessionId}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image.png') },
    });
    input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}${res.relative} `;
    autosize();
    input.focus();
    toast('添付しました（パスを入力欄に挿入）');
  } catch (ex) {
    toast(`アップロード失敗: ${ex.message}`);
  }
}

// ---------- terminal menu ----------

$('#btn-back').addEventListener('click', () => (location.hash = '#/'));
$('#btn-font-up').addEventListener('click', () => term.setFont(1));
$('#btn-font-down').addEventListener('click', () => term.setFont(-1));
$('#btn-term-menu').addEventListener('click', () => $('#dlg-menu').showModal());

$('#dlg-menu').addEventListener('close', async () => {
  const action = $('#dlg-menu').returnValue;
  $('#dlg-menu').returnValue = '';
  const id = term.sessionId;
  if (action === 'snippets') {
    prefs.set('showSnippets', !prefs.get('showSnippets', true));
    renderSnippets();
    term.fitSoon();
  } else if (action === 'edit-snippets') {
    editText('定型文', '1行に1つ。タップで入力欄を経由せず送信します。', 'snippets', DEFAULT_SNIPPETS, renderSnippets);
  } else if (action === 'edit-keys') {
    editText('キーバー', '「ラベル=送信内容」を1行に1つ。\\e=Esc, \\r=Enter, \\t=Tab, \\xNN=制御文字。@ctrl / @pgup / @pgdn は特殊動作。', 'keys', DEFAULT_KEYS, renderKeybar);
  } else if (action === 'rename') {
    const name = prompt('新しい名前', $('#term-name').textContent);
    if (name) {
      await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      $('#term-name').textContent = name;
    }
  } else if (action === 'copy') {
    copyScreen();
  } else if (action === 'kill') {
    if (confirm('このセッションを終了しますか？実行中のプロセスも終了します。')) {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      location.hash = '#/';
    }
  }
});

function copyScreen() {
  const buf = term.instance.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
  const text = lines.join('\n').replace(/\n+$/, '');
  navigator.clipboard.writeText(text).then(
    () => toast('コピーしました'),
    () => {
      // Clipboard API needs HTTPS; fall back to letting the user select the text.
      input.value = text.slice(-4000);
      autosize();
      toast('入力欄に貼り付けました。選択してコピーしてください。');
    }
  );
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

// ---------- settings & push ----------

function openSettings() {
  $('#set-lang').value = prefs.get('lang', 'ja-JP');
  $('#set-enter-send').checked = prefs.get('enterSends', true);
  $('#set-auto-enter').checked = prefs.get('autoEnter', true);
  updatePushState();
  $('#dlg-settings').showModal();
}

$('#set-lang').addEventListener('change', (e) => prefs.set('lang', e.target.value));
$('#set-enter-send').addEventListener('change', (e) => prefs.set('enterSends', e.target.checked));
$('#set-auto-enter').addEventListener('change', (e) => prefs.set('autoEnter', e.target.checked));
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
  const m = location.hash.match(/^#\/s\/([0-9a-f]+)/);
  if (m) {
    stopPolling();
    showView('term');
    term.open(m[1]);
    term.fitSoon();
  } else {
    term.close();
    showView('home');
    startPolling();
  }
}

async function boot() {
  try {
    state.info = await api('/api/info');
  } catch {
    return;
  }
  $('#host-label').textContent = `${state.info.user}@${state.info.hostname}`;
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('online', () => term.reconnectNow());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  term.reconnectNow();
  if (!term.sessionId && state.info) refreshSessions();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open' && e.data.sessionId) location.hash = `#/s/${e.data.sessionId}`;
  });
}

renderKeybar();
renderSnippets();
trackViewport();
boot();
