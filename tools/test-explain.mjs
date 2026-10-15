// 讲东西的测试（假模型、假屏幕，不开窗口）：node tools/test-explain.mjs
// 1. 积木：边写边切、字段检查   2. 宿主的短句（停一下、下一步、你来……）
// 3. 画一页：一块块交给窗口、图画不出来自动改、截图自检、存档、换深浅
// 4. 边念边指：念完一段才亮下一步，暂停、下一步
// 5. 就地讲解：一个个标、宿主一点鼠标就暂停、窗口挪了标注跟着挪
// 6. 手把手教学：点错提示、点对了界面变了才算、你来做这步、存小结
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockParser, normBlock, parseGuideCmd, Explain, VoiceLine } from '../brain/explain.mjs';
import { Guide } from '../brain/guide.mjs';

let fails = 0;
let passes = 0;
function ok(cond, name, extra = '') {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-explain-'));

// ---------- 1. 积木 ----------
{
  const p = new BlockParser();
  const lines = [
    '好的，下面是讲解：',
    '```json',
    '{"kind":"summary","text":"结论一句话。"}',
    '{"kind":"diagram","title":"主图","mermaid":"flowchart LR\\n  A[\\"甲\\"] --> B[\\"乙\\"]"}',
    '{"kind":"steps","title":"分步","items":[{"title":"第一步","text":"说明","say":"第一步，念这个。","nodes":["A"]}]}',
    '{"kind":"unknown","text":"不认识的"}',
    '{"kind":"table",',
    ' "rows":[["","甲","乙"],["快慢","快","慢"]]}',
    '```',
    '{"kind":"analogy","text":"打个比方"}',
  ].join('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 7) out.push(...p.push(lines.slice(i, i + 7)));
  out.push(...p.flush());
  ok(out.map((b) => b.kind).join(',') === 'summary,diagram,steps,table,analogy', '积木：切成小段流进来也能拼对，跳过闲话、代码块标记和不认识的', out.map((b) => b.kind).join(','));
  ok(out[1].mermaid.includes('\n') && out[2].items[0].nodes[0] === 'A', '积木：Mermaid 的换行、分步对应的节点都留着');
  ok(normBlock({ kind: 'bars', items: [{ label: 'a', value: 'x' }] }) === null, '积木：数据图的值不是数字就不要');
  ok(normBlock({ kind: 'steps', items: Array.from({ length: 20 }, (_, i) => ({ title: `s${i}`, text: 't' })) }).items.length === 8, '积木：分步最多 8 步');
  ok(normBlock({ kind: 'diagram', mermaid: '```mermaid\nflowchart LR\nA-->B\n```' }).mermaid === 'flowchart LR\nA-->B', '积木：图外面包着代码块标记也能去掉');
}

// ---------- 2. 短句 ----------
{
  const cases = [
    ['停一下', 'pause'], ['系统，暂停一下', 'pause'], ['继续', 'resume'], ['下一步', 'next'], ['上一个', 'prev'], ['这步再讲一遍', 'redo'],
    ['你来', 'do'], ['你来做吧', 'do'], ['跳过', 'skip'], ['好了', 'done'], ['做好了', 'done'], ['退出教学', 'exit'], ['算了', 'exit'], ['再指一遍', 'again'],
    ['帮我打开记事本', null], ['下一步怎么做才能导出视频', null], ['好', null], ['继续帮我把文件整理完', null],
  ];
  const bad = cases.filter(([t, want]) => parseGuideCmd(t) !== want);
  ok(!bad.length, `短句：${cases.length} 条正反例`, bad.map(([t, w]) => `${t}→${parseGuideCmd(t)}（应为 ${w}）`).join('；'));
}

// ---------- 假模型 ----------
const MODEL = { provider: 'mock', id: 'm1', input: ['text', 'image'] };
function fakeRuntime(script) {
  const calls = { stream: [], complete: [] };
  return {
    calls,
    getAvailable: async () => [MODEL, { provider: 'mock', id: 'big', input: ['text'] }],
    streamSimple(model, ctx) {
      calls.stream.push({ model, ctx });
      const text = script.stream(ctx, model);
      return (async function* () {
        for (let i = 0; i < text.length; i += 11) {
          await sleep(2);
          yield { type: 'text_delta', delta: text.slice(i, i + 11) };
        }
        yield { type: 'done' };
      })();
    },
    async completeSimple(model, ctx) {
      calls.complete.push({ model, ctx });
      return { content: [{ type: 'text', text: script.complete(ctx, model) }] };
    },
  };
}
const PAGE_JSONL = [
  { kind: 'summary', text: '三次握手是为了确认双方都能收发。' },
  { kind: 'diagram', title: '握手', mermaid: 'sequenceDiagram\n participant C as 客户端\n participant S as 服务器\n C->>S: SYN BROKEN' },
  { kind: 'steps', title: '三步', items: [{ title: 'SYN', text: '客户端先问', say: '第一步，客户端发 SYN。', nodes: ['C'] }, { title: 'SYN-ACK', text: '服务器回', say: '第二步，服务器回 SYN-ACK。', nodes: ['S'] }, { title: 'ACK', text: '客户端确认', say: '第三步，客户端确认。', nodes: ['C', 'S'] }] },
  { kind: 'analogy', text: '像打电话：喂听得到吗、听得到你呢、好的。' },
  { kind: 'bars', title: '耗时', unit: '毫秒', items: [{ label: 'SYN', value: 10 }, { label: 'ACK', value: 12 }] },
].map((b) => JSON.stringify(b)).join('\n');

// 假的讲解窗口：图里有 BROKEN 就报画不出来；要截图就给一张假图
function fakeWindow(explainRef, log) {
  return (m) => {
    log.push(m);
    if (m.type !== 'xw') return;
    if (m.op === 'block' && m.block.kind === 'diagram') {
      const broken = /BROKEN/.test(m.block.mermaid);
      setTimeout(() => explainRef.e.fromWindow({ op: 'render', page: m.page, version: m.version, block: m.block.id, ok: !broken, error: broken ? 'Parse error on line 4' : undefined }), 5);
    }
    if (m.op === 'capture') setTimeout(() => explainRef.e.fromWindow({ op: 'capture_result', id: m.id, ok: true, images: m.blocks.map((b) => ({ block: b, data: 'AAAA', mimeType: 'image/jpeg' })) }), 5);
  };
}

// ---------- 3. 画一页 ----------
{
  const log = [];
  const ref = {};
  let fixes = 0;
  const rt = fakeRuntime({
    stream: (ctx) => (/深浅：pro/.test(ctx.messages[0].content) ? PAGE_JSONL.replace('三次握手是为了确认双方都能收发。', '专业版：同步序列号并确认双向可达。') : PAGE_JSONL),
    complete: (ctx) => {
      if (/检查一页图解讲解的截图/.test(ctx.systemPrompt)) return '{"block":"b5","problem":"柱子太挤","fix":"加个单位"}';
      const asked = typeof ctx.messages[0].content === 'string' ? ctx.messages[0].content : '';
      if (/kind":"bars/.test(asked)) return '{"kind":"bars","title":"耗时（改过）","unit":"毫秒","items":[{"label":"SYN","value":10},{"label":"ACK","value":12}]}';
      fixes++;
      return fixes === 1 ? '{"kind":"diagram","title":"握手","mermaid":"sequenceDiagram\\n C->>S: SYN BROKEN again"}' : '{"kind":"diagram","title":"握手","mermaid":"sequenceDiagram\\n participant C as 客户端\\n participant S as 服务器\\n C->>S: SYN"}';
    },
  });
  const cfg = { explain: { selfCheck: true, model: '' } };
  const e = new Explain({ dir: path.join(tmp, 'explainers'), cfg, out: fakeWindow(ref, log), runtime: () => rt, model: () => MODEL });
  ref.e = e;
  const r = await e.run({ title: 'TCP 三次握手', brief: '为什么要三次', depth: 'plain' });
  const id = r.details.page;
  const page = e.load(id);
  const blocks = page.versions.plain.blocks;
  ok(blocks.map((b) => b.kind).join(',') === 'summary,diagram,steps,analogy,bars', '画一页：积木按顺序存下来', blocks.map((b) => b.kind).join(','));
  const shows = log.filter((m) => m.type === 'xw' && m.op === 'show');
  const firstBlock = log.findIndex((m) => m.type === 'xw' && m.op === 'block');
  ok(shows.length >= 1 && log.indexOf(shows[0]) < firstBlock, '画一页：窗口先打开，积木再一块块进来');
  ok(fixes === 2 && !/BROKEN/.test(blocks[1].mermaid), '画一页：图画不出来就把报错发回去改，改了两次画好了', `fixes=${fixes} mermaid=${blocks[1].mermaid}`);
  ok(blocks[4].title === '耗时（改过）', '画一页：截图自检发现的问题只改那一块', blocks[4].title);
  ok(log.some((m) => m.type === 'xw' && m.op === 'capture'), '画一页：自检时让窗口截了图');
  ok(log.some((m) => m.type === 'explain_card' && m.page.id === id && m.page.done), '画一页：面板里有图解卡，画完标成完成');
  ok(/已画好第 1 页/.test(r.content[0].text) && /别把讲解内容再说一遍/.test(r.content[0].text), '画一页：工具结果告诉大脑别再念一遍');
  ok(e.index().length === 1 && fs.existsSync(path.join(tmp, 'explainers', `${id}.json`)), '画一页：存进 data/explainers');
  // 换成专业版：现写一个版本，两个都留着
  await e.switchDepth(id, 'pro');
  const both = e.load(id);
  ok(both.versions.plain.blocks.length === 5 && /专业版/.test(both.versions.pro.blocks[0].text) && both.depth === 'pro', '换深浅：专业版现写，说人话版还在');
  // 再切回来：不用再写
  const streams = rt.calls.stream.length;
  await e.switchDepth(id, 'plain');
  ok(rt.calls.stream.length === streams, '换深浅：切回已经有的版本不用再写');
  // 宿主点了图上的「客户端」：问大脑，新的一页接在这一页下面
  let asked = null;
  e.on('ask', (a) => (asked = a));
  await e.fromWindow({ op: 'expand', page: id, labels: ['客户端'] });
  ok(asked && /展开讲讲/.test(asked.text) && /用 explain 画新的一页/.test(asked.text), '点图展开：变成一句话交给大脑');
  const r2 = await e.run({ title: '客户端在干嘛', brief: '展开' });
  ok(e.load(r2.details.page).parent === id && e.crumb(e.load(r2.details.page))[0]?.id === id, '点图展开：新的一页接在原来那页下面（路径能跳回去）');
  ok(e.search('握手')[0]?.id === id, '找以前的讲解：按关键词找得到');
  // 模型不支持看图：不截图自检
  const rt2 = fakeRuntime({ stream: () => PAGE_JSONL.replace(' BROKEN', ''), complete: () => '{"ok":true}' });
  const log2 = [];
  const ref2 = {};
  const e2 = new Explain({ dir: path.join(tmp, 'explainers2'), cfg, out: fakeWindow(ref2, log2), runtime: () => rt2, model: () => ({ provider: 'mock', id: 'text-only', input: ['text'] }) });
  ref2.e = e2;
  await e2.run({ title: '不能看图的模型', brief: 'x' });
  ok(!log2.some((m) => m.type === 'xw' && m.op === 'capture'), '自检：模型看不了图就不截图');
  // 设置里选了画图用的模型
  cfg.explain.model = 'mock/big';
  await e2.run({ title: '换模型', brief: 'x' });
  ok(rt2.calls.stream.at(-1).model.id === 'big', '画图用的模型：设置里选了就用它');
  cfg.explain.model = '';
}

// ---------- 4. 边念边指 ----------
{
  const out = [];
  let segN = 0;
  const mouth = { mode: 'gpu', ready: true, gen: 0, said: [], sayTagged(text) { this.said.push(text); return [++segN]; }, stop() { this.gen++; } };
  const voice = new VoiceLine({ mouth, out: (m) => out.push(m) });
  // 面板：每段念 30 毫秒就报告念完
  const panel = setInterval(() => {
    for (const m of out.splice(0)) if (m.type === 'explain_narr') setTimeout(() => voice.spoken(m.key), 30);
  }, 5);
  const e = new Explain({ dir: path.join(tmp, 'narr'), cfg: { explain: {} }, out: () => {}, runtime: () => null, model: () => null });
  e.voice = voice;
  e.narrator.voice = voice;
  const states = [];
  e.narrator.on('state', (st) => states.push(st));
  const blocks = PAGE_JSONL.split('\n').map((l) => normBlock(JSON.parse(l))).map((b, i) => ({ ...b, id: `b${i + 1}` }));
  e.narrator.load('p1', 'plain', blocks, { complete: true, play: true });
  await until(() => e.narrator.status === 'done', 6000);
  ok(mouth.said.length === 4 && mouth.said[0].startsWith('三次握手'), '边念边指：先念结论，再一步一步念', mouth.said.join(' | '));
  const lit = states.filter((s) => s.status === 'playing' && s.step).map((s) => s.step.nodes.join('+'));
  ok(lit.join(',') === 'C,S,C+S', '边念边指：念到哪一步，亮哪几个节点', lit.join(','));
  // 暂停：嘴停下；下一步：从下一步接着念
  mouth.said = [];
  e.narrator.go(1, true);
  await until(() => mouth.said.length === 1);
  e.narrator.pause();
  ok(e.narrator.status === 'paused' && mouth.gen > 0, '边念边指：暂停时嘴停下');
  e.narrator.next();
  await until(() => mouth.said.length === 2);
  ok(mouth.said[1] === '第二步，服务器回 SYN-ACK。', '边念边指：「下一步」从下一步接着念', mouth.said.join(' | '));
  e.narrator.stop();
  // 声音关着：只亮不念，等宿主翻
  mouth.mode = 'off';
  mouth.said = [];
  e.narrator.load('p2', 'plain', blocks, { complete: true, play: true });
  await sleep(100);
  ok(e.narrator.status === 'paused' && mouth.said.length === 0, '边念边指：系统声音关着时只亮不念');
  e.narrator.next();
  ok(e.narrator.i === 1 && e.narrator.status === 'paused', '边念边指：声音关着时「下一步」只往后翻');
  clearInterval(panel);
}

// ---------- 5、6. 就地讲解、教学 ----------
function fakeScreen() {
  const s = {
    available: true,
    win: { x: 100, y: 100, width: 800, height: 600 },
    sig: 'A',
    elements: { 1: { x: 120, y: 500, width: 100, height: 30 }, 2: { x: 300, y: 500, width: 100, height: 30 }, 3: { x: 500, y: 500, width: 100, height: 30 } },
    rectOf: () => ({ ...s.win }),
    isWindow: () => true,
    titleOf: () => 'OBS 32.0',
    async locate(app, { element, x, y }) {
      if (element != null) return { w: { wid: 7 }, rect: { ...s.elements[element] }, name: `按钮${element}`, est: false };
      return { w: { wid: 7 }, rect: { x: x - 24, y: y - 24, width: 48, height: 48 }, name: '', est: true };
    },
    async fingerprint() {
      return { sig: s.sig, count: 5, image: 'UE5H' };
    },
  };
  return s;
}
{
  const fx = [];
  const out = [];
  const operator = { userInputAt: 0, fx: (kind, data) => fx.push({ kind, ...data }) };
  const scr = fakeScreen();
  const voiceLog = [];
  const voice = { mouth: { mode: 'gpu', say: (t) => voiceLog.push(t), stop() {} }, async speak(text, cancelled) {
    voiceLog.push(text);
    for (let i = 0; i < 6; i++) {
      if (cancelled()) return 'cancelled';
      await sleep(10);
    }
    return 'done';
  } };
  const g = new Guide({ screen: scr, operator, voice, explain: null, out: (m) => out.push(m), log: () => {} });
  const tools = Object.fromEntries(g.tools().map((t) => [t.name, t]));
  const r = await tools.point_out.execute('1', { app: 'OBS', items: [{ element: 1, name: '场景', say: '场景是一套画面布置。' }, { element: 2, name: '来源', say: '来源是画面里放什么。' }, { x: 520, y: 300, name: '预览', say: '这是预览。' }] });
  ok(/已开始/.test(r.content[0].text), '就地讲解：工具马上返回，讲解在后台进行');
  await until(() => g.tour?.status === 'done' || !g.tour, 3000);
  const focus = fx.filter((f) => f.phase === 'focus').map((f) => f.label);
  ok(focus.join(',') === '1 · 场景,2 · 来源,3 · 预览' && voiceLog.length === 3, '就地讲解：一个个框住、边指边念', focus.join(','));
  ok(fx.some((f) => f.phase === 'focus' && f.est), '就地讲解：按截图坐标估的位置标成虚线');
  ok(out.some((m) => m.type === 'guide' && m.state.status === 'done'), '就地讲解：讲完面板卡片标成讲完了');
  await sleep(1600);
  ok(fx.at(-1).phase === 'clear', '就地讲解：讲完自动收起');
  // 宿主点了一下鼠标：暂停；窗口挪了：标注跟着挪
  fx.length = 0;
  await tools.point_out.execute('2', { app: 'OBS', items: [{ element: 1, name: '场景', say: '一' }, { element: 2, name: '来源', say: '二' }] });
  await sleep(5);
  operator.userInputAt = Date.now() + 1000;
  await until(() => g.tour?.status === 'paused');
  ok(g.tour?.status === 'paused', '就地讲解：宿主一点鼠标就暂停');
  scr.win = { x: 160, y: 140, width: 800, height: 600 };
  g.tourCmd('resume');
  await until(() => fx.some((f) => f.phase === 'focus' && f.rect.x === 180));
  ok(fx.some((f) => f.phase === 'focus' && f.rect.x === 180 && f.rect.y === 540), '就地讲解：窗口挪了，标注跟着挪');
  g.tourCmd('exit');
  ok(!g.tour && fx.at(-1).phase === 'clear', '就地讲解：退出就收起');

  // ---- 教学（窗口回到原位） ----
  scr.win = { x: 100, y: 100, width: 800, height: 600 };
  const ex = new Explain({ dir: path.join(tmp, 'tutor'), cfg: { explain: {} }, out: (m) => out.push(m), runtime: () => null, model: () => null });
  g.explain = ex;
  fx.length = 0;
  out.length = 0;
  const step1 = tools.tutor_step.execute('3', { app: 'OBS', index: 1, title: '添加窗口采集', steps: ['选中场景', '点加号'], say: '先选中游戏场景', element: 1 });
  await until(() => out.some((m) => m.type === 'watch_clicks' && m.on));
  ok(fx.some((f) => f.phase === 'focus' && f.mode === 'tutor' && f.label === '点这里'), '教学：亮出要点的地方');
  await g.onClick(700, 300); // 点在窗口里、但不是那个按钮
  ok(fx.some((f) => f.phase === 'hint') && out.some((m) => m.type === 'tutor' && /点错了/.test(m.state.warn)), '教学：点错了提示');
  await g.onClick(700, 300);
  await g.onClick(700, 300);
  ok(out.some((m) => m.type === 'tutor' && /3 次/.test(m.state.warn)), '教学：点错 3 次问要不要系统来做');
  await g.onClick(20, 20); // 点在窗口外面（比如面板）：不算
  ok(g.tutor.wait.wrong === 3, '教学：点在窗口外面不算点错');
  setTimeout(() => (scr.sig = 'B'), 300); // 宿主点对以后界面变了
  await g.onClick(150, 515);
  const r1 = await step1;
  ok(/做完了第 1 步/.test(r1.content[0].text) && /read_app/.test(r1.content[0].text), '教学：点对了、界面变了才算做完', r1.content[0].text);
  ok(out.some((m) => m.type === 'watch_clicks' && m.on === false), '教学：这一步做完就不再听点击');
  // 第二步：宿主说「你来」
  const step2 = tools.tutor_step.execute('4', { app: 'OBS', index: 2, say: '点来源下面的加号', element: 2 });
  await until(() => g.tutor?.wait);
  await g.tutorCmd('do');
  const r2 = await step2;
  ok(/宿主让你来做第 2 步/.test(r2.content[0].text) && /click/.test(r2.content[0].text), '教学：「你来」交回给大脑用 click 做（照常走授权）');
  // 点对了但界面没变（读不出来变化）：问宿主做好了没
  scr.sig = 'C';
  const step3 = tools.tutor_step.execute('5', { app: 'OBS', index: 2, say: '再点一下加号', element: 2 });
  await until(() => g.tutor?.wait);
  await g.onClick(350, 515);
  ok(out.some((m) => m.type === 'tutor' && m.state.asking), '教学：点对了但看不出界面变没变，问一句「做好了吗」');
  await g.tutorCmd('done');
  const r3 = await step3;
  ok(/宿主说做好了/.test(r3.content[0].text), '教学：宿主说做好了就算');
  const fin = await tools.tutor_finish.execute('6', { summary: '学会了添加窗口采集。' });
  const tp = ex.load(fin.details.page);
  ok(tp && tp.kind === 'tutor' && tp.versions.plain.blocks.some((b) => b.kind === 'shot') && fs.existsSync(path.join(tmp, 'tutor', tp.versions.plain.blocks.find((b) => b.kind === 'shot').src)), '教学：做完存成一页小结，带每步截图');
  ok(out.some((m) => m.type === 'tutor' && m.state.status === 'done' && m.state.page === tp.id) && !g.tutor, '教学：面板卡片标成完成，能打开小结');
  // 宿主退出教学
  const step4 = tools.tutor_step.execute('7', { app: 'OBS', index: 1, title: '另一个', steps: ['a'], say: 'a', element: 1 });
  await until(() => g.tutor?.wait);
  await g.command('exit');
  const r4 = await step4;
  ok(/退出了教学/.test(r4.content[0].text) && !g.tutor && fx.at(-1).phase === 'clear', '教学：说「退出教学」就停下、收起标注');
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
console.log(`\n${fails ? '有失败' : '全部通过'}：${passes} 过，${fails} 败`);
process.exit(fails ? 1 : 0);
