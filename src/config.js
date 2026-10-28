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
  // Built-in HTTPS with Remota's own certificate authority (see src/tls.js). Set false for plain
  // HTTP, or put your own certificate paths in `tls` to use those instead.
  https: true,
  // Plain-HTTP port for the certificate setup page; 0 means "HTTPS port - 1", false disables it.
  httpPort: 0,
  // Extra host names / IPs to put in the certificate (e.g. a DNS name for this machine).
  tlsNames: [],
  tls: { cert: '', key: '' },
  // Shown when creating a session; only the ones installed on this machine are offered.
  presets: [
    { name: 'Shell', command: '' },
    { name: 'Claude Code', command: 'claude' },
    { name: 'Codex', command: 'codex' },
    { name: 'OpenCode', command: 'opencode' },
    { name: 'pi', command: 'pi' },
    { name: 'Gemini CLI', command: 'gemini' },
    { name: 'Copilot CLI', command: 'copilot' },
    { name: 'Cursor CLI', command: 'cursor-agent' },
    { name: 'Droid', command: 'droid' },
    { name: 'Aider', command: 'aider' },
    { name: 'Qwen Code', command: 'qwen' },
  ],
};

// The preset list written by the first release; configs still holding it get the current list.
const OLD_DEFAULT_PRESETS = JSON.stringify([
  { name: 'Shell', command: '' },
  { name: 'Claude Code', command: 'claude' },
  { name: 'Codex', command: 'codex' },
]);

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
  if (JSON.stringify(stored.presets) === OLD_DEFAULT_PRESETS) {
    config.presets = DEFAULTS.presets;
    dirty = true;
  }
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

  // Environment overrides apply to this run only; remember the file's values so saving
  // never writes them into the config file.
  const fileValues = {};
  const override = (key, value) => {
    if (value === undefined || value === '') return;
    fileValues[key] = config[key];
    config[key] = value;
  };
  override('port', process.env.REMOTA_PORT && Number(process.env.REMOTA_PORT));
  override('host', process.env.REMOTA_HOST);
  override('token', process.env.REMOTA_TOKEN);
  override('tmux', process.env.REMOTA_TMUX);
  if (process.env.REMOTA_HTTPS !== undefined) override('https', !/^(0|false|off|no)$/i.test(process.env.REMOTA_HTTPS));
  override('httpPort', process.env.REMOTA_HTTP_PORT && Number(process.env.REMOTA_HTTP_PORT));
  Object.defineProperty(config, 'fileValues', { value: fileValues, enumerable: false });
  return config;
}

function save(config) {
  writeJson(CONFIG_FILE, { ...config, ...(config.fileValues || {}) });
}

module.exports = { CONFIG_DIR, CONFIG_FILE, loadConfig, save, newToken, readJson, writeJson };
