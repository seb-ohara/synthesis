'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  SCHEMA_VERSION,
  LIMITS,
  ValidationError,
  migrateV1,
  validateState,
  normalizeState,
} = require('../../lib/state-schema');

/* The exact legacy shape observed in the real app-support snapshot. */
const LEGACY = {
  activeIndex: 1,
  workspaces: [
    {
      name: 'workspace 1',
      cwd: '/Users/dev',
      fileDir: '/Users/dev',
      activePaneIdx: 1,
      paneIds: ['ws-1-p1', 'ws-1-p2'],
      tree: { type: 'split', dir: 'row', children: [{ leaf: 0 }, { leaf: 1 }] },
    },
    {
      name: 'Test',
      cwd: '/Users/dev/Documents/Test Workspace',
      fileDir: '/Users/dev/Documents/Test Workspace',
      activePaneIdx: 1,
      paneIds: ['ws-2-p3', 'ws-2-p4'],
      tree: { type: 'split', dir: 'col', children: [{ leaf: 0 }, { leaf: 1 }] },
    },
    {
      name: 'Flyp',
      cwd: '/Users/dev/Documents/Work/Flyp',
      fileDir: '/Users/dev/Documents/Work/Flyp',
      activePaneIdx: 0,
      paneIds: ['ws-3-p2'],
      tree: { leaf: 0 },
    },
  ],
};

function v2State() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeWorkspaceId: 'ws-1',
    workspaces: [
      {
        id: 'ws-1',
        name: 'web app',
        cwd: '/tmp/project',
        fileDir: '/tmp/project/src',
        activePaneId: 'ws-1-p1',
        panes: [
          { id: 'ws-1-p1', type: 'terminal', cwd: '/tmp/project' },
          { id: 'ws-1-p2', type: 'browser', url: 'http://localhost:3000', zoom: 1, profileId: 'default' },
        ],
        layout: {
          type: 'split',
          direction: 'row',
          children: [{ paneId: 'ws-1-p1' }, { paneId: 'ws-1-p2' }],
        },
      },
    ],
  };
}

test('migration preserves pane ids, names, cwd, fileDir, active pane and topology', () => {
  const state = migrateV1(LEGACY);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.workspaces.length, 3);

  // workspace ids are assigned deterministically and match the pane id prefixes
  assert.deepEqual(state.workspaces.map((w) => w.id), ['ws-1', 'ws-2', 'ws-3']);
  assert.equal(state.activeWorkspaceId, 'ws-2'); // legacy activeIndex 1

  const [a, b, c] = state.workspaces;
  assert.equal(a.name, 'workspace 1');
  assert.equal(a.cwd, '/Users/dev');
  assert.equal(a.fileDir, '/Users/dev');
  assert.deepEqual(a.panes.map((p) => p.id), ['ws-1-p1', 'ws-1-p2']);
  assert.equal(a.activePaneId, 'ws-1-p2'); // legacy activePaneIdx 1

  // split topology preserved: row split with two leaves
  assert.equal(a.layout.type, 'split');
  assert.equal(a.layout.direction, 'row');
  assert.deepEqual(a.layout.children.map((n) => n.paneId), ['ws-1-p1', 'ws-1-p2']);
  assert.equal(b.layout.direction, 'col');

  // single-pane workspace becomes a plain leaf
  assert.deepEqual(c.layout, { paneId: 'ws-3-p2' });
  assert.equal(c.activePaneId, 'ws-3-p2');
});

test('migration output passes validation', () => {
  assert.doesNotThrow(() => validateState(migrateV1(LEGACY)));
});

