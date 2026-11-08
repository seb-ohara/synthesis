'use strict';
/* ============ Synthesis integration tests (Electron + Playwright) ============
 *
 * Covers the acceptance criteria that need a real app: UI relaunch with live
 * PTY reattachment, split layout with a browser surface, browser navigation
 * policy, and the file preview. Every run uses a disposable SYNTHESIS_USER_DATA
 * directory — the live app-support folder and data/app-support are never
 * touched.
 *
 * Run with: npm run test:integration
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');
const { _electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');

async function launch(userData) {
  return _electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SYNTHESIS_USER_DATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
}

/* Stop only the PTY daemon holding this test's socket — never any other
 * daemon (the user's live sessions must not be touched). */
function killTestDaemon(userData) {
  const sock = path.join(userData, 'pty.sock');
  let pids = [];
  try {
    pids = execSync(`lsof -t ${JSON.stringify(sock)}`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch { return; /* no daemon running */ }
  for (const pid of pids) {
    let comm = '';
    try { comm = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim(); } catch { continue; }
    if (comm.includes('synthesis-pty')) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

async function addTabFromMenu(page, type, paneSelector = '.ws-view.active .tile.active') {
  await page.locator(`${paneSelector} .pane-btn-more`).click();
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: type === 'terminal' ? 'New Terminal Tab' : 'New Browser Tab' }).click();
}

async function assertBrowserContained(page, app, label) {
  const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  const expected = await page.locator('.browser-viewport:visible').evaluate((viewport, zoom) => {
    const rect = viewport.getBoundingClientRect();
    const body = viewport.closest('.pane-body').getBoundingClientRect();
    const tile = viewport.closest('.tile').getBoundingClientRect();
    const toolbar = viewport.closest('.browser-body').querySelector('.browser-toolbar').getBoundingClientRect();
    const left = Math.max(rect.left, body.left, tile.left, 0);
    const top = Math.max(rect.top, body.top, toolbar.bottom, tile.top, 0);
    const right = Math.min(rect.right, body.right, tile.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, body.bottom, tile.bottom, window.innerHeight);
    return {
      bounds: {
        x: Math.ceil(left * zoom - 1e-7), y: Math.ceil(top * zoom - 1e-7),
        width: Math.max(0, Math.floor(right * zoom + 1e-7) - Math.ceil(left * zoom - 1e-7)),
        height: Math.max(0, Math.floor(bottom * zoom + 1e-7) - Math.ceil(top * zoom - 1e-7)),
      },
      tile: { left: Math.ceil(tile.left * zoom - 1e-7), right: Math.floor(tile.right * zoom + 1e-7), bottom: Math.floor(tile.bottom * zoom + 1e-7) },
      toolbarBottom: Math.ceil(toolbar.bottom * zoom - 1e-7),
    };
  }, zoom);
  const native = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => view.getVisible()).map((view) => view.getBounds()));
  assert.equal(native.length, 1, 'exactly one native browser view is visible');
  assert.deepEqual(native[0], expected.bounds, label);
  assert.ok(native[0].x >= expected.tile.left, `${label}: left edge stays inside pane`);
  assert.ok(native[0].y >= expected.toolbarBottom, `${label}: top edge stays below browser controls`);
  assert.ok(native[0].x + native[0].width <= expected.tile.right, `${label}: right edge stays inside pane`);
  assert.ok(native[0].y + native[0].height <= expected.tile.bottom, `${label}: bottom edge stays inside pane`);
}

