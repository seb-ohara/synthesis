'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');

test('sidebar chat opens in the active pane and saved state omits split layout', async t => {
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
  const activePaneId = await page.evaluate(() => activeWs().panes[activeWs().activePaneIdx].id);
  await page.locator('.chat-card').first().click();
  assert.equal(await page.locator('.ws-view.active .tile').count(), 2);
  const result = await page.evaluate(({ activePaneId, id }) => {
    const ws = activeWs(), active = ws.panes[ws.activePaneIdx];
    return { activePane: active.id, tab: active.activeTab.id, otherHasChat: ws.panes.find(pane => pane !== active).activeTab?.type };
  }, { activePaneId, id });
  assert.deepEqual(result, { activePane: activePaneId, tab: id, otherHasChat: 'chat' });
  assert.match(await page.locator('.ws-view.active .tile.active .chat-message.assistant').innerText(), /A response/);
  const singleChat = await page.evaluate(() => { const ws = activeWs(), pane = ws.panes[ws.activePaneIdx], original = pane.activeTab; original.isWorking = true; addPaneTab(ws, pane, { type: 'chat' }); const retained = ws.parkedTabs.includes(original) && original.isWorking; restoreParkedTab(original, pane); return { retained, visible: pane.tabs.filter(tab => tab.type !== 'terminal').length, active: pane.activeTab === original }; });
  assert.deepEqual(singleChat, { retained: true, visible: 1, active: true });
  const parkedCheck = await page.evaluate(() => {
    const ws = activeWs(), target = ws.panes[ws.activePaneIdx], other = ws.panes.find(pane => pane !== target), original = target.activeTab;
    const otherTab = other.activeTab; addPaneTab(ws, target, { type: 'chat' });
    openConversation(conversationRows().find(row => row.tab === original));
    return { count: ws.panes.length, active: target.activeTab === original, otherUnchanged: other.activeTab === otherTab };
  });
  assert.deepEqual(parkedCheck, { count: 2, active: true, otherUnchanged: true });
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
  const restored = await page.evaluate(() => { const ws = state.workspaces.find(item => item.id === 'ws-1'); return { panes: ws.panes.length, tabs: workspaceTabs(ws).map(tab => tab.id) }; });
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
  assert.equal(await split.locator('.pane-tab').count(), 1);
  await split.locator('.pane-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 1);
  const paneWidth = await page.locator('.ws-view.active .tile').evaluate(el => el.getBoundingClientRect().width);
  const centerWidth = await page.locator('#center').evaluate(el => el.getBoundingClientRect().width);
  assert.ok(Math.abs(paneWidth - centerWidth) < 2);
  await page.locator('.ws-view.active .pane-close').click();
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

test('browser panes can hold multiple tabs without mixing them with chats', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-browser-tabs-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  const types = await page.evaluate(() => {
    const ws = activeWs(), pane = ws.panes[0];
    addPaneTab(ws, pane, { type: 'browser' }); addPaneTab(ws, pane, { type: 'browser' });
    const browsers = pane.tabs.filter(tab => tab.type !== 'terminal').map(tab => tab.type);
    addPaneTab(ws, pane, { type: 'chat' });
    return { browsers, chats: pane.tabs.filter(tab => tab.type !== 'terminal').map(tab => tab.type) };
  });
  assert.deepEqual(types, { browsers: ['browser', 'browser'], chats: ['chat'] });
});


test('snooze menu is usable and the empty chat has even spacing', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-snooze-layout-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  const gaps = await page.evaluate(() => {
    const body = document.querySelector('.ws-view.active .chat-body');
    const heading = body.querySelector('.chat-welcome h2').getBoundingClientRect();
    const text = body.querySelector('.chat-welcome p').getBoundingClientRect();
    const composer = body.querySelector('.chat-composer').getBoundingClientRect();
    return [text.top - heading.bottom, composer.top - text.bottom];
  });
  assert.ok(Math.abs(gaps[0] - gaps[1]) < 2, `Welcome gaps: ${gaps}`);
  await page.evaluate(() => { const ws = activeWs(); const tab = ws.panes[0].activeTab; tab.hasConversation = true; renderList(); });
  await page.locator('.chat-card').first().hover();
  await page.locator('.conversation-snooze').first().click();
  await page.locator('#ctx-menu .ctx-item', { hasText: 'Custom…' }).click();
  const dialog = page.locator('#snooze-dialog'); await dialog.waitFor({ state: 'visible' });
  const position = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: innerWidth, height: innerHeight }; });
  assert.ok(Math.abs(position.x - position.width / 2) < 2 && Math.abs(position.y - position.height / 2) < 2);
  await page.locator('#snooze-cancel').click(); assert.equal(await dialog.isVisible(), false);
  await page.locator('.chat-card').first().hover();
  await page.locator('.conversation-snooze').first().click();
  await page.locator('#ctx-menu .ctx-item', { hasText: 'In 1 hour' }).click();
  assert.equal(await page.locator('.conversation-section[data-section="snoozed"] .chat-card').count(), 1);
});

test('chat pane resizing preserves composer controls at constrained widths', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-pane-minimum-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  const window = await app.browserWindow(page); await window.evaluate(win => win.setSize(1400, 800));
  await page.locator('.ws-view.active .pane-btn[data-action="splitRight"]').click();
  const divider = page.locator('.ws-view.active .split-divider-row').first(); await divider.waitFor();
  let rect = await divider.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await page.mouse.move(0, rect.y + rect.height / 2, { steps: 4 }); await page.mouse.up();
  let widths = await page.locator('.ws-view.active .tile').evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect().width));
  assert.ok(widths.every(width => width >= 359), `drag produced widths ${widths}`);
  await divider.focus(); for (let i = 0; i < 80; i++) await page.keyboard.press('ArrowRight');
  widths = await page.locator('.ws-view.active .tile').evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect().width));
  assert.ok(widths.every(width => width >= 359), `keyboard resize produced widths ${widths}`);
  await page.evaluate(() => document.querySelector('#app').style.setProperty('--ws-w', '560px'));
  await window.evaluate(win => win.setSize(980, 800));
  await page.waitForFunction(() => [...document.querySelectorAll('.ws-view.active .chat-body')].some(el => el.getBoundingClientRect().width < 360));
  await page.evaluate(() => {
    for (const body of document.querySelectorAll('.ws-view.active .chat-body')) {
      body.querySelector('.chat-model-label').textContent = 'A very long model name that should be truncated';
      body.querySelector('.chat-reasoning-label').textContent = 'Extra high';
    }
  });
  const controls = await page.locator('.ws-view.active .chat-body').evaluateAll(bodies => bodies.map(body => {
    const form = body.querySelector('.chat-composer').getBoundingClientRect();
    return [...body.querySelectorAll('.chat-attach, .chat-git, .chat-model-trigger, .chat-reasoning-trigger, .chat-send')].map(button => {
      const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.left >= form.left - 1 && rect.right <= form.right + 1 && rect.top >= form.top - 1 && rect.bottom <= form.bottom + 1;
    });
  }));
  assert.ok(controls.every(buttons => buttons.every(Boolean)), `controls escaped composer: ${JSON.stringify(controls)}`);
});
