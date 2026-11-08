# Synthesis — CMUX-Inspired Improvements

**Document type:** Product and implementation specification  
**Status:** Proposed; ready for implementation planning  
**Date:** 2026-03-31  
**Project root:** `/Users/seb-ohara/Documents/Personal/AI/Projects/Synthesis`  
**Research basis:** CMUX release/source available by 31 March 2026 (v0.63.1 and repository snapshot `51fe28e`). Post-v0.63.1 CMUX material is distinguished from that release baseline and is only used where explicitly noted.

## 1. Executive summary

Synthesis already has two substantial foundations that should be preserved rather than rebuilt:

1. A detached PTY daemon keeps live terminal processes running when the Electron UI closes, and reattaches to them when the app opens again.
2. A built-in, resizable file panel can navigate directories, preview small text files, and send a directory change to the active terminal.

The main opportunities informed by CMUX are to make continuity more explicit and resilient, add a first-class browser surface inside the existing split-pane layout, and improve the existing file panel into a more capable project explorer. These should be separate surfaces and responsibilities: a terminal process, a browser page, file navigation, saved terminal output, and an agent's own conversation history are not interchangeable kinds of “memory.”

**Recommended order:** harden and clarify session recovery first; add the browser as a typed pane/surface second; improve the file explorer third; then consider opt-in agent-native resume and cross-terminal shared project context after the user's preferred agents and context model are confirmed.

## 2. Current Synthesis baseline

Observed in the project files:

- **App:** Electron 44, Node.js, xterm.js, `node-pty`; entry point `main.js`. (`package.json`)
- **PTY ownership:** `pty-daemon.js` runs detached from the UI, owns PTYs, and communicates over a Unix socket. It keeps a 512 KiB in-memory replay ring per session and appends a bounded terminal log (up to 10 MiB) per session. The socket is chmod 0600.
- **Reattachment:** `main.js` reconnects to the daemon and `renderer.js` spawns panes using their saved pane IDs. The daemon reattaches to a live session and replays buffered output. If the daemon has no live process for an ID, it replays the saved output and starts a new login shell. That is useful continuity, but it is not resumption of the dead shell process or its foreground program.
- **Workspace persistence:** `renderer.js` saves workspace name, cwd, file directory, active pane index, pane IDs, and split-tree shape to `workspaces.json`. Writes are debounced by 300 ms. The current saved shape has no explicit schema version or stable workspace ID.
- **Close semantics:** closing a pane/workspace kills its PTY; quitting the app closes the UI's socket client, not the detached daemon. The daemon cannot keep an OS process alive across a machine reboot. On reboot, terminal logs can remain, but the old shell/agent process cannot.
- **File panel:** `index.html` and `styles.css` provide a right-hand Files panel that is collapsible and resizable. `renderer.js` shows a single-directory listing with breadcrumbs, file sizes, and read-only text preview; the preview is limited to 2 MiB and displays at most 3,000 lines. It has a native open-file/folder picker, refresh, “open in terminal,” and “copy path” actions. It remembers a file directory per workspace.
- **Browser:** there is no browser surface in the pane model or UI. `createPane()` always creates an xterm terminal. Playwright packages appear in `package.json`, but the inspected source does not currently use them.
- **Testing:** `npm test` is a placeholder that exits with an error; there is no working project test suite in the checked-in package scripts.

### Relevant code map

| Area | Current files |
|---|---|
| Electron window, IPC, PTY client, filesystem operations | `main.js` |
| Narrow renderer API | `preload.js` |
| Persistent PTY owner and per-session output logs | `pty-daemon.js` |
| Workspace/pane model, split tree, restore, file UI | `renderer.js` |
| App structure, settings, workspace modal, Files panel | `index.html` |
| Three-column layout, split panes, Files panel and preview styling | `styles.css` |
| Project metadata and scripts | `package.json` |

## 3. Product goals

### Confirmed by the existing app and this brief

1. Preserve terminal work across closing/reopening the Synthesis UI when the daemon and machine remain running.
2. Make it unambiguous whether a restored pane is attached to a **live PTY**, showing **saved output with a fresh shell**, or has a **resumable agent conversation**.
3. Add a real browser page inside a workspace split, so a user can inspect a local web app without leaving Synthesis.
4. Improve the existing file panel without replacing the current workspace/terminal/file three-column arrangement.
5. Keep the current restrained dark UI and orange accent; borrow CMUX's useful primitives, not its exact layout or branding.

### Non-goals for the first implementation

