'use strict';
const { execFile } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const runFile = promisify(execFile);
const env = { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':'), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
async function run(program, args, cwd) {
  const { stdout, stderr } = await runFile(program, args, { cwd, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return (stdout || stderr || '').trim();
}
async function status(cwd) {
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const [branch, porcelain, branches, remote, remoteHead, initialBranch] = await Promise.all([
    run('git', ['branch', '--show-current'], cwd),
    runFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout),
    run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], cwd),
    run('git', ['remote', 'get-url', 'origin'], cwd).catch(() => ''),
    run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd).catch(() => ''),
    run('git', ['config', '--get', 'init.defaultBranch'], cwd).catch(() => ''),
  ]);
  const parts = porcelain.split('\0'); const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]; if (!line) continue;
    const code = line.slice(0, 2), name = line.slice(3);
    if (code.includes('R') || code.includes('C')) i++;
    changes.push({ path: name, code, staged: code[0] !== ' ' && code[0] !== '?', unstaged: code[1] !== ' ' || code === '??' });
  }
  const counts = { added: 0, deleted: 0, incomplete: false };
  const byPath = new Map(changes.map(change => [change.path, change]));
  for (const change of changes) { change.added = 0; change.deleted = 0; }
  const addCounts = output => { for (const record of output.split('\0')) { if (!record) continue; const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1); if (first < 0 || second < 0) continue; const added = record.slice(0, first), deleted = record.slice(first + 1, second), change = byPath.get(record.slice(second + 1)); if (added === '-' || deleted === '-') counts.incomplete = true; else { const a = Number(added) || 0, d = Number(deleted) || 0; counts.added += a; counts.deleted += d; if (change) { change.added += a; change.deleted += d; } } } };
  const [workingStats, stagedStats] = await Promise.all([
    run('git', ['diff', '--numstat', '-z', '--no-renames'], root),
    run('git', ['diff', '--cached', '--numstat', '-z', '--no-renames'], root),
  ]);
  addCounts(workingStats); addCounts(stagedStats);
  for (const change of changes.filter(change => change.code === '??')) {
    try {
      const file = path.join(root, change.path), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) { counts.incomplete = true; continue; }
      const data = await fs.readFile(file);
      if (data.includes(0)) { counts.incomplete = true; continue; }
      const text = data.toString('utf8'); const added = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; counts.added += added; change.added += added;
    } catch { counts.incomplete = true; }
  }
  const branchNames = branches ? branches.split('\n') : [];
  const defaultBranch = remoteHead.startsWith('origin/') ? remoteHead.slice(7) : (branchNames.includes('main') || branch === 'main') ? 'main' : (branchNames.includes('master') || branch === 'master') ? 'master' : (initialBranch || '');
  return { root, branch: branch || '(detached HEAD)', defaultBranch, changes, branches: branchNames, remote, counts };
}

