// 鉴定术（桌面这边）：定格每块屏幕，在定格的画面上选（点窗口 / 拖框 / 整块屏幕），裁图交给大脑，
// 在屏幕上画扫描和【鉴定结果】卡；全屏扫描时给每个窗口挂标签。问模型、存档在 brain/appraise.mjs。
// 每块屏幕一个全屏透明窗口（缩放可能不一样，一个窗口横跨两块屏会错位）。定格的整屏截图只留在内存里，关掉就扔。
const { BrowserWindow, screen, desktopCapturer, ipcMain, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 聊天、邮件软件：全屏扫描时只标名字、涂黑不发
const CHAT_APPS = /^(wechat|weixin|wechatappex|qq|qqnt|tim|dingtalk|feishu|lark|telegram|discord|whatsapp|line|skype|slack|teams|ms-teams|wxwork|wecom|outlook|olk|foxmail|thunderbird|mailmaster|kakaotalk)\.exe$/i;
// 常见软件的中文名（聊天软件的标题不发、不显示，就靠这个认）
const APP_NAMES = { wechat: '微信', weixin: '微信', wechatappex: '微信', qq: 'QQ', qqnt: 'QQ', tim: 'TIM', dingtalk: '钉钉', feishu: '飞书', lark: '飞书', wxwork: '企业微信', wecom: '企业微信', telegram: 'Telegram', discord: 'Discord', whatsapp: 'WhatsApp', outlook: 'Outlook', olk: 'Outlook', foxmail: 'Foxmail', mailmaster: '网易邮箱大师', thunderbird: 'Thunderbird', skype: 'Skype', slack: 'Slack', teams: 'Teams', 'ms-teams': 'Teams', kakaotalk: 'KakaoTalk', line: 'LINE' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const d = Math.min(a.y + a.height, b.y + b.height);
  return r > x && d > y ? { x, y, width: r - x, height: d - y } : null;
}

// 在 NativeImage 上把几块涂黑（BGRA 位图直接改，不透明的黑）
const BLACK = Buffer.from([0, 0, 0, 255]);
function blackout(img, rects) {
  if (!rects.length) return img;
  const { width, height } = img.getSize();
  const buf = img.toBitmap();
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y1 = Math.min(height, Math.ceil(r.y + r.height));
    if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) buf.fill(BLACK, (y * width + x0) * 4, (y * width + x1) * 4);
  }
  return nativeImage.createFromBitmap(buf, { width, height });
}
function fit(img, max) {
  const { width, height } = img.getSize();
  const k = Math.min(1, max / Math.max(width, height));
  return k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img;
}

