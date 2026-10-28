'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Wires coding agents' own notification mechanisms (hooks, plugins, extensions) to `remota notify`,
// so "finished" and "needs approval" arrive reliably instead of being guessed from screen output.

const HOME = os.homedir();
const MARK = 'remota-notify';

// Absolute paths, so hooks work even when `remota` isn't on the agent's PATH.
function notifyCommand(agent, event) {
  const bin = path.resolve(__dirname, '..', 'bin', 'remota.js');
  return `"${process.execPath}" "${bin}" notify --agent ${agent} --event ${event} # ${MARK}`;
}

function onPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${file} を読み込めません（JSONの形式を確認してください）: ${err.message}`);
  }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep the user's original once, before Remota ever touched it.
  if (fs.existsSync(file) && !fs.existsSync(`${file}.remota-backup`)) fs.copyFileSync(file, `${file}.remota-backup`);
  fs.writeFileSync(file, text);
}

const isOurs = (h) => JSON.stringify(h).includes(MARK);

// Hook files shaped like Claude Code's: { hooks: { Event: [ { matcher?, hooks: [ {type, command} ] } ] } }
function nestedHooks(file, events, agent) {
  return {
    file,
    installed: () => events.some(([ev]) => (readJson(file).hooks?.[ev] || []).some(isOurs)),
    install() {
      const cfg = readJson(file);
      cfg.hooks = cfg.hooks || {};
      for (const [ev, kind] of events) {
        const groups = (cfg.hooks[ev] || []).filter((g) => !isOurs(g));
        groups.push({ hooks: [{ type: 'command', command: notifyCommand(agent, kind), timeout: 10 }] });
        cfg.hooks[ev] = groups;
      }
      writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
    },
    uninstall() {
      const cfg = readJson(file);
      if (!cfg.hooks) return;
      for (const [ev] of events) {
        if (!cfg.hooks[ev]) continue;
        cfg.hooks[ev] = cfg.hooks[ev].filter((g) => !isOurs(g));
        if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
      }
      writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  };
}

// Hook files shaped like { version: 1, hooks: { event: [ { command | bash } ] } } (Cursor, Copilot).
function flatHooks(file, events, agent, field, extra = {}) {
  return {
    file,
    installed: () => events.some(([ev]) => (readJson(file).hooks?.[ev] || []).some(isOurs)),
    install() {
      const cfg = { version: 1, ...readJson(file) };
      cfg.hooks = cfg.hooks || {};
      for (const [ev, kind] of events) {
        cfg.hooks[ev] = [...(cfg.hooks[ev] || []).filter((h) => !isOurs(h)), { ...extra, [field]: notifyCommand(agent, kind) }];
      }
      writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
    },
    uninstall() {
      const cfg = readJson(file);
      if (!cfg.hooks) return;
      for (const [ev] of events) {
        if (!cfg.hooks[ev]) continue;
        cfg.hooks[ev] = cfg.hooks[ev].filter((h) => !isOurs(h));
        if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
      }
      writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  };
}

// A file Remota owns entirely (plugin/extension source).
function ownedFile(file, source) {
  return {
    file,
    installed: () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK),
    install: () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source());
    },
    uninstall: () => {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK)) fs.unlinkSync(file);
    },
  };
}

const bin = () => path.resolve(__dirname, '..', 'bin', 'remota.js');

const opencodePlugin = () => `// ${MARK}: sends OpenCode's "finished" and "needs permission" events to Remota.
const NODE = ${JSON.stringify(process.execPath)};
const REMOTA = ${JSON.stringify(bin())};

