'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const runFile = promisify(execFile);
const env = { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
async function run(program, args, cwd) {
  const { stdout, stderr } = await runFile(program, args, { cwd, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return (stdout || stderr || '').trim();
}
async function status(cwd) {
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const [branch, porcelain, branches, remote] = await Promise.all([
    run('git', ['branch', '--show-current'], cwd),
    runFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout),
    run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], cwd),
    run('git', ['remote', 'get-url', 'origin'], cwd).catch(() => ''),
  ]);
  const parts = porcelain.split('\0'); const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]; if (!line) continue;
    const code = line.slice(0, 2), name = line.slice(3);
    if (code.includes('R') || code.includes('C')) i++;
    changes.push({ path: name, code, staged: code[0] !== ' ' && code[0] !== '?', unstaged: code[1] !== ' ' || code === '??' });
  }
  return { root, branch: branch || '(detached HEAD)', changes, branches: branches ? branches.split('\n') : [], remote };
}
async function action(cwd, op, data = {}) {
  const paths = Array.isArray(data.paths) ? data.paths.filter(p => typeof p === 'string' && p.length && !p.includes('\0')).slice(0, 1000) : [];
  switch (op) {
    case 'init': { const existing = await run('git', ['rev-parse', '--show-toplevel'], cwd).catch(() => ''); if (existing) throw new Error('This folder already belongs to a Git repository.'); return run('git', ['init'], cwd); }
    case 'stage': if (!paths.length) throw new Error('Select at least one file.'); return run('git', ['--literal-pathspecs', 'add', '--', ...paths], cwd);
    case 'unstage': if (!paths.length) throw new Error('Select at least one file.'); if (!(await run('git', ['rev-parse', '--verify', 'HEAD'], cwd).catch(() => ''))) return run('git', ['--literal-pathspecs', 'rm', '--cached', '--', ...paths], cwd); return run('git', ['--literal-pathspecs', 'restore', '--staged', '--', ...paths], cwd);
    case 'commit': { const msg = typeof data.message === 'string' ? data.message.trim() : ''; if (!msg || msg.length > 2000) throw new Error('Enter a commit message.'); return run('git', ['commit', '-m', msg], cwd); }
    case 'pull': return run('git', ['pull', '--ff-only'], cwd);
    case 'push': { const upstream = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd).catch(() => ''); return run('git', upstream ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD'], cwd); }
    case 'switch': { const name = data.branch; if (typeof name !== 'string' || !name || name.startsWith('-')) throw new Error('Choose a branch.'); return run('git', ['switch', '--', name], cwd); }
    case 'createBranch': { const name = data.branch; if (typeof name !== 'string' || !name || name.startsWith('-') || name.length > 200) throw new Error('Enter a branch name.'); await run('git', ['check-ref-format', '--branch', name], cwd); return run('git', ['switch', '-c', name], cwd); }
    default: throw new Error('Unknown Git action.');
  }
}
module.exports = { status, action };
