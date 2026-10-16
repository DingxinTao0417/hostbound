// 项目页的桥：只能收发项目相关的消息，别的什么都碰不到
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pw', {
  on: (cb) => ipcRenderer.on('pw', (_e, msg) => cb(msg)),
  send: (msg) => ipcRenderer.send('pw-ui', msg),
});
