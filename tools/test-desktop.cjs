// 桌面实测（只对自己开的测试窗口操作）：看屏幕截图、焦点归还、接管前台时的真实鼠标键盘。
// 用法：node_modules\electron\dist\electron.exe tools\test-desktop.cjs
// 会短暂移动鼠标、在测试窗口里打字；测完把鼠标位置和原来的前台窗口还原。
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

function testWindow(title, x, y, html) {
  const w = new BrowserWindow({ x, y, width: 520, height: 360, useContentSize: true, title, show: false, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { contextIsolation: true } });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<title>${title}</title><body style="margin:0;font:28px sans-serif">${html}</body>`));
  return new Promise((r) => w.once('ready-to-show', () => r(w)));
}

app.whenReady().then(async () => {
  const win = await import(pathToFileURL(path.join(root, 'brain', 'win32.mjs')).href);
  const { Operator } = await import(pathToFileURL(path.join(root, 'brain', 'operator.mjs')).href);
  const { captureRect } = require(path.join(root, 'app', 'capture.cjs'));
  const { FxLayer } = require(path.join(root, 'app', 'fx.cjs'));
  const { screen } = require('electron');
  const prim = screen.getPrimaryDisplay();
  const fx = new FxLayer({ coreDisplay: () => prim, coreHome: () => null });
  const startFg = win.foreground();
  const startCursor = win.cursor();
  const find = (t) => win.userWindows().find((h) => win.title(h) === t);

  try {
    // ---- 1. 看屏幕：截到的是不是那个窗口 ----
    const A = await testWindow('Hostbound 测试窗口 A', prim.workArea.x + 80, prim.workArea.y + 80, '<div style="position:absolute;left:60px;top:60px;width:200px;height:120px;background:#ff8800"></div><div style="position:absolute;left:300px;top:60px">测试 A</div>');
    A.show();
    A.focus();
    await wait(600);
    const hA = find('Hostbound 测试窗口 A');
    ok('找到测试窗口 A', !!hA);
    const shot = await captureRect({ rect: win.rectOf(hA), scope: 'window', label: '测试窗口 A', fx });
    fs.writeFileSync(path.join(process.env.TEMP || '.', 'hb-capture-test.jpg'), Buffer.from(shot.data, 'base64'));
    // 橙色块在窗口内容区 (60,60)-(260,180)：取截图里大约那个位置的颜色
    const bmp = shot.image.toBitmap();
    const { width } = shot.image.getSize();
    const k = shot.width / win.rectOf(hA).width;
    const titleBar = (win.rectOf(hA).height - 360 * prim.scaleFactor) * k; // 标题栏高度（截图像素）
    const px = Math.round(160 * prim.scaleFactor * k);
    const py = Math.round(120 * prim.scaleFactor * k + titleBar);
    const i = (py * width + px) * 4;
    const [b, g, r] = [bmp[i], bmp[i + 1], bmp[i + 2]]; // BGRA
    ok('截图截到的是窗口 A（橙色块）', r > 200 && g > 100 && g < 170 && b < 60, `rgb=${r},${g},${b}`);
    ok('截图大小合理', shot.width > 300 && shot.height > 200, `${shot.width}x${shot.height}`);

    // ---- 2. 焦点归还 ----
    const op = new Operator({ ownPids: [], log: () => {} });
    const fxMsgs = [];
    op.on('fx', (m) => fxMsgs.push(m));
    A.focus();
    await wait(300);
    op.taskStart();
    await op.beforeTool({ toolName: 'powershell', input: {} }); // 记下宿主在用的窗口 A
    const B = await testWindow('Hostbound 测试窗口 B', prim.workArea.x + 300, prim.workArea.y + 160, '新开的窗口 B');
    B.show();
    B.focus(); // 模拟新开的软件抢了焦点
    await wait(500);
    ok('（准备）焦点被 B 抢走', win.foreground() === find('Hostbound 测试窗口 B'));
    op.userInputAt = Date.now(); // 宿主正在打字
    op.afterTool({ toolName: 'powershell', input: {}, content: [], isError: false });
    await wait(300);
    ok('宿主在忙：焦点还给 A', win.foreground() === hA, win.title(win.foreground()));
    ok('宿主在忙：弹「后台打开」提示', fxMsgs.some((m) => m.kind === 'notice' && m.title === '后台打开'));
    // 宿主闲着（刚说完指令在等）：新窗口留在前面
    await op.beforeTool({ toolName: 'powershell', input: {} });
    B.focus();
    await wait(400);
    op.userInputAt = 0;
    op.afterTool({ toolName: 'powershell', input: {}, content: [], isError: false });
    await wait(300);
    ok('宿主闲着：新窗口留在前面', win.foreground() === find('Hostbound 测试窗口 B'));
    B.destroy();

    // ---- 3. 接管前台：真实鼠标点击、输入、按键 ----
    const C = await testWindow(
      'Hostbound 测试窗口 C',
      prim.workArea.x + 140,
      prim.workArea.y + 120,
      `<button id="btn" style="position:absolute;left:40px;top:40px;width:200px;height:80px;font-size:22px">按钮</button>
       <input id="inp" style="position:absolute;left:40px;top:160px;width:400px;height:40px;font-size:20px">
       <script>window.log=[];btn.onclick=()=>log.push('click');inp.onkeydown=(e)=>{if(e.key==='Enter')log.push('enter')};</script>`,
    );
    C.show();
    C.focus();
    await wait(500);
    const hC = find('Hostbound 测试窗口 C');
    const rc = win.rectOf(hC);
    const titleH = rc.height - 360 * prim.scaleFactor;
    op.lastShot = { rect: rc, width: rc.width, height: rc.height, hwnd: hC }; // 截图就是窗口本身，1:1
    const tools = Object.fromEntries(op.tools().map((t) => [t.name, t]));
    op.once('takeover_request', (req) => setTimeout(() => op.answerTakeover(req.id, 'allow'), 100));
    const granted = await tools.request_foreground.execute('t1', { app: 'Hostbound 测试窗口 C', reason: '测试', seconds: 10 });
    ok('允许后拿到前台控制权', /允许了/.test(granted.content[0].text) && !!op.takeover);
    const s = prim.scaleFactor;
    await tools.fg_click.execute('t2', { x: 140 * s, y: titleH + 80 * s }); // 按钮中心
    await wait(300);
    await tools.fg_click.execute('t3', { x: 240 * s, y: titleH + 180 * s }); // 输入框
    await wait(200);
    await tools.fg_type.execute('t4', { text: '你好abc' });
    await tools.fg_key.execute('t5', { keys: 'enter' });
    await wait(400);
    const result = await C.webContents.executeJavaScript('JSON.stringify({ log: window.log, value: inp.value })');
    const rr = JSON.parse(result);
    ok('真实鼠标点中了按钮', rr.log.includes('click'), result);
    ok('真实键盘输入了中文和英文', rr.value === '你好abc', result);
    ok('按键 Enter 生效', rr.log.includes('enter'), result);
    op.userTookBack();
    let threw = '';
    try {
      await tools.fg_click.execute('t6', { x: 10, y: 10 });
    } catch (e) {
      threw = e.message;
    }
    ok('宿主收回后再也不能动真鼠标', /没有前台控制权/.test(threw), threw);
    C.destroy();
    A.destroy();
  } catch (e) {
    fails++;
    console.log('✗ 出错', e.stack);
  } finally {
    // 还原鼠标位置和原来的前台窗口
    try {
      require('koffi').load('user32.dll').func('int __stdcall SetCursorPos(int, int)')(startCursor.x, startCursor.y);
    } catch {}
    if (startFg) win.giveFocus(startFg);
  }
  console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
  app.exit(fails ? 1 : 0);
});