test('app relaunch, restore status, split layout, browser navigation, file preview', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-e2e-state-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-e2e-files-'));
  fs.writeFileSync(
    path.join(projectDir, 'hello.js'),
    '// greeting\nconst x = 1;\nconsole.log(x);\n',
  );
  fs.mkdirSync(path.join(projectDir, 'src'));
  fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=local-only\n');
  const attachmentPath = path.join(projectDir, 'file to attach.txt');
  fs.writeFileSync(attachmentPath, 'drop target\n');
  fs.writeFileSync(path.join(projectDir, 'other.txt'), 'unmatched file\n');
  fs.writeFileSync(path.join(projectDir, 'src', 'nested.js'), 'export const nested = true;\n');

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Local Test</title></head><body>hello</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  let app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    server.close();
    killTestDaemon(userData);
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  let page = await app.firstWindow();
  await page.waitForSelector('.ws-card', { timeout: 20000 });

  /* --- set up a workspace rooted at the test project --- */
  await page.click('#add-btn');
  await page.fill('#modal-name', 'e2e');
  await page.fill('#modal-dir', projectDir);
  await page.click('#modal-create');
  await page.waitForFunction(
    (dir) => {
      const card = [...document.querySelectorAll('.ws-card')]
        .find((c) => c.textContent.includes('e2e'));
      return card && card.classList.contains('active');
    },
    projectDir,
    { timeout: 10000 },
  );
  const paneId = await page.getAttribute('.ws-view.active .tile.active', 'data-pane-id');
  assert.match(paneId, /^ws-\d+-p\d+$/, 'panes carry stable ids');
  // wait for the shell to actually spawn before quitting — the pane title
  // gains its working directory once the daemon has started the PTY
  await page.waitForFunction((id) => {
    const tile = document.querySelector(`.tile[data-pane-id="${id}"]`);
    const title = tile && tile.querySelector('.pane-tab.selected .pane-tab-select');
    return Boolean(title && title.textContent.includes('·'));
  }, paneId, { timeout: 15000 });
  const terminalColors = await page.$eval('.tile[data-pane-type="terminal"]', (tile) => ({
    tile: getComputedStyle(tile).backgroundColor,
    screen: getComputedStyle(tile.querySelector('.xterm-screen')).backgroundColor,
  }));
  assert.equal(terminalColors.tile, 'rgb(16, 16, 17)', 'terminal tile uses the sidebar grey');
  assert.equal(terminalColors.screen, 'rgb(16, 16, 17)', 'terminal canvas matches the sidebar grey');
  assert.equal(await page.$('#term-head'), null, 'the redundant workspace header row is removed');
  assert.equal(await page.$eval('#files-toggle-btn', (button) => button.parentElement.id), 'titlebar', 'Files toggle lives in the top bar');
  assert.ok(await page.$eval('.brand-logo', (icon) => icon.complete && icon.naturalWidth > 0), 'the app icon loads in the title bar');
  assert.equal(await page.locator('#fs-pick svg path').count(), 2, 'file picker uses a file icon');
  assert.equal(await page.getAttribute('#fs-pick', 'aria-label'), 'Open file or folder');

  /* --- dropping a Finder file inserts its safely quoted path into xterm --- */
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'drop-test-input';
    document.body.appendChild(input);
  });
  await page.setInputFiles('#drop-test-input', attachmentPath);
  const droppedPath = await page.$eval('#drop-test-input', (input) => window.mux.app.getDroppedFilePath(input.files[0]));
  assert.equal(droppedPath, attachmentPath, 'preload resolves the native dropped-file path');
  await page.$eval('#drop-test-input', (input) => {
    const transfer = new DataTransfer();
    transfer.items.add(input.files[0]);
    const tile = document.querySelector('.ws-view.active .tile[data-pane-type="terminal"] .pane-body:not(.tab-hidden)');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      tile.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  });
  await page.waitForFunction((name) => {
    const rows = document.querySelector('.ws-view.active .tile[data-pane-type="terminal"] .xterm-rows');
    return rows && rows.textContent.includes(name);
  }, path.basename(attachmentPath), { timeout: 20000 });
  await page.waitForTimeout(400); // let the debounced workspace snapshot reach disk

  /* --- relaunch: layout restored and the live PTY reattaches --- */
  await app.close();
  app = await launch(userData);
  page = await app.firstWindow();
  await page.waitForSelector('.ws-card', { timeout: 20000 });

  const snapshot = JSON.parse(fs.readFileSync(path.join(userData, 'workspaces.json'), 'utf8'));
  assert.equal(snapshot.schemaVersion, 2, 'snapshot uses the versioned schema');
  const restored = snapshot.workspaces.find((w) => w.name === 'e2e');
  assert.ok(restored, 'workspace survived the relaunch');
  assert.ok(restored.panes.some((p) => p.id === paneId), 'pane ids preserved for daemon reattachment');

  await page.waitForSelector(`.tile[data-pane-id="${paneId}"]`, { timeout: 10000 });
  await page.evaluate((id) => window.mux.pty.input(id, 'echo SILENT_RECONNECT_OK\r'), paneId);
  await page.waitForFunction((id) => {
    const tile = document.querySelector(`.tile[data-pane-id="${id}"]`);
    return tile?.querySelector('.xterm-rows')?.textContent.includes('SILENT_RECONNECT_OK')
      && !tile.querySelector('.pane-banner');
  }, paneId, { timeout: 20000 });
  assert.equal(await page.locator(`.tile[data-pane-id="${paneId}"] .pane-banner:has-text("Reconnected")`).count(), 0);


  /* --- split layout: terminal and browser surfaces share the tree --- */
  await page.click('.ws-view.active .tile.active .pane-btn[data-action=splitRight]');
  await page.waitForFunction(
    () => document.querySelectorAll('.ws-view.active .tile').length >= 2,
    null,
    { timeout: 10000 },
  );

  const splitBefore = await page.$eval('.ws-view.active .split-divider', (divider) => {
    const split = divider.parentElement;
    const panes = [...split.children].filter((el) => !el.classList.contains('split-divider'));
    const rect = divider.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, widths: panes.map((el) => el.getBoundingClientRect().width) };
  });
  await page.mouse.move(splitBefore.x, splitBefore.y);
  await page.mouse.down();
  await page.mouse.move(splitBefore.x + 80, splitBefore.y, { steps: 5 });
  await page.mouse.up();
  const splitAfter = await page.$eval('.ws-view.active .split-divider', (divider) => {
    const split = divider.parentElement;
    return [...split.children]
      .filter((el) => !el.classList.contains('split-divider'))
      .map((el) => el.getBoundingClientRect().width);
  });
  assert.ok(splitAfter[0] > splitBefore.widths[0] + 40, 'dragging a splitter expands the adjacent pane');
  assert.ok(splitAfter[1] < splitBefore.widths[1] - 40, 'dragging a splitter contracts its neighbor');

  await page.click('.ws-view.active .tile.active .pane-btn[data-action=splitDown]');
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length >= 3);
  const verticalBefore = await page.$eval('.ws-view.active .split-divider-col', (divider) => {
    const split = divider.parentElement;
    const panes = [...split.children].filter((el) => !el.classList.contains('split-divider'));
    const rect = divider.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, heights: panes.map((el) => el.getBoundingClientRect().height) };
  });
  await page.mouse.move(verticalBefore.x, verticalBefore.y);
  await page.mouse.down();
  await page.mouse.move(verticalBefore.x, verticalBefore.y + 50, { steps: 4 });
  await page.mouse.up();
  const verticalAfter = await page.$eval('.ws-view.active .split-divider-col', (divider) => {
    const split = divider.parentElement;
    return [...split.children]
      .filter((el) => !el.classList.contains('split-divider'))
      .map((el) => el.getBoundingClientRect().height);
  });
  assert.ok(verticalAfter[0] > verticalBefore.heights[0] + 20, `vertical split dividers resize pane height: ${JSON.stringify({ verticalBefore, verticalAfter })}`);
  assert.ok(verticalAfter[1] < verticalBefore.heights[1] - 20, 'vertical resizing contracts the paired pane');

  const tileCountBeforeBrowser = await page.locator('.ws-view.active .tile').count();
  const browserPaneId = await page.getAttribute('.ws-view.active .tile.active', 'data-pane-id');
  await page.click('.ws-view.active .tile.active .pane-btn[data-action=toggleSurface]');
  await page.waitForSelector('.browser-toolbar', { timeout: 10000 });
  assert.equal(await page.locator('.ws-view.active .tile').count(), tileCountBeforeBrowser, 'browser opens in the chosen pane without creating another pane');
  assert.equal(await page.getAttribute(`.tile[data-pane-id="${browserPaneId}"]`, 'data-pane-type'), 'browser');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.browser-url'));
  await page.waitForTimeout(150);
  await assertBrowserContained(page, app, 'browser view initially matches its clipped viewport');
  const tiles = await page.$$eval('.ws-view.active .tile', (els) => els.map((e) => e.dataset.paneType));
  assert.ok(tiles.includes('terminal') && tiles.includes('browser'), 'browser replaces only the selected pane surface');

  /* DOM rectangles use CSS pixels; native views use device-independent pixels.
   * Exercise both sides of 100%, including fractional pane edges. */
  for (const zoom of [1.1, 0.8, 1.25, 1]) {
    await app.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom);
    }, zoom);
    await page.waitForTimeout(200);
    await assertBrowserContained(page, app, `browser stays inside its pane at ${zoom * 100}% app zoom`);
  }

  /* --- browser search, navigation and scheme safety --- */
  await page.fill('.browser-url', 'Synthesis browser search test');
  await page.press('.browser-url', 'Enter');
  await page.waitForFunction(() => {
    const input = document.querySelector('.browser-url');
    return input && input.value.includes('google.com/search?q=Synthesis%20browser%20search%20test');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(150);
  await assertBrowserContained(page, app, 'browser remains inside its pane after search');
  await page.fill('.browser-url', url);
  await page.press('.browser-url', 'Enter');
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector('.browser-url');
      return input && input.value.replace(/\/$/, '') === expected;
    },
    url.replace(/\/$/, ''),
    { timeout: 15000 },
  );
  const browserDivider = await page.$eval('.ws-view.active .split-divider-col', (divider) => {
    const rect = divider.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(browserDivider.x, browserDivider.y);
  await page.mouse.down();
  await page.mouse.move(browserDivider.x, browserDivider.y + 24, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await assertBrowserContained(page, app, 'browser remains clipped after resizing its pane');
  await page.fill('.browser-url', 'javascript:alert(1)');
  await page.press('.browser-url', 'Enter');
  await page.waitForSelector('.browser-error:not(.hidden)', { timeout: 10000 });
  const errorText = await page.textContent('.browser-error');
  assert.match(errorText, /Blocked|scheme/i, 'javascript: URLs are refused with a visible error');

  /* --- file preview: line numbers, highlighting, limits message --- */
  await page.waitForSelector('.file-row', { timeout: 10000 });
  await page.click('#files-tools-toggle');
  await page.fill('#files-filter', 'hello');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.file-row .f-name')].some((n) => n.textContent === 'hello.js'),
    null,
    { timeout: 10000 },
  );
  const visibleRows = await page.$$eval('.file-row', (els) => els.map((e) => e.textContent));
  assert.equal(visibleRows.filter((x) => x.includes('hello.js')).length, 1, 'filter narrows the file listing');
  assert.ok(visibleRows.some((x) => x.includes('src')), 'tree keeps folders visible as scoped containers');
  assert.ok(!visibleRows.some((x) => x.includes('other.txt')), 'non-matching files are hidden');

  await page.click('.file-row:has-text("hello.js")');
  await page.waitForSelector('#preview-code .code-line', { timeout: 10000 });
  const lineNumbers = await page.$$eval('#preview-code .ln', (els) => els.map((e) => e.textContent));
  assert.deepEqual(lineNumbers.slice(0, 3), ['1', '2', '3'], 'preview shows line numbers');
  assert.ok(await page.$('#preview-code .tok-comment'), 'comments are highlighted');
  assert.ok(await page.$('#preview-code .tok-keyword'), 'keywords are highlighted');

  /* --- keyboard navigation in the files panel --- */
  await page.click('#preview-head .icon-btn'); // back to the listing
  await page.waitForSelector('.file-row', { timeout: 10000 });
  await page.focus('.file-row');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // opens the focused entry without errors
  await page.waitForSelector('#preview-head', { timeout: 10000 });
  assert.ok(await page.$('#files-body'), 'files panel survives keyboard navigation');
  await page.click('#preview-head .icon-btn');

  /* --- workspace-root tree is the default, lazy, filterable and refreshable --- */
  await page.fill('#files-filter', '');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.file-row .f-name')].some((n) => n.textContent === 'src'),
    null,
    { timeout: 10000 },
  );
  assert.equal(
    await page.locator('.file-row .f-name').allTextContents().then((names) => names.includes('.env')),
    false,
    'hidden files are omitted by default',
  );
  await page.click('#files-hidden');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.file-row .f-name')].some((n) => n.textContent === '.env'),
    null,
    { timeout: 10000 },
  );
  assert.equal(
    await page.$eval('.tree-row.is-dir > .f-icon', (icon) => getComputedStyle(icon).display),
    'block',
    'tree shows outlined folder icons alongside disclosure chevrons',
  );
  assert.equal(
    await page.$eval('.tree-row.is-dir .tree-chev svg', (chev) => getComputedStyle(chev).width),
    '10px',
    'tree uses restrained line-drawn disclosure chevrons',
  );
  const rootBreadcrumbs = await page.textContent('#files-crumb');
  await page.click('.file-row:has-text("src")');
  assert.equal(await page.textContent('#files-crumb'), rootBreadcrumbs, 'expanding a folder keeps the explorer scoped at the workspace root');
  assert.equal(await page.locator('.file-row.selected').count(), 0, 'clicking does not leave a grey/orange selected-item highlight');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.file-row .f-name')].some((n) => n.textContent === 'nested.js'),
    null,
    { timeout: 10000 },
  );
  fs.writeFileSync(path.join(projectDir, 'src', 'added.js'), 'export const added = true;\n');
  await page.click('#files-refresh');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.file-row .f-name')].some((n) => n.textContent === 'added.js'),
    null,
    { timeout: 10000 },
  );

  /* --- minimum-size layout keeps surfaces and controls usable --- */
  await page.evaluate(() => {
    window.__testGeometryEvents = 0;
    window.mux.app.onWindowGeometryChange(() => { window.__testGeometryEvents += 1; });
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(980, 600);
  });
  await page.waitForTimeout(400);
  const geometryEventCount = await page.evaluate(() => window.__testGeometryEvents);
  assert.ok(geometryEventCount > 0, 'main process reports native window geometry changes');
  await page.fill('.browser-url', url);
  await page.press('.browser-url', 'Enter');
  await page.waitForFunction(
    (expected) => {
      const input = document.querySelector('.browser-url');
      return input && input.value.replace(/\/$/, '') === expected;
    },
    url.replace(/\/$/, ''),
    { timeout: 15000 },
  );
  await page.waitForTimeout(100);
  await assertBrowserContained(page, app, 'browser view uses current bounds when shown after resize');
  for (const selector of ['.browser-toolbar', '#files-toolbar', '#titlebar', '#files-toggle-btn', '#statusbar']) {
    const visible = await page.isVisible(selector);
    assert.equal(visible, true, `${selector} remains visible at minimum window size`);
  }

  /* --- snapshot still valid after all structural changes --- */
  const finalSnapshot = JSON.parse(fs.readFileSync(path.join(userData, 'workspaces.json'), 'utf8'));
  assert.equal(finalSnapshot.schemaVersion, 2);
  const finalWs = finalSnapshot.workspaces.find((w) => w.name === 'e2e');
  const types = finalWs.panes.map((p) => p.type);
  assert.ok(types.includes('browser'), 'browser pane type persisted');
  assert.ok(types.includes('terminal'), 'terminal pane type persisted');
  assert.equal(finalWs.panes.find((p) => p.id === browserPaneId).hasTerminal, true, 'in-place browser switch keeps its terminal session recoverable');
  assert.ok(Array.isArray(finalWs.layout.weights), 'pane resize proportions are persisted');

  /* --- machine-restart simulation: daemon stopped, snapshot and log retained --- */
  assert.ok(
    fs.existsSync(path.join(userData, 'sessions', `${paneId}.log`)),
    'terminal log is retained for saved output',
  );
  await app.close();
  killTestDaemon(userData);

  app = await launch(userData);
  page = await app.firstWindow();
  await page.waitForSelector(`.tile[data-pane-id="${paneId}"]`, { timeout: 20000 });
  await page.waitForFunction((id) => {
    const tile = document.querySelector(`.tile[data-pane-id="${id}"]`);
    const banner = tile && tile.querySelector('.pane-banner');
    return Boolean(banner && /Ended|Unavailable/.test(banner.textContent));
  }, paneId, { timeout: 20000 });
  const deadBanner = await page.textContent(`.tile[data-pane-id="${paneId}"] .pane-banner`);
  assert.match(deadBanner, /Ended/, 'a dead PTY is labelled Ended, not live');
  assert.ok(await page.$(`.tile[data-pane-id="${paneId}"] .banner-actions`), 'recovery actions are offered');

  // a fresh shell is an explicit user action and reaches the live state
  await page.click(`.tile[data-pane-id="${paneId}"] .banner-btn:has-text("Start New Shell")`);
  await page.waitForFunction((id) => {
    const tile = document.querySelector(`.tile[data-pane-id="${id}"]`);
    return tile && !tile.querySelector('.pane-banner');
  }, paneId, { timeout: 20000 });

  await page.click(`.tile[data-pane-id="${browserPaneId}"] .pane-tab[data-tab-type=terminal] .pane-tab-select`);
  await page.waitForFunction((id) => {
    const tile = document.querySelector(`.tile[data-pane-id="${id}"]`);
    return tile && tile.dataset.paneType === 'terminal' && /Ended/.test(tile.querySelector('.pane-banner')?.textContent || '');
  }, browserPaneId, { timeout: 20000 });
});

