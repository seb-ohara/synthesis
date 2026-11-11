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
  const presets = page.locator('[data-theme-preset]'); assert.equal(await presets.count(), 5);
  assert.equal(await page.locator('[data-theme-preset="original-dark"]').getAttribute('aria-pressed'), 'true');
  for (const [id, background] of [['warm-clay', 'rgb(248, 245, 237)'], ['midnight-ink', 'rgb(25, 27, 36)'], ['forest-moss', 'rgb(27, 33, 29)'], ['ocean-slate', 'rgb(25, 35, 42)']]) {
    const button = page.locator(`[data-theme-preset="${id}"]`); await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.ws-view.active .chat-body').evaluate(el => getComputedStyle(el).backgroundColor), background);
  }
  await page.locator('[data-theme-preset="original-dark"]').click();
  const original = await page.evaluate(() => ({ theme: appSettings.theme, accent: appSettings.accentColor, background: appSettings.chatBackground, sidebar: appSettings.sidebarColor, bubble: appSettings.bubbleColor, text: appSettings.chatText }));
  assert.deepEqual(original, { theme: '', accent: '#ff7a1a', background: '#141416', sidebar: '#101011', bubble: '#29383b', text: '#e9e9eb' });
  assert.equal(await page.locator('[data-theme-preset="original-dark"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.ws-view.active .tile.active').evaluate(el => getComputedStyle(el).borderLeftColor), 'rgb(98, 98, 98)');
  await page.locator('[data-accent="synthesis"]').click();
  assert.equal(await page.locator('.ws-view.active .tile.active').evaluate(el => getComputedStyle(el).borderLeftColor), 'rgb(98, 98, 98)');
  await page.locator('[data-theme-preset="warm-clay"]').click();
  assert.equal(await page.locator('.ws-view.active .tile.active').evaluate(el => getComputedStyle(el).borderLeftColor), 'rgb(168, 168, 168)');
  const light = await page.evaluate(() => ({ background: getComputedStyle(document.querySelector('.chat-composer')).backgroundColor, text: getComputedStyle(document.querySelector('.chat-composer textarea')).color, sidebar: getComputedStyle(document.querySelector('#sidebar')).backgroundColor }));
  assert.deepEqual(light, { background: 'rgb(255, 253, 248)', text: 'rgb(48, 42, 37)', sidebar: 'rgb(238, 233, 221)' });
  await page.locator('#settings-done').click();
  await page.evaluate(() => document.querySelector('#scheduled-tasks-btn').click());
  assert.equal(await page.locator('#scheduled-tasks-dialog').evaluate(el => getComputedStyle(el).color), 'rgb(48, 42, 37)');
  await page.locator('#scheduled-tasks-close').click();
  await app.close(); app = null;
  app = await _electron.launch({ args: [ROOT], cwd: ROOT, env }); page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'warm-clay');
  await page.evaluate(() => openSettings()); assert.equal(await page.locator('[data-theme-preset="warm-clay"]').getAttribute('aria-pressed'), 'true');
  await page.locator('#setting-chat-background').evaluate(el => { el.value = '#f2e9de'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('[data-theme-preset="warm-clay"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => appSettings.chatBackground), '#f2e9de');
  await page.locator('#setting-chat-background').evaluate(el => { el.value = '#202020'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('.ws-view.active .tile.active').evaluate(el => getComputedStyle(el).borderLeftColor), 'rgb(98, 98, 98)');
  await page.locator('[data-theme-preset="original-dark"]').click();
  await app.close(); app = null;
  app = await _electron.launch({ args: [ROOT], cwd: ROOT, env }); page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await page.evaluate(() => openSettings());
  assert.equal(await page.locator('[data-theme-preset="original-dark"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.ws-view.active .chat-body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(20, 20, 22)');
});

test('neutral pane border follows focus in light and dark themes', async t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-pane-border-'));
  const env = { ...process.env, SYNTHESIS_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
  t.after(async () => { await app.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  const page = await app.firstWindow(); await page.waitForSelector('.ws-view.active .chat-body');
  await page.locator('.ws-view.active .pane-btn[data-action="splitRight"]').click();
  for (const [theme, color] of [['original-dark', 'rgb(98, 98, 98)'], ['warm-clay', 'rgb(168, 168, 168)']]) {
    await page.evaluate(theme => updateAppSettings({ theme: theme === 'original-dark' ? '' : theme, ...BUILT_IN_THEMES[theme] }), theme);
    const panes = page.locator('.ws-view.active .tile');
    for (const index of [0, 1]) {
      await panes.nth(index).locator('textarea').click();
      const borders = await panes.evaluateAll(tiles => tiles.map(tile => ({ active: tile.classList.contains('active'), color: getComputedStyle(tile).borderLeftColor })));
      assert.equal(borders[index].active, true); assert.equal(borders[index].color, color);
      assert.notEqual(borders[1 - index].color, color);
    }
  }
});
