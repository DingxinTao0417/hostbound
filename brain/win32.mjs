// 直接调用 Windows 函数（koffi）：查窗口、守焦点、判断全屏、模拟真实鼠标键盘（只在宿主允许接管前台时用）。
// 所有坐标都是屏幕物理像素（进程设成了 Per-Monitor DPI 感知，跟 Open Computer Use 报的坐标一致）。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

const RECT = koffi.struct('HB_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('HB_POINT', { x: 'long', y: 'long' });
const MONITORINFO = koffi.struct('HB_MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
const MOUSEINPUT = koffi.struct('HB_MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const KEYBDINPUT = koffi.struct('HB_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
const HARDWAREINPUT = koffi.struct('HB_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT = koffi.struct('HB_INPUT', { type: 'uint32', u: koffi.union('HB_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
const EnumProc = koffi.proto('int __stdcall HB_EnumProc(intptr_t hwnd, intptr_t lparam)');

const f = {
  SetProcessDpiAwarenessContext: user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t value)'),
  GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
  GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
  IsWindow: user32.func('int __stdcall IsWindow(intptr_t hwnd)'),
  IsWindowVisible: user32.func('int __stdcall IsWindowVisible(intptr_t hwnd)'),
  IsIconic: user32.func('int __stdcall IsIconic(intptr_t hwnd)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint8_t *buf, int max)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint8_t *buf, int max)'),
  GetWindowRect: user32.func('int __stdcall GetWindowRect(intptr_t hwnd, _Out_ HB_RECT *rect)'),
  GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
  GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)'),
  EnumWindows: user32.func('int __stdcall EnumWindows(HB_EnumProc *cb, intptr_t lparam)'),
  MonitorFromWindow: user32.func('intptr_t __stdcall MonitorFromWindow(intptr_t hwnd, uint32_t flags)'),
  GetMonitorInfoW: user32.func('int __stdcall GetMonitorInfoW(intptr_t monitor, _Inout_ HB_MONITORINFO *info)'),
  SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)'),
  BringWindowToTop: user32.func('int __stdcall BringWindowToTop(intptr_t hwnd)'),
  ShowWindow: user32.func('int __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
  AttachThreadInput: user32.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)'),
  GetCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ HB_POINT *pt)'),
  SetCursorPos: user32.func('int __stdcall SetCursorPos(int x, int y)'),
  SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t count, HB_INPUT *inputs, int size)'),
  MapVirtualKeyW: user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t type)'),
  PostMessageW: user32.func('int __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)'),
  GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
  DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ uint8_t *value, uint32_t size)'),
};

// 坐标按物理像素算（DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4）
f.SetProcessDpiAwarenessContext(-4);

const text = (fn, h) => {
  const buf = Buffer.alloc(1024);
  const n = fn(h, buf, 512);
  return buf.toString('utf16le', 0, n * 2);
};

export const foreground = () => Number(f.GetForegroundWindow());
export const isWindow = (h) => !!h && !!f.IsWindow(h);
export const title = (h) => text(f.GetWindowTextW, h);
export const className = (h) => text(f.GetClassNameW, h);
export function pidOf(h) {
  const pid = [0];
  f.GetWindowThreadProcessId(h, pid);
  return pid[0];
}

// 窗口在屏幕上的样子（不含 Windows 11 的隐形阴影边框）
export function rectOf(h) {
  const buf = Buffer.alloc(16);
  if (f.DwmGetWindowAttribute(h, 9, buf, 16) === 0) {
    // DWMWA_EXTENDED_FRAME_BOUNDS
    const [l, t, r, b] = [0, 4, 8, 12].map((o) => buf.readInt32LE(o));
    return { x: l, y: t, width: r - l, height: b - t };
  }
  const rc = {};
  f.GetWindowRect(h, rc);
  return { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top };
}

// 窗口的完整范围（含 Windows 10/11 左右下的隐形缩放边框）。Open Computer Use 的元素坐标就是相对这个范围左上角的
export function rawRectOf(h) {
  const rc = {};
  f.GetWindowRect(h, rc);
  return { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top };
}

function cloaked(h) {
  const buf = Buffer.alloc(4);
  return f.DwmGetWindowAttribute(h, 14, buf, 4) === 0 && buf.readInt32LE(0) !== 0; // DWMWA_CLOAKED
}

export function monitorOf(h) {
  const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  f.GetMonitorInfoW(f.MonitorFromWindow(h, 2), info); // MONITOR_DEFAULTTONEAREST
  const m = info.rcMonitor;
  return { x: m.left, y: m.top, width: m.right - m.left, height: m.bottom - m.top };
}

