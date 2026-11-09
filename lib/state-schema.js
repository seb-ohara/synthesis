'use strict';
/* ============ Synthesis saved-state schema (v2) ============
 *
 * Pure module (no Electron, no fs) describing the versioned workspace
 * snapshot, its validation rules and the migration path from the legacy
 * unversioned shape:
 *
 *   v1 (legacy): { activeIndex, workspaces: [{ name, cwd, fileDir,
 *                  activePaneIdx, paneIds, tree }] }
 *   v2:          { schemaVersion, activeWorkspaceId,
 *                  workspaces: [{ id, name, cwd, fileDir, activePaneId,
 *                    panes: [{ id, type, activeTabId?, tabs?: [{ id, type, ... }], ... }], layout }] }
 *
 * Layout nodes:  leaf  -> { paneId }
 *                split -> { type: 'split', direction: 'row'|'col', children: [] }
 */

const SCHEMA_VERSION = 2;

/* explicit bounds — snapshots must stay small and finite */
const LIMITS = {
  maxWorkspaces: 64,
  maxPanesPerWorkspace: 32,
  // A restored single pane may contain tabs from up to 32 temporary panes.
  maxTabsPerPane: 1024,
  maxJsonBytes: 1024 * 1024,
  maxNameLength: 120,
  maxPathLength: 4096,
  maxUrlLength: 4096,
  maxLayoutDepth: 24,
  maxLayoutNodes: 256,
};

const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const PANE_TYPES = new Set(['terminal', 'browser', 'chat']);
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/* ---------------- migration ---------------- */

function migrateV1(legacy) {
  if (!isPlainObject(legacy) || !Array.isArray(legacy.workspaces)) {
    throw new ValidationError('legacy state has no workspaces array');
  }
  if (legacy.workspaces.length > LIMITS.maxWorkspaces) {
    throw new ValidationError('legacy state has too many workspaces');
  }
  const workspaces = legacy.workspaces.map((ws, wsIndex) => {
    if (!isPlainObject(ws)) throw new ValidationError(`legacy workspace ${wsIndex} is not an object`);
    const paneIds = Array.isArray(ws.paneIds) ? ws.paneIds : [];
    if (!paneIds.length) throw new ValidationError(`legacy workspace ${wsIndex} has no pane ids`);

    const panes = paneIds.map((id) => {
      if (typeof id !== 'string' || !ID_RE.test(id)) {
        throw new ValidationError(`legacy pane id is invalid in workspace ${wsIndex}`);
      }
      return { id, type: 'terminal', cwd: typeof ws.cwd === 'string' ? ws.cwd : '' };
    });

    const byIndex = (i) => panes[i] || panes[0];
    const convertStrict = (node, depth, counter) => {
      if (depth > LIMITS.maxLayoutDepth || counter.n > LIMITS.maxLayoutNodes) {
        throw new ValidationError('legacy layout is too deep or too large');
      }
      counter.n += 1;
      if (isPlainObject(node) && typeof node.leaf === 'number') {
        return { paneId: byIndex(node.leaf).id };
      }
      if (isPlainObject(node) && node.type === 'split') {
        const children = Array.isArray(node.children) ? node.children : [];
        if (children.length < 2) throw new ValidationError('legacy split is malformed');
        return {
          type: 'split',
          direction: node.dir === 'col' ? 'col' : 'row',
          children: children.map((c) => convertStrict(c, depth + 1, counter)),
        };
      }
      throw new ValidationError('legacy layout node is malformed');
    };
    /* Preserve the legacy split topology when it is well formed and covers
     * every pane exactly once; otherwise fall back to a flat row of panes so
     * a damaged tree can never block boot or invalidate pane identities. */
    let layout = null;
    try {
      const referenced = [];
      const collect = (node) => {
        if (isPlainObject(node) && typeof node.paneId === 'string') referenced.push(node.paneId);
        else if (isPlainObject(node) && node.type === 'split') node.children.forEach(collect);
      };
      const candidate = ws.tree ? convertStrict(ws.tree, 0, { n: 0 }) : { paneId: panes[0].id };
      collect(candidate);
      const uniq = new Set(referenced);
      if (uniq.size === referenced.length && referenced.length === panes.length) layout = candidate;
    } catch { /* fall through to the flat layout */ }
    if (!layout) {
      layout = panes.length === 1
        ? { paneId: panes[0].id }
        : { type: 'split', direction: 'row', children: panes.map((p) => ({ paneId: p.id })) };
    }

    const activeIdx = Number.isInteger(ws.activePaneIdx) ? ws.activePaneIdx : 0;
    return {
      id: ID_RE.test(ws.id || '') ? ws.id : `ws-${wsIndex + 1}`,
      name: typeof ws.name === 'string' && ws.name ? ws.name.slice(0, LIMITS.maxNameLength) : `workspace ${wsIndex + 1}`,
      cwd: typeof ws.cwd === 'string' ? ws.cwd.slice(0, LIMITS.maxPathLength) : '',
      fileDir: typeof ws.fileDir === 'string' ? ws.fileDir.slice(0, LIMITS.maxPathLength) : '',
      activePaneId: byIndex(Math.max(0, Math.min(activeIdx, panes.length - 1))).id,
      panes,
      layout,
    };
  });

  const activeIdx = Number.isInteger(legacy.activeIndex) ? legacy.activeIndex : 0;
  const active = workspaces[Math.max(0, Math.min(activeIdx, workspaces.length - 1))];
  return {
    schemaVersion: SCHEMA_VERSION,
    activeWorkspaceId: active ? active.id : null,
    workspaces,
  };
}

