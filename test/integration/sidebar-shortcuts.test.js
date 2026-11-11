'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');

test('sidebar controls and current default shortcuts work', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-shortcuts-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  assert.equal(await page.locator('#scheduled-tasks-btn').isVisible(), false);
  const controls = await page.evaluate(() => ['settings-btn', 'pi-update-btn', 'ws-collapse'].map(id => {
    const el = document.getElementById(id), rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, border: getComputedStyle(el).borderLeftWidth };
  }));
  assert.equal(controls[1].border, '0px'); assert.equal(controls[2].border, '0px');
  assert.ok(controls[1].left > controls[0].right && controls[2].left > controls[1].right);
  await page.keyboard.press('Meta+Shift+s');
  assert.equal(await page.locator('#app').evaluate(el => el.classList.contains('ws-collapsed')), true);
  await page.keyboard.press('Meta+Shift+f');
  assert.equal(await page.locator('#workspace-search').evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Meta+n');
  assert.equal(await page.locator('#ctx-menu').evaluate(el => el.classList.contains('visible')), true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+g');
  assert.equal(await page.locator('#git-panel').isVisible(), true);
  assert.equal(await page.locator('.ws-view.active .chat-git').getAttribute('aria-expanded'), 'true');
  const migrated = await page.evaluate(() => {
    localStorage.setItem('synthesis.settings', JSON.stringify({ shortcuts: { newSession: 'Meta+Shift+T', openFiles: 'Meta+O', splitRight: 'Meta+N' } }));
    return loadSettings().shortcuts;
  });
  assert.equal(migrated.newSession, 'Meta+Shift+N'); assert.equal(migrated.openFiles, 'Meta+Shift+G');
  assert.equal(migrated.splitRight, 'Meta+N'); assert.notEqual(migrated.newChat, 'Meta+N');
});
