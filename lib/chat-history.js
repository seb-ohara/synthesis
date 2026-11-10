'use strict';
// Read-only display projection of Pi v2/v3 sessions. The agent remains the
// authority for continuing the session; unsupported formats use its normal load.
const fs = require('node:fs/promises');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function visibleProjection(source, cwd) {
  const entries = source.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; } });
  const header = entries.shift();
  if (header?.type !== 'session' || header.cwd !== cwd || ![2, 3].includes(header.version)) throw new Error('Unsupported session format');
  if (!entries.length) return { messages: [], selection: {} };
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  if (entries.some(entry => typeof entry.id !== 'string')) throw new Error('Unsupported session entries');
  const branch = [], seen = new Set();
  let current = entries.at(-1);
  while (current) {
    if (seen.has(current.id)) throw new Error('Invalid session branch');
    seen.add(current.id); branch.push(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId);
    if (!current) throw new Error('Incomplete session branch');
  }
  branch.reverse();
  const selection = {};
  for (const entry of branch) {
    if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') selection.model = { provider: entry.provider, id: entry.modelId };
    if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') selection.reasoning = entry.thinkingLevel;
    if (entry.type === 'message' && entry.message?.role === 'assistant' && !selection.model && typeof entry.message.provider === 'string' && typeof entry.message.model === 'string') selection.model = { provider: entry.message.provider, id: entry.message.model };
  }
  const compactIndex = branch.findLastIndex(entry => entry.type === 'compaction');
  let context = branch;
  if (compactIndex !== -1) {
    const keepIndex = branch.findIndex(entry => entry.id === branch[compactIndex].firstKeptEntryId);
    context = [...(keepIndex >= 0 && keepIndex < compactIndex ? branch.slice(keepIndex, compactIndex) : []), ...branch.slice(compactIndex + 1)];
  }
  const edits = new Map(context.filter(entry => entry.type === 'context_edit').map(entry => [entry.targetId, entry]));
  const messages = context.flatMap(entry => {
    if (entry.type !== 'message' || !entry.message) return [];
    const message = entry.message;
    if (!['user', 'assistant'].includes(message.role) && !(message.role === 'toolResult' && message.toolName === 'rich_text')) return [];
    const edit = edits.get(entry.id);
    if (edit?.replacement === null) return [];
    if (edit && (!edit.replacement || !('content' in edit.replacement))) throw new Error('Unsupported context edit');
    return [{ ...message, content: edit ? edit.replacement.content : message.content ?? [] }];
  });
  return { messages, selection };
}
function visibleHistory(source, cwd) { return visibleProjection(source, cwd).messages; }

function createHistoryReader({ maxBytes = 24 * 1024 * 1024, maxEntries = 8 } = {}) {
  const cache = new Map(), pending = new Map();
  let bytes = 0;
  function discard(file) { const item = cache.get(file); if (item) { bytes -= item.size; cache.delete(file); } }
  async function loadProjection(cwd, file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Session is too large to preload');
    const fingerprint = `${cwd}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = cache.get(file);
    if (cached?.fingerprint === fingerprint) { cache.delete(file); cache.set(file, cached); return cached.projection; }
    discard(file);
    const key = file + '\0' + fingerprint;
    if (pending.has(key)) return pending.get(key);
    const task = new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { cwd, file, maxBytes: MAX_FILE_BYTES } });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('History preload timed out')); }, 5000);
      worker.once('message', result => { clearTimeout(timer); result.ok ? resolve(result.projection) : reject(new Error(result.error)); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('History preload stopped')); });
    }).then(async projection => {
      const latest = await fs.stat(file);
      if (`${cwd}\0${latest.dev}:${latest.ino}:${latest.size}:${latest.mtimeMs}:${latest.ctimeMs}` !== fingerprint) throw new Error('Session changed while loading');
      discard(file);
      cache.set(file, { fingerprint, projection, size: stat.size }); bytes += stat.size;
      while (cache.size > maxEntries || bytes > maxBytes) discard(cache.keys().next().value);
      return projection;
    }).finally(() => pending.delete(key));
    pending.set(key, task); return task;
  }
  return { load: async (cwd, file) => (await loadProjection(cwd, file)).messages, loadProjection };
}
if (!isMainThread) {
  (async () => {
    const handle = await fs.open(workerData.file, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > workerData.maxBytes) throw new Error('Session is too large to preload');
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      parentPort.postMessage({ ok: true, projection: visibleProjection(buffer.subarray(0, offset).toString('utf8'), workerData.cwd) });
    } finally { await handle.close(); }
  })().catch(error => parentPort.postMessage({ ok: false, error: error.message }));
}
module.exports = { visibleHistory, createHistoryReader };
