'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SUPPORTED_PACKAGES = new Set(['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']);

function compareVersions(a, b) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new Error('Pi returned an invalid version.');
  for (let i = 1; i <= 3; i++) { const diff = Number(left[i]) - Number(right[i]); if (diff) return Math.sign(diff); }
  if (!left[4] || !right[4]) return left[4] === right[4] ? 0 : left[4] ? -1 : 1;
  const x = left[4].split('.'), y = right[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === y[i] ? 0 : x[i] === undefined ? -1 : 1;
    if (x[i] === y[i]) continue;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn) return Math.sign(Number(x[i]) - Number(y[i]));
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function createPiUpdater(options = {}) {
  const home = options.home || os.homedir();
  const env = { ...process.env, ...options.env };
  env.PATH = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || ''].join(path.delimiter);
  const execute = options.execFile || execFile;
  function run(command, args, timeout = 30000) {
    return new Promise((resolve, reject) => execute(command, args, { env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message || 'Command failed').trim().slice(-500)));
      resolve(stdout.trim());
    }));
  }
  function executable(name) {
    for (const dir of env.PATH.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
    }
    throw new Error(`${name} was not found. Install it and try again.`);
  }
  function installed() {
    const pi = executable('pi'), resolved = fs.realpathSync(pi);
    let dir = path.dirname(resolved);
    for (let depth = 0; depth < 10; depth++) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        let meta; try { meta = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { throw new Error('Could not read the installed Pi package.'); }
        if (!SUPPORTED_PACKAGES.has(meta.name)) break;
        const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.pi;
        if (!bin || fs.realpathSync(path.resolve(dir, bin)) !== resolved) break;
        const suffix = path.join('lib', 'node_modules', ...meta.name.split('/'));
        if (!dir.endsWith(path.sep + suffix)) break;
        const prefix = dir.slice(0, -suffix.length - 1) || path.parse(dir).root;
        compareVersions(meta.version, meta.version);
        return { name: meta.name, version: meta.version, prefix };
      }
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
    throw new Error('This Pi installation is not a supported global npm package. Update it with its original installer.');
  }
  async function check() {
    const current = installed();
    const latest = JSON.parse(await run(executable('npm'), ['view', current.name, 'version', '--json']));
    if (typeof latest !== 'string') throw new Error('The npm registry did not return a Pi version.');
    return { installed: current.version, latest, available: compareVersions(latest, current.version) > 0 };
  }
  let pendingUpdate = null;
  async function update() {
    if (pendingUpdate) return pendingUpdate;
    pendingUpdate = (async () => {
      const current = installed();
      await run(executable('npm'), ['install', '--global', '--prefix', current.prefix, `${current.name}@latest`], 180000);
      return check();
    })();
    try { return await pendingUpdate; } finally { pendingUpdate = null; }
  }
  return { check, update };
}
module.exports = { createPiUpdater, compareVersions };
