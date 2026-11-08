const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const { spawn } = require('child_process');

const stateStore = require('./lib/state-store');
const { ID_RE } = require('./lib/state-schema');
const { PathGuard } = require('./lib/path-guard');
const { createBrowserManager } = require('./lib/browser-views');

const SHELL = process.env.SHELL || '/bin/zsh';
const MAX_HISTORY_BYTES = 10 * 1024 * 1024;

/* Preview policy — the single source of truth shared with the renderer
 * through fs:read/fs:limits results. */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_MAX_LINES = 3000;

app.setName('Synthesis');
// The Synthesis support path aliases the existing workspace and PTY session data.
// Tests run against a disposable directory via SYNTHESIS_USER_DATA; they must
// never point at the live app-support folder or the checked-in data snapshot.
if (process.env.SYNTHESIS_USER_DATA) {
  app.setPath('userData', process.env.SYNTHESIS_USER_DATA);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'Synthesis'));
}

let win = null;

const chatManager = require('./lib/chat-process').createChatManager((id, event) => {
  if (win && !win.isDestroyed()) win.webContents.send('chat:event', { id, event });
});
function chatSessions(cwd) {
  const root = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
  const dir = path.join(root, '--' + cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-') + '--');
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        const fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(Math.min(stat.size, 65536));
        try { fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
        let title = '';
        const lines = buffer.toString('utf8').split('\n');
        const header = JSON.parse(lines.shift());
        if (header.type !== 'session' || header.cwd !== cwd) return null;
        for (const line of lines) { try { const entry = JSON.parse(line); if (entry.type === 'session_info' && entry.name) title = entry.name; else if (!title && entry.type === 'message' && entry.message?.role === 'user') { const c = entry.message.content; title = typeof c === 'string' ? c : (c || []).filter(x => x.type === 'text').map(x => x.text).join(' '); } } catch {} }
        return { path: file, title: (title || 'Untitled chat').replace(/\s+/g, ' ').slice(0, 80), modified: stat.mtimeMs };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.modified - a.modified).slice(0, 200);
  } catch { return []; }
}
ipcMain.handle('chat:sessions', (_e, cwd) => {
  const dir = pathGuard.resolveAllowed(cwd);
  return dir ? chatSessions(dir) : [];
});
ipcMain.handle('chat:start', (_e, { id, cwd, sessionPath }) => {
  if (!validSessionId(id)) return { ok: false, error: 'Invalid chat ID' };
  const dir = pathGuard.resolveAllowed(cwd);
  if (!dir) return { ok: false, error: 'Workspace folder is unavailable' };
  if (sessionPath && !chatSessions(dir).some(s => s.path === sessionPath)) return { ok: false, error: 'Saved chat not found in this workspace' };
  try { chatManager.start(id, dir, sessionPath); return { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.on('chat:command', (_e, { id, message }) => {
  if (validSessionId(id) && message && typeof message.type === 'string') chatManager.command(id, message);
});
ipcMain.on('chat:stop', (_e, id) => { if (validSessionId(id)) chatManager.stop(id); });

/* ---------------- persistent PTY daemon client ---------------- */

let supportDir = null;
let client = null;
let connectPromise = null;
const pending = new Map();
let reqSeq = 0;

function getSupportDir() {
  if (!supportDir) {
    supportDir = app.getPath('userData');
    fs.mkdirSync(supportDir, { recursive: true });
  }
  return supportDir;
}
function sockPath() { return path.join(getSupportDir(), 'pty.sock'); }
function workspacesFile() { return path.join(getSupportDir(), 'workspaces.json'); }

function validSessionId(id) {
  return typeof id === 'string' && ID_RE.test(id) && id !== '.' && id !== '..';
}

function findSystemNode() {
  // The daemon must NOT run from the app bundle binary — LaunchServices would
  // mistake it for the app itself and refuse to launch Synthesis after a quit.
  for (const p of ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node', '/opt/local/bin/node']) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

function launchDaemon() {
  const daemon = path.join(__dirname, 'pty-daemon.js');
  const nodeBin = findSystemNode();
  const env = nodeBin ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const child = spawn(nodeBin || process.execPath, [daemon, getSupportDir()], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function wireClient(sock) {
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ev === 'data') {
        if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id: msg.id, data: msg.data });
      } else if (msg.ev === 'exit') {
        if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id: msg.id, code: msg.code });
      } else if (msg.reqId && pending.has(msg.reqId)) {
        const { resolve } = pending.get(msg.reqId);
        pending.delete(msg.reqId);
        resolve(msg);
      }
    }
  });
  const drop = () => { if (client === sock) client = null; };
  sock.on('close', drop);
  sock.on('error', drop);
}