test('native browser containment follows app zoom and window layout', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-browser-bounds-'));
  const app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.ws-view.active .tile.active');
  await page.click('.ws-view.active .tile.active .pane-btn[data-action=splitRight]');
  await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 2);
  await page.click('.ws-view.active .tile.active .pane-btn[data-action=toggleSurface]');
  await page.waitForSelector('.browser-viewport');
  await page.waitForTimeout(200);
  await assertBrowserContained(page, app, 'initial browser containment');

  for (const zoom of [1.1, 0.8, 1.25, 1]) {
    await app.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom);
    }, zoom);
    await page.waitForTimeout(200);
    await assertBrowserContained(page, app, `native view matches pane at ${Math.round(zoom * 100)}% app zoom`);
    await page.locator('.ws-view.active .split-divider-row').press('ArrowLeft');
    await page.waitForTimeout(100);
    await assertBrowserContained(page, app, 'containment after resizing a split at app zoom');
    await page.click('#files-toggle-btn');
    await page.waitForTimeout(100);
    await assertBrowserContained(page, app, 'containment after toggling the file panel');
  }
  // Collapsing either sidebar must never displace or hide either pane.
  const before = await page.locator('.ws-view.active .tile').count();
  await page.click('#ws-collapse');
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.ws-view.active .tile').count(), before);
  assert.ok(await page.$eval('#center', (el) => el.getBoundingClientRect().width > 200), 'pane area stays visible with collapsed workspaces');
  assert.ok(await page.locator('.ws-view.active .tile[data-pane-type=terminal] .xterm').first().isVisible(), 'terminal stays visible with the sidebar collapsed');
  await assertBrowserContained(page, app, 'browser remains visible with workspace sidebar collapsed');
  await page.click('#files-toggle-btn');
  await page.waitForTimeout(180);
  assert.ok(await page.$eval('#center', (el) => el.getBoundingClientRect().width > 200), 'pane area stays visible with both sidebar settings changed');
  await assertBrowserContained(page, app, 'browser remains visible when both sidebars change');
  await page.click('#ws-expand');
  await page.waitForTimeout(180);
  await assertBrowserContained(page, app, 'browser remains visible when workspace sidebar reopens');

  const id = await page.getAttribute('.tile[data-pane-type="browser"]', 'data-pane-id');
  await page.evaluate((id) => window.mux.browser.zoom(id, 1.5), id);
  await assertBrowserContained(page, app, 'browser page zoom does not move its native frame');

  await page.click('#settings-btn');
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()), false, 'browser hides behind settings');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(1.1);
    win.setSize(980, 600);
  });
  await page.waitForTimeout(200);
  await page.click('#settings-close');
  await page.waitForTimeout(200);
  await assertBrowserContained(page, app, 'browser restores current bounds after hidden resize and zoom');
  assert.equal(await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible()), true, 'browser returns after settings closes');
});

