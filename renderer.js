/* ============ Synthesis renderer ============ */
/* global Terminal, FitAddon */

const $ = (sel) => document.querySelector(sel);
const FILES_VIEW_STORAGE_KEY = 'synthesis.files.viewMode';
const MAX_PANE_TABS = 1024;

const els = {
  app: $('#app'),
  list: $('#workspace-list'),
  termHost: $('#term-host'),
  title: $('#titlebar-title'),
  statusWs: $('#status-ws'),
  statusCwd: $('#status-cwd'),
  statusShell: $('#status-shell'),
  statusPts: $('#status-pts'),
  wsCount: $('#ws-count'),
  crumb: $('#files-crumb'),
  filesBody: $('#files-body'),
  filesMeta: $('#files-meta'),
  filesFilter: $('#files-filter'),
  filesHidden: $('#files-hidden'),
  filesViewBtn: $('#files-view-btn'),
  modalWrap: $('#modal-backdrop'),
  modalName: $('#modal-name'),
  modalDir: $('#modal-dir'),
};

const state = {
  home: '',
  workspaces: [],
  activeId: null,
  wsSeq: 0,
  fileDir: null,
  preview: null,
  fileFilter: '',
  showHidden: localStorage.getItem('mux.ui.showHidden') === '1',
  // Tree view is the default so browsing stays scoped to the workspace root.
  filesView: localStorage.getItem(FILES_VIEW_STORAGE_KEY) === 'list' ? 'list' : 'tree',
  previewWrap: localStorage.getItem('mux.ui.previewWrap') === '1',
};

/* lazy tree model — expanded directories and their loaded children */
const treeState = {
  root: null,
  expanded: new Set(),
  children: new Map(), // dir path -> entries array
  loading: new Set(),
  errors: new Map(), // dir path -> last load error
  generation: 0,
};

const PREVIEW_FALLBACK_LIMITS = { maxBytes: 2 * 1024 * 1024, maxLines: 3000 };
let previewLimits = PREVIEW_FALLBACK_LIMITS;

let savedHistoryText = '';
let historyRequestSeq = 0;

/* terminal session status registry (see lib/pane-status.js) */
let daemonSessionsPromise = null;
function getDaemonSessions(force) {
  if (force) daemonSessionsPromise = null;
  if (!daemonSessionsPromise) daemonSessionsPromise = window.mux.pty.list();
  return daemonSessionsPromise;
}

const TERM_THEME = {
  background: '#101011',
  foreground: '#d9d9dc',
  cursor: '#ff7a1a',
  cursorAccent: '#0b0b0c',
  selectionBackground: '#2b2b2f',
  black: '#0b0b0c',
  red: '#c9705e',
  green: '#82a472',
  yellow: '#c2a25c',
  blue: '#718fb5',
  magenta: '#a381ac',
  cyan: '#72a39b',
  white: '#d9d9dc',
  brightBlack: '#5c5c62',
  brightRed: '#d98876',
  brightGreen: '#96b886',
  brightYellow: '#d4b872',
  brightBlue: '#89a5c9',
  brightMagenta: '#b595bf',
  brightCyan: '#88b7ae',
  brightWhite: '#f2f2f4',
};

const DEFAULT_SHORTCUTS = {
  settings: 'Meta+Comma',
  newSession: 'Meta+Shift+T',
  closeSession: 'Meta+Shift+W',
  newTab: 'Meta+T',
  closeTab: 'Meta+W',
  nextTab: 'Ctrl+Tab',
  previousTab: 'Ctrl+Shift+Tab',
  openFiles: 'Meta+O',
  splitRight: 'Meta+D',
  splitDown: 'Meta+Shift+D',
  browserRight: 'Meta+B',
  browserDown: 'Meta+Shift+B',
  clearTerminal: 'Meta+Shift+R',
  nextWorkspace: 'Meta+Alt+ArrowRight',
  previousWorkspace: 'Meta+Alt+ArrowLeft',
  nextPane: 'Meta+Alt+P',
};
const SYNTHESIS_ACCENT = '#b8eaff';
const SYNTHESIS_GRADIENT = 'linear-gradient(110deg, #d9cbff 0%, #b8eaff 54%, #c4ffe1 100%)';
// Only the pane outline is softened; the accent preset and fills stay full strength.
const SYNTHESIS_BORDER_GRADIENT = 'linear-gradient(110deg, #d9cbff86 0%, #b8eaff86 54%, #c4ffe186 100%)';
function accentColor() { return appSettings.accentColor === 'synthesis' ? SYNTHESIS_ACCENT : appSettings.accentColor; }

const DEFAULT_SETTINGS = {
  accentColor: '#ff7a1a',
  chatBackground: '#141416',
  sidebarColor: '#101011',
  bubbleColor: '#29383b',
  chatText: '#e9e9eb',
  chatFont: '',
  chatFontSize: 14,
  fontSize: 12,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 20000,
  confirmClose: true,
  shortcuts: DEFAULT_SHORTCUTS,
};
const KEYBINDING_ACTIONS = [
  { id: 'settings', label: 'Open settings' },
  { id: 'newTab', label: 'New tab in this pane' },
  { id: 'closeTab', label: 'Close current tab' },
  { id: 'nextTab', label: 'Next tab' },
  { id: 'previousTab', label: 'Previous tab' },
  { id: 'newSession', label: 'New project' },
  { id: 'closeSession', label: 'Close project' },
  { id: 'openFiles', label: 'Toggle Git panel' },
  { id: 'splitRight', label: 'Split pane right' },
  { id: 'splitDown', label: 'Split pane down' },
  { id: 'browserRight', label: 'Open browser split right' },
  { id: 'browserDown', label: 'Open browser split down' },
  { id: 'clearTerminal', label: 'Clear terminal' },
  { id: 'nextWorkspace', label: 'Next project' },
  { id: 'previousWorkspace', label: 'Previous project' },
  { id: 'nextPane', label: 'Focus next pane' },
];
const KEY_MODIFIERS = ['Meta', 'Ctrl', 'Alt', 'Shift'];
const FONT_SIZES = [11, 12, 13, 14, 16, 18];
const SCROLLBACK_SIZES = [2000, 5000, 10000, 20000, 50000, 100000];
const CURSOR_STYLES = ['bar', 'block', 'underline'];
const SETTINGS_STORAGE_KEY = 'synthesis.settings';
let appSettings = loadSettings();
let recordingShortcutFor = null;

function normalizeKeyName(key) {
  if (key === ' ') return 'Space';
  if (key === ',') return 'Comma';
  if (key === '.') return 'Period';
  if (key === '+') return 'Plus';
  if (key === '-') return 'Minus';
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function normalizeShortcut(shortcut) {
  if (typeof shortcut !== 'string') return '';
  const parts = shortcut.split('+').filter(Boolean);
  const rawKey = parts.pop();
  if (!rawKey) return '';
  const key = normalizeKeyName(rawKey);
  const mods = new Set(parts.map((part) => part === 'Control' ? 'Ctrl' : part));
  if (!mods.has('Meta') && !mods.has('Ctrl')) return '';
  if ([...mods].some((mod) => !KEY_MODIFIERS.includes(mod))) return '';
  return KEY_MODIFIERS.filter((mod) => mods.has(mod)).concat(key).join('+');
}

function loadSettings() {
  let saved = {};
  try {
    let serialized = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const legacyKeys = Object.keys(localStorage).filter((key) =>
      key !== SETTINGS_STORAGE_KEY && key.endsWith('.settings'));
    if (!serialized && legacyKeys.length) serialized = localStorage.getItem(legacyKeys[0]);
    saved = JSON.parse(serialized || '{}') || {};
    if (serialized && !localStorage.getItem(SETTINGS_STORAGE_KEY)) {
      localStorage.setItem(SETTINGS_STORAGE_KEY, serialized);
    }
    legacyKeys.forEach((key) => localStorage.removeItem(key));
  } catch { /* use defaults */ }
  // Move the old workspace defaults to Shift so familiar tab keys act on tabs.
  if (!saved.shortcuts?.newTab && saved.shortcuts) {
    if (saved.shortcuts.newSession === 'Meta+T') saved.shortcuts.newSession = 'Meta+Shift+T';
    if (saved.shortcuts.closeSession === 'Meta+W') saved.shortcuts.closeSession = 'Meta+Shift+W';
  }
  const shortcuts = { ...DEFAULT_SHORTCUTS };
  for (const [id, value] of Object.entries(saved.shortcuts || {})) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SHORTCUTS, id)) {
      const normalized = normalizeShortcut(value);
      if (normalized) shortcuts[id] = normalized;
    }
  }
  const accentColor = saved.accentColor === 'synthesis' || /^#[0-9a-f]{6}$/i.test(saved.accentColor || '')
    ? saved.accentColor : DEFAULT_SETTINGS.accentColor;
  const fontSize = FONT_SIZES.includes(Number(saved.fontSize)) ? Number(saved.fontSize) : DEFAULT_SETTINGS.fontSize;
  const scrollback = SCROLLBACK_SIZES.includes(Number(saved.scrollback))
    ? Number(saved.scrollback) : DEFAULT_SETTINGS.scrollback;
  return {
    ...DEFAULT_SETTINGS,
    accentColor,
    ...Object.fromEntries(['chatBackground', 'sidebarColor', 'bubbleColor', 'chatText'].map(key => [key, /^#[0-9a-f]{6}$/i.test(saved[key] || '') ? saved[key] : DEFAULT_SETTINGS[key]])),
    fontSize,
    chatFont: typeof saved.chatFont === 'string' && saved.chatFont.length < 300 ? saved.chatFont : '',
    chatFontSize: [12, 13, 14, 15, 16, 18, 20, 22, 24].includes(Number(saved.chatFontSize)) ? Number(saved.chatFontSize) : 14,
    cursorStyle: CURSOR_STYLES.includes(saved.cursorStyle) ? saved.cursorStyle : DEFAULT_SETTINGS.cursorStyle,
    cursorBlink: typeof saved.cursorBlink === 'boolean' ? saved.cursorBlink : DEFAULT_SETTINGS.cursorBlink,
    scrollback,
    confirmClose: typeof saved.confirmClose === 'boolean' ? saved.confirmClose : DEFAULT_SETTINGS.confirmClose,
    shortcuts,
  };
}

function formatShortcut(shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return 'Not set';
  const labels = {
    Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Comma: ',', Period: '.', Plus: '+', Minus: '−', Space: 'Space',
  };
  return normalized.split('+').map((part) => labels[part] || part).join('');
}

function persistSettings() {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings)); }
  catch { /* settings remain in memory for this session */ }
}

function darkenHex(hex, factor = 0.68) {
  const value = hex.slice(1);
  const channels = [0, 2, 4].map((i) => Math.round(parseInt(value.slice(i, i + 2), 16) * factor));
  return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

function updateShortcutTooltips() {
  const setTip = (selector, label, action) => {
    const element = $(selector);
    if (element) element.dataset.tip = `${label} (${formatShortcut(appSettings.shortcuts[action])})`;
  };
  setTip('#settings-btn', 'Settings', 'settings');
  setTip('#add-btn', 'New workspace/session', 'newSession');
  setTip('#fs-pick', 'Open file or folder picker', 'openFiles');
  updateFilesToggle();
  const paneTips = {
    splitRight: () => `Split right (${formatShortcut(appSettings.shortcuts.splitRight)})`,
    splitDown: () => `Split down (${formatShortcut(appSettings.shortcuts.splitDown)})`,
    clearTerminal: () => `Clear terminal (${formatShortcut(appSettings.shortcuts.clearTerminal)})`,
    browserRight: () => `Open browser split right (${formatShortcut(appSettings.shortcuts.browserRight)})`,
    browserDown: () => `Open browser split down (${formatShortcut(appSettings.shortcuts.browserDown)})`,
    toggleSurface: () => 'Open browser in this pane',
  };
  document.querySelectorAll('.pane-btn[data-action]').forEach((button) => {
    const tip = paneTips[button.dataset.action];
    if (tip) button.dataset.tip = tip(button);
  });
}

function applySettings() {
  window.mux.app.setTabShortcuts(Object.fromEntries(['newTab', 'closeTab', 'nextTab', 'previousTab'].map((action) => [action, normalizeShortcut(appSettings.shortcuts[action])])));
  for (const [key, variable] of Object.entries({ chatBackground: '--chat-background', sidebarColor: '--sidebar-background', bubbleColor: '--chat-bubble', chatText: '--chat-text' })) document.documentElement.style.setProperty(variable, appSettings[key]);
  const fontFamily = appSettings.chatFont.startsWith('import:') ? 'Synthesis imported ' + appSettings.chatFont.slice(7) : appSettings.chatFont;
  document.documentElement.style.setProperty('--chat-font', fontFamily ? JSON.stringify(fontFamily) + ', sans-serif' : 'var(--sans)');
  document.documentElement.style.setProperty('--chat-font-size', appSettings.chatFontSize + 'px');
  document.documentElement.style.setProperty('--thinking-gradient', appSettings.accentColor === 'synthesis' ? SYNTHESIS_GRADIENT : `linear-gradient(90deg, ${accentColor()}, ${accentColor()})`);
  document.documentElement.style.setProperty('--accent', accentColor());
  document.documentElement.style.setProperty('--accent-dim', darkenHex(accentColor()));
  document.documentElement.style.setProperty('--accent-fill', appSettings.accentColor === 'synthesis' ? SYNTHESIS_GRADIENT : accentColor());
  document.documentElement.style.setProperty('--accent-border', appSettings.accentColor === 'synthesis' ? SYNTHESIS_BORDER_GRADIENT : `linear-gradient(${accentColor()}, ${accentColor()})`);
  for (const ws of state.workspaces) {
    for (const pane of workspaceTabs(ws)) {
      if (!pane.term) continue;
      pane.term.options.fontSize = appSettings.fontSize;
      pane.term.options.cursorStyle = appSettings.cursorStyle;
      pane.term.options.cursorBlink = appSettings.cursorBlink;
      pane.term.options.scrollback = appSettings.scrollback;
      pane.term.options.theme = { ...TERM_THEME, cursor: accentColor() };
      fitSafely(pane);
    }
  }
  updateShortcutTooltips();
}

function updateAppSettings(patch) {
  appSettings = { ...appSettings, ...patch, shortcuts: { ...appSettings.shortcuts, ...(patch.shortcuts || {}) } };
  persistSettings();
  applySettings();
  renderSettings();
}

/* ---------------- helpers ---------------- */

function shortPath(p) {
  const home = state.home || '';
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' K';
  return (bytes / (1024 * 1024)).toFixed(1) + ' M';
}

function activeWs() {
  return state.workspaces.find((w) => w.id === state.activeId) || null;
}

function fitSafely(pane) {
  if (!pane.fit || !pane.body || !pane.body.getClientRects().length) return;
  try { pane.fit.fit(); } catch { /* tile not measurable */ }
}

/* ---------------- tooltips ---------------- */

const tipEl = document.createElement('div');
tipEl.id = 'tooltip';
document.body.appendChild(tipEl);
let tipTimer = null;
let tipTarget = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipTarget = null;
  tipEl.classList.remove('visible');
}

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  tipEl.textContent = text;
  tipEl.classList.add('visible');
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  let y = r.bottom + 8;
  if (y + th > window.innerHeight - 8) y = r.top - th - 8;
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest && e.target.closest('[data-tip]');
  if (target === tipTarget) return;
  hideTip();
  if (target) {
    tipTarget = target;
    tipTimer = setTimeout(() => showTip(target), 350);
  }
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest && e.target.closest('[data-tip]')) hideTip();
});
document.addEventListener('mousedown', hideTip);
window.addEventListener('scroll', hideTip, true);

/* ---------------- context menu ---------------- */