function connectDaemon() {
  if (client) return Promise.resolve(true);
  if (connectPromise) return connectPromise;
  connectPromise = new Promise((resolve) => {
    const attempt = (n) => {
      const sock = net.connect(sockPath());
      sock.on('connect', () => {
        client = sock;
        connectPromise = null;
        wireClient(sock);
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        if (n === 0) launchDaemon(); // no daemon listening — start one
        if (n < 8) setTimeout(() => attempt(n + 1), 350);
        else { connectPromise = null; resolve(false); }
      });
    };
    attempt(0);
  });
  return connectPromise;
}

function sendOp(msg) {
  return connectDaemon().then((ok) => {
    if (!ok || !client) return { ok: false, error: 'pty daemon unavailable' };
    msg.reqId = ++reqSeq;
    return new Promise((resolve) => {
      pending.set(msg.reqId, { resolve });
      try { client.write(JSON.stringify(msg) + '\n'); }
      catch (err) { pending.delete(msg.reqId); resolve({ ok: false, error: String(err) }); return; }
      setTimeout(() => {
        if (pending.has(msg.reqId)) {
          pending.delete(msg.reqId);
          resolve({ ok: false, error: 'pty daemon timeout' });
        }
      }, 8000);
    });
  });
}

ipcMain.handle('pty:spawn', (_e, { id, cols, rows, cwd, replay }) => {
  if (!validSessionId(id)) return { ok: false, error: 'Invalid terminal session id' };
  return sendOp({ op: 'spawn', id, cols, rows, cwd, shell: SHELL, replay: replay !== false });
});
ipcMain.handle('pty:history', (_e, { id }) => {
  if (!validSessionId(id)) {
    return { ok: false, error: 'Invalid terminal session id' };
  }

  const file = path.join(getSupportDir(), 'sessions', `${String(id).replace(/[^\w.-]/g, '_')}.log`);
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, error: 'History is not a file' };
    const start = Math.max(0, stat.size - MAX_HISTORY_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = fs.readSync(fd, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (!count) break;
      bytesRead += count;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    }
    return { ok: true, text, bytes: bytesRead, truncated: start > 0 };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, text: '', bytes: 0, truncated: false };
    return { ok: false, error: err.code || String(err) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* noop */ } }
  }
});
ipcMain.on('pty:input', (_e, { id, data }) => {
  if (validSessionId(id) && typeof data === 'string') sendOp({ op: 'input', id, data });
});
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
  if (validSessionId(id)) sendOp({ op: 'resize', id, cols, rows });
});
ipcMain.on('pty:kill', (_e, { id }) => {
  if (validSessionId(id)) sendOp({ op: 'kill', id });
});

/* Explicit daemon session listing/status — the renderer must never guess
 * process liveness from its own state. */
ipcMain.handle('pty:list', async () => {
  const res = await sendOp({ op: 'list' });
  if (!res || res.ok !== true || !Array.isArray(res.sessions)) {
    return { ok: false, error: (res && res.error) || 'pty daemon status unavailable' };
  }
  return {
    ok: true,
    sessions: res.sessions
      .filter((s) => s && validSessionId(s.id))
      .map((s) => ({ id: s.id, alive: Boolean(s.alive), cwd: typeof s.cwd === 'string' ? s.cwd : null })),
  };
});

/* ---------------- durable workspace state ---------------- */
/* Versioned schema, validated on both save and load, atomic writes and a
 * last-known-good backup — see lib/state-store.js. */

ipcMain.handle('sessions:save', (_e, data) => stateStore.save(workspacesFile(), data));

/* synchronous variant used by the renderer's beforeunload flush so pending
 * structural state survives app shutdown */
ipcMain.on('sessions:saveSync', (e, data) => {
  e.returnValue = stateStore.save(workspacesFile(), data).ok;
});

