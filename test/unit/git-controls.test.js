'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../../lib/git-controls');
test('Git controls report, stage, commit and switch branches in a temporary repository', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-git-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'example.txt'), 'one');
  let state = await git.status(dir); assert.equal(state.changes[0].path, 'example.txt'); assert(state.changes[0].unstaged);
  await git.action(dir, 'stage', { paths: ['example.txt'] });
  state = await git.status(dir); assert(state.changes[0].staged);
  await git.action(dir, 'commit', { message: 'Initial test commit' });
  await git.action(dir, 'createBranch', { branch: 'test-branch' });
  assert.equal((await git.status(dir)).branch, 'test-branch');
  const initial = (await git.status(dir)).branches.find(name => name !== 'test-branch');
  await git.action(dir, 'switch', { branch: initial }); assert.equal((await git.status(dir)).branch, initial);
  fs.writeFileSync(path.join(dir, 'example.txt'), 'two');
  state = await git.status(dir); assert.equal(state.changes[0].path, 'example.txt'); assert(state.changes[0].unstaged);
});

test('initialization creates a repository and refuses to reinitialize an existing one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-git-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await git.action(dir, 'init');
  assert(fs.existsSync(path.join(dir, '.git')));
  await assert.rejects(git.action(dir, 'init'), /already belongs/);
  const sub = path.join(dir, 'nested'); fs.mkdirSync(sub);
  await assert.rejects(git.action(sub, 'init'), /already belongs/);
});

test('review separates staged, unstaged and untracked changes and compares history', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-review-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run('init'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'one.txt'), 'first\n');
  run('add', 'one.txt'); run('commit', '-m', 'Initial');
  const base = run('branch', '--show-current');
  run('switch', '-c', 'feature');
  fs.writeFileSync(path.join(dir, 'one.txt'), 'first\nbranch change\n');
  run('add', 'one.txt'); run('commit', '-m', 'Feature change');
  const commit = run('rev-parse', '--short', 'HEAD');
  fs.writeFileSync(path.join(dir, 'one.txt'), 'staged change\n'); run('add', 'one.txt');
  fs.appendFileSync(path.join(dir, 'one.txt'), 'unstaged change\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked change\n');
  const working = await git.review(dir, 'working');
  assert.match(working.output, /Staged changes[\s\S]*\+staged change/);
  assert.match(working.output, /Unstaged changes[\s\S]*\+unstaged change/);
  assert.match(working.output, /Untracked files[\s\S]*\+untracked change/);
  assert(working.branches.includes(base)); assert(working.commits.some(item => item.id === commit));
  assert.match((await git.review(dir, 'branch', base)).output, /\+branch change/);
  assert.match((await git.review(dir, 'commit', commit)).output, /Feature change/);
  assert.rejects(git.review(dir, 'branch', '--bad'), /Choose a local base branch/);
  assert.rejects(git.review(dir, 'commit', '--bad'), /Choose a local commit/);
  const status = await git.status(dir); assert.equal(status.counts.added, 3); assert.equal(status.counts.deleted, 2);
});

test('commit and push sends staged changes and preserves unstaged files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-commit-push-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-commit-remote-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); });
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  run('init'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  run('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  fs.writeFileSync(path.join(dir, 'unstaged.txt'), 'untracked\n');
  run('add', 'staged.txt');
  await git.action(dir, 'commitAndPush', { message: 'Commit and push test' });
  const local = run('rev-parse', 'HEAD');
  const pushed = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/' + run('branch', '--show-current')], { encoding: 'utf8' }).trim();
  assert.equal(pushed, local);
  assert.match(run('status', '--porcelain'), /\?\? unstaged\.txt/);
  assert.doesNotMatch(run('show', '--name-only', '--format=', 'HEAD'), /unstaged\.txt/);
});

test('commit and push reports a completed commit if the push fails', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-commit-push-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('init'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content\n'); run('add', 'file.txt');
  await assert.rejects(git.action(dir, 'commitAndPush', { message: 'Saved locally' }), error => error.committed === true);
  assert.equal(run('log', '-1', '--format=%s'), 'Saved locally');
});

test('connects or updates an origin without changing project files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-connect-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-origin-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(remote, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'keep me');
  await git.action(dir, 'connectRemote', { url: remote });
  assert.equal((await git.status(dir)).remote, remote);
  await git.action(dir, 'connectRemote', { url: 'https://github.com/example/other.git' });
  assert.equal((await git.status(dir)).remote, 'https://github.com/example/other.git');
  assert.equal(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8'), 'keep me');
  await assert.rejects(git.action(dir, 'connectRemote', { url: 'ext::malicious-command' }), /HTTPS or SSH/);
  await assert.rejects(git.action(dir, 'connectRemote', { url: 'https://user:secret@example.com/repo.git' }), /HTTPS or SSH/);
});

test('clones a repository only into an empty non-repository folder', async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-clone-source-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-clone-dest-'));
  const occupied = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-clone-occupied-'));
  t.after(() => { for (const dir of [source, dest, occupied]) fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (...args) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
  run('init'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(source, 'example.txt'), 'source contents\n'); run('add', 'example.txt'); run('commit', '-m', 'Initial');
  await git.action(dest, 'clone', { url: source });
  assert.equal(fs.readFileSync(path.join(dest, 'example.txt'), 'utf8'), 'source contents\n');
  assert.equal((await git.status(dest)).remote, source);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep me');
  await assert.rejects(git.action(occupied, 'clone', { url: source }), /empty project folder/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep me');
  await assert.rejects(git.action(dest, 'clone', { url: source }), /already belongs/);
});


test('commit explains when no files are staged', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-unstaged-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'not staged\n');
  await assert.rejects(git.action(dir, 'commit', { message: 'Initial commit' }), /No staged changes.*Stage files/);
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), /\?\? file.txt/);
});
