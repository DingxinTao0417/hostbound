// 讲解窗口的桥：只能收发讲解相关的消息，别的什么都碰不到
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xw', {
  on: (cb) => ipcRenderer.on('xw', (_e, msg) => cb(msg)),
  send: (msg) => ipcRenderer.send('xw-ui', msg),
});
