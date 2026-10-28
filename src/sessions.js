'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const EventEmitter = require('events');
const pty = require('node-pty');
const { CONFIG_DIR, readJson, writeJson } = require('./config');
const { classify, lastLines } = require('./detect');

const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');
// A dedicated tmux socket keeps Remota's sessions apart from the user's own tmux server.
const TMUX_SOCKET = 'remota';
const TMUX_PREFIX = 'remota_';

function hasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tmux(args, opts = {}) {
  return execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });
}

function liveTmuxSessions() {
  try {
    return new Set(tmux(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', REMOTA: '1' };
  if (!env.LANG || !/utf-?8/i.test(env.LANG)) env.LANG = 'C.UTF-8';
  delete env.REMOTA_TOKEN;
  return env;
}

class Session extends EventEmitter {
  constructor(manager, meta) {
    super();
    this.manager = manager;
    this.id = meta.id;
    this.name = meta.name;
    this.cwd = meta.cwd;
    this.command = meta.command || '';
    this.createdAt = meta.createdAt || Date.now();
    this.useTmux = manager.useTmux;
    this.buffer = '';
    // Total characters ever emitted. Clients resume from an offset instead of re-downloading everything.
    this.seq = 0;
    // Changes whenever the server process restarts, so stale offsets are never trusted.
    this.epoch = crypto.randomBytes(4).toString('hex');
    this.pending = '';
    this.flushTimer = null;
    // Last input number applied per client, so inputs re-sent after a reconnect run only once.
    this.inputAcks = new Map();
    this.clients = new Set();
    this.status = 'running';
    this.lastOutputAt = Date.now();
    this.lastInputAt = 0;
    this.outputSinceInput = 0;
    this.notifiedCycle = false;
    // Counts alerts raised for this session; a hub watching this device relays new ones as pushes.
    this.alertSeq = 0;
    this.lastAlert = null;
    this.cols = 100;
    this.rows = 30;
    this.exited = false;
  }

  get tmuxName() {
    return TMUX_PREFIX + this.id;
  }

  start({ attachExisting = false } = {}) {
    const env = { ...childEnv(), REMOTA_SESSION: this.id };
    let file;
    let args;
    if (this.useTmux) {
      if (!attachExisting) {
        const create = ['new-session', '-d', '-s', this.tmuxName, '-c', this.cwd, '-x', String(this.cols), '-y', String(this.rows), '-e', `REMOTA_SESSION=${this.id}`];
        tmux(create, { env });
        // A phone screen has no room for tmux's status bar; scrollback is handled by copy-mode.
        tmux(['set-option', '-t', this.tmuxName, 'status', 'off']);
        tmux(['set-option', '-t', this.tmuxName, 'history-limit', '50000']);
        tmux(['set-option', '-t', this.tmuxName, 'mouse', 'off']);
        if (this.command) tmux(['send-keys', '-t', this.tmuxName, this.command, 'Enter']);
      }
      file = 'tmux';
      args = ['-L', TMUX_SOCKET, '-u', 'attach-session', '-t', this.tmuxName];
    } else {
      file = this.manager.config.shell;
      args = ['-l'];
    }

    this.pty = pty.spawn(file, args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env });
    if (!this.useTmux && this.command) this.pty.write(`${this.command}\r`);

    this.pty.onData((data) => this.onOutput(data));
    this.pty.onExit(() => {
      this.flush();
      this.exited = true;
      this.status = 'exited';
      this.broadcast({ type: 'exit' });
      this.manager.onSessionExit(this);
    });
  }

  onOutput(data) {
    this.buffer += data;
    this.seq += data.length;
    const max = this.manager.config.scrollbackBytes;
    if (this.buffer.length > max) this.buffer = this.buffer.slice(this.buffer.length - max);
    this.lastOutputAt = Date.now();
    this.outputSinceInput += data.length;
    // Agents repaint in many tiny writes; coalescing them cuts message count on slow links.
    this.pending += data;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 12);
    this.manager.scheduleCheck(this);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending) return;
    const data = this.pending;
    this.pending = '';
    this.broadcast({ type: 'output', data, seq: this.seq });
  }

  // Applies one numbered input from a client; duplicates (re-sent after a reconnect) are dropped.
  input(clientId, n, data) {
    if (clientId && Number.isInteger(n)) {
      if (n <= (this.inputAcks.get(clientId) || 0)) return;
      this.inputAcks.set(clientId, n);
      if (this.inputAcks.size > 50) this.inputAcks.delete(this.inputAcks.keys().next().value);
    }
    this.write(data);
  }

  write(data) {
    if (this.exited) return;
    this.pty.write(data);
    this.lastInputAt = Date.now();
    this.outputSinceInput = 0;
    this.notifiedCycle = false;
    if (this.status !== 'running') this.setStatus('running');
  }

  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, cols | 0));
    rows = Math.max(5, Math.min(200, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (!this.exited) this.pty.resize(cols, rows);
  }

  // Makes tmux repaint the whole screen, so a client that just joined sees a clean picture.
  redraw() {
    if (!this.useTmux || this.exited || !this.pty._pty) return;
    try {
      tmux(['refresh-client', '-t', this.pty._pty]);
    } catch {
      // client not registered yet
    }
  }

  // Scrolls tmux's history without the user having to know the copy-mode key bindings.
  scroll(direction, lines = 5) {
    if (!this.useTmux || this.exited) return false;
    try {
      if (direction === 'exit') {
        tmux(['send-keys', '-t', this.tmuxName, '-X', 'cancel']);
        return true;
      }
      tmux(['copy-mode', '-e', '-t', this.tmuxName]);
      const cmd = direction === 'up' ? 'scroll-up' : 'scroll-down';
      tmux(['send-keys', '-t', this.tmuxName, '-X', '-N', String(Math.max(1, Math.min(200, lines | 0))), cmd]);
      return true;
    } catch {
      return false;
    }
  }

  recordAlert(title, body) {
    this.alertSeq += 1;
    this.lastAlert = { title, body, at: Date.now() };
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.broadcast({ type: 'status', status });
    this.manager.emit('change', this);
  }

  attach(ws, { since, epoch, clientId } = {}) {
    this.flush();
    this.clients.add(ws);
    const start = this.seq - this.buffer.length;
    const resume = epoch === this.epoch && Number.isInteger(since) && since >= start && since <= this.seq;
    ws.send(JSON.stringify({
      type: 'hello',
      session: this.toJSON(),
      epoch: this.epoch,
      seq: this.seq,
      resume,
      replay: resume ? this.buffer.slice(since - start) : this.buffer,
      inputAck: (clientId && this.inputAcks.get(clientId)) || 0,
    }));
    return resume;
  }

  // Full scrollback as plain text (tmux history when available), for native selection and copy.
  text(lines = 3000) {
    if (this.useTmux && !this.exited) {
      try {
        return tmux(['capture-pane', '-p', '-J', '-t', this.tmuxName, '-S', `-${Math.max(10, Math.min(50000, lines | 0))}`]);
      } catch {
        // fall through to the raw buffer
      }
    }
    return null;
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(text);
    }
  }

  kill() {
    if (this.useTmux) {
      try {
        tmux(['kill-session', '-t', this.tmuxName]);
      } catch {
        // already gone
      }
    }
    if (!this.exited) this.pty.kill();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      command: this.command,
      createdAt: this.createdAt,
      status: this.status,
      lastOutputAt: this.lastOutputAt,
      clients: this.clients.size,
      tmux: this.useTmux,
      preview: lastLines(this.buffer.slice(-4000), 2),
      alertSeq: this.alertSeq,
      lastAlert: this.lastAlert,
    };
  }

  meta() {
    return { id: this.id, name: this.name, cwd: this.cwd, command: this.command, createdAt: this.createdAt };
  }
}

