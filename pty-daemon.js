#!/usr/bin/env node
/* ============ Synthesis persistent PTY daemon ============
 * Owns terminal sessions so they survive app restarts.
 * Talked to by main.js over a unix socket (newline-delimited JSON).
 * Run under the system node runtime when available (falls back to
 * ELECTRON_RUN_AS_NODE so node-pty's native ABI always matches its host).
 */
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const supportDir = process.argv[2];
if (!supportDir) process.exit(1);

// distinguish from the app process so app-level kills don't take us down
process.title = 'synthesis-pty-daemon';

const sockPath = path.join(supportDir, 'pty.sock');
const sessionsDir = path.join(supportDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const MAX_RING = 512 * 1024;   // per-session live replay buffer (bytes)
const MAX_LOG = 10 * 1024 * 1024; // per-session persisted history cap (bytes)

const sessions = new Map(); // id -> session
const clients = new Set();
let idleTimer = null;

function safeName(id) { return String(id).replace(/[^\w.-]/g, '_'); }
function logPath(id) { return path.join(sessionsDir, safeName(id) + '.log'); }

function makeSession(id) {
  return {
    id, pty: null, alive: false, cwd: null,
    ring: [], ringBytes: 0, logBytes: 0,
  };
}

function ringPush(sess, data) {
  sess.ring.push(data);
  sess.ringBytes += data.length;
  while (sess.ringBytes > MAX_RING && sess.ring.length > 1) {
    sess.ringBytes -= sess.ring.shift().length;
  }
}

function logAppend(sess, data) {
  try {
    const p = logPath(sess.id);
    fs.appendFileSync(p, data);
    sess.logBytes += Buffer.byteLength(data);
    if (sess.logBytes > MAX_LOG) {
      // keep the most recent slice of history
      const buf = fs.readFileSync(p);
      const tail = buf.subarray(buf.length - Math.floor(MAX_LOG / 2));
      fs.writeFileSync(p, tail);
      sess.logBytes = tail.length;
    }
  } catch { /* disk trouble is non-fatal for the session */ }
}

function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) {
    try { c.write(line); } catch { /* client going away */ }
  }
}

function reply(client, reqId, payload) {
  if (!reqId) return;
  try { client.write(JSON.stringify({ reqId, ...payload }) + '\n'); } catch { /* noop */ }
}

function replayTo(client, sess) {
  const text = sess.ring.join('');
  if (text) {
    try { client.write(JSON.stringify({ ev: 'data', id: sess.id, data: text }) + '\n'); } catch { /* noop */ }
  }
}

function spawnSession(client, req) {
  const { reqId, id, cols, rows, cwd, shell } = req;

  // live session: reattach and replay its buffered output
  const existing = sessions.get(id);
  if (existing && existing.alive) {
    replayTo(client, existing);
    reply(client, reqId, { ok: true, pid: existing.pty.pid, alive: true, cwd: existing.cwd });
    return;
  }

  const sess = existing || makeSession(id);
  sessions.set(id, sess);

  // dead session: replay persisted history so the conversation is visible again,
  // unless the caller asked for a clean fresh shell (replay:false) — saved
  // output then stays behind the explicit history viewer instead of being
  // mixed into the new shell prompt.
  if (req.replay !== false) {
    try {
      const hist = fs.readFileSync(logPath(id), 'utf8');
      if (hist) {
        sess.logBytes = Buffer.byteLength(hist);
        try { client.write(JSON.stringify({ ev: 'data', id, data: hist }) + '\n'); } catch { /* noop */ }
      }
    } catch { /* no history for this id yet */ }
  }

  try {
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const p = pty.spawn(shell || process.env.SHELL || '/bin/zsh', ['-l'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: dir,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    sess.pty = p;
    sess.alive = true;
    sess.cwd = dir;
    p.onData((data) => {
      ringPush(sess, data);
      logAppend(sess, data);
      broadcast({ ev: 'data', id, data });
    });
    p.onExit(({ exitCode }) => {
      sess.alive = false;
      sess.pty = null;
      broadcast({ ev: 'exit', id, code: exitCode });
      scheduleIdleCheck();
    });
    reply(client, reqId, { ok: true, pid: p.pid, alive: false, cwd: dir });
  } catch (err) {
    reply(client, reqId, { ok: false, error: String(err) });
  }
}

function killSession(id) {
  const sess = sessions.get(id);
  if (sess) {
    if (sess.pty) { try { sess.pty.kill(); } catch { /* already dead */ } }
    sessions.delete(id);
  }
  try { fs.unlinkSync(logPath(id)); } catch { /* no history to drop */ }
  broadcast({ ev: 'exit', id, code: -1 });
  scheduleIdleCheck();
}

function handle(client, msg) {
  switch (msg.op) {
    case 'spawn':
      spawnSession(client, msg);
      break;
    case 'input': {
      const sess = sessions.get(msg.id);
      if (sess && sess.pty) { try { sess.pty.write(msg.data); } catch { /* noop */ } }
      break;
    }
    case 'resize': {
      const sess = sessions.get(msg.id);
      if (sess && sess.pty) {
        try { sess.pty.resize(msg.cols, msg.rows); } catch { /* noop */ }
      }
      break;
    }
    case 'kill':
      killSession(msg.id);
      break;
    case 'list':
      reply(client, msg.reqId, {
        ok: true,
        sessions: [...sessions.values()].map((s) => ({ id: s.id, alive: s.alive, cwd: s.cwd })),
      });
      break;
    default:
      reply(client, msg.reqId, { ok: false, error: 'unknown op' });
  }
}

function scheduleIdleCheck() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const anyAlive = [...sessions.values()].some((s) => s.alive);
    if (!anyAlive && clients.size === 0) process.exit(0);
  }, 120000);
}

const server = net.createServer((client) => {
  clients.add(client);
  client.setEncoding('utf8');
  let buf = '';
  client.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      try { handle(client, JSON.parse(line)); } catch { /* malformed line */ }
    }
  });
  const drop = () => { clients.delete(client); scheduleIdleCheck(); };
  client.on('close', drop);
  client.on('error', drop);
});

// single-instance guard: if another daemon owns the socket, exit quietly
const probe = net.connect(sockPath);
probe.on('connect', () => { probe.destroy(); process.exit(0); });
probe.on('error', () => {
  probe.destroy();
  try { fs.unlinkSync(sockPath); } catch { /* stale socket */ }
  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* noop */ }
  });
});

// Only shut down when nothing is running — a kill aimed at the app must never
// take live conversations with it. (At reboot the OS hard-kills everything.)
function shutdownIfIdle() {
  const anyAlive = [...sessions.values()].some((s) => s.alive);
  if (!anyAlive) process.exit(0);
}
process.on('SIGTERM', shutdownIfIdle);
process.on('SIGINT', shutdownIfIdle);
scheduleIdleCheck();