const SHELL = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow']);

// 宿主眼里的「一个窗口」：看得见、没最小化、不是工具小窗、有标题、不是桌面和任务栏
export function isUserWindow(h, ownPids = []) {
  if (!f.IsWindowVisible(h) || f.IsIconic(h) || cloaked(h)) return false;
  if (Number(f.GetWindow(h, 4))) return false; // 有主人的弹窗（GW_OWNER）
  if (Number(f.GetWindowLongPtrW(h, -20)) & 0x80) return false; // WS_EX_TOOLWINDOW
  if (SHELL.has(className(h)) || !title(h)) return false;
  if (ownPids.includes(pidOf(h))) return false;
  const r = rectOf(h);
  return r.width >= 120 && r.height >= 80;
}

// 从上往下数，第一个宿主的窗口（跳过 Hostbound 自己）
export function topWindow(ownPids = []) {
  let hit = 0;
  const cb = koffi.register((h) => {
    const hw = Number(h);
    if (isUserWindow(hw, ownPids)) {
      hit = hw;
      return 0;
    }
    return 1;
  }, koffi.pointer(EnumProc));
  try {
    f.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return hit;
}

// 所有宿主看得见的窗口（从上往下）
export function userWindows(ownPids = []) {
  const list = [];
  const cb = koffi.register((h) => {
    const hw = Number(h);
    if (isUserWindow(hw, ownPids)) list.push(hw);
    return 1;
  }, koffi.pointer(EnumProc));
  try {
    f.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return list;
}

// 按标题和大小找窗口：Open Computer Use 报的元素坐标是相对窗口左上角的，要知道窗口在屏幕哪里才能换算
export function findWindow(titleText, size, ownPids = []) {
  let best = null;
  let bestScore = Infinity;
  for (const h of userWindows(ownPids)) {
    const t = title(h);
    if (titleText && t !== titleText && !t.includes(titleText)) continue;
    const r = rawRectOf(h);
    const score = size ? Math.abs(r.width - size.width) + Math.abs(r.height - size.height) + (t === titleText ? 0 : 50) : 0;
    if (score < bestScore) {
      best = h;
      bestScore = score;
    }
  }
  return best;
}

export function describe(h) {
  return h ? { hwnd: h, title: title(h), cls: className(h), pid: pidOf(h), rect: rectOf(h) } : null;
}

// 前台窗口是不是盖满了整块屏幕（游戏、全屏视频、演示）
export function foregroundIsFullscreen(ownPids = []) {
  const h = foreground();
  if (!h || ownPids.includes(pidOf(h)) || SHELL.has(className(h))) return false;
  const r = rectOf(h);
  const m = monitorOf(h);
  return r.x <= m.x && r.y <= m.y && r.x + r.width >= m.x + m.width && r.y + r.height >= m.y + m.height;
}

// 把焦点还给某个窗口。后台进程直接 SetForegroundWindow 会被 Windows 拦住，
// 先把自己的输入线程挂到当前前台窗口的线程上（AttachThreadInput），就允许了
export function giveFocus(h) {
  if (!isWindow(h)) return false;
  const fg = foreground();
  const me = f.GetCurrentThreadId();
  const them = fg ? f.GetWindowThreadProcessId(fg, [0]) : 0;
  const attached = them && them !== me && f.AttachThreadInput(me, them, 1);
  try {
    if (f.IsIconic(h)) f.ShowWindow(h, 9); // SW_RESTORE
    f.BringWindowToTop(h);
    f.SetForegroundWindow(h);
  } finally {
    if (attached) f.AttachThreadInput(me, them, 0);
  }
  return foreground() === h;
}

// 像点右上角 × 一样请窗口关闭（WM_CLOSE），软件自己决定要不要问「是否保存」
export function closeWindow(h) {
  return !!f.PostMessageW(h, 0x10, 0, 0);
}

// ---- 真实鼠标键盘：只在宿主允许接管前台期间使用 ----
export function cursor() {
  const p = {};
  f.GetCursorPos(p);
  return { x: p.x, y: p.y };
}

const INPUT_SIZE = koffi.sizeof(INPUT);
const send = (input) => f.SendInput(1, input, INPUT_SIZE);
const mouse = (flags, data = 0) => send({ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const key = (vk, up, scan = 0, flags = 0) =>
  send({ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags | (up ? 0x2 : 0), time: 0, dwExtraInfo: 0 } } });

const BUTTONS = { left: [0x2, 0x4], right: [0x8, 0x10], middle: [0x20, 0x40] };
export function click(x, y, { button = 'left', double = false } = {}) {
  f.SetCursorPos(Math.round(x), Math.round(y));
  const [down, up] = BUTTONS[button] || BUTTONS.left;
  for (let i = 0; i < (double ? 2 : 1); i++) {
    mouse(down);
    mouse(up);
  }
}

// 逐字输入（KEYEVENTF_UNICODE，中文也行）
export function typeText(s) {
  for (const ch of s) {
    for (let i = 0; i < ch.length; i++) {
      const code = ch.charCodeAt(i);
      key(0, false, code, 0x4);
      key(0, true, code, 0x4);
    }
  }
}

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09,
  space: 0x20, backspace: 0x08, delete: 0x2e, del: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
};
// 组合键：'ctrl+s'、'alt+f4'、'enter'
export function pressKeys(combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const codes = parts.map((p) => VK[p] ?? (/^f\d{1,2}$/.test(p) ? 0x6f + Number(p.slice(1)) : p.length === 1 ? p.toUpperCase().charCodeAt(0) : null));
  if (codes.some((c) => c == null)) throw new Error(`不认识的按键：${combo}`);
  for (const c of codes) key(c, false, f.MapVirtualKeyW(c, 0));
  for (const c of [...codes].reverse()) key(c, true, f.MapVirtualKeyW(c, 0));
}

export const inputStructSize = INPUT_SIZE;

// ---- 阶段 4：正在运行的程序（直播软件开没开、等某个程序退出）、电源状态（电量低提醒） ----
const PROCESSENTRY32W = koffi.struct('HB_PROCESSENTRY32W', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32',
  cntThreads: 'uint32',
  th32ParentProcessID: 'uint32',
  pcPriClassBase: 'int32',
  dwFlags: 'uint32',
  szExeFile: koffi.array('char16_t', 260, 'String'),
});
const POWER = koffi.struct('HB_POWER', { ACLineStatus: 'uint8', BatteryFlag: 'uint8', BatteryLifePercent: 'uint8', SystemStatusFlag: 'uint8', BatteryLifeTime: 'uint32', BatteryFullLifeTime: 'uint32' });
const k = {
  CreateToolhelp32Snapshot: kernel32.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
  Process32FirstW: kernel32.func('int __stdcall Process32FirstW(intptr_t snap, _Inout_ HB_PROCESSENTRY32W *e)'),
  Process32NextW: kernel32.func('int __stdcall Process32NextW(intptr_t snap, _Inout_ HB_PROCESSENTRY32W *e)'),
  CloseHandle: kernel32.func('int __stdcall CloseHandle(intptr_t h)'),
  GetSystemPowerStatus: kernel32.func('int __stdcall GetSystemPowerStatus(_Out_ HB_POWER *s)'),
};

