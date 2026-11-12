# Loading speed analysis

Measured on 12 November 2026, using the project source on this Apple Silicon Mac, Node 26.9.0 and Electron 44.9.1.

## Measured savings

These are the middle results from five runs before and five runs after the changes. Lower is better.

| Task | Before | After | Time saved | Less waiting |
| --- | ---: | ---: | ---: | ---: |
| Open the application with 20 projects and 100 saved threads | 1,796 ms | 796 ms | 1,000 ms | 56% |
| Open a saved thread with 1,000 messages | 397 ms | 134 ms | 264 ms | 66% |
| Open the app and prepare previews for all 100 threads | 2,600 ms | 1,011 ms | 1,589 ms | 61% |
| Read 24 different saved thread files | 277 ms | 36 ms | 241 ms | 87% |

The preview-preparation figure includes application startup. The rows measure different tasks, so their savings should not be added together. Values are rounded independently.

## What changed, in simple terms

### 1. Prepare a thread's controls when you open it

Previously, startup built message boxes, model menus and other controls for every restored thread, including ones you could not see. Now it remembers those threads and builds their controls on first opening. In the benchmark, that avoids preparing 100 hidden chat interfaces before you can start using the app.

### 2. Show the newest messages first

A long thread previously turned every saved message into formatted content before opening. It now shows the latest 60 messages first. **Load earlier messages** adds 60 older messages at a time, in order, while keeping the existing messages and live replies in place.

For the 1,000-message example, that is **94% fewer message elements on first display**. The full history is still saved and the agent's conversation context is unchanged. Background formatting also concentrates on the newest 60 messages.

### 3. Reuse the history readers

Previously, each uncached saved file started a new background worker. Now up to two workers are reused across files. Reading and parsing still happen away from the application's main thread. Idle workers release their memory after 10 seconds.

File-change checks, cache limits, session validation and the fallback to normal agent loading remain in place.

### 4. Avoid repeated sidebar work

Startup now waits until restored projects are assembled before drawing their sidebar entries. Project scan results that arrive together share a sidebar update. The app only measures and copies sidebar cards for animations when they actually change sections.

Independent startup information is requested together, and overlapping skill-list requests share one lookup.

## How the comparison was measured

- All fixtures use temporary folders; the benchmark does not open or modify your real conversations.
- The same fixture contains 20 projects and 100 saved threads. One thread contains 1,000 alternating user/assistant messages; the other 99 contain 10 each. Assistant messages contain Markdown, links, code and tables.
- Startup is measured from Electron launch until the selected chat has a message box, followed by two animation frames. This measures interface availability, not readiness of an AI model.
- Thread opening is measured with saved history already in the preview cache but its formatted-text cache cleared, followed by two animation frames. It includes selecting the thread, creating its controls and displaying its newest content.
- Preview preparation is measured from launch until all 100 histories reach the renderer's preview cache; it does not wait for every background formatting task.
- File reading measures 24 distinct small files, read sequentially using a new history reader for each run. Each file still receives the normal file checks.
- Agent startup is stubbed in the benchmark. No AI prompts are sent. These savings do not measure model response time, network speed or the first launch after installation.
- Results will vary with project count, thread size, disk state and other applications running on the machine. This is a controlled local comparison, not a guarantee for every session.

Run the benchmark again with:

```sh
npm run benchmark:loading -- docs/performance/loading-latest.json
```

Use `BENCH_RUNS=10` to collect more samples. Raw measurements are saved in `loading-before.json` and `loading-after.json` beside this report.

## Regression checks

The automated checks cover saved-history refresh, late-preview races, model and reasoning selection, message order, loading all older messages, preserving live replies, and restoring tab identities while deferring hidden controls. The history reader also checks concurrent files, an invalid session and a subsequent repaired session.

- **Unit tests: 85 passed.**
- **Full integration run: 31 passed, 9 failed.** All loading-specific checks passed, including the new deferred-controls and paginated-history coverage.
- Eight failures are in the older `app.test.js` tests and involve workspace cards, removed controls, terminal-menu entries, hidden restored panes or an outdated close-button label. The remaining failure is a theme test expecting the textarea's text color even though the app displays text through an overlaid mirror.
- As a baseline check, the first workspace-card failure and the theme-color failure were reproduced on a temporary copy of the unchanged Git HEAD, with the same selectors/assertions failing. The other legacy failures were not individually rerun on that copy. These unrelated tests were not rewritten as part of the loading changes.
- Syntax checks and `git diff --check` passed.

The full integration run used `env -u ELECTRON_RUN_AS_NODE node --test --test-concurrency=1 --test-timeout=120000 test/integration/`. Clearing that inherited environment variable is required by the older Electron test launcher in this terminal environment.