function cleanTerminalHistory(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

async function openSavedHistory(ws, pane) {
  const token = ++historyRequestSeq;
  const backdrop = $('#history-backdrop');
  const subtitle = $('#history-subtitle');
  const content = $('#history-content');
  const meta = $('#history-meta');
  savedHistoryText = '';
  subtitle.textContent = `${ws.name} · ${pane.id}`;
  content.textContent = 'Loading saved terminal output…';
  meta.textContent = 'Reading persisted session history';
  backdrop.classList.remove('hidden');
  requestBrowserSync();
  $('#history-close').focus();

  try {
    const result = await window.mux.pty.history(surfaceId(pane));
    if (token !== historyRequestSeq) return;
    if (!result || !result.ok) throw new Error(result && result.error || 'History could not be read');
    savedHistoryText = cleanTerminalHistory(result.text);
    content.textContent = savedHistoryText || 'No saved output is available for this pane yet.';
    const lineCount = savedHistoryText ? savedHistoryText.split('\n').length : 0;
    meta.textContent = `${result.truncated ? 'Showing the most recent saved output · ' : ''}${fmtSize(result.bytes || 0)} · ${lineCount.toLocaleString()} lines`;
    requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
  } catch (error) {
    if (token !== historyRequestSeq) return;
    content.textContent = `Could not load saved history: ${error.message || error}`;
    meta.textContent = '';
  }
}

function closeSavedHistory() {
  historyRequestSeq += 1;
  $('#history-backdrop').classList.add('hidden');
  requestBrowserSync();
}

const menuEl = document.createElement('div');
menuEl.id = 'ctx-menu';
document.body.appendChild(menuEl);

function hideMenu() {
  menuEl.classList.remove('visible');
  requestBrowserSync();
}

function showMenu(x, y, items) {
  hideTip();
  menuEl.innerHTML = '';
  for (const it of items) {
    if (it === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menuEl.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    const label = document.createElement('span');
    label.textContent = it.label;
    btn.appendChild(label);
    if (it.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = it.hint;
      btn.appendChild(hint);
    }
    if (!it.disabled) {
      btn.addEventListener('click', () => {
        hideMenu();
        it.action();
      });
    }
    menuEl.appendChild(btn);
  }
  menuEl.classList.add('visible');
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
  menuEl.querySelector('.ctx-item:not(.disabled)')?.focus({ preventScroll: true });
  requestBrowserSync();
}

document.addEventListener('click', (e) => {
  if (!menuEl.contains(e.target)) hideMenu();
});
document.addEventListener('contextmenu', (e) => {
  if (!menuEl.contains(e.target)) hideMenu();
}, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('resize', hideMenu);

/* ---------------- split tree (tiling) ---------------- */
// leaf: { type:'leaf', pane }   ·   split: { type:'split', dir:'row'|'col', children:[...] }

function findLeaf(root, pane) {
  if (root.type === 'leaf') {
    return root.pane === pane ? { node: root, parent: null, index: -1 } : null;
  }
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.type === 'leaf') {
      if (c.pane === pane) return { node: c, parent: root, index: i };
    } else {
      const found = findLeaf(c, pane);
      if (found) return found;
    }
  }
  return null;
}

function collapseSplits(node) {
  if (node.type !== 'split') return node;
  node.children = node.children.map(collapseSplits);
  return node.children.length === 1 ? node.children[0] : node;
}

function ensureSplitWeights(node) {
  if (!Array.isArray(node.weights) || node.weights.length !== node.children.length ||
      node.weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    node.weights = node.children.map(() => 1);
  }
}

function applySplitWeights(node, splitEl) {
  ensureSplitWeights(node);
  const childEls = [...splitEl.children].filter((child) => !child.classList.contains('split-divider'));
  childEls.forEach((child, index) => {
    child.style.flex = `${node.weights[index]} 1 0px`;
  });
}

function resizeSplitBoundary(node, splitEl, boundary, delta) {
  ensureSplitWeights(node);
  const isRow = node.dir === 'row';
  const bounds = splitEl.getBoundingClientRect();
  const fullSize = isRow ? bounds.width : bounds.height;
  const dividerSize = 8;
  const usableSize = fullSize - dividerSize * Math.max(0, node.children.length - 1);
  if (usableSize <= 0) return;

  const pairWeight = node.weights[boundary] + node.weights[boundary + 1];
  const pairSize = usableSize * pairWeight / node.weights.reduce((sum, value) => sum + value, 0);
  const firstSize = pairSize * node.weights[boundary] / pairWeight;
  const minSize = Math.min(96, pairSize / 2);
  const nextFirstSize = Math.max(minSize, Math.min(pairSize - minSize, firstSize + delta));
  node.weights[boundary] = pairWeight * nextFirstSize / pairSize;
  node.weights[boundary + 1] = pairWeight - node.weights[boundary];
  applySplitWeights(node, splitEl);
}

function createSplitDivider(node, splitEl, boundary, ws) {
  const divider = document.createElement('div');
  const isRow = node.dir === 'row';
  divider.className = `split-divider ${isRow ? 'split-divider-row' : 'split-divider-col'}`;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Resize panes');
  divider.setAttribute('aria-orientation', isRow ? 'vertical' : 'horizontal');
  divider.tabIndex = 0;

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.focus();
    const resizeClass = isRow ? 'split-resizing-row' : 'split-resizing-col';
    document.body.classList.add(resizeClass);
    let previous = isRow ? event.clientX : event.clientY;
    const onMove = (moveEvent) => {
      const current = isRow ? moveEvent.clientX : moveEvent.clientY;
      resizeSplitBoundary(node, splitEl, boundary, current - previous);
      previous = current;
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      document.body.classList.remove(resizeClass);
      saveWorkspaces();
      requestAnimationFrame(() => {
        fitWorkspace(ws);
        syncBrowserBounds();
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  });
  divider.addEventListener('keydown', (event) => {
    const negative = isRow ? 'ArrowLeft' : 'ArrowUp';
    const positive = isRow ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== negative && event.key !== positive) return;
    event.preventDefault();
    resizeSplitBoundary(node, splitEl, boundary, event.key === positive ? 16 : -16);
    saveWorkspaces();
    requestAnimationFrame(() => {
      fitWorkspace(ws);
      syncBrowserBounds();
    });
  });
  return divider;
}

function renderNode(node, ws) {
  if (node.type === 'leaf') return node.pane.tile;
  const el = document.createElement('div');
  el.className = 'split ' + (node.dir === 'row' ? 'split-row' : 'split-col');
  ensureSplitWeights(node);
  node.children.forEach((child, index) => {
    const childEl = renderNode(child, ws);
    childEl.style.flex = `${node.weights[index]} 1 0px`;
    el.appendChild(childEl);
    if (index < node.children.length - 1) {
      el.appendChild(createSplitDivider(node, el, index, ws));
    }
  });
  return el;
}

function refreshView(ws) {
  ws.view.innerHTML = '';
  ws.view.className = 'ws-view' + (ws.id === state.activeId ? ' active' : '');
  const root = renderNode(ws.tree, ws);
  // A former split child may still carry its fractional flex weight.
  root.style.removeProperty('flex');
  ws.view.appendChild(root);
  const pane = ws.panes[ws.activePaneIdx];
  ws.panes.forEach((p) => {
    p.tile.classList.toggle('active', p === pane);
    const close = p.tile.querySelector('.pane-close');
    if (close) close.disabled = ws.panes.length <= 1;
  });
}

// Split layouts are a temporary way to arrange surfaces, not part of a chat.
// Keep the live tabs (including running agents) while returning to one pane.
function flattenWorkspacePanes(ws, target) {
  if (!target || !ws.panes.includes(target) || ws.panes.length <= 1) return;
  for (const pane of [...ws.panes]) {
    if (pane === target) continue;
    for (const tab of pane.tabs) {
      if (tab.syncObserver) { tab.syncObserver.unobserve(pane.tile); tab.syncObserver.observe(target.tile); }
      tab.owner = target; tab.tile = target.tile; target.tabs.push(tab); target.tile.appendChild(tab.body);
      tab.body.classList.toggle('tab-hidden', tab !== target.activeTab);
    }
    pane.tabs = []; pane.layoutObserver?.disconnect(); pane.tile.remove();
  }
  ws.panes = [target]; ws.activePaneIdx = 0; ws.tree = { type: 'leaf', pane: target };
  updatePaneSurfaceChrome(target); renderPaneTabs(target); refreshView(ws); syncBrowserBounds();
}

function fitWorkspace(ws) {
  for (const p of ws.panes) {
    if (document.body.contains(p.tile)) fitSafely(p);
  }
}

function afterLayout(ws, focusPane) {
  requestAnimationFrame(() => {
    fitWorkspace(ws);
    renderChrome();
    renderList();
    syncBrowserBounds();
    const p = focusPane || ws.panes[ws.activePaneIdx];
    if (p && ws.id === state.activeId) focusPaneSurface(p);
  });
}

function focusPaneSurface(pane) {
  if (!pane) return;
  if (pane.type === 'terminal' && pane.term) pane.term.focus();
  else if (pane.type === 'browser' && pane.urlInput) pane.urlInput.focus();
  else if (pane.type === 'chat') { pane.activeTab?.startChat?.(); pane.startChat?.(); pane.body.querySelector('textarea')?.focus(); }
}

function splitPane(ws, pane, dir, type = 'chat') {
  if (ws.closingPane) return;
  const found = findLeaf(ws.tree, pane);
  if (!found) return;
  const newPane = createPane(ws, { type });
  const replacement = {
    type: 'split',
    dir,
    children: [found.node, { type: 'leaf', pane: newPane }],
    weights: [1, 1],
  };
  if (found.parent) found.parent.children[found.index] = replacement;
  else ws.tree = replacement;
  ws.activePaneIdx = ws.panes.indexOf(newPane);
  refreshView(ws);
  afterLayout(ws, newPane);
  saveWorkspaces();
}

function disposeTab(tab) {
  tab.disposed = true;
  hidePaneBanner(tab);
  tab.unsubs.forEach((u) => u());
  (tab.browserUnsubs || []).forEach((u) => u());
  if (tab.syncObserver) tab.syncObserver.disconnect();
  if (tab.type === 'browser') window.mux.browser.dispose(tab.id);
  if (tab.type === 'chat') window.mux.chat.stop(tab.id);
  if (tab.term) { window.mux.pty.kill(tab.id); tab.term.dispose(); }
  if (tab.browserToolbar) tab.browserToolbar.remove();
  tab.body.remove();
}

function disposePane(pane) {
  if (pane.layoutObserver) pane.layoutObserver.disconnect();
  pane.tabs.forEach(disposeTab);
}

async function closePane(ws, pane) {
  if (ws.closingPane || ws.panes.length <= 1 || !ws.panes.includes(pane)) return;
  const isBrowser = pane.type === 'browser';
  const title = pane.title || (isBrowser ? 'browser' : 'terminal');
  const warning = 'All tabs in this pane will be closed and their terminal processes stopped.';
  if (appSettings.confirmClose && !window.confirm(`Close pane “${title}”? ${warning}`)) return;
  ws.closingPane = pane;
  pane.tile.classList.add('pane-closing');
  // Collapse the actual layout rather than scaling a screenshot. Neighboring
  // terminals and native browser surfaces resize together throughout the exit.
  if (ws.id === state.activeId && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const divider = pane.tile.nextElementSibling?.classList.contains('split-divider')
      ? pane.tile.nextElementSibling : pane.tile.previousElementSibling;
    const options = { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'forwards' };
    const animations = [pane.tile.animate([
      { flexGrow: getComputedStyle(pane.tile).flexGrow, opacity: 1 },
      { flexGrow: 0, opacity: 0 },
    ], options)];
    if (divider?.classList.contains('split-divider')) {
      animations.push(divider.animate([{ flexBasis: '8px', opacity: 1 }, { flexBasis: '0px', opacity: 0 }], options));
    }
    syncBrowserBounds();
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    animations.forEach((animation) => animation.cancel());
  }
  // The workspace can be closed by a keyboard command during the animation.
  ws.closingPane = null;
  if (!state.workspaces.includes(ws) || !ws.panes.includes(pane)) return;
  const activePane = ws.panes[ws.activePaneIdx];
  const found = findLeaf(ws.tree, pane);
  if (found && found.parent) {
    found.parent.children.splice(found.index, 1);
    if (Array.isArray(found.parent.weights)) found.parent.weights.splice(found.index, 1);
    ws.tree = collapseSplits(ws.tree);
  } else if (found && !found.parent) {
    const other = ws.panes.find((p) => p !== pane);
    ws.tree = { type: 'leaf', pane: other };
  }

  disposePane(pane);
  ws.panes.splice(ws.panes.indexOf(pane), 1);
  scheduleStatusUpdate(ws);

  const idx = activePane !== pane ? ws.panes.indexOf(activePane) : Math.min(ws.activePaneIdx, ws.panes.length - 1);
  ws.activePaneIdx = Math.max(0, idx);
  refreshView(ws);
  afterLayout(ws);
  saveWorkspaces();
}

/* ---------------- panes ---------------- */

function setPaneTitle(pane, text) {
  pane = pane.activeTab || pane;
  if (pane.disposed) return;
  pane.title = text;
  if (pane.owner) renderPaneTabs(pane.owner);
}

function updatePaneSurfaceChrome(pane) {
  const isBrowser = pane.type === 'browser';
  pane.tile.dataset.paneType = pane.type;
  if (pane.surfaceBtn) {
    pane.surfaceBtn.dataset.tip = 'Open browser in this pane';
    pane.surfaceBtn.setAttribute('aria-label', pane.surfaceBtn.dataset.tip);
  }
  updateShortcutTooltips();
}

function buildPaneActions(ws, pane) {
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.dataset.tip = 'Close pane';
  closeBtn.setAttribute('aria-label', 'Close pane');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePane(ws, pane);
  });

  const actions = document.createElement('div');
  actions.className = 'pane-actions';
  const mkBtn = (action, tip, svg, onClick) => {
    const b = document.createElement('button');
    b.className = 'pane-btn';
    if (action) b.dataset.action = action;
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    b.innerHTML = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" ' +
      'stroke-width="1.2" stroke-linejoin="round">' + svg + '</svg>';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      hideTip();
    });
    actions.appendChild(b);
    return b;
  };
  mkBtn('splitRight', 'Split right',
    '<rect x="1.5" y="2.5" width="4.75" height="9" rx="1"/><rect x="7.75" y="2.5" width="4.75" height="9" rx="1"/>',
    () => splitPane(ws, pane, 'row'));
  mkBtn('splitDown', 'Split down',
    '<rect x="1.5" y="2.5" width="11" height="3.9" rx="1"/><rect x="1.5" y="7.6" width="11" height="3.9" rx="1"/>',
    () => splitPane(ws, pane, 'col'));
  pane.surfaceBtn = mkBtn('toggleSurface', 'Open browser in this pane',
    '<circle cx="7" cy="7" r="5.2"/><path d="M1.8 7h10.4M7 1.8c1.7 1.7 2.4 3.4 2.4 5.2S8.7 10.5 7 12.2C5.3 10.5 4.6 8.8 4.6 7S5.3 3.5 7 1.8z"/>',
    () => togglePaneBrowser(ws, pane));
  // pane options menu — splitting, closing, copy/paste, etc.
  const optsBtn = document.createElement('button');
  optsBtn.className = 'pane-btn pane-btn-more';
  optsBtn.dataset.tip = 'Pane options';
  optsBtn.setAttribute('aria-label', 'Pane options');
  optsBtn.textContent = '⋯';
  optsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTip();
    const r = optsBtn.getBoundingClientRect();
    showMenu(r.left - 180, r.bottom + 4, paneMenu(ws, pane));
  });
  actions.appendChild(optsBtn);

  actions.appendChild(closeBtn);
  return actions;
}

/* ---------------- pane status banners ---------------- */
/* Ended or unavailable sessions show recovery actions. Live sessions
 * reconnect without an extra banner. */

function hidePaneBanner(pane) {
  if (pane.bannerTimer) { clearTimeout(pane.bannerTimer); pane.bannerTimer = null; }
  if (pane.bannerEl) pane.bannerEl.remove();
  pane.bannerEl = null;
}

function showPaneBanner(ws, pane, status) {
  if (!pane.bannerEl) {
    pane.bannerEl = document.createElement('div');
    pane.bannerEl.className = 'pane-banner';
    pane.tile.insertBefore(pane.bannerEl, pane.body);
  }
  const el = pane.bannerEl;
  const spec = status === 'pending'
    ? { label: 'Checking', message: 'Checking terminal session status…', tone: 'muted' }
    : (window.PaneStatus.BANNERS[status] || null);
  if (!spec) return;
  el.className = `pane-banner tone-${spec.tone}`;
  el.replaceChildren();

  const labelEl = document.createElement('span');
  labelEl.className = 'banner-label';
  labelEl.textContent = spec.label;
  const msg = document.createElement('span');
  msg.className = 'banner-msg';
  msg.textContent = spec.message;
  el.append(labelEl, msg);

  const actions = document.createElement('div');
  actions.className = 'banner-actions';
  const mkAction = (text, fn, cls = 'banner-btn') => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };
  if (status === 'ended') {
    actions.append(
      mkAction('View Saved Output', () => openSavedHistory(ws, pane)),
      mkAction('Start New Shell', () => startShell(ws, pane, { replay: false })),
    );
  } else if (status === 'unavailable') {
    actions.append(mkAction('Retry', () => retryPaneStatus(ws, pane)));
  }
  el.append(actions);
  el.append(mkAction('✕', () => hidePaneBanner(pane), 'banner-dismiss'));

  fitSafely(pane); // the banner shrinks the terminal grid
}

function setPaneStatus(ws, pane, status) {
  pane = pane.activeTab || pane;
  if (pane.disposed) return;
  pane.status = status;
  if (pane.owner && pane.owner.activeTab !== pane) { hidePaneBanner(pane); return; }
  if (pane.type === 'browser') {
    hidePaneBanner(pane);
    return;
  }
  if (status === 'live' || status === 'reconnected' || status === 'reconnected-done') {
    hidePaneBanner(pane);
    requestAnimationFrame(() => fitSafely(pane));
    return;
  }
  showPaneBanner(ws, pane, status);
}

/* ---------------- terminal panes ---------------- */

function startShell(ws, pane, { replay = true, attach = false } = {}) {
  pane = pane.activeTab || pane;
  if (pane.disposed || !pane.term) return;
  pane.exited = false;
  const spawnCwd = ws.cwd;
  window.mux.pty.spawn({ id: pane.id, cols: pane.term.cols, rows: pane.term.rows, cwd: spawnCwd, replay })
    .then((res) => {
      if (pane.disposed) return;
      if (res && res.ok) {
        pane.pid = res.pid;
        if (!pane.terminalOscTitle) {
          pane.terminalTitle = `${els.statusShell.textContent || 'shell'} · ${shortPath(res.cwd || spawnCwd)}`;
          if (pane.type === 'terminal') setPaneTitle(pane, pane.terminalTitle);
        }
        // Keep the internal restore status for exit handling.
        setPaneStatus(ws, pane, attach ? 'reconnected' : window.PaneStatus.transition(pane.status, 'spawn-fresh'));
      } else {
        pane.exited = true;
        pane.term.write(`\x1b[31mfailed to start pty: ${res && res.error}\x1b[0m\r\n`);
        setPaneStatus(ws, pane, 'unavailable');
      }
      scheduleStatusUpdate(ws);
      renderChrome();
    })
    .catch((error) => {
      if (pane.disposed) return;
      pane.exited = true;
      pane.term.write(`\x1b[31mfailed to start pty: ${error && error.message ? error.message : error}\x1b[0m\r\n`);
      setPaneStatus(ws, pane, 'unavailable');
      scheduleStatusUpdate(ws);
      renderChrome();
    });
}

async function restoreTerminalPane(ws, pane) {
  setPaneStatus(ws, pane, 'pending');
  const list = await getDaemonSessions();
  const status = window.PaneStatus.classifyRestore(list, pane.id);
  setPaneStatus(ws, pane, status);
  if (status === 'reconnected') startShell(ws, pane, { attach: true });
  // Ended: saved output stays behind “View Saved Output”; a new shell is an
  // explicit user action so old log text can never be mistaken for live output.
}

async function retryPaneStatus(ws, pane) {
  setPaneStatus(ws, pane, 'pending');
  const list = await getDaemonSessions(true);
  const status = window.PaneStatus.classifyRestore(list, pane.id);
  setPaneStatus(ws, pane, status);
  if (status === 'reconnected') startShell(ws, pane, { attach: true });
}

function initTerminalPane(ws, pane) {
  const body = pane.body;
  if (!pane.terminalSurface) {
    pane.terminalSurface = document.createElement('div');
    pane.terminalSurface.className = 'terminal-surface';
    body.appendChild(pane.terminalSurface);
  }
  pane.terminalSurface.style.display = 'block';
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
    fontSize: appSettings.fontSize,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: appSettings.cursorBlink,
    cursorStyle: appSettings.cursorStyle,
    scrollback: appSettings.scrollback,
    macOptionIsMeta: true,
    theme: { ...TERM_THEME, cursor: accentColor() },
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane.terminalSurface);
  pane.term = term;
  pane.fit = fit;

  term.onTitleChange((t) => {
    if (t && t.trim()) {
      pane.terminalOscTitle = true;
      pane.terminalTitle = t.trim();
      if (pane.type === 'terminal') {
        pane.oscTitle = true;
        setPaneTitle(pane, t.trim());
      }
    }
  });

  // listeners first — data can arrive immediately after spawn
  pane.unsubs.push(window.mux.pty.onData(pane.id, (data) => {
    term.write(data);
    if (pane.isWorking) {
      pane.lastActivityAt = Date.now();
      scheduleStatusUpdate(ws);
    }
  }));
  pane.unsubs.push(window.mux.pty.onExit(pane.id, ({ code }) => {
    pane.exited = true;
    pane.isWorking = false;
    term.write(`\r\n\x1b[90m── session ended (code ${code}) ──\x1b[0m\r\n`);
    setPaneStatus(ws, pane, window.PaneStatus.transition(pane.status, 'exit'));
    scheduleStatusUpdate(ws);
  }));
  term.onData((d) => sendPaneInput(ws, pane, d));
  // Keep the PTY in sync with the rendered grid — this is what fills the pane.
  term.onResize(({ cols, rows }) => window.mux.pty.resize(pane.id, cols, rows));

  let dragDepth = 0;
  const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  const onDragEnter = (event) => {
    if (pane.owner.activeTab !== pane || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    pane.tile.classList.add('file-drop-target');
  };
  const onDragOver = (event) => {
    if (pane.owner.activeTab !== pane || !isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event) => {
    if (pane.owner.activeTab !== pane || !isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) pane.tile.classList.remove('file-drop-target');
  };
  const onDrop = (event) => {
    if (pane.owner.activeTab !== pane || !isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    pane.tile.classList.remove('file-drop-target');
    const files = Array.from(event.dataTransfer.files || []);
    const paths = files
      .map((file) => window.mux.app.getDroppedFilePath(file))
      .filter((filePath) => typeof filePath === 'string' && filePath.length > 0);
    if (paths.length && pane.term && pane.type === 'terminal') {
      pane.term.paste(paths.map(shellQuote).join(' '));
      pane.term.focus();
    }
  };
  pane.body.addEventListener('dragenter', onDragEnter);
  pane.body.addEventListener('dragover', onDragOver);
  pane.body.addEventListener('dragleave', onDragLeave);
  pane.body.addEventListener('drop', onDrop);
  pane.unsubs.push(() => {
    pane.body.removeEventListener('dragenter', onDragEnter);
    pane.body.removeEventListener('dragover', onDragOver);
    pane.body.removeEventListener('dragleave', onDragLeave);
    pane.body.removeEventListener('drop', onDrop);
    pane.tile.classList.remove('file-drop-target');
  });

  requestAnimationFrame(() => {
    fitSafely(pane);
    if (pane.disposed) return;
    if (pane.restore) restoreTerminalPane(ws, pane);
    else startShell(ws, pane);
  });
}

/* ---------------- browser panes ---------------- */

function safeHost(url) {
  try { return new URL(url).host || 'browser'; } catch { return url ? 'browser' : 'browser'; }
}

function browserInputTarget(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const isWebAddress = /^https?:\/\//i.test(value)
    || /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)
    || /^(?:[\w-]+\.)+[\w-]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)
    || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/.test(value)
    || /^[a-z][a-z0-9+.-]*:/i.test(value);
  return isWebAddress ? value : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function updateBrowserChrome(ws, pane, s) {
  if (!pane.urlInput) return;
  const nextUrl = s.url || pane.currentUrl || '';
  const urlChanged = nextUrl !== pane.currentUrl;
  pane.currentUrl = nextUrl;
  if (urlChanged) saveWorkspaces();
  if (!pane.oscTitle) setPaneTitle(pane, s.title || (pane.currentUrl ? safeHost(pane.currentUrl) : 'New tab'));
  if (document.activeElement !== pane.urlInput) pane.urlInput.value = s.url || '';
  pane.loading = Boolean(s.loading);
  if (pane.reloadBtn) {
    pane.reloadBtn.textContent = s.loading ? '✕' : '↻';
    pane.reloadBtn.dataset.tip = s.loading ? 'Stop loading' : 'Reload';
  }
  if (pane.backBtn) pane.backBtn.disabled = !s.canGoBack;
  if (pane.forwardBtn) pane.forwardBtn.disabled = !s.canGoForward;
  if (pane.errorBox) {
    if (s.error) {
      pane.hasError = true;
      pane.errorBox.classList.remove('hidden');
      pane.errorBox.replaceChildren();
      const text = document.createElement('div');
      text.className = 'browser-error-msg';
      text.textContent = `Could not load page — ${s.error}`;
      const retry = document.createElement('button');
      retry.className = 'ghost-btn';
      retry.textContent = 'Retry';
      retry.addEventListener('click', (e) => {
        e.stopPropagation();
        pane.hasError = false;
        pane.errorBox.classList.add('hidden');
        window.mux.browser.navigate(pane.id, pane.urlInput.value || pane.currentUrl);
        requestBrowserSync();
      });
      pane.errorBox.append(text, retry);
    } else {
      pane.hasError = false;
      pane.errorBox.classList.add('hidden');
    }
    requestBrowserSync();
  }
}

function initBrowserPane(ws, pane, opts) {
  pane.zoom = typeof opts.zoom === 'number' ? Math.min(3, Math.max(0.5, opts.zoom)) : 1;
  pane.currentUrl = opts.url || '';
  pane.hasError = false;
  pane.loading = false;
  const surface = document.createElement('div');
  surface.className = 'browser-body';
  pane.browserSurface = surface;
  pane.body.appendChild(surface);

  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';
  pane.browserToolbar = toolbar;
  const mkNavBtn = (text, tip) => {
    const b = document.createElement('button');
    b.className = 'browser-btn';
    b.textContent = text;
    b.dataset.tip = tip;
    toolbar.appendChild(b);
    return b;
  };
  pane.backBtn = mkNavBtn('←', 'Back');
  pane.backBtn.disabled = true;
  pane.forwardBtn = mkNavBtn('→', 'Forward');
  pane.forwardBtn.disabled = true;
  pane.reloadBtn = mkNavBtn('↻', 'Reload');

  const urlInput = document.createElement('input');
  urlInput.className = 'browser-url mono';
  urlInput.type = 'text';
  urlInput.spellcheck = false;
  urlInput.placeholder = 'Search or enter a URL';
  urlInput.value = pane.currentUrl;
  urlInput.dataset.tip = 'Search the web or enter an http(s) address';
  pane.urlInput = urlInput;
  toolbar.appendChild(urlInput);

  const extBtn = mkNavBtn('↗', 'Open in default browser');
  extBtn.addEventListener('click', () => window.mux.browser.openExternal(surfaceId(pane)));

  const viewport = document.createElement('div');
  viewport.className = 'browser-viewport';
  const errorBox = document.createElement('div');
  errorBox.className = 'browser-error hidden';
  viewport.appendChild(errorBox);
  surface.append(toolbar, viewport);
  pane.viewport = viewport;
  pane.errorBox = errorBox;

  pane.backBtn.addEventListener('click', () => window.mux.browser.back(pane.id));
  pane.forwardBtn.addEventListener('click', () => window.mux.browser.forward(pane.id));
  pane.reloadBtn.addEventListener('click', () => {
    if (pane.loading) window.mux.browser.stop(pane.id);
    else window.mux.browser.reload(pane.id);
  });
  const submitUrl = () => {
    const raw = urlInput.value.trim();
    if (!raw) return;
    const target = browserInputTarget(raw);
    pane.browserReady.then((created) => {
      if (pane.disposed) return null;
      return created?.ok ? window.mux.browser.navigate(pane.id, target) : created;
    }).then((res) => {
      if (res && res.ok) {
        urlInput.value = res.url;
        requestBrowserSync();
      } else if (res && res.error) {
        pane.hasError = true;
        updateBrowserChrome(ws, pane, {
          id: pane.id, url: target, title: '', loading: false,
          canGoBack: false, canGoForward: false, error: res.error,
        });
      }
    });
  };
  urlInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') submitUrl();
    if (e.key === 'Escape') { urlInput.value = pane.currentUrl || ''; urlInput.blur(); }
  });

  pane.browserUnsubs = [window.mux.browser.onState(pane.id, (s) => updateBrowserChrome(ws, pane, s))];
  // Register the native view immediately, so a quick address submission
  // cannot race a later animation frame that creates the browser.
  pane.browserReady = window.mux.browser.create({ id: pane.id, url: pane.currentUrl, zoomFactor: pane.zoom });
  pane.browserReady.then(() => { if (!pane.disposed) requestBrowserSync(); });
  requestAnimationFrame(() => {
    if (pane.disposed || pane.type !== 'browser' || pane.browserSurface !== surface || !pane.tile.isConnected) return;
    if (pane.currentUrl) setPaneTitle(pane, safeHost(pane.currentUrl));
    syncBrowserBounds();
    if (ws.id === state.activeId && ws.panes[ws.activePaneIdx] === pane.owner && pane.owner.activeTab === pane) urlInput.focus();
  });

  pane.syncObserver = new ResizeObserver(() => requestBrowserSync());
  pane.syncObserver.observe(pane.tile);
  pane.syncObserver.observe(pane.body);
  pane.syncObserver.observe(surface);
  pane.syncObserver.observe(toolbar);
  pane.syncObserver.observe(viewport);
}