- Replacing the persistent PTY daemon or changing the terminal emulator.
- Cloud sync, remote SSH workspaces, or cross-device state.
- Turning the general-purpose terminal into an opinionated AI-agent orchestrator.
- Treating terminal scrollback as agent memory or as a safe source for reconstructing prompts.
- Editing files in the preview panel or adding destructive file operations in the initial explorer pass.
- Automatically injecting hidden context or running arbitrary saved shell commands on restore.

## 4. Core product model: separate kinds of continuity

Synthesis should use these terms in UI, persistence, and implementation:

- **Live terminal session:** the same PTY process is still running and the pane reconnects to it. This already works across ordinary app UI restarts while the daemon remains alive.
- **Saved terminal output:** bounded log text for inspection after the original PTY process has ended. It is not an interactive continuation.
- **Agent session:** an agent's native conversation/session ID and its own durable history. Future support must use that agent's documented resume command; the PTY log alone is not enough.
- **Workspace context:** optional, human-readable project notes intentionally shared by multiple panes/agents. This is a separate feature and should not be silently inferred from terminal output.
- **Browser session:** browser URL/history and, if the user opts in to persistence, browser-profile cookies/storage. These must not be conflated with terminal or agent history.

## 5. Requirements

Priority definitions: **P0** = reliability/security foundation; **P1** = first product release; **P2** = follow-up capability.

### A. Session recovery and durable workspace state

#### P0 — Harden the existing design

1. Replace the unversioned workspace JSON shape with a versioned schema. Preserve a migration path from the current `{activeIndex, workspaces:[{name,cwd,fileDir,activePaneIdx,paneIds,tree}]}` format.
2. Preserve existing pane IDs during migration; they are the keys used to reconnect live daemon PTYs. Do not derive identity from pane ordering or array index.
3. Write snapshots atomically (temporary file then replace) and validate the parsed structure, field lengths, types, IDs, pane counts, and split-tree references before using it. Keep a last-known-good snapshot for recovery from truncated/corrupt JSON.
4. Add explicit daemon session listing/status to the IPC contract. `pty-daemon.js` already supports `list`; expose a validated `pty.list()` in `main.js` and `preload.js` rather than guessing process status from renderer state.
5. On restore, distinguish and visibly label:
   - **Reconnected** — same PTY still alive.
   - **Ended** — old PTY ended; saved output can be opened, and a new shell can be started.
   - **Unavailable** — daemon/session lookup failed; offer retry rather than silently presenting stale text as live output.
6. Persist promptly on structural changes (workspace/pane creation, close, split, reorder, active selection, directory change) and flush pending state on app shutdown. A failed save must leave the prior snapshot intact.
7. Keep intentional close behavior: closing a terminal pane/workspace stops its PTY and removes that session's history as it does today. Quitting/relaunching the app must not kill a live PTY.
8. Test all persistence using a temporary user-data directory. Do not use or modify `data/app-support/` as a test database; it is a copied user-data snapshot.

#### P1 — Agent-native resume (opt-in, after the agent list is confirmed)

1. Store only recognized agent kind, native session ID, working directory, pane ID, and the minimum launch metadata required to invoke the agent's documented resume command.
2. Never persist API keys, tokens, passwords, or arbitrary environment values as resume metadata.
3. Resume must use a hard-coded/validated adapter for each supported agent. Do not evaluate an arbitrary saved command string.
4. Offer a user setting for automatic resume versus a visible **Resume** action. Default to the safer manual action until the behavior is tested with the chosen agents.
5. If the agent session is missing, expired, or the CLI is unavailable, show an actionable status and retain saved terminal output; do not repeatedly spawn failing commands.
6. Treat terminal process restoration and agent conversation restoration as different operations. Generic shells and unsupported tools remain “saved output + new shell,” not “resumed.”

#### P2 — Explicit shared workspace context (decision required)

If the intended meaning of “memory across terminal instances” is sharing project facts between separate agent conversations, add a workspace-level Markdown context note as an explicit, user-owned artifact. It should be inspectable and editable, with clear per-workspace scope. Do not auto-summarize or inject terminal transcripts in the initial version. Decide whether this is a Synthesis-managed note or a project-local file before implementation.

### B. First-class in-pane browser

#### P1 — Browser surface MVP

