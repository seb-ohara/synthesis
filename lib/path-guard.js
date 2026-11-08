'use strict';
/* ============ Synthesis filesystem path guard ============
 *
 * Renderer-supplied paths are untrusted. Every list/read/reveal/open
 * operation must pass isPathAllowed() before the main process touches the
 * filesystem. Paths are canonicalized (symlinks resolved) so a symlink
 * inside an authorized root cannot be used to reach outside it.
 *
 * Authorized roots:
 *   - the user's home directory,
 *   - workspace roots (working directories of workspaces),
 *   - paths the user explicitly chose through a native picker.
 *
 * Pure filesystem module (no Electron) so it is unit-testable.
 */

const fs = require('fs');
const path = require('path');

const MAX_PATH_LENGTH = 4096;

/**
 * Resolve a path to its real location. For paths that do not exist yet the
 * nearest existing ancestor is resolved and the remainder re-appended, so
 * callers can validate the destination of a write/reveal safely.
 */
function canonicalize(target) {
  if (typeof target !== 'string' || !target || target.length > MAX_PATH_LENGTH) return null;
  if (target.includes('\0')) return null;
  const resolved = path.resolve(target);
  let current = resolved;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class PathGuard {
  constructor({ home, extraRoots = [] } = {}) {
    this.home = home ? canonicalize(home) : null;
    this.extraRoots = new Set();
    for (const root of extraRoots) this.addAllowedRoot(root);
  }

  /** Register a user-selected or workspace root. */
  addAllowedRoot(root) {
    const real = canonicalize(root);
    if (real) this.extraRoots.add(real);
    return real;
  }

  roots() {
    return [this.home, ...this.extraRoots].filter(Boolean);
  }

  /**
   * True when `target` resolves inside an authorized root. The canonical
   * (symlink-resolved) location is what gets checked, so traversal through
   * a symlink out of the roots is denied.
   */
  isPathAllowed(target) {
    const real = canonicalize(target);
    if (!real) return false;
    return this.roots().some((root) => within(root, real));
  }

  /** Canonical target when allowed, otherwise null. */
  resolveAllowed(target) {
    if (!this.isPathAllowed(target)) return null;
    return canonicalize(target);
  }
}

module.exports = { PathGuard, canonicalize, within, MAX_PATH_LENGTH };
