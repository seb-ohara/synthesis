'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tabActionForInput } = require('../../lib/tab-shortcuts');
const bindings = { newTab: 'Meta+T', closeTab: 'Meta+W', nextTab: 'Ctrl+Tab', previousTab: 'Ctrl+Shift+Tab' };

test('native browser keyboard input follows configured tab actions', () => {
  assert.equal(tabActionForInput({ type: 'keyDown', key: 't', meta: true }, bindings), 'newTab');
  assert.equal(tabActionForInput({ type: 'keyDown', key: 'w', meta: true }, bindings), 'closeTab');
  assert.equal(tabActionForInput({ type: 'keyDown', key: 'Tab', control: true, shift: true }, bindings), 'previousTab');
  assert.equal(tabActionForInput({ type: 'keyDown', key: 'n', control: true }, { newTab: 'Ctrl+N' }), 'newTab');
  assert.equal(tabActionForInput({ type: 'keyDown', key: ',', meta: true }, { newTab: 'Meta+Comma' }), 'newTab');
});

test('ordinary page input, copy/paste, modified keys and key-up are left alone', () => {
  for (const input of [
    { type: 'keyDown', key: 't' },
    { type: 'keyDown', key: 'c', meta: true },
    { type: 'keyDown', key: 'v', meta: true },
    { type: 'keyDown', key: 't', meta: true, alt: true },
    { type: 'keyUp', key: 't', meta: true },
    { type: 'keyDown', key: 't', meta: true, isAutoRepeat: true },
  ]) assert.equal(tabActionForInput(input, bindings), null);
});