// 正在运行的程序名（小写，带 .exe）
export function processNames() {
  const out = new Set();
  const snap = k.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
  if (Number(snap) === -1) return out;
  try {
    const e = { dwSize: koffi.sizeof(PROCESSENTRY32W), szExeFile: '' };
    for (let ok = k.Process32FirstW(snap, e); ok; ok = k.Process32NextW(snap, e)) out.add(String(e.szExeFile).toLowerCase());
  } finally {
    k.CloseHandle(snap);
  }
  return out;
}

// 进程号 → 程序名（小写，带 .exe）：鉴定时认出窗口是哪个软件（聊天软件只标名字、禁止操作的涂黑）
export function processMap() {
  const out = new Map();
  const snap = k.CreateToolhelp32Snapshot(2, 0);
  if (Number(snap) === -1) return out;
  try {
    const e = { dwSize: koffi.sizeof(PROCESSENTRY32W), szExeFile: '' };
    for (let ok = k.Process32FirstW(snap, e); ok; ok = k.Process32NextW(snap, e)) out.set(e.th32ProcessID, String(e.szExeFile).toLowerCase());
  } finally {
    k.CloseHandle(snap);
  }
  return out;
}

// 电源：ac 插着电吗（null 不知道），percent 电量（null 没电池或不知道），secondsLeft 还能用多久（null 不知道）
export function powerStatus() {
  const s = {};
  if (!k.GetSystemPowerStatus(s)) return null;
  return {
    ac: s.ACLineStatus === 255 ? null : s.ACLineStatus === 1,
    battery: !(s.BatteryFlag & 128) && s.BatteryFlag !== 255,
    percent: s.BatteryLifePercent === 255 ? null : s.BatteryLifePercent,
    secondsLeft: s.BatteryLifeTime === 0xffffffff ? null : s.BatteryLifeTime,
  };
}
