'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPiUpdater, compareVersions } = require('../../lib/pi-updater');

test('compares stable and prerelease Pi versions', () => {
  assert.ok(compareVersions('1.5.2', '1.5.0') > 0);
  assert.ok(compareVersions('2.0.0-beta.2', '2.0.0-beta.11') < 0);
  assert.ok(compareVersions('2.0.0', '2.0.0-rc.1') > 0);
  assert.throws(() => compareVersions('not-a-version', '1.0.0'));
});

test('checks and updates the Pi package at its actual npm prefix', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-update-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prefix = path.join(home, '.local'), pkg = path.join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true }); fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const manifest = path.join(pkg, 'package.json');
  const writeVersion = version => fs.writeFileSync(manifest, JSON.stringify({ name: '@earendil-works/pi-coding-agent', version, bin: { pi: 'dist/cli.js' } }));
  writeVersion('1.5.0'); fs.writeFileSync(path.join(pkg, 'dist/cli.js'), '', { mode: 0o755 });
  fs.symlinkSync(path.join(pkg, 'dist/cli.js'), path.join(prefix, 'bin/pi'));
  fs.writeFileSync(path.join(prefix, 'bin/npm'), '', { mode: 0o755 });
  const calls = [];
  const updater = createPiUpdater({ home, env: { PATH: '' }, execFile: (command, args, _options, cb) => {
    calls.push({ command, args });
    if (args[0] === 'install') { writeVersion('1.5.2'); cb(null, '', ''); }
    else cb(null, '"1.5.2"', '');
  } });
  assert.deepEqual(await updater.check(), { installed: '1.5.0', latest: '1.5.2', available: true });
  assert.deepEqual(await updater.update(), { installed: '1.5.2', latest: '1.5.2', available: false });
  assert.deepEqual(calls[1].args, ['install', '--global', '--prefix', fs.realpathSync(prefix), '@earendil-works/pi-coding-agent@latest']);
  assert.equal(calls[1].command, path.join(prefix, 'bin/npm'));
});

test('does not update an unrecognised Pi installation', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-update-unknown-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.local/bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\n', { mode: 0o755 });
  let invoked = false;
  const updater = createPiUpdater({ home, env: { PATH: '' }, execFile: () => { invoked = true; } });
  await assert.rejects(updater.update(), /not a supported global npm package/);
  assert.equal(invoked, false);
});
