'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PathGuard } = require('../../lib/path-guard');
const { createDocumentProtocol } = require('../../lib/document-protocol');

test('document previews resolve paths safely and render Markdown with an isolated policy', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'synthesis-doc-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside'); await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'my report.md'), '# Report\n**Visible**');
  await fs.writeFile(path.join(outside, 'secret.md'), 'Secret');
  await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
  const documents = createDocumentProtocol(new PathGuard({ home: root }));
  const prepared = await documents.prepare(root, 'my%20report.md:12');
  assert.equal(documents.owns(prepared.url), true);
  const response = await documents.handle({ url: prepared.url });
  assert.equal(response.status, 200); assert.match(await response.text(), /<strong>Visible<\/strong>/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'none'/);
  const raw = await documents.handle({ url: prepared.url + '?raw=1' });
  assert.match(await raw.text(), /\*\*Visible\*\*/);
  assert.equal((await documents.handle({ url: 'synthesis-doc://unknown/file.md' })).status, 404);
  await assert.rejects(documents.prepare(root, '../outside/secret.md'));
  await assert.rejects(documents.prepare(root, 'link.md'));
  await assert.rejects(documents.prepare(root, 'missing.md'));
});