1. Make workspace layout leaves typed surfaces: `terminal` or `browser`. A browser must participate in the same nested split tree and pane focus/resize/close lifecycle as a terminal.
2. Add **Open Browser Split** actions (right/down) and a keyboard shortcut. Opening a browser should not replace or kill the active PTY.
3. Show a compact browser toolbar in the pane: back, forward, reload/stop, editable URL field, loading indicator, and open-in-default-browser action. Keep the pane title and current URL readable at narrow widths.
4. Support HTTP and HTTPS URLs, including localhost development servers. Normalize missing schemes safely. Handle failed navigation and unsupported schemes with clear UI errors.
5. Persist browser pane type, last URL, zoom, and selected browser profile identifier in the workspace snapshot. Restore the URL on launch. Do not claim that arbitrary page JavaScript/form state is restored.
6. Use a dedicated Electron `WebContentsView` (or the current Electron-supported equivalent), managed by the main process, for the untrusted web page. The native browser view should occupy only the content rectangle below Synthesis's own toolbar. Recompute its bounds after split/resize, workspace switch, window resize, and collapse/expand; hide/detach it when its workspace is inactive.
7. Keep the browser surface isolated from the app renderer: no Node integration, no preload exposing Synthesis filesystem/PTY APIs, sandboxing/context isolation enabled, and no direct access to the app's IPC bridge.
8. Define browser profile persistence explicitly. Recommended MVP: one local persistent profile with a visible **Clear browser data** action. Do not imply that URL restore alone preserves login. A later per-workspace profile option can prevent cookie/account crossover between projects.
9. Manage popups and external navigation deliberately: no uncontrolled new windows; allow safe HTTP(S) navigation in-pane and ask or open externally for other schemes. Block `javascript:` and untrusted `file:` navigation by default.
10. Browser views must be disposed when the browser surface is closed, without terminating terminal panes or other browser panes.

#### P2 — Browser automation

After the visible browser lifecycle is stable, expose a small, scoped automation surface to local agents. Start with identify-current-browser, navigate, wait, accessibility/DOM snapshot, screenshot, click, fill, and read URL/title. Use stable surface IDs and verify actions with returned state. Add frames/dialogs/downloads only after tests. Do not expose unrestricted JavaScript evaluation as the first automation API.

### C. Improve the existing Files panel

#### P1 — Explorer usability

1. Retain the current collapsible, resizable right-side panel and current three-column layout. Do not add a second competing Files sidebar.
2. Continue to default the active workspace's file root to its working directory and preserve each workspace's last visited directory.
3. Add a filter/search field for the current directory, a hidden-files toggle, and a visible empty/loading/error state. Consider hiding dotfiles by default but preserve an explicit way to reveal them.
4. Add an expandable tree mode rooted at the workspace directory, while retaining breadcrumbs for full-path orientation and quick parent navigation. Lazy-load children; do not recursively enumerate the whole project at once.
5. Keep current actions (open folder, preview file, open containing directory in the active terminal, copy path, refresh). Add **Reveal in Finder** and **Open externally** for files that cannot be previewed.
6. Add clearer file-type icons and selected/focused-row states consistent with the existing muted palette. Show git status only if it can be calculated cheaply and without blocking the UI; it is optional for the first release.
7. Keep previews read-only. Improve code previews with line numbers, optional wrapping, syntax highlighting, and an explicit size/line-limit message. Large files, binary files, unreadable files, and deleted files must fail gracefully.
8. Refresh visible directory data after file-system changes using a debounced watcher where practical; keep manual refresh as a fallback. Avoid a watcher per row or per workspace.
9. Directory enumeration should remain asynchronous and resilient to permission errors, broken symlinks, large directories, Unicode names, and filenames containing spaces.

#### P0 — Filesystem and IPC safety

1. Validate filesystem IPC inputs in the main process; renderer-supplied paths are untrusted. Keep using a narrow preload API rather than exposing `fs` or `ipcRenderer` directly.
2. Define authorized roots: the home directory, workspace roots, and paths explicitly selected by the user. Canonicalize paths and account for symlinks before allowing list/read operations outside those roots.
3. Do not let the browser surface use the file-panel IPC bridge. Do not execute file contents or silently open executable files.
4. Make preview byte limits and allowed operations explicit and consistent between main and renderer.

## 6. Proposed saved-state schema

The exact schema can change during implementation, but it should represent surface types and stable identity explicitly. Example:

```json
{
  "schemaVersion": 2,
  "activeWorkspaceId": "ws-...",
  "workspaces": [
    {
      "id": "ws-...",
      "name": "web app",
      "cwd": "/path/to/project",
      "fileDir": "/path/to/project/src",
      "activePaneId": "ws-...-p1",
      "panes": [
        { "id": "ws-...-p1", "type": "terminal", "cwd": "/path/to/project" },
        { "id": "ws-...-p2", "type": "browser", "url": "http://localhost:3000", "zoom": 1, "profileId": "default" }
      ],
      "layout": { "type": "split", "direction": "row", "children": [ { "paneId": "ws-...-p1" }, { "paneId": "ws-...-p2" } ] }
    }
  ]
}
```

