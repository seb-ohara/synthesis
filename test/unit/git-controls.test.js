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