function togglePaneBrowser(ws, pane) {
  const existing = pane.type === 'browser' ? pane.activeTab : pane.tabs.find((tab) => tab.type === 'browser');
  if (existing) activateTab(ws, pane, existing);
  else addPaneTab(ws, pane, { type: 'browser' });
}

function syncBrowserBounds() {
  const active = activeWs();
  const overlayOpen = ['#settings-backdrop', '#history-backdrop', '#modal-backdrop']
    .some((sel) => { const el = $(sel); return el && !el.classList.contains('hidden'); })
    || menuEl.classList.contains('visible') || !projectFilterPanel.hidden || !$('#git-panel').hidden;
  for (const ws of state.workspaces) {
    for (const pane of workspaceTabs(ws)) {
      if (pane.type !== 'browser' || !pane.viewport) continue;
      const viewportRect = pane.viewport.getBoundingClientRect();
      const bodyRect = pane.body.getBoundingClientRect();
      const tileRect = pane.tile.getBoundingClientRect();
      const toolbarRect = pane.browserToolbar.getBoundingClientRect();
      // WebContentsView is a native sibling above Chromium's DOM and does not
      // inherit CSS overflow clipping. Explicitly intersect its bounds with
      // the browser viewport, pane body, pane tile, and window; also keep its
      // top edge below both Synthesis toolbars.
      const left = Math.max(viewportRect.left, bodyRect.left, tileRect.left, 0);
      const top = Math.max(viewportRect.top, bodyRect.top, toolbarRect.bottom, tileRect.top, 0);
      const right = Math.min(viewportRect.right, bodyRect.right, tileRect.right, window.innerWidth);
      const bottom = Math.min(viewportRect.bottom, bodyRect.bottom, tileRect.bottom, window.innerHeight);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      const visible = ws === active && pane.owner.activeTab === pane && !overlayOpen && !draggedTab && !pane.hasError && !pane.owner.tile.classList.contains('pane-closing');
      const onscreen = visible && width > 0 && height > 0;
      window.mux.browser.setBounds({
        id: pane.id,
        x: left,
        y: top,
        width,
        height,
        visible: onscreen,
      });
    }
  }
}

function requestBrowserSync() {
  if (requestBrowserSync.queued) return;
  requestBrowserSync.queued = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    requestBrowserSync.queued = false;
    syncBrowserBounds();
  }));
}

window.addEventListener('resize', requestBrowserSync, { passive: true });
window.addEventListener('scroll', requestBrowserSync, { passive: true, capture: true });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', requestBrowserSync, { passive: true });
  window.visualViewport.addEventListener('scroll', requestBrowserSync, { passive: true });
}
let browserGeometryTimer = null;
window.mux.app.onWindowGeometryChange(() => {
  clearTimeout(browserGeometryTimer);
  browserGeometryTimer = setTimeout(() => {
    browserGeometryTimer = null;
    syncBrowserBounds();
  }, 50);
});

// Panes own layout; tabs own sessions and page state. Compatibility accessors
// let pane actions operate on the selected tab while callbacks retain their tab.
function surfaceId(pane) { return (pane.activeTab || pane).id; }
function workspaceTabs(ws) { return ws.panes.flatMap((pane) => pane.tabs); }

let draggedTab = null, draggedConversation = null;

function finishTabDrag() {
  draggedTab = null;
  document.querySelectorAll('.tab-drop-before, .tab-drop-after, .tab-drop-target, .tab-dragging').forEach((el) => {
    el.classList.remove('tab-drop-before', 'tab-drop-after', 'tab-drop-target', 'tab-dragging');
  });
  for (const ws of state.workspaces) ws.panes.forEach(renderPaneTabs);
  syncBrowserBounds();
}

function installTabDropTarget(element, pane, getIndex) {
  const accepts = () => draggedTab && draggedTab.owner.ws === pane.ws
    && (draggedTab.owner === pane || pane.tabs.length < MAX_PANE_TABS);
  const dropIndex = (event) => {
    if (!getIndex) return pane.tabs.length;
    const rect = element.getBoundingClientRect();
    return getIndex() + (event.clientX >= rect.left + rect.width / 2 ? 1 : 0);
  };
  element.addEventListener('dragover', (event) => {
    if (!accepts()) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.tab-drop-before, .tab-drop-after, .tab-drop-target').forEach((el) => el.classList.remove('tab-drop-before', 'tab-drop-after', 'tab-drop-target'));
    if (getIndex) element.classList.add(dropIndex(event) === getIndex() ? 'tab-drop-before' : 'tab-drop-after');
    else pane.tile.classList.add('tab-drop-target');
    // Allow long tab lists to scroll while dragging near an edge.
    const list = pane.tabList;
    const bounds = list.getBoundingClientRect();
    if (event.clientX < bounds.left + 24) list.scrollLeft -= 16;
    else if (event.clientX > bounds.right - 24) list.scrollLeft += 16;
  });
  element.addEventListener('drop', (event) => {
    if (!accepts()) return;
    event.preventDefault();
    event.stopPropagation();
    const tab = draggedTab;
    const index = dropIndex(event);
    finishTabDrag();
    movePaneTab(tab, pane, index);
  });
}

function movePaneTab(tab, target, index, focus = true) {
  const source = tab.owner;
  const ws = source.ws;
  if (ws.closingPane || target.ws.closingPane || (source !== target && target.tabs.length >= MAX_PANE_TABS)) return;
  const from = source.tabs.indexOf(tab);
  if (from < 0) return;
  hidePaneBanner(tab);
  source.tabs.splice(from, 1);
  if (source !== target && !source.tabs.length) addPaneTab(ws, source, { type: 'chat' }, false);
  if (source === target && from < index) index -= 1;
  target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, tab);
  if (source !== target) {
    if (source.activeTab === tab) source.activeTab = source.tabs[Math.min(from, source.tabs.length - 1)] || null;
    if (tab.syncObserver) { tab.syncObserver.unobserve(source.tile); tab.syncObserver.observe(target.tile); }
    tab.owner = target;
    tab.tile = target.tile;
    target.tile.appendChild(tab.body);
    if (source.tabs.length) {
      source.tabs.forEach((item) => item.body.classList.toggle('tab-hidden', item !== source.activeTab));
      updatePaneSurfaceChrome(source);
      if (source.activeTab.type === 'terminal') setPaneStatus(ws, source.activeTab, source.activeTab.status);
      renderPaneTabs(source);
    } else {
      // Remove an empty layout leaf without disposing the moved live session.
      const found = findLeaf(ws.tree, source);
      if (found?.parent) {
        found.parent.children.splice(found.index, 1);
        found.parent.weights?.splice(found.index, 1);
        ws.tree = collapseSplits(ws.tree);
      }
      source.layoutObserver?.disconnect();
      source.tile.remove();
      ws.panes.splice(ws.panes.indexOf(source), 1);
      refreshView(ws);
    }
  }
  activateTab(target.ws, target, tab, focus);
  if (source !== target) { afterLayout(ws); afterLayout(target.ws, target); }
}

function tabMoveMenu(pane, tab) {
  const index = pane.tabs.indexOf(tab);
  return [
    { label: 'Move tab left', disabled: index === 0, action: () => movePaneTab(tab, pane, index - 1) },
    { label: 'Move tab right', disabled: index === pane.tabs.length - 1, action: () => movePaneTab(tab, pane, index + 2) },
    ...pane.ws.panes.filter((target) => target !== pane).map((target) => ({
      label: `Move to pane ${pane.ws.panes.indexOf(target) + 1}`,
      disabled: target.tabs.length >= MAX_PANE_TABS,
      action: () => movePaneTab(tab, target, target.tabs.length),
    })),
    'sep',
    { label: 'Close tab', action: () => closePaneTab(pane.ws, pane, tab) },
  ];
}

function renderPaneTabs(pane) {
  if (!pane.tabList || draggedTab) return;
  const scrollLeft = pane.tabList.scrollLeft;
  const focused = document.activeElement;
  const focusedItem = focused?.closest('.pane-tab');
  const focusedId = focusedItem && pane.tabList.contains(focusedItem) ? focusedItem.dataset.tabId : null;
  const focusedClass = focused?.classList.contains('pane-tab-close') ? 'pane-tab-close' : 'pane-tab-select';
  pane.tabList.replaceChildren();
  const visibleTabs = pane.tabs.filter((tab) => tab.type !== 'terminal');
  visibleTabs.forEach((tab, index) => {
    const item = document.createElement('div');
    item.className = 'pane-tab' + (tab === pane.activeTab ? ' selected' : '');
    item.dataset.tabId = tab.id;
    item.dataset.tabType = tab.type;
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      if (event.target.closest('.pane-tab-close')) { event.preventDefault(); return; }
      draggedTab = tab;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-synthesis-tab', tab.id);
      item.classList.add('tab-dragging');
      syncBrowserBounds(); // native pages cannot intercept tab drops
    });
    item.addEventListener('dragend', finishTabDrag);
    installTabDropTarget(item, pane, () => pane.tabs.indexOf(tab));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showMenu(event.clientX, event.clientY, tabMoveMenu(pane, tab));
    });
    const select = document.createElement('button');
    select.className = 'pane-tab-select';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(tab === pane.activeTab));
    select.setAttribute('aria-controls', tab.body.id);
    select.id = 'tab-' + tab.id;
    select.tabIndex = tab === pane.activeTab ? 0 : -1;
    select.textContent = (tab.type === 'browser' ? '◎ ' : tab.type === 'chat' ? '✳ ' : '>_ ') + (tab.title || (tab.type === 'browser' ? 'New tab' : 'Terminal'));
    select.title = select.textContent;
    select.addEventListener('click', () => activateTab(pane.ws, pane, tab));
    select.addEventListener('keydown', (event) => {
      if (event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const offset = event.key === 'ArrowLeft' ? -1 : 2;
        movePaneTab(tab, pane, pane.tabs.indexOf(tab) + offset, false);
        pane.tabList.querySelector(`[data-tab-id="${tab.id}"] .pane-tab-select`)?.focus();
        return;
      }
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % visibleTabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + visibleTabs.length) % visibleTabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = visibleTabs.length - 1;
      else return;
      event.preventDefault();
      activateTab(pane.ws, pane, visibleTabs[next], false);
      pane.tabList.querySelector('[aria-selected="true"]').focus();
    });
    const close = document.createElement('button');
    close.className = 'pane-tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close ' + (tab.title || tab.type) + ' tab');
    close.addEventListener('click', () => closePaneTab(pane.ws, pane, tab));
    item.append(select, close);
    pane.tabList.appendChild(item);
  });
  pane.tabList.scrollLeft = scrollLeft;
  if (focusedId) {
    const item = [...pane.tabList.children].find((child) => child.dataset.tabId === focusedId);
    item?.querySelector(`.${focusedClass}`)?.focus({ preventScroll: true });
  }
}

function activateTab(ws, pane, tab, focus = true) {
  if (!pane.tabs.includes(tab)) return;
  if (pane.activeTab) hidePaneBanner(pane.activeTab);
  pane.activeTab = tab;
  if (ws.id === state.activeId) tab.startChat?.();
  pane.tabs.forEach((item) => item.body.classList.toggle('tab-hidden', item !== tab));
  updatePaneSurfaceChrome(pane);
  setPaneTitle(tab, tab.title);
  if (tab.type === 'terminal' && tab.status !== 'live') setPaneStatus(ws, tab, tab.status);
  ws.activePaneIdx = ws.panes.indexOf(pane);
  ws.panes.forEach((item) => item.tile.classList.toggle('active', item === pane));
  renderPaneTabs(pane);
  pane.tabList.querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncBrowserBounds();
  requestAnimationFrame(() => { fitSafely(tab); if (focus && ws.id === state.activeId) focusPaneSurface(tab); });
  renderChrome();
  renderList();
  refreshGitPanel();
  saveWorkspaces();
}

