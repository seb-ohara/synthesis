'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function launchAgentPlist({ label, node, worker, directory, home }) {
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const args = [node, worker, directory].map(arg => '<string>' + escape(arg) + '</string>').join('');
  const executablePath = path.join(home, '.local/bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${escape(label)}</string><key>ProgramArguments</key><array>${args}</array><key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/><key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(home)}</string><key>PATH</key><string>${escape(executablePath)}</string></dict><key>StandardErrorPath</key><string>${escape(path.join(directory, 'scheduled-tasks.log'))}</string></dict></plist>`;
}
function nextOccurrence(task, after) {
  const match = /^(\d{2}):(\d{2})$/.exec(task.time || '');
  if (!match || +match[1] > 23 || +match[2] > 59 || !['daily', 'weekdays', 'weekly'].includes(task.frequency)) return null;
  for (let i = 0; i <= 8; i++) {
    const date = new Date(after); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + i); date.setHours(+match[1], +match[2], 0, 0);
    if (date.getTime() <= after) continue;
    if (task.frequency === 'weekdays' && (date.getDay() === 0 || date.getDay() === 6)) continue;
    if (task.frequency === 'weekly' && date.getDay() !== task.day) continue;
    return date.getTime();
  }
  return null;
}
function validateTask(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid task.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!title || title.length > 120) throw new Error('Enter a task name of up to 120 characters.');
  if (!prompt || prompt.length > 50000) throw new Error('Enter task instructions of up to 50,000 characters.');
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || input.cwd.includes('\0')) throw new Error('Choose a project folder.');
  if (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 200) throw new Error('Choose a project.');
  const task = { title, prompt, cwd: input.cwd, projectId: input.projectId, frequency: input.frequency, time: input.time, day: Number(input.day) };
  if (task.frequency === 'weekly' && (!Number.isInteger(task.day) || task.day < 0 || task.day > 6)) throw new Error('Choose a day of the week.');
  if (!nextOccurrence(task, Date.now())) throw new Error('Choose a valid recurrence and time.');
  if (input.skillId) { if (!require('./skills').validId(input.skillId)) throw new Error('Invalid skill.'); task.skillId = input.skillId; }
  if (input.model && typeof input.model.provider === 'string' && typeof input.model.id === 'string' && input.model.provider.length <= 200 && input.model.id.length <= 300) task.model = { provider: input.model.provider, id: input.model.id };
  return task;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Could not read scheduled task data.'); }
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
function readTasks(dir) { const tasks = readJson(path.join(dir, 'scheduled-tasks.json'), []); if (!Array.isArray(tasks)) throw new Error('Invalid scheduled task data.'); return tasks; }
function readRuns(dir) { const runs = readJson(path.join(dir, 'scheduled-task-runs.json'), {}); if (!runs || typeof runs !== 'object' || Array.isArray(runs)) throw new Error('Invalid scheduled run data.'); return runs; }
function saveTasks(dir, tasks) { atomicWrite(path.join(dir, 'scheduled-tasks.json'), tasks); }
function saveRuns(dir, runs) { atomicWrite(path.join(dir, 'scheduled-task-runs.json'), runs); }
function dueAt(task, run) { return nextOccurrence(task, Math.max(task.notBefore || task.createdAt || 0, run?.lastScheduledAt || 0)); }
module.exports = { launchAgentPlist, nextOccurrence, validateTask, readTasks, readRuns, saveTasks, saveRuns, dueAt };
