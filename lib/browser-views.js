'use strict';
/* ============ Synthesis in-pane browser manager (main process) ============
 *
 * Owns the untrusted WebContentsView instances used by browser panes.
 *
 * Security policy:
 *   - views run sandboxed with context isolation, no Node integration, no
 *     Synthesis preload and no access to the app's IPC bridge,
 *   - only http/https navigation happens in-pane; javascript:, file: and
 *     other schemes are denied; mailto:/tel: go to the OS handler,
 *   - no uncontrolled popups: http(s) window.open targets become managed tabs
 *     in the opener's pane,
 *   - one persistent local profile (`persist:synthesis-browser`) with a
 *     visible Clear-browser-data action; cookies stay in Electron's profile
 *     store and never in workspace JSON.
 */

const { WebContentsView, session, shell } = require('electron');
const { tabActionForInput } = require('./tab-shortcuts');
const { normalizeBrowserUrl, classifyNavigationTarget } = require('./browser-url');

const BROWSER_PARTITION = 'persist:synthesis-browser';
const DEFAULT_ZOOM = 1;

function createBrowserManager({ getWindow, getTabShortcuts = () => ({}), isDocumentUrl = () => false, documentPath = () => '' }) {
  const views = new Map(); // surface id -> { view, state }

  function sendState(id) {
    const entry = views.get(id);
    const win = getWindow();
    if (!entry || !win || win.isDestroyed()) return;
    const contents = entry.view.webContents;
    const state = {
      id,
      url: entry.state.error ? (entry.state.url || contents.getURL()) : (contents.getURL() || entry.state.url || ''),
      title: contents.getTitle() || '',
      documentPath: documentPath(contents.getURL() || entry.state.url || ''),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory ? contents.navigationHistory.canGoBack() : contents.canGoBack(),
      canGoForward: contents.navigationHistory ? contents.navigationHistory.canGoForward() : contents.canGoForward(),
      error: entry.state.error || null,
    };
    entry.state = { ...entry.state, ...state };
    win.webContents.send('browser:state', state);
  }

  function applyVisibility(id, visible) {
    const entry = views.get(id);
    if (!entry) return;
    entry.visible = visible;
    const view = entry.view;
    if (typeof view.setVisible === 'function') {
      // A hidden WebContentsView keeps its previous native frame even while
      // renderer layout updates are cached in entry.bounds. Reapply the latest
      // frame before showing it again, or it can cover neighboring panes.
      if (visible && entry.bounds) view.setBounds(entry.bounds);
      view.setVisible(visible);
    } else if ('visible' in view) {
      if (visible && entry.bounds) view.setBounds(entry.bounds);
      view.visible = visible;
    } else if (visible && entry.bounds) {
      view.setBounds(entry.bounds);
    } else {
      view.setBounds({ x: 0, y: -10000, width: 1, height: 1 }); // park offscreen
    }
  }

  function wireContents(id, contents) {
    const notifyFocus = () => {
      const win = getWindow();
      if (views.get(id)?.visible && win && !win.isDestroyed()) win.webContents.send('browser:focus', { id });
    };
    contents.on('focus', notifyFocus);
    // Native views do not bubble pointer/focus events through the renderer DOM.
    // Mouse-down also covers clicking a view that already owns native focus.
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') notifyFocus();
    });
    contents.on('context-menu', (_event, params) => {
      const entry = views.get(id);
      const win = getWindow();
      if (!entry || !entry.visible || !entry.bounds || !win || win.isDestroyed()) return;
      const zoom = win.webContents.getZoomFactor();
      win.webContents.send('browser:context-menu', {
        id,
        x: (entry.bounds.x + params.x) / zoom,
        y: (entry.bounds.y + params.y) / zoom,
        linkURL: params.linkURL || '',
      });
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') notifyFocus();
      const action = tabActionForInput(input, getTabShortcuts());
      const win = getWindow();
      if (action && win && !win.isDestroyed()) {
        event.preventDefault();
        win.webContents.send('app:tab-command', { action, id });
      }
    });
    contents.on('did-start-loading', () => {
      const entry = views.get(id);
      if (entry) entry.state.error = null;
      sendState(id);
    });
    contents.on('did-stop-loading', () => sendState(id));
    contents.on('did-navigate', () => {
      const entry = views.get(id);
      if (entry) entry.state.error = null;
      sendState(id);
    });
    contents.on('did-navigate-in-page', () => sendState(id));
    contents.on('page-title-updated', () => sendState(id));
    contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // ignore aborted loads
      const entry = views.get(id);
      if (entry) {
        entry.state.url = validatedURL;
        entry.state.error = `${errorDescription} (${errorCode}) — ${validatedURL}`;
      }
      sendState(id);
    });

    /* navigation policy — in-pane http(s) only */
    contents.on('will-navigate', (event, url) => {
      const kind = classifyNavigationTarget(url);
      if (kind === 'in-pane' || isDocumentUrl(url)) return;
      event.preventDefault();
      if (kind === 'external') {
        try { shell.openExternal(url); } catch { /* refuse silently */ }
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      const kind = classifyNavigationTarget(url);
      if (kind === 'in-pane' || isDocumentUrl(url)) {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('browser:new-tab', { id, url });
      } else if (kind === 'external') {
        try { shell.openExternal(url); } catch { /* refuse silently */ }
      }
      return { action: 'deny' }; // never an uncontrolled new window
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }

  function create(id, { url, zoomFactor } = {}) {
    if (views.has(id)) return { ok: true, id };
    const win = getWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window for browser surface' };

    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        plugins: true,
        javascript: true,
        spellcheck: false,
      },
    });
    const entry = { view, bounds: null, visible: false, state: { url: url || '', error: null } };
    views.set(id, entry);
    win.contentView.addChildView(view);
    wireContents(id, view.webContents);

    const zoom = typeof zoomFactor === 'number' && zoomFactor >= 0.5 && zoomFactor <= 3 ? zoomFactor : DEFAULT_ZOOM;
    view.webContents.setZoomFactor(zoom);
    applyVisibility(id, false);

    if (url) {
      const normalized = isDocumentUrl(url) ? { ok: true, url } : normalizeBrowserUrl(url);
      if (normalized.ok) view.webContents.loadURL(normalized.url).catch(() => {});
    }
    return { ok: true, id };
  }

  function get(id) {
    const entry = views.get(id);
    return entry ? entry.view.webContents : null;
  }

  function navigate(id, rawUrl) {
    const entry = views.get(id);
    if (!entry) return { ok: false, error: 'Unknown browser surface' };
    const normalized = isDocumentUrl(rawUrl) ? { ok: true, url: rawUrl } : normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) return normalized;
    entry.state.error = null;
    entry.view.webContents.loadURL(normalized.url).catch(() => {});
    return { ok: true, url: normalized.url };
  }

  function run(id, fn, verb) {
    const entry = views.get(id);
    if (!entry) return { ok: false, error: `Unknown browser surface for ${verb}` };
    const contents = entry.view.webContents;
    const history = contents.navigationHistory;
    try {
      if (fn === 'back') { if (history) history.goBack(); else contents.goBack(); }
      else if (fn === 'forward') { if (history) history.goForward(); else contents.goForward(); }
      else if (fn === 'reload') contents.reload();
      else if (fn === 'stop') contents.stop();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  function setZoom(id, zoomFactor) {
    const entry = views.get(id);
    if (!entry) return { ok: false, error: 'Unknown browser surface' };
    const zoom = Math.min(3, Math.max(0.5, Number(zoomFactor) || DEFAULT_ZOOM));
    entry.view.webContents.setZoomFactor(zoom);
    return { ok: true, zoom };
  }

  function setBounds(id, rect) {
    const entry = views.get(id);
    if (!entry || !rect) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // Renderer rectangles are CSS pixels. Native child views use DIPs, so
    // apply the HOST's zoom (never the browser page zoom or screen pixel ratio).
    // Round edges inward to avoid painting across fractional pane boundaries.
    const zoom = win.webContents.getZoomFactor();
    const x = Math.ceil(rect.x * zoom - 1e-7);
    const y = Math.ceil(rect.y * zoom - 1e-7);
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.floor((rect.x + rect.width) * zoom + 1e-7) - x),
      height: Math.max(0, Math.floor((rect.y + rect.height) * zoom + 1e-7) - y),
    };
    entry.bounds = bounds;
    if (entry.visible) entry.view.setBounds(bounds);
  }

  function setVisible(id, visible) {
    if (!views.has(id)) return;
    applyVisibility(id, Boolean(visible));
  }

  async function clearData() {
    const ses = session.fromPartition(BROWSER_PARTITION);
    try {
      await ses.clearStorageData();
      await ses.clearCache();
    } catch { /* best effort */ }
    for (const entry of views.values()) {
      try { entry.view.webContents.reload(); } catch { /* noop */ }
    }
    return { ok: true };
  }

  function dispose(id) {
    const entry = views.get(id);
    if (!entry) return;
    views.delete(id);
    const win = getWindow();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
    } catch { /* already detached */ }
    try { entry.view.webContents.close(); } catch { /* already gone */ }
  }

  function disposeAll() {
    for (const id of [...views.keys()]) dispose(id);
  }

  return {
    BROWSER_PARTITION,
    create,
    get,
    navigate,
    back: (id) => run(id, 'back', 'back'),
    forward: (id) => run(id, 'forward', 'forward'),
    reload: (id) => run(id, 'reload', 'reload'),
    stop: (id) => run(id, 'stop', 'stop'),
    setZoom,
    setBounds,
    setVisible,
    clearData,
    dispose,
    disposeAll,
    has: (id) => views.has(id),
  };
}

module.exports = { createBrowserManager, BROWSER_PARTITION, DEFAULT_ZOOM };
