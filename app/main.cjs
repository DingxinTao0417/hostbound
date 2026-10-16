// 桌面窗口（Electron 主进程）：透明置顶小窗 + 托盘 + 全局快捷键，并负责拉起后台进程（耳朵 + 大脑）
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, shell, desktopCapturer, clipboard } = require('electron');
const { FxLayer } = require('./fx.cjs');
const { captureRect } = require('./capture.cjs');
const { Explainer } = require('./explainer.cjs');
const { Appraiser } = require('./appraise.cjs');
const { ProjectWindow } = require('./project-window.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
let saveConfig = null; // brain/config.mjs 里的，起来后再载入
let DEFAULTS = null;

let win = null;
let tray = null;
let brain = null;
let cfg = null;
let quitting = false;
let wakeEnabled = true;
let restarts = 0;
let speechMode = 'gpu';
let speechState = null;
let fx = null; // 效果层
let petHome = null; // 系统核心中心点（屏幕 DIP 坐标）
let fxHome = null; // 系统光标的起飞点：核心隐去时改成面板靠核心那条边的中点
let takeoverActive = false; // 系统正在接管前台
let injectUntil = 0; // 这之前的鼠标键盘动作是系统自己模拟的，不算宿主
let autoLive = false; // 直播模式是检测到在直播自动打开的（直播结束就自动关；宿主手动开的不动）
let explainer = null; // 讲解窗口（explainer.cjs）
let watchClicks = false; // 手把手教学等宿主去点：这时把宿主点了哪告诉大脑
let appraiser = null; // 鉴定术（appraise.cjs）
let projectWin = null; // 项目页（project-window.cjs）
function uiLog(text) {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.appendFile(path.join(ROOT, 'logs', 'ui.log'), `${new Date().toISOString()} ${text}\n`, () => {});
}

// 托盘里改过的东西（系统声音模式）存在 data/state.json，重启后照旧
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}

if (!app.requestSingleInstanceLock()) app.quit();

function toWindow(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('brain', msg);
}

function toBrain(msg) {
  if (brain && brain.connected) brain.send(msg);
}

