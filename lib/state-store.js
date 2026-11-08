'use strict';
/* ============ Synthesis saved-state store ============
 *
 * Durable, validated snapshot persistence:
 *   - atomic writes (temp file + fsync + rename) so a failed save always
 *     leaves the prior snapshot intact,
 *   - a last-known-good backup (`workspaces.json.bak`) that is only ever
 *     written from a validated state, so corrupt/truncated input can never
 *     destroy it,
 *   - load falls back to the backup when the main file is unusable.
 *
 * Filesystem-only module (no Electron) so it is unit-testable against
 * temporary directories.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SCHEMA_VERSION,
  LIMITS,
  ValidationError,
  normalizeState,
} = require('./state-schema');

function backupPath(file) { return `${file}.bak`; }

function readAndNormalize(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new ValidationError('state path is not a file');
  if (stat.size > LIMITS.maxJsonBytes) throw new ValidationError('state file exceeds the size limit');
  const text = fs.readFileSync(file, 'utf8');
  // Check the bytes actually read as well in case the file changed after stat.
  if (Buffer.byteLength(text) > LIMITS.maxJsonBytes) {
    throw new ValidationError('state file exceeds the size limit');
  }
  const raw = JSON.parse(text);
  return { raw, state: normalizeState(raw) };
}

function atomicReplace(file, serialized) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    // Persist the directory entry where supported. The data file is already
    // committed if the platform does not allow syncing directories.
    try {
      const dirFd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync is not supported on every platform */ }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* noop */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/**
 * Load the snapshot for `file`.
 * Returns { state, source: 'main'|'backup', migrated, error } — `state` is
 * null only when neither the main file nor the backup is usable. Never
 * writes anything.
 */
function load(file) {
  const attempt = (target, source) => {
    try {
      const { raw, state } = readAndNormalize(target);
      const migrated = raw.schemaVersion === undefined;
      return { state, source, migrated, error: null };
    } catch (err) {
      return { state: null, source, migrated: false, error: err };
    }
  };

  let result = attempt(file, 'main');
  if (!result.state && fs.existsSync(backupPath(file))) {
    const fallback = attempt(backupPath(file), 'backup');
    if (fallback.state) return fallback;
    result.error = result.error || fallback.error;
  }
  return result;
}

/**
 * Persist `state` atomically. The state is validated before anything is
 * written; on success the same validated content is mirrored to the backup.
 * Returns { ok, error }.
 */
function save(file, state) {
  let serialized;
  try {
    normalizeState(state); // throws on anything invalid
    serialized = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(serialized) > LIMITS.maxJsonBytes) {
      throw new ValidationError('state exceeds the size limit');
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicReplace(file, serialized); // a failed write leaves the old snapshot intact
    try {
      atomicReplace(backupPath(file), serialized);
    } catch { /* backup trouble is non-fatal; the main snapshot is intact */ }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  SCHEMA_VERSION,
  LIMITS,
  ValidationError,
  backupPath,
  load,
  save,
  normalizeState,
};
