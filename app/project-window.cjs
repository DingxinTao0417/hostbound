// 项目页（主进程这边）：一个单独的大窗口，看一个项目里总指挥和每个智能体在干什么。只开一个，换项目就在里面切。
// - 弹出来不抢焦点；拖过、拉过的大小和位置记在 data/project-window.json
// - 页面只能收发项目相关的消息（project-preload.cjs）；数据都找大脑要（快照 + 一条条事件）
const { BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

class ProjectWindow {
  constructor({ dataDir, toBrain, coreHome, defaultDir }) {
    this.stateFile = path.join(dataDir, 'project-window.json');
    this.toBrain = toBrain;
    this.coreHome = coreHome;
    this.defaultDir = defaultDir || (() => undefined);
    this.win = null;
    this.ready = false;
    this.projectId = null;
    this.seq = 0;
    ipcMain.on('pw-ui', (e, m) => {
      if (!this.win || this.win.isDestroyed() || e.sender !== this.win.webContents || !m || typeof m !== 'object') return;
      this.#fromWindow(m).catch((err) => console.error('project window', err));
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

  #bounds() {
    const saved = this.#readState().bounds;
    if (saved && screen.getAllDisplays().some((d) => saved.x < d.workArea.x + d.workArea.width - 80 && saved.x + saved.width > d.workArea.x + 80 && saved.y >= d.workArea.y - 10 && saved.y < d.workArea.y + d.workArea.height - 80)) return saved;
    const home = this.coreHome?.() || null;
    const d = home ? screen.getDisplayNearestPoint(home) : screen.getPrimaryDisplay();
    const a = d.workArea;
    const width = Math.min(1180, Math.round(a.width * 0.86));
    const height = Math.min(780, Math.round(a.height * 0.86));
    return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
  }

  #ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.ready = false;
    const win = new BrowserWindow({
      ...this.#bounds(),
      minWidth: 760,
      minHeight: 480,
      frame: false,
      backgroundColor: '#050817',
      show: false,
      title: '系统项目',
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'project-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
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
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, 'renderer', 'project.html'));
    return win;
  }

  #send(msg) {
    if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send('pw', msg);
  }

  // 打开某个项目的项目页（已经开着就切过去、挪到最前面）
  show(projectId) {
    const fresh = !this.win || this.win.isDestroyed();
    const win = this.#ensure();
    this.projectId = projectId || this.projectId;
    if (!fresh) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.moveTop();
      this.#send({ type: 'open', projectId: this.projectId });
    }
  }

  get isOpen() {
    return !!(this.win && !this.win.isDestroyed());
  }

  // 大脑发来的：项目事件、卡片（只要这个窗口正看着的那个项目），以及回给这个窗口的请求结果（reqId 以 pw 开头）
  fromBrain(msg) {
    if (!this.isOpen) return;
    if (msg.type === 'project_event' && msg.projectId !== this.projectId) return;
    if (msg.type === 'project_card' && msg.card?.projectId !== this.projectId) return this.#send({ type: 'card_other', card: msg.card });
    this.#send(msg);
  }

  async #fromWindow(m) {
    switch (m.op) {
      case 'ready':
        this.ready = true;
        return this.#send({ type: 'open', projectId: this.projectId });
      case 'snapshot':
        return this.toBrain({ type: 'project_snapshot', projectId: m.projectId || this.projectId, light: !!m.light, reqId: `pw${++this.seq}` });
      case 'list':
        return this.toBrain({ type: 'projects_query', reqId: `pw${++this.seq}` });
      case 'switch':
        this.projectId = m.projectId;
        return this.#send({ type: 'open', projectId: this.projectId });
      case 'action':
        return this.toBrain({ type: 'project_action', projectId: m.projectId || this.projectId, action: m.action, value: m.value, qid: m.qid, reqId: `pw${++this.seq}` });
      case 'pick_folder': {
        const r = await dialog.showOpenDialog(this.win, { properties: ['openDirectory', 'createDirectory'], defaultPath: this.defaultDir() });
        if (r.canceled || !r.filePaths[0]) return;
        return this.toBrain({ type: 'project_action', projectId: m.projectId || this.projectId, action: 'set_dir', value: r.filePaths[0], reqId: `pw${++this.seq}` });
      }
      case 'minimize':
        return this.win.minimize();
      case 'maximize':
        return this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize();
      case 'close':
        return this.win.close();
    }
  }
}

module.exports = { ProjectWindow };
