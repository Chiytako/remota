#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const { loadConfig, save, newToken, CONFIG_FILE } = require('../src/config');

const HELP = `remota — スマホからAIコーディングエージェントを操作するセルフホスト型ターミナル

使い方:
  remota [start]                 サーバーを起動（既定: HTTPS 0.0.0.0:7681、証明書の設定ページ :7680）
  remota url                     スマホで開くURLとQRコードを表示
  remota token [--rotate]        アクセストークンを表示 / 再発行

  remota hooks                   コーディングエージェントの通知連携の状態を表示
  remota hooks install [名前..]  通知連携を設定（省略時は見つかったエージェントすべて）
  remota hooks uninstall [名前..] 通知連携を外す
      対応: claude, codex, gemini, opencode, pi, copilot, cursor, droid, aider

  remota notify [メッセージ]      スマホに通知（任意のエージェントやスクリプトから）
      --status <idle|waiting>  --title <t>  --session <id>

  remota service install         バックグラウンドのサービスとして登録（ログイン/起動時に自動起動・自動復帰）
  remota service uninstall|status|logs|restart

  remota doctor                  スマホからつながらないときの診断（サーバー・アドレス・ファイアウォール）

  remota ca                      HTTPS 用の証明書（認証局）の情報
  remota ca export <file>        証明書を書き出す（他の機器で共通にするため）
  remota ca import <file>        書き出した証明書を読み込む

環境変数: REMOTA_PORT, REMOTA_HOST, REMOTA_TOKEN, REMOTA_HTTPS(true|false), REMOTA_HTTP_PORT,
          REMOTA_TMUX(auto|true|false), REMOTA_HOME
設定ファイル: ${CONFIG_FILE}
`;

// Interfaces a phone can never reach: container and VM bridges.
const VIRTUAL_IF = /^(docker|br-|veth|virbr|vnet|cni|flannel|cali|lxc|lxdbr|podman|vboxnet|vmnet|kube)/;

// Addresses to offer the phone, most likely first: private LAN, then VPN (100.64/10), then others.
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) out.push(addr.address);
    }
  }
  const rank = (ip) => (/^(192\.168|10)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 0 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

function builtinTls(config) {
  return config.https !== false && !(config.tls && config.tls.cert);
}

function hosts(config) {
  const list = config.host === '0.0.0.0' ? lanAddresses() : [config.host];
  return list.length ? list : ['localhost'];
}

// With built-in HTTPS the phone first needs the certificate, so the link goes to the plain-HTTP
// setup page, which forwards to the HTTPS app once the certificate is trusted. The app reads the
// same link when adding this machine from a QR code.
function urls(config) {
  const token = encodeURIComponent(config.token);
  if (builtinTls(config) && config.httpPort !== false) {
    const httpPort = config.httpPort || config.port - 1;
    // The key pin rides along too, so pasting this link into the Android app also works.
    const tls = require('../src/tls');
    tls.serverCredentials(config.tlsNames);
    const pin = encodeURIComponent(tls.serverKeyPin());
    return hosts(config).map((h) => `http://${h}:${httpPort}/setup#token=${token}&https=${config.port}&k=${pin}`);
  }
  const scheme = config.https === false && !(config.tls && config.tls.cert) ? 'http' : 'https';
  return hosts(config).map((h) => `${scheme}://${h}:${config.port}/#token=${token}`);
}

// Pairing link for the Android app: every address of this machine, the token, and the pin of the
// HTTPS key (the app trusts exactly that key, like an SSH host key — no certificate to install).
function pairLink(config) {
  const tls = require('../src/tls');
  tls.serverCredentials(config.tlsNames);
  const q = new URLSearchParams({ n: os.hostname(), p: String(config.port), a: hosts(config).join(','), t: config.token, k: tls.serverKeyPin() });
  return `remota://pair?${q}`;
}

function printUrls(config) {
  if (builtinTls(config)) {
    const link = pairLink(config);
    console.log('\nAndroid アプリで QR コードを読み取ってください（アプリの「QRで追加」、またはカメラで読み取り）。');
    require('qrcode-terminal').generate(link, { small: true }, (qr) => console.log(qr));
    console.log(`ペアリングリンク: ${link}`);
    console.log(`鍵の指紋 (SHA-256): ${require('../src/tls').serverKeyPin()}`);
    console.log('\nブラウザから使う場合（PC など）:');
    for (const u of urls(config)) console.log(`  ${u}`);
    console.log('');
    return;
  }
  const list = urls(config);
  console.log('\nブラウザでこのURLを開いてください:');
  for (const u of list) console.log(`  ${u}`);
  require('qrcode-terminal').generate(list[0], { small: true }, (qr) => console.log(qr));
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else flags[key] = args[++i];
    } else rest.push(args[i]);
  }
  return { flags, rest };
}