test('migration survives a damaged legacy tree without losing pane ids', () => {
  const broken = {
    activeIndex: 0,
    workspaces: [{
      name: 'x',
      cwd: '/tmp',
      fileDir: '/tmp',
      activePaneIdx: 0,
      paneIds: ['ws-1-p1', 'ws-1-p2'],
      tree: { type: 'split', dir: 'row', children: [{ leaf: 0 }, { bogus: true }] },
    }],
  };
  const state = migrateV1(broken);
  assert.deepEqual(state.workspaces[0].panes.map((p) => p.id), ['ws-1-p1', 'ws-1-p2']);
  assert.doesNotThrow(() => validateState(state)); // falls back to a flat row
});

test('normalizeState accepts v2 unchanged and migrates legacy', () => {
  const v2 = v2State();
  assert.strictEqual(normalizeState(v2), v2);
  const migrated = normalizeState(LEGACY);
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
});

test('normalizeState refuses unknown explicit schema versions instead of treating them as legacy', () => {
  assert.throws(() => normalizeState({ ...LEGACY, schemaVersion: 99 }), /unsupported schemaVersion/);
});

test('migration refuses to silently drop workspaces beyond the supported bound', () => {
  const oversized = {
    workspaces: new Array(LIMITS.maxWorkspaces + 1).fill(LEGACY.workspaces[0]),
  };
  assert.throws(() => migrateV1(oversized), /too many workspaces/);
});

test('pane ids are globally unique across workspaces', () => {
  const duplicate = v2State();
  duplicate.workspaces.push({
    id: 'ws-2',
    name: 'second',
    cwd: '/tmp',
    fileDir: '/tmp',
    activePaneId: 'ws-1-p1',
    panes: [{ id: 'ws-1-p1', type: 'terminal', cwd: '/tmp' }],
    layout: { paneId: 'ws-1-p1' },
  });
  duplicate.activeWorkspaceId = 'ws-1';
  assert.throws(() => validateState(duplicate), /duplicate pane id/);
});

test('validation rejects unknown schema versions', () => {
  assert.throws(() => validateState({ schemaVersion: 99, workspaces: [] }), ValidationError);
  assert.throws(() => validateState(LEGACY), ValidationError);
});

test('validation rejects duplicate ids and bad references', () => {
  const dupPane = v2State();
  dupPane.workspaces[0].panes[1].id = 'ws-1-p1';
  assert.throws(() => validateState(dupPane), ValidationError);

  const badActive = v2State();
  badActive.activeWorkspaceId = 'ws-999';
  assert.throws(() => validateState(badActive), ValidationError);

  const badPaneRef = v2State();
  badPaneRef.workspaces[0].activePaneId = 'ws-1-p99';
  assert.throws(() => validateState(badPaneRef), ValidationError);

  const badLayoutRef = v2State();
  badLayoutRef.workspaces[0].layout.children[1] = { paneId: 'ws-1-p99' };
  assert.throws(() => validateState(badLayoutRef), ValidationError);
});

test('validation requires the layout to reference every pane exactly once', () => {
  const missing = v2State();
  missing.workspaces[0].layout = { paneId: 'ws-1-p1' };
  assert.throws(() => validateState(missing), ValidationError);

  const duplicated = v2State();
  duplicated.workspaces[0].layout.children[1] = { paneId: 'ws-1-p1' };
  assert.throws(() => validateState(duplicated), ValidationError);
});

test('validation rejects malformed split nodes and accepts bounded resize weights', () => {
  const badDir = v2State();
  badDir.workspaces[0].layout.direction = 'diagonal';
  assert.throws(() => validateState(badDir), ValidationError);

  const oneChild = v2State();
  oneChild.workspaces[0].layout.children = [{ paneId: 'ws-1-p1' }];
  assert.throws(() => validateState(oneChild), ValidationError);

  const weighted = v2State();
  weighted.workspaces[0].layout.weights = [1.4, 0.6];
  assert.doesNotThrow(() => validateState(weighted));

  const badWeights = v2State();
  badWeights.workspaces[0].layout.weights = [1];
  assert.throws(() => validateState(badWeights), /split weights/);
  badWeights.workspaces[0].layout.weights = [0, 1];
  assert.throws(() => validateState(badWeights), /split weights/);
});

