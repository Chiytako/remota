'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// A private tmux server for the test, standing in for the user's own (default) one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remota-tmux-'));
process.env.TMUX_TMPDIR = home;
process.env.REMOTA_HOME = home;
process.env.REMOTA_TMUX = 'true';
process.env.REMOTA_HTTPS = 'false';
const userTmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' });

test('attach to a tmux session the user started outside Remota, and leave it running', { skip: !hasTmux }, async () => {
  const WebSocket = require('ws');
  const { loadConfig } = require('../src/config');
  const { createServer } = require('../src/server');
  userTmux('new-session', '-d', '-s', 'my work', '-x', '100', '-y', '30');
  userTmux('send-keys', '-t', '=my work:', 'echo BEFORE_REMOTA', 'Enter');
  // A second, named server (tmux -L side) must be found too.
  userTmux('-L', 'side', 'new-session', '-d', '-s', 'other', '-x', '80', '-y', '24');

  const config = loadConfig();
  const { server } = createServer(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  try {
    const list = await (await fetch(`${base}/api/tmux`, { headers: H })).json();
    assert.strictEqual(list.available, true);
    assert.deepStrictEqual(list.sessions.map((s) => s.name).sort(), ['my work', 'other']);
    const side = list.sessions.find((s) => s.name === 'other');
    assert.strictEqual(side.server, 'side');
    assert.strictEqual(list.sessions.find((s) => s.name === 'my work').remotaId, null);
    const o = await (await fetch(`${base}/api/tmux/attach`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'other', socket: side.socket }) })).json();
    assert.strictEqual(o.externalSocket, side.socket);
    await fetch(`${base}/api/sessions/${o.id}`, { method: 'DELETE', headers: H });

    const s = await (await fetch(`${base}/api/tmux/attach`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'my work' }) })).json();
    assert.strictEqual(s.external, 'my work');

    // Output already on that screen arrives, and typing goes into the user's session.
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=${s.id}&cols=100&rows=30`, { headers: { Authorization: H.Authorization } });
    let out = '';
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      out += m.data || m.replay || '';
    });
    await new Promise((r) => ws.on('open', r));
    for (let i = 0; i < 50 && !out.includes('BEFORE_REMOTA'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /BEFORE_REMOTA/);
    ws.send(JSON.stringify({ type: 'input', data: 'echo FROM_PHONE_$((2*21))\r' }));
    let pane = '';
    for (let i = 0; i < 50 && !pane.includes('FROM_PHONE_42'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      pane = userTmux('capture-pane', '-p', '-t', '=my work:');
    }
    assert.match(pane, /FROM_PHONE_42/, 'typed text reaches the user\'s own tmux session');
    ws.close();

    // Attaching twice gives the same Remota session; it is listed as attached.
    const again = await (await fetch(`${base}/api/tmux/attach`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'my work' }) })).json();
    assert.strictEqual(again.id, s.id);
    assert.strictEqual((await (await fetch(`${base}/api/tmux`, { headers: H })).json()).sessions.find((x) => x.name === 'my work').remotaId, s.id);

    // Closing it in Remota only detaches: the user's tmux session keeps running.
    await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE', headers: H });
    await new Promise((r) => setTimeout(r, 300));
    assert.match(userTmux('list-sessions', '-F', '#{session_name}'), /my work/);

    const missing = await fetch(`${base}/api/tmux/attach`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'nope' }) });
    assert.strictEqual(missing.status, 400);
  } finally {
    server.close();
    server.closeAllConnections();
    for (const args of [['kill-server'], ['-L', 'side', 'kill-server']]) {
      try {
        userTmux(...args);
      } catch {
        // already gone
      }
    }
    try {
      execFileSync('tmux', ['-L', 'remota', 'kill-server'], { stdio: 'ignore' });
    } catch {
      // none
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