ipcMain.handle('sessions:load', () => {
  const result = stateStore.load(workspacesFile());
  if (!result.state) return null;
  if (result.migrated || result.source === 'backup') {
    stateStore.save(workspacesFile(), result.state); // persist migration / repair from backup
  }
  return result.state;
});

/* ---------------- Filesystem (untrusted renderer input) ---------------- */

const pathGuard = new PathGuard({ home: os.homedir() });

function denied() {
  return { ok: false, error: 'Path is outside the allowed directories' };
}

function entryKind(name, isDir) {
  if (isDir) return 'dir';
  const ext = path.extname(name).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.html', '.htm', '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.zsh', '.bash', '.swift', '.php', '.vue', '.svelte'].includes(ext)) return 'code';
  if (['.md', '.markdown', '.txt', '.rst', '.log', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.env'].includes(ext)) return 'text';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.icns', '.ico'].includes(ext)) return 'image';
  if (['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.dmg', '.pkg'].includes(ext)) return 'archive';
  return 'file';
}

ipcMain.handle('fs:list', async (_e, target) => {
  const dir = pathGuard.resolveAllowed(target || os.homedir());
  if (!dir) return { ...denied(), path: String(target || ''), entries: [] };
  try {
    const names = await fsp.readdir(dir);
    const entries = (await Promise.all(names.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const lst = await fsp.lstat(full);
        if (lst.isSymbolicLink()) {
          try {
            const st = await fsp.stat(full);
            return { name, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, kind: entryKind(name, st.isDirectory()), symlink: true };
          } catch {
            return { name, isDir: false, size: 0, mtime: lst.mtimeMs, kind: 'file', broken: true };
          }
        }
        return {
          name,
          isDir: lst.isDirectory(),
          size: lst.size,
          mtime: lst.mtimeMs,
          kind: entryKind(name, lst.isDirectory()),
          executable: lst.isFile() && (lst.mode & 0o111) !== 0,
        };
      } catch { return null; } // permission errors etc. skip the entry only
    }))).filter(Boolean);

    entries.sort((a, b) =>
      (b.isDir - a.isDir) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    return {
      ok: true,
      path: dir,
      parent: path.dirname(dir),
      isRoot: path.dirname(dir) === dir,
      entries,
    };
  } catch (err) {
    return { ok: false, path: dir, error: err.code || String(err), entries: [] };
  }
});

ipcMain.handle('fs:read', async (_e, target) => {
  const file = pathGuard.resolveAllowed(target);
  if (!file) return denied();
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return { ok: false, error: 'Not a file' };
    const limits = { maxBytes: PREVIEW_MAX_BYTES, maxLines: PREVIEW_MAX_LINES };
    if (st.size > PREVIEW_MAX_BYTES) {
      return { ok: false, error: 'File too large to preview', size: st.size, limits };
    }
    const buf = await fsp.readFile(file);
    if (buf.includes(0)) return { ok: false, binary: true, error: 'Binary file', size: st.size, limits };
    return { ok: true, text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs, truncated: false, limits };
  } catch (err) {
    return { ok: false, error: err.code || String(err) };
  }
});

ipcMain.handle('fs:limits', () => ({ maxBytes: PREVIEW_MAX_BYTES, maxLines: PREVIEW_MAX_LINES }));

ipcMain.handle('fs:reveal', (_e, target) => {
  const file = pathGuard.resolveAllowed(target);
  if (!file) return denied();
  try {
    if (!fs.existsSync(file)) return { ok: false, error: 'Path no longer exists' };
    shell.showItemInFolder(file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.code || String(err) };
  }
});

ipcMain.handle('fs:openExternal', async (_e, target) => {
  const file = pathGuard.resolveAllowed(target);
  if (!file) return denied();
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return { ok: false, error: 'Only files can be opened externally' };
    if ((st.mode & 0o111) !== 0) return { ok: false, error: 'Executable files are never opened automatically' };
    const result = await shell.openPath(file);
    return result ? { ok: false, error: result } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.code || String(err) };
  }
});

/* one debounced watcher for the directory currently on screen */
let dirWatcher = null;
let dirWatchTimer = null;

