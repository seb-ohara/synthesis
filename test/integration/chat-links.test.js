'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const APP_OPTIONS = process.env.SYNTHESIS_TEST_EXECUTABLE ? { executablePath: process.env.SYNTHESIS_TEST_EXECUTABLE, args: [] } : { args: [ROOT] };

test('chat document and web links open in browser tabs and chosen splits', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-links-'));
  const project = path.join(temp, 'project'), userData = path.join(temp, 'userdata'); fs.mkdirSync(project); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(project, 'report.md'), '# Document heading\nHello from **Markdown**.\n');
  fs.writeFileSync(path.join(project, 'sample.html'), '<!doctype html><title>HTML test</title><h1>Local HTML works</h1>');
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForSelector('.ws-view.active .chat-body');
  const tabId = await page.evaluate(cwd => { const ws = createWorkspace({ name: 'Project', cwd }); setActive(ws.id); return ws.panes[0].activeTab.id; }, project);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('chat:event', { id, event: { type: 'response', command: 'get_messages', success: true, data: { messages: [{ role: 'assistant', content: 'Read `report.md`, [HTML document](sample.html), and [website](https://example.com). Avoid [unsafe](javascript:alert(1)).' }] } } }), tabId);
  await page.waitForSelector('.chat-message.assistant a[href="report.md"]');
  assert.equal(await page.locator('.chat-message.assistant a[href^="javascript:"]').count(), 0);
  await page.locator('.chat-message.assistant a[href="report.md"]').click();
  await page.waitForFunction(() => document.querySelector('.ws-view.active .browser-url')?.value.includes('report.md'));
  const doc = await app.evaluate(async ({ BrowserWindow }) => {
    let view; for (let i = 0; i < 100 && !view; i++) { view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents.getURL().includes('report.md')); if (!view) await new Promise(resolve => setTimeout(resolve, 10)); }
    if (!view) return null;
    await new Promise(resolve => view.webContents.isLoading() ? view.webContents.once('did-stop-loading', resolve) : resolve());
    return { url: view.webContents.getURL(), body: await view.webContents.executeJavaScript('document.body.innerText') };
  });
  assert.match(doc.url, /^synthesis-doc:/); assert.match(doc.body, /Document heading/); assert.match(doc.body, /Hello from Markdown/);
  assert.equal(await page.locator('.ws-view.active .tile').count(), 2);
  assert.equal(await page.locator('.ws-view.active .chat-message.assistant').count(), 1);
  await page.locator('.chat-message.assistant a[href="sample.html"]').click({ button: 'right' });
  assert.equal(await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Show in Finder' }).isVisible(), true);
  assert.equal(await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Open in this pane' }).count(), 0);
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Open in pane 2' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.ws-view.active .browser-url')].some(input => input.value.includes('sample.html')));
  const html = await app.evaluate(async ({ BrowserWindow }) => {
    let view;
    for (let i = 0; i < 100 && !view; i++) { view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents.getURL().includes('sample.html')); if (!view) await new Promise(resolve => setTimeout(resolve, 10)); }
    if (!view) return ''; 
    await new Promise(resolve => view.webContents.isLoading() ? view.webContents.once('did-stop-loading', resolve) : resolve());
    return view.webContents.executeJavaScript('document.body.innerText');
  });
  assert.match(html, /Local HTML works/);
  await page.locator('.chat-message.assistant a[href="https://example.com"]').click({ button: 'right' });
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Open in pane 2' }).click();
  await page.waitForFunction(() => { const ws = activeWs(); return ws.panes[1]?.activeTab?.type === 'browser' && ws.panes[1].activeTab.currentUrl.startsWith('https://example.com'); });
  assert.deepEqual(errors, []);
});

test('PDF documents open within a browser surface', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-pdf-'));
  const project = path.join(temp, 'project'), userData = path.join(temp, 'userdata'); fs.mkdirSync(project); fs.mkdirSync(userData);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(project, 'sample.pdf'), pdf);
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  const tabId = await page.evaluate(cwd => { const ws = createWorkspace({ name: 'Project', cwd }); setActive(ws.id); return ws.panes[0].activeTab.id; }, project);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('chat:event', { id, event: { type: 'response', command: 'get_messages', success: true, data: { messages: [{ role: 'assistant', content: 'Here is sample.pdf.' }] } } }), tabId);
  await page.locator('.chat-message.assistant a[href="sample.pdf"]').click();
  await page.waitForFunction(() => document.querySelector('.ws-view.active .browser-url')?.value.includes('sample.pdf'));
  const result = await app.evaluate(async ({ BrowserWindow }) => {
    let view; for (let i = 0; i < 200 && !view; i++) { view = BrowserWindow.getAllWindows()[0].contentView.children.find(child => child.webContents.getURL().includes('sample.pdf')); if (!view) await new Promise(resolve => setTimeout(resolve, 10)); }
    if (!view) return null;
    return { url: view.webContents.getURL(), type: await view.webContents.executeJavaScript('document.contentType'), body: await view.webContents.executeJavaScript('document.body.innerHTML.slice(0,1000)') };
  });
  assert.ok(result, 'PDF must load in an in-app view');
  assert.match(result.url, /sample\.pdf/);
  assert.equal(result.type, 'application/pdf');
});

test('a saved document tab can be reopened after relaunch', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-doc-restore-'));
  const project = path.join(temp, 'project'), userData = path.join(temp, 'userdata'); fs.mkdirSync(project); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(project, 'report.md'), '# Restored document');
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  t.after(async () => { if (app) await app.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  let page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  const wsId = await page.evaluate(cwd => { const ws = createWorkspace({ name: 'Restored project', cwd }); setActive(ws.id); openChatTarget(ws, ws.panes[0], cwd, 'report.md', 'tab'); return ws.id; }, project);
  await page.waitForFunction(() => activeWs().panes[0].activeTab.currentUrl.startsWith('synthesis-doc:'));
  const snapshot = await page.evaluate(() => buildSnapshot());
  const saved = snapshot.workspaces.find(ws => ws.name === 'Restored project').panes[0].tabs.find(tab => tab.type === 'browser');
  assert.match(saved.url, /^file:\/\//);
  await page.evaluate(snapshot => window.mux.sessions.save(snapshot), snapshot);
  await app.close(); app = null;
  app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await page.evaluate(id => { const ws = state.workspaces.find(item => item.id === id); setActive(id); const pane = ws.panes[0]; activateTab(ws, pane, pane.tabs.find(tab => tab.type === 'browser')); }, wsId);
  await page.waitForFunction(() => activeWs().panes[0].activeTab.currentUrl.startsWith('synthesis-doc:'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('.ws-view.active .browser-url')?.value.endsWith('/report.md'));
  assert.equal(await page.locator('.ws-view.active .browser-url').inputValue(), fs.realpathSync(path.join(project, 'report.md')));
});
