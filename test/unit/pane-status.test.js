'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { transition, classifyRestore, STATES, BANNERS } = require('../../lib/pane-status');

test('restore classification: live session reconnects', () => {
  const list = { ok: true, sessions: [{ id: 'ws-1-p1', alive: true, cwd: '/tmp' }] };
  assert.equal(classifyRestore(list, 'ws-1-p1'), 'reconnected');
});

test('restore classification: known-but-dead session is ended', () => {
  const list = { ok: true, sessions: [{ id: 'ws-1-p1', alive: false, cwd: null }] };
  assert.equal(classifyRestore(list, 'ws-1-p1'), 'ended');
  assert.equal(classifyRestore({ ok: true, sessions: [] }, 'ws-1-p1'), 'ended');
});

test('restore classification: failed lookup is unavailable', () => {
  assert.equal(classifyRestore({ ok: false, error: 'pty daemon unavailable' }, 'ws-1-p1'), 'unavailable');
  assert.equal(classifyRestore(null, 'ws-1-p1'), 'unavailable');
  assert.equal(classifyRestore({ ok: true }, 'ws-1-p1'), 'unavailable'); // malformed payload
});

test('reconnected exits become ended, never silently live', () => {
  assert.equal(transition('reconnected', 'exit'), 'ended');
});

test('a live pane that exits shows ended', () => {
  assert.equal(transition('pending', 'spawn-fresh'), 'live');
  assert.equal(transition('live', 'exit'), 'ended');
});

test('ended panes reach live only through an explicit fresh shell', () => {
  assert.equal(transition('ended', 'spawn-fresh'), 'live');
  assert.equal(transition('ended', 'exit'), 'ended'); // no change
});

test('unavailable offers retry back through pending', () => {
  assert.equal(transition('unavailable', 'retry'), 'pending');
  assert.equal(transition('pending', 'list-failed'), 'unavailable');
  assert.equal(transition('unavailable', 'list-live'), 'reconnected');
  assert.equal(transition('unavailable', 'list-dead'), 'ended');
});

test('unknown events leave the state unchanged; unknown states reset to pending', () => {
  assert.equal(transition('live', 'nonsense'), 'live');
  assert.equal(transition('bogus', 'exit'), 'pending');
});

test('every state has defined banner copy for the visible labels', () => {
  for (const status of ['ended', 'unavailable']) {
    assert.ok(BANNERS[status], `banner for ${status}`);
    assert.ok(BANNERS[status].label.length > 0);
    assert.ok(BANNERS[status].message.length > 0);
  }
  assert.ok(STATES.includes('pending'));
  assert.equal(BANNERS.reconnected, undefined);
});