function startBrain() {
  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'brain.log'), { flags: 'a' });
  const nodeBin = cfg.nodePath || 'node';
  brain = spawn(nodeBin, [path.join(ROOT, 'brain', 'index.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    env: { ...process.env, HOSTBOUND_SPEECH_MODE: speechMode },
  });
  brain.stderr.pipe(logStream);
  brain.on('message', (msg) => {
    if (msg.type === 'wake_enabled') {
      wakeEnabled = msg.enabled;
      buildTrayMenu();
    }
    if (msg.type === 'speech_state') {
      speechState = msg;
      buildTrayMenu();
    }
    if (msg.type === 'voice_ready' || msg.type === 'brain_ready') restarts = 0;
    // 效果、截图、模拟输入的提醒：主进程自己处理，不进面板
    if (msg.type === 'fx') return cfg.fx?.enabled === false ? undefined : fx?.route(msg);
    if (msg.type === 'capture') return capture(msg);
    if (msg.type === 'injecting') return void (injectUntil = Date.now() + (msg.ms || 400));
    if (msg.type === 'takeover_state') takeoverActive = !!msg.active;
    if (msg.type === 'auto_live') return onAutoLive(msg);
    if (msg.type === 'xw') return explainer?.handle(msg);
    if (msg.type === 'watch_clicks') return void (watchClicks = !!msg.on);
    // 鉴定术：开始、卡片边出边显示、全屏扫描的标签（面板要的 appraise_card 照常发给面板）
    if (/^appraise_(start|close|part|result|tag|scan_done)$/.test(msg.type)) return appraiser?.fromBrain(msg);
    // 项目模式：项目页要的（事件、回给项目页的请求结果）只发给项目页；卡片两边都要
    if (msg.type === 'project_open') return projectWin?.show(msg.projectId);
    if (msg.type === 'project_event') return projectWin?.fromBrain(msg);
    if (String(msg.reqId || '').startsWith('pw')) return projectWin?.fromBrain(msg);
    if (msg.type === 'project_card') projectWin?.fromBrain(msg);
    if (msg.type === 'open_url') return void (/^https?:\/\//i.test(String(msg.url)) && shell.openExternal(String(msg.url)));
    toWindow(msg);
  });
  brain.on('error', (e) => toWindow({ type: 'error', message: `后台进程起不来：${e.message}（需要安装 Node.js 22.19 以上）` }));
  brain.on('exit', (code) => {
    brain = null;
    if (quitting) return;
    restarts++;
    toWindow({ type: 'brain_crashed', code });
    if (restarts <= 5) setTimeout(startBrain, 1500 * restarts);
  });
}

// 窗口铺满系统核心所在那块屏幕的工作区（不盖住任务栏），全透明；核心和面板在里面自由摆放，空白处点击穿透。
// 多块屏幕的缩放可能不一样（比如笔记本 150%、外接屏 100%），一个窗口横跨两块屏会错位发虚，
// 所以窗口只盖一块屏：核心被拖到别的屏幕上时，整个窗口搬过去。
let displayId = null;
function currentDisplay() {
  return screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
}
function fitToScreen() {
  const d = currentDisplay(); // 那块屏拔掉了就回主屏
  displayId = d.id;
  if (win && !win.isDestroyed()) win.setBounds(d.workArea);
}
function moveToDisplay(d) {
  if (d.id === displayId) return false;
  displayId = d.id;
  writeState({ display: d.id });
  fitToScreen();
  return true;
}

function createWindow() {
  displayId = readState().display ?? null;
  const { workArea } = currentDisplay();
  displayId = currentDisplay().id;
  win = new BrowserWindow({
    ...workArea,
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
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.on('did-finish-load', () => win.webContents.setVisualZoomLevelLimits(1, 1));
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, fitToScreen);
}

function sendCmd(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('cmd', cmd);
}

function wakeByHotkey() {
  win.showInactive();
  win.focus();
  sendCmd({ type: 'wake' });
}

// 检测到在直播 / 直播结束（阶段 4）
function onAutoLive({ on, source }) {
  if (on && wakeEnabled) {
    autoLive = true;
    setWake(false);
    fx?.route({ type: 'fx', kind: 'notice', mode: 'toast', tone: 'info', title: '直播模式', text: `检测到在直播（${source}），已关掉语音唤醒` });
  } else if (!on && autoLive) {
    autoLive = false;
    setWake(true);
    fx?.route({ type: 'fx', kind: 'notice', mode: 'toast', tone: 'info', title: '直播模式', text: '直播结束，语音唤醒已恢复' });
  }
}

function setWake(enabled) {
  wakeEnabled = enabled;
  toBrain({ type: 'set_wake', enabled });
  buildTrayMenu();
}

function setSpeech(mode) {
  speechMode = mode;
  writeState({ speechMode: mode });
  toBrain({ type: 'set_speech', mode });
  buildTrayMenu();
}

// 托盘里显示声音引擎现在的情况
function speechNote(engine) {
  const st = speechState?.[engine] || '';
  if (st === 'starting') return '（加载中）';
  if (st.startsWith('down:')) return `（${st.slice(5)}${speechMode === 'gpu' && speechState?.engine === 'cpu' ? '，暂用 CPU' : ''}）`;
  return '';
}

function buildTrayMenu() {
  if (!tray) return;
  const hk = cfg.hotkeys;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `唤醒系统（${hk.wake}）`, click: wakeByHotkey },
      { label: `停止当前任务（${hk.stop}）`, click: () => toBrain({ type: 'stop' }) },
      { label: `鉴定（${hk.appraise || 'Control+Alt+J'}）`, click: () => appraiser?.start('select') },
      { type: 'separator' },
      {
        label: '直播模式（关掉语音唤醒）',
        type: 'checkbox',
        checked: !wakeEnabled,
        click: (item) => {
          autoLive = false;
          setWake(!item.checked);
        },
      },
      {
        label: '系统声音',
        submenu: [
          { label: `显卡 · 音质最好${speechMode === 'gpu' ? speechNote('gpu') : ''}`, type: 'radio', checked: speechMode === 'gpu', click: () => setSpeech('gpu') },
          { label: `CPU · 不占显卡${speechMode === 'cpu' ? speechNote('cpu') : ''}`, type: 'radio', checked: speechMode === 'cpu', click: () => setSpeech('cpu') },
          { label: '静音', type: 'radio', checked: speechMode === 'off', click: () => setSpeech('off') },
        ],
      },
      { label: '换个话题（清空大脑的上下文，以前的对话还在）', click: () => toBrain({ type: 'new_session' }) },
      {
        label: '把系统核心放回主屏幕右下角',
        click: () => {
          moveToDisplay(screen.getPrimaryDisplay());
          sendCmd({ type: 'reset_pos' });
        },
      },
      { type: 'separator' },
      { label: '讲解窗口（最近一页）', click: () => toBrain({ type: 'explain_open' }) },
      { label: '系统任务', click: () => openPage('task') },
      { label: '系统记忆', click: () => openPage('mem') },
      { label: '系统技能', click: () => openPage('skill') },
      { label: '系统项目', click: () => openPage('proj') },
      { label: '设置', click: () => openPage('set') },
      { label: '任务记录', click: () => openPage('rec') },
      { label: '系统日志', click: () => openPage('log') },
      { label: '重启系统', click: () => { app.relaunch(); quit(); } },
      { label: '退出', click: quit },
    ]),
  );
}

