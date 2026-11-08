'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stateStore = require('../../lib/state-store');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'workspaces.json');
}

function goodState(id = 'ws-1') {
  return {
    schemaVersion: 2,
    activeWorkspaceId: id,
    workspaces: [{
      id,
      name: 'workspace',
      cwd: '/tmp',
      fileDir: '/tmp',
      activePaneId: `${id}-p1`,
      panes: [{ id: `${id}-p1`, type: 'terminal', cwd: '/tmp' }],
      layout: { paneId: `${id}-p1` },
    }],
  };
}

test('save writes atomically and load round-trips', (t) => {
  const file = tmpFile(t);
  const res = stateStore.save(file, goodState());
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(file));
  const loaded = stateStore.load(file);
  assert.equal(loaded.source, 'main');
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.state.workspaces[0].id, 'ws-1');
  assert.ok(fs.existsSync(stateStore.backupPath(file)), 'last-known-good backup is kept');
});

test('a failed save leaves the prior snapshot intact', (t) => {
  const file = tmpFile(t);
  stateStore.save(file, goodState());
  const before = fs.readFileSync(file, 'utf8');

  const invalid = goodState();
  invalid.workspaces[0].panes = []; // invalid — must be refused
  const res = stateStore.save(file, invalid);
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'snapshot untouched after failed save');
  assert.equal(stateStore.load(file).state.workspaces[0].id, 'ws-1');
});

test('corrupt main file falls back to the last-known-good backup', (t) => {
  const file = tmpFile(t);
  stateStore.save(file, goodState());
  fs.writeFileSync(file, '{"schemaVersion": 2, "workspaces": [TRUNCATED');

  const loaded = stateStore.load(file);
  assert.equal(loaded.source, 'backup');
  assert.equal(loaded.state.workspaces[0].id, 'ws-1', 'recovered from backup');
});

test('a corrupt main file never overwrites the backup', (t) => {
  const file = tmpFile(t);
  stateStore.save(file, goodState());
  fs.writeFileSync(file, 'not json at all');
  const backupBefore = fs.readFileSync(stateStore.backupPath(file), 'utf8');

  const loaded = stateStore.load(file);
  assert.ok(loaded.state);
  assert.equal(fs.readFileSync(stateStore.backupPath(file), 'utf8'), backupBefore);
});

test('legacy v1 data is migrated on load', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({
    activeIndex: 0,
    workspaces: [{
      name: 'legacy',
      cwd: '/tmp',
      fileDir: '/tmp',
      activePaneIdx: 0,
      paneIds: ['ws-1-p1'],
      tree: { leaf: 0 },
    }],
  }));
  const loaded = stateStore.load(file);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.state.schemaVersion, 2);
  assert.equal(loaded.state.workspaces[0].panes[0].id, 'ws-1-p1', 'pane id preserved through migration');
});

test('unusable main and backup yield a null state without writes', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, 'garbage');
  fs.writeFileSync(stateStore.backupPath(file), 'also garbage');
  const loaded = stateStore.load(file);
  assert.equal(loaded.state, null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'garbage', 'main file untouched');
});

test('size-limited snapshots are refused on save and load', (t) => {
  const file = tmpFile(t);
  const big = goodState();
  big.workspaces[0].name = 'x'.repeat(2 * 1024 * 1024); // beyond maxJsonBytes
  const res = stateStore.save(file, big);
  assert.equal(res.ok, false);
  assert.ok(!fs.existsSync(file), 'nothing written');

  fs.writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
  const loaded = stateStore.load(file);
  assert.equal(loaded.state, null, 'oversized files are rejected before JSON parsing');
});

test('a failed backup replacement cannot damage the committed main snapshot', (t) => {
  const file = tmpFile(t);
  assert.equal(stateStore.save(file, goodState()).ok, true);
  const backup = stateStore.backupPath(file);
  fs.unlinkSync(backup);
  fs.mkdirSync(backup); // force the backup rename to fail

  const updated = goodState();
  updated.workspaces[0].name = 'updated';
  assert.equal(stateStore.save(file, updated).ok, true);
  assert.equal(stateStore.load(file).state.workspaces[0].name, 'updated');
  assert.ok(fs.statSync(backup).isDirectory(), 'failed backup write did not replace the prior backup path');
});

test('snapshot files are user-only (0600)', (t) => {
  const file = tmpFile(t);
  stateStore.save(file, goodState());
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});
