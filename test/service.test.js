'use strict';

const test = require('node:test');
const assert = require('node:assert');
const svc = require('../src/service');

test('systemd unit restarts Remota and leaves tmux sessions alive', () => {
  const { text } = svc.preview('linux');
  assert.match(text, /^ExecStart=".+node.*" ".+bin\/remota\.js" start$/m);
  assert.match(text, /^Restart=always$/m);
  assert.match(text, /^KillMode=process$/m, 'stopping the service must not kill the tmux server');
  assert.match(text, /^Environment="PATH=/m, 'agents must be found on the PATH the user had');
  assert.match(text, /^WantedBy=default.target$/m);
});

test('launchd agent starts at login, stays alive and abandons tmux on stop', () => {
  const { text, file } = svc.preview('darwin');
  assert.match(file, /LaunchAgents\/dev\.remota\.plist$/);
  for (const key of ['RunAtLoad', 'KeepAlive', 'AbandonProcessGroup']) assert.match(text, new RegExp(`<key>${key}</key><true/>`));
  assert.match(text, /<string>start<\/string>/);
  // Well-formed enough for plutil: every <dict>/<array> closes.
  for (const tag of ['dict', 'array']) assert.strictEqual(text.split(`<${tag}>`).length, text.split(`</${tag}>`).length, tag);
});
