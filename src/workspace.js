'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Read-only views into a session's working directory (git changes, files) and the machine's health,
// so the phone can review what an agent did without typing commands into the terminal.

const MAX_DIFF = 400 * 1024;
const MAX_FILE = 512 * 1024;

function run(cmd, args, cwd, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
}

async function gitChanges(cwd, file) {
  const top = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) return { repo: false };
  const root = top.stdout.trim();
  const [branch, status, log] = await Promise.all([
    run('git', ['branch', '--show-current'], cwd),
    run('git', ['status', '--porcelain=v1', '-uall'], cwd),
    run('git', ['log', '-5', '--pretty=format:%h\t%cr\t%s'], cwd),
  ]);
  const files = status.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, 500)
    .map((line) => ({ code: line.slice(0, 2).trim() || '?', path: line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() }));

  // Diff against HEAD covers staged and unstaged edits; new files are shown in full.
  const args = ['diff', '--no-color', '--no-ext-diff', 'HEAD'];
  if (file) args.push('--', file);
  let diff = (await run('git', args, root)).stdout;
  const untracked = files.filter((f) => f.code === '??' && (!file || f.path === file));
  for (const f of untracked.slice(0, 20)) {
    const extra = await run('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', f.path], root);
    diff += extra.stdout;
  }
  const truncated = diff.length > MAX_DIFF;
  return {
    repo: true,
    root,
    branch: branch.stdout.trim() || '(detached)',
    files,
    commits: log.stdout.split('\n').filter(Boolean).map((l) => {
      const [hash, when, ...subject] = l.split('\t');
      return { hash, when, subject: subject.join('\t') };
    }),
    diff: truncated ? diff.slice(0, MAX_DIFF) : diff,
    truncated,
  };
}

// Resolves `rel` inside `base`, refusing anything (including symlinks) that leads outside it.
function insideBase(base, rel) {
  const realBase = fs.realpathSync(base);
  const target = path.resolve(realBase, rel || '.');
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw Object.assign(new Error('見つかりません'), { status: 404 });
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw Object.assign(new Error('作業フォルダの外は表示できません'), { status: 403 });
  return { real, rel: path.relative(realBase, real) };
}

const HIDDEN = new Set(['.git', 'node_modules', '.remota-uploads', '__pycache__', '.venv', '.DS_Store']);

function browse(cwd, rel) {
  const { real, rel: clean } = insideBase(cwd, rel);
  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(real, { withFileTypes: true })
      .filter((e) => !HIDDEN.has(e.name))
      .slice(0, 1000)
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const s = fs.statSync(path.join(real, e.name));
          size = s.size;
          mtime = s.mtimeMs;
          return { name: e.name, dir: s.isDirectory(), size, mtime };
        } catch {
          return { name: e.name, dir: false, size, mtime };
        }
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { type: 'dir', path: clean, entries };
  }
  const size = stat.size;
  const fd = fs.openSync(real, 'r');
  const buf = Buffer.alloc(Math.min(size, MAX_FILE));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const binary = buf.subarray(0, 8000).includes(0);
  return { type: 'file', path: clean, size, binary, truncated: size > MAX_FILE, content: binary ? null : buf.toString('utf8') };
}

function rawFile(cwd, rel) {
  const { real } = insideBase(cwd, rel);
  if (!fs.statSync(real).isFile()) throw Object.assign(new Error('ファイルではありません'), { status: 400 });
  return real;
}

let gpuCache = { at: 0, value: null };
async function gpuStats() {
  if (Date.now() - gpuCache.at < 10000) return gpuCache.value;
  const r = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], undefined, 3000);
  const value = r.ok
    ? r.stdout.trim().split('\n').filter(Boolean).map((l) => {
        const [name, util, used, total, temp] = l.split(',').map((x) => x.trim());
        return { name, util: Number(util), memUsed: Number(used), memTotal: Number(total), temp: Number(temp) };
      })
    : null;
  gpuCache = { at: Date.now(), value };
  return value;
}

async function machineStats() {
  let disk = null;
  try {
    const s = fs.statfsSync(os.homedir());
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    // statfs unavailable
  }
  return {
    load: os.loadavg(),
    cpus: os.cpus().length,
    mem: { total: os.totalmem(), free: os.freemem() },
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()}`,
    disk,
    gpus: await gpuStats(),
  };
}

module.exports = { gitChanges, browse, rawFile, machineStats };
