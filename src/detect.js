'use strict';

// Heuristics that read a terminal's recent output and guess what a coding agent is doing.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()*+][0-9A-Za-z]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// Prompts where an agent stops and waits for a human decision. Covers Claude Code, Codex, Gemini
// CLI, OpenCode, Copilot, Cursor, Droid, Aider and generic y/n prompts; agents with hooks installed
// report this themselves.
const WAITING_PATTERNS = [
  /do you want to (?:proceed|make this edit|create|run|allow|continue|apply)/i,
  /would you like to (?:proceed|continue|run|make|apply|allow)/i,
  /\b(?:allow|approve|deny|reject)\b.*\?/i,
  /[❯›>●]\s*1[.)]\s*(?:yes|allow|approve|accept)/i,
  /\b(?:allow once|allow always|always allow|yes, allow|accept once)\b/i,
  /\b(?:permission (?:required|requested|needed)|requires? (?:your )?(?:approval|permission)|approval (?:required|needed))\b/i,
  /waiting for (?:your )?(?:input|approval|confirmation|permission)/i,
  /\[y\/n\]|\(y\/n\)|\[Y\/n\]|\[y\/N\]|\(Y\)es\/\(N\)o/,
  /press enter to (?:continue|confirm)/i,
];

// Text agents show while they are busy.
const WORKING_PATTERNS = [
  /\besc(?:ape)? to (?:interrupt|cancel|stop)\b/i,
  /\bctrl\+c to (?:interrupt|cancel|stop)\b/i,
  /\(esc to cancel/i,
];

function classify(recentOutput) {
  const text = stripAnsi(recentOutput).slice(-4000);
  // Only the last few visible lines matter: a prompt that was already answered and pushed up
  // by newer output must not count.
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-8).join('\n');
  if (WORKING_PATTERNS.some((re) => re.test(lines.slice(-4).join('\n')))) return 'working';
  if (WAITING_PATTERNS.some((re) => re.test(tail))) return 'waiting';
  return null;
}

// Short human-readable summary of the last meaningful lines, used in notifications.
function lastLines(recentOutput, count = 3) {
  return stripAnsi(recentOutput)
    .split(/\r?\n/)
    .map((l) => l.replace(/[─━│┃╭╮╯╰┌┐└┘├┤┬┴┼═║]+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .slice(-count)
    .join('\n')
    .slice(0, 240);
}

module.exports = { stripAnsi, classify, lastLines };
