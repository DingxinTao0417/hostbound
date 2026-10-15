// 对比两个操作软件界面的引擎：Open Computer Use（现在用的）和 Cua Driver。
// 1. 只读：同一批软件各读一次界面，比能读出多少元素、多少有名字、多快、有没有截图
// 2. 后台操作：在计算器里点按钮、在记事本里打字，比能不能做成、会不会动宿主的鼠标和焦点
// 只输出数量和耗时，不输出界面上的文字（微信之类可能有隐私内容）。
// 安全规则：点击、打字、清空只对测试自己新开的窗口做；宿主本来就开着的软件只读不碰（记事本、计算器开着就跳过操作测试）。
// 用法：node tools/compare-engines.mjs [--skip-launch]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../brain/mcp-client.mjs';
import * as win from '../brain/win32.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OCU_EXE = path.join(root, 'node_modules/open-computer-use/dist/windows/amd64/open-computer-use.exe');
const CUA_EXE = path.join(root, 'tools/cua-driver/cua-driver.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// 要测的软件：name 给 Cua 的 launch_app 用；exe 用来认进程；running 表示宿主已经开着（只读、不关）
const APPS = [
  { key: '剪映专业版', name: '剪映专业版', exe: /JianyingPro/i, wait: 15000 },
  { key: '微信', exe: /Weixin|WeChat/i, running: true },
  { key: 'OBS Studio', name: 'OBS Studio', exe: /obs64/i, wait: 6000 },
  { key: '网易云音乐', name: '网易云音乐', exe: /cloudmusic/i, wait: 8000 },
  { key: 'Obsidian', name: 'Obsidian', exe: /Obsidian/i, wait: 6000 },
  { key: 'Word', name: 'Word', exe: /WINWORD/i, wait: 8000 },
];
const INTERACTIVE = /^(button|edit|menu ?item|check ?box|combo ?box|list ?item|tab ?item|hyperlink|link|radio ?button|slider|tree ?item|split ?button|按钮|编辑|菜单项|复选框|组合框|列表项|选项卡项|超链接|单选按钮|滑块|树项)$/i;

// ---- 两个引擎读界面的结果统计 ----
function statOcu(text) {
  const rows = text.split('\n').map((l) => l.match(/^\t*(\d+) (.*?) Frame:/)).filter(Boolean);
  const parsed = rows.map((m) => {
    const label = m[2].replace(/\s*Secondary Actions:.*$/, '').trim();
    const [role, ...rest] = label.split(' ');
    return { role, name: rest.join(' ').trim() };
  });
  return { rows: parsed.length, named: parsed.filter((r) => r.name).length, actionable: parsed.filter((r) => INTERACTIVE.test(r.role)).length };
}
function statCua(text) {
  const lines = text.split('\n').filter((l) => /^\s*- /.test(l));
  return {
    rows: lines.length,
    named: lines.filter((l) => /^\s*- (\[\d+\] )?\S+ "[^"]+"/.test(l)).length,
    actionable: lines.filter((l) => /^\s*- \[\d+\]/.test(l)).length,
    truncated: /truncated/i.test(text),
  };
}

// Cua 的窗口列表：「- exe (pid N) "标题" [window_id: W]」
async function cuaWindows(cua) {
  const r = await cua.call('list_windows', {});
  return r.text
    .split('\n')
    .map((l) => l.match(/^- (\S+) \(pid (\d+)\) "(.*)" \[window_id: (\d+)\]/))
    .filter(Boolean)
    .map((m) => ({ exe: m[1], pid: +m[2], title: m[3], wid: +m[4] }));
}
// Open Computer Use 的软件列表：「Name -- Name [running, pid=N, window=标题]」
async function ocuApps(ocu) {
  const r = await ocu.call('list_apps', {});
  return r.text
    .split('\n')
    .map((l) => l.match(/^(.+?) -- .*pid=(\d+)/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].trim(), pid: +m[2] }));
}

async function findWindow(cua, exe, timeoutMs, title = /./) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const w = (await cuaWindows(cua)).find((x) => exe.test(x.exe) && title.test(x.title));
    if (w) return w;
    await sleep(1000);
  }
  return null;
}

const ocu = await new McpClient(OCU_EXE, ['mcp']).init();
const cua = await new McpClient(CUA_EXE, ['mcp']).init();
const opened = []; // 测试里由我打开的软件，测完关掉
const startWins = await cuaWindows(cua);
const before = new Set(startWins.map((w) => w.pid)); // 测试前宿主就开着的软件：一律不关、不碰
const beforeWids = new Set(startWins.map((w) => w.wid));
const results = [];
const userFg = win.foreground();
const userCursor = win.cursor();