async function review(cwd, scope, ref) {
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const branches = await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root);
  const commits = await run('git', ['log', '-30', '--format=%h%x09%s'], root).catch(() => '');
  let output = '';
  if (scope === 'working') {
    const [staged, working, files] = await Promise.all([
      run('git', ['diff', '--cached', '--no-ext-diff', '--no-color'], root),
      run('git', ['diff', '--no-ext-diff', '--no-color'], root),
      runFile('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }).then(result => result.stdout),
    ]);
    const untracked = [], untrackedFiles = files.split('\0').filter(Boolean);
    let untrackedBytes = 0;
    for (const file of untrackedFiles.slice(0, 100)) {
      if (untrackedBytes >= 1000000) { untracked.push('Additional untracked files omitted.'); break; }
      try {
        const result = await runFile('git', ['--literal-pathspecs', 'diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', file], { cwd: root, env, timeout: 10000, maxBuffer: 512 * 1024, encoding: 'utf8' });
        if (result.stdout) { untracked.push(result.stdout); untrackedBytes += result.stdout.length; }
      } catch (error) { if (error.code === 1 && error.stdout) { untracked.push(error.stdout); untrackedBytes += error.stdout.length; } else untracked.push(`Unable to display untracked file: ${file}`); }
    }
    if (untrackedFiles.length > 100) untracked.push('Additional untracked files omitted.');
    output = [staged && `Staged changes\n${staged}`, working && `Unstaged changes\n${working}`, untracked.length && `Untracked files\n${untracked.join('\n')}`].filter(Boolean).join('\n\n') || 'No uncommitted changes.';
  } else if (scope === 'branch') {
    const names = branches ? branches.split('\n') : [];
    if (!names.includes(ref)) throw new Error('Choose a local base branch.');
    output = await run('git', ['diff', '--no-ext-diff', '--no-color', `${ref}...HEAD`, '--'], root) || 'No changes compared with this branch.';
  } else if (scope === 'commit') {
    if (typeof ref !== 'string' || !/^[a-f0-9]{7,40}$/.test(ref)) throw new Error('Choose a local commit.');
    output = await run('git', ['show', '--format=fuller', '--no-ext-diff', '--no-color', ref, '--'], root);
  } else throw new Error('Choose a review scope.');
  return { output: output.slice(0, 1000000), truncated: output.length > 1000000, branches: branches ? branches.split('\n') : [], commits: commits ? commits.split('\n').map(line => { const i = line.indexOf('\t'); return { id: line.slice(0, i), subject: line.slice(i + 1) }; }) : [] };
}
function repositoryUrl(value) {
  if (typeof value !== 'string') throw new Error('Enter a repository URL or an absolute local path.');
  const url = value.trim();
  if (!url || url.length > 2048 || /[\x00-\x1f\x7f]/.test(url) || url.startsWith('-')) throw new Error('Enter a valid repository URL or absolute local path.');
  if (path.isAbsolute(url)) return url;
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (['https:', 'ssh:'].includes(parsed.protocol) && parsed.hostname && !parsed.password && !parsed.search && !parsed.hash) return url;
  } catch {}
  throw new Error('Use an HTTPS or SSH repository URL, or an absolute local path.');
}
async function autoCommit(cwd, op, generateMessage, expectedBranch) {
  if (!['commit', 'commitAndPush'].includes(op)) throw new Error('Unknown commit action.');
  const branch = await run('git', ['branch', '--show-current'], cwd);
  if (typeof expectedBranch === 'string' && (branch || '(detached HEAD)') !== expectedBranch) throw new Error('The branch changed. Please try again.');
  const root = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (await run('git', ['diff', '--name-only', '--diff-filter=U'], root)) throw new Error('Resolve merge conflicts before committing.');
  await run('git', ['add', '-A', '--', '.'], root);
  const staged = await runFile('git', ['diff', '--cached', '--quiet', '--exit-code'], { cwd, env, timeout: 60000 }).then(() => false, error => { if (error.code === 1) return true; throw error; });
  if (!staged) throw new Error('No changes to commit.');
  const indexTree = await run('git', ['write-tree'], cwd);
  const summary = await run('git', ['diff', '--cached', '--stat', '--no-ext-diff', '--no-color'], cwd);
  let patch;
  try { patch = await run('git', ['diff', '--cached', '--no-ext-diff', '--no-color', '--no-renames', '--'], cwd); }
  catch (error) { if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') patch = ''; else throw error; }
  const message = await generateMessage({ summary: summary.slice(0, 6000), patch: patch.slice(0, 24000) });
  if (typeof message !== 'string' || !message.trim()) throw new Error('Could not generate a commit message. Check the selected model and try again.');
  if ((await run('git', ['write-tree'], cwd)) !== indexTree || (await run('git', ['branch', '--show-current'], cwd)) !== branch) throw new Error('The staged changes or branch changed while preparing the commit. Please try again.');
  const cleanMessage = message.trim().split(/\r?\n/)[0].replace(/^[\s"'`#*]+|[\s"'`]+$/g, '').slice(0, 100);
  if (!cleanMessage) throw new Error('Could not generate a commit message. Please try again.');
  const output = await action(cwd, op, { message: cleanMessage });
  return { output, message: cleanMessage };
}
async function action(cwd, op, data = {}) {
  const paths = Array.isArray(data.paths) ? data.paths.filter(p => typeof p === 'string' && p.length && !p.includes('\0')).slice(0, 1000) : [];
  switch (op) {
    case 'init': { const existing = await run('git', ['rev-parse', '--show-toplevel'], cwd).catch(() => ''); if (existing) throw new Error('This folder already belongs to a Git repository.'); return run('git', ['init'], cwd); }
    case 'connectRemote': {
      const url = repositoryUrl(data.url);
      await run('git', ['rev-parse', '--show-toplevel'], cwd);
      const hasOrigin = await run('git', ['remote'], cwd).then(remotes => remotes.split('\n').includes('origin'));
      return hasOrigin ? run('git', ['remote', 'set-url', 'origin', url], cwd) : run('git', ['remote', 'add', 'origin', url], cwd);
    }
    case 'clone': {
      const url = repositoryUrl(data.url);
      const existing = await run('git', ['rev-parse', '--show-toplevel'], cwd).catch(() => '');
      if (existing) throw new Error('This folder already belongs to a Git repository.');
      if ((await fs.readdir(cwd)).length) throw new Error('Choose an empty project folder before cloning a repository.');
      return run('git', ['clone', '--', url, '.'], cwd);
    }

    case 'stage': if (!paths.length) throw new Error('Select at least one file.'); return run('git', ['--literal-pathspecs', 'add', '--', ...paths], cwd);
    case 'unstage': if (!paths.length) throw new Error('Select at least one file.'); if (!(await run('git', ['rev-parse', '--verify', 'HEAD'], cwd).catch(() => ''))) return run('git', ['--literal-pathspecs', 'rm', '--cached', '--', ...paths], cwd); return run('git', ['--literal-pathspecs', 'restore', '--staged', '--', ...paths], cwd);
    case 'commit': {
      const msg = typeof data.message === 'string' ? data.message.trim() : '';
      if (!msg || msg.length > 2000) throw new Error('Enter a commit message.');
      const hasStagedChanges = await runFile('git', ['diff', '--cached', '--quiet', '--exit-code'], { cwd, env, timeout: 60000 }).then(() => false, error => { if (error.code === 1) return true; throw error; });
      if (!hasStagedChanges) throw new Error('No changes are ready to commit.');
      return run('git', ['commit', '-m', msg], cwd);
    }
    case 'commitAndPush': {
      const commitOutput = await action(cwd, 'commit', data);
      try { const pushOutput = await action(cwd, 'push'); return [commitOutput, pushOutput].filter(Boolean).join('\n'); }
      catch (error) { error.committed = true; throw error; }
    }
    case 'pull': return run('git', ['pull', '--ff-only'], cwd);
    case 'push': { const upstream = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd).catch(() => ''); return run('git', upstream ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD'], cwd); }
    case 'switch': { const name = data.branch; if (typeof name !== 'string' || !name || name.startsWith('-')) throw new Error('Choose a branch.'); return run('git', ['switch', '--', name], cwd); }
    case 'createBranch': { const name = data.branch; if (typeof name !== 'string' || !name || name.startsWith('-') || name.length > 200) throw new Error('Enter a branch name.'); await run('git', ['check-ref-format', '--branch', name], cwd); return run('git', ['switch', '-c', name], cwd); }
    default: throw new Error('Unknown Git action.');
  }
}
module.exports = { status, action, review, autoCommit };