// Hooks call this with a JSON event on stdin, but plugins may leave stdin open and empty;
// never wait long for it.
function readStdin(timeoutMs = 400) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function postLocal(config, path, body) {
  const https = builtinTls(config) || (config.tls && config.tls.cert);
  const lib = require(https ? 'https' : 'http');
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const payload = Buffer.from(JSON.stringify(body));
  const options = {
    host,
    port: config.port,
    path,
    method: 'POST',
    timeout: 4000,
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', 'Content-Length': payload.length },
  };
  // Trust our own CA for the loopback call.
  if (builtinTls(config)) options.ca = fs.readFileSync(require('../src/tls').CA_CRT);
  else if (https) options.rejectUnauthorized = false;
  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

// Called by agents' hooks: must stay silent on stdout and never fail the agent.
async function notify(config, args) {
  const { flags, rest } = parseFlags(args);
  let payload = null;
  const stdin = await readStdin();
  // Codex's legacy `notify` passes the event as a JSON command-line argument instead of stdin.
  const jsonArg = rest.length && /^\s*\{/.test(rest[rest.length - 1]) ? rest.pop() : '';
  for (const text of [stdin, jsonArg]) {
    if (!text.trim()) continue;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!rest.length) rest.push(text.trim().slice(0, 500));
    }
  }
  const { parseEvent } = require('../src/agents');
  const parsed = parseEvent(flags.agent || '', flags.event || '', payload);
  const message = rest.join(' ').trim() || parsed.message;
  const status = flags.status || (flags.event || payload ? parsed.status : undefined);
  try {
    const code = await postLocal(config, '/api/notify', {
      title: flags.title,
      message,
      session: flags.session || process.env.REMOTA_SESSION || '',
      status,
      agent: flags.agent,
      cwd: (payload && payload.cwd) || process.cwd(),
    });
    if (code >= 400) console.error(`remota notify: HTTP ${code}`);
  } catch (err) {
    console.error(`remota notify: ${err.message}`);
  }
}