try {
  // ================= 1. 只读对比 =================
  for (const app of APPS) {
    const row = { app: app.key };
    try {
      let w = (await cuaWindows(cua)).find((x) => app.exe.test(x.exe) && x.title);
      if (!w && !app.running && !process.argv.includes('--skip-launch')) {
        const l = await cua.call('launch_app', { name: app.name }, 60_000);
        if (l.isError) throw new Error('打不开：' + l.text.slice(0, 80));
        w = await findWindow(cua, app.exe, 30_000);
        if (w) opened.push(w);
        await sleep(app.wait || 4000);
        w = (await cuaWindows(cua)).find((x) => app.exe.test(x.exe) && x.title) || w;
      }
      if (!w) {
        row.note = '没开着，跳过';
        results.push(row);
        continue;
      }
      // Open Computer Use：按 pid 找它认的软件名
      const oa = (await ocuApps(ocu)).find((a) => a.pid === w.pid);
      if (oa) {
        const r = await ocu.call('get_app_state', { app: oa.name }, 90_000).catch((e) => ({ isError: true, text: e.message, images: [], ms: 90_000 }));
        row.ocu = r.isError ? { error: r.text.slice(0, 60), ms: r.ms } : { ...statOcu(r.text), ms: r.ms, shot: r.images.length > 0 };
      } else row.ocu = { error: '列表里没有这个软件' };
      const c = await cua.call('get_window_state', { pid: w.pid, window_id: w.wid, max_elements: 1200 }, 90_000).catch((e) => ({ isError: true, text: e.message, images: [], ms: 90_000 }));
      row.cua = c.isError ? { error: c.text.slice(0, 60), ms: c.ms } : { ...statCua(c.text), ms: c.ms, shot: c.images.length > 0 };
      // 界面读不出几个元素的软件：试试 Cua 的看图识别（文字和图标区域）
      const capture = c.text?.match(/capture_id[=: ]+"?([\w:-]+)/)?.[1];
      if (capture && row.cua.actionable < 15) {
        const v = await cua.call('parse_visual_regions', { capture_id: capture }, 90_000).catch((e) => ({ isError: true, text: e.message }));
        row.visual = v.isError ? { error: v.text.slice(0, 80) } : { regions: (v.text.match(/^\s*-/gm) || []).length, ms: v.ms };
      }
    } catch (e) {
      row.note = e.message.slice(0, 80);
    }
    results.push(row);
    log(JSON.stringify(row));
  }

  // ================= 2. 后台操作对比 =================
  const action = {};
  const fgBefore = win.foreground();
  const curBefore = win.cursor();
  // 计算器（用 Cua 的 launch_app：不抢焦点地打开）。宿主本来开着计算器就不测，免得点到宿主的计算器
  const userCalc = (await cuaWindows(cua)).some((w) => /^(Calculator|计算器)$/.test(w.title));
  let calc = null;
  if (userCalc) action.calc = '跳过：宿主开着计算器';
  else {
    await cua.call('launch_app', { name: 'Calculator' }, 60_000);
    calc = await findWindow(cua, /ApplicationFrameHost/i, 15_000, /^(Calculator|计算器)$/);
    if (calc && beforeWids.has(calc.wid)) calc = null; // 保险：不是新开的窗口就不碰
    const calcHwnd = win.findWindow('Calculator') || win.findWindow('计算器');
    if (calc) opened.push({ ...calc, hwnd: calcHwnd, mine: true });
    await sleep(1500);
    action.launchStoleFocus = win.foreground() !== fgBefore;
  }

  if (calc) {
  // -- Open Computer Use：Clear 7 + 8 =
  const ocuIdx = (text, name) => text.split('\n').find((l) => new RegExp(`^\\t*\\d+ button ${name}(\\s|$)`).test(l))?.match(/^\t*(\d+)/)?.[1];
  const display = (text) => text.match(/Display is ([\d,.\-]+)/)?.[1];
  {
    const t0 = Date.now();
    const s = await ocu.call('get_app_state', { app: 'ApplicationFrameHost' });
    for (const name of ['Clear', 'Seven', 'Plus', 'Eight', 'Equals']) {
      const i = ocuIdx(s.text, name);
      if (i) await ocu.call('click', { app: 'ApplicationFrameHost', element_index: i });
    }
    const after = await ocu.call('get_app_state', { app: 'ApplicationFrameHost' });
    action.ocuCalc = { result: display(after.text), ms: Date.now() - t0 };
  }
  // -- Cua Driver：Clear 9 × 6 =
  {
    const t0 = Date.now();
    const s = await cua.call('get_window_state', { pid: calc.pid, window_id: calc.wid });
    const snap = s.text.match(/snapshot_id=(\w+)/)?.[1];
    const tok = (name) => {
      const n = s.text.split('\n').find((l) => new RegExp(`\\[\\d+\\] Button "${name}"`).test(l))?.match(/\[(\d+)\]/)?.[1];
      return n ? `${snap}:${n}` : null;
    };
    for (const name of ['Clear', 'Nine', 'Multiply by', 'Six', 'Equals']) {
      const t = tok(name);
      if (t) await cua.call('click', { pid: calc.pid, window_id: calc.wid, element_token: t });
    }
    const after = await cua.call('get_window_state', { pid: calc.pid, window_id: calc.wid });
    action.cuaCalc = { result: after.text.match(/Display is ([\d,.\-]+)/)?.[1], ms: Date.now() - t0 };
  }
  }

  // 记事本：后台打字。宿主本来开着记事本就绝对不测：Windows 11 记事本「再开一个」只是在宿主的窗口里加个标签页，
  // 打字、清空会落到宿主正在编辑的文件上
  const userNotepad = (await cuaWindows(cua)).some((w) => /Notepad/i.test(w.exe));
  let note = null;
  if (userNotepad) action.notepad = '跳过：宿主开着记事本';
  else {
    await cua.call('launch_app', { name: 'Notepad' }, 60_000);
    note = await findWindow(cua, /Notepad/i, 15_000);
    if (note && (before.has(note.pid) || beforeWids.has(note.wid))) note = null; // 保险：不是新开的就不碰
    if (note) opened.push({ ...note, mine: true });
    await sleep(1500);
  }
  const oaNote = (await ocuApps(ocu)).find((a) => a.pid === note?.pid);
  if (oaNote) {
    await ocu.call('get_app_state', { app: oaNote.name });
    const r = await ocu.call('type_text', { app: oaNote.name, text: 'OCU 测试 abc' });
    const after = await ocu.call('get_app_state', { app: oaNote.name });
    action.ocuType = { ok: !r.isError && /OCU 测试 abc/.test(after.text), err: r.isError ? r.text.slice(0, 60) : undefined };
  }
  if (note) {
    await cua.call('get_window_state', { pid: note.pid, window_id: note.wid });
    const r = await cua.call('type_text', { pid: note.pid, window_id: note.wid, text: 'Cua 测试 xyz' });
    const after = await cua.call('get_window_state', { pid: note.pid, window_id: note.wid });
    action.cuaType = { ok: !r.isError && /Cua 测试 xyz/.test(after.text), err: r.isError ? r.text.slice(0, 80) : undefined };
    // 清空，免得 Windows 11 记事本下次打开还恢复这些字
    const st = await cua.call('get_window_state', { pid: note.pid, window_id: note.wid });
    const snap = st.text.match(/snapshot_id=(\w+)/)?.[1];
    const doc = st.text.split('\n').find((l) => /\[\d+\] (Document|Edit|RichEdit)/.test(l))?.match(/\[(\d+)\]/)?.[1];
    if (doc) await cua.call('set_value', { pid: note.pid, window_id: note.wid, element_token: `${snap}:${doc}`, value: '' });
  }
  action.userFocusKept = win.foreground() === fgBefore;
  const cur = win.cursor();
  action.userMouseKept = cur.x === curBefore.x && cur.y === curBefore.y;
  log('ACTION', JSON.stringify(action));
} finally {
  // 关掉测试里打开的软件（宿主本来开着的不动）
  for (const w of opened.filter((x) => !before.has(x.pid))) {
    try {
      const h = w.hwnd || win.userWindows().find((x) => win.pidOf(x) === w.pid);
      if (h) win.closeWindow(h);
    } catch {}
  }
  await sleep(5000);
  for (const w of opened.filter((x) => !before.has(x.pid))) {
    const still = (await cuaWindows(cua).catch(() => [])).some((x) => x.pid === w.pid);
    if (still) await cua.call('kill_app', { pid: w.pid }).catch(() => {});
  }
  if (userFg && win.foreground() !== userFg) win.giveFocus(userFg);
  ocu.close();
  cua.close();
  log('DONE', JSON.stringify({ restoredFocus: win.foreground() === userFg, cursorUntouched: win.cursor().x === userCursor.x }));
}