test('mixed pane tabs keep independent pages and terminals through switching and relaunch', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-mixed-tabs-'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Page ${req.url}</title><input id="draft"><h1>${req.url}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.pane-tabs');
  page.on('dialog', (dialog) => dialog.accept());
  const originalId = await page.getAttribute('.pane-tab', 'data-tab-id');
  await addTabFromMenu(page, 'terminal');
  const secondId = await page.getAttribute('.pane-tab.selected', 'data-tab-id');
  assert.notEqual(originalId, secondId, 'each terminal has a separate identity');
  await page.waitForFunction(async (ids) => {
    const result = await window.mux.pty.list();
    return result.ok && ids.every((id) => result.sessions.some((s) => s.id === id && s.alive));
  }, [originalId, secondId]);
  await page.evaluate((id) => window.mux.pty.input(id, "export SYNTHESIS_TAB_MARKER=first\r"), originalId);
  await page.evaluate((id) => window.mux.pty.input(id, "export SYNTHESIS_TAB_MARKER=second\r"), secondId);

  await addTabFromMenu(page, 'browser');
  const browserA = await page.getAttribute('.pane-tab.selected', 'data-tab-id');
  await page.locator('.browser-url:visible').fill(base + '/one');
  await page.locator('.browser-url:visible').press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane-tab-select')].some((el) => el.textContent.includes('Page /one')));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript('document.querySelector("#draft").value = "keep this draft"'));
  await addTabFromMenu(page, 'browser');
  const browserB = await page.getAttribute('.pane-tab.selected', 'data-tab-id');
  await page.locator('.browser-url:visible').fill(base + '/two');
  await page.locator('.browser-url:visible').press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane-tab-select')].some((el) => el.textContent.includes('Page /two')));
  assert.equal(await page.locator('.tile').count(), 1, 'new tabs do not add panes');
  assert.equal(await page.locator('.pane-tab').count(), 4);
  await page.locator('.tile.active .pane-btn[data-action=toggleSurface]').click();
  assert.equal(await page.getAttribute('.pane-tab.selected', 'data-tab-id'), browserB, 'Open Browser keeps the current browser selected');
  await page.click(`.pane-tab[data-tab-id="${browserA}"] .pane-tab-select`);
  await page.waitForTimeout(100);
  const draft = await app.evaluate(({ BrowserWindow }) => {
    const children = BrowserWindow.getAllWindows()[0].contentView.children;
    const shown = children.filter((v) => v.getVisible());
    return Promise.all([Promise.resolve(shown.length), shown[0].webContents.executeJavaScript('document.querySelector("#draft").value')]);
  });
  assert.deepEqual(draft, [1, 'keep this draft'], 'inactive pages stay loaded and only the selected browser is visible');
  // Browser pages are separate native views: their right-click must still
  // open the pane menu at the click location, including at host zoom.
  await page.evaluate((id) => window.mux.browser.zoom(id, 1.5), browserA);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.1));
  await page.waitForTimeout(150);
  const expectedMenu = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find((item) => item.getVisible());
    const bounds = view.getBounds();
    view.webContents.focus();
    view.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'right', clickCount: 1 });
    view.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'right', clickCount: 1 });
    return { x: (bounds.x + 40) / 1.1, y: (bounds.y + 40) / 1.1 };
  });
  await page.waitForSelector('#ctx-menu.visible');
  assert.ok(await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'New Browser Tab' }).isVisible());
  assert.ok(await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Zoom In' }).isVisible());
  const menuRect = await page.$eval('#ctx-menu', (menu) => ({ x: menu.getBoundingClientRect().x, y: menu.getBoundingClientRect().y }));
  assert.ok(Math.abs(menuRect.x - expectedMenu.x) < 3 && Math.abs(menuRect.y - expectedMenu.y) < 3, 'browser pane menu appears at the right-click location');
  await page.keyboard.press('Escape');
  await page.evaluate((id) => window.mux.browser.zoom(id, 1), browserA);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await page.waitForTimeout(150);

  await app.evaluate(({ BrowserWindow }, url) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => v.getVisible());
    return view.webContents.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank'); void 0`);
  }, base + '/three');
  await page.waitForFunction(() => document.querySelectorAll('.pane-tab').length === 5);
  await page.waitForFunction(() => document.querySelector('.pane-tab.selected').textContent.includes('Page /three'));
  await page.click('.pane-tab.selected .pane-tab-close');
  await page.waitForFunction(() => document.querySelectorAll('.pane-tab').length === 4);
  await page.click(`.pane-tab[data-tab-id="${browserA}"] .pane-tab-select`);
  assert.equal(await page.locator('.browser-url:visible').inputValue(), base + '/one', 'new-window links leave the opener unchanged');

  // Tab shortcuts must also work while the native page, rather than app chrome,
  // owns focus. Closing a tab must keep the Synthesis window open.
  for (const [key, count] of [['t', 5], ['w', 4]]) {
    if (key === 'w') {
      await page.locator('.browser-url:visible').fill(base + '/keyboard');
      await page.locator('.browser-url:visible').press('Enter');
      await page.waitForFunction(() => document.querySelector('.pane-tab.selected').textContent.includes('Page /keyboard'));
    }
    await page.waitForTimeout(100);
    await app.evaluate(({ BrowserWindow }, key) => {
      const win = BrowserWindow.getAllWindows()[0];
      const contents = win.contentView.children.find((v) => v.getVisible()).webContents;
      win.focus();
      contents.focus();
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: ['meta'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: ['meta'] });
    }, key);
    await page.waitForFunction((count) => document.querySelectorAll('.pane-tab').length === count, count, { timeout: 5000 });
  }

  await page.click(`.pane-tab[data-tab-id="${browserA}"] .pane-tab-select`);
  await page.waitForTimeout(100);
  await assertBrowserContained(page, app, 'selected browser stays contained with several browser tabs');
  await page.click(`.pane-tab[data-tab-id="${secondId}"] .pane-tab-select`);
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.getVisible()).length), 0, 'terminal tabs hide all native browsers');
  await page.evaluate((id) => window.mux.pty.input(id, 'echo TAB_VALUE:$SYNTHESIS_TAB_MARKER\r'), secondId);
  await page.waitForFunction(() => document.querySelector('.pane-body:not(.tab-hidden) .xterm-screen').textContent.includes('TAB_VALUE:second'));
  await page.click(`.pane-tab[data-tab-id="${originalId}"] .pane-tab-select`);
  await page.evaluate((id) => window.mux.pty.input(id, 'echo TAB_VALUE:$SYNTHESIS_TAB_MARKER\r'), originalId);
  await page.waitForFunction(() => document.querySelector('.pane-body:not(.tab-hidden) .xterm-screen').textContent.includes('TAB_VALUE:first'));

  if (process.env.SYNTHESIS_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SYNTHESIS_TEST_SCREENSHOT });
  // Save and relaunch with a browser selected; both PTYs must reattach unchanged.
  await page.click(`.pane-tab[data-tab-id="${browserB}"] .pane-tab-select`);
  await page.waitForTimeout(400);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'workspaces.json'), 'utf8'));
  assert.equal(saved.workspaces[0].panes[0].tabs.length, 4);
  assert.equal(saved.workspaces[0].panes[0].activeTabId, browserB);
  await app.close();
  app = await launch(userData);
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.waitForSelector('.pane-tab.selected');
  assert.equal(await page.getAttribute('.pane-tab.selected', 'data-tab-id'), browserB);
  assert.equal(await page.locator('.pane-tab').count(), 4);
  await page.click(`.pane-tab[data-tab-id="${secondId}"] .pane-tab-select`);
  await page.waitForFunction(() => !document.querySelector('.tile.active .pane-banner'));
  assert.equal(await page.locator('.pane-banner:has-text("Reconnected")').count(), 0);
  await page.evaluate((id) => window.mux.pty.input(id, 'echo RESTORED:$SYNTHESIS_TAB_MARKER\r'), secondId);
  await page.waitForFunction(() => document.querySelector('.pane-body:not(.tab-hidden) .xterm-screen').textContent.includes('RESTORED:second'));

  // Closing a background browser releases its native view; closing a terminal
  // stops only that PTY, leaving the other session alive.
  await page.click(`.pane-tab[data-tab-id="${browserA}"] .pane-tab-close`);
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length), 1);
  await page.click(`.pane-tab[data-tab-id="${originalId}"] .pane-tab-close`);
  await page.waitForFunction(async (ids) => {
    const result = await window.mux.pty.list();
    return !result.sessions.some((s) => s.id === ids[0] && s.alive) && result.sessions.some((s) => s.id === ids[1] && s.alive);
  }, [originalId, secondId]);
  await page.click(`.pane-tab[data-tab-id="${browserB}"] .pane-tab-close`);
  await page.click(`.pane-tab[data-tab-id="${secondId}"] .pane-tab-close`);
  await page.waitForFunction(() => document.querySelectorAll('.pane-tab').length === 1 && document.querySelector('.pane-tab').dataset.tabType === 'terminal');
  assert.notEqual(await page.getAttribute('.pane-tab', 'data-tab-id'), secondId, 'closing the last tab leaves a fresh usable terminal');
  await page.keyboard.press('Meta+t');
  await page.waitForFunction(() => document.querySelectorAll('.pane-tab').length === 2);
  assert.equal(await page.getAttribute('.pane-tab.selected', 'data-tab-type'), 'terminal', 'new-tab shortcut uses the current surface type');
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.tile').count(), 1);
  assert.deepEqual(errors, [], 'no renderer errors during tab lifecycle');
});