class Appraiser {
  // toBrain(msg)；hide() → 截图时要藏起来的窗口（面板）；fx 效果层；blocked() 禁止操作的软件名单；log(…)
  // 测试时可以换掉：win32（查窗口）、freeze（假的定格画面）、cursorDisplay（鼠标在哪块屏幕）、focusOnSelect（选的时候抢不抢焦点）
  constructor({ root, toBrain, hide = () => [], fx = null, blocked = () => [], log = () => {}, win32 = null, freeze = null, cursorDisplay = null, focusOnSelect = true }) {
    Object.assign(this, { root, toBrain, hide, fx, blocked, log, focusOnSelect });
    this.w32 = win32;
    this.freezeImpl = freeze;
    this.cursorDisplay = cursorDisplay || (() => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
    this.wins = new Map(); // 屏幕 id → { win, ready, queue }
    this.s = null; // 这一次鉴定：{ id, stage, shots, windows, prevFg, cardDisplay }
    this.busy = false;
    ipcMain.on('appraise-ui', (e, m) => this.#fromUi(e.sender, m).catch((err) => this.log('appraise ui failed', err)));
    screen.on('display-removed', (_e, d) => {
      const w = this.wins.get(d.id);
      if (w && !w.win.isDestroyed()) w.win.destroy();
      this.wins.delete(d.id);
    });
  }

  get active() {
    return !!this.s;
  }

  async #win32() {
    this.w32 ||= await import(pathToFileURL(path.join(this.root, 'brain', 'win32.mjs')).href);
    return this.w32;
  }

  // ---- 每块屏幕一个窗口 ----
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
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
      webPreferences: { preload: path.join(__dirname, 'appraise-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    s = { win, ready: false, queue: [], display };
    this.wins.set(display.id, s);
    win.webContents.once('did-finish-load', () => {
      s.ready = true;
      for (const m of s.queue.splice(0)) win.webContents.send('appraise', m);
    });
    win.loadFile(path.join(__dirname, 'renderer', 'appraise.html'));
    return s;
  }
  #send(displayId, msg) {
    const s = this.wins.get(displayId);
    if (!s || s.win.isDestroyed()) return;
    if (s.ready) s.win.webContents.send('appraise', msg);
    else s.queue.push(msg);
  }
  #displayOf(sender) {
    for (const [id, s] of this.wins) if (!s.win.isDestroyed() && s.win.webContents === sender) return id;
    return null;
  }
  #hideAll(except = null) {
    for (const [id, s] of this.wins) {
      if (id === except || s.win.isDestroyed()) continue;
      this.#send(id, { stage: 'idle' });
      s.win.hide();
    }
  }

  // ---- 开始：定格每块屏幕 ----
  // mode：select 进选择；window 直接鉴定宿主正在用的窗口；screen 直接扫描全屏
  async start(mode = 'select') {
    if (this.busy) return;
    if (this.s?.stage === 'select' && mode === 'select') return this.close('cancel'); // 再按一次快捷键 = 退出
    if (this.s) this.close('replace');
    this.busy = true;
    try {
      const w32 = await this.#win32();
      const prevFg = w32.foreground();
      const shots = await this.#freeze();
      const windows = this.#windows(w32);
      this.s = { id: newId(), stage: 'select', shots, windows, prevFg, sent: new Set() };
      this.toBrain({ type: 'appraise_state', open: true });
      if (mode === 'screen') return this.#scan();
      if (mode === 'window') {
        const own = w32.pidOf(prevFg) === process.pid;
        const h = own ? w32.topWindow([process.pid]) : prevFg;
        const w = windows.find((x) => x.hwnd === h) || windows[0];
        if (!w) return this.#fail('没找到能鉴定的窗口');
        return this.#pick(this.#displayOfRect(screen.screenToDipRect(null, w.rect)), { kind: 'window', windowId: w.id });
      }
      // 选择：每块屏幕铺上定格的画面
      for (const shot of shots.values()) {
        const d = shot.display;
        const s = this.#ensure(d);
        s.win.setBounds(d.bounds);
        s.win.setIgnoreMouseEvents(false);
        this.#send(d.id, { stage: 'select', image: shot.img.toDataURL(), windows: this.#localWindows(d), scale: d.scaleFactor });
        this.s.sent.add(d.id);
        if (this.focusOnSelect) s.win.show();
        else s.win.showInactive();
      }
      const s = this.wins.get(this.#cursorShot());
      if (s && this.focusOnSelect) s.win.focus();
      this.log(`appraise: 选择（${shots.size} 块屏幕，${windows.length} 个窗口）`);
    } catch (e) {
      this.log('appraise start failed', e);
      this.#fail(`进不了鉴定模式：${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  // 鼠标所在的那块屏幕（不在定格的屏幕里就用第一块）
  #cursorShot() {
    const id = this.cursorDisplay();
    return this.s?.shots.has(id) ? id : this.s?.shots.keys().next().value;
  }
  // 一个矩形（DIP）落在哪块屏幕上：重叠最多的那块
  #displayOfRect(dip) {
    let best = null;
    let area = -1;
    for (const [id, shot] of this.s.shots) {
      const r = intersect(dip, shot.display.bounds);
      const a = r ? r.width * r.height : 0;
      if (a > area) [best, area] = [id, a];
    }
    return best;
  }

  // 每块屏幕截一张（截的时候藏起面板和效果层）
  async #freeze() {
    if (this.freezeImpl) return this.freezeImpl();
    const hide = this.hide().filter((w) => w && !w.isDestroyed());
    for (const w of hide) w.setOpacity(0);
    this.fx?.setOpacity(0);
    for (const s of this.wins.values()) if (!s.win.isDestroyed()) s.win.hide();
    await wait(120);
    try {
      const displays = screen.getAllDisplays();
      const phys = displays.map((d) => ({ d, p: screen.dipToScreenRect(null, d.bounds) }));
      const size = { width: Math.max(...phys.map((x) => x.p.width)), height: Math.max(...phys.map((x) => x.p.height)) };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      const shots = new Map();
      for (const { d, p } of phys) {
        const src = sources.find((x) => x.display_id === String(d.id)) || (displays.length === 1 ? sources[0] : null);
        if (!src) continue;
        shots.set(d.id, { display: d, phys: p, img: src.thumbnail });
      }
      if (!shots.size) throw new Error('没拿到屏幕画面');
      return shots;
    } finally {
      for (const w of hide) if (!w.isDestroyed()) w.setOpacity(1);
      this.fx?.setOpacity(1);
    }
  }

  // 宿主看得见的窗口（从上往下），屏幕物理像素
  #windows(w32) {
    const names = w32.processMap();
    const blocked = (this.blocked() || []).map((b) => String(b).toLowerCase()).filter(Boolean);
    return w32.userWindows([process.pid]).slice(0, 60).map((hwnd, i) => {
      const title = w32.title(hwnd);
      const exe = names.get(w32.pidOf(hwnd)) || '';
      const low = `${title} ${exe}`.toLowerCase();
      return { id: `w${i + 1}`, hwnd, title, exe, rect: w32.rectOf(hwnd), z: i, chat: CHAT_APPS.test(exe), blocked: blocked.some((b) => low.includes(b)) };
    });
  }
  // 某块屏幕上的窗口，换成这块屏幕里的 DIP 坐标（给选择层用）
  #localWindows(d) {
    const out = [];
    for (const w of this.s.windows) {
      const dip = screen.screenToDipRect(null, w.rect);
      const r = intersect(dip, d.bounds);
      if (!r || r.width < 40 || r.height < 30) continue;
      out.push({ id: w.id, title: w.title, exe: w.exe, blocked: w.blocked, chat: w.chat, rect: { x: r.x - d.bounds.x, y: r.y - d.bounds.y, width: r.width, height: r.height } });
    }
    return out;
  }

  // 屏幕里的 DIP 矩形 → 定格截图上的像素矩形
  #toShot(shot, local) {
    const d = shot.display;
    const g = screen.dipToScreenRect(null, { x: local.x + d.bounds.x, y: local.y + d.bounds.y, width: local.width, height: local.height });
    const { width: tw, height: th } = shot.img.getSize();
    const k = tw / shot.phys.width;
    const x = Math.max(0, Math.round((g.x - shot.phys.x) * k));
    const y = Math.max(0, Math.round((g.y - shot.phys.y) * k));
    return { x, y, width: Math.min(tw - x, Math.round(g.width * k)), height: Math.min(th - y, Math.round(g.height * k)) };
  }
  // 窗口（物理像素）→ 定格截图上的像素矩形
  #winOnShot(shot, w) {
    const dip = screen.screenToDipRect(null, w.rect);
    const r = intersect(dip, shot.display.bounds);
    if (!r) return null;
    return this.#toShot(shot, { x: r.x - shot.display.bounds.x, y: r.y - shot.display.bounds.y, width: r.width, height: r.height });
  }

  // ---- 选好了：裁图、涂黑禁止操作的软件、交给大脑 ----
  // sel：{ kind: region | window | display, rect（屏幕里的 DIP）, windowId, question }
  async #pick(displayId, sel) {
    const s = this.s;
    const shot = s?.shots.get(displayId);
    if (!shot) return;
    const d = shot.display;
    let local = sel.rect;
    let label = '';
    let win = null;
    if (sel.kind === 'window') {
      win = s.windows.find((w) => w.id === sel.windowId);
      if (!win) return;
      if (win.blocked) return this.#errorCard(displayId, null, '这个软件在禁止操作的名单里，系统不看、不鉴定。');
      const dip = screen.screenToDipRect(null, win.rect);
      const r = intersect(dip, d.bounds);
      if (!r) return;
      local = { x: r.x - d.bounds.x, y: r.y - d.bounds.y, width: r.width, height: r.height };
      label = win.title || win.exe;
    } else if (sel.kind === 'display') {
      local = { x: 0, y: 0, width: d.bounds.width, height: d.bounds.height };
      label = '整块屏幕';
    }
    if (!local || local.width < 8 || local.height < 8) return;
    const px = this.#toShot(shot, local);
    let img = shot.img.crop(px);
    // 框里压着禁止操作的软件：那几块涂黑再发
    const masks = [];
    for (const w of s.windows) {
      if (!w.blocked) continue;
      const r = this.#winOnShot(shot, w);
      const hit = r && intersect(r, px);
      if (hit) masks.push({ x: hit.x - px.x, y: hit.y - px.y, width: hit.width, height: hit.height });
    }
    img = blackout(img, masks);
    const big = fit(img, 1600);
    const small = fit(img, 360);
    const id = newId();
    s.id = id;
    s.stage = 'card';
    s.cardDisplay = displayId;
    // 别的屏幕收起来；这块屏幕只留框住的那一块定格画面，扫描、出卡
    this.#hideAll(displayId);
    const ow = this.#ensure(d);
    ow.win.setIgnoreMouseEvents(true, { forward: true });
    // 框住的那块要接着显示定格的画面：这块屏幕的窗口还没拿到画面就补发
    if (!s.sent.has(displayId)) {
      this.#send(displayId, { stage: 'image', image: shot.img.toDataURL() });
      s.sent.add(displayId);
    }
    if (!ow.win.isVisible()) {
      ow.win.setBounds(d.bounds);
      ow.win.showInactive();
    }
    this.#send(displayId, { stage: 'scan', id, rect: local, label: sel.kind === 'window' ? label : '', actions: win ? ['annotate'] : [] });
    this.#restoreFocus();
    const big64 = big.toJPEG(85).toString('base64');
    const { width, height } = big.getSize();
    this.toBrain({
      type: 'appraise_req',
      id,
      kind: sel.kind,
      label,
      app: win ? { title: win.title, exe: win.exe } : null,
      question: String(sel.question || '').slice(0, 200),
      image: { data: big64, mimeType: 'image/jpeg', width, height },
      thumb: small.toJPEG(72).toString('base64'),
      masked: masks.length,
    });
    this.log(`appraise: ${sel.kind} ${width}×${height}${masks.length ? `（涂黑 ${masks.length} 块）` : ''}`);
  }

  // ---- 全屏扫描：每块屏幕一张（禁止操作的、聊天软件涂黑），每个窗口挂一句 ----
  async #scan() {
    const s = this.s;
    s.stage = 'tags';
    const screens = [];
    let n = 0;
    for (const shot of s.shots.values()) {
      const d = shot.display;
      const img0 = fit(shot.img, 1600);
      const k = img0.getSize().width / shot.img.getSize().width;
      const masks = [];
      const list = [];
      // 被上面的窗口整个挡住的不挂标签（标题栏和中间都被挡住）
      const locals = this.#localWindows(d);
      const covered = (p, i) => locals.slice(0, i).some((u) => p.x >= u.rect.x && p.y >= u.rect.y && p.x <= u.rect.x + u.rect.width && p.y <= u.rect.y + u.rect.height);
      const shown = locals.filter((w, i) => !(covered({ x: w.rect.x + 40, y: w.rect.y + 12 }, i) && covered({ x: w.rect.x + w.rect.width / 2, y: w.rect.y + w.rect.height / 2 }, i)));
      for (const w of shown) {
        const full = s.windows.find((x) => x.id === w.id);
        const r = this.#winOnShot(shot, full);
        if (!r) continue;
        const rr = { x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.width * k), height: Math.round(r.height * k) };
        const masked = full.blocked || full.chat;
        if (masked) masks.push(rr);
        list.push({ id: w.id, exe: w.exe, title: masked ? '' : w.title, rect: rr, masked, local: w.rect, kind: full.blocked ? 'block' : full.chat ? 'priv' : '' });
      }
      const img = blackout(img0, masks);
      const { width, height } = img.getSize();
      screens.push({ id: d.id, image: { data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg', width, height }, windows: list.slice(0, 14) });
      for (const w of list.slice(0, 14)) (s.scanned ||= new Set()).add(w.id);
      n += Math.min(14, list.length);
      // 屏幕上：扫描线扫过去，先挂上不用问模型的标签（聊天软件、禁止操作的）
      const ow = this.#ensure(d);
      ow.win.setBounds(d.bounds);
      ow.win.setIgnoreMouseEvents(true, { forward: true });
      this.#send(d.id, {
        stage: 'tags',
        id: s.id,
        windows: list.slice(0, 14).map((w) => ({ id: w.id, rect: w.local, name: this.#appName(w), kind: w.kind, label: w.kind === 'block' ? '禁止操作，已涂黑' : w.kind === 'priv' ? '聊天内容不读' : '' })),
      });
      ow.win.showInactive();
    }
    this.#restoreFocus();
    s.summaryDisplay = this.#cursorShot();
    this.toBrain({ type: 'appraise_scan_req', id: s.id, screens: screens.map(({ id, image, windows }) => ({ id: String(id), image, windows: windows.map(({ local, kind, ...w }) => w) })), count: n });
    this.log(`appraise: 全屏扫描（${screens.length} 块屏幕，${n} 个窗口）`);
  }
  #appName(w) {
    const exe = String(w.exe || '').replace(/\.exe$/i, '');
    if (APP_NAMES[exe.toLowerCase()]) return APP_NAMES[exe.toLowerCase()];
    const t = String(w.title || '').split(/ [-–—|] /).pop();
    return (t && t.length <= 16 ? t : exe) || exe || '窗口';
  }

  // ---- 大脑发来的 ----
  fromBrain(m) {
    const s = this.s;
    switch (m.type) {
      case 'appraise_start':
        return this.start(m.mode || 'select');
      case 'appraise_close':
        return this.close('voice');
      case 'appraise_part':
      case 'appraise_result':
        if (!s || s.id !== m.id) return;
        return this.#send(s.cardDisplay, { stage: m.type === 'appraise_part' ? 'part' : 'result', ...m });
      case 'appraise_tag': {
        if (!s || s.id !== m.id) return;
        for (const [id] of s.shots) this.#send(id, { stage: 'tag', windowId: m.windowId, label: m.label });
        return;
      }
      case 'appraise_scan_done': {
        if (!s || s.id !== m.id) return;
        const seen = s.windows.filter((w) => s.scanned?.has(w.id));
        const names = seen.filter((w) => !w.blocked && !w.chat).map((w) => this.#appName(w));
        const masked = seen.filter((w) => w.blocked || w.chat).map((w) => `${this.#appName(w)}（${w.blocked ? '禁止操作' : '聊天内容不读'}）`);
        return this.#send(s.summaryDisplay, { stage: 'summary', ...m, names: [...new Set(names)].slice(0, 8), masked: [...new Set(masked)] });
      }
    }
  }

  // ---- 选择层、卡片发来的 ----
  async #fromUi(sender, m) {
    const displayId = this.#displayOf(sender);
    const s = this.wins.get(displayId);
    switch (m.op) {
      case 'hit':
        if (s && this.s?.stage !== 'select') s.win.setIgnoreMouseEvents(!m.on, { forward: true });
        return;
      case 'pick':
        if (this.s?.stage !== 'select') return;
        return this.#pick(displayId, m);
      case 'key':
        if (this.s?.stage !== 'select') return;
        if (m.key === 'scan') return this.#scan();
        // F：鉴定鼠标所在的那块屏幕
        return this.#pick(this.#cursorShot() ?? displayId, { kind: 'display' });
      case 'tag': {
        // 扫描完点了某个窗口的标签：鉴定那个窗口
        if (this.s?.stage !== 'tags') return;
        const w = this.s.windows.find((x) => x.id === m.windowId);
        if (!w || w.blocked || w.chat) return;
        this.s.stage = 'select';
        return this.#pick(displayId, { kind: 'window', windowId: w.id });
      }
      case 'cancel':
      case 'close':
        return this.close(m.op);
      case 'copy':
        clipboard.writeText(String(m.text || ''));
        return;
      case 'action':
        // 卡片上的「追问」「帮我处理」「在软件上标出来」
        this.toBrain({ type: 'appraise_action', id: m.id, action: m.action });
        if (m.action !== 'followup') this.close('action');
        return;
    }
  }

  close(why = '') {
    if (!this.s && why !== 'force') return;
    const wasSelect = this.s?.stage === 'select';
    const prevFg = this.s?.prevFg;
    this.s = null;
    this.#hideAll();
    this.toBrain({ type: 'appraise_state', open: false, why });
    if (wasSelect && (why === 'cancel' || why === 'replace')) this.#restoreFocus(prevFg);
  }

  #fail(text) {
    this.close('fail');
    this.toBrain({ type: 'appraise_failed', error: text });
  }
  #errorCard(displayId, id, text) {
    this.s.stage = 'card';
    this.s.cardDisplay = displayId;
    this.#hideAll(displayId);
    const ow = this.wins.get(displayId);
    ow?.win.setIgnoreMouseEvents(true, { forward: true });
    this.#send(displayId, { stage: 'result', id, ok: false, error: text });
    this.#restoreFocus();
  }
  // 选完把焦点还给宿主原来在用的窗口
  #restoreFocus(h = this.s?.prevFg) {
    if (!h || !this.w32) return;
    setTimeout(() => {
      try {
        if (this.w32.pidOf(h) !== process.pid) this.w32.giveFocus(h);
      } catch {}
    }, 60);
  }
}

module.exports = { Appraiser, CHAT_APPS, blackout, intersect };