// 托盘里点「设置」「任务记录」「系统日志」：展开面板翻到那一页
function openPage(page, sub) {
  win.showInactive();
  win.focus();
  sendCmd({ type: 'nav', page, sub });
}

function openConfig() {
  const file = path.join(ROOT, 'hostbound.config.json');
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(ROOT, 'hostbound.config.example.json'), file);
  shell.openPath(file);
}

function quit() {
  quitting = true;
  toBrain({ type: 'quit' });
  setTimeout(() => {
    if (brain) brain.kill();
    app.quit();
  }, 600);
}

ipcMain.on('to-brain', (_e, msg) => toBrain(msg));
ipcMain.on('hit', (_e, on) => win && win.setIgnoreMouseEvents(!on, { forward: true }));
ipcMain.on('ui-log', (_e, text) => {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.appendFile(path.join(ROOT, 'logs', 'ui.log'), `${new Date().toISOString()} ${text}\n`, () => {});
});
// 看屏幕：截图交给 capture.cjs，结果发回大脑
async function capture(req) {
  try {
    const r = await captureRect({ rect: req.rect, scope: req.scope, label: req.label, fx, hide: [win] });
    toBrain({ type: 'capture_result', id: req.id, ok: true, data: r.data, mimeType: r.mimeType, width: r.width, height: r.height });
  } catch (e) {
    toBrain({ type: 'capture_result', id: req.id, ok: false, error: e.message });
  }
}

// 面板报告系统核心的位置（x/y/w/h）；展开时核心隐去了，另报系统光标的起飞点 cx/cy
ipcMain.on('pet-rect', (_e, r) => {
  if (!win || win.isDestroyed() || !r) return;
  const b = win.getBounds();
  petHome = { x: b.x + r.x + r.w / 2, y: b.y + r.y + r.h / 2 };
  fxHome = { x: b.x + (r.cx ?? r.x + r.w / 2), y: b.y + (r.cy ?? r.y + r.h / 2) };
});

