'use strict';
// Disposable, synthetic fixtures only. No prompts or live application state.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHistoryReader } = require('../lib/chat-history');
const { _electron } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const runs = Number(process.env.BENCH_RUNS || 5);
const sessionSource = (cwd, count) => [
  { type: 'session', version: 3, cwd },
  ...Array.from({ length: count }, (_, i) => ({ type: 'message', id: `m${i}`, parentId: i ? `m${i - 1}` : null, message: {
    role: i % 2 ? 'assistant' : 'user', timestamp: 1000 + i,
    content: i % 2 ? `Response ${i}\n\n### Implementation\n\nRead [the source](./main.js).\n\n- Check the inputs\n- Preserve existing behavior\n\n\`\`\`js\nconst result = ${i};\n\`\`\`\n\n| Check | Result |\n| --- | --- |\n| Validation | Passed |` : `Question ${i}: please explain the project files and the next steps.`,
  } })),
].map(entry => JSON.stringify(entry)).join('\n') + '\n';
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'synthesis-loading-bench-'));
  let app;
  try {
    const userData = path.join(temp, 'userdata'), agentDir = path.join(temp, 'agent');
    const owned = {}, workspaces = [], files = [];
    for (let w = 0; w < 20; w++) {
      const cwd = path.join(temp, `project-${w}`); await fs.mkdir(cwd);
      const dir = path.join(agentDir, 'sessions', '--' + cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-') + '--');
      await fs.mkdir(dir, { recursive: true });
      const tabs = [];
      for (let c = 0; c < 5; c++) {
        const sessionPath = path.join(dir, `chat-${c}.jsonl`);
        await fs.writeFile(sessionPath, sessionSource(cwd, w === 0 && c === 0 ? 1000 : 10));
        owned[sessionPath] = true; files.push({ cwd, sessionPath });
        tabs.push({ id: `ws-${w + 1}-chat-${c}`, type: 'chat', sessionPath });
      }
      const paneId = `ws-${w + 1}-p1`;
      workspaces.push({ id: `ws-${w + 1}`, name: `Project ${w}`, cwd, fileDir: cwd, activePaneId: paneId,
        panes: [{ id: paneId, type: 'chat', tabs, activeTabId: tabs[0].id }], layout: { paneId } });
    }
    const env = { ...process.env, SYNTHESIS_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, SYNTHESIS_SCHEDULER_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    async function launch() {
      app = await _electron.launch({ args: [ROOT], cwd: ROOT, env });
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('chat:start'); ipcMain.handle('chat:start', () => ({ ok: true })); });
      return app.firstWindow();
    }
    let page = await launch(); await page.waitForSelector('.ws-view.active .chat-body');
    await page.evaluate(owned => localStorage.setItem('synthesis.chat.ownedSessions', JSON.stringify(owned)), owned);
    await app.close(); app = null;
    const startup = [], thread = [], preload = [], history = [], counts = [];
    for (let run = 0; run < runs; run++) {
      await fs.writeFile(path.join(userData, 'workspaces.json'), JSON.stringify({ schemaVersion: 2, activeWorkspaceId: 'ws-1', workspaces }));
      const began = performance.now(); page = await launch();
      await page.waitForFunction(() => typeof state !== 'undefined' && state.activeId && document.querySelector('.ws-view.active textarea'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      startup.push(performance.now() - began);
      await page.waitForFunction(() => chatPreviewCache.size === 100, null, { timeout: 60000 });
      preload.push(performance.now() - began);
      const result = await page.evaluate(async file => {
        chatMarkupCache.clear(); chatMarkupBytes = 0;
        const began = performance.now();
        openConversation(conversationRows().find(row => row.key === file));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ms: performance.now() - began, nodes: document.querySelectorAll('.ws-view.active .chat-messages .chat-message').length };
      }, files[0].sessionPath);
      thread.push(result.ms); counts.push(result.nodes);
      await app.close(); app = null;
      const reader = createHistoryReader();
      const start = performance.now();
      for (const file of files.slice(1, 25)) await reader.loadProjection(file.cwd, file.sessionPath);
      history.push(performance.now() - start);
    }
    const result = { fixture: { projects: 20, savedThreads: 100, longThreadMessages: 1000, historyFiles: 24 }, runs,
      mediansMs: { startup: median(startup), preload: median(preload), thread: median(thread), history: median(history) },
      samplesMs: { startup, preload, thread, history }, renderedMessageCounts: counts };
    const output = process.argv[2];
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally { if (app) await app.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
