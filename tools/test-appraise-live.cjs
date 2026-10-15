// 鉴定层实测（真的 Electron 窗口，假的「屏幕」：一张画好的图 + 假的窗口清单）：不截真屏幕、不碰别的软件、不抢焦点、不碰剪贴板。
// 用法：node_modules\electron\dist\electron.exe tools\test-appraise-live.cjs
// 选择层开在主屏左上角一块 900×560 的地方（自己开的窗口），用 sendInputEvent 模拟鼠标键盘。
const { app, screen, nativeImage, desktopCapturer } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Appraiser } = require('../app/appraise.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const SNAP = process.env.HOSTBOUND_SNAP || path.join(os.tmpdir(), 'hostbound-appraise-live');

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const prim = screen.getPrimaryDisplay();
  const bounds = { x: prim.workArea.x + 60, y: prim.workArea.y + 60, width: 900, height: 560 };
  const display = { id: 9001, bounds, workArea: bounds, scaleFactor: prim.scaleFactor };
  const phys = screen.dipToScreenRect(null, bounds);
  const k = phys.width / bounds.width;
  // 假的窗口（这块「屏幕」里的 DIP 坐标）：游戏、聊天软件、禁止操作的网银
  const W = [
    { hwnd: 11, title: '游戏 · 背包', exe: 'game.exe', dip: { x: 40, y: 60, width: 420, height: 300 }, color: [200, 60, 150] },
    { hwnd: 12, title: '聊天', exe: 'wechat.exe', dip: { x: 520, y: 80, width: 300, height: 250 }, color: [60, 190, 60] },
    { hwnd: 13, title: '网上银行', exe: 'bank.exe', dip: { x: 600, y: 380, width: 200, height: 150 }, color: [50, 50, 220] },
  ];
  // 画一张「屏幕」：深蓝底 + 三个色块（BGRA）
  const pw = phys.width;
  const ph = phys.height;
  const buf = Buffer.alloc(pw * ph * 4);
  const fill = (r, [b, g, rr]) => {
    for (let y = Math.round(r.y * k); y < Math.round((r.y + r.height) * k); y++) for (let x = Math.round(r.x * k); x < Math.round((r.x + r.width) * k); x++) buf.set([b, g, rr, 255], (y * pw + x) * 4);
  };
  fill({ x: 0, y: 0, width: bounds.width, height: bounds.height }, [70, 40, 20]);
  for (const w of W) fill(w.dip, w.color);
  const img = nativeImage.createFromBitmap(buf, { width: pw, height: ph });
  const rectOf = (h) => {
    const w = W.find((x) => x.hwnd === h);
    return screen.dipToScreenRect(null, { x: bounds.x + w.dip.x, y: bounds.y + w.dip.y, width: w.dip.width, height: w.dip.height });
  };
  let fg = 11;
  const win32 = {
    foreground: () => fg,
    pidOf: (h) => 1000 + h,
    topWindow: () => 11,
    userWindows: () => W.map((w) => w.hwnd),
    title: (h) => W.find((w) => w.hwnd === h)?.title || '',
    processMap: () => new Map(W.map((w) => [1000 + w.hwnd, w.exe])),
    rectOf,
    giveFocus: () => true,
  };
  const sent = [];
  const ap = new Appraiser({
    root: path.resolve(__dirname, '..'),
    toBrain: (m) => sent.push(m),
    blocked: () => ['网上银行'],
    win32,
    freeze: async () => new Map([[9001, { display, phys, img }]]),
    cursorDisplay: () => 9001,
    focusOnSelect: false,
  });
  const next = (type, ms = 4000) =>
    new Promise((resolve) => {
      const from = sent.length;
      const t0 = Date.now();
      const tick = () => {
        const hit = sent.slice(from).find((m) => m.type === type);
        if (hit || Date.now() - t0 > ms) return resolve(hit || null);
        setTimeout(tick, 40);
      };
      tick();
    });
  const ov = () => ap.wins.get(9001).win;
  const js = (code) => ov().webContents.executeJavaScript(code);
  const mouse = async (type, x, y, extra = {}) => {
    ov().webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra });
    await wait(40);
  };
  const click = async (x, y) => {
    await mouse('mouseMove', x, y);
    await mouse('mouseDown', x, y);
    await mouse('mouseUp', x, y);
  };
  const key = async (keyCode) => {
    ov().webContents.sendInputEvent({ type: 'keyDown', keyCode });
    ov().webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await wait(60);
  };
  const ready = async () => {
    for (let i = 0; i < 50 && !ap.wins.get(9001)?.ready; i++) await wait(100);
    await wait(250);
  };
  const decode = (m) => nativeImage.createFromBuffer(Buffer.from(m.image.data, 'base64'));
  const pixel = (im, x, y) => {
    const { width } = im.getSize();
    const b = im.toBitmap();
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    return [b[i + 2], b[i + 1], b[i]]; // RGB
  };
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40);
  const timer = setTimeout(() => {
    console.log('超时');
    app.exit(1);
  }, 90_000);

  try {
    // ---- 真屏幕：每块都对得上截图源（只要 1×1 的缩略图，不看内容），换算出来的物理大小对 ----
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    const all = screen.getAllDisplays();
    ok(`真屏幕 ${all.length} 块：每块都对得上截图源`, all.length === 1 || all.every((d) => srcs.some((x) => x.display_id === String(d.id))), JSON.stringify({ displays: all.map((d) => d.id), sources: srcs.map((x) => x.display_id) }));
    ok('真屏幕：DIP 换成物理像素对得上缩放', all.every((d) => Math.abs(screen.dipToScreenRect(null, d.bounds).width - d.bounds.width * d.scaleFactor) <= 2), JSON.stringify(all.map((d) => [d.bounds, d.scaleFactor, screen.dipToScreenRect(null, d.bounds)])));

    // ---- 选择：定格画面、高亮窗口 ----
    await ap.start('select');
    await ready();
    ok('进选择：只开在自己的测试区域，没抢焦点', JSON.stringify(ov().getBounds()) === JSON.stringify(bounds) && !ov().isFocused(), JSON.stringify(ov().getBounds()));
    ok('进选择：定格画面、提示条', (await js(`document.body.className === 'select' && getComputedStyle(frozen).display === 'block' && /鉴定模式/.test(hint.textContent)`)) === true);
    ok('告诉大脑：鉴定开着', sent.some((m) => m.type === 'appraise_state' && m.open));
    await mouse('mouseMove', 200, 200);
    ok('鼠标停在游戏窗口上：亮起来，标出名字和大小', /游戏 · 背包.*420|游戏 · 背包/.test(await js('lab.textContent')) && (await js(`!hole.classList.contains('hidden') && hole.style.width === '420px'`)) === true, await js('lab.textContent'));
    await mouse('mouseMove', 700, 450);
    ok('停在禁止操作的软件上：标红、说不能鉴定', /禁止操作/.test(await js('lab.textContent')) && (await js(`hole.className`)) === 'blocked');
    await mouse('mouseMove', 870, 20);
    ok('停在桌面上：整块屏幕', /整块屏幕/.test(await js('lab.textContent')));

    // ---- 拖一个框，带一句话，点鉴定 ----
    await mouse('mouseMove', 100, 100);
    await mouse('mouseDown', 100, 100);
    await mouse('mouseMove', 200, 150);
    await mouse('mouseMove', 300, 250);
    await mouse('mouseUp', 300, 250);
    ok('拖框：框、大小（物理像素）、按钮', (await js(`!reg.classList.contains('hidden') && !tool.classList.contains('hidden') && reg.querySelector('.size').textContent`)) === `${Math.round(200 * k)} × ${Math.round(150 * k)}`, await js(`reg.querySelector('.size').textContent`));
    await js(`document.querySelector('#t-ask').value = '值不值得换？'`);
    const go = await js(`(() => { const r = document.querySelector('#t-go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const reqP = next('appraise_req');
    await click(go.x, go.y);
    const req = await reqP;
    ok('点鉴定：裁好的图交给大脑，带上问的那句', req && req.kind === 'region' && req.question === '值不值得换？' && Math.abs(req.image.width - 200 * k) <= 2 && Math.abs(req.image.height - 150 * k) <= 2, JSON.stringify(req && { w: req.image.width, h: req.image.height, k }));
    ok('裁的是框住的那块（游戏窗口的颜色）', req && near(pixel(decode(req), req.image.width / 2, req.image.height / 2), [150, 60, 200]), req && JSON.stringify(pixel(decode(req), req.image.width / 2, req.image.height / 2)));
    ok('还有一张小缩略图', req && req.thumb.length > 100);
    await wait(300);
    ok('扫描：只留框住的那块，扫描线、鉴定中的卡片', (await js(`document.body.className === 'scan' && frame.className === 'scanning' && !card.classList.contains('hidden') && /鉴定中/.test(card.textContent)`)) === true);

    // ---- 卡片边出边显示 ----
    const id = req.id;
    ap.fromBrain({ type: 'appraise_part', id, part: 'name', key: '名称', value: '寒铁长剑' });
    ap.fromBrain({ type: 'appraise_part', id, part: 'rarity', key: '品质', value: '史诗' });
    ap.fromBrain({ type: 'appraise_part', id, part: 'field', key: '类别', value: '装备 · 单手剑' });
    ap.fromBrain({ type: 'appraise_part', id, part: 'field', key: '属性', value: '攻击 +128　暴击 +6%' });
    await wait(500);
    ok('边出边显示：名称、品质、属性', (await js(`card.querySelector('.nm').textContent.includes('寒铁长剑') && !!card.querySelector('.rar.epic') && card.querySelectorAll('.kv span').length === 4`)) === true, await js('card.textContent'));
    ap.fromBrain({ type: 'appraise_result', id, ok: true, card: { name: '寒铁长剑', rarity: '史诗', tag: '', style: 'rpg', fields: [['类别', '装备 · 单手剑'], ['属性', '攻击 +128　暴击 +6%']], verdict: '同等级里的上等货。', advice: '换。', actions: ['fix'], say: '' } });
    await wait(1200);
    const btns = await js(`[...card.querySelectorAll('.ops button')].map((b) => b.textContent)`);
    ok('出完：评价、建议、按钮', btns.join() === '追问,帮我处理,复制,✕' && /评价同等级里的上等货/.test(await js('card.textContent')), btns.join());
    const inside = await js(`(() => { const r = card.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
    ok('卡片放在框旁边、没出界', inside === true);
    ok('定格的那块淡掉，露出现在的画面', (await js(`frozen.classList.contains('fade')`)) === true);
    fs.mkdirSync(SNAP, { recursive: true });
    fs.writeFileSync(path.join(SNAP, 'card.png'), (await ov().webContents.capturePage()).toPNG());
    const fix = await js(`(() => { const b = [...card.querySelectorAll('.ops button')].find((x) => x.textContent === '帮我处理').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const actP = next('appraise_action');
    await click(fix.x, fix.y);
    const act = await actP;
    ok('点「帮我处理」：交给大脑，卡片收起', act?.action === 'fix' && act.id === id && !ov().isVisible() && sent.at(-1).type === 'appraise_state' && sent.at(-1).open === false);

    // ---- 点一下窗口 = 鉴定整个窗口 ----
    await ap.start('select');
    await ready();
    const winP = next('appraise_req');
    await click(200, 200);
    const wr = await winP;
    ok('点窗口：鉴定整个游戏窗口', wr?.kind === 'window' && wr.label === '游戏 · 背包' && Math.abs(wr.image.width - Math.min(1600, 420 * k)) <= 2, JSON.stringify(wr && { kind: wr.kind, label: wr.label, w: wr.image.width }));
    ap.fromBrain({ type: 'appraise_close' });
    await wait(200);
    ok('说「关掉」：收起', !ov().isVisible());

    // ---- 禁止操作的软件：点了没反应；框住一部分：那块涂黑再发 ----
    await ap.start('select');
    await ready();
    const none = next('appraise_req', 900);
    await click(700, 450);
    ok('点禁止操作的软件：不鉴定', !(await none));
    await mouse('mouseMove', 550, 350);
    await mouse('mouseDown', 550, 350);
    await mouse('mouseMove', 700, 450);
    await mouse('mouseMove', 850, 540);
    await mouse('mouseUp', 850, 540);
    const maskP = next('appraise_req');
    await key('Enter');
    const mr = await maskP;
    const mim = mr && decode(mr);
    // 框是 (550,350)-(850,540)：网银在 (600,380)-(800,530)，框里的 (150,105) 是网银中间；(20,10) 是桌面
    ok('框住一部分网银：那块涂黑', mr?.masked === 1 && near(pixel(mim, 150 * k * (mr.image.width / (300 * k)), 105 * k * (mr.image.height / (190 * k))), [0, 0, 0]) && near(pixel(mim, 20 * k * (mr.image.width / (300 * k)), 10 * k * (mr.image.height / (190 * k))), [20, 40, 70]), mr && JSON.stringify([pixel(mim, 150 * k, 105 * k), pixel(mim, 20 * k, 10 * k)]));
    ap.close('test');

    // ---- Esc 退出、F 整块屏幕 ----
    await ap.start('select');
    await ready();
    const escP = next('appraise_state');
    await key('Escape');
    const esc = await escP;
    ok('Esc：退出鉴定模式', esc && esc.open === false && esc.why === 'cancel' && !ov().isVisible());
    await ap.start('select');
    await ready();
    const fP = next('appraise_req', 3000);
    await key('F');
    const fr = await fP;
    ok('按 F：鉴定整块屏幕', fr?.kind === 'display' && Math.abs(fr.image.width - Math.min(1600, pw)) <= 2, JSON.stringify(fr && fr.image.width));
    ap.close('test');

    // ---- 直接鉴定当前窗口 ----
    const dirP = next('appraise_req');
    await ap.start('window');
    const dr = await dirP;
    ok('「鉴定一下这个窗口」：直接鉴定前台窗口，不进选择', dr?.kind === 'window' && dr.label === '游戏 · 背包');
    ap.close('test');

    // ---- 全屏扫描 ----
    const scanP = next('appraise_scan_req');
    await ap.start('screen');
    const sr = await scanP;
    await ready();
    const sw = sr?.screens[0].windows || [];
    ok('全屏扫描：窗口清单，聊天、网银标成涂黑', sw.length === 3 && sw.find((w) => w.exe === 'wechat.exe')?.masked && sw.find((w) => w.exe === 'bank.exe')?.masked && !sw.find((w) => w.exe === 'game.exe')?.masked, JSON.stringify(sw.map((w) => [w.exe, w.masked])));
    const sim = sr && nativeImage.createFromBuffer(Buffer.from(sr.screens[0].image.data, 'base64'));
    const sk = sim ? sim.getSize().width / bounds.width : 1;
    ok('全屏扫描：聊天软件、网银在图上涂黑，游戏没涂', sim && near(pixel(sim, 670 * sk, 200 * sk), [0, 0, 0]) && near(pixel(sim, 700 * sk, 450 * sk), [0, 0, 0]) && near(pixel(sim, 250 * sk, 200 * sk), [150, 60, 200]));
    await wait(300);
    ok('屏幕上：每个窗口一个标签，聊天、网银不用问模型', (await js(`document.querySelectorAll('.tag2').length`)) === 3 && /聊天内容不读/.test(await js(`document.querySelector('.tag2.priv').textContent`)) && /禁止操作/.test(await js(`document.querySelector('.tag2.block').textContent`)));
    const gw = sw.find((w) => w.exe === 'game.exe');
    ap.fromBrain({ type: 'appraise_tag', id: sr.id, windowId: gw.id, label: '在看背包，选中了一把剑' });
    ap.fromBrain({ type: 'appraise_scan_done', id: sr.id, verdict: '宿主正在玩游戏。', count: 3 });
    await wait(300);
    ok('标签填上、汇总卡', /在看背包/.test(await js(`document.querySelector('.tag2.click').textContent`)) && /检测到 3 个窗口/.test(await js('summary.textContent')) && /宿主正在玩游戏/.test(await js('summary.textContent')));
    fs.writeFileSync(path.join(SNAP, 'tags.png'), (await ov().webContents.capturePage()).toPNG());
    const tag = await js(`(() => { const r = document.querySelector('.tag2.click').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    const tagP = next('appraise_req');
    await click(tag.x, tag.y);
    const tr = await tagP;
    ok('点标签：鉴定那个窗口', tr?.kind === 'window' && tr.label === '游戏 · 背包');
    ap.close('test');
  } catch (e) {
    fails++;
    console.log('✗ 出错', e.stack || e.message);
  }
  clearTimeout(timer);
  console.log(`截图（只有测试窗口）：${SNAP}`);
  console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
  app.exit(fails ? 1 : 0);
});
