const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appraiseBridge', {
  on: (cb) => ipcRenderer.on('appraise', (_e, msg) => cb(msg)),
  send: (msg) => ipcRenderer.send('appraise-ui', msg),
});