function initChatPane(ws, tab) {
  const chatCwd = tab.chatCwd || ws.cwd;
  const projectWorkspace = () => state.workspaces.find(item => item.id === tab.projectId) || ws;
  tab.body.classList.add('chat-body');
  tab.body.innerHTML = `<div class="chat-scroll"><div class="chat-thread"><div class="chat-welcome"><span class="chat-symbol">✳</span><h2>What shall we work on?</h2><p>Ask Pi to explore, create, or change something in this workspace.</p></div><div class="chat-messages" aria-live="polite"></div><div class="chat-status" hidden><span class="chat-thinking"><span class="chat-status-text">Thinking</span><span aria-hidden="true">…</span></span></div></div></div><form class="chat-composer"><textarea rows="1" aria-label="Message Pi" placeholder="Ask anything… Use / for commands; attach files with the paperclip."></textarea><div class="chat-attachments" aria-label="Attachments" hidden></div><div class="chat-compose-bottom"><button class="chat-attach" type="button" aria-label="Attach a file or folder" title="Attach a file or folder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-8.49 8.49a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48"/></svg></button><button class="chat-git" type="button" aria-label="Open Git menu" aria-haspopup="dialog" aria-expanded="false" title="Open Git menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 2.6a2 2 0 0 1 2.8 0l8 8a2 2 0 0 1 0 2.8l-8 8a2 2 0 0 1-2.8 0l-8-8a2 2 0 0 1 0-2.8z"/><path d="m7.5 5.5 4 4v5m0-5 4 4"/><circle cx="11.5" cy="9.5" r="1.1"/><circle cx="11.5" cy="15.5" r="1.1"/><circle cx="16.5" cy="14.5" r="1.1"/></svg></button><div class="chat-controls"><div class="chat-model-picker"><button class="chat-model-trigger" type="button" aria-label="Choose model" aria-haspopup="dialog" aria-expanded="false"><span class="chat-model-label">Loading models…</span><svg class="chat-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button><div class="chat-model-menu" role="dialog" aria-label="Choose model" hidden><div class="chat-model-header"><strong>Choose a model</strong><input class="chat-model-search" type="search" placeholder="Search models or providers" aria-label="Search models or providers"></div><div class="chat-model-list"></div></div></div><div class="chat-reasoning-picker"><button class="chat-reasoning-trigger" type="button" aria-label="Choose reasoning level" aria-haspopup="dialog" aria-expanded="false"><span class="chat-reasoning-label">Off</span><svg class="chat-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button><div class="chat-reasoning-menu chat-model-menu" role="dialog" aria-label="Choose reasoning level" hidden><div class="chat-reasoning-list"></div></div></div></div><button class="chat-send" type="submit" aria-label="Send message" title="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v6a3 3 0 0 1-3 3H5m4-4-4 4 4 4"/></svg></button></div></form>`;
  const messages = tab.body.querySelector('.chat-messages');
  const scroll = tab.body.querySelector('.chat-scroll');
  const welcome = tab.body.querySelector('.chat-welcome');
  const status = tab.body.querySelector('.chat-status');
  const statusText = tab.body.querySelector('.chat-status-text');
  const form = tab.body.querySelector('form');
  const input = form.querySelector('textarea');
  const button = form.querySelector('.chat-send');
  form.querySelector('.chat-git').addEventListener('click', event => {
    const trigger = event.currentTarget;
    if (!$('#git-panel').hidden && gitAnchor === trigger) setFsCollapsed(true);
    else { gitAnchor = trigger; setFsCollapsed(false); }
  });
  const modelSelect = form.querySelector('.chat-model-trigger');
  const modelLabel = form.querySelector('.chat-model-label');
  const modelMenu = form.querySelector('.chat-model-menu');
  const modelSearch = form.querySelector('.chat-model-search');
  const modelList = form.querySelector('.chat-model-list');
  const favoriteKey = 'synthesis.chat.favoriteModels';
  let models = [];
  function favorites() { try { const values = JSON.parse(localStorage.getItem(favoriteKey) || '[]'); return new Set(Array.isArray(values) ? values.filter(x => typeof x === 'string') : []); } catch { return new Set(); } }
  function modelKey(model) { return JSON.stringify([model.provider, model.id]); }
  function providerName(value) { return ({ openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic', google: 'Google', 'github-copilot': 'GitHub Copilot', 'openai-codex': 'OpenAI Codex' })[value] || value; }
  function updateModelLabel() { const model = models.find(m => modelKey(m) === currentModel); modelLabel.textContent = model ? (model.name || model.id) : models.length ? 'Choose model' : 'No models available'; modelSelect.title = model ? `${model.name || model.id} · ${providerName(model.provider)}` : modelLabel.textContent; }
  function closeModelMenu() { modelMenu.hidden = true; modelSelect.setAttribute('aria-expanded', 'false'); }
  function renderModels() {
    modelList.replaceChildren();
    const saved = favorites(); const query = modelSearch.value.trim().toLowerCase();
    const filtered = models.filter(m => `${m.name || ''} ${m.id} ${m.provider}`.toLowerCase().includes(query));
    const groups = [['Favourites', filtered.filter(m => saved.has(modelKey(m)))], ['All models', filtered.filter(m => !saved.has(modelKey(m)))]];
    if (!filtered.length) { const empty = document.createElement('div'); empty.className = 'chat-model-empty'; empty.textContent = models.length ? 'No matching models' : 'No models available'; modelList.append(empty); return; }
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const heading = document.createElement('div'); heading.className = 'chat-model-group'; heading.textContent = label; modelList.append(heading);
      for (const model of items) {
        const key = modelKey(model); const row = document.createElement('div'); row.className = 'chat-model-row';
        const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'chat-model-option';
        const name = document.createElement('span'); name.className = 'chat-model-name'; name.textContent = model.name || model.id;
        const provider = document.createElement('span'); provider.className = 'chat-model-provider'; provider.textContent = providerName(model.provider);
        choose.append(name, provider); if (key === currentModel) { const check = document.createElement('span'); check.className = 'chat-model-check'; check.textContent = '✓'; choose.append(check); choose.setAttribute('aria-current', 'true'); }
        choose.addEventListener('click', () => { if (key === currentModel) { closeModelMenu(); return; } changing = true; closeModelMenu(); update(); command('set_model', { provider: model.provider, modelId: model.id }); });
        const star = document.createElement('button'); star.type = 'button'; star.className = 'chat-model-star'; star.textContent = saved.has(key) ? '★' : '☆'; star.setAttribute('aria-label', (saved.has(key) ? 'Remove from favourites: ' : 'Add to favourites: ') + (model.name || model.id) + ', ' + providerName(model.provider)); star.setAttribute('aria-pressed', String(saved.has(key)));
        star.addEventListener('click', () => { const next = favorites(); if (next.has(key)) next.delete(key); else next.add(key); try { localStorage.setItem(favoriteKey, JSON.stringify([...next])); } catch {} renderModels(); });
        row.append(choose, star); modelList.append(row);
      }
    }
  }
  modelSelect.addEventListener('click', () => { if (!modelMenu.hidden) { closeModelMenu(); return; } closeReasoning(); modelSearch.value = ''; renderModels(); modelMenu.hidden = false; modelSelect.setAttribute('aria-expanded', 'true'); modelSearch.focus(); });
  modelSearch.addEventListener('input', renderModels);
  modelMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeModelMenu(); modelSelect.focus(); } });
  const dismissModelMenu = event => { if (!form.querySelector('.chat-model-picker').contains(event.target)) closeModelMenu(); };
  document.addEventListener('pointerdown', dismissModelMenu);
  tab.unsubs.push(() => document.removeEventListener('pointerdown', dismissModelMenu));
  const reasoningSelect = form.querySelector('.chat-reasoning-trigger');
  const reasoningLabel = form.querySelector('.chat-reasoning-label');
  const reasoningMenu = form.querySelector('.chat-reasoning-menu');
  const reasoningList = form.querySelector('.chat-reasoning-list');
  let levels = ['off'], pendingReasoning = null;
  function levelLabel(level) { return level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Off'; }
  function renderReasoning() {
    reasoningLabel.textContent = levelLabel(currentReasoning);
    reasoningList.replaceChildren();
    for (const level of levels) { const item = document.createElement('button'); item.type = 'button'; item.className = 'chat-reasoning-option'; item.textContent = levelLabel(level); if (level === currentReasoning) { item.setAttribute('aria-current', 'true'); const check = document.createElement('span'); check.textContent = '✓'; item.append(check); } item.addEventListener('click', () => { closeReasoning(); if (level === currentReasoning) return; pendingReasoning = level; changing = true; update(); command('set_thinking_level', { level }); }); reasoningList.append(item); }
  }
  function closeReasoning() { reasoningMenu.hidden = true; reasoningSelect.setAttribute('aria-expanded', 'false'); }
  reasoningSelect.addEventListener('click', () => { if (!reasoningMenu.hidden) { closeReasoning(); return; } closeModelMenu(); renderReasoning(); reasoningMenu.hidden = false; reasoningSelect.setAttribute('aria-expanded', 'true'); reasoningList.querySelector('button')?.focus(); });
  reasoningMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeReasoning(); reasoningSelect.focus(); } });
  const dismissReasoning = event => { if (!form.querySelector('.chat-reasoning-picker').contains(event.target)) closeReasoning(); };
  document.addEventListener('pointerdown', dismissReasoning);
  tab.unsubs.push(() => document.removeEventListener('pointerdown', dismissReasoning));
  const attachmentList = form.querySelector('.chat-attachments');
  const attachButton = form.querySelector('.chat-attach');
  let attachments = [], pastedImages = [], pendingImages = 0, currentReasoning = 'off';
  const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const maxImageBytes = 10 * 1024 * 1024;
  let currentModel = '', changing = false;
  function renderAttachments() {
    attachmentList.replaceChildren(); attachmentList.hidden = !attachments.length && !pastedImages.length && !pendingImages;
    attachments.forEach(path => { const chip = document.createElement('span'); chip.className = 'chat-attachment'; const name = document.createElement('span'); name.textContent = path.split('/').filter(Boolean).pop() || path; name.title = path; const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove ' + name.textContent); remove.addEventListener('click', () => { attachments = attachments.filter(item => item !== path); renderAttachments(); update(); }); chip.append(name, remove); attachmentList.append(chip); });
    pastedImages.forEach((item, index) => {
      const chip = document.createElement('span'); chip.className = 'chat-attachment chat-image-attachment';
      const thumb = document.createElement('img'); thumb.src = `data:${item.mimeType};base64,${item.data}`; thumb.alt = '';
      const name = document.createElement('span'); name.textContent = item.name || 'Pasted image';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove pasted image ' + (index + 1));
      remove.addEventListener('click', () => { pastedImages = pastedImages.filter(image => image !== item); renderAttachments(); update(); });
      chip.append(thumb, name, remove); attachmentList.append(chip);
    });
    if (pendingImages) { const note = document.createElement('span'); note.className = 'chat-attachment'; note.textContent = 'Adding image…'; attachmentList.append(note); }
  }
  input.addEventListener('paste', event => {
    const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && imageTypes.has(item.type));
    if (!items.length) return;
    // Preserve regular text when a clipboard contains both text and an image.
    if (![...(event.clipboardData?.items || [])].some(item => item.kind === 'string' && item.type === 'text/plain')) event.preventDefault();
    for (const item of items) {
      const file = item.getAsFile(); if (!file) continue;
      if (!file.size || file.size > maxImageBytes) { add('error', 'Pasted images must be smaller than 10 MB.'); continue; }
      pendingImages++; renderAttachments(); update();
      const reader = new FileReader();
      reader.onload = () => {
        if (tab.disposed) return;
        const data = String(reader.result || '').split(',', 2)[1];
        if (data) pastedImages.push({ type: 'image', mimeType: file.type, data, name: file.name && file.name !== 'image.png' ? file.name : 'Pasted image' });
        else add('error', 'Could not read the pasted image.');
      };
      reader.onerror = () => { if (!tab.disposed) add('error', 'Could not read the pasted image.'); };
      reader.onloadend = () => { if (!tab.disposed) { pendingImages--; renderAttachments(); update(); } };
      reader.readAsDataURL(file);
    }
  });
  attachButton.addEventListener('click', async () => { const path = await window.mux.app.pickPath(); if (path && !tab.disposed && !attachments.includes(path)) { attachments.push(path); renderAttachments(); update(); } });
  let streaming = null, busy = false, ready = false, lastSidebarBusy = null, turnHasOutput = false, turnHasError = false;
  let turnCount = 0, timerStarted = null, timerInterval = null, timerNode = null, pendingRender = null;
  function formatElapsed(ms) {
    const seconds = Math.floor(ms / 1000), h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), sec = seconds % 60;
    return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
  }
  function addTimer(ms, running = false) {
    const node = document.createElement('div'); node.className = 'chat-work-timer';
    node.textContent = `${running ? 'Working' : 'Worked'} for ${formatElapsed(ms)}`;
    messages.append(node); return node;
  }
  function beginTimer() {
    timerStarted = Date.now(); timerNode = addTimer(0, true);
    timerInterval = setInterval(() => { if (timerNode) timerNode.textContent = `Working for ${formatElapsed(Date.now() - timerStarted)}`; }, 1000);
  }
  function finishTimer() {
    if (timerStarted === null) return;
    const elapsed = Date.now() - timerStarted;
    clearInterval(timerInterval); timerInterval = null;
    if (timerNode) timerNode.textContent = `Worked for ${formatElapsed(elapsed)}`;
    const key = tab.sessionPath || tab.id; const durations = { ...(chatMeta(key).durations || {}), [turnCount]: elapsed };
    setChatMeta(key, { durations }); timerStarted = null; timerNode = null;
  }
  tab.unsubs.push(() => { clearInterval(timerInterval); if (pendingRender !== null) cancelAnimationFrame(pendingRender); });
  tab.modified = 0;
  function update() { tab.isWorking = busy; if (lastSidebarBusy !== busy) { lastSidebarBusy = busy; scheduleStatusUpdate(projectWorkspace()); renderList(); } button.disabled = !ready || busy || changing || pendingImages > 0 || (!input.value.trim() && !attachments.length && !pastedImages.length); modelSelect.disabled = !ready || busy || changing; reasoningSelect.disabled = !ready || busy || changing; attachButton.disabled = busy || changing; status.hidden = !busy; }
  tab.abortChat = () => { if (busy) { command('abort'); statusText.textContent = 'Stopping…'; } };
  function add(role, content, images = []) {
    if (!content && !images.length) return null;
    if (busy && role === 'error') turnHasError = true;
    welcome.hidden = true;
    const row = document.createElement('div'); row.className = 'chat-message ' + role;
    const body = document.createElement('div'); body.className = 'chat-message-content';
    row.append(body);
    if (role === 'assistant') {
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'chat-response-copy'; copy.title = 'Copy response'; copy.setAttribute('aria-label', 'Copy response');
      const icon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="1.5"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
      copy.innerHTML = icon; copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(body.raw || ''); copy.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>'; copy.title = 'Copied'; copy.setAttribute('aria-label', 'Response copied'); setTimeout(() => { if (copy.isConnected) { copy.innerHTML = icon; copy.title = 'Copy response'; copy.setAttribute('aria-label', 'Copy response'); } }, 2000); } catch { copy.title = 'Copy failed'; copy.setAttribute('aria-label', 'Copy failed'); } }); row.append(copy);
    }
    messages.append(row); body.raw = content || ''; renderText(body, content || '');
    for (const item of images) {
      if (!imageTypes.has(item.mimeType) || typeof item.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) continue;
      const image = document.createElement('img'); image.className = 'chat-message-image'; image.alt = 'Attached image'; image.src = `data:${item.mimeType};base64,${item.data}`; body.append(image);
    }
    scroll.scrollTop = scroll.scrollHeight; return body;
  }
  function renderText(el, value) {
    // Markdown is converted locally, then restricted to inert formatting elements.
    const html = marked.parse(String(value), { gfm: true, breaks: false });
    el.innerHTML = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
      ALLOWED_ATTR: ['href', 'title', 'start'], ALLOW_DATA_ATTR: false
    });
    for (const link of el.querySelectorAll('a')) {
      const href = link.getAttribute('href') || '';
      let valid = false; try { valid = ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol); } catch {}
      if (!valid) { link.removeAttribute('href'); continue; }
      link.addEventListener('click', event => { event.preventDefault(); window.mux.app.openChatLink(href); });
    }
    for (const pre of el.querySelectorAll('pre')) {
      const raw = pre.querySelector('code')?.textContent || pre.textContent;
      const wrapper = document.createElement('div'); wrapper.className = 'chat-code-block';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'chat-code-copy'; copy.setAttribute('aria-label', 'Copy code'); copy.title = 'Copy code';
      const copyIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="1.5"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
      copy.innerHTML = copyIcon;
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(raw.replace(/\n$/, '')); copy.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>'; copy.setAttribute('aria-label', 'Code copied'); copy.title = 'Copied'; setTimeout(() => { if (copy.isConnected) { copy.innerHTML = copyIcon; copy.setAttribute('aria-label', 'Copy code'); copy.title = 'Copy code'; } }, 2000); } catch { copy.setAttribute('aria-label', 'Copy failed; select the code to copy'); copy.title = 'Copy failed; select the code to copy'; } });
      pre.replaceWith(wrapper); wrapper.append(copy, pre);
    }
    for (const table of el.querySelectorAll('table')) { const wrapper = document.createElement('div'); wrapper.className = 'chat-table-wrap'; table.replaceWith(wrapper); wrapper.append(table); }
  }
  function textOf(message) { return typeof message.content === 'string' ? message.content : (message.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n'); }
  function imagesOf(message) { return Array.isArray(message.content) ? message.content.filter(x => x.type === 'image' && imageTypes.has(x.mimeType) && typeof x.data === 'string') : []; }
  function command(type, extra = {}) { window.mux.chat.command(tab.id, { type, ...extra }); }
  function onChatEvent(event) {
    if (event.type === 'response' && event.command === 'get_messages') {
      ready = event.success;
      if (event.success) { messages.replaceChildren(); welcome.hidden = false; turnCount = 0; const durations = chatMeta(tab.sessionPath || tab.id).durations || {}; for (const m of event.data.messages || []) { if (m.role === 'user' || m.role === 'assistant') { const text = textOf(m); add(m.role, text, m.role === 'user' ? imagesOf(m) : []); if (m.role === 'user' && text) { turnCount++; if (Number.isFinite(durations[turnCount])) addTimer(durations[turnCount]); } if (m.role === 'user' && text) { tab.hasConversation = true; if (tab.sessionPath) rememberConversation(tab.sessionPath); } if (m.role === 'user' && tab.title === 'Chat' && text) setPaneTitle(tab, chatMeta(tab.sessionPath || tab.id).title || text.replace(/\s+/g, ' ').slice(0, 45)); } else if (m.role === 'toolResult' && m.toolName === 'rich_text') { const text = chatRichText.resultText(m); if (text) add(m.isError ? 'error' : 'assistant', text); } } }
      else add('error', event.error || 'Could not load this chat.'); update(); renderList();
    } else if (event.type === 'response' && event.command === 'get_available_models') {
      models = (event.data?.models || []).filter(m => typeof m.provider === 'string' && typeof m.id === 'string'); updateModelLabel(); if (!modelMenu.hidden) renderModels();
    } else if (event.type === 'response' && event.command === 'get_state' && event.success) {
      const model = event.data.model; currentModel = model ? modelKey(model) : ''; updateModelLabel();
      if (event.data.sessionFile && tab.sessionPath !== event.data.sessionFile) { moveChatMeta(tab.id, event.data.sessionFile); tab.sessionPath = event.data.sessionFile; refreshProjectChats(projectWorkspace()); } if (tab.hasConversation && tab.sessionPath) rememberConversation(tab.sessionPath); currentReasoning = event.data.thinkingLevel || 'off'; renderReasoning(); saveWorkspaces();
    } else if (event.type === 'response' && event.command === 'set_model') {
      changing = false; if (!event.success) { add('error', event.error || 'Could not change model.'); updateModelLabel(); } else { const m = event.data; currentModel = modelKey(m); updateModelLabel(); command('get_state'); command('get_available_thinking_levels'); } update();
    } else if (event.type === 'response' && event.command === 'get_available_thinking_levels') {
      levels = event.data?.levels?.length ? event.data.levels : ['off']; renderReasoning();
    } else if (event.type === 'response' && event.command === 'set_thinking_level') {
      changing = false; if (!event.success) add('error', event.error || 'Could not change reasoning level.'); else { currentReasoning = pendingReasoning; command('get_state'); } pendingReasoning = null; renderReasoning(); update();
    } else if (event.type === 'response' && event.command === 'prompt' && (!event.success || event.data?.disposition === 'handled')) { busy = false; finishTimer(); if (!event.success) add('error', event.error || 'Could not send message.'); update(); }
    else if (event.type === 'message_start' && event.message?.role === 'assistant') streaming = null;
    else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      if (!streaming) { streaming = add('assistant', ' '); streaming.raw = ''; }
      if (event.assistantMessageEvent.delta) turnHasOutput = true; streaming.raw += event.assistantMessageEvent.delta; if (pendingRender === null) pendingRender = requestAnimationFrame(() => { pendingRender = null; if (streaming) { renderText(streaming, streaming.raw); scroll.scrollTop = scroll.scrollHeight; } });
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = textOf(event.message); if (text) turnHasOutput = true; if (pendingRender !== null) { cancelAnimationFrame(pendingRender); pendingRender = null; } if (streaming) { streaming.raw = text; renderText(streaming, text); } else if (text) add('assistant', text);
      if (event.message.errorMessage) add('error', event.message.errorMessage); streaming = null;
    } else if (event.type === 'tool_execution_start') { statusText.textContent = 'Thinking'; }
    else if (event.type === 'tool_execution_end') {
      statusText.textContent = 'Thinking';
      if (event.toolName === 'rich_text') {
        const text = chatRichText.resultText(event.result);
        if (event.isError) add('error', text || 'The rich-text response could not be produced.');
        else if (text) { turnHasOutput = true; add('assistant', text); }
      }
    }
    else if (event.type === 'agent_settled') { if (busy && !event.aborted && !turnHasOutput && !turnHasError) add('error', 'The agent finished without a text response. Try again or check the selected model.'); busy = false; finishTimer(); statusText.textContent = 'Thinking'; command('get_state'); update(); refreshProjectChats(projectWorkspace()); }
    else if (event.type === 'extension_ui_request') {
      let response = { type: 'extension_ui_response', id: event.id };
      if (event.method === 'confirm') response.confirmed = window.confirm(event.title || 'Confirm');
      else if (['input', 'editor', 'select'].includes(event.method)) { const answer = window.prompt(event.title + (event.options ? '\n' + event.options.join('\n') : ''), event.prefill || ''); if (answer === null) response.cancelled = true; else response.value = answer; }
      else { if (event.method === 'notify') add('error', event.message); return; }
      window.mux.chat.command(tab.id, response);
    } else if (event.type === 'process_error' || event.type === 'process_exit') { ready = false; busy = false; finishTimer(); add('error', event.error || 'Pi stopped. Close and reopen this chat to try again.'); update(); }
  }
  form.addEventListener('submit', e => { e.preventDefault(); const value = input.value.trim(); if ((!value && !attachments.length && !pastedImages.length) || busy || !ready || changing || pendingImages) return; const paths = [...attachments]; const images = pastedImages.map(({ type, mimeType, data }) => ({ type, mimeType, data })); const context = paths.length ? 'Attached files and folders (use these paths):\n' + paths.map(path => '- ' + JSON.stringify(path)).join('\n') : ''; const message = [value, context].filter(Boolean).join('\n\n') || 'Please look at the attached image.'; const firstTurn = !tab.hasConversation; add('user', message, images); turnHasOutput = false; turnHasError = false; turnCount++; beginTimer(); tab.hasConversation = true; if (tab.sessionPath) rememberConversation(tab.sessionPath); tab.modified = Date.now(); setChatMeta(tab.sessionPath || tab.id, { modified: tab.modified }); if (tab.title === 'Chat') setPaneTitle(tab, (value || 'New chat').replace(/\s+/g, ' ').slice(0, 45)); if (firstTurn && value) { const chosen = models.find(m => modelKey(m) === currentModel); window.mux.chat.title(chatCwd, value, chosen ? { provider: chosen.provider, id: chosen.id } : null).then(title => { if (!title || tab.disposed) return; setPaneTitle(tab, title); setChatMeta(tab.sessionPath || tab.id, { title }); command('set_session_name', { name: title }); saveWorkspaces(); }).catch(() => {}); } input.value = ''; attachments = []; pastedImages = []; renderAttachments(); resizeInput(); busy = true; update(); command('prompt', { message, ...(images.length ? { images } : {}) }); });
  function resizeInput() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
  input.addEventListener('input', () => { resizeInput(); update(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  update();
  tab.startChat = () => {
    if (tab.disposed || tab.chatStarted) return;
    tab.chatStarted = true;
    tab.unsubs.push(window.mux.chat.onEvent(tab.id, onChatEvent));
    window.mux.app.allowRoot(chatCwd).then(() => tab.disposed ? null : window.mux.chat.start(tab.id, chatCwd, tab.sessionPath)).then(result => {
      if (tab.disposed) { window.mux.chat.stop(tab.id); return; }
      if (!result.ok) { ready = false; add('error', result.error || 'Could not start this chat.'); update(); }
    }).catch(() => { if (!tab.disposed) { ready = false; add('error', 'Could not start this chat. Close and reopen it to try again.'); update(); } });
  };
}

function addPaneTab(ws, pane, opts = {}, activate = true) {
  if (pane.tabs.length >= MAX_PANE_TABS && !opts.restore) return null;
  const type = ['browser', 'chat'].includes(opts.type) ? opts.type : 'terminal';
  const id = opts.id || 'tab-' + crypto.randomUUID();
  const body = document.createElement('div');
  body.className = 'pane-body tab-hidden';
  body.id = 'panel-' + id;
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', 'tab-' + id);
  pane.tile.appendChild(body);
  const tab = {
    id, type, owner: pane, tile: pane.tile, body,
    title: type === 'browser' ? 'New tab' : type === 'chat' ? 'Chat' : 'Terminal',
    status: 'pending', hasTerminal: type === 'terminal', restore: Boolean(opts.restore),
    exited: false, isWorking: false, lastActivityAt: 0, oscTitle: false, unsubs: [],
  };
  pane.tabs.push(tab);
  if (!pane.activeTab) pane.activeTab = tab;
  body.classList.toggle('tab-hidden', pane.activeTab !== tab);
  if (type === 'browser') initBrowserPane(ws, tab, opts);
  else if (type === 'chat') { tab.sessionPath = opts.sessionPath || ''; tab.chatCwd = opts.chatCwd || ws.cwd; tab.projectId = opts.projectId || ws.id; initChatPane(ws, tab); }
  else initTerminalPane(ws, tab);
  renderPaneTabs(pane);
  if (activate) activateTab(ws, pane, tab);
  return tab;
}

function closePaneTab(ws, pane, tab) {
  if (!pane.tabs.includes(tab)) return;
  // Closing the last visible tab closes its split, including any hidden terminal.
  if (tab.type !== 'terminal' && pane.tabs.filter(item => item.type !== 'terminal').length === 1 && ws.panes.length > 1) { closePane(ws, pane); return; }
  if (appSettings.confirmClose && !window.confirm(`Close tab “${tab.title}”? ${tab.type === 'terminal' ? 'Its running terminal process will be stopped.' : tab.type === 'chat' ? 'Its active chat will be stopped.' : 'The browser page will be closed.'}`)) return;
  const index = pane.tabs.indexOf(tab);
  const wasActive = pane.activeTab === tab;
  disposeTab(tab);
  pane.tabs.splice(index, 1);
  if (!pane.tabs.some((item) => item.type !== 'terminal')) addPaneTab(ws, pane, { type: 'chat' });
  else if (wasActive) activateTab(ws, pane, pane.tabs.filter((item) => item.type !== 'terminal')[0]);
  else { renderPaneTabs(pane); renderChrome(); saveWorkspaces(); }
  scheduleStatusUpdate(ws);
}

function createPane(ws, opts = {}) {
  let paneId = opts.id;
  if (!paneId) {
    do {
      ws.paneSeq = (ws.paneSeq || 0) + 1;
      paneId = ws.id + '-p' + ws.paneSeq;
    } while (ws.panes.some((pane) => pane.id === paneId || pane.tabs.some((tab) => tab.id === paneId)));
  }
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.paneId = paneId;
  ws.view.appendChild(tile);
  const pane = { id: paneId, tile, ws, tabs: [], activeTab: null };
  // Only surface state is forwarded; layout identity remains stable on the pane.
  for (const key of ['type', 'title', 'body', 'term', 'fit', 'status', 'exited', 'isWorking', 'lastActivityAt', 'currentUrl', 'zoom', 'urlInput', 'hasError', 'viewport', 'browserToolbar', 'oscTitle']) {
    Object.defineProperty(pane, key, { get: () => pane.activeTab?.[key], set: (value) => { if (pane.activeTab) pane.activeTab[key] = value; } });
  }
  Object.defineProperty(pane, 'hasTerminal', { get: () => pane.tabs.some((tab) => tab.hasTerminal) });
  ws.panes.push(pane);
  const specs = opts.tabs || [{ ...opts, id: opts.type === 'browser' && opts.hasTerminal ? 'tab-' + crypto.randomUUID() : paneId }];
  specs.forEach((spec, index) => addPaneTab(ws, pane, { ...spec, id: spec.id || (index === 0 ? paneId : undefined), restore: opts.restore }, false));
  // Old browser panes may also own a recoverable terminal under the pane ID.
  if (!opts.tabs && opts.type === 'browser' && opts.hasTerminal) {
    addPaneTab(ws, pane, { type: 'terminal', id: paneId, restore: Boolean(opts.restore) }, false);
  }
  if (!pane.tabs.some((tab) => tab.type !== 'terminal')) addPaneTab(ws, pane, { type: 'chat' }, false);
  pane.activeTab = pane.tabs.find((tab) => tab.id === opts.activeTabId && tab.type !== 'terminal') || pane.tabs.find((tab) => tab.type !== 'terminal');
  pane.tabs.forEach((tab) => tab.body.classList.toggle('tab-hidden', tab !== pane.activeTab));
  const actions = buildPaneActions(ws, pane);
  const strip = document.createElement('div');
  strip.className = 'pane-tabs';
  pane.tabList = document.createElement('div');
  pane.tabList.className = 'pane-tab-list';
  pane.tabList.setAttribute('role', 'tablist');
  pane.tabList.setAttribute('aria-label', 'Pane tabs');
  strip.appendChild(pane.tabList);
  strip.appendChild(actions);
  tile.prepend(strip);
  installTabDropTarget(strip, pane);
  installTabDropTarget(tile, pane);
  tile.addEventListener('dragover', event => { if (!draggedConversation || pane.tabs.length >= MAX_PANE_TABS) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; tile.classList.add('tab-drop-target'); });
  tile.addEventListener('dragleave', event => { if (!tile.contains(event.relatedTarget)) tile.classList.remove('tab-drop-target'); });
  tile.addEventListener('drop', event => {
    const row = draggedConversation; if (!row || pane.tabs.length >= MAX_PANE_TABS) return;
    event.preventDefault(); event.stopPropagation(); draggedConversation = null; tile.classList.remove('tab-drop-target');
    if (row.tab) movePaneTab(row.tab, pane, pane.tabs.length);
    else addPaneTab(pane.ws, pane, { type: 'chat', sessionPath: row.session.path, chatCwd: row.ws.cwd, projectId: row.ws.id });
    syncBrowserBounds(); renderList();
  });
  renderPaneTabs(pane);
  updatePaneSurfaceChrome(pane);
  tile.addEventListener('mousedown', () => setActivePane(ws, ws.panes.indexOf(pane)));
  tile.addEventListener('focusin', () => {
    if (ws.panes[ws.activePaneIdx] !== pane) setActivePane(ws, ws.panes.indexOf(pane), false);
  });
  pane.layoutObserver = new ResizeObserver(() => fitSafely(pane));
  pane.layoutObserver.observe(tile);
  return pane;
}

function sendPaneInput(ws, pane, data) {
  if (pane.type !== 'terminal') return;
  if (!pane.exited && (data.includes('\r') || data.includes('\n'))) {
    pane.isWorking = true;
    pane.lastActivityAt = Date.now();
    scheduleStatusUpdate(ws);
  }
  window.mux.pty.input(surfaceId(pane), data);
}

function setActivePane(ws, idx, focus = true) {
  if (!ws.panes[idx] || ws.closingPane === ws.panes[idx]) return;
  ws.activePaneIdx = idx;
  const pane = ws.panes[idx];
  ws.panes.forEach((p) => p.tile.classList.toggle('active', p === pane));
  if (focus) focusPaneSurface(pane);
  renderList();
  refreshGitPanel();
  saveWorkspaces();
  requestBrowserSync();
}

/* ---------------- workspaces ---------------- */

/* ---------------- durable state (schema v2) ----------------
 * Layout leaves reference stable pane ids — never array positions — so
 * live daemon PTYs reattach by identity after relaunch. See
 * lib/state-schema.js for the validated shape. */

function treeToLayout(node) {
  if (node.type === 'leaf') return { paneId: node.pane.id };
  const children = node.children.map(treeToLayout);
  if (children.length === 1) return children[0];
  return {
    type: 'split',
    direction: node.dir === 'col' ? 'col' : 'row',
    children,
    weights: [...node.weights],
  };
}

function layoutToTree(layout, panesById) {
  if (!layout) return null;
  if (typeof layout.paneId === 'string') {
    const pane = panesById.get(layout.paneId);
    return pane ? { type: 'leaf', pane } : null;
  }
  if (layout.type === 'split') {
    const children = (layout.children || []).map((c) => layoutToTree(c, panesById)).filter(Boolean);
    if (children.length === 1) return children[0];
    if (children.length === 0) return null;
    const weights = Array.isArray(layout.weights) && layout.weights.length === children.length
      ? [...layout.weights]
      : children.map(() => 1);
    return { type: 'split', dir: layout.direction === 'col' ? 'col' : 'row', children, weights };
  }
  return null;
}

function tabSnapshot(tab, ws) {
  return tab.type === 'chat' ? { id: tab.id, type: 'chat', ...(tab.sessionPath && (tab.hasConversation || readLocalMap(OWNED_CHATS_KEY)[tab.sessionPath]) ? { sessionPath: tab.sessionPath } : {}), ...(tab.chatCwd !== ws.cwd ? { chatCwd: tab.chatCwd } : {}), ...(tab.projectId !== ws.id ? { projectId: tab.projectId } : {}) } : tab.type === 'browser'
    ? { id: tab.id, type: 'browser', url: tab.currentUrl || '', zoom: tab.zoom || 1, profileId: 'default' }
    : { id: tab.id, type: 'terminal', cwd: ws.cwd };
}

function buildSnapshot() {
  return {
    schemaVersion: 2,
    activeWorkspaceId: state.activeId,
    workspaces: state.workspaces.map((w) => {
      const activePane = w.panes[w.activePaneIdx] || w.panes[0];
      // Persist tabs and session identities, but not their temporary split layout.
      const tabs = w.panes.flatMap(pane => pane.tabs.map(tab => tabSnapshot(tab, w)));
      const active = activePane.activeTab;
      return {
        id: w.id, name: w.name, cwd: w.cwd, fileDir: w.fileDir,
        activePaneId: activePane.id,
        panes: [{ ...tabSnapshot(active, w), id: activePane.id,
          hasTerminal: w.panes.some(pane => pane.hasTerminal), activeTabId: active.id, tabs }],
        layout: { paneId: activePane.id },
      };
    }),
  };
}

/* persist workspace list + pane ids so conversations resume on relaunch */
let saveTimer = null;
function flushWorkspaces() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.workspaces.length) return;
  window.mux.sessions.save(buildSnapshot());
}
function saveWorkspaces() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushWorkspaces, 300);
}

