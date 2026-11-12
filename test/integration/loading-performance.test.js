'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');

test('restored chat controls initialize only when opened and retain all tab identities', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-lazy-chats-'));
  const workspaces = Array.from({ length: 8 }, (_, i) => {
    const id = `ws-${i + 1}`, paneId = `${id}-p1`;
    const tabs = Array.from({ length: 4 }, (_, n) => ({ id: `${id}-chat-${n}`, type: 'chat' }));
    return { id, name: `Project ${i}`, cwd: userData, fileDir: userData, activePaneId: paneId,
      panes: [{ id: paneId, type: 'chat', tabs, activeTabId: tabs[0].id }], layout: { paneId } };
  });
  fs.writeFileSync(path.join(userData, 'workspaces.json'), JSON.stringify({ schemaVersion: 2, activeWorkspaceId: 'ws-1', workspaces }));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData, PI_CODING_AGENT_DIR: path.join(userData, 'agent') }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow();
  await page.waitForSelector('.ws-view.active textarea');
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('chat:start'); ipcMain.handle('chat:start', () => ({ ok: true })); });
  const initial = await page.evaluate(() => state.workspaces.filter(ws => ws.name.startsWith('Project')).map(ws => ({
    ids: workspaceTabs(ws).map(tab => tab.id).sort(), controls: workspaceTabs(ws).filter(tab => tab.body.querySelector('textarea')).length,
  })));
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(initial[i].ids, workspaces[i].panes[0].tabs.map(tab => tab.id).sort());
    assert.equal(initial[i].controls, 0);
  }
  const opened = await page.evaluate(() => {
    setActive('ws-1'); setActive('ws-1');
    const ws = activeWs(), pane = ws.panes[0], first = pane.activeTab;
    restoreParkedTab(ws.parkedTabs[0], pane);
    return { firstControls: first.body.querySelectorAll('textarea').length,
      secondControls: pane.activeTab.body.querySelectorAll('textarea').length,
      initialized: workspaceTabs(ws).filter(tab => tab.body.querySelector('textarea')).length,
      saved: buildSnapshot().workspaces.find(item => item.id === ws.id).panes[0].tabs.map(tab => tab.id).sort() };
  });
  assert.equal(opened.firstControls, 1); assert.equal(opened.secondControls, 1);
  assert.equal(opened.initialized, 2);
  assert.deepEqual(opened.saved, initial[0].ids);
});
