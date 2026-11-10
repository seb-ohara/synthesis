'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');

test('sidebar chat opens a single pane and saved state omits split layout', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-layout-test-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { if (app) await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  let page = await app.firstWindow();
  await page.waitForSelector('.ws-view.active .chat-body');
  const id = await page.locator('.ws-view.active .chat-body').evaluate(el => el.id.slice('panel-'.length));
  await page.waitForFunction(() => !document.querySelector('.ws-view.active .chat-model-trigger').disabled, null, { timeout: 30000 });
  await app.evaluate(({ BrowserWindow }, tabId) => {
    BrowserWindow.getAllWindows()[0].webContents.send('chat:event', { id: tabId, event: {
      type: 'response', command: 'get_messages', success: true,
      data: { messages: [{ role: 'user', content: 'A sample conversation' }, { role: 'assistant', content: 'A response' }] },
    } });
  }, id);
  await page.waitForSelector('.chat-card');
  await page.locator('.ws-view.active .pane-btn[data-action="splitRight"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 2);
  await page.evaluate(() => { const ws = activeWs(); ws.tree.weights = [0.35, 1.65]; applySplitWeights(ws.tree, ws.view.querySelector('.split')); });
  const snapshot = await page.evaluate(() => buildSnapshot().workspaces.find(ws => ws.id === state.activeId));
  assert.equal(snapshot.panes.length, 1);
  assert.equal(snapshot.panes[0].tabs.length, 2);
  assert.equal(snapshot.layout.paneId, snapshot.panes[0].id);
  await page.locator('.chat-card').first().click();
  assert.equal(await page.locator('.ws-view.active .tile').count(), 1);
  const geometry = await page.evaluate(() => ({ pane: document.querySelector('.ws-view.active .tile').getBoundingClientRect().width, center: document.querySelector('#center').getBoundingClientRect().width }));
  assert.ok(Math.abs(geometry.pane - geometry.center) < 2, `pane ${geometry.pane} should fill center ${geometry.center}`);
  assert.equal(await page.locator('.ws-view.active .pane-tab').count(), 2);
  assert.match(await page.locator('.ws-view.active .chat-message.assistant').innerText(), /A response/);
  await page.locator('.ws-view.active .pane-btn[data-action="splitRight"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 2);
  await app.close(); app = null;
  app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  page = await app.firstWindow();
  await page.waitForSelector('.ws-view.active .chat-body');
  assert(await page.evaluate(() => state.workspaces.every(ws => ws.panes.length === 1)));
});

test('older saved splits restore as one pane without dropping tabs', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-layout-migration-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const pane = id => ({ id, type: 'chat', activeTabId: id, hasTerminal: false, tabs: [{ id, type: 'chat' }] });
  fs.writeFileSync(path.join(userData, 'workspaces.json'), JSON.stringify({ schemaVersion: 2, activeWorkspaceId: 'ws-1', workspaces: [{
    id: 'ws-1', name: 'Existing project', cwd: os.tmpdir(), fileDir: os.tmpdir(), activePaneId: 'ws-1-p2',
    panes: [pane('ws-1-p1'), pane('ws-1-p2')], layout: { type: 'split', direction: 'row', children: [{ paneId: 'ws-1-p1' }, { paneId: 'ws-1-p2' }], weights: [1, 1] },
  }] }));
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  const restored = await page.evaluate(() => { const ws = state.workspaces.find(item => item.id === 'ws-1'); return { panes: ws.panes.length, tabs: ws.panes.flatMap(p => p.tabs.map(tab => tab.id)) }; });
  assert.equal(restored.panes, 1);
  assert.deepEqual(new Set(restored.tabs), new Set(['ws-1-p1', 'ws-1-p2']));
});

test('closing the last tab closes its split while preserving the final pane', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-close-split-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await page.evaluate(() => { appSettings.confirmClose = false; });
  await page.locator('.ws-view.active .pane-btn[data-action="splitRight"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 2);
  const split = page.locator('.ws-view.active .tile').last();
  await page.evaluate(() => { const ws = activeWs(); addPaneTab(ws, ws.panes[ws.activePaneIdx], { type: 'chat' }); });
  assert.equal(await split.locator('.pane-tab').count(), 2);
  await split.locator('.pane-tab-close').last().click();
  assert.equal(await page.locator('.ws-view.active .tile').count(), 2);
  assert.equal(await split.locator('.pane-tab').count(), 1);
  await split.locator('.pane-tab-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 1);
  const paneWidth = await page.locator('.ws-view.active .tile').evaluate(el => el.getBoundingClientRect().width);
  const centerWidth = await page.locator('#center').evaluate(el => el.getBoundingClientRect().width);
  assert.ok(Math.abs(paneWidth - centerWidth) < 2);
  await page.locator('.ws-view.active .pane-tab-close').click();
  assert.equal(await page.locator('.ws-view.active .tile').count(), 1);
  assert.equal(await page.locator('.ws-view.active .chat-body').count(), 1);
});

test('long chat histories render in one layout pass and preserve message order', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-history-speed-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.waitForSelector('.ws-view.active .chat-body');
  await page.waitForFunction(() => !document.querySelector('.ws-view.active .chat-model-trigger').disabled, null, { timeout: 30000 });
  const id = await page.locator('.ws-view.active .chat-body').evaluate(el => el.id.slice('panel-'.length));
  await page.evaluate(() => {
    const scroll = document.querySelector('.ws-view.active .chat-scroll');
    const getter = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight').get;
    window.__historyLayoutReads = 0;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get() { window.__historyLayoutReads++; return getter.call(this); } });
  });
  await app.evaluate(({ BrowserWindow }, tabId) => {
    const messages = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` }));
    BrowserWindow.getAllWindows()[0].webContents.send('chat:event', { id: tabId, event: { type: 'response', command: 'get_messages', success: true, data: { messages } } });
  }, id);
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .chat-message').length === 200);
  const result = await page.evaluate(() => ({ reads: window.__historyLayoutReads, texts: [...document.querySelectorAll('.ws-view.active .chat-message-content')].map(node => node.textContent) }));
  assert.ok(result.reads <= 2, `Expected one layout read, got ${result.reads}`);
  assert.equal(result.texts[0].trim(), 'Message 0');
  assert.equal(result.texts.at(-1).trim(), 'Message 199');
});

test('session metadata refresh notices changes after a cached scan', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-scan-cache-'));
  const project = path.join(temp, 'project'); const userData = path.join(temp, 'userdata'); const agentDir = path.join(temp, 'agent');
  fs.mkdirSync(project); fs.mkdirSync(userData);
  const dir = path.join(agentDir, 'sessions', '--' + project.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const session = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(session, JSON.stringify({ type: 'session', cwd: project }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: 'First title', timestamp: 1000 } }) + '\n');
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.evaluate(cwd => window.mux.app.allowRoot(cwd), project);
  const scan = () => page.evaluate(({ cwd, file }) => window.mux.chat.sessions(cwd, [file]), { cwd: project, file: session });
  assert.equal((await scan())[0].title, 'First title');
  assert.equal((await scan())[0].title, 'First title');
  fs.appendFileSync(session, JSON.stringify({ type: 'session_info', name: 'Updated title' }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Done', timestamp: 5000 } }) + '\n');
  const updated = (await scan())[0];
  assert.equal(updated.title, 'Updated title');
  assert.equal(updated.modified, 5000);
});
