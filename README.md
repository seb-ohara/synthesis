# Synthesis

Consolidated source and data snapshot for the Synthesis Electron app.

## Contents

- App source: `main.js`, `preload.js`, `pty-daemon.js`, `renderer.js`, `index.html`, and `styles.css`
- Shared libraries (`lib/`): versioned workspace state schema + atomic store (`state-schema.js`, `state-store.js`), filesystem path guard (`path-guard.js`), terminal pane status machine (`pane-status.js`), in-pane browser manager + URL policy (`browser-views.js`, `browser-url.js`)
- Tests (`test/unit/`, `test/integration/`): `npm test` runs the unit suite; `npm run test:integration` runs the Electron integration suite against disposable user-data directories
- Node project metadata: `package.json` and `package-lock.json`
- Branding: `assets/logo-variations/`
- UI/design explorations: `design-explorations/`
- User workspace and terminal-history snapshot: `data/app-support/`
- Implementation specification: `SYNTHESIS_IMPLEMENTATION_SPEC.md`

The app-support snapshot was copied from `~/Library/Application Support/Synthesis` (currently an alias to the existing `Pmux` support directory). It contains `workspaces.json` and terminal session logs. The original data remains untouched. Electron caches, transient socket/lock files, and other regenerable runtime state were not copied. Tests never use this snapshot — they run against temporary `SYNTHESIS_USER_DATA` directories.

## Run from this folder

Install dependencies with `npm ci`, then launch with `npm start`.

Note: node-pty's bundled darwin prebuild can be broken under newer Node
versions (symptom: `posix_spawnp failed`). `postinstall` detects this and
rebuilds node-pty from source automatically; to force it, run
`npm_config_build_from_source=true npm rebuild node-pty`.

`node_modules` and the installed `/Applications/Synthesis.app` bundle are not included; dependencies can be recreated from the lockfile. The originals in the home directory and the installed app have not been moved or changed.

## Tabs within panes

Use the pane options menu (⋯) or right-click a pane to create a **New Terminal Tab** or **New Browser Tab**. Tabs can mix terminal sessions and browser pages. Switching tabs keeps terminals
running and browser pages loaded. Close a tab with its × button; closing the
last tab opens a fresh terminal in the same pane. Close a pane with its × button or through its options menu. The final pane cannot be closed, and pane controls never close a workspace. Pane removal fades and collapses smoothly, or happens immediately when Reduce Motion is enabled.

- **⌘T** opens another tab of the current type.
- **⌘W** closes the current tab (with confirmation when enabled).
- **Control+Tab / Control+Shift+Tab** selects the next / previous tab.
- **⌘Shift+T / ⌘Shift+W** creates / closes a workspace.

Settings includes a **Synthesis** accent preset with the logo’s lilac → sky → mint gradient. The active pane has a fine accent border, including when focusing native browser content. The Files bar shows the current folder beside its heading; its **⋯** button reveals filtering, hidden files, view options, the picker and breadcrumbs.

Shortcuts can be changed in Settings. Browser links that request a new window
open a browser tab in the same pane. Workspaces save tab order, selection,
browser URLs and zoom, and stable terminal session identities. Existing
workspaces acquire tabs automatically; browser page form state is preserved
when switching tabs, but is not restored after quitting the app.

Tabs and pane controls share one 32-pixel row. Browser navigation and the
address field appear in a thin row immediately below the tabs when a browser tab is selected. Drag a
tab to reorder it or drop it on another pane in the same workspace. Moving
the last tab out of a pane removes the empty pane. Running terminals and
loaded browser pages retain their state when moved. Right-click a tab for
move commands, or focus its label and use Alt+Shift+Left/Right to reorder it.
