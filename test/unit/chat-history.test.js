'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { visibleHistory, createHistoryReader } = require('../../lib/chat-history');
const cwd = '/test/project';
const header = { type: 'session', version: 3, cwd };
const message = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content } });
const source = entries => [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('preloaded history follows the active branch and preserves images and rich text', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' };
  const entries = [message('a', null, 'user', [{ type: 'text', text: 'Question' }, image]), message('old', 'a', 'assistant', 'Old branch'), message('new', 'a', 'assistant', 'Current branch'), { ...message('tool', 'new', 'toolResult', [{ type: 'text', text: 'Rich output' }]), message: { role: 'toolResult', toolName: 'rich_text', content: [{ type: 'text', text: 'Rich output' }] } }];
  const history = visibleHistory(source(entries), cwd);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'toolResult']);
  assert.equal(history[1].content, 'Current branch');
  assert.deepEqual(history[0].content[1], image);
});

test('preloaded history respects compaction and context edits', () => {
  const entries = [message('a', null, 'user', 'Summarized'), message('b', 'a', 'user', 'Keep'), message('c', 'b', 'assistant', 'Original'), { type: 'compaction', id: 'd', parentId: 'c', firstKeptEntryId: 'b' }, { type: 'context_edit', id: 'e', parentId: 'd', targetId: 'c', replacement: { content: 'Edited' } }, message('f', 'e', 'user', 'Removed'), { type: 'context_edit', id: 'g', parentId: 'f', targetId: 'f', replacement: null }];
  assert.deepEqual(visibleHistory(source(entries), cwd).map(m => m.content), ['Keep', 'Edited']);
});

test('preloading rejects unknown formats, wrong projects and invalid branches', () => {
  assert.throws(() => visibleHistory(source([]), '/other'));
  assert.throws(() => visibleHistory(JSON.stringify({ ...header, version: 4 }), cwd));
  assert.throws(() => visibleHistory(source([message('a', 'missing', 'user', 'Invalid')]), cwd));
  assert.throws(() => visibleHistory(source([message('a', 'b', 'user', 'Cycle'), message('b', 'a', 'assistant', 'Cycle')]), cwd));
});

test('cached history reloads changed files and bounds retained entries', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synthesis-history-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.jsonl'), second = path.join(dir, 'other.jsonl');
  await fs.writeFile(file, source([message('a', null, 'user', 'First')]));
  const reader = createHistoryReader({ maxEntries: 1 });
  const first = await reader.load(cwd, file);
  assert.equal((await reader.load(cwd, file)), first);
  await fs.writeFile(file, source([message('a', null, 'user', 'Updated content')]));
  const updated = await reader.load(cwd, file);
  assert.equal(updated[0].content, 'Updated content');
  await fs.writeFile(second, source([message('b', null, 'user', 'Other')]));
  await reader.load(cwd, second);
  assert.notEqual(await reader.load(cwd, file), updated);
  await fs.unlink(file);
  await assert.rejects(reader.load(cwd, file));
});

test('the history preview exposes model and reasoning from the selected branch', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synthesis-history-selection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chat.jsonl');
  await fs.writeFile(file, source([
    { type: 'model_change', id: 'a', parentId: null, provider: 'openai', modelId: 'first' },
    { type: 'thinking_level_change', id: 'b', parentId: 'a', thinkingLevel: 'low' },
    { type: 'model_change', id: 'old', parentId: 'b', provider: 'openrouter', modelId: 'abandoned' },
    { type: 'model_change', id: 'c', parentId: 'b', provider: 'openai', modelId: 'current' },
    { type: 'thinking_level_change', id: 'd', parentId: 'c', thinkingLevel: 'high' },
    message('e', 'd', 'user', 'Hello'),
  ]));
  const projection = await createHistoryReader().loadProjection(cwd, file);
  assert.deepEqual(projection.selection, { model: { provider: 'openai', id: 'current' }, reasoning: 'high' });
  assert.equal(projection.messages[0].content, 'Hello');
});

test('pooled readers isolate concurrent files and recover after invalid sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synthesis-history-workers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reader = createHistoryReader(), files = Array.from({ length: 12 }, (_, i) => path.join(dir, `${i}.jsonl`));
  await Promise.all(files.map((file, i) => fs.writeFile(file, i === 3 ? 'invalid session' : source([message('a', null, 'user', `File ${i}`)]))));
  const results = await Promise.allSettled(files.map(file => reader.load(cwd, file)));
  results.forEach((result, i) => {
    assert.equal(result.status, i === 3 ? 'rejected' : 'fulfilled');
    if (result.status === 'fulfilled') assert.equal(result.value[0].content, `File ${i}`);
  });
  await fs.writeFile(files[3], source([message('a', null, 'user', 'Repaired')]));
  assert.equal((await reader.load(cwd, files[3]))[0].content, 'Repaired');
  const [first, second] = await Promise.all([reader.load(cwd, files[0]), reader.load(cwd, files[0])]);
  assert.equal(first, second);
});
