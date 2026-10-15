// 讲解窗口、效果层标注实测（真的 Electron 窗口，假的大脑，不碰别的软件）：npx electron tools/test-explain-live.cjs
// 1. 讲解窗口：真实的安全策略下 Mermaid 能画、节点认得出、写错的图会报错、模拟能跑、截图自检、导出到浏览器（不真打开）
// 2. 效果层：在自己开的测试窗口上画就地讲解的编号、框、字幕，教学的「点这里」
// 截图存到 HOSTBOUND_SNAP（默认系统临时目录下的 hostbound-explain-live）
const { app, BrowserWindow, shell, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Explainer } = require('../app/explainer.cjs');
const { FxLayer } = require('../app/fx.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.HOSTBOUND_SNAP || path.join(os.tmpdir(), 'hostbound-explain-live');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let passes = 0;
function ok(cond, name, extra = '') {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`);
}

const PAGE = {
  id: 'live-1', kind: 'explain', title: '系统是怎么听懂宿主说话的', at: Date.now(), no: 1, total: 1, depth: 'plain', crumb: [], done: true,
  versions: { plain: { done: true, blocks: [
    { id: 'b1', kind: 'summary', text: '系统听懂宿主要过五关：唤醒词 → 断句 → 识别 → 大脑 → 开口。只有「大脑」这一关要联网。' },
    { id: 'b2', kind: 'diagram', title: '一张图看全程', mermaid: 'flowchart LR\n  mic["麦克风"] --> kws["唤醒词"]\n  kws --> vad["断句"]\n  vad --> asr["识别"]\n  asr --> brain["大脑"]\n  brain --> tts["开口"]' },
    { id: 'b3', kind: 'steps', title: '五关', items: [{ title: '唤醒词', text: '只认系统启动', say: '第一关。', nodes: ['mic', 'kws'] }, { title: '断句', text: '停 0.8 秒算说完', say: '第二关。', nodes: ['vad'] }, { title: '大脑', text: '唯一联网的一步', say: '第三关。', nodes: ['brain'] }] },
    { id: 'b4', kind: 'diagram', title: '时序图', mermaid: 'sequenceDiagram\n  participant H as 宿主\n  participant S as 系统\n  H->>S: 系统启动\n  S-->>H: 叮' },
    { id: 'b5', kind: 'bars', title: '耗时', unit: '秒', items: [{ label: '唤醒', value: 0.2 }, { label: '大脑', value: 1.5 }] },
    { id: 'b6', kind: 'sim', title: '模拟', html: '<div id=x>0</div><button id=b>加一</button><script>b.onclick=()=>x.textContent=+x.textContent+1;parent.postMessage({simRan:true},"*")</script>' },
    { id: 'b7', kind: 'diagram', title: '写错的图', mermaid: 'flowchart LR\n  A["开始" --> B' },
  ] } },
};

app.whenReady().then(async () => {
  let opened = null;
  shell.openExternal = async (u) => (opened = u); // 别真的打开浏览器
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-xw-'));
  const sent = [];
  let ex = null;
  const toBrain = (m) => {
    sent.push(m);
    if (m.op === 'ready') ex.handle({ type: 'xw', op: 'show', page: PAGE, version: 'plain', total: 1 });
  };
  ex = new Explainer({ root: ROOT, dataDir, toBrain, coreHome: () => null });
  const logs = [];
  ex.handle({ type: 'xw', op: 'show', page: PAGE, version: 'plain', total: 1 });
  ex.win.webContents.on('console-message', (_e, level, message) => level >= 2 && logs.push(message));
  for (let i = 0; i < 60 && sent.filter((m) => m.op === 'render').length < 3; i++) await wait(200);
  const renders = sent.filter((m) => m.op === 'render');
  ok(ex.win.isVisible(), '讲解窗口开出来了');
  ok(renders.filter((r) => r.ok).map((r) => r.block).sort().join(',') === 'b2,b4', '真实的安全策略下流程图、时序图都画出来了', JSON.stringify(renders));
  ok(renders.some((r) => r.block === 'b7' && !r.ok && /Parse error/.test(r.error)), '写错的图报回去了（大脑会拿去改）');
  const info = await ex.win.webContents.executeJavaScript(`({ nodes: [...document.querySelectorAll('.xnode')].map(g => g.dataset.node), actors: [...document.querySelectorAll('.k-diagram')][1]?.querySelectorAll('.xnode').length || 0 })`);
  ok(['mic', 'kws', 'vad', 'asr', 'brain', 'tts'].every((n) => info.nodes.includes(n)) && info.actors >= 2, '流程图的节点、时序图的参与者都认出来了（能点、能亮）', JSON.stringify(info));
  // 边念边指：亮第 1 步（麦克风、唤醒词）
  ex.handle({ type: 'xw', op: 'narr', page: 'live-1', version: 'plain', status: 'playing', i: 1, n: 4, step: { block: 'b3', index: 0, nodes: ['mic', 'kws'] }, stepNo: 1, steps: 3, title: '唤醒词', say: '第一关，唤醒词。系统一直在听。', full: true });
  await wait(600);
  const lit = await ex.win.webContents.executeJavaScript(`[...document.querySelectorAll('.hl')].map(e => e.dataset.node || 'card' + e.dataset.k).join(',')`);
  ok(lit === 'mic,kws,card0' || lit === 'card0,mic,kws', '边念边指：分步卡片和图上的节点一起亮', lit);
  await ex.win.webContents.executeJavaScript('document.getElementById("doc").scrollTop = 0');
  await wait(300);
  fs.writeFileSync(path.join(OUT, '1-explainer.png'), (await ex.win.webContents.capturePage()).toPNG());
  // 模拟：sim.html 里的脚本跑起来了
  const simRan = await ex.win.webContents.executeJavaScript(`new Promise((r) => { addEventListener('message', (e) => e.data?.simRan && r(true)); const f = document.querySelector('.sim iframe'); f && f.contentWindow && f.src && setTimeout(() => r(false), 3000); f.src = f.src; })`);
  ok(simRan, '模拟：大脑写的小程序在沙箱里跑起来了');
  // 截图自检
  ex.handle({ type: 'xw', op: 'capture', id: 9, page: 'live-1', version: 'plain', blocks: ['b2', 'b5'] });
  for (let i = 0; i < 30 && !sent.some((m) => m.op === 'capture_result'); i++) await wait(200);
  const cap = sent.find((m) => m.op === 'capture_result');
  ok(cap?.ok && cap.images.length === 2 && cap.images[0].data.length > 1000, '截图自检：只截讲解窗口里那几块', cap ? `${cap.images.length} 张` : '没回');
  if (cap?.images[0]) fs.writeFileSync(path.join(OUT, '2-capture-b2.jpg'), Buffer.from(cap.images[0].data, 'base64'));
  // 浏览器打开：存成一个 HTML
  await ex.win.webContents.executeJavaScript('document.getElementById("browser").click()');
  await wait(500);
  const html = path.join(dataDir, 'explainers', 'live-1.html');
  ok(fs.existsSync(html) && /^file:/.test(opened || ''), '「浏览器打开」：存成 HTML 交给默认浏览器（测试里没真打开）');
  ok(!logs.some((l) => /Content Security Policy|Refused/.test(l)), '没有被安全策略拦下的东西', logs.filter((l) => /Content Security Policy|Refused/.test(l)).join(' | '));
  ex.handle({ type: 'xw', op: 'close' });

  // ---- 效果层：就地讲解、教学的标注 ----
  const d = screen.getPrimaryDisplay();
  const bounds = { x: d.workArea.x + 120, y: d.workArea.y + 140, width: 760, height: 460 };
  const fake = new BrowserWindow({ ...bounds, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, backgroundColor: '#1f2128' });
  await fake.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;background:#1f2128;color:#d9dce5;font:13px 'Microsoft YaHei UI'">
    <div style="padding:6px 10px;background:#2a2d36">假的 OBS（测试窗口）</div><div style="height:250px;margin:8px 10px;border:1px solid #343846;display:grid;place-items:center;color:#6c7488">预览</div>
    <div style="display:flex;gap:8px;padding:0 10px"><div id=a style="flex:1;height:120px;background:#262931;border:1px solid #343846">场景</div><div id=b style="flex:1;height:120px;background:#262931;border:1px solid #343846">来源</div><div id=c style="flex:1;height:120px;background:#262931;border:1px solid #343846">控件</div></div></body>`));
  fake.showInactive();
  await wait(400);
  const rects = await fake.webContents.executeJavaScript(`['a','b','c'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })`);
  const phys = (r) => screen.dipToScreenRect(null, { x: Math.round(bounds.x + r.x), y: Math.round(bounds.y + r.y), width: Math.round(r.width), height: Math.round(r.height) });
  const winPhys = screen.dipToScreenRect(null, bounds);
  const fx = new FxLayer({ coreDisplay: () => d, coreHome: () => null });
  const route = (m) => fx.route({ type: 'fx', kind: 'guide', ...m });
  route({ phase: 'frame', key: 'tour', rect: winPhys });
  rects.forEach((r, k) => route({ phase: 'mark', key: 'tour', n: k + 1, rect: phys(r), state: k === 1 ? 'cur' : k < 1 ? 'past' : 'later' }));
  route({ phase: 'focus', key: 'tour', mode: 'tour', rect: phys(rects[1]), label: '2 · 来源', name: '来源', text: '画面里放什么：摄像头、游戏窗口、图片、文字，都在这里加。', sub: '2 / 3' });
  await wait(1500);
  const shot = async (name) => {
    const phy = screen.dipToScreenRect(null, d.bounds);
    const src = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: phy.width, height: phy.height } })).find((s) => s.display_id === String(d.id));
    const k = src.thumbnail.getSize().width / phy.width;
    // 只截测试窗口自己那一块，别把宿主屏幕上别的软件截进来
    const crop = { x: Math.round((winPhys.x - phy.x + 8) * k), y: Math.round((winPhys.y - phy.y + 8) * k), width: Math.round((winPhys.width - 16) * k), height: Math.round((winPhys.height - 16) * k) };
    fs.writeFileSync(path.join(OUT, name), src.thumbnail.crop(crop).toPNG());
  };
  await shot('3-point-out.png');
  // 教学：「点这里」
  route({ phase: 'clear', key: 'tour', rect: winPhys });
  route({ phase: 'frame', key: 'tutor', rect: winPhys });
  route({ phase: 'focus', key: 'tutor', mode: 'tutor', rect: phys(rects[2]), label: '点这里', text: '点「控件」里的开始直播', sub: '2 / 4' });
  route({ phase: 'hint', key: 'tutor', rect: phys(rects[2]), text: '不是这里，要点的是亮着的那个' });
  await wait(900);
  await shot('4-tutor.png');
  route({ phase: 'clear', key: 'tutor', rect: winPhys });
  await wait(300);
  fake.destroy();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
  console.log(`\n截图在 ${OUT}`);
  console.log(`${fails ? '有失败' : '全部通过'}：${passes} 过，${fails} 败`);
  app.exit(fails ? 1 : 0);
});
app.on('window-all-closed', () => {});