test('existing browser panes recover their original terminal as a separate tab', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-legacy-tabs-'));
  let app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    fs.rmSync(userData, { recursive: true, force: true });
  });
  let page = await app.firstWindow();
  await page.waitForSelector('.pane-tab');
  const id = await page.getAttribute('.pane-tab', 'data-tab-id');
  await page.waitForFunction(async (id) => {
    const result = await window.mux.pty.list();
    return result.sessions.some((session) => session.id === id && session.alive);
  }, id);
  await page.evaluate((id) => window.mux.pty.input(id, 'export LEGACY_TERMINAL=preserved\r'), id);
  await app.close();
  const file = path.join(userData, 'workspaces.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pane = saved.workspaces[0].panes[0];
  delete pane.tabs;
  delete pane.activeTabId;
  Object.assign(pane, { type: 'browser', hasTerminal: true, url: '', zoom: 1 });
  fs.writeFileSync(file, JSON.stringify(saved));
  app = await launch(userData);
  page = await app.firstWindow();
  await page.waitForSelector('.pane-tab[data-tab-type="browser"].selected');
  assert.equal(await page.locator('.pane-tab').count(), 2);
  await page.click(`.pane-tab[data-tab-id="${id}"] .pane-tab-select`);
  await page.waitForFunction(() => !document.querySelector('.tile.active .pane-banner'));
  assert.equal(await page.locator('.pane-banner:has-text("Reconnected")').count(), 0);
  await page.evaluate((id) => window.mux.pty.input(id, 'echo LEGACY:$LEGACY_TERMINAL\r'), id);
  await page.waitForFunction(() => document.querySelector('.pane-body:not(.tab-hidden) .xterm-screen').textContent.includes('LEGACY:preserved'));
});

