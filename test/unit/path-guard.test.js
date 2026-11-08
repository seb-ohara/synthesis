'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PathGuard, canonicalize, within } = require('../../lib/path-guard');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('paths inside authorized roots are allowed', (t) => {
  const home = makeSandbox(t);
  const guard = new PathGuard({ home });
  const inside = path.join(home, 'projects', 'app');
  fs.mkdirSync(inside, { recursive: true });

  assert.equal(guard.isPathAllowed(home), true);
  assert.equal(guard.isPathAllowed(inside), true);
  assert.equal(guard.resolveAllowed(inside), fs.realpathSync(inside));
});

test('paths outside authorized roots are denied', (t) => {
  const home = makeSandbox(t);
  const elsewhere = makeSandbox(t);
  const guard = new PathGuard({ home });

  assert.equal(guard.isPathAllowed(elsewhere), false);
  assert.equal(guard.resolveAllowed(elsewhere), null);
  assert.equal(guard.isPathAllowed('/etc/passwd'), false);
  assert.equal(guard.isPathAllowed(''), false);
  assert.equal(guard.isPathAllowed(null), false);
});

test('traversal through a symlink cannot bypass the root policy', (t) => {
  const home = makeSandbox(t);
  const outside = makeSandbox(t);
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'nope');

  const link = path.join(home, 'escape');
  fs.symlinkSync(outside, link);

  // the symlink entry itself string-wise lives under the authorized root...
  assert.equal(within(home, link), true);
  // ...but its resolved target does not, so access must be denied
  assert.equal(guardResolve(home, link), false);
  assert.equal(guardResolve(home, path.join(link, 'secret.txt')), false);
});

function guardResolve(home, target) {
  const guard = new PathGuard({ home });
  return guard.isPathAllowed(target);
}

test('extra user-selected roots are honored', (t) => {
  const home = makeSandbox(t);
  const elsewhere = makeSandbox(t);
  const guard = new PathGuard({ home });
  assert.equal(guard.isPathAllowed(elsewhere), false);
  guard.addAllowedRoot(elsewhere);
  assert.equal(guard.isPathAllowed(path.join(elsewhere, 'file.txt')), true);
});

test('not-yet-existing targets are validated through their nearest ancestor', (t) => {
  const home = makeSandbox(t);
  const guard = new PathGuard({ home });
  assert.equal(guard.isPathAllowed(path.join(home, 'does', 'not', 'exist.txt')), true);
  assert.equal(guard.isPathAllowed(path.join(home, '..', 'escape.txt')), false);
});

test('canonicalize rejects hostile input', () => {
  assert.equal(canonicalize(''), null);
  assert.equal(canonicalize(null), null);
  assert.equal(canonicalize('x'.repeat(5000)), null);
  assert.equal(canonicalize('/tmp/a\0b'), null);
});

test('canonicalize resolves symlinks', (t) => {
  const home = makeSandbox(t);
  const real = path.join(home, 'real');
  fs.mkdirSync(real);
  const link = path.join(home, 'link');
  fs.symlinkSync(real, link);
  assert.equal(canonicalize(link), fs.realpathSync(real));
});
