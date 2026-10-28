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
const FIELD = '<|remota|>';

function hasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// `socket`: a name (tmux -L, like Remota's own), an absolute socket path (tmux -S, for servers the
// user started), or null for tmux's default server.
function socketArgs(socket) {
  if (!socket) return [];
  return socket.startsWith('/') ? ['-S', socket] : ['-L', socket];
}

function tmux(args, opts = {}, socket = TMUX_SOCKET) {
  return execFileSync('tmux', [...socketArgs(socket), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// Every tmux server this user runs: tmux keeps its sockets in <dir>/tmux-<uid>/, where <dir> is
// TMUX_TMPDIR or /tmp (some setups use XDG_RUNTIME_DIR). Named servers (tmux -L work) are there too.
function userTmuxSockets() {
  const uid = process.getuid ? process.getuid() : 0;
  const dirs = [...new Set([process.env.TMUX_TMPDIR, '/tmp', process.env.XDG_RUNTIME_DIR, `/run/user/${uid}`].filter(Boolean))];
  const found = [];
  for (const dir of dirs) {
    const base = path.join(dir, `tmux-${uid}`);
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(base, name);
      if (name === TMUX_SOCKET) continue;
      try {
        if (fs.statSync(full).isSocket() && !found.includes(fs.realpathSync(full))) found.push(fs.realpathSync(full));
      } catch {
        // vanished
      }
    }
  }
  return found;
}

function liveTmuxSessions(socket = TMUX_SOCKET) {
  try {
    return new Set(tmux(['list-sessions', '-F', '#{session_name}'], {}, socket).split('\n').filter(Boolean));
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
    // Name of a tmux session the user started themselves (outside Remota), or null for Remota's own,
    // and the socket of the tmux server it lives on (null: tmux's default server).
    this.external = meta.external || null;
    this.externalSocket = meta.externalSocket || null;
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
    this.cols = 100;
    this.rows = 30;
    this.exited = false;
  }

  get tmuxName() {
    return this.external || TMUX_PREFIX + this.id;
  }

  // The user's own sessions live on their default tmux server; Remota's on its private socket.
  get socket() {
    return this.external ? this.externalSocket : TMUX_SOCKET;
  }

  // "=name" matches the session name exactly (a bare name could match by prefix).
  get target() {
    return `=${this.tmuxName}`;
  }

  tmux(args, opts) {
    return tmux(args, opts, this.socket);
  }

  start({ attachExisting = false } = {}) {
    const env = { ...childEnv(), REMOTA_SESSION: this.id };
    let file;
    let args;
    if (this.useTmux) {
      if (!attachExisting && !this.external) {
        const create = ['new-session', '-d', '-s', this.tmuxName, '-c', this.cwd, '-x', String(this.cols), '-y', String(this.rows), '-e', `REMOTA_SESSION=${this.id}`];
        tmux(create, { env });
        // A phone screen has no room for tmux's status bar; scrollback is handled by copy-mode.
        tmux(['set-option', '-t', this.tmuxName, 'status', 'off']);
        tmux(['set-option', '-t', this.tmuxName, 'history-limit', '50000']);
        tmux(['set-option', '-t', this.tmuxName, 'mouse', 'off']);
        if (this.command) tmux(['send-keys', '-t', this.tmuxName, this.command, 'Enter']);
      }
      file = 'tmux';
      args = [...socketArgs(this.socket), '-u', 'attach-session', '-t', this.target];
    } else {
      file = this.manager.config.shell;
      args = ['-l'];
    }

    const cwd = fs.existsSync(this.cwd) ? this.cwd : require('os').homedir();
    this.pty = pty.spawn(file, args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd, env });
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
      this.tmux(['refresh-client', '-t', this.pty._pty]);
    } catch {
      // client not registered yet
    }
  }

  // Scrolls tmux's history without the user having to know the copy-mode key bindings.
  scroll(direction, lines = 5) {
    if (!this.useTmux || this.exited) return false;
    try {
      if (direction === 'exit') {
        this.tmux(['send-keys', '-t', `${this.target}:`, '-X', 'cancel']);
        return true;
      }
      this.tmux(['copy-mode', '-e', '-t', `${this.target}:`]);
      const cmd = direction === 'up' ? 'scroll-up' : 'scroll-down';
      this.tmux(['send-keys', '-t', `${this.target}:`, '-X', '-N', String(Math.max(1, Math.min(200, lines | 0))), cmd]);
      return true;
    } catch {
      return false;
    }
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
        return this.tmux(['capture-pane', '-p', '-J', '-t', `${this.target}:`, '-S', `-${Math.max(10, Math.min(50000, lines | 0))}`]);
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
        // Never end a session the user started themselves; leaving Remota only detaches from it.
        if (!this.external) this.tmux(['kill-session', '-t', this.target]);
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
      external: this.external,
      externalSocket: this.externalSocket,
      preview: lastLines(this.buffer.slice(-4000), 2),
    };
  }

  meta() {
    return { id: this.id, name: this.name, cwd: this.cwd, command: this.command, createdAt: this.createdAt, external: this.external, externalSocket: this.externalSocket };
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
      if (meta.external ? !liveTmuxSessions(meta.externalSocket || null).has(meta.external) : !live.has(TMUX_PREFIX + meta.id)) continue;
      const session = new Session(this, meta);
      session.start({ attachExisting: true });
      this.sessions.set(session.id, session);
    }
    this.persist();
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map((s) => s.toJSON());
  }

  // tmux sessions the user started themselves (outside Remota), on every tmux server they run.
  listUserTmux() {
    if (!this.useTmux) return { available: false, sessions: [], errors: [] };
    const attached = new Map([...this.sessions.values()].filter((x) => x.external).map((x) => [`${x.externalSocket}\n${x.external}`, x.id]));
    const sessions = [];
    const errors = [];
    const fmt = ['#{session_name}', '#{session_windows}', '#{session_attached}', '#{session_activity}', '#{pane_current_path}', '#{pane_current_command}'].join(FIELD);
    for (const socket of userTmuxSockets()) {
      let out = '';
      try {
        // tmux rewrites tabs and control characters in its output, so fields are split on a marker.
        out = tmux(['list-sessions', '-F', fmt], {}, socket);
      } catch (err) {
        const msg = String(err.stderr || err.message).trim();
        // A server with no sessions left, or a stale socket file, is not an error worth showing.
        if (!/no server running|error connecting|no sessions/i.test(msg)) errors.push(`${path.basename(socket)}: ${msg}`);
        continue;
      }
      for (const line of out.split('\n').filter(Boolean)) {
        const [name, windows, clients, activity, cwd, command] = line.split(FIELD);
        sessions.push({
          name,
          socket,
          server: path.basename(socket),
          windows: Number(windows),
          clients: Number(clients),
          activity: Number(activity) * 1000,
          cwd,
          command,
          remotaId: attached.get(`${socket}\n${name}`) || null,
        });
      }
    }
    sessions.sort((x, y) => y.activity - x.activity);
    return { available: true, sessions, errors };
  }

  attachUserTmux(name, socket) {
    name = String(name || '');
    const found = this.listUserTmux().sessions.find((x) => x.name === name && (!socket || x.socket === socket));
    if (!found) throw new Error(`tmux セッション「${name}」が見つかりません`);
    if (found.remotaId) return this.get(found.remotaId);
    const session = new Session(this, {
      id: crypto.randomBytes(4).toString('hex'),
      name: name.slice(0, 60),
      cwd: found.cwd || require('os').homedir(),
      command: found.command === 'bash' || found.command === 'zsh' || found.command === 'fish' ? '' : found.command,
      external: name,
      externalSocket: found.socket,
    });
    session.start({ attachExisting: true });
    this.sessions.set(session.id, session);
    this.persist();
    this.emit('change', session);
    return session;
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
    if (session.useTmux && liveTmuxSessions(session.socket).has(session.tmuxName) && this.sessions.has(session.id)) {
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
