'use strict';
// Runs from a per-user launch agent. One invocation claims due occurrences and
// stores their outcome; Pi owns the conversation files, just as in the GUI.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const store = require('./lib/scheduled-tasks');

function runPi(task, { executable, timeoutMs = 90 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    const local = path.join(os.homedir(), '.local/bin/pi');
    const bin = executable || (fs.existsSync(local) ? local : 'pi');
    const args = ['--mode', 'rpc', '--session-id', randomUUID()];
    if (task.model) args.push('--provider', task.model.provider, '--model', task.model.id);
    let child;
    try { child = spawn(bin, args, { cwd: task.cwd, env: { ...process.env, PATH: [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':') }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ ok: false, error: error.message }); return; }
    let buffer = '', errorMessage = '', settled = false, waitingState = false, done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(result); };
    const send = payload => { if (!done && child.stdin.writable) child.stdin.write(JSON.stringify(payload) + '\n'); };
    const finishWithState = () => { if (!waitingState) { waitingState = true; send({ type: 'get_state' }); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'The scheduled run timed out.' }), timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'message_end' && event.message?.errorMessage) errorMessage = String(event.message.errorMessage).slice(0, 1000);
        if (event.type === 'response' && event.command === 'prompt' && !event.success) { errorMessage = String(event.error || 'The agent could not start the task.').slice(0, 1000); finishWithState(); }
        else if (event.type === 'response' && event.command === 'prompt' && event.data?.disposition === 'handled') { settled = true; finishWithState(); }
        if (event.type === 'agent_settled') { settled = true; if (event.aborted) errorMessage = 'The scheduled run was stopped.'; finishWithState(); }
        if (event.type === 'response' && event.command === 'get_state' && waitingState) { const sessionPath = event.data?.sessionFile || ''; finish({ ok: settled && !errorMessage && !!sessionPath, sessionPath, error: errorMessage || (!settled ? 'The agent could not complete the task.' : !sessionPath ? 'The task finished but its conversation could not be saved.' : '') }); }
        if (event.type === 'extension_ui_request' && ['confirm', 'input', 'editor', 'select'].includes(event.method)) send({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true });
      }
    });
    // Do not persist stderr, which can contain provider or environment details.
    child.stderr.resume();
    child.on('error', error => finish({ ok: false, error: error.message }));
    child.on('close', code => finish({ ok: false, error: `The agent stopped before completing the task (exit ${code ?? 'unknown'}).` }));
    send({ type: 'set_session_name', name: task.title });
    send({ type: 'prompt', message: task.prompt });
  });
}
function acquireLock(dir) {
  const lock = path.join(dir, 'scheduled-task-runner.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      let pid = 0; try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch {}
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); return null; } catch (e) { if (e.code !== 'ESRCH') return null; } }
      else if (Date.now() - fs.statSync(lock).mtimeMs < 300000) return null;
      fs.rmSync(lock, { recursive: true, force: true }); fs.mkdirSync(lock, { mode: 0o700 });
    } catch { return null; }
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  return () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} };
}
async function runDueTasks(dir, { now = Date.now(), execute = runPi } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(dir); if (!release) return { skipped: true };
  try {
    const tasks = store.readTasks(dir), runs = store.readRuns(dir);
    let recovered = false;
    for (const state of Object.values(runs)) if (state.status === 'running') { state.status = 'failed'; state.error = 'The previous run was interrupted.'; state.finishedAt = now; recovered = true; }
    const due = tasks.filter(task => { const when = store.dueAt(task, runs[task.id]); return task.enabled && Number.isFinite(when) && when <= now; });
    if (!due.length) { if (recovered) store.saveRuns(dir, runs); return { ran: 0 }; }
    for (const task of due) {
      const state = runs[task.id] || { history: [] }; state.history = Array.isArray(state.history) ? state.history : [];
      state.lastScheduledAt = now; state.status = 'running'; state.startedAt = now; state.error = ''; runs[task.id] = state;
    }
    store.saveRuns(dir, runs);
    async function runTask(task) {
      const latest = store.readTasks(dir).find(item => item.id === task.id);
      if (!latest?.enabled || latest.notBefore !== task.notBefore) { const state = runs[task.id]; state.status = 'cancelled'; state.finishedAt = Date.now(); store.saveRuns(dir, runs); return; }
      let result; try { result = await execute(task); } catch (error) { result = { ok: false, error: error.message }; }
      const state = runs[task.id]; state.status = result.ok ? 'completed' : 'failed'; state.finishedAt = Date.now(); state.error = String(result.error || '').slice(0, 1000);
      const entry = { status: state.status, startedAt: state.startedAt, finishedAt: state.finishedAt, sessionPath: typeof result.sessionPath === 'string' ? result.sessionPath : '', error: state.error, projectId: task.projectId, cwd: task.cwd, title: task.title };
      if (entry.sessionPath) fs.appendFileSync(path.join(dir, 'scheduled-task-sessions.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
      state.history = [entry, ...state.history].slice(0, 20); store.saveRuns(dir, runs);
    }
    for (let i = 0; i < due.length; i += 3) await Promise.all(due.slice(i, i + 3).map(runTask));
    return { ran: due.length };
  } finally { release(); }
}
if (require.main === module) runDueTasks(process.argv[2]).catch(error => { console.error('Synthesis scheduled task runner:', error.message); process.exitCode = 1; });
module.exports = { runPi, runDueTasks };
