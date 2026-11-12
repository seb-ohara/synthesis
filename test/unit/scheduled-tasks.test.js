'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextOccurrence, validateTask, saveTasks, readRuns } = require('../../lib/scheduled-tasks');
const { runDueTasks, runPi } = require('../../scheduler-worker');

test('daily, weekday and weekly schedules use local calendar time', () => {
  const friday = new Date(2026, 10, 13, 10, 0).getTime();
  assert.equal(nextOccurrence({ frequency: 'daily', time: '09:00' }, friday), new Date(2026, 10, 14, 9).getTime());
  assert.equal(nextOccurrence({ frequency: 'weekdays', time: '09:00' }, friday), new Date(2026, 10, 16, 9).getTime());
  assert.equal(nextOccurrence({ frequency: 'weekly', time: '09:00', day: 5 }, friday), new Date(2026, 10, 20, 9).getTime());
  assert.equal(nextOccurrence({ frequency: 'daily', time: '28:99' }, friday), null);
  assert.throws(() => validateTask({ title: 'x', prompt: 'y', cwd: '/tmp', projectId: 'p', frequency: 'weekly', day: 9, time: '09:00' }), /day/);
});

test('due tasks run once, recover missed intervals and retain session details', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date(2026, 10, 16, 10).getTime(), createdAt = new Date(2026, 10, 13, 10).getTime();
  const task = { id: 'one', title: 'Daily task', prompt: 'Do work', projectId: 'p', cwd: dir, frequency: 'daily', time: '09:00', createdAt, enabled: true };
  saveTasks(dir, [task]); let calls = 0;
  const execute = async () => { calls++; return { ok: true, sessionPath: '/some/chat.jsonl' }; };
  assert.deepEqual(await runDueTasks(dir, { now, execute }), { ran: 1 });
  assert.equal(calls, 1); assert.equal(readRuns(dir).one.status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'scheduled-task-sessions.jsonl'), 'utf8')).sessionPath, '/some/chat.jsonl');
  assert.deepEqual(await runDueTasks(dir, { now: now + 60000, execute }), { ran: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(await runDueTasks(dir, { now: new Date(2026, 10, 17, 9, 1).getTime(), execute: async () => ({ ok: false, error: 'No model' }) }), { ran: 1 });
  assert.equal(readRuns(dir).one.error, 'No model');
});

test('the background Pi runner sends a prompt and records the finished session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-scheduled-pi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst rl = require('readline').createInterface({input:process.stdin}); rl.on('line', line => { const c = JSON.parse(line); if (c.type === 'prompt') { if (c.message !== 'Run the task') process.exit(2); console.log(JSON.stringify({type:'response',command:'prompt',success:true})); console.log(JSON.stringify({type:'agent_settled'})); } if (c.type === 'get_state') console.log(JSON.stringify({type:'response',command:'get_state',success:true,data:{sessionFile:'/tmp/result.jsonl'}})); });\n`, { mode: 0o700 });
  const result = await runPi({ title: 'Task', prompt: 'Run the task', cwd: dir }, { executable: fake, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: true, sessionPath: '/tmp/result.jsonl', error: '' });
});

test('overlapping scheduler invocations do not run a task twice', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-schedule-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date(2026, 10, 16, 10).getTime();
  saveTasks(dir, [{ id: 'one', title: 'Task', prompt: 'Work', projectId: 'p', cwd: dir, frequency: 'daily', time: '09:00', createdAt: now - 86400000, enabled: true }]);
  let unblock, started; const running = new Promise(resolve => { started = resolve; });
  const first = runDueTasks(dir, { now, execute: () => new Promise(resolve => { unblock = resolve; started(); }) });
  await running; assert.deepEqual(await runDueTasks(dir, { now, execute: () => { throw new Error('duplicate'); } }), { skipped: true });
  unblock({ ok: true, sessionPath: '/tmp/one.jsonl' }); assert.deepEqual(await first, { ran: 1 });
});

test('macOS launch agent configuration is valid and contains no task instructions', t => {
  if (process.platform !== 'darwin') return t.skip('macOS plist tooling is unavailable');
  const { execFileSync } = require('child_process'); const { launchAgentPlist } = require('../../lib/scheduled-tasks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-schedule-plist-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agent.plist'); fs.writeFileSync(file, launchAgentPlist({ label: 'test.synthesis', node: '/usr/local/bin/node', worker: '/tmp/a & b/worker.js', directory: dir, home: '/Users/test' }));
  assert.match(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' }), /OK/);
  assert.match(fs.readFileSync(file, 'utf8'), /a &amp; b/);
});

test('a stale incomplete scheduler lock does not block future tasks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-schedule-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'scheduled-task-runner.lock'); fs.mkdirSync(lock);
  const old = new Date(Date.now() - 600000); fs.utimesSync(lock, old, old);
  assert.deepEqual(await runDueTasks(dir), { ran: 0 });
});

test('scheduled skills resolve at run time and missing skills fail before launch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-scheduled-skill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'skills', 'writing'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'writing', 'SKILL.md'), '---\nname: writing\ndescription: Writing help\n---\nBe concise.');
  const fake = path.join(dir, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const c=JSON.parse(line);if(c.type==='prompt'){if(!c.message.includes('Be concise.')||!c.message.includes('Draft text'))process.exit(2);console.log(JSON.stringify({type:'agent_settled'}));}if(c.type==='get_state')console.log(JSON.stringify({type:'response',command:'get_state',success:true,data:{sessionFile:'/tmp/result.jsonl'}}));});`, { mode: 0o700 });
  const task = { title: 'Task', prompt: 'Draft text', cwd: dir, skillRoot: dir, skillId: 'writing' };
  assert.equal((await runPi(task, { executable: fake, timeoutMs: 5000 })).ok, true);
  fs.rmSync(path.join(dir, 'skills', 'writing'), { recursive: true });
  assert.match((await runPi(task, { executable: fake, timeoutMs: 5000 })).error, /unavailable/);
});
