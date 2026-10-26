'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.REMOTA_HOME || path.join(os.homedir(), '.config', 'remota');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 7681,
  // 'auto' uses tmux when it is installed, so sessions survive server restarts.
  tmux: 'auto',
  shell: process.env.SHELL || '/bin/bash',
  defaultCwd: os.homedir(),
  // Seconds of silence after output before a session counts as "idle" (task finished).
  idleSeconds: 8,
  // Bytes of output kept per session and replayed to clients when they reconnect.
  scrollbackBytes: 512 * 1024,
  // Optional: ntfy.sh topic URL or any webhook URL that receives a JSON POST.
  webhookUrl: '',
  tls: { cert: '', key: '' },
  presets: [
    { name: 'Shell', command: '' },
    { name: 'Claude Code', command: 'claude' },
    { name: 'Codex', command: 'codex' },
  ],
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function loadConfig() {
  ensureDir(CONFIG_DIR);
  const stored = readJson(CONFIG_FILE, {});
  const config = { ...DEFAULTS, ...stored, tls: { ...DEFAULTS.tls, ...(stored.tls || {}) } };

  let dirty = false;
  if (!config.token) {
    config.token = newToken();
    dirty = true;
  }
  if (!config.vapid || !config.vapid.publicKey) {
    const webpush = require('web-push');
    config.vapid = webpush.generateVAPIDKeys();
    dirty = true;
  }
  if (dirty || !fs.existsSync(CONFIG_FILE)) save(config);

  if (process.env.REMOTA_PORT) config.port = Number(process.env.REMOTA_PORT);
  if (process.env.REMOTA_HOST) config.host = process.env.REMOTA_HOST;
  if (process.env.REMOTA_TOKEN) config.token = process.env.REMOTA_TOKEN;
  if (process.env.REMOTA_TMUX) config.tmux = process.env.REMOTA_TMUX;
  return config;
}

function save(config) {
  writeJson(CONFIG_FILE, config);
}

module.exports = { CONFIG_DIR, CONFIG_FILE, loadConfig, save, newToken, readJson, writeJson };
