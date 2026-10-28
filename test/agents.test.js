'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Install into a throwaway home directory, never the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remota-agents-'));
process.env.HOME = home;
const agents = require('../src/agents');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('every agent installs and uninstalls cleanly, keeping existing settings', () => {
  // A pre-existing Claude Code setting and a user hook that must survive.
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));

  for (const a of agents.AGENTS) {
    agents.install(a.id);
    agents.install(a.id); // idempotent
    const state = agents.list().find((x) => x.id === a.id);
    assert.strictEqual(state.installed, true, `${a.id} installed`);
  }

  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.strictEqual(claude.model, 'opus');
  assert.strictEqual(claude.hooks.Stop.length, 2, 'user hook kept, ours added once');
  assert.match(claude.hooks.Notification[0].hooks[0].command, /notify --agent claude --event permission/);

  const copilot = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'hooks', 'remota-notify.json'), 'utf8'));
  assert.strictEqual(copilot.version, 1);
  assert.match(copilot.hooks.agentStop[0].bash, /--agent copilot --event stop/);
  assert.match(fs.readFileSync(path.join(home, '.config', 'opencode', 'plugins', 'remota-notify.js'), 'utf8'), /session\.idle/);
  assert.match(fs.readFileSync(path.join(home, '.pi', 'agent', 'extensions', 'remota-notify.ts'), 'utf8'), /agent_end/);
  assert.match(fs.readFileSync(path.join(home, '.aider.conf.yml'), 'utf8'), /notifications-command:/);

  for (const a of agents.AGENTS) agents.uninstall(a.id);
  for (const s of agents.list()) assert.strictEqual(s.installed, false, `${s.id} removed`);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(after.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }]);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json.remota-backup')), 'original kept as a backup');
});

test('agent payloads become a status and a readable message', () => {
  const p = agents.parseEvent;
  assert.deepStrictEqual(p('claude', 'permission', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), { status: 'waiting', message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(p('codex', 'stop', { hook_event_name: 'Stop', last_assistant_message: 'All tests pass.' }).message, 'All tests pass.');
  assert.strictEqual(p('codex', 'permission', { hook_event_name: 'PermissionRequest', tool_input: { command: 'npm publish' } }).message, 'npm publish');
  assert.strictEqual(p('gemini', 'stop', { hook_event_name: 'AfterAgent', prompt_response: 'Done refactoring' }).status, 'idle');
  assert.strictEqual(p('', '', { type: 'agent-turn-complete', 'last-assistant-message': 'legacy notify' }).message, 'legacy notify');
  assert.deepStrictEqual(p('aider', 'stop', null), { status: 'idle', message: 'タスクが完了しました' });
});
