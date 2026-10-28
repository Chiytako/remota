'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classify, stripAnsi, lastLines } = require('../src/detect');

test('stripAnsi removes colors and cursor movement', () => {
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m \x1b[2K\x1b[1Gok'), 'red ok');
});

test('detects Claude Code permission prompt as waiting', () => {
  const out = '\x1b[1mBash command\x1b[0m\r\n  npm test\r\n Do you want to proceed?\r\n \x1b[36m❯ 1. Yes\x1b[0m\r\n   2. No\r\n';
  assert.strictEqual(classify(out), 'waiting');
});

test('detects y/n prompts as waiting', () => {
  assert.strictEqual(classify('Overwrite file? [y/N] '), 'waiting');
});

test('busy spinner counts as working even if older prompt text exists', () => {
  assert.strictEqual(classify('Do you want to proceed?\n...\n✻ Thinking… (esc to interrupt)'), 'working');
});

test('plain shell output is not classified', () => {
  assert.strictEqual(classify('total 0\r\nuser@host:~$ '), null);
});

test('prompt that scrolled far away is ignored', () => {
  const old = 'Do you want to proceed?\n' + Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  assert.strictEqual(classify(old), null);
});

test('lastLines keeps the final meaningful lines', () => {
  assert.strictEqual(lastLines('a1\n\n│ b2 │\n╰────╯\nc3\n', 2), 'b2\nc3');
});

test('answered prompt followed by more output is no longer waiting', () => {
  const out = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n2\nPICKED=2\n$ echo hi\nhi\n$ ls\na b c\n$ ';
  assert.strictEqual(classify(out), null);
});

test('stripAnsi removes charset designations like ESC ( B', () => {
  assert.strictEqual(stripAnsi('\x1b(B\x1b[mroot@vm:~#'), 'root@vm:~#');
});

test('approval prompts from other agents are recognised', () => {
  const prompts = [
    'Allow command?\n› 1. Yes, proceed\n  2. No, and tell Codex what to do differently',
    'Apply this change?\n● 1. Allow once\n  2. Allow always\n  3. Reject',
    'Permission required: bash rm -rf build',
    'Run shell command? (Y)es/(N)o [Yes]:',
    'Waiting for permission to edit src/app.ts',
  ];
  for (const p of prompts) assert.strictEqual(classify(p), 'waiting', p);
});

test('busy indicators from other agents are recognised', () => {
  for (const p of ['⠋ Thinking… (esc to cancel, 4s)', 'Working (12s • Esc to interrupt)', 'Generating… ctrl+c to stop']) {
    assert.strictEqual(classify(p), 'working', p);
  }
});
