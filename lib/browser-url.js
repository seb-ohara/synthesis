'use strict';
/* ============ Synthesis browser URL policy (pure) ============
 *
 * Shared by the main-process browser manager and unit tests.
 * Only http and https targets are ever loaded in-pane:
 *   - missing schemes are normalized safely (http for localhost/loopback,
 *     https otherwise),
 *   - javascript:, file:, data: and other schemes are refused.
 */

const BLOCKED_SCHEMES = new Set(['javascript', 'file', 'data', 'blob', 'about', 'chrome', 'devtools']);
const EXTERNAL_SCHEMES = new Set(['mailto', 'tel']); // opened in the OS handler, never in-pane
const KNOWN_SCHEMES = new Set(['http', 'https', ...BLOCKED_SCHEMES, ...EXTERNAL_SCHEMES]);

/**
 * Returns the scheme when the input clearly names one, or null for bare
 * hosts (including host:port forms like localhost:3000).
 */
function splitScheme(input) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (KNOWN_SCHEMES.has(scheme)) return scheme;
  // e.g. localhost:3000 or example.com:8080 — a port, not a scheme
  if (/^\d/.test(input.slice(m[0].length))) return null;
  return scheme;
}

function isLoopbackHost(hostPart) {
  return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(hostPart);
}

/**
 * Normalize user input into a safe in-pane URL.
 * Returns { ok: true, url } or { ok: false, error }.
 */
function normalizeBrowserUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'Enter a URL' };
  if (input.length > 4096) return { ok: false, error: 'URL is too long' };
  if (input.includes('\0') || /\s/.test(input.replace(/^\s+|\s+$/g, ''))) {
    return { ok: false, error: 'URL contains invalid characters' };
  }

  let candidate = input;
  const scheme = splitScheme(input);
  if (scheme) {
    if (BLOCKED_SCHEMES.has(scheme)) return { ok: false, error: `Blocked URL scheme “${scheme}:”` };
    if (EXTERNAL_SCHEMES.has(scheme)) return { ok: false, error: `“${scheme}:” links open in the system handler` };
    if (scheme !== 'http' && scheme !== 'https') {
      return { ok: false, error: `Unsupported URL scheme “${scheme}:”` };
    }
  } else {
    candidate = (isLoopbackHost(input) ? 'http://' : 'https://') + input;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'That does not look like a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https pages can be opened in a pane' };
  }
  if (!url.hostname) return { ok: false, error: 'URL has no host' };
  return { ok: true, url: url.toString() };
}

/**
 * Policy for navigation targets reached from inside a page (links, window
 * open). Returns 'in-pane' | 'external' | 'deny'.
 */
function classifyNavigationTarget(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return 'deny'; }
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'in-pane';
  if (EXTERNAL_SCHEMES.has(url.protocol.replace(':', ''))) return 'external';
  return 'deny';
}

module.exports = { normalizeBrowserUrl, classifyNavigationTarget, BLOCKED_SCHEMES, EXTERNAL_SCHEMES };