ipcMain.handle('fs:watch', (_e, target) => {
  const dir = pathGuard.resolveAllowed(target);
  if (!dir) return denied();
  try {
    if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
    clearTimeout(dirWatchTimer);
    dirWatcher = fs.watch(dir, { persistent: false }, () => {
      clearTimeout(dirWatchTimer);
      dirWatchTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path: dir });
      }, 250);
    });
    dirWatcher.on('error', () => { /* watch failures fall back to manual refresh */ });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.code || String(err) };
  }
});

ipcMain.on('fs:unwatch', () => {
  if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
});

/* ---------------- in-pane browser ---------------- */

let tabShortcuts = {};
ipcMain.on('app:tab-shortcuts', (event, bindings) => {
  if (!win || event.sender !== win.webContents || !bindings || typeof bindings !== 'object') return;
  tabShortcuts = Object.fromEntries(['newTab', 'closeTab', 'nextTab', 'previousTab'].map((action) => [action,
    typeof bindings[action] === 'string' && bindings[action].length < 100 ? bindings[action] : '',
  ]));
});
const browserManager = createBrowserManager({ getWindow: () => win, getTabShortcuts: () => tabShortcuts });

ipcMain.handle('browser:create', (_e, opts) => {
  const { id, url, zoomFactor } = opts || {};
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'Invalid browser surface id' };
  return browserManager.create(id, { url, zoomFactor });
});
ipcMain.handle('browser:navigate', (_e, { id, url }) => browserManager.navigate(id, url));
ipcMain.on('browser:back', (_e, { id }) => browserManager.back(id));
ipcMain.on('browser:forward', (_e, { id }) => browserManager.forward(id));
ipcMain.on('browser:reload', (_e, { id }) => browserManager.reload(id));
ipcMain.on('browser:stop', (_e, { id }) => browserManager.stop(id));
ipcMain.handle('browser:zoom', (_e, { id, zoomFactor }) => browserManager.setZoom(id, zoomFactor));
ipcMain.handle('browser:setBounds', (_e, { id, x, y, width, height, visible }) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'Invalid browser surface id' };
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, error: 'Invalid bounds' };
  }
  browserManager.setBounds(id, { x, y, width, height });
  browserManager.setVisible(id, visible !== false);
  return { ok: true };
});
ipcMain.handle('browser:clearData', () => browserManager.clearData());
ipcMain.handle('browser:openExternal', (_e, { id }) => {
  const contents = browserManager.get(id);
  if (!contents) return { ok: false, error: 'Unknown browser surface' };
  const url = contents.getURL();
  if (!/^https?:/i.test(url)) return { ok: false, error: 'Only http(s) pages can be opened externally' };
  try { shell.openExternal(url); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.on('browser:dispose', (_e, { id }) => browserManager.dispose(id));

/* ---------------- App helpers ---------------- */

ipcMain.handle('app:home', () => os.homedir());
ipcMain.handle('app:shell', () => path.basename(SHELL));
ipcMain.handle('app:allowRoot', (_e, root) => {
  const real = pathGuard.addAllowedRoot(root);
  return { ok: Boolean(real) };
});
ipcMain.handle('dialog:pickDirectory', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose Workspace Directory',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof defaultPath === 'string' ? defaultPath : os.homedir(),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const picked = res.filePaths[0];
  return pathGuard.addAllowedRoot(picked) ? picked : null;
});

ipcMain.handle('dialog:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'openDirectory', 'createDirectory'],
    defaultPath: os.homedir(),
  });
  if (res.canceled) return null;
  const picked = res.filePaths[0];
  pathGuard.addAllowedRoot(picked); // user-chosen paths become authorized roots
  return picked;
});

/* ---------------- App lifecycle ---------------- */

app.whenReady().then(() => {
  getSupportDir();
  createWindow();
  connectDaemon(); // warm up early; sessions may be waiting to reattach
});

function createWindow() {
  if (win || BrowserWindow.getAllWindows().length > 0) return;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const notifyWindowGeometryChange = () => {
    if (win && !win.isDestroyed()) win.webContents.send('app:window-geometry-changed');
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, notifyWindowGeometryChange);
  }
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => {
    browserManager.disposeAll();
    win = null;
  });
}

// NOTE: sessions are intentionally NOT killed here — the daemon keeps
// conversations alive so they resume when the app reopens.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  browserManager.disposeAll();
  if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
  if (client) { try { client.end(); } catch { /* noop */ } }
});
