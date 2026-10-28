'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remota-test-'));
process.env.REMOTA_HOME = home;
// Plain PTYs keep the test independent of whether tmux is installed.
process.env.REMOTA_TMUX = 'false';

const WebSocket = require('ws');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

const config = loadConfig();
config.idleSeconds = 1;
let server;
let base;

test.before(async () => {
  ({ server } = createServer(config));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(home, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' });

test('rejects unauthenticated API calls', async () => {
  const res = await fetch(`${base}/api/sessions`);
  assert.strictEqual(res.status, 401);
});

test('login with wrong token fails, right token sets cookie', async () => {
  const bad = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: 'nope' }) });
  assert.strictEqual(bad.status, 401);
  const ok = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ token: config.token }) });
  assert.strictEqual(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.ok(!cookie.includes(config.token), 'cookie must not contain the raw token');
  const me = await fetch(`${base}/api/info`, { headers: { cookie: cookie.split(';')[0] } });
  assert.strictEqual(me.status, 200);
});

test('serves the app shell and vendor bundles without auth', async () => {
  assert.strictEqual((await fetch(`${base}/`)).status, 200);
  assert.strictEqual((await fetch(`${base}/vendor/xterm.js`)).status, 200);
  assert.notStrictEqual((await fetch(`${base}/..%2Fpackage.json`)).status, 200);
});

test('session lifecycle: create, stream output over WebSocket, type, delete', async () => {
  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 't1', cwd: home }) });
  assert.strictEqual(created.status, 201);
  const s = await created.json();

  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=${s.id}&cols=80&rows=24`, { headers: { Authorization: `Bearer ${config.token}` } });
  let output = '';
  const sawMarker = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no marker in output: ${output}`)), 8000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'output' || msg.type === 'hello') output += msg.data || msg.replay || '';
      if (output.includes('REMOTA_OK_42')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'input', data: 'echo REMOTA_OK_$((40+2))\r' }));
  await sawMarker;
  ws.close();

  const list = await (await fetch(`${base}/api/sessions`, { headers: auth() })).json();
  assert.ok(list.some((x) => x.id === s.id));

  const del = await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE', headers: auth() });
  assert.strictEqual(del.status, 200);
});

test('WebSocket without auth or from another origin is refused', async () => {
  const tryWs = (headers) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=x`, { headers });
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('refused'));
    });
  assert.strictEqual(await tryWs({}), 'refused');
  assert.strictEqual(await tryWs({ Authorization: `Bearer ${config.token}`, Origin: 'https://evil.example' }), 'refused');
});

test('upload stores the file inside the session directory', async () => {
  const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth(), body: JSON.stringify({ cwd: home }) })).json();
  const res = await fetch(`${base}/api/upload?session=${s.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'X-Filename': encodeURIComponent('../../スクショ.png') },
    body: Buffer.from('png'),
  });
  assert.strictEqual(res.status, 201);
  const out = await res.json();
  assert.ok(out.path.startsWith(path.join(home, '.remota-uploads')));
  assert.match(out.relative, /^\.remota-uploads\/.+スクショ\.png$/);
  await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE', headers: auth() });
});

test('reconnect resumes from the last offset and duplicate inputs run once', async () => {
  const s = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: auth(), body: JSON.stringify({ cwd: home }) })).json();
  const wsUrl = (q) => `${base.replace('http', 'ws')}/ws?session=${s.id}&client=c1${q}`;
  const open = (q) =>
    new Promise((resolve) => {
      const ws = new WebSocket(wsUrl(q), { headers: { Authorization: `Bearer ${config.token}` } });
      const state = { ws, out: '', hello: null, seq: 0 };
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'hello') {
          state.hello = msg;
          state.out += msg.replay;
          state.seq = msg.seq;
          resolve(state);
        }
        if (msg.type === 'output') {
          state.out += msg.data;
          state.seq = msg.seq;
        }
      });
    });
  const waitFor = async (st, re) => {
    for (let i = 0; i < 80 && !re.test(st.out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(st.out, re);
  };

  const a = await open('');
  a.ws.send(JSON.stringify({ type: 'input', n: 1, data: 'echo ONE_$((0+1))\r' }));
  await waitFor(a, /ONE_1/);
  await new Promise((r) => setTimeout(r, 300));
  const { seq } = a;
  const epoch = a.hello.epoch;
  a.ws.close();

  const b = await open(`&epoch=${epoch}&since=${seq}`);
  assert.strictEqual(b.hello.resume, true);
  assert.ok(!b.hello.replay.includes('ONE_1'), 'resumed replay must not repeat old output');
  assert.strictEqual(b.hello.inputAck, 1);
  // Input 1 is re-sent (as after a flaky reconnect) together with a new input 2.
  b.ws.send(JSON.stringify({ type: 'input', n: 1, data: 'echo ONE_$((0+1))\r' }));
  b.ws.send(JSON.stringify({ type: 'input', n: 2, data: 'echo TWO_$((1+1))\r' }));
  await waitFor(b, /TWO_2/);
  assert.ok(!b.out.includes('ONE_1'), 'duplicate input must not run again');
  b.ws.close();

  const c = await open('&epoch=stale&since=5');
  assert.strictEqual(c.hello.resume, false, 'a stale epoch gets a full replay');
  c.ws.close();
  await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE', headers: auth() });
});
