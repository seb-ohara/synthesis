#!/usr/bin/env node
/* ============ node-pty sanity check + self-heal ============
 *
 * node-pty ships darwin prebuilds that can fail at runtime under newer Node
 * versions with "posix_spawnp failed". Since the persistent PTY daemon runs
 * under the system Node runtime, a broken binding means no terminals at all.
 *
 * This script (run on postinstall) performs a real test spawn and, if the
 * prebuilt binding is broken, rebuilds node-pty from source for the current
 * Node ABI.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function spawnWorks() {
  try {
    const pty = require(path.join(root, 'node_modules', 'node-pty'));
    const p = pty.spawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm', cols: 8, rows: 4 });
    try { p.kill(); } catch { /* already gone */ }
    return true;
  } catch {
    return false;
  }
}

if (spawnWorks()) {
  console.log('node-pty: prebuilt binding OK');
  process.exit(0);
}

console.warn('node-pty: prebuilt binding failed to spawn — rebuilding from source…');
const result = spawnSync('npm', ['rebuild', 'node-pty'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, npm_config_build_from_source: 'true' },
});

if (result.status === 0 && spawnWorks()) {
  console.log('node-pty: rebuilt from source OK');
  process.exit(0);
}

console.warn(
  'node-pty: could not build a working binding.\n' +
  '  Terminal panes will not start until this is fixed. Run:\n' +
  '    npm_config_build_from_source=true npm rebuild node-pty\n' +
  '  (requires the Xcode Command Line Tools).',
);
process.exit(0); // never block installation on the warning
