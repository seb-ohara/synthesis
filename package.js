#!/usr/bin/env node
/* ============ Synthesis app packaging ============
 *
 * Builds the installed macOS app bundle with @electron/packager:
 *
 *   node package.js  ->  dist/Synthesis-darwin-arm64/Synthesis.app
 *
 * The bundle keeps the un-asarred `Resources/app` layout of the previous
 * installed build (the detached PTY daemon runs from that directory under the
 * system Node runtime). devDependencies are pruned, so only @xterm, node-pty
 * and the app source ship inside the bundle.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;

/* keep the bundle to app source + runtime dependencies */
const IGNORE = [
  /^\/dist($|\/)/,
  /^\/data($|\/)/,
  /^\/(?:tmp|output|docs)($|\/)/,
  /^\/design-explorations($|\/)/,
  /^\/synthesis-logo-variations($|\/)/,
  /^\/test($|\/)/,
  /^\/scripts($|\/)/,
  /^\/assets\/(?!logo-variations(?:\/Synthesis-icon\.png)?$)/,
  /^\/node_modules\/\.bin($|\/)/,
  /^\/README\.md$/,
  /^\/SYNTHESIS_IMPLEMENTATION_SPEC\.md$/,
  /^\/package\.js$/,
  /^\/package-lock\.json$/,
  /\.tmp\.js$/,
];

(async () => {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  const out = await packager({
    dir: root,
    name: 'Synthesis',
    platform: 'darwin',
    arch: 'arm64',
    icon: path.join(root, 'assets', 'logo-variations', 'Synthesis.icns'),
    out: path.join(root, 'dist'),
    electronVersion,
    ...(process.env.SYNTHESIS_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.SYNTHESIS_ELECTRON_ZIP_DIR } : {}),
    appVersion: pkg.version,
    appBundleId: 'com.seb-ohara.synthesis',
    overwrite: true,
    asar: false,
    prune: true,
    ignore: IGNORE,
  });
  const appDir = path.join(out[0], 'Synthesis.app', 'Contents', 'Resources', 'app');
  pruneToRuntime(path.join(appDir, 'node_modules'));
  const appBundle = path.join(out[0], 'Synthesis.app');
  // custom app icon (packager's icon step can be skipped on newer versions)
  const resources = path.join(appBundle, 'Contents', 'Resources');
  const plist = path.join(appBundle, 'Contents', 'Info.plist');
  fs.copyFileSync(path.join(root, 'assets', 'logo-variations', 'Synthesis.icns'), path.join(resources, 'Synthesis.icns'));
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile Synthesis.icns', plist]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleIconFile string Synthesis.icns', plist]);
  }
  // pruning touches bundle resources, so re-seal with an ad-hoc signature
  // (same format as the previously installed build)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', appBundle], { stdio: 'inherit' });
  console.log('built:', path.relative(root, appBundle));
})().catch((err) => {
  console.error('packaging failed:', err);
  process.exit(1);
});

/* Deterministic bundle contents: keep only the runtime dependency closure of
 * the packages the app actually loads (@xterm for the terminal UI, node-pty
 * for the detached PTY daemon) — dev tooling trees can be hoisted alongside
 * them by npm and are stripped here. */
function pruneToRuntime(nodeModules) {
  const runtimeRoots = Object.keys(pkg.dependencies || {});
  const keep = new Set();
  const queue = [...runtimeRoots];
  while (queue.length) {
    const name = queue.pop();
    if (keep.has(name)) continue;
    keep.add(name);
    const manifest = path.join(nodeModules, name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
      queue.push(dep);
    }
  }
  for (const entry of fs.readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue; // .bin, .package-lock.json, …
    const full = path.join(nodeModules, entry);
    if (entry.startsWith('@')) {
      for (const sub of fs.readdirSync(full)) {
        if (!keep.has(`${entry}/${sub}`)) fs.rmSync(path.join(full, sub), { recursive: true, force: true });
      }
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } else if (!keep.has(entry)) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
  console.log('bundled node_modules:', [...keep].sort().join(', '));
}