function nextWorkspaceId() {
  let id;
  do { id = 'ws-' + (++state.wsSeq); } while (state.workspaces.some((w) => w.id === id));
  return id;
}

function createWorkspace({ name, cwd, id, restore }) {
  const wsId = id || nextWorkspaceId();
  const seqMatch = /^ws-(\d+)$/.exec(wsId);
  if (seqMatch) state.wsSeq = Math.max(state.wsSeq, Number(seqMatch[1]));
  if (cwd && !restore) window.mux.app.allowRoot(cwd); // Restored project roots are authorized when opened.
  const view = document.createElement('div');
  view.dataset.id = wsId;
  els.termHost.appendChild(view);

  const ws = {
    id: wsId,
    name,
    cwd: cwd || state.home,
    view,
    panes: [],
    paneSeq: 0,
    activePaneIdx: 0,
    fileDir: cwd || state.home,
    activity: 'idle',
    activityTimer: null,
    tree: null,
  };
  state.workspaces.push(ws);
  const restoredPanes = restore && Array.isArray(restore.panes) ? restore.panes
    .filter((p) => p && typeof p.id === 'string') : [];
  if (restoredPanes.length) {
    const panes = restoredPanes.map((spec) => createPane(ws, {
      id: spec.id,
      type: spec.type,
      url: spec.url,
      zoom: spec.zoom,
      hasTerminal: spec.hasTerminal,
      tabs: spec.tabs,
      activeTabId: spec.activeTabId,
      restore: true,
    }));
    ws.paneSeq = panes.reduce((maxSeq, pane) => {
      const match = pane.id.match(/-p(\d+)$/);
      return Math.max(maxSeq, match ? Number(match[1]) : 0);
    }, panes.length);
    const byId = new Map(panes.map((p) => [p.id, p]));
    ws.tree = layoutToTree(restore.layout, byId) || { type: 'leaf', pane: panes[0] };
    const activeIdx = panes.findIndex((p) => p.id === restore.activePaneId);
    ws.activePaneIdx = activeIdx >= 0 ? activeIdx : 0;
    if (restore.fileDir) ws.fileDir = restore.fileDir;
    flattenWorkspacePanes(ws, ws.panes[ws.activePaneIdx]);
  } else {
    ws.tree = { type: 'leaf', pane: createPane(ws, { type: 'chat' }) };
  }
  refreshView(ws);
  renderList();
  refreshProjectChats(ws);
  saveWorkspaces();
  return ws;
}

function closeWorkspace(id, { confirmed = false } = {}) {
  const idx = state.workspaces.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const ws = state.workspaces[idx];
  if (!confirmed && appSettings.confirmClose && !window.confirm(`Close “${ws.name}”? Its running terminal processes will be stopped.`)) return;
  if (ws.activityTimer) clearTimeout(ws.activityTimer);
  for (const p of ws.panes) disposePane(p);
  ws.view.remove();
  state.workspaces.splice(idx, 1);
  saveWorkspaces();

  if (state.workspaces.length === 0) {
    const fresh = createWorkspace({ name: 'workspace', cwd: state.home });
    setActive(fresh.id);
  } else if (state.activeId === id) {
    setActive(state.workspaces[Math.max(0, idx - 1)].id);
  } else {
    renderList();
    renderChrome();
  }
}

function setActive(id) {
  state.activeId = id;
  for (const w of state.workspaces) {
    w.view.classList.toggle('active', w.id === id);
  }
  const ws = activeWs();
  if (ws) {
    window.mux.app.allowRoot(ws.cwd);
    state.fileDir = ws.fileDir || ws.cwd;
    state.preview = null;
    renderList();
    renderChrome();
    refreshGitPanel();
    for (const pane of ws.panes) pane.activeTab?.startChat?.();
    saveWorkspaces();
    requestAnimationFrame(() => {
      fitWorkspace(ws);
      syncBrowserBounds();
      focusPaneSurface(ws.panes[ws.activePaneIdx]);
    });
  }
}

/* Chat activity drives the workspace indicator; legacy terminal timers are retained. */
const WORKING_QUIET_MS = 1400;
function workspaceActivity(ws) {
  return workspaceTabs(ws).some((tab) => tab.type === 'chat' && tab.isWorking) ? 'working' : 'idle';
}

function scheduleStatusUpdate(ws) {
  if (ws.activityTimer) clearTimeout(ws.activityTimer);
  const activity = workspaceActivity(ws);
  if (ws.activity !== activity) {
    ws.activity = activity;
    renderList();
  }

  const activePanes = workspaceTabs(ws).filter((pane) => pane.type === 'terminal' && !pane.exited && pane.isWorking);
  if (activePanes.length) {
    const nextIdleAt = Math.min(...activePanes.map((pane) => pane.lastActivityAt + WORKING_QUIET_MS));
    ws.activityTimer = setTimeout(() => {
      const now = Date.now();
      for (const pane of workspaceTabs(ws)) {
        if (pane.type === 'terminal' && pane.isWorking && now - pane.lastActivityAt >= WORKING_QUIET_MS) pane.isWorking = false;
      }
      scheduleStatusUpdate(ws);
    }, Math.max(0, nextIdleAt - Date.now()) + 20);
  }
}

/* ---------------- rendering: sidebar + chrome ---------------- */

let workspaceSortAlphabetically = false;
let showArchivedChats = false;
let projectFilter = 'all';
const CHAT_META_KEY = 'synthesis.chat.sidebar';
const SCRATCH_KEY = 'synthesis.scratch.projects';
const OWNED_CHATS_KEY = 'synthesis.chat.ownedSessions';
const localMapCache = new Map();
function readLocalMap(key) {
  try { const raw = localStorage.getItem(key) || '{}'; const cached = localMapCache.get(key); if (cached?.raw === raw) return cached.value; const value = JSON.parse(raw) || {}; localMapCache.set(key, { raw, value }); return value; } catch { return {}; }
}
function rememberConversation(path) { if (!path) return; const owned = readLocalMap(OWNED_CHATS_KEY); if (!owned[path]) { owned[path] = true; localStorage.setItem(OWNED_CHATS_KEY, JSON.stringify(owned)); } }
function chatMeta(key) { return readLocalMap(CHAT_META_KEY)[key] || {}; }
function setChatMeta(key, patch) { const all = readLocalMap(CHAT_META_KEY); all[key] = { ...all[key], ...patch }; localStorage.setItem(CHAT_META_KEY, JSON.stringify(all)); renderList(); }
function moveChatMeta(from, to) { const all = readLocalMap(CHAT_META_KEY); if (all[from]) { all[to] = { ...all[to], ...all[from] }; delete all[from]; localStorage.setItem(CHAT_META_KEY, JSON.stringify(all)); } }
function isScratch(ws) { return !!readLocalMap(SCRATCH_KEY)[ws.id]; }
function setScratch(ws, value) { const all = readLocalMap(SCRATCH_KEY); if (value) all[ws.id] = true; else delete all[ws.id]; localStorage.setItem(SCRATCH_KEY, JSON.stringify(all)); }
async function refreshProjectChats(ws) {
  const cwd = ws.cwd;
  try { const sessions = await window.mux.chat.sessions(cwd, Object.keys(readLocalMap(OWNED_CHATS_KEY))); if (state.workspaces.includes(ws) && ws.cwd === cwd) { ws.chatHistory = sessions; renderList(); } } catch {}
}
function conversationRows() {
  const rows = [], owned = readLocalMap(OWNED_CHATS_KEY), meta = readLocalMap(CHAT_META_KEY);
  const byProject = new Map();
  for (const tab of state.workspaces.flatMap(workspaceTabs)) {
    if (tab.type !== 'chat' || (!tab.hasConversation && !(tab.sessionPath && owned[tab.sessionPath]))) continue;
    const id = tab.projectId || tab.owner.ws.id;
    if (!byProject.has(id)) byProject.set(id, []);
    byProject.get(id).push(tab);
  }
  for (const ws of state.workspaces) {
    const open = byProject.get(ws.id) || [], history = ws.chatHistory || [];
    const histories = new Map(history.map(session => [session.path, session]));
    const paths = new Set(open.map(tab => tab.sessionPath).filter(Boolean));
    for (const tab of open) {
      const key = tab.sessionPath || tab.id, saved = histories.get(tab.sessionPath), info = meta[key] || {};
      rows.push({ ws, tab, key, title: info.title || (tab.title !== 'Chat' ? tab.title : saved?.title) || 'New chat', modified: tab.modified || info.modified || saved?.modified || 0 });
    }
    for (const session of history) if (owned[session.path] && !paths.has(session.path)) {
      const info = meta[session.path] || {};
      rows.push({ ws, session, key: session.path, title: info.title || session.title, modified: info.modified || session.modified });
    }
  }
  return rows;
}
function openConversation(row) {
  if (row.tab) {
    const ownerWs = row.tab.owner.ws, target = row.tab.owner;
    flattenWorkspacePanes(ownerWs, target);
    setActive(ownerWs.id); activateTab(ownerWs, target, row.tab); return;
  }
  const target = row.ws.panes[row.ws.activePaneIdx];
  flattenWorkspacePanes(row.ws, target);
  setActive(row.ws.id);
  addPaneTab(row.ws, target, { type: 'chat', sessionPath: row.session.path });
}
function relativeTime(stamp) {
  if (!stamp) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function conversationMenu(row, x, y) {
  const meta = chatMeta(row.key);
  const items = [
    { label: meta.pinned ? 'Unpin chat' : 'Pin chat', action: () => setChatMeta(row.key, { pinned: !meta.pinned }) },
    { label: meta.archived ? 'Restore chat' : 'Archive chat', action: () => setChatMeta(row.key, { archived: !meta.archived }) },
    'sep',
    { label: isScratch(row.ws) ? 'Turn into project…' : 'Rename project…', action: () => {
      const name = window.prompt('Project name', isScratch(row.ws) ? '' : row.ws.name);
      if (!name || !name.trim()) return;
      row.ws.name = name.trim(); setScratch(row.ws, false); saveWorkspaces(); renderChrome(); renderList();
    } },
    { label: 'New chat in project', action: () => { setActive(row.ws.id); addPaneTab(row.ws, row.ws.panes[row.ws.activePaneIdx], { type: 'chat' }); } },
    'sep',
    { label: 'Delete chat…', action: async () => {
      if (!window.confirm(`Move “${row.title}” to the Trash?`)) return;
      const target = row.tab; const sessionPath = target?.sessionPath || row.session?.path;
      if (target?.isWorking) { window.alert('Stop this chat before deleting it.'); return; }
      if (sessionPath) { const result = await window.mux.chat.remove(target?.chatCwd || row.ws.cwd, sessionPath); if (!result.ok) { window.alert(result.error || 'Could not delete this chat.'); return; } }
      if (target) { const pane = target.owner; const index = pane.tabs.indexOf(target); if (index >= 0) pane.tabs.splice(index, 1); disposeTab(target); if (!pane.tabs.length) addPaneTab(pane.ws, pane, { type: 'chat' }, false); if (pane.activeTab === target) pane.activeTab = pane.tabs.find(item => item.type !== 'terminal') || pane.tabs[0]; activateTab(pane.ws, pane, pane.activeTab); }
      const owned = readLocalMap(OWNED_CHATS_KEY); delete owned[sessionPath]; localStorage.setItem(OWNED_CHATS_KEY, JSON.stringify(owned));
      const meta = readLocalMap(CHAT_META_KEY); delete meta[row.key]; localStorage.setItem(CHAT_META_KEY, JSON.stringify(meta));
      await refreshProjectChats(row.ws); renderList(); saveWorkspaces();
    } },
  ];
  showMenu(x, y, items);
}
function conversationProjectIcon(scratch = false) {
  return `<svg class="project-chat-icon${scratch ? ' scratch' : ''}" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v9H9l-4 3v-3H3z"/></svg>`;
}

function renderList() {
  els.list.replaceChildren();
  const query = $('#workspace-search').value.trim().toLocaleLowerCase();
  const rows = conversationRows().filter(row => {
    const meta = chatMeta(row.key);
    const matchesProject = projectFilter === 'all' || (projectFilter === 'scratch' ? isScratch(row.ws) : row.ws.id === projectFilter);
    return matchesProject && !!meta.archived === showArchivedChats && `${row.title} ${isScratch(row.ws) ? 'No project' : row.ws.name} ${row.ws.cwd}`.toLocaleLowerCase().includes(query);
  });
  rows.sort((a, b) => Number(!!chatMeta(b.key).pinned) - Number(!!chatMeta(a.key).pinned) || (workspaceSortAlphabetically ? a.title.localeCompare(b.title) : b.modified - a.modified));
  for (const row of rows) {
    const { ws, tab } = row; const meta = chatMeta(row.key);
    const card = document.createElement('div'); card.className = 'ws-card chat-card' + (tab && tab.owner.ws.id === state.activeId && tab.owner.ws.panes[tab.owner.ws.activePaneIdx]?.activeTab === tab ? ' active' : '');
    card.dataset.id = ws.id; card.tabIndex = 0; card.draggable = true;
    card.addEventListener('dragstart', event => { draggedConversation = row; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-synthesis-chat', row.key); syncBrowserBounds(); });
    card.addEventListener('dragend', () => { draggedConversation = null; document.querySelectorAll('.tab-drop-target').forEach(el => el.classList.remove('tab-drop-target')); syncBrowserBounds(); }); card.setAttribute('role', 'button'); card.setAttribute('aria-label', `${row.title}, ${isScratch(ws) ? 'No project' : ws.name}`);
    const heading = document.createElement('div'); heading.className = 'conversation-heading';
    const project = document.createElement('span'); project.className = 'conversation-project'; project.innerHTML = conversationProjectIcon(isScratch(ws)); const projectName = document.createElement('span'); projectName.textContent = isScratch(ws) ? 'No project' : ws.name; project.append(projectName);
    const time = document.createElement('span'); time.className = 'conversation-time'; time.dataset.timestamp = String(row.modified || 0); time.textContent = relativeTime(row.modified);
    heading.append(project, time);
    const bottom = document.createElement('div'); bottom.className = 'conversation-bottom';
    const title = document.createElement('span'); title.className = 'conversation-title'; title.textContent = (meta.pinned ? '⌖  ' : '') + row.title;
    const status = document.createElement('span'); status.className = `ws-status ${tab?.isWorking ? 'working' : 'idle'}`; status.setAttribute('aria-label', tab?.isWorking ? 'Working' : 'Idle');
    const indicator = document.createElement('span'); indicator.className = 'ws-status-indicator'; indicator.setAttribute('aria-hidden', 'true');
    if (tab?.isWorking) for (const order of [2,3,4,1,null,5,0,7,6]) { const dot = document.createElement('span'); dot.className = 'ws-status-dot'; if (order !== null) dot.dataset.order = String(order); indicator.append(dot); }
    status.append(indicator);
    bottom.append(title, status); card.append(heading, bottom);
    card.addEventListener('click', () => openConversation(row));
    card.addEventListener('keydown', event => { if (event.target !== card) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openConversation(row); } });
    card.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); conversationMenu(row, event.clientX, event.clientY); });
    els.list.append(card);
  }
  if (!rows.length) { const empty = document.createElement('div'); empty.className = 'conversation-empty'; empty.textContent = query ? 'No chats match your search.' : showArchivedChats ? 'No archived chats in this view.' : projectFilter !== 'all' ? 'No chats in this project yet.' : 'Start a chat to see it here.'; els.list.append(empty); }
  els.wsCount.textContent = `${rows.length} ${rows.length === 1 ? 'chat' : 'chats'}`;
}

const relativeTimeTimer = setInterval(() => { document.querySelectorAll('.conversation-time[data-timestamp]').forEach(time => { time.textContent = relativeTime(Number(time.dataset.timestamp)); }); }, 60000);
window.addEventListener('beforeunload', () => clearInterval(relativeTimeTimer));

function startRename(card, ws) {
  const nameEl = card.querySelector('.ws-name');
  nameEl.textContent = ws.name;
  nameEl.contentEditable = 'true';
  nameEl.classList.add('editing');
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const value = nameEl.textContent.trim();
    nameEl.contentEditable = 'false';
    nameEl.classList.remove('editing');
    if (save && value) ws.name = value;
    renderList();
    renderChrome();
    saveWorkspaces();
  };
  nameEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  nameEl.addEventListener('blur', () => commit(true), { once: true });
}

function renderChrome() {
  const ws = activeWs();
  if (!ws) return;
  els.title.textContent = ws.name;
  els.statusWs.textContent = ws.name;
  els.statusCwd.textContent = shortPath(ws.cwd);

  const totalPanes = ws.panes.length;
  els.statusPts.textContent = totalPanes + (totalPanes === 1 ? ' pane' : ' panes');
}

/* ---------------- file viewer ---------------- */

/* ---------------- file viewer ---------------- */
/* The existing collapsible right-hand panel — improved, not replaced:
 * filter/search, hidden-file toggle, optional lazy tree mode, watcher-backed
 * refresh and richer read-only previews. */

const FILE_ICONS = { dir: '▸', code: '‹›', text: '¶', image: '▦', archive: '▣', file: '·' };
let fileListRequestSeq = 0;

