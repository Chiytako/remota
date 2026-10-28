'use strict';

const path = require('path');
const webpush = require('web-push');
const { CONFIG_DIR, readJson, writeJson } = require('./config');

const SUBS_FILE = path.join(CONFIG_DIR, 'push-subscriptions.json');

class Notifier {
  constructor(config) {
    this.config = config;
    this.subscriptions = readJson(SUBS_FILE, []);
    webpush.setVapidDetails('mailto:remota@localhost', config.vapid.publicKey, config.vapid.privateKey);
  }

  get publicKey() {
    return this.config.vapid.publicKey;
  }

  // The phone owns its VAPID key pair and hands it to every machine it uses, so all of them can
  // push to its single subscription without a central server. `device` is the phone's own id for
  // this machine, echoed back in payloads so a tap opens the right session.
  subscribe(sub, { vapid, device } = {}) {
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) throw new Error('invalid subscription');
    const entry = { endpoint: sub.endpoint, keys: sub.keys };
    if (vapid) {
      if (typeof vapid.publicKey !== 'string' || typeof vapid.privateKey !== 'string') throw new Error('invalid VAPID keys');
      // Throws on malformed keys, before anything is stored.
      webpush.getVapidHeaders('https://push.example', 'mailto:remota@localhost', vapid.publicKey, vapid.privateKey, 'aes128gcm');
      entry.vapid = { publicKey: vapid.publicKey, privateKey: vapid.privateKey };
    }
    if (device) entry.device = String(device).slice(0, 64);
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    this.subscriptions.push(entry);
    writeJson(SUBS_FILE, this.subscriptions);
  }

  unsubscribe(endpoint) {
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    writeJson(SUBS_FILE, this.subscriptions);
  }

  async send({ title, body, sessionId, tag }) {
    const gone = [];
    await Promise.all(
      this.subscriptions.map((sub) => {
        const payload = JSON.stringify({ title, body, sessionId, device: sub.device || null, tag: tag || (sessionId ? `${sub.device || ''}:${sessionId}` : 'remota') });
        const options = { TTL: 3600, urgency: 'high' };
        if (sub.vapid) options.vapidDetails = { subject: 'mailto:remota@localhost', ...sub.vapid };
        return webpush.sendNotification(sub, payload, options).catch((err) => {
          if (err.statusCode === 404 || err.statusCode === 410) gone.push(sub.endpoint);
          else console.warn(`[remota] push failed: ${err.statusCode || ''} ${err.message}`);
        });
      })
    );
    if (gone.length) {
      this.subscriptions = this.subscriptions.filter((s) => !gone.includes(s.endpoint));
      writeJson(SUBS_FILE, this.subscriptions);
    }
    if (this.config.webhookUrl) await this.webhook({ title, body, sessionId });
  }

  async webhook({ title, body, sessionId }) {
    const url = this.config.webhookUrl;
    try {
      // ntfy takes the message as the body and the title as a query param (headers can't carry UTF-8);
      // any other webhook gets JSON.
      const target = new URL(url);
      if (/ntfy/.test(target.hostname)) {
        target.searchParams.set('title', title);
        target.searchParams.set('tags', 'robot');
        await fetch(target, { method: 'POST', body });
      } else {
        await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, sessionId }),
        });
      }
    } catch (err) {
      console.warn(`[remota] webhook failed: ${err.message}`);
    }
  }
}

module.exports = { Notifier };
