// 操作软件界面（screen.mjs）的单元测试：两个引擎都换成假的，不碰真窗口、真鼠标键盘。node tools/test-screen.mjs
import { Screen } from '../brain/screen.mjs';
import { Operator } from '../brain/operator.mjs';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const throws = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
};

// 宽 w、高 h 的 PNG 文件头
function png(w, h) {
  const b = Buffer.alloc(33);
  b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

// ---- 假的 Cua Driver ----
const WINDOWS = [
  '- CalculatorApp.exe (pid 100) "计算器" [window_id: 11]',
  '- Weixin.exe (pid 200) "微信" [window_id: 22]',
  '- WINWORD.EXE (pid 300) "文档1 - Word" [window_id: 33]',
  '- electron.exe (pid 999) "Hostbound" [window_id: 44]',
  '- Qoder CN.exe (pid 400) "index.mjs - myapp - Qoder CN" [window_id: 55]',
].join('\n');
const el = (i, role, label, x, y, w = 100, h = 80) => ({ element_index: i, element_token: `s1:${i}`, role, label, actions: role === 'Edit' ? ['set_value', 'text'] : ['invoke'], frame: { x, y, w, h } });
// 计算器：窗口在屏幕 (300, 200)，480×760；截图缩成一半 240×380
const CALC = [el(1, 'Button', '七', 320, 600), el(2, 'Button', '加', 650, 700), el(3, 'Edit', '密码', 320, 300, 400, 40), el(4, 'Button', '发送', 650, 300)];
for (let i = 5; i <= 10; i++) CALC.push(el(i, 'Button', `键${i}`, 320 + i, 800));
const calls = { cua: [], ocu: [] };
// 每次读界面发一个新的截图编号；busyOnce：下一次按坐标点报 busy；shotWidth：截图宽度（模拟窗口变大）
const fake = { captures: 0, busyOnce: false, busyAlways: false, shotWidth: 240 };
const cua = {
  async call(name, args) {
    calls.cua.push({ name, args });
    if (name === 'list_windows') return { text: WINDOWS };
    if (name === 'get_window_state') {
      const base = { window_bounds: { x: 300, y: 200, width: 480, height: 760 }, screenshot_width: fake.shotWidth, screenshot_height: 380, capture_id: `cap${++fake.captures}`, tree_markdown: 'tree' };
      const elements = args.window_id === 11 ? CALC : args.window_id === 33 ? [el(1, 'Button', '保存', 10, 10)] : [];
      return { text: 'tree', isError: false, structured: { ...base, elements }, raw: { content: [{ type: 'text' }, { type: 'image', data: png(240, 380), mimeType: 'image/png' }] } };
    }
    if (name === 'launch_app') return { text: 'ok', isError: false, structured: { windows: [{ title: '计算器' }] } };
    if (name === 'click' && args.x != null && fake.busyAlways) return { text: 'UIA pixel click busy for pid 100. No fallback input was sent.', isError: true };
    if (name === 'click' && args.x != null && fake.busyOnce) {
      fake.busyOnce = false;
      return { text: 'UIA pixel click busy for pid 100. No fallback input was sent.', isError: true };
    }
    if (name === 'type_text' && args.window_id === 22 && args.delivery_mode === 'background') return { text: "Background delivery is not available for target window class 'Chrome_WidgetWin_1' (background_unavailable)", isError: true };
    return { text: 'ok', isError: false };
  },
  close() {},
};
// ---- 假的 Open Computer Use：Word 能读出 12 个按钮，微信只读出 1 个 ----
const ocuState = (title, n) =>
  [`App=${title}`, `Window: "${title}", App: ${title}.`, `\t0 window ${title} Frame: {x: 0, y: 0, width: 800, height: 600}`]
    .concat(Array.from({ length: n }, (_, i) => `\t\t${i + 1} button 按钮${i + 1} Frame: {x: ${10 + i * 20}, y: 40, width: 18, height: 18}`))
    .join('\n');
const ocu = {
  async call(name, args) {
    calls.ocu.push({ name, args });
    if (name === 'list_apps') return { text: 'Word -- WINWORD.EXE pid=300\nWeChat -- Weixin.exe pid=200\n计算器 -- CalculatorApp.exe pid=100' };
    if (name === 'get_app_state') {
      const n = args.app === 'Word' ? 12 : 1;
      return { text: ocuState(args.app, n), images: [{ type: 'image', data: png(800, 600), mimeType: 'image/png' }], isError: false };
    }
    return { text: 'ok', isError: false };
  },
  close() {},
};

const operator = new Operator({ ownPids: [], cursor: true });
const fx = [];
const events = [];
operator.on('fx', (m) => fx.push(m));
operator.on('target', (t) => events.push(t));
const screen = new Screen({ root: '.', cfg: { computerUse: { enabled: true } }, operator, ownPids: [999] });
screen.clients = { cua, ocu };
// 跟真的一样数 Cua 调了几次（截图编号新不新靠它判断）
const cuaCall = cua.call;
cua.call = (...a) => (screen.cuaCalls++, cuaCall.apply(cua, a));
screen.isWindow = () => false; // 先当窗口都不在：每次都去列窗口
screen.rectOf = (h) => ({ 11: { x: 300, y: 200, width: 480, height: 760 }, 22: { x: 0, y: 0, width: 900, height: 700 }, 33: { x: 108, y: 50, width: 784, height: 592 } })[h];
screen.rawRectOf = (h) => ({ 33: { x: 100, y: 50, width: 800, height: 600 } })[h] || screen.rectOf(h);

// ---- 认窗口 ----
ok('中文名认窗口：计算器', (await screen.resolve('计算器')).wid === 11);
ok('程序名认窗口：calculator', (await screen.resolve('calculator')).wid === 11);
ok('标题里的词认窗口：word', (await screen.resolve('word')).wid === 33);
ok('程序名带空格的也认得（Qoder CN.exe）', (await screen.resolve('Qoder')).wid === 55);
ok('自己的窗口（Hostbound）不在列表里', /没找到/.test(await throws(() => screen.resolve('Hostbound'))));

// ---- 读界面：Cua 读得出就用 Cua ----
fx.length = 0;
const r1 = await screen.read('计算器');
ok('计算器：用 Cua 读', r1.details.engine === 'cua' && r1.details.count === 10, JSON.stringify(r1.details));
ok('读之前发「扫描中」，读完锁定', fx[0]?.phase === 'scanning' && fx.some((m) => m.kind === 'scan' && m.phase === 'locked' && m.sub === '10 元素'));
ok('报告操作目标', events.some((t) => t.name === '计算器' && t.count === 10 && t.elements.includes('七')));
ok('附截图', r1.content.some((c) => c.type === 'image'));
ok('记下截图位置（接管前台时用）', operator.lastShot?.hwnd === 11 && operator.lastShot.width === 240, JSON.stringify(operator.lastShot));
ok('Cua 读出够多：不去叫 Open Computer Use', !calls.ocu.some((c) => c.name === 'get_app_state' && c.args.app === '计算器'));

// ---- 读界面：Cua 读得少、Open Computer Use 读得多 → 换它 ----
const r2 = await screen.read('word');
ok('Word：Cua 只读出 1 个，换 Open Computer Use', r2.details.engine === 'ocu' && r2.details.count === 12, JSON.stringify(r2.details));
const word = screen.apps.get(33);
ok('Open Computer Use 的坐标换成屏幕坐标（加上含边框的窗口左上角）', word.elements.get('1').rect.x === 110 && word.elements.get('1').rect.y === 90, JSON.stringify(word.elements.get('1').rect));

// ---- 读界面：两个都读不出（自己画的界面）→ 留着 Cua 的截图，按坐标点 ----
const r3 = await screen.read('微信');
ok('微信：两个都读不出按钮，提示按坐标点', r3.details.engine === 'cua' && r3.details.count === 0 && /按坐标/.test(r3.content[0].text), r3.content[0].text.slice(0, 80));
calls.ocu.length = 0;
await screen.read('微信');
ok('再读微信：上次 Open Computer Use 也读不出，这次不再白等它', !calls.ocu.some((c) => c.name === 'get_app_state'));
calls.ocu.length = 0;
await screen.read('word');
ok('再读 Word：Open Computer Use 读得多，照样用它', calls.ocu.some((c) => c.name === 'get_app_state'));

// ---- 点击：光标先飞到元素中心，再在后台点 ----
fx.length = 0;
calls.cua.length = 0;
let t = Date.now();
await screen.click('计算器', { element: 1 });
const click = fx.find((m) => m.kind === 'click');
ok('点击：光标飞到元素中心', click?.point.x === 370 && click.point.y === 640 && /七/.test(click.label), JSON.stringify(click));
ok('点击：等光标飞到再执行（约 0.5 秒）', Date.now() - t >= 480, `${Date.now() - t}ms`);
const c1 = calls.cua.find((c) => c.name === 'click');
ok('点击：用元素令牌在后台点', c1?.args.element_token === 's1:1' && c1.args.pid === 100 && c1.args.window_id === 11 && c1.args.delivery_mode === 'background', JSON.stringify(c1?.args));

// 按截图坐标点：截图是窗口的一半大小
fx.length = 0;
calls.cua.length = 0;
await screen.click('计算器', { x: 100, y: 50 });
const c2 = fx.find((m) => m.kind === 'click');
ok('按截图坐标点：光标换回屏幕坐标', c2?.point.x === 500 && c2.point.y === 300, JSON.stringify(c2?.point));
const c2c = calls.cua.find((c) => c.name === 'click');
const lastCap = `cap${fake.captures}`;
ok('按截图坐标点：带上最新的截图编号', c2c?.args.x === 100 && c2c.args.capture_id === lastCap, JSON.stringify(c2c?.args));
ok('截图编号只用一次', screen.apps.get(11).capture === null);

// 读过的窗口直接用：读完马上按坐标点，中间不再列窗口、不用重截
screen.isWindow = () => true;
await screen.read('计算器');
const readCap = `cap${fake.captures}`;
calls.cua.length = 0;
await screen.click('计算器', { x: 10, y: 10 });
ok('读完马上点：不再列窗口、不重截', JSON.stringify(calls.cua.map((c) => c.name)) === '["click"]', JSON.stringify(calls.cua.map((c) => c.name)));
ok('读完马上点：用的就是读界面那张截图的编号', calls.cua[0]?.args.capture_id === readCap, calls.cua[0]?.args.capture_id);

// 中间调过别的（截图编号旧了）：先悄悄重截一张，用新编号
await screen.read('计算器');
await screen.windows();
calls.cua.length = 0;
await screen.click('计算器', { x: 10, y: 10 });
ok('编号旧了：先重截再点', JSON.stringify(calls.cua.map((c) => c.name)) === '["get_window_state","click"]', JSON.stringify(calls.cua.map((c) => c.name)));
ok('编号旧了：用新截图的编号', calls.cua.at(-1)?.args.capture_id === `cap${fake.captures}`);

// Cua 报 busy（说明了没发出输入）：重截一张再试一次
await screen.read('计算器');
fake.busyOnce = true;
calls.cua.length = 0;
const busyMsg = await screen.click('计算器', { x: 10, y: 10 }).then((m) => m, (e) => 'ERR ' + e.message);
ok('报 busy：重截后再点一次就成了', /已点击/.test(busyMsg) && JSON.stringify(calls.cua.map((c) => c.name)) === '["click","get_window_state","click"]', `${busyMsg} ${JSON.stringify(calls.cua.map((c) => c.name))}`);

// 一直 busy：试几次就停，告诉大脑这次什么都没点
await screen.read('计算器');
fake.busyAlways = true;
calls.cua.length = 0;
const stuck = await throws(() => screen.click('计算器', { x: 10, y: 10 }));
fake.busyAlways = false;
ok('一直 busy：试 4 次就停，提示稍后再试或申请前台', /request_foreground/.test(stuck) && calls.cua.filter((c) => c.name === 'click').length === 4, `${stuck} ${calls.cua.filter((c) => c.name === 'click').length}`);

// 窗口大小变了：大脑手里那张截图的坐标对不上，让它重新读，不硬点
await screen.read('计算器');
await screen.windows();
fake.shotWidth = 300;
calls.cua.length = 0;
const resized = await throws(() => screen.click('计算器', { x: 10, y: 10 }));
fake.shotWidth = 240;
ok('窗口大小变了：不点，让大脑重新读', /重新读/.test(resized) && !calls.cua.some((c) => c.name === 'click'), resized);
await screen.read('计算器');
screen.isWindow = () => false;

// Word 走 Open Computer Use
calls.ocu.length = 0;
await screen.click('word', { element: 3 });
const c3 = calls.ocu.find((c) => c.name === 'click');
ok('Word：用 Open Computer Use 点，按它的编号', c3?.args.app === 'Word' && c3.args.element_index === '3', JSON.stringify(c3?.args));

// ---- 输入：密码框打码 ----
fx.length = 0;
calls.cua.length = 0;
await screen.type('计算器', { text: 'hunter2', element: 3 });
ok('密码框输入：字幕打码', fx.find((m) => m.kind === 'type')?.text === '••••');
const sv = calls.cua.find((c) => c.name === 'set_value');
ok('输入框：直接填值（后台也能用）', sv?.args.element_token === 's1:3' && sv.args.value === 'hunter2', JSON.stringify(sv?.args));

// 软件收不到后台打字：不偷偷切前台，告诉大脑去申请
const bgErr = await throws(() => screen.type('微信', { text: '你好' }));
ok('收不到后台输入：提示申请接管前台', /request_foreground/.test(bgErr), bgErr);
ok('收不到后台输入：没有自己改用前台', !calls.cua.some((c) => c.args.delivery_mode === 'foreground'));
// 宿主允许接管以后：同样的动作走前台，并告诉桌面窗口这段键鼠是模拟的
const injecting = [];
operator.on('injecting', (ms) => injecting.push(ms));
operator.takeover = { hwnd: 22, until: Date.now() + 5000 };
calls.cua.length = 0;
await screen.type('微信', { text: '你好' });
operator.takeover = null;
ok('接管期间：改走前台', calls.cua.find((c) => c.name === 'type_text')?.args.delivery_mode === 'foreground');
ok('接管期间：先说一声这段键鼠是模拟的', injecting.length === 1 && injecting[0] >= 1000);
ok('面板描述也打码', screen.describe('type_text', { app: '计算器', element: 3, text: 'hunter2' }) === '计算器：输入：••••');

// ---- 按键 ----
fx.length = 0;
calls.cua.length = 0;
await screen.keys('计算器', { keys: 'Ctrl+S' });
ok('组合键：拆成 hotkey', JSON.stringify(calls.cua.find((c) => c.name === 'hotkey')?.args.keys) === '["ctrl","s"]');
ok('按键：键帽', fx.some((m) => m.kind === 'keys' && m.keys === 'Ctrl+S'));
await screen.keys('计算器', { keys: 'enter' });
ok('单个键：press_key，enter 换成 Cua 的 return', calls.cua.find((c) => c.name === 'press_key')?.args.key === 'return');

// ---- 授权 ----
ok('点「发送」要授权', /发送/.test(screen.risk({ toolName: 'click', input: { app: '计算器', element: 4 } })?.label || ''));
ok('点「七」不用授权', screen.risk({ toolName: 'click', input: { app: '计算器', element: 1 } }) === null);
ok('在微信里按回车要授权', /微信/.test(screen.risk({ toolName: 'press_keys', input: { app: '微信', keys: 'enter' } })?.label || ''));
ok('没读过界面也拦：在 QQ 里按 ctrl+enter', !!screen.risk({ toolName: 'press_keys', input: { app: 'QQ', keys: 'ctrl+enter' } }));
ok('在计算器里按回车不用授权', screen.risk({ toolName: 'press_keys', input: { app: '计算器', keys: 'enter' } }) === null);
ok('在微信里按 ctrl+a 不用授权', screen.risk({ toolName: 'press_keys', input: { app: '微信', keys: 'ctrl+a' } }) === null);
ok('别的工具不归这里管', screen.risk({ toolName: 'powershell', input: { command: 'ls' } }) === null);

// ---- 面板描述、出错提示、工具 ----
ok('面板描述：点击', screen.describe('click', { app: '计算器', element: 1 }) === '计算器：点击「七」', screen.describe('click', { app: '计算器', element: 1 }));
ok('面板描述：不是这里的工具返回 null', screen.describe('powershell', {}) === null);
ok('编号不存在：提示重新读', /重新读/.test(await throws(() => screen.click('计算器', { element: 99 }))));
ok('没给编号也没给坐标：报错', /element|坐标/.test(await throws(() => screen.click('计算器', {}))));
const open = await screen.open('计算器');
ok('打开软件：系统应用用英文名、在后台打开', calls.cua.find((c) => c.name === 'launch_app')?.args.name === 'Calculator' && /后台/.test(open));
ok('工具齐全', JSON.stringify(screen.tools().map((x) => x.name)) === JSON.stringify(['list_apps', 'open_app', 'read_app', 'click', 'type_text', 'press_keys', 'scroll']));

console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