/* ---------------- validation ---------------- */

function collectLayoutPaneIds(layout) {
  const ids = [];
  const walk = (node, depth, counter) => {
    if (depth > LIMITS.maxLayoutDepth || counter.n > LIMITS.maxLayoutNodes) {
      throw new ValidationError('layout is too deep or too large');
    }
    counter.n += 1;
    if (!isPlainObject(node)) throw new ValidationError('layout node is not an object');
    if (typeof node.paneId === 'string') {
      if (!ID_RE.test(node.paneId)) throw new ValidationError('layout paneId is invalid');
      ids.push(node.paneId);
      return;
    }
    if (node.type === 'split') {
      if (node.direction !== 'row' && node.direction !== 'col') {
        throw new ValidationError('split direction must be row or col');
      }
      if (!Array.isArray(node.children) || node.children.length < 2) {
        throw new ValidationError('split must have at least two children');
      }
      if (node.weights !== undefined) {
        if (!Array.isArray(node.weights) || node.weights.length !== node.children.length ||
            node.weights.some((weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1000)) {
          throw new ValidationError('split weights must be positive, bounded, and match its children');
        }
      }
      for (const child of node.children) walk(child, depth + 1, counter);
      return;
    }
    throw new ValidationError('layout node must be a paneId leaf or a split');
  };
  walk(layout, 0, { n: 0 });
  return ids;
}

/* Shared validation for legacy pane metadata and individual tab surfaces. */
function validateSurface(pane) {
  if (!PANE_TYPES.has(pane.type)) throw new ValidationError('pane type is invalid');
  if (pane.type === 'terminal' && pane.cwd !== undefined &&
      (typeof pane.cwd !== 'string' || pane.cwd.length > LIMITS.maxPathLength)) {
    throw new ValidationError('terminal pane cwd is invalid');
  }
  if (pane.type === 'chat' && pane.sessionPath !== undefined && (typeof pane.sessionPath !== 'string' || pane.sessionPath.length > LIMITS.maxPathLength)) throw new ValidationError('chat session path is invalid');
  if (pane.type === 'chat' && pane.chatCwd !== undefined && (typeof pane.chatCwd !== 'string' || pane.chatCwd.length > LIMITS.maxPathLength)) throw new ValidationError('chat folder is invalid');
  if (pane.type === 'chat' && pane.projectId !== undefined && (typeof pane.projectId !== 'string' || !ID_RE.test(pane.projectId))) throw new ValidationError('chat project id is invalid');
  if (pane.type === 'browser') {
    if (pane.url !== undefined && (typeof pane.url !== 'string' || pane.url.length > LIMITS.maxUrlLength)) {
      throw new ValidationError('browser pane url is invalid');
    }
    if (pane.zoom !== undefined && (typeof pane.zoom !== 'number' || pane.zoom < ZOOM_MIN || pane.zoom > ZOOM_MAX)) {
      throw new ValidationError('browser pane zoom is invalid');
    }
    if (pane.profileId !== undefined &&
        (typeof pane.profileId !== 'string' || !ID_RE.test(pane.profileId))) {
      throw new ValidationError('browser pane profileId is invalid');
    }
    if (pane.hasTerminal !== undefined && typeof pane.hasTerminal !== 'boolean') {
      throw new ValidationError('browser pane hasTerminal flag is invalid');
    }
  }
}

/** Validate a v2 snapshot, including optional per-pane tabs. */
function validateState(state) {
  if (!isPlainObject(state)) throw new ValidationError('state is not an object');
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new ValidationError(`unsupported schemaVersion: ${state.schemaVersion}`);
  }
  if (!Array.isArray(state.workspaces)) throw new ValidationError('workspaces is not an array');
  if (state.workspaces.length > LIMITS.maxWorkspaces) {
    throw new ValidationError('too many workspaces');
  }
  if (state.workspaces.length === 0) {
    if (state.activeWorkspaceId !== null) {
      throw new ValidationError('activeWorkspaceId must be null without workspaces');
    }
    return state;
  }

  const allTabIds = new Set(state.workspaces.flatMap((ws) => Array.isArray(ws?.panes) ? ws.panes.filter((p) => p && p.tabs === undefined).map((p) => p.id) : []));
  const workspaceIds = new Set();
  const allPaneIds = new Set();
  for (const ws of state.workspaces) {
    if (!isPlainObject(ws)) throw new ValidationError('workspace is not an object');
    if (typeof ws.id !== 'string' || !ID_RE.test(ws.id)) throw new ValidationError('workspace id is invalid');
    if (workspaceIds.has(ws.id)) throw new ValidationError('duplicate workspace id');
    workspaceIds.add(ws.id);
    if (!isString(ws.name, LIMITS.maxNameLength)) throw new ValidationError('workspace name is invalid');
    if (typeof ws.cwd !== 'string' || ws.cwd.length > LIMITS.maxPathLength) {
      throw new ValidationError('workspace cwd is invalid');
    }
    if (typeof ws.fileDir !== 'string' || ws.fileDir.length > LIMITS.maxPathLength) {
      throw new ValidationError('workspace fileDir is invalid');
    }
    if (!Array.isArray(ws.panes) || ws.panes.length === 0) {
      throw new ValidationError('workspace has no panes');
    }
    if (ws.panes.length > LIMITS.maxPanesPerWorkspace) {
      throw new ValidationError('workspace has too many panes');
    }

    const paneIds = new Set();
    for (const pane of ws.panes) {
      if (!isPlainObject(pane)) throw new ValidationError('pane is not an object');
      if (typeof pane.id !== 'string' || !ID_RE.test(pane.id)) throw new ValidationError('pane id is invalid');
      if (paneIds.has(pane.id) || allPaneIds.has(pane.id)) {
        throw new ValidationError('duplicate pane id');
      }
      paneIds.add(pane.id);
      allPaneIds.add(pane.id);
      validateSurface(pane);
      if (pane.tabs !== undefined) {
        if (!Array.isArray(pane.tabs) || !pane.tabs.length || pane.tabs.length > LIMITS.maxTabsPerPane) {
          throw new ValidationError('pane tabs must be a nonempty bounded array');
        }
        const tabIds = new Set();
        for (const tab of pane.tabs) {
          if (!isPlainObject(tab) || typeof tab.id !== 'string' || !ID_RE.test(tab.id)) {
            throw new ValidationError('tab id is invalid');
          }
          if (tabIds.has(tab.id) || allTabIds.has(tab.id)) {
            throw new ValidationError('duplicate tab id');
          }
          if (tab.tabs !== undefined) throw new ValidationError('tabs cannot be nested');
          tabIds.add(tab.id);
          allTabIds.add(tab.id);
          validateSurface(tab);
        }
        if (!tabIds.has(pane.activeTabId)) throw new ValidationError('activeTabId does not reference a tab');
        if (pane.tabs.find((tab) => tab.id === pane.activeTabId).type !== pane.type) {
          throw new ValidationError('pane type must match the active tab');
        }
      } else if (pane.activeTabId !== undefined) {
        throw new ValidationError('activeTabId requires tabs');
      }
    }

    const layoutIds = collectLayoutPaneIds(ws.layout);
    const layoutSet = new Set(layoutIds);
    if (layoutSet.size !== layoutIds.length || layoutIds.length !== ws.panes.length) {
      throw new ValidationError('layout must reference every pane exactly once');
    }
    for (const id of layoutIds) {
      if (!paneIds.has(id)) throw new ValidationError('layout references unknown pane');
    }
    if (typeof ws.activePaneId !== 'string' || !paneIds.has(ws.activePaneId)) {
      throw new ValidationError('activePaneId does not reference a pane');
    }
  }

  if (!workspaceIds.has(state.activeWorkspaceId)) {
    throw new ValidationError('activeWorkspaceId does not reference a workspace');
  }
  return state;
}

/**
 * Accept either a v2 snapshot or the legacy shape and always return a
 * validated v2 snapshot. Throws ValidationError when the input is unusable.
 */
function normalizeState(raw) {
  if (!isPlainObject(raw)) throw new ValidationError('state is not an object');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
    throw new ValidationError(`unsupported schemaVersion: ${raw.schemaVersion}`);
  }
  const state = raw.schemaVersion === SCHEMA_VERSION ? raw : migrateV1(raw);
  return validateState(state);
}

module.exports = {
  SCHEMA_VERSION,
  LIMITS,
  ID_RE,
  PANE_TYPES,
  ZOOM_MIN,
  ZOOM_MAX,
  ValidationError,
  migrateV1,
  validateState,
  normalizeState,
};
