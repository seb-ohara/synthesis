'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

test('new chats use unique Pi session IDs, while saved chats resume their path', (t) => {
  const starts = [];
  t.mock.method(childProcess, 'spawn', (executable, args) => {
    starts.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter(); child.stdin.writable = true; child.stdin.write = () => true;
    child.kill = () => {};
    return child;
  });
  delete require.cache[require.resolve('../../lib/chat-process')];
  const manager = require('../../lib/chat-process').createChatManager(() => {});
  manager.start('ws-1-p1', '/tmp');
  manager.stop('ws-1-p1');
  manager.start('ws-1-p1', '/tmp');
  manager.start('other', '/tmp', '/tmp/saved-session.jsonl', '/tmp/synthesis-skills');
  assert.match(starts[2][starts[2].indexOf('--append-system-prompt') + 1], /synthesis-skills/);
  const first = starts[0][starts[0].indexOf('--session-id') + 1];
  const second = starts[1][starts[1].indexOf('--session-id') + 1];
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.notEqual(first, second);
  assert.deepEqual(starts[2].slice(-2), ['--session', '/tmp/saved-session.jsonl']);
});

test('stopping chats ignores late exit events and terminates every child', (t) => {
  const children = [], events = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter(); child.stdin.writable = true; child.stdin.write = () => true;
    child.kill = () => { child.killed = true; }; children.push(child); return child;
  });
  delete require.cache[require.resolve('../../lib/chat-process')];
  const manager = require('../../lib/chat-process').createChatManager((id, event) => events.push({ id, event }));
  manager.start('one', '/tmp'); manager.start('two', '/tmp'); manager.stopAll();
  assert(children.every(child => child.killed));
  children.forEach(child => child.emit('close', 0));
  assert.deepEqual(events, []);
});

test('image attachments are forwarded in the Pi prompt command', (t) => {
  const writes = [];
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = new EventEmitter(); child.stdin.writable = true; child.stdin.write = value => { writes.push(value); return true; };
    child.kill = () => {}; return child;
  });
  delete require.cache[require.resolve('../../lib/chat-process')];
  const manager = require('../../lib/chat-process').createChatManager(() => {});
  manager.start('one', '/tmp');
  const prompt = { type: 'prompt', message: 'What is this?', images: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }] };
  assert.equal(manager.command('one', prompt), true);
  assert.deepEqual(JSON.parse(writes.at(-1)), prompt);
});