// 拖核心或拖标题牌时鼠标出了窗口：鼠标到了别的屏幕上，就把窗口搬过去（还在本屏的任务栏上就不动）
ipcMain.on('drag-edge', () => {
  if (!win || win.isDestroyed()) return;
  moveToDisplay(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
});
ipcMain.on('focus', () => win && win.focus());
ipcMain.on('copy-text', (_e, text) => clipboard.writeText(String(text || '')));
// 全局快捷键要做的事
const HOTKEY_ACTIONS = {
  wake: () => wakeByHotkey(),
  stop: () => toBrain({ type: 'stop' }),
  appraise: () => appraiser?.start('select'),
};
ipcMain.on('blur', () => win && win.blur());
// ---- 设置页 ----
// 能在设置页里改的项（别的项还得手改配置文件）
const SETTING_KEYS = new Set([
  'voice.wakeWords', 'voice.kwsThreshold', 'voice.endSilence', 'voice.mic', 'voice.listenTimeoutMs',
  'conversation.enabled', 'conversation.windowMs', 'conversation.filter', 'conversation.contextBudget',
  'voiceConfirm', 'model', 'model.thinking', 'workdir', 'timezone',
  'computerUse.enabled', 'browser.enabled', 'browser.headed', 'fx.cursor', 'fx.notice',
  'safety.blockedApps', 'speech.fx', 'speech.volume', 'speech.maxChars', 'speech.headphones',
  'hotkeys.wake', 'hotkeys.stop', 'hotkeys.appraise', 'hotkeys.pushToTalk', 'ui.panelOpacity', 'ui.petSize', 'ui.sound', 'ui.boot',
  'watch.downloads', 'watch.downloadsDir', 'watch.battery', 'watch.live', 'watch.liveApps',
  'memory.enabled', 'memory.autoReview', 'memory.embed.chat',
  'skills.enabled', 'skills.suggest',
  'explain.selfCheck', 'explain.model',
  'projects.root', 'projects.commanderModel', 'projects.workerEngine', 'projects.workerModel', 'projects.maxConcurrent', 'projects.budget', 'projects.maxTurns', 'projects.autoAllow',
]);
const pick = (o, key) => key.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function settingsSnapshot() {
  const values = {};
  for (const k of SETTING_KEYS) values[k] = pick(cfg, k);
  return {
    values,
    defaults: Object.fromEntries([...SETTING_KEYS].map((k) => [k, pick(DEFAULTS, k)])),
    speechMode,
    live: !wakeEnabled,
    onboarded: !!readState().onboarded,
    version: require(path.join(ROOT, 'package.json')).version,
    dataDir: DATA,
  };
}
ipcMain.handle('settings:get', () => settingsSnapshot());
ipcMain.handle('settings:set', async (_e, { key, value, label }) => {
  try {
    // 不写配置文件的两项：声音模式（托盘里也能切，存在 data/state.json）、直播模式（开关语音唤醒）
    if (key === 'speech.mode') {
      setSpeech(value);
      return { ok: true };
    }
    if (key === 'live') {
      autoLive = false;
      setWake(!value);
      return { ok: true };
    }
    if (!SETTING_KEYS.has(key)) return { ok: false, error: `这一项不能在设置页里改：${key}` };
    // 快捷键先试着注册，注册不上（被别的软件占了）就不改
    if (key === 'hotkeys.wake' || key === 'hotkeys.stop' || key === 'hotkeys.appraise') {
      const name = key.slice(8);
      const old = cfg.hotkeys[name];
      if (old) globalShortcut.unregister(old);
      const ok = globalShortcut.register(value, HOTKEY_ACTIONS[name]);
      if (!ok) {
        if (old) globalShortcut.register(old, HOTKEY_ACTIONS[name]);
        return { ok: false, error: `${value} 被别的软件占用了，换一个试试` };
      }
    }
    cfg = { ...saveConfig(ROOT, key, value), nodePath: cfg.nodePath };
    if (key.startsWith('hotkeys.')) buildTrayMenu();
    if (key === 'hotkeys.pushToTalk') setPushToTalk(value);
    // 面板自己用的（透明度、提示音、声音音效）直接告诉面板；其余交给后台
    if (key.startsWith('ui.') || key === 'speech.fx' || key === 'speech.volume') toWindow({ type: 'ui_config', key, value });
    if (!key.startsWith('ui.') && !key.startsWith('hotkeys.')) toBrain({ type: 'config', key, value, label });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.on('onboarded', () => writeState({ onboarded: true }));
// 密钥（硅基流动）：宿主在设置页里自己粘，存在 data/secrets.json（开源时不上传）。只写不读：面板只拿得到「配没配」
const SECRETS_FILE = path.join(DATA, 'secrets.json');
const SECRET_NAMES = { siliconflow: 'SILICONFLOW_API_KEY' };
function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
ipcMain.handle('secret:status', () => Object.fromEntries(Object.entries(SECRET_NAMES).map(([k, env]) => [k, readSecrets()[k] ? 'file' : process.env[env] ? 'env' : null])));
ipcMain.handle('secret:set', (_e, { name, value }) => {
  if (!SECRET_NAMES[name]) return { ok: false, error: '不认识的密钥' };
  const v = String(value || '').trim();
  if (v && (v.length < 8 || /\s/.test(v))) return { ok: false, error: '看起来不像密钥' };
  const all = readSecrets();
  if (v) all[name] = v;
  else delete all[name];
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2));
  toBrain({ type: 'secrets_changed' });
  return { ok: true };
});
ipcMain.on('open-path', (_e, which) => {
  if (which === 'data') shell.openPath(DATA);
  if (which === 'config') openConfig();
  if (which === 'logs') shell.openPath(path.join(ROOT, 'logs'));
  if (which === 'browser-profile') shell.openPath(path.resolve(ROOT, cfg.browser?.profile || 'browser-profile'));
});
ipcMain.on('relaunch', () => {
  app.relaunch();
  quit();
});
ipcMain.handle('pick-folder', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: cfg.workdir });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('config', () => ({
  sleepAfterMs: cfg.sleepAfterMs,
  hotkeys: cfg.hotkeys,
  wakeWords: cfg.voice.wakeWords.map((w) => w.text),
  ui: cfg.ui,
  speech: { fx: cfg.speech.fx, volume: cfg.speech.volume },
  onboarded: !!readState().onboarded,
}));

// ---- 全局键鼠监听 ----
// 1. 按住说话：按下和松开（Electron 自带的快捷键只知道按下）。键盘上的键按住期间又按了别的键（比如 Ctrl+C），是在用快捷键，这次不算
// 2. 宿主在不在忙：按键、点鼠标、滚轮时告诉大脑（系统新开的窗口抢了焦点时，宿主在忙才把焦点还回去）
// 3. 接管前台期间：宿主一动鼠标或按 Esc，告诉大脑立刻停手（系统自己模拟的输入不算）
let setPushToTalk = () => {};
function startInputHook() {
  let hook;
  try {
    hook = require('uiohook-napi');
  } catch (e) {
    toWindow({ type: 'notice', text: `按住说话不可用：${e.message}` });
    return;
  }
  const { uIOhook, UiohookKey } = hook;
  const ALIAS = { RightCtrl: 'CtrlRight', RightAlt: 'AltRight', RightShift: 'ShiftRight', LeftCtrl: 'Ctrl', LeftAlt: 'Alt', LeftShift: 'Shift' };
  const keys = new Set();
  const buttons = new Set();
  setPushToTalk = (list) => {
    keys.clear();
    buttons.clear();
    for (const name of [].concat(list || [])) {
      const m = /^mouse([1-5])$/i.exec(name);
      if (m) buttons.add(Number(m[1]));
      else if (UiohookKey[ALIAS[name] || name] != null) keys.add(UiohookKey[ALIAS[name] || name]);
      else toWindow({ type: 'notice', text: `按住说话的键名「${name}」不认识，已忽略。` });
    }
  };
  setPushToTalk(cfg.hotkeys.pushToTalk);
  let held = null; // 'key' | 'mouse'
  let lastSent = 0;
  const busy = () => {
    if (Date.now() < injectUntil) return;
    const now = Date.now();
    if (now - lastSent < 500) return;
    lastSent = now;
    toBrain({ type: 'user_input', at: now });
  };
  let lastTakeback = 0;
  const takeback = () => {
    if (!takeoverActive || Date.now() < injectUntil || Date.now() - lastTakeback < 1000) return;
    lastTakeback = Date.now();
    toBrain({ type: 'user_takeback' });
  };
  const down = (kind) => {
    if (held) return;
    held = kind;
    toBrain({ type: 'ptt', state: 'down' });
  };
  const up = (state = 'up') => {
    if (!held) return;
    held = null;
    toBrain({ type: 'ptt', state });
  };
  uIOhook.on('keydown', (e) => {
    busy();
    if (e.keycode === UiohookKey.Escape) takeback();
    if (keys.has(e.keycode)) return down('key');
    if (held === 'key') up('cancel');
  });
  uIOhook.on('keyup', (e) => {
    if (keys.has(e.keycode) && held === 'key') up();
  });
  uIOhook.on('mousemove', takeback);
  uIOhook.on('wheel', busy);
  uIOhook.on('mousedown', (e) => {
    busy();
    takeback();
    // 手把手教学：宿主点了哪（屏幕物理像素，跟大脑读到的软件界面一个坐标系）。系统自己模拟的点击不算
    if (watchClicks && e.button === 1 && Date.now() >= injectUntil) toBrain({ type: 'host_click', x: e.x, y: e.y });
    if (buttons.has(e.button)) return down('mouse');
    if (held === 'key') up('cancel'); // 按着 Ctrl 点鼠标：是 Ctrl+点击，不是按住说话
  });
  uIOhook.on('mouseup', (e) => {
    if (buttons.has(e.button) && held === 'mouse') up();
  });
  try {
    uIOhook.start();
  } catch (e) {
    toWindow({ type: 'notice', text: `按住说话不可用：${e.message}` });
  }
  app.on('will-quit', () => {
    try {
      uIOhook.stop();
    } catch {}
  });
}

app.whenReady().then(async () => {
  // 桌面、下载文件夹可能被 OneDrive 挪到别处（比如 OneDrive\桌面）：用系统登记的真实位置，后台进程从环境变量拿
  process.env.HOSTBOUND_DESKTOP ||= app.getPath('desktop');
  process.env.HOSTBOUND_DOWNLOADS ||= app.getPath('downloads');
  const conf = await import(pathToFileURL(path.join(ROOT, 'brain', 'config.mjs')).href);
  ({ saveConfig, DEFAULTS } = conf);
  cfg = conf.loadConfig(ROOT);
  const st = readState();
  if (st.onboarded == null && (st.speechMode || st.display != null)) writeState({ onboarded: true });
  wakeEnabled = cfg.voice.wakeEnabled !== false;
  speechMode = readState().speechMode || cfg.speech.mode;

  createWindow();
  fx = new FxLayer({ coreDisplay: () => currentDisplay(), coreHome: () => petHome, cursorHome: () => fxHome });
  explainer = new Explainer({ root: ROOT, dataDir: DATA, toBrain, coreHome: () => petHome });
  projectWin = new ProjectWindow({ dataDir: DATA, toBrain, coreHome: () => petHome, defaultDir: () => cfg.projects?.root || path.join(require('node:os').homedir(), 'HostboundProjects') });
  appraiser = new Appraiser({ root: ROOT, toBrain, hide: () => [win], fx, blocked: () => cfg.safety?.blockedApps || [], log: (...a) => uiLog(a.map(String).join(' ')) });
  startBrain();

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip("Hostbound · 宿主系统");
  tray.on('click', wakeByHotkey);
  buildTrayMenu();

  const ok1 = globalShortcut.register(cfg.hotkeys.wake, wakeByHotkey);
  const ok2 = globalShortcut.register(cfg.hotkeys.stop, () => {
    toBrain({ type: 'stop' });
  });
  const ok3 = !cfg.hotkeys.appraise || globalShortcut.register(cfg.hotkeys.appraise, HOTKEY_ACTIONS.appraise);
  if (!ok1 || !ok2 || !ok3) toWindow({ type: 'notice', text: '有快捷键被别的软件占用了，可以在设置 · 快捷键里换一个。' });
  startInputHook();
});

// 自检用：HOSTBOUND_SNAPSHOT=目录 时，截一张睡觉的、一张叫醒后的窗口图，然后退出
async function selfTest(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 截系统核心和面板所在的那一块（核心可能被拖到了任何位置）
  const shot = async (name) => {
    const r = JSON.parse(
      await win.webContents.executeJavaScript(`(() => {
        const rs = [document.querySelector('#pet'), document.querySelector('#bubble')].map((e) => e.getBoundingClientRect());
        const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
        const x2 = Math.max(...rs.map((r) => r.right)), y2 = Math.max(...rs.map((r) => r.bottom));
        return JSON.stringify({ x: Math.max(0, Math.floor(x - 20)), y: Math.max(0, Math.floor(y - 20)), width: Math.ceil(x2 - x + 40), height: Math.ceil(y2 - y + 40) });
      })()`),
    );
    const [w, h] = win.getContentSize();
    r.width = Math.min(r.width, w - r.x);
    r.height = Math.min(r.height, h - r.y);
    fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage(r)).toPNG());
  };
  await wait(4000);
  await shot('1-sleep.png');
  sendCmd({ type: 'wake' });
  await wait(2500);
  await shot('2-awake.png');
  // 不说话，等“没听到”超时（7 秒）以后再截一张
  await wait(9000);
  await shot('3-after-timeout.png');
  // 发声：等声音引擎就绪（显卡模型第一次加载要十几秒），念一句，记下有没有真的出声
  let voice = { skipped: speechMode === 'off' };
  if (speechMode !== 'off') {
    for (let i = 0; i < 60 && !speechState?.engine; i++) await wait(1000);
    await win.webContents.executeJavaScript(`window.__vmax = 0; window.__vplayed = false; (function t() { if (Speech.playing) { window.__vplayed = true; window.__vmax = Math.max(window.__vmax, Speech.level()); } requestAnimationFrame(t); })(); 0`);
    toBrain({ type: 'speak', text: '系统自检：发声模块正常。' });
    await wait(1800);
    await shot('4-speaking.png');
    await wait(3500);
    voice = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({ engine: ${JSON.stringify(speechState?.engine || null)}, played: window.__vplayed, maxLevel: +window.__vmax.toFixed(3) })`));
  }
  // HOSTBOUND_SNAPSHOT_PROMPT：再打一句指令（走真实模型），回复念的过程中连拍几张，看文字是不是跟着声音出现
  const prompt = process.env.HOSTBOUND_SNAPSHOT_PROMPT;
  if (prompt) {
    await win.webContents.executeJavaScript(`document.querySelector('#input').value = ${JSON.stringify(prompt)}; document.querySelector('#ask').requestSubmit(); 0`);
    // 整块屏幕连拍：看效果层（扫描框、系统光标、通知）有没有对准真实的窗口
    const screens = async (name) => {
      const ds = screen.getAllDisplays();
      const big = Math.max(...ds.map((d) => d.bounds.width * d.scaleFactor));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(big / 2), height: Math.round(big / 2) } });
      sources.forEach((s, i) => fs.writeFileSync(path.join(dir, `${name}-screen${i + 1}.png`), s.thumbnail.toPNG()));
    };
    const until = Date.now() + Number(process.env.HOSTBOUND_SNAPSHOT_SECONDS || 40) * 1000;
    for (let i = 1; Date.now() < until; i++) {
      await wait(2000);
      await screens(`5-run-${String(i).padStart(2, '0')}`);
    }
    await shot('6-reply-done.png');
  }
  // 状态记一下，方便查图片有没有加载出来
  const info = JSON.parse(
    await win.webContents.executeJavaScript(
      `JSON.stringify({ core: document.querySelector('#pet').dataset.state, title: document.querySelector('#title').textContent, pet: document.querySelector('#pet').className })`,
    ),
  );
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...info, voice }));
  quit();
}

app.on('second-instance', wakeByHotkey);
app.whenReady().then(() => {
  if (process.env.HOSTBOUND_SNAPSHOT) setTimeout(() => selfTest(process.env.HOSTBOUND_SNAPSHOT), 500);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {});