function hooks(args) {
  const agents = require('../src/agents');
  const [sub, ...names] = args;
  if (!sub || sub === 'list' || sub === 'status') {
    console.log('コーディングエージェントの通知連携:\n');
    for (const a of agents.list()) {
      const state = a.error ? `エラー: ${a.error}` : a.installed ? '連携済み' : a.present ? '未設定' : '未検出';
      console.log(`  ${a.installed ? '●' : '○'} ${a.name.padEnd(20)} ${state.padEnd(8)} ${a.via}`);
    }
    console.log('\n設定: remota hooks install [名前..]（省略時は検出されたものすべて）');
    console.log('上記以外のエージェントも画面出力から承認待ち/完了を推定します。任意のスクリプトからは remota notify "メッセージ"。');
    return;
  }
  if (sub !== 'install' && sub !== 'uninstall') throw new Error(`unknown: hooks ${sub}`);
  const targets = names.length ? names : agents.list().filter((a) => (sub === 'install' ? a.present : a.installed)).map((a) => a.id);
  if (!targets.length) {
    console.log(sub === 'install' ? '対象のエージェントが見つかりませんでした。名前を指定してください（例: remota hooks install opencode）' : '連携済みのエージェントはありません');
    return;
  }
  for (const id of targets) {
    try {
      agents[sub](id);
      const a = agents.list().find((x) => x.id === id);
      console.log(`${sub === 'install' ? '✓ 連携しました' : '✓ 外しました'}: ${a.name}（${a.file}）`);
    } catch (err) {
      console.log(`✗ ${id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  if (sub === 'install') console.log('\n起動中のエージェントは再起動すると反映されます。');
}

// Checks the usual reasons a phone can't reach this machine and says what to do about each.
async function doctor(config) {
  const { execFileSync } = require('child_process');
  const sh = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
    } catch {
      return null;
    }
  };
  const ok = (msg) => console.log(`  ✓ ${msg}`);
  const ng = (msg, fix) => console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`);
  console.log('Remota の診断\n');

  const rev = sh('git', ['-C', require('path').resolve(__dirname, '..'), 'rev-parse', '--short', 'HEAD']);
  console.log(`  バージョン: ${rev || '不明'}  Node.js ${process.version}`);

  let svc = null;
  try {
    svc = require('../src/service').manager().status();
  } catch {
    // no service manager here
  }
  if (svc === 'active' || svc === 'installed') ok(`サービス: ${svc}`);
  else console.log(`  - サービス: ${svc || '未登録'}（常駐させるには: node bin/remota.js service install）`);

  // 1) Is the server answering on this machine at all?
  const scheme = builtinTls(config) || (config.tls && config.tls.cert) ? 'https' : 'http';
  const ping = (host) =>
    new Promise((resolve) => {
      const lib = require(scheme);
      const req = lib.get({ host, port: config.port, path: '/api/ping', rejectUnauthorized: false, timeout: 3000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? 'ok' : `HTTP ${res.statusCode}`);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve(e.code || e.message));
    });
  const local = await ping('127.0.0.1');
  if (local === 'ok') ok(`サーバーが応答しています（${scheme}://127.0.0.1:${config.port}）`);
  else ng(`サーバーが応答しません（${local}）`, 'node bin/remota.js service install（または node bin/remota.js start）で起動してください');

  // 2) Which address does it listen on?
  if (config.host !== '0.0.0.0' && config.host !== '::') ng(`待ち受けが ${config.host} に限定されています`, '設定ファイルの "host" を "0.0.0.0" にしてください');

  // 3) Each address the phone will try, from this machine's side.
  const addrs = lanAddresses();
  if (!addrs.length) ng('LAN のアドレスが見つかりません', 'ネットワークに接続されているか確認してください');
  for (const a of addrs) {
    const r = await ping(a);
    if (r === 'ok') ok(`${a}:${config.port} で応答`);
    else ng(`${a}:${config.port} で応答しません（${r}）`);
  }
  const skipped = Object.keys(os.networkInterfaces()).filter((n) => VIRTUAL_IF.test(n));
  if (skipped.length) console.log(`  - 仮想ネットワークは除外: ${skipped.join(', ')}`);

  // 4) Firewalls that drop incoming connections (the usual cause of "応答がありません").
  const active = (unit) => sh('systemctl', ['is-active', unit]) === 'active';
  const ports = `${config.port}${builtinTls(config) && config.httpPort !== false ? `, ${config.httpPort || config.port - 1}` : ''}`;
  // `ufw status` needs root; /etc/ufw/ufw.conf tells whether it is switched on without it.
  let ufwOn = null;
  try {
    ufwOn = /^\s*ENABLED\s*=\s*yes/m.test(fs.readFileSync('/etc/ufw/ufw.conf', 'utf8'));
  } catch {
    // ufw not installed
  }
  if (ufwOn !== null && active('ufw')) {
    if (!ufwOn) ok('ufw: 無効');
    else ng(`ufw が有効です（ポート ${ports}/tcp が許可されていないと、スマホからは「応答がありません」になります）`, `sudo ufw allow ${ports.replace(', ', ':')}/tcp`);
  } else if (active('firewalld')) {
    ng(`firewalld が有効です（ポート ${ports}/tcp の許可が必要な場合があります）`, `sudo firewall-cmd --permanent --add-port=${ports.replace(', ', '-')}/tcp && sudo firewall-cmd --reload`);
  } else if (sh('nft', ['list', 'ruleset']) && /policy drop/.test(sh('nft', ['list', 'ruleset']) || '')) {
    ng('nftables に既定で破棄するルールがあります', `ポート ${ports}/tcp への受信を許可してください`);
  } else {
    ok('有効なファイアウォール（ufw / firewalld）は見つかりません');
  }

  console.log('\nスマホ側の確認:');
  console.log(`  - スマホがこの機器と同じ Wi-Fi（または同じ VPN）につながっているか`);
  if (addrs[0]) console.log(`  - スマホのブラウザで http://${addrs[0]}:${config.httpPort || config.port - 1}/setup が開けるか（開ければネットワークは届いています）`);
}

function service(args) {
  const svc = require('../src/service');
  const [sub = 'status'] = args;
  if (sub === 'install' && args.includes('--print')) {
    const { file, text } = svc.preview();
    console.log(`# ${file || '(タスク スケジューラ)'}\n${text}`);
    return;
  }
  const m = svc.manager();
  if (sub === 'install') {
    const notes = m.install();
    console.log(`✓ サービスとして登録しました。ターミナルを閉じても動き続け、ログイン時に自動で起動します。${m.file ? `\n  ${m.file}` : ''}`);
    for (const n of notes) console.log(`  ※ ${n}`);
    console.log('  スマホで開くURLとQRは `remota url` でいつでも表示できます。');
  } else if (sub === 'uninstall') {
    m.uninstall();
    console.log('✓ サービスを解除しました（tmux のセッションはそのまま残ります）。');
  } else if (sub === 'status') {
    console.log(m.status());
  } else if (sub === 'restart') {
    const r = m.restart();
    if (r && !r.ok) throw new Error(r.out);
    console.log('✓ 再起動しました（セッションは tmux 上で継続）。');
  } else if (sub === 'logs') {
    const cmd = m.logs();
    if (!cmd) throw new Error('この OS ではログを取得できません');
    require('child_process').spawnSync(cmd[0], cmd[1], { stdio: 'inherit' });
  } else {
    throw new Error(`unknown: service ${sub}`);
  }
}

function ca(args) {
  const tls = require('../src/tls');
  const [sub, file] = args;
  if (!sub) {
    const info = tls.caInfo();
    console.log(`${info.subject}\nSHA-256: ${info.fingerprint}\n有効期限: ${info.validTo}\nファイル: ${tls.CA_CRT}`);
    return;
  }
  if (sub === 'export') {
    if (!file) throw new Error('書き出し先のファイルを指定してください: remota ca export ca.json');
    fs.writeFileSync(file, tls.exportCa(), { mode: 0o600 });
    console.log(`書き出しました: ${file}\n秘密鍵を含みます。他の機器へ移したら削除してください。`);
    return;
  }
  if (sub === 'import') {
    if (!file) throw new Error('読み込むファイルを指定してください: remota ca import ca.json');
    tls.importCa(fs.readFileSync(file, 'utf8'));
    console.log('読み込みました。Remota を再起動すると、この証明書で HTTPS を提供します。');
    return;
  }
  throw new Error(`unknown: ca ${sub}`);
}

async function main() {
  const [cmd = 'start', ...args] = process.argv.slice(2);
  const config = loadConfig();

  switch (cmd) {
    case 'start': {
      const { createServer } = require('../src/server');
      const { server, setupServer, httpPort, sessions, useTls } = createServer(config);
      server.listen(config.port, config.host, () => {
        console.log(`Remota listening on ${useTls ? 'https' : 'http'}://${config.host}:${config.port}`);
        console.log(`tmux による永続セッション: ${sessions.useTmux ? '有効' : '無効（tmux をインストールすると有効）'}`);
        if (setupServer) {
          setupServer.on('error', (err) => console.warn(`証明書の設定ページを起動できません（ポート ${httpPort}）: ${err.message}`));
          setupServer.listen(httpPort, config.host, () => printUrls(config));
        } else printUrls(config);
      });
      const stop = () => {
        // tmux sessions keep running; only the attach clients go away.
        server.close();
        if (setupServer) setupServer.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }
    case 'url':
      printUrls(config);
      break;
    case 'token':
      if (args.includes('--rotate')) {
        config.token = newToken();
        save(config);
        console.log('トークンを再発行しました。サーバーを再起動してください。');
      }
      console.log(config.token);
      break;
    case 'notify':
      await notify(config, args);
      break;
    case 'hooks':
      hooks(args);
      break;
    case 'ca':
      ca(args);
      break;
    case 'doctor':
      await doctor(config);
      break;
    case 'service':
      service(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