Requirements for this schema:

- Migration must preserve the existing pane IDs and translate the old index-based tree to ID references.
- Do not store PIDs as identity; they change when a process restarts.
- Do not store browser passwords or raw cookies in the workspace JSON. Browser cookies belong to Electron's profile store.
- Agent resume metadata is optional and must contain no secret values.
- Bound the number of workspaces/panes and JSON size; reject malformed or cyclic layouts.

## 7. Key user flows

### Relaunch while terminal processes are live

1. User quits or closes the Synthesis UI.
2. The PTY daemon remains alive if sessions are active.
3. On next launch, Synthesis loads/migrates the workspace snapshot and checks daemon status.
4. Each terminal pane reconnects by stable pane ID and shows **Reconnected**; no duplicate shell is spawned.
5. Browser panes restore their saved URL/profile; Files returns to its saved directory.

### Reopen after machine restart or dead daemon

1. Synthesis restores the workspace and split layout.
2. The pane shows that the previous PTY is no longer live.
3. User can inspect saved output and start a fresh shell in the saved cwd; the UI clearly separates old log text from the new shell prompt.
4. If a supported agent adapter is implemented and the user enabled it, offer native agent resume separately.

### Check a local web change

1. User opens a browser split beside an existing terminal.
2. User starts a local server in the terminal and opens its localhost URL in the browser pane.
3. Browser controls remain usable through split resizing and workspace switching.
4. Closing the browser does not stop the server or alter the terminal session.

### Browse a project

1. Files opens at the active workspace root.
2. User filters or expands directories, opens a text preview, copies/reveals a path, or changes the active terminal to the chosen directory.
3. Switching workspaces restores each workspace's independent file location.

## 8. Acceptance criteria

### Session recovery

- A clean UI quit/reopen with a live PTY reattaches to the same process and does not create a second shell.
- Closing one workspace still kills only that workspace's PTYs and removes their saved logs as intended.
- A daemon disconnect/reconnect during an active session does not lose input/output or mislabel a dead session as live.
- A machine-restart simulation (daemon stopped, snapshot/log retained) restores layout and clearly identifies old output versus a new shell.
- Invalid, truncated, old-version, or partially written state never crashes boot and never overwrites the last-known-good snapshot.
- Migration from the existing data shape preserves workspace names, cwd, fileDir, pane IDs, active pane, and split topology.

### Browser

- Browser and terminal panes can be split both horizontally and vertically; resizing, focus, switching workspaces, and closing behave predictably.
- Browser URL/zoom/profile metadata restores after app relaunch; a failed URL displays a recoverable error.
- A browser page cannot call Synthesis PTY or filesystem APIs and cannot load `javascript:` or arbitrary `file:` URLs by default.
- Browser popups, external links, and unsupported schemes follow the documented policy.
- Localhost development pages render and remain interactive in a pane at the minimum supported window size.

### Files

- Search/filter, dotfile visibility, breadcrumbs, tree expansion, keyboard focus, refresh, and preview work with Unicode/space-containing paths.
- Large or binary files do not freeze the UI or exceed configured preview limits.
- Filesystem errors are displayed without losing the current workspace or changing its PTY.
- IPC rejects paths outside authorized roots and does not permit traversal through symlinks to bypass the root policy.

### Quality

- Add unit tests for schema migration/validation and PTY status transitions.
- Add Electron integration tests for app relaunch, split layout, browser navigation, and file preview using temporary user-data directories.
- Add UI tests for keyboard navigation, minimum-size layout, and status/error states. Replace the placeholder `npm test` script with a real test command.
- Test against a disposable Synthesis support directory; never exercise tests against the user's live app-support folder.

## 9. Implementation sequence

### Milestone 0 — State and test foundation (P0)

- Add a test harness and temporary Electron user-data configuration.
- Implement versioned state schema, validator, atomic writer, backup, and migration.
- Add PTY daemon `list` IPC and status-aware restore UI.
- Add restore banners distinguishing reconnected, ended, and unavailable states.

### Milestone 1 — Browser surface (P1)

- Refactor pane creation/rendering to support a terminal/browser surface union.
- Add main-process browser-view lifecycle and renderer-to-main bounds/focus synchronization.
- Implement toolbar, navigation, URL/zoom persistence, profile policy, and security rules.
- Add basic automation only after browser lifecycle tests pass.

### Milestone 2 — File explorer (P1)

- Harden filesystem IPC and define authorized roots.
- Add filtering, hidden-file control, lazy tree mode, selection/focus behavior, and watcher-backed refresh.
- Improve read-only preview, file actions, and error handling.

