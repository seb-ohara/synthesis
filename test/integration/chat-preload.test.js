'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const APP_OPTIONS = process.env.SYNTHESIS_TEST_EXECUTABLE ? { executablePath: process.env.SYNTHESIS_TEST_EXECUTABLE, args: [] } : { args: [ROOT] };

test('after relaunch saved content opens before the agent responds and send highlights only on hover', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-preload-ui-'));
  const cwd = path.join(temp, 'project'), userData = path.join(temp, 'userdata'), agentDir = path.join(temp, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(userData);
  const dir = path.join(agentDir, 'sessions', '--' + cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, 'saved.jsonl');
  const history = [{ role: 'user', content: 'A saved question', timestamp: 1000 }, { role: 'assistant', content: 'A saved answer', timestamp: 2000 }];
  fs.writeFileSync(sessionPath, [
    { type: 'session', version: 3, cwd },
    { type: 'message', id: 'a', parentId: null, message: history[0] },
    { type: 'message', id: 'b', parentId: 'a', message: history[1] },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  t.after(async () => { if (app) await app.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  let page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await page.evaluate(async ({ cwd, sessionPath }) => {
    const ws = createWorkspace({ name: 'Saved project', cwd });
    addPaneTab(ws, ws.panes[0], { type: 'chat', sessionPath }, false);
    rememberConversation(sessionPath);
    await window.mux.sessions.save(buildSnapshot());
  }, { cwd, sessionPath });
  await app.close(); app = null;
  app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  page = await app.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.ws-view.active .chat-body');
  // Leave the selected agent permanently unready: viewing must not depend on it.
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('chat:start'); ipcMain.handle('chat:start', () => ({ ok: true })); });
  const card = page.locator('.chat-card').filter({ hasText: 'A saved question' });
  await card.waitFor();
  const start = Date.now(); await card.click();
  await page.locator('.ws-view.active .chat-message.assistant').filter({ hasText: 'A saved answer' }).waitFor({ timeout: 5000 });
  t.diagnostic(`Saved content visible ${Date.now() - start} ms after click, without an agent response`);
  assert.equal(await page.locator('.ws-view.active .chat-body:not(.tab-hidden) .chat-send').isDisabled(), true);
  const tabId = await page.locator('.ws-view.active .chat-body:not(.tab-hidden)').evaluate(el => el.id.slice('panel-'.length));
  await page.evaluate(() => { window.__previewBody = document.querySelector('.ws-view.active .chat-body:not(.tab-hidden) .chat-messages'); window.__previewMessage = window.__previewBody.firstElementChild; });
  await app.evaluate(({ BrowserWindow }, { id, messages }) => BrowserWindow.getAllWindows()[0].webContents.send('chat:event', { id, event: { type: 'response', command: 'get_messages', success: true, data: { messages } } }), { id: tabId, messages: history });
  await page.waitForFunction(() => !document.querySelector('.ws-view.active .chat-body:not(.tab-hidden) .chat-model-trigger').disabled);
  assert.equal(await page.evaluate(() => window.__previewBody.firstElementChild === window.__previewMessage), true);
  await page.locator('.ws-view.active .chat-body:not(.tab-hidden) textarea').fill('Continue');
  const send = page.locator('.ws-view.active .chat-body:not(.tab-hidden) .chat-send');
  await page.mouse.move(0, 0);
  assert.equal(await send.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await send.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.ws-view.active .chat-body:not(.tab-hidden) .chat-send')).backgroundColor !== 'rgba(0, 0, 0, 0)');
  assert.deepEqual(errors, []);
});

test('a late disk preview cannot overwrite live agent history', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-preview-race-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ ...APP_OPTIONS, cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:start'); ipcMain.handle('chat:start', () => ({ ok: true }));
    ipcMain.removeHandler('chat:history'); ipcMain.handle('chat:history', () => new Promise(resolve => { globalThis.__releasePreview = resolve; }));
  });
  const id = await page.evaluate(() => {
    const ws = activeWs(), tab = addPaneTab(ws, ws.panes[0], { type: 'chat', sessionPath: '/delayed-preview.jsonl' }); return tab.id;
  });
  await app.evaluate(async ({ BrowserWindow }, id) => {
    // Wait for the renderer's history request to reach the main process.
    for (let i = 0; !globalThis.__releasePreview && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    BrowserWindow.getAllWindows()[0].webContents.send('chat:event', { id, event: { type: 'response', command: 'get_messages', success: true, data: { messages: [{ role: 'assistant', content: 'Current agent response' }] } } });
    globalThis.__releasePreview({ ok: true, messages: [{ role: 'assistant', content: 'Outdated disk response' }] });
  }, id);
  await page.locator('.ws-view.active .chat-body:not(.tab-hidden) .chat-message.assistant').filter({ hasText: 'Current agent response' }).waitFor();
  // The IPC response and event have both been delivered before this round trip.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.getByText('Outdated disk response', { exact: true }).count(), 0);
});
