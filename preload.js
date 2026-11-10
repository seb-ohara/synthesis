const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mux', {
  git: { status: cwd => ipcRenderer.invoke('git:status', cwd), review: (cwd, scope, ref) => ipcRenderer.invoke('git:review', { cwd, scope, ref }), action: (cwd, action, data) => ipcRenderer.invoke('git:action', { cwd, action, data }), github: (cwd, action) => ipcRenderer.invoke('git:github', { cwd, action }), commitAuto: (cwd, action, model, expectedBranch) => ipcRenderer.invoke('git:commitAuto', { cwd, action, model, expectedBranch }), openFinder: cwd => ipcRenderer.invoke('git:openFinder', cwd) },
  fonts: { list: (includeSystem) => ipcRenderer.invoke('fonts:list', includeSystem), import: () => ipcRenderer.invoke('fonts:import') },
  chat: {
    history: (cwd, sessionPath) => ipcRenderer.invoke('chat:history', { cwd, sessionPath }),
    preload: requests => ipcRenderer.invoke('chat:preload', requests),
    start: (id, cwd, sessionPath) => ipcRenderer.invoke('chat:start', { id, cwd, sessionPath }),
    sessions: (cwd, ownedPaths) => ipcRenderer.invoke('chat:sessions', cwd, ownedPaths),
    createScratch: () => ipcRenderer.invoke('chat:createScratch'),
    remove: (cwd, sessionPath) => ipcRenderer.invoke('chat:delete', { cwd, sessionPath }),
    title: (cwd, message, model) => ipcRenderer.invoke('chat:title', { cwd, message, model }),
    command: (id, message) => ipcRenderer.send('chat:command', { id, message }),
    stop: (id) => ipcRenderer.send('chat:stop', id),
    onEvent: (id, cb) => { const h = (_e, m) => { if (m.id === id) cb(m.event); }; ipcRenderer.on('chat:event', h); return () => ipcRenderer.removeListener('chat:event', h); },
  },
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    history: (id) => ipcRenderer.invoke('pty:history', { id }),
    list: () => ipcRenderer.invoke('pty:list'),
    input: (id, data) => ipcRenderer.send('pty:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('pty:kill', { id }),
    onData: (id, cb) => {
      const h = (_e, m) => { if (m.id === id) cb(m.data); };
      ipcRenderer.on('pty:data', h);
      return () => ipcRenderer.removeListener('pty:data', h);
    },
    onExit: (id, cb) => {
      const h = (_e, m) => { if (m.id === id) cb(m); };
      ipcRenderer.on('pty:exit', h);
      return () => ipcRenderer.removeListener('pty:exit', h);
    },
  },
  fs: {
    list: (p) => ipcRenderer.invoke('fs:list', p),
    read: (p) => ipcRenderer.invoke('fs:read', p),
    limits: () => ipcRenderer.invoke('fs:limits'),
    reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
    openExternal: (p) => ipcRenderer.invoke('fs:openExternal', p),
    watch: (p) => ipcRenderer.invoke('fs:watch', p),
    unwatch: () => ipcRenderer.send('fs:unwatch'),
    onChanged: (cb) => {
      const h = (_e, m) => cb(m);
      ipcRenderer.on('fs:changed', h);
      return () => ipcRenderer.removeListener('fs:changed', h);
    },
  },
  browser: {
    create: (opts) => ipcRenderer.invoke('browser:create', opts),
    navigate: (id, url) => ipcRenderer.invoke('browser:navigate', { id, url }),
    back: (id) => ipcRenderer.send('browser:back', { id }),
    forward: (id) => ipcRenderer.send('browser:forward', { id }),
    reload: (id) => ipcRenderer.send('browser:reload', { id }),
    stop: (id) => ipcRenderer.send('browser:stop', { id }),
    zoom: (id, zoomFactor) => ipcRenderer.invoke('browser:zoom', { id, zoomFactor }),
    setBounds: (rect) => ipcRenderer.invoke('browser:setBounds', rect),
    clearData: () => ipcRenderer.invoke('browser:clearData'),
    openExternal: (id) => ipcRenderer.invoke('browser:openExternal', { id }),
    dispose: (id) => ipcRenderer.send('browser:dispose', { id }),
    onFocus: (cb) => {
      const h = (_e, message) => cb(message);
      ipcRenderer.on('browser:focus', h);
      return () => ipcRenderer.removeListener('browser:focus', h);
    },
    onContextMenu: (cb) => {
      const h = (_e, message) => cb(message);
      ipcRenderer.on('browser:context-menu', h);
      return () => ipcRenderer.removeListener('browser:context-menu', h);
    },
    onNewTab: (cb) => {
      const h = (_e, message) => cb(message);
      ipcRenderer.on('browser:new-tab', h);
      return () => ipcRenderer.removeListener('browser:new-tab', h);
    },
    onState: (id, cb) => {
      const h = (_e, m) => { if (m.id === id) cb(m); };
      ipcRenderer.on('browser:state', h);
      return () => ipcRenderer.removeListener('browser:state', h);
    },
  },
  sessions: {
    save: (data) => ipcRenderer.invoke('sessions:save', data),
    saveSync: (data) => ipcRenderer.sendSync('sessions:saveSync', data),
    load: () => ipcRenderer.invoke('sessions:load'),
  },
  app: {
    openChatLink: (url) => ipcRenderer.invoke('app:openChatLink', url),
    prepareDocument: (cwd, path) => ipcRenderer.invoke('app:prepareDocument', { cwd, path }),
    setTabShortcuts: (bindings) => ipcRenderer.send('app:tab-shortcuts', bindings),
    onTabCommand: (cb) => {
      const h = (_e, message) => cb(message);
      ipcRenderer.on('app:tab-command', h);
      return () => ipcRenderer.removeListener('app:tab-command', h);
    },
    home: () => ipcRenderer.invoke('app:home'),
    shellName: () => ipcRenderer.invoke('app:shell'),
    allowRoot: (p) => ipcRenderer.invoke('app:allowRoot', p),
    pickPath: () => ipcRenderer.invoke('dialog:pick'),
    pickDirectory: (current) => ipcRenderer.invoke('dialog:pickDirectory', current),
    getDroppedFilePath: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return ''; }
    },
    onWindowGeometryChange: (cb) => {
      const h = () => cb();
      ipcRenderer.on('app:window-geometry-changed', h);
      return () => ipcRenderer.removeListener('app:window-geometry-changed', h);
    },
  },
});