test('validation enforces bounds on counts, lengths and zoom', () => {
  const longName = v2State();
  longName.workspaces[0].name = 'x'.repeat(LIMITS.maxNameLength + 1);
  assert.throws(() => validateState(longName), ValidationError);

  const badZoom = v2State();
  badZoom.workspaces[0].panes[1].zoom = 9;
  assert.throws(() => validateState(badZoom), ValidationError);

  const badType = v2State();
  badType.workspaces[0].panes[1].type = 'widget';
  assert.throws(() => validateState(badType), ValidationError);

  const tooMany = v2State();
  tooMany.workspaces = new Array(LIMITS.maxWorkspaces + 1).fill(tooMany.workspaces[0]);
  assert.throws(() => validateState(tooMany), ValidationError);
});

test('validation rejects oversized layouts (depth and node count)', () => {
  let layout = { paneId: 'ws-1-p1' };
  const state = v2State();
  // build a chain deeper than the limit using both panes alternately
  const ids = ['ws-1-p1', 'ws-1-p2'];
  for (let i = 0; i < LIMITS.maxLayoutDepth + 2; i++) {
    layout = {
      type: 'split',
      direction: 'row',
      children: [{ paneId: ids[i % 2] }, layout],
    };
  }
  // first make the pane set match the leaves so only depth is at fault
  state.workspaces[0].panes = [
    { id: 'ws-1-p1', type: 'terminal', cwd: '/tmp' },
    { id: 'ws-1-p2', type: 'terminal', cwd: '/tmp' },
  ];
  state.workspaces[0].layout = layout;
  assert.throws(() => validateState(state), ValidationError);
});

test('mixed pane tabs preserve stable identities and selection', () => {
  const state = v2State();
  const pane = state.workspaces[0].panes[0];
  pane.tabs = [
    { id: pane.id, type: 'terminal', cwd: '/tmp/project' },
    { id: 'browser-tab', type: 'browser', url: 'https://example.com', zoom: 1.1 },
  ];
  pane.activeTabId = pane.id;
  assert.equal(normalizeState(state), state);
});

test('tab validation rejects duplicate identities, invalid selection and nested tabs', () => {
  for (const mutate of [
    (p) => p.tabs.push({ ...p.tabs[0] }),
    (p) => { p.activeTabId = 'missing'; },
    (p) => { p.tabs[0].tabs = []; },
    (p) => { p.tabs[0].id = 'ws-1-p2'; p.activeTabId = 'ws-1-p2'; },
    (p) => { p.tabs[0].type = 'unknown'; },
    (p) => { p.tabs = []; },
    (p) => { p.tabs = Array.from({ length: 33 }, (_, i) => ({ id: `tab-${i}`, type: 'terminal' })); },
    (p) => { p.tabs.push({ id: 'bad-browser', type: 'browser', zoom: 9 }); },
    (p) => { p.type = 'browser'; },
  ]) {
    const state = v2State();
    const pane = state.workspaces[0].panes[0];
    pane.tabs = [{ id: pane.id, type: 'terminal' }];
    pane.activeTabId = pane.id;
    mutate(pane);
    assert.throws(() => validateState(state), ValidationError);
  }
});


test('moved tabs can retain an original pane ID while all session IDs stay unique', () => {
  const state = v2State();
  const [first, second] = state.workspaces[0].panes;
  first.tabs = [{ id: 'replacement-tab', type: 'terminal' }];
  first.activeTabId = 'replacement-tab';
  second.tabs = [
    { id: second.id, type: 'browser', url: 'http://localhost:3000' },
    { id: first.id, type: 'terminal' },
  ];
  second.activeTabId = second.id;
  assert.equal(validateState(state), state);
  first.tabs.push({ id: first.id, type: 'terminal' });
  assert.throws(() => validateState(state), /duplicate tab/);
});
