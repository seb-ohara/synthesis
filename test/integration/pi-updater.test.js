'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');

test('Pi update button reports availability and runs the requested update', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-pi-update-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const appOptions = process.env.SYNTHESIS_TEST_EXECUTABLE ? { executablePath: process.env.SYNTHESIS_TEST_EXECUTABLE, args: [] } : { args: [ROOT] };
  const app = await _electron.launch({ ...appOptions, cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pi:check-update'); ipcMain.removeHandler('pi:update'); globalThis.__piUpdates = 0;
    ipcMain.handle('pi:check-update', () => ({ ok: true, installed: '1.5.0', latest: '1.5.2', available: true }));
    ipcMain.handle('pi:update', () => { globalThis.__piUpdates++; return { ok: true, installed: '1.5.2', latest: '1.5.2', available: false }; });
  });
  await page.evaluate(async () => { while (piUpdateBusy) await new Promise(resolve => setTimeout(resolve, 20)); await checkPiUpdate(); });
  const button = page.locator('#pi-update-btn');
  assert.equal(await page.locator('#ws-count').count(), 0);
  assert.equal(await button.locator('.pi-update-dot').isVisible(), true);
  assert.match(await button.getAttribute('aria-label'), /1.5.2/);
  await button.click(); assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.match(await page.locator('#ctx-menu').innerText(), /Available: 1.5.2/);
  await page.locator('#ctx-menu .ctx-item', { hasText: 'Update Pi' }).click();
  await page.waitForFunction(() => document.querySelector('#ctx-menu')?.textContent.includes('Updated. New chats use this version.'));
  assert.equal(await app.evaluate(() => globalThis.__piUpdates), 1);
  assert.equal(await button.locator('.pi-update-dot').isVisible(), false);
  await page.keyboard.press('Escape'); assert.equal(await button.getAttribute('aria-expanded'), 'false');
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('pi:check-update'); ipcMain.handle('pi:check-update', () => ({ ok: false, error: 'Registry unavailable' })); });
  await page.evaluate(() => checkPiUpdate());
  await button.click(); assert.match(await page.locator('#ctx-menu').innerText(), /Registry unavailable/);
  assert.equal(await page.locator('#ctx-menu .ctx-item', { hasText: 'Update Pi' }).count(), 0);
  assert.equal(await page.locator('#ctx-menu .ctx-item', { hasText: 'Check for updates' }).count(), 1);
});
