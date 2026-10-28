'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { CONFIG_DIR } = require('./config');

// Built-in HTTPS without a third-party service: Remota runs its own small certificate authority.
// The phone trusts that CA once (a profile install on iOS); every certificate Remota issues for
// this machine's addresses (LAN, VPN, hostname) is then trusted, so push notifications, the camera
// and Face ID work over plain IP addresses.

const DIR = path.join(CONFIG_DIR, 'tls');
const CA_KEY = path.join(DIR, 'ca.key');
const CA_CRT = path.join(DIR, 'ca.crt');
const SRV_KEY = path.join(DIR, 'server.key');
const SRV_CRT = path.join(DIR, 'server.crt');
const SRV_META = path.join(DIR, 'server.json');

// iOS rejects user-trusted TLS certificates valid for more than 825 days; stay under the 398-day
// limit browsers apply to public ones as well.
const LEAF_DAYS = 397;
const RENEW_BEFORE_DAYS = 30;

function rsaKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey: forge.pki.privateKeyFromPem(privateKey), publicKey: forge.pki.publicKeyFromPem(publicKey) };
}

function serial() {
  // Positive, non-zero 16-byte serial.
  return `01${crypto.randomBytes(15).toString('hex')}`;
}

function writeSecret(file, text) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function createCa() {
  const keys = rsaKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const subject = [
    { name: 'commonName', value: `Remota Local CA (${os.hostname()})` },
    { name: 'organizationName', value: 'Remota' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  writeSecret(CA_KEY, forge.pki.privateKeyToPem(keys.privateKey));
  writeSecret(CA_CRT, forge.pki.certificateToPem(cert));
}

function loadCa() {
  if (!fs.existsSync(CA_KEY) || !fs.existsSync(CA_CRT)) createCa();
  return {
    key: forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY, 'utf8')),
    cert: forge.pki.certificateFromPem(fs.readFileSync(CA_CRT, 'utf8')),
  };
}

// Every name the phone might use to reach this machine.
function hostNames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', '::1', os.hostname(), `${os.hostname().split('.')[0]}.local`]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!a.internal && !a.address.startsWith('fe80')) names.add(a.address);
    }
  }
  for (const n of extra) if (n) names.add(String(n).trim());
  return [...names].sort();
}

function issueServerCert(ca, names) {
  const keys = rsaKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: os.hostname() }, { name: 'organizationName', value: 'Remota' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: names.map((n) => (net.isIP(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  writeSecret(SRV_KEY, forge.pki.privateKeyToPem(keys.privateKey));
  writeSecret(SRV_CRT, `${forge.pki.certificateToPem(cert)}${fs.readFileSync(CA_CRT, 'utf8')}`);
  writeSecret(SRV_META, JSON.stringify({ names, notAfter: cert.validity.notAfter.toISOString(), ca: caFingerprint() }));
}

function caFingerprint() {
  return new crypto.X509Certificate(fs.readFileSync(CA_CRT)).fingerprint256;
}

// Returns { key, cert } for the HTTPS server, (re)issuing the certificate when the machine's
// addresses changed, the CA was replaced, or expiry is near. `changed` tells callers to reload.
function serverCredentials(extraNames = []) {
  const ca = loadCa();
  const names = hostNames(extraNames);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(SRV_META, 'utf8'));
  } catch {
    // first run
  }
  const stale =
    !meta ||
    !fs.existsSync(SRV_KEY) ||
    meta.ca !== caFingerprint() ||
    names.some((n) => !meta.names.includes(n)) ||
    new Date(meta.notAfter) - Date.now() < RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000;
  if (stale) issueServerCert(ca, names);
  return { key: fs.readFileSync(SRV_KEY), cert: fs.readFileSync(SRV_CRT), changed: stale, names };
}

function caCertDer() {
  const cert = forge.pki.certificateFromPem(fs.readFileSync(CA_CRT, 'utf8'));
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
}

function caInfo() {
  loadCa();
  const x = new crypto.X509Certificate(fs.readFileSync(CA_CRT));
  return { subject: x.subject.replace(/\n/g, ', '), fingerprint: x.fingerprint256, validTo: x.validTo };
}

// Sharing one CA across machines means the phone trusts a single profile for all of them.
function exportCa() {
  loadCa();
  return JSON.stringify({ remotaCa: 1, cert: fs.readFileSync(CA_CRT, 'utf8'), key: fs.readFileSync(CA_KEY, 'utf8') });
}

function importCa(text) {
  const data = JSON.parse(text);
  if (!data.remotaCa || !data.cert || !data.key) throw new Error('Remota の CA エクスポートファイルではありません');
  const cert = forge.pki.certificateFromPem(data.cert);
  const key = forge.pki.privateKeyFromPem(data.key);
  if (forge.pki.publicKeyToPem(cert.publicKey) !== forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(key.n, key.e))) {
    throw new Error('証明書と秘密鍵が一致しません');
  }
  writeSecret(CA_CRT, data.cert);
  writeSecret(CA_KEY, data.key);
  if (fs.existsSync(SRV_META)) fs.unlinkSync(SRV_META);
}

module.exports = { serverCredentials, caCertDer, caInfo, exportCa, importCa, hostNames, DIR, CA_CRT };
