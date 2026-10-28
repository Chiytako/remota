'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remota-tls-'));
process.env.REMOTA_HOME = home;
process.env.REMOTA_TMUX = 'false';
const tls = require('../src/tls');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('issued certificate meets iOS requirements for a user-trusted CA', () => {
  const { cert } = tls.serverCredentials(['remota.example.lan']);
  const leaf = new crypto.X509Certificate(cert);
  const ca = new crypto.X509Certificate(fs.readFileSync(tls.CA_CRT));
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey), 'signed by our CA');
  assert.ok(ca.ca && !leaf.ca);
  for (const name of ['DNS:localhost', 'IP Address:127.0.0.1', 'DNS:remota.example.lan']) assert.ok(leaf.subjectAltName.includes(name), name);
  for (const ip of tls.hostNames().filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))) assert.ok(leaf.subjectAltName.includes(`IP Address:${ip}`), ip);
  const days = (new Date(leaf.validTo) - new Date(leaf.validFrom)) / 86400000;
  assert.ok(days <= 398, `validity ${days} days`);
  assert.ok(leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1'), 'extended key usage: serverAuth');
  // Same addresses again: no needless reissue.
  assert.strictEqual(tls.serverCredentials(['remota.example.lan']).changed, false);
});

test('HTTPS server is trusted with the CA; setup page and CA download work over HTTP', async () => {
  const config = { ...loadConfig(), https: true, token: 'tls-token' };
  const { server, setupServer } = createServer(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((r) => setupServer.listen(0, '127.0.0.1', r));
  const ca = fs.readFileSync(tls.CA_CRT);
  const get = (port, p) =>
    new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: p, ca }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  const ping = await get(server.address().port, '/api/ping');
  assert.strictEqual(ping.status, 200);
  // Without our CA the connection must be refused (proves real verification happened).
  await assert.rejects(new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: server.address().port, path: '/api/ping' }, resolve).on('error', reject)));

  const base = `http://127.0.0.1:${setupServer.address().port}`;
  const page = await fetch(`${base}/setup`);
  assert.match(await page.text(), /証明書をダウンロード/);
  const crt = await fetch(`${base}/remota-ca.crt`);
  assert.strictEqual(crt.headers.get('content-type'), 'application/x-x509-ca-cert');
  assert.ok(new crypto.X509Certificate(Buffer.from(await crt.arrayBuffer())).ca);
  server.close();
  setupServer.close();
  server.closeAllConnections();
});

test('a CA exported from one machine can be imported on another', () => {
  const exported = tls.exportCa();
  const before = tls.caInfo().fingerprint;
  tls.importCa(exported);
  assert.strictEqual(tls.caInfo().fingerprint, before);
  assert.throws(() => tls.importCa('{"remotaCa":1,"cert":"x","key":"y"}'));
  assert.throws(() => tls.importCa('{}'), /エクスポート/);
});
