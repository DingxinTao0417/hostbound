// 效果层（主进程这边）：每块屏幕一个全屏、透明、点不到的窗口，画系统操作时的效果。
// 大脑发来的坐标多半是屏幕物理像素（Open Computer Use、Windows 窗口），这里换成 DIP，
// 找到它在哪块屏幕上，再换成那块屏幕里的坐标发给对应的窗口。
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('node:path');

class FxLayer {
  constructor({ coreDisplay, coreHome, cursorHome }) {
    this.wins = new Map(); // 屏幕 id → { win, ready, queue }
    this.coreDisplay = coreDisplay; // 系统核心所在的屏幕
    this.coreHome = coreHome; // 系统核心中心点（屏幕 DIP 坐标）：小提示挂在它旁边
    this.cursorHome = cursorHome || coreHome; // 系统光标起飞、归位的点：核心隐去时是面板靠核心那条边的中点
    ipcMain.on('fx-idle', (e) => {
      for (const s of this.wins.values()) if (!s.win.isDestroyed() && s.win.webContents === e.sender) s.win.hide();
    });
    screen.on('display-removed', (_e, d) => this.#drop(d.id));
    screen.on('display-metrics-changed', (_e, d) => {
      const s = this.wins.get(d.id);
      if (s && !s.win.isDestroyed()) s.win.setBounds(d.bounds);
    });
  }

  #drop(id) {
    const s = this.wins.get(id);
    if (s && !s.win.isDestroyed()) s.win.destroy();
    this.wins.delete(id);
  }

  #ensure(display) {
    let s = this.wins.get(display.id);
    if (s && !s.win.isDestroyed()) return s;
    const win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'fx-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    s = { win, ready: false, queue: [] };
    this.wins.set(display.id, s);
    win.webContents.once('did-finish-load', () => {
      s.ready = true;
      for (const m of s.queue.splice(0)) win.webContents.send('fx', m);
    });
    win.loadFile(path.join(__dirname, 'renderer', 'fx.html'));
    return s;
  }

  #send(display, msg) {
    const s = this.#ensure(display);
    if (!s.win.isVisible()) {
      s.win.setBounds(display.bounds);
      s.win.showInactive();
    }
    if (s.ready) s.win.webContents.send('fx', msg);
    else s.queue.push(msg);
  }

  // 物理像素 → DIP（Windows 上缩放不同的屏幕要分别换算）
  #dipRect(r, dip) {
    if (!r) return null;
    if (dip || process.platform !== 'win32') return r;
    return screen.screenToDipRect(null, { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
  }

  #local(r, d) {
    return r ? { ...r, x: r.x - d.bounds.x, y: r.y - d.bounds.y } : null;
  }

  route(msg) {
    // 全部清掉（任务结束）、光标回家：每块屏幕都要知道
    if ((msg.kind === 'scan' && msg.all) || msg.kind === 'home' || (msg.kind === 'takeover' && !msg.rect)) {
      for (const [id, s] of this.wins) {
        if (s.win.isDestroyed()) continue;
        const d = screen.getAllDisplays().find((x) => x.id === id);
        if (d && (s.win.isVisible() || msg.kind === 'takeover')) this.#send(d, { ...msg, home: this.#homeOn(d) });
      }
      if (msg.kind === 'takeover' && !this.wins.size) this.#send(this.coreDisplay(), { ...msg, home: this.#homeOn(this.coreDisplay()) });
      return;
    }
    let rect = this.#dipRect(msg.rect, msg.dip);
    let point = msg.point ? this.#dipRect({ ...msg.point, width: 0, height: 0 }, msg.dip) : null;
    // 通知放在系统核心那块屏幕上；有位置的效果放在它自己那块屏幕上
    const display = msg.kind === 'notice' || !rect ? this.coreDisplay() : screen.getDisplayMatching(rect.width ? rect : { ...rect, width: 1, height: 1 });
    this.#send(display, { ...msg, rect: this.#local(rect, display), point: point ? this.#local(point, display) : null, home: this.#homeOn(display), core: this.#coreOn(display) });
  }

  #homeOn(d) {
    return this.#onScreen(d, this.cursorHome());
  }

  // 「后台打开了某某」这类小提示挂在核心旁边，不跟着起飞点跑到面板上
  #coreOn(d) {
    return this.#onScreen(d, this.coreHome());
  }

  // 屏幕 DIP 坐标换算成这块屏幕的局部坐标；不在这块屏幕上就是 null
  #onScreen(d, h) {
    if (!h) return null;
    const b = d.bounds;
    if (h.x < b.x || h.y < b.y || h.x >= b.x + b.width || h.y >= b.y + b.height) return null;
    return { x: h.x - b.x, y: h.y - b.y };
  }

  // 截图时先把效果藏起来
  setOpacity(v) {
    for (const s of this.wins.values()) if (!s.win.isDestroyed()) s.win.setOpacity(v);
  }
}

module.exports = { FxLayer };
