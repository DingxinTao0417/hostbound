const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fxBridge', {
  onFx: (cb) => ipcRenderer.on('fx', (_e, msg) => cb(msg)),
  idle: () => ipcRenderer.send('fx-idle'),
});