test('compact controls and movable tabs preserve sessions, pages and saved layout', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-move-tabs-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Movable page</title><input id="draft">');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.pane-tabs');
  const firstPane = await page.getAttribute('.tile', 'data-pane-id');
  const firstTab = await page.getAttribute('.pane-tab', 'data-tab-id');
  await addTabFromMenu(page, 'terminal');
  const secondTab = await page.getAttribute('.pane-tab.selected', 'data-tab-id');
  assert.equal(await page.locator('.pane-head, .pane-title').count(), 0, 'duplicated title header is removed');
  const row = await page.$eval('.pane-tabs', (strip) => {
    const rect = strip.getBoundingClientRect();
    return { height: rect.height, top: rect.top, actions: strip.querySelector('.pane-actions').getBoundingClientRect().top };
  });
  assert.ok(row.height <= 32, 'pane chrome uses a single compact row');
  assert.ok(row.actions >= row.top && row.actions < row.top + row.height, 'pane actions are in the tab row');
  assert.deepEqual(await page.$$eval('.pane-actions > button', (buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ['Split right', 'Split down', 'Open browser in this pane', 'Pane options', 'Close pane']);
  assert.equal(await page.locator('.pane-new-tab').count(), 0, 'new-tab controls are in the menu');
  await page.locator('.pane-body:not(.tab-hidden)').click({ button: 'right' });
  assert.ok(await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'New Terminal Tab' }).isVisible());
  assert.ok(await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Clear Terminal' }).isVisible());
  await page.keyboard.press('Escape');

  await page.locator(`.pane-tab[data-tab-id="${secondTab}"]`).dragTo(page.locator(`.pane-tab[data-tab-id="${firstTab}"]`), { targetPosition: { x: 2, y: 12 } });
  assert.deepEqual(await page.$$eval('.pane-tab', (tabs) => tabs.map((tab) => tab.dataset.tabId)), [secondTab, firstTab], 'dragging changes tab order');
  // Let focus settle after the drag before using keyboard reordering.
  await page.waitForTimeout(100);
  await page.locator(`.pane-tab[data-tab-id="${secondTab}"] .pane-tab-select`).press('Alt+Shift+ArrowRight');
  assert.deepEqual(await page.$$eval('.pane-tab', (tabs) => tabs.map((tab) => tab.dataset.tabId)), [firstTab, secondTab]);

  await page.click('.pane-btn[data-action="splitRight"]');
  const secondPane = await page.getAttribute('.tile.active', 'data-pane-id');
  const targetTab = await page.getAttribute('.tile.active .pane-tab', 'data-tab-id');
  await page.waitForFunction(async (id) => (await window.mux.pty.list()).sessions.some((s) => s.id === id && s.alive), firstTab);
  await page.evaluate((id) => window.mux.pty.input(id, 'export MOVED_TERMINAL=still-running\r'), firstTab);
  await page.locator(`.pane-tab[data-tab-id="${firstTab}"]`).dragTo(page.locator(`.tile[data-pane-id="${secondPane}"] .pane-tab`));
  await page.waitForFunction(({ pane, tab }) => document.querySelector(`.tile[data-pane-id="${pane}"] .pane-tab[data-tab-id="${tab}"]`), { pane: secondPane, tab: firstTab });
  assert.equal(await page.locator('.tile').count(), 2, 'source pane stays while it has another tab');
  await page.evaluate((id) => window.mux.pty.input(id, 'echo MOVED:$MOVED_TERMINAL\r'), firstTab);
  await page.waitForFunction(() => document.querySelector('.tile.active .pane-body:not(.tab-hidden) .xterm-screen').textContent.includes('MOVED:still-running'));

  await addTabFromMenu(page, 'browser', `.tile[data-pane-id="${firstPane}"]`);
  const browserTab = await page.getAttribute('.pane-tab.selected[data-tab-type="browser"]', 'data-tab-id');
  await page.locator('.browser-url:visible').fill(url);
  await page.locator('.browser-url:visible').press('Enter');
  await page.waitForFunction(() => document.querySelector('.pane-tab.selected[data-tab-type="browser"]').textContent.includes('Movable page'));
  const chrome = await page.$eval('.tile.active', (tile) => {
    const tabs = tile.querySelector('.pane-tabs').getBoundingClientRect();
    const toolbar = tile.querySelector('.browser-toolbar').getBoundingClientRect();
    return { tabsBottom: tabs.bottom, toolbarTop: toolbar.top, toolbarHeight: toolbar.height, toolbarWidth: toolbar.width, tileWidth: tile.getBoundingClientRect().width };
  });
  assert.ok(chrome.toolbarTop >= chrome.tabsBottom, 'browser navigation is below the tab row');
  assert.ok(chrome.toolbarHeight <= 32, 'browser navigation stays thin');
  assert.ok(Math.abs(chrome.toolbarWidth - chrome.tileWidth) < 3, 'navigation spans the pane');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript('document.querySelector("#draft").value = "persistent draft"'));
  await page.locator(`.pane-tab[data-tab-id="${browserTab}"]`).dragTo(page.locator(`.tile[data-pane-id="${secondPane}"] .pane-tab[data-tab-id="${targetTab}"]`));
  await page.waitForTimeout(150);
  await assertBrowserContained(page, app, 'moved browser stays in the destination pane');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].webContents.executeJavaScript('document.querySelector("#draft").value')), 'persistent draft', 'moving a browser keeps the loaded document');
  await page.locator(`.pane-tab[data-tab-id="${browserTab}"]`).dragTo(page.locator('#files-toggle-btn'));
  await page.waitForTimeout(100);
  await assertBrowserContained(page, app, 'cancelled drag restores the native browser');
  assert.equal(await page.locator('.tab-dragging').count(), 0);
  if (process.env.SYNTHESIS_COMPACT_SCREENSHOT) await page.screenshot({ path: process.env.SYNTHESIS_COMPACT_SCREENSHOT });

  // Move the last source tab via its menu: the empty pane should collapse.
  await page.locator(`.pane-tab[data-tab-id="${secondTab}"]`).click({ button: 'right' });
  await page.getByRole('button', { name: 'Move to pane 2', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
  await page.waitForTimeout(400);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'workspaces.json'), 'utf8'));
  assert.equal(saved.workspaces[0].panes.length, 1);
  const order = saved.workspaces[0].panes[0].tabs.map((tab) => tab.id);
  assert.ok(order.includes(firstTab), 'a session whose ID matches the removed pane remains valid');
  await app.close();
  app = await launch(userData);
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.pane-tab');
  assert.deepEqual(await page.$$eval('.pane-tab', (tabs) => tabs.map((tab) => tab.dataset.tabId)), order, 'moved tab order restores after relaunch');
  await page.locator(`.pane-tab[data-tab-id="${firstTab}"] .pane-tab-select`).click();
  await page.evaluate((id) => window.mux.pty.input(id, 'echo RESTORED_MOVE:$MOVED_TERMINAL\r'), firstTab);
  await page.waitForFunction(() => document.querySelector('.pane-body:not(.tab-hidden) .xterm-screen').textContent.includes('RESTORED_MOVE:still-running'));
  assert.deepEqual(errors, [], 'no errors during moving, collapsing and restoring panes');
});

