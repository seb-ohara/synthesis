const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');

const stateStore = require('./lib/state-store');
const { ID_RE } = require('./lib/state-schema');
const { PathGuard } = require('./lib/path-guard');
const { createBrowserManager } = require('./lib/browser-views');
const gitControls = require('./lib/git-controls');
const { generateGitCommitMessage } = require('./lib/git-commit-message');

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
function sessionDirectory(cwd) {
  const root = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
  return path.join(root, '--' + cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-') + '--');
}
async function validChatSession(cwd, file) {
  if (typeof file !== 'string' || path.extname(file) !== '.jsonl') return false;
  let handle;
  try {
    const [parent, actual] = await Promise.all([fsp.realpath(sessionDirectory(cwd)), fsp.realpath(file)]);
    if (path.dirname(actual) !== parent) return false;
    handle = await fsp.open(actual, 'r');
    const data = Buffer.alloc(65536), { bytesRead } = await handle.read(data, 0, data.length, 0);
    const header = JSON.parse(data.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]);
    return header.type === 'session' && header.cwd === cwd;
  } catch { return false; } finally { if (handle) await handle.close(); }
}
const pendingSessionScans = new Map();
function chatSessions(cwd, ownedPaths) {
  const directory = sessionDirectory(cwd);
  const names = Array.isArray(ownedPaths) ? [...new Set(ownedPaths.filter(file => typeof file === 'string' && path.dirname(file) === directory && file.endsWith('.jsonl')).map(file => path.basename(file)))].sort() : null;
  if (names && !names.length) return Promise.resolve([]);
  const key = cwd + '\0' + JSON.stringify(names);
  if (pendingSessionScans.has(key)) return pendingSessionScans.get(key);
  const pending = scanChatSessions(cwd, names).finally(() => pendingSessionScans.delete(key));
  pendingSessionScans.set(key, pending); return pending;
}
async function scanChatSessions(cwd, ownedNames) {
  const dir = sessionDirectory(cwd);
  try {
    const names = ownedNames || (await fsp.readdir(dir)).filter(name => name.endsWith('.jsonl'));
    const results = [];
    // Bound the number of open files while keeping disk reads off the UI thread.
    for (let i = 0; i < names.length; i += 20) {
      const batch = await Promise.all(names.slice(i, i + 20).map(async name => {
        const file = path.join(dir, name); let handle;
        try {
          handle = await fsp.open(file, 'r'); const stat = await handle.stat();
          const buffer = Buffer.alloc(Math.min(stat.size, 65536));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
          const header = JSON.parse(lines.shift());
          if (header.type !== 'session' || header.cwd !== cwd) return null;
          let title = '';
          for (const line of lines) { try { const entry = JSON.parse(line); if (entry.type === 'session_info' && entry.name) title = entry.name; else if (!title && entry.type === 'message' && entry.message?.role === 'user') { const c = entry.message.content; title = typeof c === 'string' ? c : (c || []).filter(x => x.type === 'text').map(x => x.text).join(' '); } } catch {} }
          // Message timestamps reflect conversation activity; file mtime can change when Pi reopens a session.
          let latest = 0;
          const tail = stat.size > buffer.length ? Buffer.alloc(Math.min(stat.size, 65536)) : buffer.subarray(0, bytesRead);
          if (stat.size > buffer.length) { const read = await handle.read(tail, 0, tail.length, stat.size - tail.length); if (read.bytesRead < tail.length) tail.fill(0, read.bytesRead); }
          for (const line of tail.toString('utf8').split('\n')) { try { const entry = JSON.parse(line); if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role) && Number.isFinite(entry.message.timestamp)) latest = Math.max(latest, entry.message.timestamp); } catch {} }
          return { path: file, title: (title || 'Untitled chat').replace(/\s+/g, ' ').slice(0, 80), modified: latest || stat.mtimeMs };
        } catch { return null; } finally { if (handle) await handle.close(); }
      }));
      results.push(...batch.filter(Boolean));
    }
    return results.sort((a, b) => b.modified - a.modified);
  } catch { return []; }
}
ipcMain.handle('git:status', async (_event, cwd) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir) return { ok: false, error: 'Project folder is unavailable.' };
  try { return { ok: true, ...(await gitControls.status(dir)) }; } catch (error) { const notRepo = /not a git repository/i.test(error.stderr || error.message || ''); return { ok: false, canInit: notRepo, error: notRepo ? 'This folder is not a Git repository.' : (error.stderr || error.message || 'Could not read Git status.').trim().slice(0, 1000) }; }
});
ipcMain.handle('git:review', async (_event, { cwd, scope, ref }) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir) return { ok: false, error: 'Project folder is unavailable.' };
  try { return { ok: true, ...(await gitControls.review(dir, scope, ref)) }; } catch (error) { return { ok: false, error: (error.stderr || error.message || 'Could not read changes.').trim().slice(0, 1000) }; }
});
ipcMain.handle('git:action', async (_event, { cwd, action, data }) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir) return { ok: false, error: 'Project folder is unavailable.' };
  try { return { ok: true, output: await gitControls.action(dir, action, data) }; } catch (error) { return { ok: false, committed: error.committed === true, error: (error.stderr || error.stdout || error.message || 'Git action failed.').trim().slice(0, 2000) }; }
});
ipcMain.handle('git:openFinder', async (_event, cwd) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir) return { ok: false, error: 'Project folder is unavailable.' };
  try { if (!(await fsp.stat(dir)).isDirectory()) throw new Error('Project folder is unavailable.'); const error = await shell.openPath(dir); return error ? { ok: false, error } : { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('git:commitAuto', async (_event, { cwd, action, model, expectedBranch }) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir) return { ok: false, error: 'Project folder is unavailable.' };
  try { return { ok: true, ...(await gitControls.autoCommit(dir, action, changes => generateGitCommitMessage(dir, model, changes), expectedBranch)) }; }
  catch (error) { return { ok: false, committed: error.committed === true, error: (error.stderr || error.stdout || error.message || 'Git action failed.').trim().slice(0, 2000) }; }
});
ipcMain.handle('git:github', async (_event, { cwd, action }) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir || !['repo', 'pr', 'createPr'].includes(action)) return { ok: false, error: 'Project folder is unavailable.' };
  const args = action === 'repo' ? ['repo', 'view', '--web'] : action === 'pr' ? ['pr', 'view', '--web'] : ['pr', 'create', '--web'];
  try { await new Promise((resolve, reject) => execFile('/opt/homebrew/bin/gh', args, { cwd: dir, timeout: 30000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout))); return { ok: true }; } catch (error) { return { ok: false, error: error.message.slice(0, 1000) }; }
});
ipcMain.handle('chat:delete', async (_event, { cwd, sessionPath }) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir || typeof sessionPath !== 'string') return { ok: false, error: 'Chat not found.' };
  try { if (!(await validChatSession(dir, sessionPath))) return { ok: false, error: 'Chat not found in this project.' }; await shell.trashItem(sessionPath); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('chat:title', async (_event, { cwd, message, model }) => {
  const dir = pathGuard.resolveAllowed(cwd); if (!dir || typeof message !== 'string' || !message.trim()) return null;
  const executable = fs.existsSync(path.join(os.homedir(), '.local/bin/pi')) ? path.join(os.homedir(), '.local/bin/pi') : 'pi';
  const args = ['--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--thinking', 'off'];
  if (model && typeof model.provider === 'string' && typeof model.id === 'string') args.push('--provider', model.provider, '--model', model.id);
  args.push('Write a concise 2 to 6 word title for the following first chat message. Return only the title, without quotes or punctuation:');
  return await new Promise(resolve => {
    const child = spawn(executable, args, { cwd: dir, env: { ...process.env, PATH: [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(':') }, stdio: ['pipe','pipe','ignore'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); resolve(null); }, 30000);
    child.stdout.on('data', chunk => { output += chunk.toString().slice(0, 1000); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); const title = output.trim().split('\n')[0].replace(/^[#*\s"']+|[#*\s"'.:]+$/g, '').slice(0, 80); resolve(code === 0 && title ? title : null); });
    child.stdin.end(message.slice(0, 6000));
  });
});
ipcMain.handle('chat:createScratch', () => {
  const root = path.join(app.getPath('userData'), 'scratch');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(root, 'chat-'));
  pathGuard.addAllowedRoot(dir);
  return dir;
});
ipcMain.handle('chat:sessions', (_e, cwd, ownedPaths) => {
  // Session metadata lives under Pi's own data directory; listing it must not
  // access every restored project folder (which can trigger macOS privacy prompts).
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0') || cwd.length > 4096 || !Array.isArray(ownedPaths)) return [];
  return chatSessions(path.normalize(cwd), ownedPaths);
});
ipcMain.handle('chat:start', async (event, { id, cwd, sessionPath }) => {
  if (!validSessionId(id)) return { ok: false, error: 'Invalid chat ID' };
  const dir = pathGuard.resolveAllowed(cwd);
  if (!dir) return { ok: false, error: 'Workspace folder is unavailable' };
  if (sessionPath && !(await validChatSession(dir, sessionPath))) return { ok: false, error: 'Saved chat not found in this workspace' };
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return { ok: false, error: 'The application window was closed.' };
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

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const MAX_FONT_BYTES = 15 * 1024 * 1024;
function importedFontDir() { return path.join(app.getPath('userData'), 'fonts'); }
async function readImportedFont(name) {
  if (!/^[a-f0-9-]{36}--[^/\\]+\.(ttf|otf|woff2?)$/i.test(name)) return null;
  const file = path.join(importedFontDir(), name);
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size > MAX_FONT_BYTES) return null;
  return { id: name, name: name.slice(38).replace(/\.(ttf|otf|woff2?)$/i, ''), data: (await fsp.readFile(file)).toString('base64') };
}
ipcMain.handle('fonts:list', async (_event, includeSystem = true) => {
  let imported = [];
  try { const names = await fsp.readdir(importedFontDir()); imported = (await Promise.all(names.map(name => readImportedFont(name).catch(() => null)))).filter(Boolean); } catch {}
  const system = !includeSystem ? [] : await new Promise(resolve => {
    execFile('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (error, stdout) => {
      if (error) return resolve([]);
      try { const records = JSON.parse(stdout).SPFontsDataType || []; resolve([...new Set(records.filter(font => font.enabled !== 'no').flatMap(font => (font.typefaces || []).filter(face => face.enabled !== 'no' && typeof face.family === 'string').map(face => face.family)))].sort((a, b) => a.localeCompare(b))); } catch { resolve([]); }
    });
  });
  return { system, imported };
});
ipcMain.handle('fonts:import', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Import a font', properties: ['openFile'], filters: [{ name: 'Font files', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    const source = result.filePaths[0], ext = path.extname(source).toLowerCase();
    const stat = await fsp.stat(source);
    if (!FONT_EXTENSIONS.has(ext) || !stat.isFile() || stat.size === 0 || stat.size > MAX_FONT_BYTES) return { error: 'Choose a font file smaller than 15 MB.' };
    const display = path.basename(source, path.extname(source)).replace(/[^a-z0-9 _.-]/gi, '_').slice(0, 100) || 'Imported font';
    const name = randomUUID() + '--' + display + ext;
    await fsp.mkdir(importedFontDir(), { recursive: true, mode: 0o700 });
    await fsp.copyFile(source, path.join(importedFontDir(), name), fs.constants.COPYFILE_EXCL);
    return { font: await readImportedFont(name) };
  } catch { return { error: 'Could not import that font file.' }; }
});
ipcMain.handle('app:openChatLink', async (_event, raw) => {
  if (typeof raw !== 'string' || raw.length > 4096) return false;
  let url; try { url = new URL(raw); } catch { return false; }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return false;
  try { await shell.openExternal(url.toString()); return true; } catch { return false; }
});
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
    chatManager.stopAll();
    browserManager.disposeAll();
    win = null;
  });
}

// The detached terminal daemon retains terminal sessions; chat history is saved separately.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  chatManager.stopAll();
  browserManager.disposeAll();
  if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
  if (client) { try { client.end(); } catch { /* noop */ } }
});
