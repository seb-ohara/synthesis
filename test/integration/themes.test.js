'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');

test('built-in themes apply, can be customised, and persist after restart', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-themes-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  let app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { if (app) await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  let page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await page.evaluate(() => openSettings());
  const presets = page.locator('[data-theme-preset]'); assert.equal(await presets.count(), 4);
  for (const [id, background] of [['warm-clay', 'rgb(248, 245, 237)'], ['midnight-ink', 'rgb(25, 27, 36)'], ['forest-moss', 'rgb(27, 33, 29)'], ['ocean-slate', 'rgb(25, 35, 42)']]) {
    const button = page.locator(`[data-theme-preset="${id}"]`); await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.ws-view.active .chat-body').evaluate(el => getComputedStyle(el).backgroundColor), background);
  }
  await page.locator('[data-theme-preset="warm-clay"]').click();
  const light = await page.evaluate(() => ({ background: getComputedStyle(document.querySelector('.chat-composer')).backgroundColor, text: getComputedStyle(document.querySelector('.chat-composer textarea')).color, sidebar: getComputedStyle(document.querySelector('#sidebar')).backgroundColor }));
  assert.deepEqual(light, { background: 'rgb(255, 253, 248)', text: 'rgb(48, 42, 37)', sidebar: 'rgb(238, 233, 221)' });
  await page.locator('#settings-done').click();
  await page.locator('#scheduled-tasks-btn').click();
  assert.equal(await page.locator('#scheduled-tasks-dialog').evaluate(el => getComputedStyle(el).color), 'rgb(48, 42, 37)');
  await page.locator('#scheduled-tasks-close').click();
  await app.close(); app = null;
  app = await _electron.launch({ args: [ROOT], cwd: ROOT, env }); page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'warm-clay');
  await page.evaluate(() => openSettings()); assert.equal(await page.locator('[data-theme-preset="warm-clay"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#setting-chat-background').evaluate(el => { el.value = '#f2e9de'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('[data-theme-preset="warm-clay"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => appSettings.chatBackground), '#f2e9de');
});