function joinPath(dir, name) {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

function matchesFileFilter(ent, treeMode) {
  if (!state.showHidden && ent.name.startsWith('.')) return false;
  const f = state.fileFilter.trim().toLowerCase();
  if (!f) return true;
  if (treeMode && ent.isDir) return true; // directories are containers
  return ent.name.toLowerCase().includes(f);
}

function applyFilesMode(mode) {
  state.filesView = mode;
  localStorage.setItem(FILES_VIEW_STORAGE_KEY, mode);
  updateFilesControls();
}

function refreshFilesView() {
  if (state.filesView === 'tree') {
    const root = (activeWs() && activeWs().cwd) || state.home;
    if (treeState.root === root) {
      for (const dir of treeState.expanded) loadTreeChildren(dir, true);
    }
    renderTree();
  } else loadDir(state.fileDir || (activeWs() ? activeWs().cwd : state.home));
}

function updateFilesControls() {
  if (!els.filesHidden) return;
  els.filesHidden.classList.toggle('active', state.showHidden);
  els.filesHidden.dataset.tip = state.showHidden ? 'Hide hidden files' : 'Show hidden files';
  els.filesHidden.setAttribute('aria-pressed', String(state.showHidden));
  els.filesViewBtn.textContent = state.filesView === 'tree' ? 'list' : 'tree';
  els.filesViewBtn.dataset.tip = state.filesView === 'tree' ? 'Switch to list view' : 'Switch to tree view';
}

function setFilesStatus(text, retryLabel, onRetry) {
  els.filesBody.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'files-msg';
  msg.textContent = text;
  els.filesBody.appendChild(msg);
  if (retryLabel && onRetry) {
    const retry = document.createElement('button');
    retry.className = 'ghost-btn files-retry';
    retry.textContent = retryLabel;
    retry.addEventListener('click', onRetry);
    els.filesBody.appendChild(retry);
  }
}

/* --- list mode --- */

async function loadDir(dir) {
  applyFilesMode('list');
  state.preview = null;
  const requestSeq = ++fileListRequestSeq;
  const requestedWorkspace = activeWs();
  setFilesStatus('Loading…');
  const res = await window.mux.fs.list(dir).catch((error) => ({
    ok: false,
    path: String(dir || ''),
    error: error && error.message ? error.message : String(error),
    entries: [],
  }));
  if (requestSeq !== fileListRequestSeq || state.filesView !== 'list' || activeWs() !== requestedWorkspace) return;
  state.fileDir = res.path;
  if (requestedWorkspace) requestedWorkspace.fileDir = res.path;
  state.lastList = res;
  saveWorkspaces();
  renderCrumb(res.path);
  renderDirListing();
  if (res.ok) watchDirectory(res.path);
}

function renderDirListing() {
  const res = state.lastList;
  els.filesBody.innerHTML = '';
  if (!res) return;
  if (!res.ok) {
    setFilesStatus(`Cannot open folder\n${res.error || ''}`, 'Retry', () => loadDir(res.path));
    els.filesMeta.textContent = '';
    return;
  }

  if (!res.isRoot) {
    const row = document.createElement('div');
    row.className = 'file-row parent-row';
    row.tabIndex = 0;
    row.innerHTML = '<span class="f-icon">↰</span><span class="f-name">..</span>';
    const goUp = () => loadDir(res.parent);
    row.addEventListener('click', goUp);
    row.addEventListener('keydown', (e) => rowKeyNav(row, e, goUp));
    els.filesBody.appendChild(row);
  }

  const entries = res.entries.filter((ent) => matchesFileFilter(ent, false));
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'files-msg';
    empty.textContent = state.fileFilter.trim() ? 'No matches' : 'Empty folder';
    els.filesBody.appendChild(empty);
  }
  for (const ent of entries) {
    const full = joinPath(res.path, ent.name);
    els.filesBody.appendChild(fileRow(ent, full, 0));
  }

  els.filesMeta.textContent = `${res.entries.length} items · ${shortPath(res.path)}` +
    (entries.length !== res.entries.length ? ` · ${entries.length} shown` : '');
}

function kindIcon(ent) {
  const icon = document.createElement('span');
  const kind = ent.broken ? 'broken' : (ent.isDir ? 'dir' : (ent.kind || 'file'));
  icon.className = `f-icon kind-${kind}`;
  if (ent.isDir && !ent.broken) {
    icon.innerHTML = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2h3L8 4h6.5A1.5 1.5 0 0 1 16 5.5v8A1.5 1.5 0 0 1 14.5 15h-11A1.5 1.5 0 0 1 2 13.5Z"/></svg>';
  } else icon.textContent = ent.broken ? '⚠' : (FILE_ICONS[ent.kind || 'file'] || '·');
  return icon;
}

function rowKeyNav(row, e, activate) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = [...els.filesBody.querySelectorAll('.file-row')];
    const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  }
}

function fileRow(ent, full, depth, activateFn) {
  const row = document.createElement('div');
  row.className = 'file-row' + (ent.isDir ? ' is-dir' : '');
  row.tabIndex = 0;
  if (depth) row.style.paddingLeft = (10 + depth * 14) + 'px';

  const name = document.createElement('span');
  name.className = 'f-name';
  name.textContent = ent.name;

  const size = document.createElement('span');
  size.className = 'f-size';
  size.textContent = ent.isDir ? '' : fmtSize(ent.size);

  row.append(kindIcon(ent), name, size);
  const activate = activateFn || (() => {
    if (ent.isDir) loadDir(full);
    else previewFile(full, ent.name);
  });
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (e) => rowKeyNav(row, e, activate));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, fileRowMenu(full, ent));
  });
  return row;
}

/* --- tree mode (workspace-scoped default; list remains available) --- */

function renderTree() {
  if (state.preview) return; // never clobber an open preview
  const ws = activeWs();
  const root = (ws && ws.cwd) || state.home;
  if (treeState.root !== root) {
    treeState.root = root;
    treeState.expanded = new Set([root]);
    treeState.children = new Map();
    treeState.loading = new Set();
    treeState.errors = new Map();
    treeState.generation += 1;
    renderCrumb(root);
    loadTreeChildren(root);
  }
  els.filesBody.innerHTML = '';
  const frag = document.createDocumentFragment();
  buildTreeRows(root, 0, frag);
  els.filesBody.appendChild(frag);
  els.filesMeta.textContent = `tree · ${shortPath(root)}`;
  watchDirectory(root);
}

function buildTreeRows(dir, depth, frag) {
  if (treeState.loading.has(dir)) {
    const loading = document.createElement('div');
    loading.className = 'files-msg tree-loading';
    loading.style.paddingLeft = `${12 + depth * 14}px`;
    loading.textContent = 'Loading…';
    frag.appendChild(loading);
    return;
  }
  if (treeState.errors.has(dir)) {
    const error = document.createElement('div');
    error.className = 'tree-error-row';
    error.style.paddingLeft = `${12 + depth * 14}px`;
    const message = document.createElement('span');
    message.textContent = `Cannot load folder · ${treeState.errors.get(dir)}`;
    const retry = document.createElement('button');
    retry.className = 'ghost-btn tree-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => loadTreeChildren(dir, true));
    error.append(message, retry);
    frag.appendChild(error);
    return;
  }
  const entries = (treeState.children.get(dir) || []).filter((ent) => matchesFileFilter(ent, true));
  for (const ent of entries) {
    const full = joinPath(dir, ent.name);
    frag.appendChild(treeRow(ent, full, depth));
    if (ent.isDir && treeState.expanded.has(full)) buildTreeRows(full, depth + 1, frag);
  }
}

function treeRow(ent, full, depth) {
  const row = fileRow(ent, full, depth, () => {
    if (ent.isDir) toggleTreeDir(full);
    else previewFile(full, ent.name);
  });
  row.classList.add('tree-row');
  row.style.paddingLeft = `${6 + depth * 14 + (ent.isDir ? 0 : 19)}px`;
  if (ent.isDir) {
    const chev = document.createElement('span');
    chev.className = 'tree-chev';
    chev.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>';
    chev.classList.toggle('expanded', treeState.expanded.has(full));
    row.setAttribute('aria-expanded', String(treeState.expanded.has(full)));
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTreeDir(full);
    });
    row.insertBefore(chev, row.firstChild);
  }
  return row;
}

function toggleTreeDir(full) {
  if (treeState.expanded.has(full)) treeState.expanded.delete(full);
  else {
    treeState.expanded.add(full);
    loadTreeChildren(full);
  }
  renderTree();
}

async function loadTreeChildren(dir, force = false) {
  if (treeState.loading.has(dir)) return;
  if (!force && treeState.children.has(dir) && !treeState.errors.has(dir)) return;
  const generation = treeState.generation;
  const loading = treeState.loading;
  const children = treeState.children;
  const errors = treeState.errors;
  loading.add(dir);
  errors.delete(dir);
  if (state.filesView === 'tree') renderTree();
  try {
    const res = await window.mux.fs.list(dir);
    if (generation !== treeState.generation) return;
    if (!res || !res.ok) {
      children.delete(dir);
      errors.set(dir, (res && res.error) || 'Unable to read directory');
    } else {
      children.set(dir, res.entries);
      errors.delete(dir);
    }
  } catch (error) {
    if (generation !== treeState.generation) return;
    children.delete(dir);
    errors.set(dir, error && error.message ? error.message : String(error));
  } finally {
    loading.delete(dir);
    if (generation === treeState.generation && state.filesView === 'tree') renderTree();
  }
}

/* --- watcher-backed refresh (single watcher for the visible directory) --- */

let watchedDir = null;
function watchDirectory(dir) {
  if (watchedDir === dir) return;
  watchedDir = dir;
  window.mux.fs.watch(dir);
}

function handleFsChanged(m) {
  if (!m || !m.path) return;
  if (state.filesView === 'tree') {
    if (treeState.children.has(m.path) || m.path === treeState.root) loadTreeChildren(m.path, true);
    return;
  }
  if (state.preview) return; // never clobber an open preview
  if (m.path === state.fileDir) {
    window.mux.fs.list(m.path).then((res) => {
      state.lastList = res;
      renderDirListing();
    });
  }
}

function renderCrumb(dir) {
  els.crumb.innerHTML = '';
  const rootLabel = $('#files-root');
  rootLabel.textContent = basename(dir) || '/';
  rootLabel.title = dir;
  const home = state.home || '';
  const rel = home && (dir === home || dir.startsWith(home + '/'))
    ? dir.slice(home.length)
    : null;
  const parts = rel !== null
    ? ['~', ...rel.split('/').filter(Boolean)]
    : dir.split('/').filter(Boolean);

  let acc = '';
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      els.crumb.appendChild(sep);
    }
    if (i === 0 && part === '~') acc = home;
    else acc = acc ? acc + '/' + part : '/' + part;
    const target = acc;
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = part;
    crumb.addEventListener('click', () => loadDir(target));
    els.crumb.appendChild(crumb);
  });
}

/* --- read-only preview: line numbers, wrapping, light syntax highlighting,
 *     and explicit size/line limits (main process is the source of truth) --- */

