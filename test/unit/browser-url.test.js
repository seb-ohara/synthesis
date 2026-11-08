'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeBrowserUrl, classifyNavigationTarget } = require('../../lib/browser-url');

test('http and https URLs pass through', () => {
  assert.deepEqual(normalizeBrowserUrl('https://example.com/path'), {
    ok: true, url: 'https://example.com/path',
  });
  assert.equal(normalizeBrowserUrl('http://localhost:3000').ok, true);
});

test('missing schemes are normalized safely', () => {
  assert.equal(normalizeBrowserUrl('example.com').url, 'https://example.com/');
  assert.equal(normalizeBrowserUrl('localhost:3000').url, 'http://localhost:3000/');
  assert.equal(normalizeBrowserUrl('127.0.0.1:8080/status').url, 'http://127.0.0.1:8080/status');
  assert.equal(normalizeBrowserUrl('[::1]:5173').url, 'http://[::1]:5173/');
});

test('javascript, file, data and other schemes are blocked', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    'devtools://x',
    'chrome://settings',
  ]) {
    const res = normalizeBrowserUrl(bad);
    assert.equal(res.ok, false, `${bad} must be refused`);
  }
});

test('mailto and tel are not in-pane URLs', () => {
  const res = normalizeBrowserUrl('mailto:a@b.com');
  assert.equal(res.ok, false);
  assert.match(res.error, /system handler/);
});

test('empty and oversized input is refused', () => {
  assert.equal(normalizeBrowserUrl('').ok, false);
  assert.equal(normalizeBrowserUrl('   ').ok, false);
  assert.equal(normalizeBrowserUrl('a'.repeat(5000)).ok, false);
  assert.equal(normalizeBrowserUrl('not a url at all').ok, false);
});

test('navigation targets: http(s) in-pane, mailto/tel external, everything else denied', () => {
  assert.equal(classifyNavigationTarget('https://example.com/x'), 'in-pane');
  assert.equal(classifyNavigationTarget('http://127.0.0.1:3000/'), 'in-pane');
  assert.equal(classifyNavigationTarget('mailto:x@y.z'), 'external');
  assert.equal(classifyNavigationTarget('tel:+123'), 'external');
  assert.equal(classifyNavigationTarget('javascript:alert(1)'), 'deny');
  assert.equal(classifyNavigationTarget('file:///etc/passwd'), 'deny');
  assert.equal(classifyNavigationTarget('not a url'), 'deny');
});