export const RemotaNotify = async ({ $, directory }) => {
  const notify = (event, message) =>
    $\`\${NODE} \${REMOTA} notify --agent opencode --event \${event} \${message || ''}\`.cwd(directory).quiet().nothrow();
  return {
    event: async ({ event }) => {
      if (event.type === 'session.idle') await notify('stop', '');
      else if (event.type === 'permission.asked' || event.type === 'permission.updated') {
        const p = event.properties || {};
        await notify('permission', p.title || p.type || '許可が必要です');
      } else if (event.type === 'session.error') await notify('error', 'エラーで停止しました');
    },
  };
};
`;

const piExtension = () => `// ${MARK}: sends pi's "finished" events to Remota.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NODE = ${JSON.stringify(process.execPath)};
const REMOTA = ${JSON.stringify(bin())};

export default function (pi: ExtensionAPI) {
  const notify = (event: string, message = "") =>
    pi.exec(NODE, [REMOTA, "notify", "--agent", "pi", "--event", event, message], { timeout: 5000 }).catch(() => {});

  pi.on("agent_end", async (event: any) => {
    const last = [...(event.messages || [])].reverse().find((m: any) => m.role === "assistant");
    const text = Array.isArray(last?.content)
      ? last.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
      : typeof last?.content === "string" ? last.content : "";
    await notify("stop", text.slice(0, 200));
  });
}
`;

function aiderConfig() {
  const file = path.join(HOME, '.aider.conf.yml');
  const block = `# ${MARK} begin\nnotifications: true\nnotifications-command: '${notifyCommand('aider', 'stop').replace(` # ${MARK}`, '').replace(/'/g, "''")}'\n# ${MARK} end\n`;
  const strip = (t) => t.replace(new RegExp(`# ${MARK} begin[\\s\\S]*?# ${MARK} end\\n?`), '');
  return {
    file,
    installed: () => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK),
    install() {
      const text = fs.existsSync(file) ? strip(fs.readFileSync(file, 'utf8')) : '';
      if (/^\s*notifications(-command|_command)?\s*:/m.test(text)) throw new Error(`${file} に notifications の設定がすでにあります。手動で調整してください`);
      writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}`);
    },
    uninstall() {
      if (fs.existsSync(file)) writeFile(file, strip(fs.readFileSync(file, 'utf8')));
    },
  };
}

const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    configDir: '.claude',
    via: '~/.claude/settings.json の hooks（Stop / Notification）',
    target: () => nestedHooks(path.join(HOME, '.claude', 'settings.json'), [['Stop', 'stop'], ['Notification', 'permission']], 'claude'),
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    configDir: '.codex',
    via: '~/.codex/hooks.json（Stop / PermissionRequest）',
    target: () => nestedHooks(path.join(HOME, '.codex', 'hooks.json'), [['Stop', 'stop'], ['PermissionRequest', 'permission']], 'codex'),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    configDir: '.gemini',
    via: '~/.gemini/settings.json の hooks（AfterAgent / Notification）',
    target: () => nestedHooks(path.join(HOME, '.gemini', 'settings.json'), [['AfterAgent', 'stop'], ['Notification', 'permission']], 'gemini'),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    configDir: path.join('.config', 'opencode'),
    via: '~/.config/opencode/plugins/remota-notify.js（session.idle / permission.asked）',
    target: () => ownedFile(path.join(HOME, '.config', 'opencode', 'plugins', 'remota-notify.js'), opencodePlugin),
  },
  {
    id: 'pi',
    name: 'pi',
    command: 'pi',
    configDir: path.join('.pi', 'agent'),
    via: '~/.pi/agent/extensions/remota-notify.ts（agent_end）',
    target: () => ownedFile(path.join(HOME, '.pi', 'agent', 'extensions', 'remota-notify.ts'), piExtension),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    configDir: '.copilot',
    via: '~/.copilot/hooks/remota-notify.json（agentStop / notification / permissionRequest）',
    target: () =>
      flatHooks(
        path.join(process.env.COPILOT_HOME || path.join(HOME, '.copilot'), 'hooks', 'remota-notify.json'),
        [['agentStop', 'stop'], ['notification', 'permission'], ['permissionRequest', 'permission']],
        'copilot',
        'bash',
        { type: 'command', timeoutSec: 10 }
      ),
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    command: 'cursor-agent',
    configDir: '.cursor',
    via: '~/.cursor/hooks.json（stop）',
    target: () => flatHooks(path.join(HOME, '.cursor', 'hooks.json'), [['stop', 'stop']], 'cursor', 'command'),
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    command: 'droid',
    configDir: '.factory',
    via: '~/.factory/settings.json の hooks（Stop / Notification）',
    target: () => nestedHooks(path.join(HOME, '.factory', 'settings.json'), [['Stop', 'stop'], ['Notification', 'permission']], 'droid'),
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    configDir: null,
    via: '~/.aider.conf.yml の notifications-command（応答待ちになったとき）',
    target: aiderConfig,
  },
];

function list() {
  return AGENTS.map((a) => {
    const t = a.target();
    let installed = false;
    let error = null;
    try {
      installed = t.installed();
    } catch (err) {
      error = err.message;
    }
    const present = onPath(a.command) || Boolean(a.configDir && fs.existsSync(path.join(HOME, a.configDir)));
    return { id: a.id, name: a.name, command: a.command, present, installed, via: a.via, file: t.file, error };
  });
}

function get(id) {
  const a = AGENTS.find((x) => x.id === id);
  if (!a) throw Object.assign(new Error(`unknown agent: ${id}`), { status: 404 });
  return a;
}

function install(id) {
  get(id).target().install();
}

function uninstall(id) {
  get(id).target().uninstall();
}

// What each agent hands to its hook, reduced to { status, message }.
function parseEvent(agent, event, payload) {
  const p = payload || {};
  const waiting = event === 'permission' || p.hook_event_name === 'Notification' || p.hook_event_name === 'PermissionRequest' || p.type === 'approval-requested';
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim());
  let message = pick(
    p.message,
    p.last_assistant_message,
    p['last-assistant-message'],
    p.prompt_response,
    p.tool_input && (p.tool_input.description || p.tool_input.command),
    p.toolName && `${p.toolName} の実行許可`,
    p.tool_name && `${p.tool_name} の実行許可`
  );
  if (!message) message = waiting ? '許可が必要です' : event === 'error' || p.status === 'error' ? 'エラーで停止しました' : 'タスクが完了しました';
  return { status: waiting ? 'waiting' : 'idle', message: message.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

module.exports = { AGENTS, list, install, uninstall, parseEvent, notifyCommand, onPath, MARK };