const HL_PATTERNS = {
  js: {
    comment: /\/\/.*$|\/\*[\s\S]*?\*\//,
    string: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/,
    number: /\b\d+(?:\.\d+)?\b/,
    keyword: /\b(?:const|let|var|function|return|if|else|for|while|class|extends|new|import|export|from|async|await|try|catch|finally|throw|typeof|instanceof|this|super|switch|case|break|continue|default|delete|in|of|do|yield|static|null|undefined|true|false)\b/,
  },
  json: {
    key: /"(?:[^"\\]|\\.)*"(?=\s*:)/,
    string: /"(?:[^"\\]|\\.)*"/,
    number: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/,
    keyword: /\b(?:true|false|null)\b/,
  },
  css: {
    comment: /\/\*[\s\S]*?\*\//,
    string: /"[^"\\]*"|'[^'\\]*'/,
    keyword: /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|fr)?\b/,
    key: /[a-z-]+(?=\s*:)/,
  },
  html: {
    comment: /<!--[\s\S]*?-->/,
    string: /"[^"\\]*"|'[^'\\]*'/,
    tag: /<\/?[a-zA-Z][^<>]*>/,
  },
  md: {
    heading: /^#{1,6} .*$/,
    string: /`[^`]*`|\*\*[^*]+\*\*/,
    key: /\[[^\]]*\]\([^)]*\)/,
  },
  py: {
    comment: /#.*$/,
    string: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,
    number: /\b\d+(?:\.\d+)?\b/,
    keyword: /\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|in|is|not|and|or|None|True|False|self)\b/,
  },
  sh: {
    comment: /#.*$/,
    string: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/,
    number: /\b\d+(?:\.\d+)?\b/,
    keyword: /\b(?:if|then|else|elif|fi|for|do|done|while|case|esac|function|export|local|return|echo|cd|source)\b/,
  },
};

const HL_COMBINED = {};
function highlightRegex(lang) {
  if (!HL_PATTERNS[lang]) return null;
  if (!HL_COMBINED[lang]) {
    const names = Object.keys(HL_PATTERNS[lang]);
    const source = names.map((n) => '(' + HL_PATTERNS[lang][n].source + ')').join('|');
    HL_COMBINED[lang] = { re: new RegExp(source, 'g'), names };
  }
  return HL_COMBINED[lang];
}

function langForFile(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'js';
  if (ext === '.json') return 'json';
  if (['.css', '.scss', '.less'].includes(ext)) return 'css';
  if (['.html', '.htm', '.xml', '.svg', '.vue', '.svelte'].includes(ext)) return 'html';
  if (['.md', '.markdown'].includes(ext)) return 'md';
  if (ext === '.py') return 'py';
  if (['.sh', '.zsh', '.bash'].includes(ext)) return 'sh';
  return 'plain';
}

function appendHighlighted(parent, line, lang) {
  const hl = highlightRegex(lang);
  if (!hl) {
    parent.textContent = line || ' ';
    return;
  }
  const { re, names } = hl;
  re.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (!m[0].length) { re.lastIndex += 1; continue; }
    if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
    const span = document.createElement('span');
    const groupIdx = names.findIndex((_, i) => m[i + 1] !== undefined);
    span.className = 'tok-' + (names[groupIdx] || 'plain');
    span.textContent = m[0];
    parent.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
  if (!parent.childNodes.length) parent.textContent = ' ';
}

function renderCodeLines(container, lines, name) {
  const lang = langForFile(name);
  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const row = document.createElement('div');
    row.className = 'code-line';
    const ln = document.createElement('span');
    ln.className = 'ln';
    ln.textContent = String(i + 1);
    const lc = document.createElement('span');
    lc.className = 'lc';
    appendHighlighted(lc, line, lang);
    row.append(ln, lc);
    frag.appendChild(row);
  });
  container.appendChild(frag);
}

function closePreview() {
  state.preview = null;
  refreshFilesView();
}

async function previewFile(full, name) {
  state.preview = { full, name };
  els.filesBody.innerHTML = '<div class="files-msg">Loading…</div>';
  const res = await window.mux.fs.read(full);
  if (!state.preview || state.preview.full !== full) return;
  els.filesBody.innerHTML = '';

  const head = document.createElement('div');
  head.id = 'preview-head';

  const back = document.createElement('button');
  back.className = 'icon-btn';
  back.dataset.tip = 'Back to file list';
  back.textContent = '←';
  back.addEventListener('click', closePreview);

  const nameEl = document.createElement('span');
  nameEl.className = 'f-name';
  nameEl.textContent = name;

  const wrapBtn = document.createElement('button');
  wrapBtn.className = 'icon-btn' + (state.previewWrap ? ' active' : '');
  wrapBtn.dataset.tip = 'Toggle line wrapping';
  wrapBtn.textContent = '↩';
  wrapBtn.setAttribute('aria-pressed', String(state.previewWrap));
  wrapBtn.addEventListener('click', () => {
    state.previewWrap = !state.previewWrap;
    localStorage.setItem('mux.ui.previewWrap', state.previewWrap ? '1' : '0');
    wrapBtn.classList.toggle('active', state.previewWrap);
    wrapBtn.setAttribute('aria-pressed', String(state.previewWrap));
    code.classList.toggle('wrap', state.previewWrap);
  });

  head.append(back, nameEl, wrapBtn);

  const code = document.createElement('div');
  code.id = 'preview-code';
  code.classList.toggle('wrap', state.previewWrap);

  const limits = res.limits || previewLimits;
  if (res.ok) {
    const allLines = res.text.split('\n');
    const shown = allLines.slice(0, limits.maxLines);
    renderCodeLines(code, shown, name);
    let meta = `${name} · ${fmtSize(res.size)} · ${allLines.length.toLocaleString()} lines`;
    if (allLines.length > limits.maxLines) {
      meta += ` · preview limited to ${limits.maxLines.toLocaleString()} lines`;
    }
    els.filesMeta.textContent = meta;
  } else {
    const msg = document.createElement('div');
    msg.className = 'files-msg';
    if (res.binary) msg.textContent = '▪ Binary file — preview unavailable';
    else if (res.error === 'File too large to preview') {
      msg.textContent = `▪ File too large to preview (limit ${fmtSize(limits.maxBytes)})`;
    } else msg.textContent = `▪ ${res.error}`;
    code.appendChild(msg);
    els.filesMeta.textContent = name + (res.size ? ` · ${fmtSize(res.size)}` : '');
  }

  els.filesBody.append(head, code);
}

/* native file/folder picker */
async function openPicker() {
  const picked = await window.mux.app.pickPath();
  if (!picked) return;
  setFsCollapsed(false);
  const asDir = await window.mux.fs.list(picked);
  if (asDir.ok) {
    loadDir(picked);
  } else {
    await loadDir(dirname(picked));
    previewFile(picked, basename(picked));
  }
}

/* ---------------- context menus ---------------- */

function paneMenu(ws, pane) {
  const isMultiple = ws.panes.length > 1;
  const items = [
    { label: 'Add New Chat Tab', disabled: pane.tabs.length >= MAX_PANE_TABS, action: () => addPaneTab(ws, pane, { type: 'chat' }) },
    { label: 'New Browser Tab', disabled: pane.tabs.length >= MAX_PANE_TABS, action: () => addPaneTab(ws, pane, { type: 'browser' }) },
    { label: 'Close Tab', action: () => closePaneTab(ws, pane, pane.activeTab) },
    'sep',
    { label: 'Split Right', hint: '→', action: () => splitPane(ws, pane, 'row') },
    { label: 'Split Down', hint: '↓', action: () => splitPane(ws, pane, 'col') },
    { label: 'Open Browser Right', hint: formatShortcut(appSettings.shortcuts.browserRight), action: () => splitPane(ws, pane, 'row', 'browser') },
    { label: 'Open Browser Down', hint: formatShortcut(appSettings.shortcuts.browserDown), action: () => splitPane(ws, pane, 'col', 'browser') },
    'sep',
  ];

  if (pane.type === 'terminal') {
    items.push(
      { label: 'View Saved History', action: () => openSavedHistory(ws, pane) },
      {
        label: 'Copy',
        hint: '⌘C',
        disabled: !pane.term.hasSelection(),
        action: () => navigator.clipboard.writeText(pane.term.getSelection()),
      },
      {
        label: 'Paste',
        hint: '⌘V',
        action: () => navigator.clipboard.readText().then((t) => sendPaneInput(ws, pane, t)),
      },
      'sep',
      { label: 'Clear Terminal', action: () => pane.term.clear() },
    );
  } else if (pane.type === 'browser') {
    items.push(
      { label: 'Open in Default Browser', action: () => window.mux.browser.openExternal(surfaceId(pane)) },
      { label: 'Zoom In', action: () => setBrowserZoom(ws, pane, (pane.zoom || 1) + 0.1) },
      { label: 'Zoom Out', action: () => setBrowserZoom(ws, pane, (pane.zoom || 1) - 0.1) },
      { label: 'Reset Zoom', action: () => setBrowserZoom(ws, pane, 1) },
      'sep',
      {
        label: 'Clear Browser Data…',
        hint: 'cookies & storage',
        action: () => {
          if (window.confirm('Clear cookies, storage and cache for the built-in browser profile?')) {
            window.mux.browser.clearData();
          }
        },
      },
    );
  }

  items.push(
    'sep',
    {
      label: 'Close Pane',
      hint: isMultiple ? '' : 'last pane',
      disabled: !isMultiple,
      danger: true,
      action: () => closePane(ws, pane),
    },
    'sep',
    { label: 'Rename Workspace', action: () => {
      const card = els.list.querySelector(`.ws-card[data-id="${ws.id}"]`);
      if (card) startRename(card, ws);
    } },
  );
  return items;
}

function setBrowserZoom(ws, pane, zoom) {
  pane = pane.activeTab || pane;
  window.mux.browser.zoom(surfaceId(pane), zoom).then((res) => {
    if (res && res.ok) {
      pane.zoom = res.zoom;
      saveWorkspaces();
    }
  });
}

async function changeWorkspaceDirectory(ws) {
  const dir = await window.mux.app.pickDirectory(ws.cwd);
  if (!dir || !state.workspaces.includes(ws)) return;
  ws.cwd = dir;
  ws.fileDir = dir;
  saveWorkspaces();
  renderList();
  if (ws.id === state.activeId) {
    state.fileDir = dir;
    state.preview = null;
    renderChrome();
    refreshFilesView();
  }
  window.alert('Workspace directory updated. New chats will use this folder; existing chats keep their original context.');
}

function workspaceCardMenu(ws) {
  return [
    { label: 'Open Workspace', disabled: ws.id === state.activeId, action: () => setActive(ws.id) },
    { label: 'Change Workspace Directory…', action: () => changeWorkspaceDirectory(ws) },
    { label: 'Rename', hint: 'double-click', action: () => {
      const card = els.list.querySelector(`.ws-card[data-id="${ws.id}"]`);
      if (card) startRename(card, ws);
    } },
    'sep',
    { label: 'Split Right', action: () => {
      setActive(ws.id);
      splitPane(ws, ws.panes[ws.activePaneIdx], 'row');
    } },
    { label: 'Split Down', action: () => {
      setActive(ws.id);
      splitPane(ws, ws.panes[ws.activePaneIdx], 'col');
    } },
    { label: 'Open Browser Right', action: () => {
      setActive(ws.id);
      splitPane(ws, ws.panes[ws.activePaneIdx], 'row', 'browser');
    } },
    { label: 'Open Browser Down', action: () => {
      setActive(ws.id);
      splitPane(ws, ws.panes[ws.activePaneIdx], 'col', 'browser');
    } },
    'sep',
    { label: 'Delete Workspace', danger: true, action: () => {
      if (window.confirm(`Delete “${ws.name}” from Synthesis? Its running terminal processes will be stopped. Files in its folder will not be deleted.`)) {
        closeWorkspace(ws.id, { confirmed: true });
      }
    } },
  ];
}

function cdInTerminal(path) {
  const ws = activeWs();
  if (!ws) return;
  const pane = ws.panes[ws.activePaneIdx] && ws.panes[ws.activePaneIdx].type === 'terminal'
    ? ws.panes[ws.activePaneIdx]
    : ws.panes.find((p) => p.type === 'terminal');
  if (!pane) return;
  sendPaneInput(ws, pane, `cd ${shellQuote(path)}\n`);
  focusPaneSurface(pane);
}

function fileRowMenu(full, ent) {
  const items = [
    ent.isDir
      ? { label: 'Open Folder', action: () => loadDir(full) }
      : { label: 'Preview File', action: () => previewFile(full, ent.name) },
    ent.isDir
      ? { label: 'Open in Terminal', hint: 'cd', action: () => cdInTerminal(full) }
      : { label: 'cd to Folder in Terminal', hint: 'cd', action: () => cdInTerminal(dirname(full)) },
    'sep',
    { label: 'Copy Path', action: () => navigator.clipboard.writeText(full) },
    { label: 'Reveal in Finder', action: () => window.mux.fs.reveal(full).then((res) => {
      if (!res.ok) setFilesStatus(`Cannot reveal in Finder\n${res.error || ''}`);
    }) },
    {
      label: 'Open Externally',
      hint: ent.executable ? 'executables blocked' : 'default app',
      disabled: ent.isDir || ent.executable || ent.broken,
      action: () => window.mux.fs.openExternal(full).then((res) => {
        if (!res.ok) setFilesStatus(`Cannot open externally\n${res.error || ''}`);
      }),
    },
  ];
  return items;
}

function filesBackgroundMenu() {
  return [
    { label: 'Refresh', hint: '↻', action: () => refreshFilesView() },
    { label: 'Open File or Folder…', hint: '⌘O', action: openPicker },
    { label: 'Go to Workspace Directory', hint: '⌂', action: () => {
      const ws = activeWs();
      loadDir(ws ? ws.cwd : state.home);
    } },
    'sep',
    { label: state.showHidden ? 'Hide Hidden Files' : 'Show Hidden Files', action: toggleHiddenFiles },
    { label: state.filesView === 'tree' ? 'Switch to List View' : 'Switch to Tree View', action: toggleFilesView },
  ];
}

function toggleHiddenFiles() {
  state.showHidden = !state.showHidden;
  localStorage.setItem('mux.ui.showHidden', state.showHidden ? '1' : '0');
  updateFilesControls();
  refreshFilesView();
}

function toggleFilesView() {
  state.preview = null;
  applyFilesMode(state.filesView === 'tree' ? 'list' : 'tree');
  refreshFilesView();
}

/* ---------------- Git panel ---------------- */
let gitRefreshSequence = 0, gitVisibleChanges = [], gitStatusCwd = null;
function activeGitWorkspace() { const ws = activeWs(); const tab = ws?.panes[ws.activePaneIdx]?.activeTab; return state.workspaces.find(project => project.id === tab?.projectId) || ws; }
function activeGitCwd() { const ws = activeWs(); const tab = ws?.panes[ws.activePaneIdx]?.activeTab; return tab?.chatCwd || activeGitWorkspace()?.cwd; }
async function refreshGitPanel() {
  if ($('#git-panel').hidden) return;
  const ws = activeGitWorkspace(), seq = ++gitRefreshSequence;
  const repo = $('#git-repo'), empty = $('#git-empty'), init = $('#git-init');
  init.hidden = true; $('#git-clone-details').hidden = true;
  if (!ws) { repo.hidden = true; empty.hidden = false; $('#git-empty-message').textContent = 'Open a project to use Git.'; return; }
  const cwd = activeGitCwd();
  const result = await window.mux.git.status(cwd).catch(() => ({ ok: false }));
  if (seq !== gitRefreshSequence) return;
  repo.hidden = !result.ok; empty.hidden = !!result.ok;
  if (!result.ok) { $('#git-empty-message').textContent = result.error || 'This folder is not a Git repository.'; init.hidden = !result.canInit; $('#git-clone-details').hidden = !result.canInit; if (gitStatusCwd !== cwd) $('#git-clone-url').value = ''; gitStatusCwd = cwd; return; }
  const remoteInput = $('#git-remote-url'), remote = result.remote || '';
  if (gitStatusCwd !== cwd || remoteInput.value === (remoteInput.dataset.original || '')) remoteInput.value = remote;
  remoteInput.dataset.original = remote; gitStatusCwd = cwd;
  $('#git-remote-summary').textContent = remote ? 'Manage repository connection' : 'Connect repository';
  $('#git-remote-save').textContent = remote ? 'Update repository' : 'Connect repository';
  $('#git-current-branch').textContent = result.branch;
  const branches = $('#git-branches'); branches.replaceChildren();
  for (const branch of result.branches) branches.add(new Option(branch, branch));
  if (!result.branches.includes(result.branch)) branches.add(new Option(result.branch, result.branch));
  branches.value = result.branch;
  gitVisibleChanges = result.changes;
  $('#git-stage-all').disabled = !result.changes.some(change => change.unstaged);
  $('#git-unstage-all').disabled = !result.changes.some(change => change.staged);
  const list = $('#git-changes'); list.replaceChildren();
  const counts = result.counts || { added: 0, deleted: 0 };
  const count = $('#git-count'); count.replaceChildren();
  const added = document.createElement('span'); added.className = 'git-count-added'; added.textContent = `+${counts.added}`;
  const deleted = document.createElement('span'); deleted.className = 'git-count-deleted'; deleted.textContent = `−${counts.deleted}`;
  count.append(added, deleted);
  if (counts.incomplete) { const marker = document.createElement('span'); marker.textContent = '*'; count.append(marker); }
  $('#git-count').title = counts.incomplete ? 'Some binary or large files are not included in the line counts.' : `${result.changes.length} changed files`;
  if (!result.changes.length) { const clean = document.createElement('div'); clean.className = 'git-empty'; clean.textContent = 'No uncommitted changes.'; list.append(clean); }
  for (const change of result.changes) {
    const line = document.createElement('div'); line.className = 'git-file';
    const name = document.createElement('span'); name.textContent = change.path; name.title = change.path; line.append(name);
    if (change.unstaged) { const stage = document.createElement('button'); stage.textContent = 'Stage'; stage.title = 'Stage ' + change.path; stage.addEventListener('click', () => runGitAction('stage', { paths: [change.path] })); line.append(stage); }
    if (change.staged) { const unstage = document.createElement('button'); unstage.textContent = 'Unstage'; unstage.title = 'Unstage ' + change.path; unstage.addEventListener('click', () => runGitAction('unstage', { paths: [change.path] })); line.append(unstage); }
    list.append(line);
  }
}
async function runGitAction(action, data = {}) {
  const ws = activeGitWorkspace(), cwd = activeGitCwd(); if (!ws || !cwd) return;
  const feedback = $('#git-feedback'); feedback.textContent = 'Working…';
  const commitButtons = [$('#git-commit'), $('#git-commit-push')];
  const committing = action === 'commit' || action === 'commitAndPush';
  const repositoryButtons = [$('#git-init'), $('#git-clone'), $('#git-remote-save')];
  const changingRepository = ['init', 'clone', 'connectRemote'].includes(action);
  if (changingRepository) repositoryButtons.forEach(button => { button.disabled = true; });
  if (committing) commitButtons.forEach(button => { button.disabled = true; });
  const result = await window.mux.git.action(cwd, action, data).catch(error => ({ ok: false, error: error.message }));
  if (committing) commitButtons.forEach(button => { button.disabled = false; });
  if (changingRepository) repositoryButtons.forEach(button => { button.disabled = false; });
  feedback.textContent = result.ok ? (action === 'connectRemote' ? 'Repository connected.' : action === 'clone' ? 'Repository cloned.' : result.output || 'Done.') : result.committed ? `Commit created, but push failed: ${result.error || 'Git push failed.'}` : (result.error || 'Git action failed.');
  if ((result.ok && committing) || result.committed) $('#git-message').value = '';
  if (activeGitCwd() === cwd) refreshGitPanel();
}
$('#git-refresh').addEventListener('click', refreshGitPanel);
$('#git-init').addEventListener('click', () => runGitAction('init'));
$('#git-clone').addEventListener('click', () => runGitAction('clone', { url: $('#git-clone-url').value }));
$('#git-remote-save').addEventListener('click', () => runGitAction('connectRemote', { url: $('#git-remote-url').value }));
$('#git-branches').addEventListener('change', event => runGitAction('switch', { branch: event.target.value }));
$('#git-new-branch').addEventListener('click', () => { const name = window.prompt('New branch name'); if (name?.trim()) runGitAction('createBranch', { branch: name.trim() }); });
$('#git-commit').addEventListener('click', () => runGitAction('commit', { message: $('#git-message').value }));
$('#git-commit-push').addEventListener('click', () => runGitAction('commitAndPush', { message: $('#git-message').value }));
$('#git-stage-all').addEventListener('click', () => runGitAction('stage', { paths: gitVisibleChanges.filter(change => change.unstaged).map(change => change.path) }));
$('#git-unstage-all').addEventListener('click', () => runGitAction('unstage', { paths: gitVisibleChanges.filter(change => change.staged).map(change => change.path) }));
$('#git-panel').addEventListener('click', async event => {
  const git = event.target.closest('[data-git-action]'); if (git) { runGitAction(git.dataset.gitAction); return; }
  const gh = event.target.closest('[data-github-action]'); if (!gh || !activeGitWorkspace()) return;
  const result = await window.mux.git.github(activeGitCwd(), gh.dataset.githubAction).catch(error => ({ ok: false, error: error.message }));
  $('#git-feedback').textContent = result.ok ? 'Opened GitHub.' : result.error;
});

let gitReviewSequence = 0, gitReviewOptions = { branches: [], commits: [] };
function updateGitReviewOptions(scope) {
  const label = $('#git-review-ref-label'), select = $('#git-review-ref');
  const previous = select.value;
  label.hidden = scope === 'working';
  $('#git-review-ref-title').textContent = scope === 'branch' ? 'Base branch' : 'Commit';
  select.replaceChildren();
  const options = scope === 'branch' ? gitReviewOptions.branches.map(branch => ({ id: branch, text: branch })) : gitReviewOptions.commits.map(commit => ({ id: commit.id, text: `${commit.id} ${commit.subject}` }));
  for (const option of options) select.add(new Option(option.text, option.id));
  if (options.some(option => option.id === previous)) select.value = previous;
  else if (scope === 'branch') { const fallback = options.find(option => option.id === 'main') || options.find(option => option.id === 'master'); if (fallback) select.value = fallback.id; }
}
async function loadGitReview(refreshOptions = false) {
  const cwd = activeGitCwd(), scope = $('#git-review-scope').value, seq = ++gitReviewSequence;
  if (!cwd) return;
  $('#git-review-output').textContent = 'Loading changes…';
  // Fetch the option lists with the working-tree request before choosing a base/commit.
  if (refreshOptions && scope !== 'working') {
    const metadata = await window.mux.git.review(cwd, 'working').catch(error => ({ ok: false, error: error.message }));
    if (seq !== gitReviewSequence) return;
    if (!metadata.ok) { $('#git-review-output').textContent = metadata.error; return; }
    gitReviewOptions = metadata; updateGitReviewOptions(scope);
  }
  const ref = scope === 'working' ? '' : $('#git-review-ref').value;
  if (scope !== 'working' && !ref) { $('#git-review-output').textContent = scope === 'branch' ? 'No local base branches available.' : 'No local commits available.'; return; }
  const result = await window.mux.git.review(cwd, scope, ref).catch(error => ({ ok: false, error: error.message }));
  if (seq !== gitReviewSequence || activeGitCwd() !== cwd) return;
  if (!result.ok) { $('#git-review-output').textContent = result.error || 'Could not read changes.'; return; }
  gitReviewOptions = result; updateGitReviewOptions(scope);
  $('#git-review-note').textContent = result.truncated ? 'Diff shortened to 1 MB.' : scope === 'working' ? 'Staged, unstaged and untracked changes in this working folder.' : scope === 'branch' ? 'Changes since the selected branch’s common ancestor.' : 'Changes introduced by the selected commit.';
  const output = $('#git-review-output'), lines = result.output.split('\n'), fragment = document.createDocumentFragment(); output.replaceChildren();
  for (const line of lines.slice(0, 6000)) { const row = document.createElement('span'); row.className = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''; row.textContent = line || '\u00a0'; fragment.append(row); }
  if (lines.length > 6000) $('#git-review-note').textContent = 'Showing the first 6,000 diff lines.';
  output.append(fragment);
}
$('#git-review-open').addEventListener('click', () => {
  $('#git-menu-content').hidden = true; $('#git-review').hidden = false; $('#git-panel').classList.add('reviewing');
  $('#git-review-scope').value = 'working'; updateGitReviewOptions('working'); positionGitPanel(); loadGitReview();
});
$('#git-review-close').addEventListener('click', () => { ++gitReviewSequence; $('#git-review').hidden = true; $('#git-menu-content').hidden = false; $('#git-panel').classList.remove('reviewing'); positionGitPanel(); $('#git-review-open').focus(); });
$('#git-review-scope').addEventListener('change', () => { const scope = $('#git-review-scope').value; updateGitReviewOptions(scope); loadGitReview(true); });
$('#git-review-ref').addEventListener('change', () => loadGitReview());
$('#git-panel').addEventListener('toggle', () => requestAnimationFrame(positionGitPanel), true);

/* ---------------- panel collapse ---------------- */

function setWsCollapsed(collapsed) {
  els.app.classList.toggle('ws-collapsed', collapsed);
  localStorage.setItem('mux.ui.wsCollapsed', collapsed ? '1' : '0');
  requestAnimationFrame(() => {
    const ws = activeWs();
    if (ws) fitWorkspace(ws);
    syncBrowserBounds();
  });
}

let gitAnchor = null;
function updateFilesToggle() {
  const open = !$('#git-panel').hidden;
  document.querySelectorAll('.chat-git').forEach(button => {
    const expanded = open && button === gitAnchor;
    button.setAttribute('aria-label', expanded ? 'Close Git menu' : 'Open Git menu');
    button.setAttribute('aria-expanded', String(expanded));
  });
}
function positionGitPanel() {
  const panel = $('#git-panel');
  if (panel.hidden || !gitAnchor?.isConnected) return;
  const rect = gitAnchor.getBoundingClientRect();
  const margin = 8, gap = 8;
  const above = Math.max(0, rect.top - margin - gap);
  const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
  const showAbove = above >= Math.min(200, window.innerHeight * 0.45) || above >= below;
  const available = showAbove ? above : below;
  panel.style.maxHeight = `${Math.max(0, Math.min(480, available, window.innerHeight - 2 * margin))}px`;
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - panel.offsetWidth - margin));
  const preferredTop = showAbove ? rect.top - panel.offsetHeight - gap : rect.bottom + gap;
  const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - panel.offsetHeight - margin));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
function setFsCollapsed(collapsed) {
  els.app.classList.add('fs-collapsed');
  $('#git-panel').hidden = collapsed;
  if (collapsed) { ++gitReviewSequence; $('#git-review').hidden = true; $('#git-menu-content').hidden = false; $('#git-panel').classList.remove('reviewing'); document.querySelectorAll('#git-repo details, #git-clone-details').forEach(group => { group.open = false; }); }
  updateFilesToggle();
  if (!collapsed) { positionGitPanel(); refreshGitPanel().then(positionGitPanel); }
  requestBrowserSync();
}
document.addEventListener('pointerdown', event => {
  if (!$('#git-panel').hidden && !event.target.closest('#git-panel, .chat-git')) setFsCollapsed(true);
});
$('#git-panel').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.stopPropagation(); setFsCollapsed(true); gitAnchor?.focus(); }
});
window.addEventListener('resize', positionGitPanel);
let gitPositionPending = false;
new ResizeObserver(() => {
  if ($('#git-panel').hidden || gitPositionPending) return;
  gitPositionPending = true;
  requestAnimationFrame(() => { gitPositionPending = false; positionGitPanel(); });
}).observe($('#git-panel'));

/* ---------------- panel resize ---------------- */

function initResizing() {
  const setup = (handle, panelSel, varName, storageKey, min, max, def, direction) => {
    let dragging = false;
    let startPos = 0;
    let startW = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startPos = e.clientX;
      startW = document.querySelector(panelSel).getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = (e.clientX - startPos) * direction;
      const w = Math.max(min, Math.min(max, startW + delta));
      els.app.style.setProperty(varName, w + 'px');
      requestBrowserSync();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      localStorage.setItem(storageKey, els.app.style.getPropertyValue(varName).trim());
      requestBrowserSync();
    });
    handle.addEventListener('dblclick', () => {
      els.app.style.setProperty(varName, def + 'px');
      localStorage.setItem(storageKey, def + 'px');
      requestBrowserSync();
    });

    const saved = localStorage.getItem(storageKey);
    if (saved) els.app.style.setProperty(varName, Math.max(min, Math.min(max, parseFloat(saved) || def)) + 'px');
  };

  setup($('#resize-ws'), '#sidebar', '--ws-w', 'mux.ui.wsWidth', 240, 560, 264, 1);
  
}

/* ---------------- modal ---------------- */

function openModal() {
  els.modalName.value = `Project ${state.workspaces.length + 1}`;
  els.modalDir.value = state.home || '';
  els.modalWrap.classList.remove('hidden');
  requestBrowserSync();
  requestAnimationFrame(() => {
    els.modalName.focus();
    els.modalName.select();
  });
}
function closeModal() {
  els.modalWrap.classList.add('hidden');
  requestBrowserSync();
}

function submitModal() {
  const name = els.modalName.value.trim() || `Project ${state.workspaces.length + 1}`;
  const cwd = els.modalDir.value.trim() || state.home;
  closeModal();
  const ws = createWorkspace({ name, cwd });
  setActive(ws.id);
}

function setSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach((button) => {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.settings-page').forEach((page) => {
    page.classList.toggle('hidden', page.dataset.settingsPage !== tab);
  });
}

function renderKeybindings() {
  const list = $('#keybinding-list');
  if (!list) return;
  list.replaceChildren();
  for (const action of KEYBINDING_ACTIONS.filter(item => item.id !== 'clearTerminal')) {
    const row = document.createElement('div');
    row.className = 'keybinding-row';
    const label = document.createElement('span');
    label.className = 'keybinding-label';
    label.textContent = action.label;
    const button = document.createElement('button');
    button.className = 'shortcut-record' + (recordingShortcutFor === action.id ? ' recording' : '');
    button.dataset.keybinding = action.id;
    button.textContent = recordingShortcutFor === action.id
      ? 'Press shortcut…' : formatShortcut(appSettings.shortcuts[action.id]);
    row.append(label, button);
    list.appendChild(row);
  }
}

let availableSystemFonts = [];
let importedChatFonts = [];
function fontFamilyFor(value) {
  return value.startsWith('import:') ? 'Synthesis imported ' + value.slice(7) : value;
}
function fontNameFor(value) {
  if (!value) return 'System default';
  if (value.startsWith('import:')) return importedChatFonts.find(font => 'import:' + font.id === value)?.name || 'Imported font unavailable';
  return value;
}
function renderFontOptions() {
  const current = $('#font-picker-current');
  current.textContent = fontNameFor(appSettings.chatFont);
  current.style.fontFamily = appSettings.chatFont ? JSON.stringify(fontFamilyFor(appSettings.chatFont)) + ', sans-serif' : '';
  if ($('#font-picker-panel').hidden) return;
  const list = $('#font-picker-list'), query = $('#font-picker-search').value.trim().toLocaleLowerCase();
  const options = [{ value: '', label: 'System default' }, ...importedChatFonts.map(font => ({ value: 'import:' + font.id, label: font.name })), ...availableSystemFonts.map(family => ({ value: family, label: family }))];
  if (appSettings.chatFont && !options.some(option => option.value === appSettings.chatFont)) options.push({ value: appSettings.chatFont, label: fontNameFor(appSettings.chatFont) });
  const fragment = document.createDocumentFragment();
  for (const option of options.filter(item => item.label.toLocaleLowerCase().includes(query))) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'font-picker-option';
    button.textContent = option.label; button.setAttribute('aria-pressed', String(option.value === appSettings.chatFont));
    if (option.value) button.style.fontFamily = JSON.stringify(fontFamilyFor(option.value)) + ', sans-serif';
    button.addEventListener('click', () => { updateAppSettings({ chatFont: option.value }); closeFontPicker(); $('#setting-chat-font').focus(); });
    fragment.append(button);
  }
  list.replaceChildren(fragment);
}
function closeFontPicker() {
  $('#font-picker-panel').hidden = true;
  $('#setting-chat-font').setAttribute('aria-expanded', 'false');
}
function openFontPicker() {
  const trigger = $('#setting-chat-font'), panel = $('#font-picker-panel');
  const rect = trigger.getBoundingClientRect();
  panel.style.left = Math.max(12, Math.min(rect.right - 260, window.innerWidth - 272)) + 'px';
  panel.style.top = Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 320)) + 'px';
  panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
  $('#font-picker-search').value = ''; renderFontOptions(); $('#font-picker-search').focus();
}
async function registerImportedFont(font) {
  const bytes = Uint8Array.from(atob(font.data), character => character.charCodeAt(0));
  const face = new FontFace('Synthesis imported ' + font.id, bytes.buffer);
  await face.load(); document.fonts.add(face);
  return { id: font.id, name: font.name };
}
let systemFontsLoaded = false;
async function loadAvailableFonts(includeSystem = true) {
  try {
    const result = await window.mux.fonts.list(includeSystem);
    if (includeSystem) { availableSystemFonts = result.system; systemFontsLoaded = true; }
    const known = new Set(importedChatFonts.map(font => font.id));
    importedChatFonts.push(...(await Promise.all(result.imported.filter(font => !known.has(font.id)).map(font => registerImportedFont(font).catch(() => null)))).filter(Boolean));
    renderFontOptions(); applySettings();
  } catch { $('#font-settings-status').textContent = 'Could not load the installed fonts.'; }
}
async function importChatFont() {
  const status = $('#font-settings-status'); status.textContent = '';
  try {
    const result = await window.mux.fonts.import();
    if (result.canceled) return;
    if (result.error) { status.textContent = result.error; return; }
    const font = await registerImportedFont(result.font); importedChatFonts.push(font);
    updateAppSettings({ chatFont: 'import:' + font.id }); status.textContent = `Imported ${font.name}.`;
  } catch { status.textContent = 'That font could not be loaded. Try a different font file.'; }
}

function renderSettings() {
  const customColor = $('#setting-accent-custom');
  if (!customColor) return;
  customColor.value = accentColor();
  document.querySelectorAll('.accent-swatch').forEach((swatch) => {
    const selected = swatch.dataset.accent.toLowerCase() === appSettings.accentColor.toLowerCase();
    swatch.classList.toggle('selected', selected);
    swatch.setAttribute('aria-pressed', String(selected));
  });
  for (const [id, key] of Object.entries({ 'chat-background': 'chatBackground', 'sidebar-color': 'sidebarColor', 'bubble-color': 'bubbleColor', 'chat-text': 'chatText' })) $('#setting-' + id).value = appSettings[key];
  $('#setting-chat-font-size').value = String(appSettings.chatFontSize);
  renderFontOptions();
  $('#setting-font-size').value = String(appSettings.fontSize);
  $('#setting-cursor-style').value = appSettings.cursorStyle;
  $('#setting-cursor-blink').checked = appSettings.cursorBlink;
  $('#setting-scrollback').value = String(appSettings.scrollback);
  $('#setting-confirm-close').checked = appSettings.confirmClose;
  renderKeybindings();
}

function openSettings(tab = 'appearance') {
  if (!systemFontsLoaded) loadAvailableFonts();
  renderSettings();
  setSettingsTab(tab);
  $('#settings-backdrop').classList.remove('hidden');
  requestBrowserSync();
}

function closeSettings() {
  closeFontPicker();
  if (recordingShortcutFor) {
    recordingShortcutFor = null;
    renderKeybindings();
  }
  $('#settings-backdrop').classList.add('hidden');
  requestBrowserSync();
}

function setShortcutStatus(message, isError = false) {
  const status = $('#shortcut-status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function beginShortcutRecording(actionId) {
  recordingShortcutFor = actionId;
  renderKeybindings();
  setShortcutStatus('Press a combination with ⌘ or Ctrl. Press Esc to cancel.');
}

function shortcutFromEvent(e) {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return '';
  const mods = [];
  if (e.metaKey) mods.push('Meta');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.includes('Meta') && !mods.includes('Ctrl')) return '';
  const key = normalizeKeyName(e.key);
  return KEY_MODIFIERS.filter((mod) => mods.includes(mod)).concat(key).join('+');
}

function handleShortcutRecording(e) {
  if (!recordingShortcutFor) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    recordingShortcutFor = null;
    renderKeybindings();
    setShortcutStatus('Shortcut recording cancelled.');
    return true;
  }
  const binding = shortcutFromEvent(e);
  if (!binding) {
    setShortcutStatus('Include ⌘ or Ctrl with the key you want to use.');
    return true;
  }
  const duplicate = KEYBINDING_ACTIONS.find((action) =>
    action.id !== recordingShortcutFor && normalizeShortcut(appSettings.shortcuts[action.id]) === binding);
  if (duplicate) {
    setShortcutStatus(`That shortcut is already assigned to “${duplicate.label}”. Try another.`, true);
    return true;
  }
  const actionId = recordingShortcutFor;
  recordingShortcutFor = null;
  appSettings = { ...appSettings, shortcuts: { ...appSettings.shortcuts, [actionId]: binding } };
  persistSettings();
  applySettings();
  renderKeybindings();
  setShortcutStatus(`Shortcut saved: ${formatShortcut(binding)}.`);
  return true;
}

function runShortcutAction(actionId) {
  const ws = activeWs();
  switch (actionId) {
    case 'newTab':
      if (ws) { const pane = ws.panes[ws.activePaneIdx]; addPaneTab(ws, pane, { type: pane.type === 'browser' ? 'browser' : 'chat' }); }
      break;
    case 'closeTab':
      if (ws) { const pane = ws.panes[ws.activePaneIdx]; closePaneTab(ws, pane, pane.activeTab); }
      break;
    case 'nextTab':
    case 'previousTab':
      if (ws) {
        const pane = ws.panes[ws.activePaneIdx];
        const step = actionId === 'nextTab' ? 1 : -1;
        const tabs = pane.tabs.filter((tab) => tab.type !== 'terminal');
        if (tabs.length) activateTab(ws, pane, tabs[(tabs.indexOf(pane.activeTab) + step + tabs.length) % tabs.length]);
      }
      break;
    case 'settings': openSettings(); break;
    case 'newSession': openModal(); break;
    case 'closeSession': if (state.activeId) closeWorkspace(state.activeId); break;
    case 'openFiles': setFsCollapsed(!$('#git-panel').hidden); break;
    case 'splitRight':
      if (ws) splitPane(ws, ws.panes[ws.activePaneIdx], 'row');
      break;
    case 'splitDown':
      if (ws) splitPane(ws, ws.panes[ws.activePaneIdx], 'col');
      break;
    case 'browserRight':
      if (ws) splitPane(ws, ws.panes[ws.activePaneIdx], 'row', 'browser');
      break;
    case 'browserDown':
      if (ws) splitPane(ws, ws.panes[ws.activePaneIdx], 'col', 'browser');
      break;
    case 'clearTerminal': {
      const pane = ws && ws.panes[ws.activePaneIdx];
      if (pane && pane.type === 'terminal') { pane.term.clear(); pane.term.focus(); }
      break;
    }
    case 'nextWorkspace':
    case 'previousWorkspace': {
      if (!state.workspaces.length) break;
      const current = state.workspaces.findIndex((item) => item.id === state.activeId);
      const step = actionId === 'nextWorkspace' ? 1 : -1;
      const next = (current + step + state.workspaces.length) % state.workspaces.length;
      setActive(state.workspaces[next].id);
      break;
    }
    case 'nextPane':
      if (ws && ws.panes.length > 1) setActivePane(ws, (ws.activePaneIdx + 1) % ws.panes.length);
      break;
  }
}

/* ---------------- events ---------------- */

window.mux.app.onTabCommand(({ action, id }) => {
  const ws = activeWs();
  if (!ws) return;
  const index = ws.panes.findIndex((pane) => pane.tabs.some((tab) => tab.id === id));
  if (index < 0) return;
  ws.activePaneIdx = index;
  runShortcutAction(action);
});

window.mux.browser.onFocus(({ id }) => {
  const ws = activeWs();
  const index = ws?.panes.findIndex((pane) => pane.activeTab.id === id);
  if (index >= 0 && index !== ws.activePaneIdx) setActivePane(ws, index, false);
});

window.mux.browser.onNewTab(({ id, url }) => {
  for (const ws of state.workspaces) {
    const pane = ws.panes.find((item) => item.tabs.some((tab) => tab.id === id));
    if (pane) { addPaneTab(ws, pane, { type: 'browser', url }); return; }
  }
});

window.mux.browser.onContextMenu(({ id, x, y }) => {
  const ws = activeWs();
  if (!ws) return;
  const index = ws.panes.findIndex((pane) => pane.activeTab.id === id);
  if (index < 0) return;
  setActivePane(ws, index);
  showMenu(x, y, paneMenu(ws, ws.panes[index]));
});

const filesToolsToggle = $('#files-tools-toggle');
function toggleFilesTools(open) {
  $('#files').classList.toggle('tools-open', open);
  filesToolsToggle.setAttribute('aria-expanded', String(open));
  localStorage.setItem('synthesis.files.toolsOpen', String(open));
}
toggleFilesTools(localStorage.getItem('synthesis.files.toolsOpen') === 'true');
filesToolsToggle.addEventListener('click', () => toggleFilesTools(!$('#files').classList.contains('tools-open')));

$('#settings-btn').addEventListener('click', () => openSettings());
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-done').addEventListener('click', closeSettings);
$('#settings-backdrop').addEventListener('click', (e) => {
  if (e.target === $('#settings-backdrop')) closeSettings();
});
$('#settings-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-settings-tab]');
  if (tab) setSettingsTab(tab.dataset.settingsTab);
});
$('#accent-presets').addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-accent]');
  if (swatch) updateAppSettings({ accentColor: swatch.dataset.accent });
});
$('#setting-accent-custom').addEventListener('change', (e) => updateAppSettings({ accentColor: e.target.value }));
for (const [id, key] of Object.entries({ 'chat-background': 'chatBackground', 'sidebar-color': 'sidebarColor', 'bubble-color': 'bubbleColor', 'chat-text': 'chatText' })) $('#setting-' + id).addEventListener('input', event => updateAppSettings({ [key]: event.target.value }));
$('#setting-chat-font').addEventListener('click', () => { if ($('#font-picker-panel').hidden) openFontPicker(); else closeFontPicker(); });
$('#font-picker-search').addEventListener('input', renderFontOptions);
$('#font-picker-panel').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeFontPicker(); $('#setting-chat-font').focus(); } });
document.addEventListener('pointerdown', event => { if (!$('#font-picker-panel').hidden && !event.target.closest('#font-picker-panel, #setting-chat-font')) closeFontPicker(); });
$('#setting-chat-font-size').addEventListener('change', event => updateAppSettings({ chatFontSize: Number(event.target.value) }));
$('#setting-import-font').addEventListener('click', importChatFont);
$('#setting-font-size').addEventListener('change', (e) => updateAppSettings({ fontSize: Number(e.target.value) }));
$('#setting-cursor-style').addEventListener('change', (e) => updateAppSettings({ cursorStyle: e.target.value }));
$('#setting-cursor-blink').addEventListener('change', (e) => updateAppSettings({ cursorBlink: e.target.checked }));
$('#setting-scrollback').addEventListener('change', (e) => updateAppSettings({ scrollback: Number(e.target.value) }));
$('#setting-confirm-close').addEventListener('change', (e) => updateAppSettings({ confirmClose: e.target.checked }));
$('#keybinding-list').addEventListener('click', (e) => {
  const button = e.target.closest('[data-keybinding]');
  if (button) beginShortcutRecording(button.dataset.keybinding);
});
$('#settings-reset-bindings').addEventListener('click', () => {
  recordingShortcutFor = null;
  updateAppSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  setShortcutStatus('Keyboard shortcuts restored to defaults.');
});
$('#settings-reset').addEventListener('click', () => {
  recordingShortcutFor = null;
  appSettings = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
  persistSettings();
  applySettings();
  renderSettings();
  setShortcutStatus('All settings restored to defaults.');
});

$('#add-btn').addEventListener('click', openModal);
$('#workspace-search').addEventListener('input', renderList);
const projectFilterButton = $('#workspace-sort');
const projectFilterPanel = document.createElement('section');
projectFilterPanel.className = 'project-filter-panel';
projectFilterPanel.hidden = true;
projectFilterPanel.setAttribute('role', 'dialog');
projectFilterPanel.setAttribute('aria-label', 'Filter chats by project');
projectFilterPanel.innerHTML = `<label class="project-filter-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></svg><input type="search" placeholder="Search projects…" aria-label="Search projects" autocomplete="off"></label><div class="project-filter-options" role="group" aria-label="Projects"></div><div class="project-filter-footer"><button type="button" class="project-filter-archive"></button><button type="button" class="project-filter-order"></button></div>`;
document.body.appendChild(projectFilterPanel);
const projectFilterSearch = projectFilterPanel.querySelector('input');
function closeProjectFilter() {
  projectFilterPanel.hidden = true;
  projectFilterButton.setAttribute('aria-expanded', 'false');
  requestBrowserSync();
}
function renderProjectFilter() {
  const list = projectFilterPanel.querySelector('.project-filter-options');
  list.replaceChildren();
  const query = projectFilterSearch.value.trim().toLocaleLowerCase();
  const options = [{ id: 'all', label: 'All projects' }, ...state.workspaces.filter(ws => !isScratch(ws)).map(ws => ({ id: ws.id, label: ws.name }))];
  if (conversationRows().some(row => isScratch(row.ws))) options.push({ id: 'scratch', label: 'No project' });
  for (const option of options.filter(item => item.id === 'all' || item.label.toLocaleLowerCase().includes(query))) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'project-filter-option'; button.setAttribute('aria-pressed', String(option.id === projectFilter));
    const icon = document.createElement('span'); icon.className = 'project-filter-icon'; icon.innerHTML = conversationProjectIcon(option.id === 'scratch');
    const label = document.createElement('span'); label.className = 'project-filter-label'; label.textContent = option.label;
    const check = document.createElement('span'); check.className = 'project-filter-check'; check.textContent = option.id === projectFilter ? '✓' : '';
    button.append(icon, label, check);
    button.addEventListener('click', () => { projectFilter = option.id; projectFilterButton.classList.toggle('filter-active', projectFilter !== 'all'); closeProjectFilter(); renderList(); projectFilterButton.focus(); });
    list.appendChild(button);
  }
  projectFilterPanel.querySelector('.project-filter-archive').textContent = showArchivedChats ? 'Show active chats' : 'Show archived chats';
  projectFilterPanel.querySelector('.project-filter-order').textContent = workspaceSortAlphabetically ? 'Sort by recent' : 'Sort by title';
}
projectFilterButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!projectFilterPanel.hidden) { closeProjectFilter(); return; }
  hideMenu(); projectFilterSearch.value = ''; renderProjectFilter();
  projectFilterPanel.hidden = false;
  const rect = projectFilterButton.getBoundingClientRect();
  projectFilterPanel.style.left = Math.max(8, Math.min(rect.left - 38, window.innerWidth - projectFilterPanel.offsetWidth - 8)) + 'px';
  projectFilterPanel.style.top = Math.min(rect.bottom + 8, window.innerHeight - projectFilterPanel.offsetHeight - 8) + 'px';
  projectFilterButton.setAttribute('aria-expanded', 'true');
  requestBrowserSync(); projectFilterSearch.focus();
});
projectFilterSearch.addEventListener('input', renderProjectFilter);
projectFilterPanel.querySelector('.project-filter-archive').addEventListener('click', () => { showArchivedChats = !showArchivedChats; closeProjectFilter(); renderList(); });
projectFilterPanel.querySelector('.project-filter-order').addEventListener('click', () => { workspaceSortAlphabetically = !workspaceSortAlphabetically; closeProjectFilter(); renderList(); });
projectFilterPanel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeProjectFilter(); projectFilterButton.focus(); } });
document.addEventListener('pointerdown', event => { if (!projectFilterPanel.hidden && !projectFilterPanel.contains(event.target) && !projectFilterButton.contains(event.target)) closeProjectFilter(); });
window.addEventListener('resize', () => { if (!projectFilterPanel.hidden) closeProjectFilter(); });
$('#workspace-new-chat').addEventListener('click', (event) => {
  event.stopPropagation();
  const button = event.currentTarget; const rect = button.getBoundingClientRect();
  const items = [{ label: 'No project — new scratch chat', action: async () => {
    const cwd = await window.mux.chat.createScratch();
    const ws = createWorkspace({ name: 'No project', cwd }); setScratch(ws, true); setActive(ws.id); renderList();
  } }, 'sep', ...state.workspaces.filter(ws => !isScratch(ws)).map(ws => ({ label: ws.name, action: () => { setActive(ws.id); addPaneTab(ws, ws.panes[ws.activePaneIdx], { type: 'chat' }); } })), 'sep', { label: 'New project…', action: openModal }];
  showMenu(rect.left, rect.bottom + 4, items);
});
$('#history-close').addEventListener('click', closeSavedHistory);
$('#history-backdrop').addEventListener('click', (e) => {
  if (e.target === $('#history-backdrop')) closeSavedHistory();
});
$('#history-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(savedHistoryText);
    $('#history-meta').textContent = 'Saved history copied to clipboard';
  } catch {
    $('#history-meta').textContent = 'Clipboard access is unavailable';
  }
});

