// README 配图：用自己开的离屏窗口把设计稿、面板预览（真的界面代码 + 假数据）渲染成图片，存到 docs/images。
// 不截真屏幕。用法：node_modules\electron\dist\electron.exe tools\render-readme-images.cjs [只渲染这几张，逗号隔开] [输出目录]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const only = (process.argv[2] || '').split(',').filter(Boolean);
const outDir = process.argv[3] || path.join(root, 'docs', 'images');
const SCALE = 2; // 按 2 倍渲染（窗口放大 2 倍、页面缩放 2 倍），再缩到 maxWidth，字更清楚
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 跟 tools/serve-ui.cjs 一样：/ 是界面，/design/ 是设计稿
function serve() {
  const dirs = { renderer: path.join(root, 'app', 'renderer'), design: path.join(root, 'design') };
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
  return new Promise((resolve) => {
    const srv = http
      .createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const design = url.startsWith('/design/');
        const base = design ? dirs.design : dirs.renderer;
        const p = path.join(base, (design ? url.slice('/design'.length) : url).replace(/^\/$/, '/index.html'));
        if (!p.startsWith(base) || !fs.existsSync(p)) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
      })
      .listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// 面板预览里的一段对话：说口令跑技能 → 动作 → 回复 → 一张小鉴定卡
const CHAT_DEMO = `(() => {
  const b = window.__brain;
  const thumb = (() => { const c = document.createElement('canvas'); c.width = c.height = 120; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 120, 120); gr.addColorStop(0, '#2a1a3d'); gr.addColorStop(1, '#130d24'); g.fillStyle = gr; g.fillRect(0, 0, 120, 120);
    g.strokeStyle = '#b15bff'; g.lineWidth = 3; g.strokeRect(6, 6, 108, 108);
    g.strokeStyle = '#dbe9ff'; g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.moveTo(30, 90); g.lineTo(88, 32); g.stroke();
    g.strokeStyle = '#c99a4a'; g.lineWidth = 7; g.beginPath(); g.moveTo(24, 70); g.lineTo(50, 96); g.stroke(); return c.toDataURL('image/jpeg', 0.9); })();
  App.cfg().ui.chatHeight = 820;
  App.resetSize();
  document.querySelector('#log').innerHTML = '';
  b({ type: 'heard', text: '系统，开始做新一期' });
  b({ type: 'busy', busy: true });
  b({ type: 'skill_run', title: '开始做新一期' });
  b({ type: 'steps', steps: ['建文件夹', '建子文件夹', '打开剪映', '打开文件夹'], done: 4 });
  [['t1', '执行命令：New-Item D:\\\\视频\\\\2026-10-16'], ['t2', '执行命令：New-Item 素材、成品'], ['t3', '后台打开：剪映专业版'], ['t4', '打开文件夹：D:\\\\视频\\\\2026-10-16']].forEach(([id, text]) => {
    b({ type: 'tool', id, name: 'powershell', text });
    b({ type: 'tool_end', id, name: 'powershell', isError: false });
  });
  b({ type: 'say_start', id: 91 });
  b({ type: 'say', delta: '【完成】新一期已就绪：文件夹建好了，剪映已打开。' });
  b({ type: 'say_end', id: 91 });
  b({ type: 'busy', busy: false });
  b({ type: 'done', text: '【完成】新一期已就绪：文件夹建好了，剪映已打开。' });
  b({ type: 'appraise_card', rec: { id: 'r1', at: Date.now(), kind: 'region', name: '寒铁长剑', rarity: '史诗', fields: [['类别', '装备 · 单手剑'], ['属性', '攻击 +128　暴击 +6%']], verdict: '同等级里的上等货，比宿主身上那把强一截。', actions: [], thumb } });
})()`;

const SHOTS = [
  // 真的面板（假数据）
  { name: 'panel-chat', url: '/design/panel-preview.html', w: 1280, h: 1000, wait: 2500, prep: CHAT_DEMO, after: 1200, union: ['#bubble', '#pet'], pad: 28 },
  { name: 'panel-skills', url: '/design/panel-preview.html', w: 1280, h: 860, wait: 2500, prep: `App.go('skill')`, after: 1200, union: ['#bubble'], pad: 28 },
  { name: 'panel-memory', url: '/design/panel-preview.html', w: 1280, h: 860, wait: 2500, prep: `App.go('mem')`, after: 1200, union: ['#bubble'], pad: 28 },
  { name: 'panel-project', url: '/design/panel-preview.html', w: 1280, h: 1000, wait: 2500, prep: `__demoProjects('plan'); setTimeout(() => document.querySelector('#log .msg.pj').scrollIntoView({ block: 'start' }), 300)`, after: 1500, union: ['#bubble', '#pet'], pad: 28 },
  // 项目页（真的项目页代码 + 假的一个做到一半的项目）
  { name: 'project-page', url: '/design/project-preview.html', w: 1280, h: 820, wait: 1500, prep: `document.querySelectorAll('.agi')[2].click()`, after: 600, rect: 'viewport' },
  // 讲解窗口（真的讲解页面代码 + 假的一页）
  { name: 'explainer', url: '/design/explainer-preview.html', w: 1440, h: 1040, wait: 9000, rect: 'viewport' },
  // 鉴定术设计稿
  { name: 'appraise-select', url: '/design/appraise.html', w: 1280, h: 900, wait: 1200, el: '.desk', index: 1, pad: 0 },
  { name: 'appraise-card', url: '/design/appraise.html', w: 1280, h: 900, wait: 1200, el: '.desk', index: 2, pad: 0 },
  { name: 'appraise-scan', url: '/design/appraise.html', w: 1280, h: 900, wait: 1200, prep: "document.querySelectorAll('.row2.scan .cap2').forEach((e) => e.remove())", el: '.row2.scan', index: 0, pad: 8 },
];

async function shoot(base, s) {
  const win = new BrowserWindow({
    width: s.w * SCALE,
    height: s.h * SCALE,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, zoomFactor: SCALE, backgroundThrottling: false },
  });
  // 新建时窗口会被压到屏幕大小以内；建好以后再设一次就不会
  win.setContentSize(s.w * SCALE, s.h * SCALE);
  await win.loadURL(base + s.url);
  await wait(s.wait || 1000);
  if (s.prep) await win.webContents.executeJavaScript(s.prep);
  await wait(s.after || 300);
  const rect = await win.webContents.executeJavaScript(`(() => {
    const pad = ${s.pad || 0};
    if (${JSON.stringify(s.rect === 'viewport')}) return { x: 0, y: 0, width: innerWidth, height: innerHeight };
    let els = ${JSON.stringify(s.union || [])}.map((q) => document.querySelector(q)).filter(Boolean);
    if (${JSON.stringify(!!s.el)}) els = [document.querySelectorAll(${JSON.stringify(s.el || '')})[${s.index || 0}]];
    if (!els.length || !els[0]) return null;
    els[0].scrollIntoView({ block: 'start' });
    const rs = els.map((e) => e.getBoundingClientRect());
    const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - pad);
    const y = Math.max(0, Math.min(...rs.map((r) => r.top)) - pad);
    const x2 = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + pad);
    const y2 = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + pad);
    return { x, y, width: x2 - x, height: y2 - y };
  })()`);
  if (!rect) throw new Error(`${s.name}：找不到要截的元素`);
  await wait(400);
  let img = await win.webContents.capturePage({ x: Math.round(rect.x * SCALE), y: Math.round(rect.y * SCALE), width: Math.round(rect.width * SCALE), height: Math.round(rect.height * SCALE) });
  const maxW = s.maxWidth || 1200;
  if (img.getSize().width > maxW) img = img.resize({ width: maxW, quality: 'best' });
  win.destroy();
  const file = path.join(outDir, `${s.name}.png`);
  fs.writeFileSync(file, img.toPNG());
  const { width, height } = img.getSize();
  console.log(`✓ ${s.name}.png  ${width}×${height}  ${Math.round(fs.statSync(file).size / 1024)}KB`);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { srv, base } = await serve();
  let fails = 0;
  for (const s of SHOTS) {
    if (only.length && !only.includes(s.name)) continue;
    try {
      await shoot(base, s);
    } catch (e) {
      fails++;
      console.log(`✗ ${s.name}：${e.message}`);
    }
  }
  srv.close();
  app.exit(fails ? 1 : 0);
});
