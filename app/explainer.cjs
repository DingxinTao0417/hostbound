// 讲解窗口（主进程这边）：只开一个，每次讲解是里面的一页。
// - 弹出来不抢焦点（宿主正在打字也不打断），默认不置顶，「钉住」才浮在最上面
// - 第一次在系统核心旁边展开，拖过、拉过的大小和位置记在 data/explainer-window.json
// - 页面里是大脑写的积木，隔离显示：跑不了 Node、不能弹新窗口、点链接用默认浏览器打开
// - 自检：大脑要看某几块画出来的样子时，只截讲解窗口自己的画面
const { BrowserWindow, ipcMain, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Explainer {
  constructor({ root, dataDir, toBrain, coreHome }) {
    this.root = root;
    this.dir = path.join(dataDir, 'explainers');
    this.stateFile = path.join(dataDir, 'explainer-window.json');
    this.toBrain = toBrain;
    this.coreHome = coreHome; // 系统核心中心点（屏幕 DIP 坐标）
    this.win = null;
    this.ready = false;
    this.pinned = false;
    ipcMain.on('xw-ui', (e, m) => {
      if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents || !m || typeof m !== 'object') return;
      this.#fromWindow(m);
    });
  }

  #readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }
  #saveBounds() {
    if (!this.win || this.win.isDestroyed() || this.win.isMinimized() || this.win.isMaximized()) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ ...this.#readState(), bounds: this.win.getBounds() }));
    } catch {}
  }

  // 记下的位置还在某块屏幕上就用它；不然在系统核心旁边展开
  #bounds() {
    const saved = this.#readState().bounds;
    if (saved && screen.getAllDisplays().some((d) => saved.x < d.workArea.x + d.workArea.width - 80 && saved.x + saved.width > d.workArea.x + 80 && saved.y >= d.workArea.y - 10 && saved.y < d.workArea.y + d.workArea.height - 80)) return saved;
    const home = this.coreHome?.() || null;
    const d = home ? screen.getDisplayNearestPoint(home) : screen.getPrimaryDisplay();
    const a = d.workArea;
    const width = Math.min(960, Math.round(a.width * 0.9));
    const height = Math.min(720, Math.round(a.height * 0.9));
    let x = a.x + Math.round((a.width - width) / 2);
    let y = a.y + Math.round((a.height - height) / 2);
    if (home) {
      x = home.x > a.x + a.width / 2 ? home.x - width - 60 : home.x + 60;
      y = home.y - height / 2;
    }
    x = Math.max(a.x + 8, Math.min(a.x + a.width - width - 8, Math.round(x)));
    y = Math.max(a.y + 8, Math.min(a.y + a.height - height - 8, Math.round(y)));
    return { x, y, width, height };
  }

  #ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.ready = false;
    const win = new BrowserWindow({
      ...this.#bounds(),
      minWidth: 560,
      minHeight: 420,
      frame: false,
      backgroundColor: '#050817',
      show: false,
      title: '系统讲解',
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'explainer-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.win = win;
    // 页面里的链接一律用默认浏览器打开，不在这个窗口里跳走，也不弹新窗口
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    win.webContents.on('did-finish-load', () => win.webContents.setVisualZoomLevelLimits(1, 1));
    let saveTimer = null;
    const later = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => this.#saveBounds(), 400);
    };
    win.on('move', later);
    win.on('resize', later);
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.toBrain({ type: 'xw_ui', op: 'closed' });
    });
    win.once('ready-to-show', () => win.showInactive());
    win.loadFile(path.join(__dirname, 'renderer', 'explainer', 'index.html'));
    if (this.pinned) win.setAlwaysOnTop(true, 'floating');
    return win;
  }

  get assets() {
    return pathToFileURL(this.dir + path.sep).href;
  }

  // 大脑发来的 { type: 'xw', op, ... }
  handle(m) {
    if (m.op === 'close') {
      if (this.win && !this.win.isDestroyed()) this.win.close();
      return;
    }
    if (m.op === 'capture') return this.#capture(m);
    if (m.op === 'show') {
      const fresh = !this.win || this.win.isDestroyed();
      const win = this.#ensure();
      // 已经开着：挪到最前面让宿主看见，但不抢焦点
      if (!fresh) {
        if (win.isMinimized()) win.showInactive();
        if (!win.isVisible()) win.showInactive();
        win.moveTop();
      }
      m = { ...m, assets: this.assets };
    }
    if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send('xw', m);
  }

  #fromWindow(m) {
    switch (m.op) {
      case 'ready':
        this.ready = true;
        return this.toBrain({ type: 'xw_ui', op: 'ready', version: m.version });
      case 'pin':
        this.pinned = !!m.on;
        this.win.setAlwaysOnTop(this.pinned, 'floating');
        return;
      case 'minimize':
        return this.win.minimize();
      case 'maximize':
        return this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize();
      case 'close':
        return this.win.close();
      case 'focus':
        return this.win.focus();
      case 'browser':
        return this.#exportAndOpen(m);
      default:
        return this.toBrain({ ...m, type: 'xw_ui' });
    }
  }

  // 「浏览器打开」：把这一页存成一个 HTML（积木内嵌，样式和脚本用本机的文件），交给默认浏览器
  #exportAndOpen(m) {
    try {
      const page = m.page;
      if (!page || !/^[\w-]+$/.test(page.id || '')) return;
      const r = (p) => pathToFileURL(path.join(this.root, 'app', 'renderer', 'explainer', p)).href;
      const data = JSON.stringify({ page, version: m.version, assets: this.assets }).replace(/</g, '\\u003c');
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(page.title || '系统讲解').replace(/[<&"]/g, '')} · 系统讲解</title>
<link rel="stylesheet" href="${r('explainer.css')}"></head>
<body class="standalone">
<script>window.XW_PAGE = ${data};</script>
<div id="app"></div>
<script src="${r('vendor/mermaid.min.js')}"></script>
<script src="${r('explainer.js')}"></script>
</body></html>`;
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${page.id}.html`);
      fs.writeFileSync(file, html);
      shell.openExternal(pathToFileURL(file).href);
    } catch (e) {
      console.error('explainer export failed', e);
    }
  }

  // 自检截图：让页面把那一块滚到眼前，报告位置，只截讲解窗口自己
  async #capture(m) {
    const images = [];
    try {
      const win = this.win;
      if (!win || win.isDestroyed() || !this.ready || win.isMinimized()) throw new Error('讲解窗口没开着');
      for (const id of [].concat(m.blocks || []).slice(0, 4)) {
        const rect = await win.webContents.executeJavaScript(`window.XW ? window.XW.rectOf(${JSON.stringify(String(id))}) : null`);
        if (!rect || rect.width < 20 || rect.height < 20) continue;
        await wait(350);
        let img = await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
        if (img.isEmpty()) continue;
        const size = img.getSize();
        const k = Math.min(1, 1200 / Math.max(size.width, size.height));
        if (k < 1) img = img.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k), quality: 'best' });
        images.push({ block: id, data: img.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' });
      }
      await win.webContents.executeJavaScript('window.XW && window.XW.scrollTop()').catch(() => {});
      this.toBrain({ type: 'xw_ui', op: 'capture_result', id: m.id, ok: images.length > 0, images });
    } catch (e) {
      this.toBrain({ type: 'xw_ui', op: 'capture_result', id: m.id, ok: false, error: e.message, images });
    }
  }
}

module.exports = { Explainer };