test('new panes avoid terminal identities retained by moved tabs after relaunch', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-tab-identities-'));
  const paneId = 'ws-1-p1';
  const movedTabId = 'ws-1-p2';
  fs.writeFileSync(path.join(userData, 'workspaces.json'), JSON.stringify({
    schemaVersion: 2, activeWorkspaceId: 'ws-1', workspaces: [{
      id: 'ws-1', name: 'Moved tabs', cwd: userData, fileDir: userData,
      activePaneId: paneId, layout: { paneId }, panes: [{
        id: paneId, type: 'terminal', activeTabId: movedTabId,
        tabs: [{ id: movedTabId, type: 'terminal' }],
      }],
    }],
  }));
  const app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.pane-tabs');
  await page.click('.pane-btn[data-action="splitRight"]');
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
  assert.equal(await page.getAttribute('.tile.active', 'data-pane-id'), 'ws-1-p3');
  assert.deepEqual(await page.$$eval('.pane-tab', (tabs) => tabs.map((tab) => tab.dataset.tabId)), [movedTabId, 'ws-1-p3']);
  let confirmation = '';
  page.once('dialog', async (dialog) => { confirmation = dialog.message(); await dialog.dismiss(); });
  await page.locator('.tile.active .pane-close').click();
  assert.match(confirmation, /Close pane/);
  assert.equal(await page.locator('.tile').count(), 2, 'cancelling close leaves both panes open');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.tile.active .pane-close').click();
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
  assert.equal(await page.locator('.ws-card[data-id="ws-1"]').count(), 1, 'pane close preserves the workspace');
  assert.equal(await page.getAttribute('.tile', 'data-pane-id'), paneId, 'pane close preserves the other pane');
  assert.equal(await page.locator('.tile .pane-close').isDisabled(), true, 'the final pane cannot close the workspace');

});

test('failed browser loads retain a visible error and can recover', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-browser-errors-'));
  const server = http.createServer((_req, res) => res.end('<title>Recovered</title>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.tile.active');
  await page.click('.tile.active .pane-btn[data-action=toggleSurface]');
  await page.waitForSelector('.browser-url:visible');
  await new Promise((resolve) => server.close(resolve));
  await page.locator('.browser-url:visible').fill(`http://127.0.0.1:${port}/`);
  await page.locator('.browser-url:visible').press('Enter');
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('.browser-error:not(.hidden)').count(), 1, 'failed page displays an error after loading stops');
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  await page.locator('.browser-error:not(.hidden) .ghost-btn').click();
  await page.waitForFunction(() => document.querySelector('.pane-tab.selected')?.textContent.includes('Recovered'));
  assert.equal(await page.locator('.browser-error:not(.hidden)').count(), 0, 'retry hides the error after recovery');
});

test('closing a pane and reopening the application window preserve other live sessions', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-close-window-'));
  const app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    fs.rmSync(userData, { recursive: true, force: true });
  });
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.waitForSelector('.tile.active');
  const survivor = await page.getAttribute('.tile.active .pane-tab', 'data-tab-id');
  await page.waitForFunction(async (id) => (await window.mux.pty.list()).sessions.some((s) => s.id === id && s.alive), survivor);
  await page.evaluate((id) => window.mux.pty.input(id, 'export SURVIVE_WINDOW=still-running\r'), survivor);
  await page.click('.tile.active .pane-btn[data-action=splitRight]');
  const closed = await page.getAttribute('.tile.active .pane-tab', 'data-tab-id');
  await page.waitForFunction(async (id) => (await window.mux.pty.list()).sessions.some((s) => s.id === id && s.alive), closed);
  await page.click('.tile.active .pane-btn-more');
  await page.locator('#ctx-menu .ctx-item').filter({ hasText: 'Close Pane' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
  await page.waitForFunction(async ({ closed, survivor }) => {
    const list = (await window.mux.pty.list()).sessions;
    return !list.some((s) => s.id === closed && s.alive) && list.some((s) => s.id === survivor && s.alive);
  }, { closed, survivor });
  await page.click('.tile.active .pane-btn[data-action=toggleSurface]');
  await page.waitForSelector('.browser-toolbar:visible');
  await page.waitForTimeout(400);
  const closedWindow = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closedWindow;
  await app.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().length !== 0) throw new Error('Window did not close');
  });
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(({ app }) => app.emit('activate'));
  await nextWindow;
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.tile.active');
  assert.equal(await page.locator('.tile').count(), 1, 'closed pane does not return after reopening');
  assert.equal(await page.locator('.pane-tab[data-tab-type=browser]').count(), 1, 'browser tab restores after reopening');
  await page.click(`.pane-tab[data-tab-id="${survivor}"] .pane-tab-select`);
  await page.evaluate((id) => window.mux.pty.input(id, 'echo WINDOW_RESTORED:$SURVIVE_WINDOW\r'), survivor);
  await page.waitForFunction(() => document.querySelector('.pane-body:not(.tab-hidden) .xterm-screen')?.textContent.includes('WINDOW_RESTORED:still-running'));
  assert.deepEqual(errors, [], 'pane close and window reopening do not produce renderer errors');
});

