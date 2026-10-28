#!/usr/bin/env node
'use strict';

const os = require('os');
const { loadConfig, save, newToken, CONFIG_FILE } = require('../src/config');

const HELP = `remota — スマホからAIコーディングエージェントを操作するセルフホスト型ターミナル

使い方:
  remota [start]              サーバーを起動（既定: 0.0.0.0:7681）
  remota url                  ログイン用URLとQRコードを表示
  remota token [--rotate]     アクセストークンを表示 / 再発行
  remota notify [メッセージ]   スマホに通知を送る（エージェントのフック用）
      --title <t>  --session <id>  --status <idle|waiting>
  remota hooks                Claude Code 用のフック設定(JSON)を表示
  remota help

環境変数: REMOTA_PORT, REMOTA_HOST, REMOTA_TOKEN, REMOTA_TMUX(auto|true|false), REMOTA_HOME
設定ファイル: ${CONFIG_FILE}
`;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

function urls(config, useTls) {
  const scheme = useTls ? 'https' : 'http';
  const hosts = config.host === '0.0.0.0' ? lanAddresses() : [config.host];
  if (!hosts.length) hosts.push('localhost');
  return hosts.map((h) => `${scheme}://${h}:${config.port}/#token=${encodeURIComponent(config.token)}`);
}

function printUrls(config, useTls) {
  const list = urls(config, useTls);
  console.log('\nスマホでこのURLを開く（またはQRを読み取る）。2台目以降は、アプリの「機器を追加」にこのURLを貼り付け:');
  for (const u of list) console.log(`  ${u}`);
  require('qrcode-terminal').generate(list[0], { small: true }, (qr) => console.log(qr));
  console.log('ホーム画面に追加するとアプリとして使えます（iOSの通知はHTTPS + ホーム画面追加が必要）。\n');
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

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function notify(config, args) {
  const { flags, rest } = parseFlags(args);
  let message = rest.join(' ');
  let status = flags.status;
  // Claude Code hooks pass a JSON event on stdin; turn it into a readable message.
  const stdin = await readStdin();
  if (stdin.trim()) {
    try {
      const event = JSON.parse(stdin);
      if (!message) message = event.message || (event.hook_event_name === 'Stop' ? 'タスクが完了しました' : '');
      if (!status) status = event.hook_event_name === 'Notification' ? 'waiting' : 'idle';
    } catch {
      if (!message) message = stdin.trim().slice(0, 500);
    }
  }
  const session = flags.session || process.env.REMOTA_SESSION || '';
  const scheme = config.tls && config.tls.cert ? 'https' : 'http';
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  const res = await fetch(`${scheme}://${host}:${config.port}/api/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: flags.title, message: message || '完了しました', session, status }),
  });
  if (!res.ok) {
    console.error(`notify failed: ${res.status}`);
    process.exitCode = 1;
  }
}

function hooks() {
  const cmd = 'remota notify';
  const json = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: `${cmd} --status idle` }] }],
      Notification: [{ hooks: [{ type: 'command', command: `${cmd} --status waiting` }] }],
    },
  };
  console.log('~/.claude/settings.json に以下をマージしてください:\n');
  console.log(JSON.stringify(json, null, 2));
}

async function main() {
  const [cmd = 'start', ...args] = process.argv.slice(2);
  const config = loadConfig();

  switch (cmd) {
    case 'start': {
      const { createServer } = require('../src/server');
      const { server, sessions, useTls } = createServer(config);
      server.listen(config.port, config.host, () => {
        console.log(`Remota listening on ${useTls ? 'https' : 'http'}://${config.host}:${config.port}`);
        console.log(`tmux による永続セッション: ${sessions.useTmux ? '有効' : '無効（tmux をインストールすると有効）'}`);
        printUrls(config, useTls);
      });
      const stop = () => {
        // tmux sessions keep running; only the attach clients go away.
        server.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      break;
    }
    case 'url':
      printUrls(config, Boolean(config.tls && config.tls.cert));
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
      hooks();
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
