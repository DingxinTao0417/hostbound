// 操作软件界面的实测（真的 Cua Driver，只对自己开的测试窗口操作）：
// 窗口 A（另一个进程开的小窗，跟真实情况一样）当作宿主正在用的前台，在后台读、点、输入、按键、滚动窗口 B，
// 检查 B 没被拉到前台、鼠标没被拽到 B 上。宿主同时在用电脑也不影响判断（前台换成别的窗口不算错）。
// 用法：node_modules\electron\dist\electron.exe tools\test-screen-live.cjs
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

const PAGE_B = `
<body style="margin:0;font:22px sans-serif">
  <div style="padding:16px;display:flex;gap:12px;align-items:center">
    <button id="add" onclick="window.clicks=(window.clicks||0)+1">加一</button>
    <button id="other" onclick="window.others=(window.others||0)+1">另一个按钮</button>
    <input id="name" aria-label="名字">
  <script>window.keys = []; addEventListener("keydown", (e) => { window.lastKey = e.key; window.keys.push(e.key); }, true)</script>
  </div>
  <div style="height:3000px;background:linear-gradient(#fff,#ccd)">很长的内容</div>
</body>`;

function testWindow(title, x, y, html) {
  const w = new BrowserWindow({ x, y, width: 560, height: 360, useContentSize: true, title, show: false, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { contextIsolation: true } });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<title>${title}</title>${html}`));
  return new Promise((r) => w.once('ready-to-show', () => r(w)));
}

app.whenReady().then(async () => {
  const win = await import(pathToFileURL(path.join(root, 'brain', 'win32.mjs')).href);
  const { Operator } = await import(pathToFileURL(path.join(root, 'brain', 'operator.mjs')).href);
  const { Screen } = await import(pathToFileURL(path.join(root, 'brain', 'screen.mjs')).href);
  const { loadConfig } = await import(pathToFileURL(path.join(root, 'brain', 'config.mjs')).href);
  const { screen: displays } = require('electron');
  const wa = displays.getPrimaryDisplay().workArea;
  const startFg = win.foreground();
  const stamp = Date.now().toString(36);
  const titleA = `Hostbound 前台测试 ${stamp}`;
  const titleB = `Hostbound 后台测试 ${stamp}`;
  const operator = new Operator({ ownPids: [], log: () => {}, cursor: true });
  const scr = new Screen({ root, cfg: loadConfig(root), log: (...a) => console.log('  [screen]', ...a), operator, ownPids: [] });
  // A 用 PowerShell 开一个 WinForms 小窗：跟 B 不是一个进程，Windows 的前台规则才跟真实情况一样
  const psA = spawn('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.Text='${titleA}'; $f.Width=420; $f.Height=220; $f.StartPosition='Manual'; $f.Left=${wa.x + 700}; $f.Top=${wa.y + 300}; [void]$f.ShowDialog()`], { stdio: 'ignore' });
  const B = await testWindow(titleB, wa.x + 120, wa.y + 120, PAGE_B);
  const js = (code) => B.webContents.executeJavaScript(code);

  try {
    ok('Cua Driver 在', scr.available && require('node:fs').existsSync(scr.cuaPath), scr.cuaPath);
    B.showInactive();
    let hA = null;
    for (let i = 0; i < 40 && !hA; i++) {
      await wait(250);
      hA = win.userWindows().find((h) => win.title(h) === titleA);
    }
    win.giveFocus(hA);
    await wait(500);
    ok('（准备）前台是窗口 A', win.foreground() === hA, win.title(win.foreground()));
    const hB = win.userWindows().find((h) => win.title(h) === titleB);
    const rectB = win.rectOf(hB);
    const untouched = (step) => {
      ok(`${step}：B 没被拉到前台`, win.foreground() !== hB, win.title(win.foreground()));
      const c = win.cursor();
      const inB = c.x >= rectB.x && c.x < rectB.x + rectB.width && c.y >= rectB.y && c.y < rectB.y + rectB.height;
      ok(`${step}：鼠标没被拽到 B 上`, !inB, JSON.stringify(c));
    };

    // ---- 认窗口、读界面 ----
    const w = await scr.resolve(titleB);
    ok('认出窗口 B', w.title === titleB);
    let t = Date.now();
    const r = await scr.read(titleB);
    const st = scr.apps.get(w.wid);
    const find = (name) => [...st.elements.entries()].find(([, e]) => e.name === name);
    ok('读界面：用 Cua', r.details.engine === 'cua', JSON.stringify(r.details));
    ok('读界面：读出按钮和输入框', find('加一') && find('另一个按钮') && find('名字'), [...st.elements.values()].map((e) => e.name).join(' / '));
    ok('读界面：附截图', r.content.some((c) => c.type === 'image'));
    console.log(`  读界面 ${Date.now() - t}ms，${r.details.count} 个元素`);
    untouched('读界面');

    // ---- 按编号点 ----
    const [addIdx] = find('加一');
    await scr.click(titleB, { element: +addIdx });
    await wait(300);
    ok('按编号点「加一」：页面收到了', (await js('window.clicks')) === 1, String(await js('window.clicks')));
    untouched('按编号点');

    // ---- 按截图坐标点（读不出按钮的界面就这么点）----
    await scr.read(titleB);
    const st2 = scr.apps.get(w.wid);
    const other = [...st2.elements.values()].find((e) => e.name === '另一个按钮');
    const k = st2.shot.width / st2.shotRect.width;
    const x = Math.round((other.rect.x + other.rect.width / 2 - st2.shotRect.x) * k);
    const y = Math.round((other.rect.y + other.rect.height / 2 - st2.shotRect.y) * k);
    await scr.click(titleB, { x, y });
    await wait(300);
    ok('按截图坐标点「另一个按钮」：页面收到了', (await js('window.others')) === 1, `(${x}, ${y}) → ${await js('window.others')}`);
    untouched('按坐标点');

    // ---- 输入（中文）----
    await scr.read(titleB);
    const [nameIdx] = [...scr.apps.get(w.wid).elements.entries()].find(([, e]) => e.name === '名字');
    await scr.type(titleB, { text: '宿主系统 ok', element: +nameIdx });
    await wait(300);
    ok('往输入框填中文', (await js('document.getElementById("name").value')) === '宿主系统 ok', await js('document.getElementById("name").value'));
    untouched('输入');

    // ---- 按键 ----
    const keyErr = await scr.keys(titleB, { keys: 'enter' }).then(() => '', (e) => e.message);
    await wait(300);
    const key = (await js('window.keys')).includes('Enter') ? 'Enter' : '';
    console.log(`  后台按回车：${key === 'Enter' ? '页面收到了' : keyErr ? '软件收不到后台按键（' + keyErr.slice(0, 30) + '…）' : '没报错但页面没收到'}`);
    ok('后台按回车：要么收到、要么明确提示申请前台', key === 'Enter' || /request_foreground/.test(keyErr), keyErr || String(key));
    untouched('按键');

    // ---- 滚动 ----
    const scrollErr = await scr.scroll(titleB, { direction: 'down', amount: 5 }).then(() => '', (e) => e.message);
    await wait(500);
    const sy = await js('window.scrollY');
    console.log(`  后台滚动：${sy > 0 ? '页面滚了 ' + sy : scrollErr ? '软件收不到后台滚动（' + scrollErr.slice(0, 30) + '…）' : '没报错但页面没滚'}`);
    ok('后台滚动：要么滚了、要么明确提示申请前台', sy > 0 || /request_foreground/.test(scrollErr), scrollErr || String(sy));
    untouched('滚动');

    // ---- 宿主允许接管前台以后：同样的按键改走前台，做完焦点还给 A ----
    if (keyErr) {
      operator.takeover = { hwnd: w.wid, until: Date.now() + 10_000 };
      await scr.keys(titleB, { keys: 'enter' });
      operator.takeover = null;
      await wait(500);
      const keys = await js('window.keys');
      ok('接管前台后按回车：页面收到了', keys.includes('Enter'), JSON.stringify(keys));
      ok('接管前台后按回车：做完焦点还回去', win.foreground() !== hB, win.title(win.foreground()));
    }

    // ---- 面板描述（编号每次读界面都可能变，按最新一次的）----
    const cur = [...scr.apps.get(w.wid).elements.entries()].find(([, e]) => e.name === '加一')[0];
    ok('面板描述', /点击「加一」/.test(scr.describe('click', { app: titleB, element: +cur }) || ''), scr.describe('click', { app: titleB, element: +cur }));
  } catch (e) {
    fails++;
    console.log('✗ 出错', e.stack || e.message);
  } finally {
    scr.close();
    psA.kill();
    B.destroy();
    if (startFg && win.isWindow(startFg)) win.giveFocus(startFg);
    console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
    app.exit(fails ? 1 : 0);
  }
});