test('pane-only close controls, smooth collapse, focus borders and logo accent', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-pane-polish-'));
  const server = http.createServer((_req, res) => res.end('<title>Focus Test</title><input autofocus>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let app = await launch(userData);
  t.after(async () => {
    await app.close().catch(() => {});
    killTestDaemon(userData);
    fs.rmSync(userData, { recursive: true, force: true });
  });
  let page = await app.firstWindow();
  await page.waitForSelector('.tile.active');
  assert.equal(await page.locator('.ws-close, [aria-label="Close workspace"]').count(), 0);
  assert.equal(await page.evaluate(() => workspaceCardMenu(activeWs()).some((item) => item.label === 'Close Workspace')), false);
  assert.equal(await page.locator('.pane-close').getAttribute('aria-label'), 'Close pane');
  assert.equal(await page.locator('.pane-close').isDisabled(), true);
  assert.equal(await page.$eval('#sidebar .side-head', (el) => getComputedStyle(el).textTransform), 'none');
  assert.equal(await page.locator('#files-toolbar').isVisible(), false, 'file bar starts with a clean header');
  assert.ok(await page.locator('#files-root').textContent(), 'current folder appears in the header');
  await page.click('#files-tools-toggle');
  assert.equal(await page.locator('#files-filter').isVisible(), true, 'file tools remain available');

  await page.click('#settings-btn');
  await page.click('[data-accent="synthesis"]');
  await page.click('#settings-done');
  const gradient = await page.evaluate(() => ({
    setting: JSON.parse(localStorage.getItem('synthesis.settings')).accentColor,
    fill: getComputedStyle(document.documentElement).getPropertyValue('--accent-fill'),
    border: getComputedStyle(document.querySelector('.tile.active')).borderImageSource,
    borderWidth: getComputedStyle(document.querySelector('.tile.active')).borderLeftWidth,
  }));
  assert.equal(gradient.setting, 'synthesis');
  assert.equal(gradient.fill.trim(), 'linear-gradient(110deg, #d9cbff 0%, #b8eaff 54%, #c4ffe1 100%)', 'accent fills keep the original full-strength gradient');
  assert.match(gradient.border, /linear-gradient/);
  assert.match(gradient.border, /rgba\(217, 203, 255, 0\.7\d*\)/, 'only the active outline uses softer 70% opacity');
  assert.equal(gradient.borderWidth, '1px', 'native browser content cannot cover the reserved border');
  await page.waitForTimeout(150);
  const borderRect = await page.$eval('.tile.active', (tile) => {
    const rect = tile.getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top + rect.height / 2), width: 4, height: 1 };
  });
  const borderPixels = await app.evaluate(async ({ BrowserWindow }, rect) => {
    // Inspect the rendered edge in memory; do not save preview screenshots.
    const image = await BrowserWindow.getAllWindows()[0].capturePage(rect);
    return [...image.toBitmap()];
  }, borderRect);
  assert.ok(borderPixels.some((value, index) => index % 4 !== 3 && value > 80), 'the accent border is actually painted above the pane background');

  // Confirm animation geometry halfway through a row, column and nested close.
  await page.evaluate(() => updateAppSettings({ confirmClose: false }));
  for (const dir of ['row', 'col', 'nested']) {
    const result = await page.evaluate((dir) => {
      const ws = activeWs();
      const original = ws.panes[0];
      splitPane(ws, original, dir === 'col' ? 'col' : 'row');
      if (dir === 'nested') splitPane(ws, ws.panes[ws.activePaneIdx], 'col');
      const closing = ws.panes[ws.activePaneIdx];
      const sibling = closing.tile.previousElementSibling.previousElementSibling;
      const axis = dir === 'row' ? 'width' : 'height';
      const before = { closed: closing.tile.getBoundingClientRect()[axis], sibling: sibling.getBoundingClientRect()[axis] };
      closing.tile.querySelector('.pane-close').click();
      const animations = document.getAnimations().filter((animation) => animation.effect.target.matches('.pane-closing, .split-divider'));
      animations.forEach((animation) => { animation.pause(); animation.currentTime = 100; });
      const halfway = { closed: closing.tile.getBoundingClientRect()[axis], sibling: sibling.getBoundingClientRect()[axis] };
      return { before, halfway, animations: animations.length, id: closing.id };
    }, dir);
    assert.ok(result.animations >= 2, `${dir}: pane and divider animate together`);
    assert.ok(result.halfway.closed > 0 && result.halfway.closed < result.before.closed, `${dir}: pane collapses instead of vanishing`);
    assert.ok(result.halfway.sibling > result.before.sibling, `${dir}: neighboring pane expands during the transition`);
    await page.evaluate(() => document.getAnimations().filter((animation) => animation.effect.target.matches('.pane-closing, .split-divider')).forEach((animation) => animation.finish()));
    await page.waitForFunction((id) => !document.querySelector(`[data-pane-id="${id}"]`), result.id);
    // Remove the extra nested sibling without motion.
    if (dir === 'nested') {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('.tile.active .pane-close').click();
      await page.waitForFunction(() => document.querySelectorAll('.ws-view.active .tile').length === 1);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.pane-closing').length), 0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  }

  // Focusing native browser content must select its owner without stealing
  // focus back into the address field.
  await page.click('.tile.active [data-action="splitRight"]');
  const browserPane = await page.getAttribute('.tile.active', 'data-pane-id');
  await page.click('.tile.active [data-action="toggleSurface"]');
  await page.waitForSelector('.browser-url:visible');
  await page.locator('.browser-url:visible').fill(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('.browser-url:visible').press('Enter');
  await page.waitForFunction(() => document.querySelector('.tile.active .pane-tab.selected')?.textContent.includes('Focus Test'));
  await page.waitForTimeout(150);
  await page.locator('.tile[data-pane-type="terminal"] .pane-tab-select').click();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find((child) => child.getVisible());
    win.focus();
    view.webContents.focus();
    view.webContents.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 });
    view.webContents.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 });
  });
  await page.waitForFunction((id) => document.querySelector('.tile.active')?.dataset.paneId === id, browserPane);
  await page.waitForTimeout(150);
  const borders = await page.$$eval('.tile', (tiles) => tiles.map((tile) => getComputedStyle(tile).borderImageSource));
  assert.equal(borders.filter((source) => source !== 'none').length, 1, 'only the active pane is highlighted');
  await app.close();
  app = await launch(userData);
  page = await app.firstWindow();
  await page.waitForSelector('.tile.active');
  assert.equal(await page.evaluate(() => appSettings.accentColor), 'synthesis', 'gradient persists after relaunch');
  assert.match(await page.$eval('.tile.active', (el) => getComputedStyle(el).borderImageSource), /linear-gradient/);
});
