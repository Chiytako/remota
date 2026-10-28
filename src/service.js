'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CONFIG_DIR } = require('./config');

// Runs Remota as an OS-managed background service: starts at login/boot, restarts if it crashes,
// and needs no terminal window. tmux keeps the sessions alive across service restarts.

const LABEL = 'dev.remota';
const BIN = path.resolve(__dirname, '..', 'bin', 'remota.js');

// Services start with a bare environment; carry over what Remota and the agents it launches need
// (PATH to find claude/codex/…, plus Remota's own settings).
function capturedEnv() {
  const env = { PATH: process.env.PATH, HOME: os.homedir(), LANG: process.env.LANG || 'C.UTF-8' };
  for (const k of ['REMOTA_HOME', 'REMOTA_PORT', 'REMOTA_HOST', 'REMOTA_HTTPS', 'REMOTA_HTTP_PORT', 'REMOTA_TMUX', 'SHELL']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

const has = (cmd) => run(process.platform === 'win32' ? 'where' : 'which', [cmd]).ok;

// ---------- Linux: systemd user unit ----------

const systemd = {
  file: path.join(os.homedir(), '.config', 'systemd', 'user', 'remota.service'),
  available: () => process.platform === 'linux' && has('systemctl') && run('systemctl', ['--user', 'show-environment']).ok,
  unit() {
    const env = Object.entries(capturedEnv()).map(([k, v]) => `Environment=${JSON.stringify(`${k}=${v}`)}`).join('\n');
    return `[Unit]
Description=Remota — drive coding agents from your phone
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} start
${env}
Restart=always
RestartSec=3
# tmux sessions must outlive the service process (they are what keeps your work running).
KillMode=process

[Install]
WantedBy=default.target
`;
  },
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, this.unit());
    for (const args of [['daemon-reload'], ['enable', '--now', 'remota.service'], ['restart', 'remota.service']]) {
      const r = run('systemctl', ['--user', ...args]);
      if (!r.ok) throw new Error(`systemctl --user ${args.join(' ')}: ${r.out}`);
    }
    // Without lingering, user services stop when you log out and don't start at boot.
    const linger = run('loginctl', ['enable-linger', os.userInfo().username]);
    return linger.ok ? [] : ['ログアウト中や再起動直後も動かすには: sudo loginctl enable-linger ' + os.userInfo().username];
  },
  uninstall() {
    run('systemctl', ['--user', 'disable', '--now', 'remota.service']);
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    run('systemctl', ['--user', 'daemon-reload']);
  },
  status: () => run('systemctl', ['--user', 'is-active', 'remota.service']).out || 'unknown',
  logs: () => ['journalctl', ['--user', '-u', 'remota.service', '-n', '80', '--no-pager']],
  restart: () => run('systemctl', ['--user', 'restart', 'remota.service']),
};

// ---------- macOS: launchd agent ----------

const LOG = path.join(CONFIG_DIR, 'remota.log');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const launchd = {
  file: path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  available: () => process.platform === 'darwin',
  unit() {
    const env = Object.entries(capturedEnv()).map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(process.execPath)}</string>
      <string>${xml(BIN)}</string>
      <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <!-- tmux holds the sessions; it must survive when launchd stops or restarts Remota. -->
    <key>AbandonProcessGroup</key><true/>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>${xml(LOG)}</string>
    <key>StandardErrorPath</key><string>${xml(LOG)}</string>
  </dict>
</plist>
`;
  },
  install() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const domain = `gui/${process.getuid()}`;
    run('launchctl', ['bootout', `${domain}/${LABEL}`]);
    fs.writeFileSync(this.file, this.unit());
    const r = run('launchctl', ['bootstrap', domain, this.file]);
    if (!r.ok) throw new Error(`launchctl bootstrap: ${r.out}`);
    return [];
  },
  uninstall() {
    run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  },
  status: () => (run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).ok ? 'active' : 'inactive'),
  logs: () => ['tail', ['-n', '80', LOG]],
  restart: () => run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]),
};

// ---------- Windows: scheduled task at logon ----------

const schtasks = {
  file: null,
  available: () => process.platform === 'win32',
  unit: () => `"${process.execPath}" "${BIN}" start`,
  install() {
    const r = run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'Remota', '/TR', this.unit()]);
    if (!r.ok) throw new Error(`schtasks: ${r.out}`);
    run('schtasks', ['/Run', '/TN', 'Remota']);
    return ['Windows では tmux がないため、サービス再起動でセッションは引き継がれません（WSL での利用を推奨）。'];
  },
  uninstall() {
    run('schtasks', ['/End', '/TN', 'Remota']);
    run('schtasks', ['/Delete', '/F', '/TN', 'Remota']);
  },
  status: () => (run('schtasks', ['/Query', '/TN', 'Remota']).ok ? 'installed' : 'not installed'),
  logs: () => null,
  restart() {
    run('schtasks', ['/End', '/TN', 'Remota']);
    return run('schtasks', ['/Run', '/TN', 'Remota']);
  },
};

function manager() {
  const m = [systemd, launchd, schtasks].find((x) => x.available());
  if (!m) {
    throw new Error(
      process.platform === 'linux'
        ? 'systemd のユーザーサービスが使えない環境です（コンテナや古い WSL など）。cron の @reboot などで `remota start` を起動してください。'
        : `この OS (${process.platform}) には未対応です`
    );
  }
  return m;
}

// The unit text for the current platform, for `remota service install --print` and tests.
function preview(platform = process.platform) {
  const m = platform === 'darwin' ? launchd : platform === 'win32' ? schtasks : systemd;
  return { file: m.file, text: m.unit() };
}

module.exports = { manager, preview, LOG };