### Milestone 3 — Agent continuity/context (P2, decision gated)

- Select target agents and implement validated native-session adapters.
- Add manual/automatic resume preferences and failure handling.
- Decide whether Synthesis needs an explicit workspace context note shared between independent conversations. Keep this separate from PTY logs and agent-native history.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Browser native view drifts over DOM split panes or covers controls | Keep browser view bounds restricted to the page content rectangle; test all resize/switch/collapse paths. |
| Browser content gains access to local app APIs | Separate `WebContentsView` session; no Synthesis preload; enforce scheme/navigation policy in main. |
| Old session output is mistaken for a live process | Surface explicit liveness state and a visible boundary before any new-shell prompt. |
| Agent resume reruns unsafe or stale commands | Use per-agent allowlisted adapters and native session IDs; never auto-run arbitrary persisted shell text. |
| Workspace JSON corruption loses the user's layout | Version schema, validate, atomic write, last-known-good backup, migration tests. |
| File explorer exposes unintended files through IPC | Main-process path validation, authorized roots, real-path/symlink checks, and temporary-root security tests. |
| Browser cookies or terminal logs contain sensitive data | Local-only storage, clear-data controls, bounded retention, user-only file permissions, and no secret metadata in snapshots. |
| Adding all CMUX features at once increases scope and regression risk | Ship state recovery, browser, files, then agent automation in separate milestones. |

## 11. Open decisions

These are not blockers for Milestone 0, but should be settled before the relevant later work:

1. Which agent CLIs should be supported first (e.g. Claude Code, Codex, Pi, OpenCode)?
2. Should browser cookies be shared globally or isolated per workspace? Recommended MVP: one clearly identified persistent profile, with a later per-workspace option.
3. Should browser automation be a first-release requirement, or should the first release focus on the visual browser pane and local dev workflow?
4. Does “memory across terminal instances” mean native conversation resume, a shared workspace context note, or both? These solve different problems.
5. For the Files panel, should the tree be the default view, or should the current breadcrumb/list view remain default with tree as an optional mode?
6. Should the file explorer be scoped to the workspace root by default, with user-selected extra roots, or remain free to navigate the entire home directory?

## 12. Research references

### Synthesis project evidence

- `README.md` — project description and provenance of the copied app-support snapshot.
- `main.js` — Electron window/security settings, PTY daemon connection, session IPC, filesystem IPC, lifecycle.
- `preload.js` — renderer-facing PTY/session/filesystem API.
- `pty-daemon.js` — daemon lifecycle, bounded replay ring/logs, reattachment, dead-session behavior.
- `renderer.js` — workspace state, split tree, restore, file listing/preview/actions.
- `index.html` and `styles.css` — present three-column UI and file-panel styling.
- `package.json` — dependencies and placeholder test script.

### CMUX primary sources (research cutoff: 31 March 2026)

1. [CMUX v0.63.1 release](https://github.com/manaflow-ai/cmux/releases/tag/v0.63.1) — stable release available before the cutoff.
2. [CMUX repository snapshot at 31 March 2026](https://github.com/manaflow-ai/cmux/commit/51fe28e45dbe79145efed09da5a78841d54f95a0).
3. [README at the pinned snapshot](https://github.com/manaflow-ai/cmux/blob/51fe28e45dbe79145efed09da5a78841d54f95a0/README.md) — describes terminal/browser panes and clarifies that session restore did not yet resume live process state.
4. [CMUX SessionPersistence.swift at the pinned snapshot](https://github.com/manaflow-ai/cmux/blob/51fe28e45dbe79145efed09da5a78841d54f95a0/Sources/SessionPersistence.swift) — snapshot model and bounded scrollback policy.
5. [CMUX browser panel implementation](https://github.com/manaflow-ai/cmux/blob/51fe28e45dbe79145efed09da5a78841d54f95a0/Sources/Panels/BrowserPanel.swift).
6. [CMUX browser automation port spec](https://github.com/manaflow-ai/cmux/blob/51fe28e45dbe79145efed09da5a78841d54f95a0/docs/agent-browser-port-spec.md) — implemented browser automation families and recorded parity gaps.
7. [CMUX browser screenshot at the pinned snapshot](https://raw.githubusercontent.com/manaflow-ai/cmux/51fe28e45dbe79145efed09da5a78841d54f95a0/docs/assets/built-in-browser.png).

CMUX's Finder-like file explorer is described in material beyond v0.63.1; it was not confirmed as part of that release. This spec uses the concept only as design inspiration for improving Synthesis's existing Files panel.
