const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hostbound', {
  onBrain: (cb) => ipcRenderer.on('brain', (_e, msg) => cb(msg)),
  onCmd: (cb) => ipcRenderer.on('cmd', (_e, msg) => cb(msg)),
  send: (msg) => ipcRenderer.send('to-brain', msg),
  setHit: (on) => ipcRenderer.send('hit', on),
  dragEdge: () => ipcRenderer.send('drag-edge'),
  petRect: (r) => ipcRenderer.send('pet-rect', r),
  focus: () => ipcRenderer.send('focus'),
  blur: () => ipcRenderer.send('blur'),
  config: () => ipcRenderer.invoke('config'),
  log: (text) => ipcRenderer.send('ui-log', String(text)),
  copyText: (text) => ipcRenderer.send('copy-text', String(text)),
  // 设置页
  settings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value, label) => ipcRenderer.invoke('settings:set', { key, value, label }),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openPath: (which) => ipcRenderer.send('open-path', which),
  onboarded: () => ipcRenderer.send('onboarded'),
  relaunch: () => ipcRenderer.send('relaunch'),
  secretStatus: () => ipcRenderer.invoke('secret:status'),
  setSecret: (name, value) => ipcRenderer.invoke('secret:set', { name, value }),
});