class SessionManager extends EventEmitter {
  constructor(config, notifier) {
    super();
    this.config = config;
    this.notifier = notifier;
    this.useTmux = config.tmux === true || config.tmux === 'true' || (config.tmux === 'auto' && hasTmux());
    this.sessions = new Map();
    this.timers = new Map();
  }

  // Re-attaches to tmux sessions that outlived a previous server process.
  restore() {
    if (!this.useTmux) return;
    const live = liveTmuxSessions();
    for (const meta of readJson(SESSIONS_FILE, [])) {
      if (!live.has(TMUX_PREFIX + meta.id)) continue;
      const session = new Session(this, meta);
      session.start({ attachExisting: true });
      this.sessions.set(session.id, session);
    }
    this.persist();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map((s) => s.toJSON());
  }

  get(id) {
    return this.sessions.get(id);
  }

  create({ name, cwd, command } = {}) {
    const dir = resolveCwd(cwd || this.config.defaultCwd);
    const id = crypto.randomBytes(4).toString('hex');
    const session = new Session(this, {
      id,
      name: String(name || '').trim().slice(0, 60) || `${path.basename(dir) || 'session'}`,
      cwd: dir,
      command: String(command || '').slice(0, 500),
    });
    session.start();
    this.sessions.set(id, session);
    this.persist();
    this.emit('change', session);
    return session;
  }

