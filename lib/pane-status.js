'use strict';
/* ============ Synthesis terminal pane status ============
 *
 * Pure state machine for terminal restore states:
 *
 *   pending      — checking daemon session status (initial only)
 *   reconnected  — the same PTY is still alive; attached to it
 *   ended        — the old PTY ended; saved output + explicit new shell
 *   unavailable  — daemon/session lookup failed; offer retry
 *   live         — a shell started in this pane (fresh or first run)
 *
 * Events:
 *   list-live      daemon reports a live session for this pane id
 *   list-dead      daemon reachable, no live session for this pane id
 *   list-failed    daemon/session lookup failed
 *   spawn-fresh    a new shell process was started in this pane
 *   exit           the pane's PTY process ended
 *   retry          the user asked to re-check daemon status
 */

const STATES = ['pending', 'reconnected', 'ended', 'unavailable', 'live'];

const TRANSITIONS = {
  pending: {
    'list-live': 'reconnected',
    'list-dead': 'ended',
    'list-failed': 'unavailable',
    'spawn-fresh': 'live',
  },
  reconnected: {
    exit: 'ended',
    'spawn-fresh': 'live',
    'list-failed': 'unavailable',
  },
  ended: {
    'spawn-fresh': 'live',
    retry: 'pending',
    'list-live': 'reconnected',
    'list-dead': 'ended',
    'list-failed': 'unavailable',
  },
  unavailable: {
    retry: 'pending',
    'list-live': 'reconnected',
    'list-dead': 'ended',
    'list-failed': 'unavailable',
    'spawn-fresh': 'live',
  },
  live: {
    exit: 'ended',
    'spawn-fresh': 'live',
    'list-live': 'reconnected',
    'list-dead': 'ended',
    'list-failed': 'unavailable',
  },
};

function transition(status, event) {
  const table = TRANSITIONS[status];
  if (!table) return 'pending';
  return table[event] !== undefined ? table[event] : status;
}

/**
 * Classify a daemon `list` result for one pane id.
 * Returns one of 'reconnected' | 'ended' | 'unavailable'.
 */
function classifyRestore(listResult, paneId) {
  if (!listResult || listResult.ok !== true || !Array.isArray(listResult.sessions)) {
    return 'unavailable';
  }
  const entry = listResult.sessions.find((s) => s && s.id === paneId);
  return entry && entry.alive ? 'reconnected' : 'ended';
}

/** Human-facing copy for each status banner. */
const BANNERS = {
  ended: {
    label: 'Ended',
    message: 'Previous session ended. Saved output can be viewed; a new shell starts only when you ask.',
    tone: 'warn',
  },
  unavailable: {
    label: 'Unavailable',
    message: 'Session status unavailable — the terminal daemon could not be reached.',
    tone: 'error',
  },
};

const PaneStatus = { STATES, TRANSITIONS, transition, classifyRestore, BANNERS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PaneStatus;
} else {
  window.PaneStatus = PaneStatus;
}
