// 把 app/icon.svg 渲染成 app/tray.png（256×256，透明底），再由 ffmpeg 转 icon.ico
// 用法：node_modules\electron\dist\electron.exe tools\render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(root, 'app', 'icon.svg'), 'utf8');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.writeFileSync(path.join(root, 'app', 'tray.png'), img.resize({ width: 256, height: 256 }).toPNG());
  app.quit();
});