  rename(id, name) {
    const session = this.get(id);
    if (!session) return null;
    session.name = String(name).trim().slice(0, 60) || session.name;
    this.persist();
    this.emit('change', session);
    return session;
  }

  remove(id) {
    const session = this.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    this.persist();
    this.emit('change', session);
    return true;
  }

  onSessionExit(session) {
    // With tmux, the attach client can die while the tmux session lives on; reattach in that case.
    if (session.useTmux && liveTmuxSessions().has(session.tmuxName) && this.sessions.has(session.id)) {
      session.exited = false;
      session.status = 'running';
      setTimeout(() => this.sessions.has(session.id) && session.start({ attachExisting: true }), 300);
      return;
    }
    this.emit('change', session);
  }

  persist() {
    writeJson(SESSIONS_FILE, [...this.sessions.values()].map((s) => s.meta()));
  }

  scheduleCheck(session) {
    clearTimeout(this.timers.get(session.id));
    // Prompts are detected quickly; "finished" needs a longer quiet period.
    this.timers.set(session.id, setTimeout(() => this.check(session, false), 1200));
  }

  check(session, quietLongEnough) {
    if (session.exited) return;
    const recent = session.buffer.slice(-6000);
    const guess = classify(recent);
    const quietFor = Date.now() - session.lastOutputAt;

    if (guess === 'waiting') {
      if (session.status !== 'waiting') {
        session.setStatus('waiting');
        this.alert(session, '承認待ち', lastLines(recent, 3));
      }
      return;
    }
    if (guess === 'working') {
      session.setStatus('running');
      // Keep watching: the agent may go quiet later.
      this.timers.set(session.id, setTimeout(() => this.check(session, false), this.config.idleSeconds * 1000));
      return;
    }
    if (!quietLongEnough) {
      const wait = Math.max(0, this.config.idleSeconds * 1000 - quietFor);
      this.timers.set(session.id, setTimeout(() => this.check(session, true), wait));
      return;
    }
    if (session.status === 'running') {
      session.setStatus('idle');
      // Only bother the user when something substantial ran after their last keystroke.
      if (session.lastInputAt && session.outputSinceInput > 400) this.alert(session, '完了', lastLines(recent, 3));
    }
  }

  alert(session, kind, body) {
    if (session.notifiedCycle && kind === '完了') return;
    session.notifiedCycle = true;
    session.recordAlert(`${session.name}: ${kind}`, body || kind);
    this.notifier.send({ title: `${session.name}: ${kind}`, body: body || kind, sessionId: session.id }).catch(() => {});
  }
}

function resolveCwd(dir) {
  const home = require('os').homedir();
  const expanded = dir.startsWith('~') ? path.join(home, dir.slice(1)) : dir;
  const abs = path.resolve(expanded);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`ディレクトリが存在しません: ${abs}`);
  return abs;
}

module.exports = { SessionManager, TMUX_SOCKET, TMUX_PREFIX };