$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-create').addEventListener('click', submitModal);
$('#modal-browse').addEventListener('click', async () => {
  const dir = await window.mux.app.pickPath();
  if (dir) els.modalDir.value = dir;
});
els.modalWrap.addEventListener('click', (e) => {
  if (e.target === els.modalWrap) closeModal();
});
[els.modalName, els.modalDir].forEach((input) =>
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitModal();
    if (e.key === 'Escape') closeModal();
  }));

$('#files-refresh').addEventListener('click', () => refreshFilesView());
$('#files-home').addEventListener('click', () => {
  const ws = activeWs();
  loadDir(ws ? ws.cwd : state.home);
});
$('#fs-pick').addEventListener('click', openPicker);
if (els.filesFilter) {
  els.filesFilter.addEventListener('input', () => {
    state.fileFilter = els.filesFilter.value;
    if (state.filesView === 'tree') renderTree();
    else renderDirListing();
  });
}
if (els.filesHidden) els.filesHidden.addEventListener('click', toggleHiddenFiles);
if (els.filesViewBtn) els.filesViewBtn.addEventListener('click', toggleFilesView);
$('#ws-collapse').addEventListener('click', () => setWsCollapsed(true));
$('#ws-expand').addEventListener('click', () => setWsCollapsed(false));

/* right-click regions */
els.termHost.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const selectedText = e.target.closest('.chat-message-content') ? window.getSelection()?.toString() : '';
  const codeBlock = e.target.closest('.chat-code-block');
  if (selectedText || codeBlock) {
    const items = [];
    if (selectedText) items.push({ label: 'Copy', hint: '⌘C', action: () => navigator.clipboard.writeText(selectedText) });
    if (codeBlock) { const code = codeBlock.querySelector('pre code')?.textContent || ''; items.push({ label: 'Copy all code', action: () => navigator.clipboard.writeText(code) }); }
    showMenu(e.clientX, e.clientY, items);
    return;
  }
  const ws = activeWs();
  if (!ws) return;
  const tile = e.target.closest('.tile');
  let pane = ws.panes[ws.activePaneIdx];
  if (tile) {
    const idx = ws.panes.findIndex((p) => p.tile === tile);
    if (idx !== -1) { setActivePane(ws, idx); pane = ws.panes[idx]; }
  }
  showMenu(e.clientX, e.clientY, paneMenu(ws, pane));
});

els.list.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.ws-card');
  if (!card) return;
  e.preventDefault();
  const ws = state.workspaces.find((w) => w.id === card.dataset.id);
  if (ws) showMenu(e.clientX, e.clientY, workspaceCardMenu(ws));
});

els.filesBody.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('.file-row')) return; // rows handle their own menu
  showMenu(e.clientX, e.clientY, filesBackgroundMenu());
});

window.addEventListener('keydown', (e) => {
  if (recordingShortcutFor && handleShortcutRecording(e)) return;
  if (e.key === 'Escape') {
    if (!$('#git-panel').hidden) { setFsCollapsed(true); gitAnchor?.focus(); return; }
    if (!$('#history-backdrop').classList.contains('hidden')) {
      closeSavedHistory();
      return;
    }
    if (!$('#settings-backdrop').classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!els.modalWrap.classList.contains('hidden')) {
      closeModal();
      return;
    }
    const menuWasOpen = menuEl.classList.contains('visible');
    hideMenu();
    if (menuWasOpen) {
      const ws = activeWs();
      if (ws) focusPaneSurface(ws.panes[ws.activePaneIdx]);
    }
    hideTip();
    if (!menuWasOpen) activeWs()?.panes[activeWs().activePaneIdx]?.activeTab?.abortChat?.();
    return;
  }
  if (!$('#history-backdrop').classList.contains('hidden') || !$('#settings-backdrop').classList.contains('hidden') || !els.modalWrap.classList.contains('hidden')) return;

  const binding = shortcutFromEvent(e);
  const action = KEYBINDING_ACTIONS.find((item) => normalizeShortcut(appSettings.shortcuts[item.id]) === binding);
  if (action) {
    e.preventDefault();
    runShortcutAction(action.id);
    return;
  }

  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const key = e.key.toLowerCase();
  if (/^[1-9]$/.test(key) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    const target = state.workspaces[Number(key) - 1];
    if (target) setActive(target.id);
  } else if (e.key === 'Tab' && !e.altKey) {
    e.preventDefault();
    if (!state.workspaces.length) return;
    const idx = state.workspaces.findIndex((w) => w.id === state.activeId);
    const next = e.shiftKey
      ? (idx - 1 + state.workspaces.length) % state.workspaces.length
      : (idx + 1) % state.workspaces.length;
    setActive(state.workspaces[next].id);
  }
});

// keep terminals sized to their tiles and browser views glued to their panes
const ro = new ResizeObserver(() => {
  const ws = activeWs();
  if (ws) fitWorkspace(ws);
  requestBrowserSync();
});
ro.observe(els.termHost);
window.addEventListener('resize', requestBrowserSync);
window.mux.fs.onChanged((m) => handleFsChanged(m));

/* flush pending workspace state on shutdown — a failed save leaves the prior
 * snapshot intact (atomic write in the main process) */
window.addEventListener('beforeunload', () => {
  if (!state.workspaces.length) return;
  try {
    clearTimeout(saveTimer);
    window.mux.sessions.saveSync(buildSnapshot());
  } catch { /* best effort */ }
});

/* ---------------- boot ---------------- */

(async function boot() {
  applySettings();
  if (appSettings.chatFont.startsWith('import:')) loadAvailableFonts(false);
  state.home = await window.mux.app.home();
  els.statusShell.textContent = await window.mux.app.shellName();
  const limits = await window.mux.fs.limits().catch(() => null);
  if (limits && limits.maxBytes) previewLimits = limits;
  updateFilesControls();

  // panel visibility: workspaces shown, files collapsed — remembered per user
  setWsCollapsed(localStorage.getItem('mux.ui.wsCollapsed') === '1');
  setFsCollapsed(true);
  initResizing();

  // Restore saved workspaces (schema v2 — the main process migrates older
  // shapes and falls back to its last-known-good snapshot). Terminal panes
  // reattach to live daemon sessions by stable pane id, or visibly show
  // Ended / Unavailable instead of stale output.
  let saved = null;
  try { saved = await window.mux.sessions.load(); } catch { /* fresh start */ }
  if (saved && Array.isArray(saved.workspaces) && saved.workspaces.length) {
    for (const spec of saved.workspaces) {
      createWorkspace({ name: spec.name, cwd: spec.cwd, id: spec.id, restore: spec });
    }
  }
  // Reuse an untouched scratch space; otherwise create a new one without changing saved chats.
  let fresh = state.workspaces.find(ws => isScratch(ws) && workspaceTabs(ws).every(tab => tab.type === 'chat' && !tab.hasConversation && !(tab.sessionPath && readLocalMap(OWNED_CHATS_KEY)[tab.sessionPath])));
  if (!fresh) { const cwd = await window.mux.chat.createScratch(); fresh = createWorkspace({ name: 'No project', cwd }); setScratch(fresh, true); }
  setActive(fresh.id); renderList();

  document.fonts.ready.then(() => {
    const cur = activeWs();
    if (cur) fitWorkspace(cur);
    syncBrowserBounds();
  });
})();
