'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remota-nodes-'));
process.env.REMOTA_HOME = home;
process.env.REMOTA_TMUX = 'false';

const WebSocket = require('ws');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

// Two servers in one process: a hub the phone talks to and a device registered on it.
const hubConfig = { ...loadConfig(), token: 'hub-token', nodes: [] };
const devConfig = { ...loadConfig(), token: 'device-token', nodes: [] };
let hub;
let dev;
let hubUrl;
let devUrl;

test.before(async () => {
  ({ server: hub } = createServer(hubConfig));
  ({ server: dev } = createServer(devConfig));
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  hubUrl = `http://127.0.0.1:${hub.address().port}`;
  devUrl = `http://127.0.0.1:${dev.address().port}`;
});

test.after(() => {
  for (const s of [hub, dev]) {
    s.close();
    s.closeAllConnections();
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const H = { Authorization: 'Bearer hub-token', 'Content-Type': 'application/json' };

test('a device is verified before it is added', async () => {
  const bad = await fetch(`${hubUrl}/api/nodes`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'dev', url: devUrl, token: 'wrong' }) });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /トークン/);
  const unreachable = await fetch(`${hubUrl}/api/nodes`, { method: 'POST', headers: H, body: JSON.stringify({ url: 'http://127.0.0.1:1', token: 'x' }) });
  assert.strictEqual(unreachable.status, 400);
});

test('sessions on a registered device are listed, created and streamed through the hub', async () => {
  const added = await fetch(`${hubUrl}/api/nodes`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'GPU box', url: devUrl, token: 'device-token' }) });
  assert.strictEqual(added.status, 201);
  const node = await added.json();
  assert.strictEqual(node.online, true);

  const created = await fetch(`${hubUrl}/api/n/${node.id}/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'remote-1', cwd: home }) });
  assert.strictEqual(created.status, 201);
  const s = await created.json();

  // The hub polls its devices every few seconds.
  await new Promise((r) => setTimeout(r, 3500));
  const overview = await (await fetch(`${hubUrl}/api/overview`, { headers: H })).json();
  assert.deepStrictEqual(overview.nodes.map((n) => n.name).slice(1), ['GPU box']);
  assert.ok(overview.sessions.some((x) => x.id === s.id && x.node === node.id));

  const ws = new WebSocket(`${hubUrl.replace('http', 'ws')}/ws?node=${node.id}&session=${s.id}&client=t`, { headers: { Authorization: 'Bearer hub-token' } });
  let out = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no output: ${out}`)), 8000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      out += msg.data || msg.replay || '';
      if (out.includes('VIA_HUB_7')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'input', n: 1, data: 'echo VIA_HUB_$((3+4))\r' })));
  await done;
  ws.close();

  const del = await fetch(`${hubUrl}/api/nodes/${node.id}`, { method: 'DELETE', headers: H });
  assert.strictEqual(del.status, 200);
  await fetch(`${devUrl}/api/sessions/${s.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer device-token' } });
});
