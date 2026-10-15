// 讲解的端到端测试：起一个假模型，拉起真的后台进程（大脑 + 讲解），假装自己是讲解窗口和面板。
// 走一遍：宿主说「画图讲讲」→ 大脑调 explain → 画图模型一块块写 → 窗口回报画好了 / 截图自检 → 图解卡 → 宿主点图展开 → 新的一页接在下面
// node tools/test-explain-brain.mjs
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-explain-e2e-'));
const PORT = 5196;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1', input: ['text', 'image'] }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, computerUse: { enabled: false }, browser: { enabled: false }, watch: { downloads: false, battery: false, live: false }, memory: { enabled: false, autoReview: false, embed: { chat: false } } }));

let fails = 0;
let passes = 0;
function ok(cond, name, extra = '') {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`);
}

// ---- 假模型 ----
const seen = { gen: 0, check: 0, agent: [], tools: [], system: '' };
const PAGE = [
  { kind: 'summary', text: '三次握手是为了确认双方都能收发。' },
  { kind: 'diagram', title: '握手', mermaid: 'sequenceDiagram\n participant C as 客户端\n participant S as 服务器\n C->>S: SYN' },
  { kind: 'steps', title: '三步', items: [{ title: 'SYN', text: '客户端先问', say: '第一步。', nodes: ['C'] }, { title: 'ACK', text: '确认', say: '第二步。', nodes: ['S'] }] },
  { kind: 'analogy', text: '像打电话。' },
].map((b) => JSON.stringify(b)).join('\n');
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-1' };
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [chunks[i++]] })}\n\n`);
      setTimeout(tick, 8);
    } else {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  tick();
}
const text = (t) => [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }, ...t.match(/[\s\S]{1,9}/g).map((c) => ({ index: 0, delta: { content: c }, finish_reason: null })), { index: 0, delta: {}, finish_reason: 'stop' }];
const call = (id, name, args) => [
  { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null },
  { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null },
  { index: 0, delta: {}, finish_reason: 'tool_calls' },
];
const contentText = (c) => (typeof c === 'string' ? c : JSON.stringify(c || ''));
const server = http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = JSON.parse(body);
      const sys = contentText(json.messages.find((m) => m.role === 'system' || m.role === 'developer')?.content);
      if (/讲解绘制模块/.test(sys)) {
        seen.gen++;
        return sse(res, text(PAGE));
      }
      if (/检查一页图解讲解的截图/.test(sys)) {
        seen.check++;
        seen.checkHadImage = /image/.test(JSON.stringify(json.messages.at(-1).content));
        return sse(res, text('{"ok":true}'));
      }
      if (/只输出一个词/.test(sys)) return sse(res, text('yes'));
      seen.system = sys;
      seen.tools = (json.tools || []).map((t) => t.function.name);
      const lastUser = json.messages.map((m) => m.role).lastIndexOf('user');
      const after = json.messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
      const asked = contentText(json.messages[lastUser].content);
      seen.agent.push(asked);
      if (!after.length) return sse(res, call(`c${seen.agent.length}`, 'explain', /展开讲讲/.test(asked) ? { title: '客户端在干嘛', brief: '展开讲客户端' } : { title: 'TCP 三次握手', brief: '为什么要握三次' }));
      return sse(res, text('图解已生成，在讲解窗口里。'));
    });
  })
  .listen(PORT);

const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data') },
});
let errLog = '';
brain.stderr.on('data', (d) => (errLog += d));

const msgs = [];
const waiters = [];
brain.on('message', (m) => {
  if (m.type === 'level') return;
  msgs.push(m);
  // 假装是讲解窗口：图都画得出来；要截图就给一张
  if (m.type === 'xw' && m.op === 'block' && m.block.kind === 'diagram') brain.send({ type: 'xw_ui', op: 'render', page: m.page, version: m.version, block: m.block.id, ok: true });
  if (m.type === 'xw' && m.op === 'capture') brain.send({ type: 'xw_ui', op: 'capture_result', id: m.id, ok: true, images: m.blocks.map((b) => ({ block: b, data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg' })) });
  for (const w of [...waiters]) if (w.test(m)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(m);
  }
});
const wait = (test, ms = 20000) =>
  new Promise((resolve) => {
    const hit = msgs.find(test);
    if (hit) return resolve(hit);
    const w = { test, resolve };
    waiters.push(w);
    setTimeout(() => {
      if (waiters.includes(w)) waiters.splice(waiters.indexOf(w), 1);
      resolve(null);
    }, ms);
  });
function finish() {
  brain.kill();
  server.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  console.log(`\n${fails ? '有失败' : '全部通过'}：${passes} 过，${fails} 败`);
  if (fails) console.log('--- brain stderr ---\n' + errLog.slice(-3000));
  process.exit(fails ? 1 : 0);
}
setTimeout(() => {
  console.log('超时');
  fails++;
  finish();
}, 60000);

const ready = await wait((m) => m.type === 'brain_ready' || m.type === 'brain_missing');
ok(ready?.type === 'brain_ready', '后台起来了，大脑连上假模型');
brain.send({ type: 'prompt', text: '画图给我讲讲 TCP 三次握手' });
const done = await wait((m) => m.type === 'done');
ok(seen.tools.includes('explain') && seen.tools.includes('explain_open'), '大脑有 explain / explain_open 工具', seen.tools.join(','));
ok(!seen.tools.includes('point_out'), '没开「操作软件」时没有就地讲解 / 教学工具');
ok(/讲东西：画图讲解/.test(seen.system) && /别把讲解内容再说一遍/.test(seen.system), '系统提示里有「讲东西」这一节');
ok(seen.gen === 1, '画图模块另开了一次模型调用');
const show = msgs.find((m) => m.type === 'xw' && m.op === 'show');
const blocks = msgs.filter((m) => m.type === 'xw' && m.op === 'block');
ok(show && blocks.length === 4 && msgs.indexOf(show) < msgs.indexOf(blocks[0]), '讲解窗口先打开，4 块积木一块块送过去', `show=${!!show} blocks=${blocks.length}`);
ok(seen.check === 1 && seen.checkHadImage, '画完截图自检了一次（带着截图）');
const card = msgs.filter((m) => m.type === 'explain_card').at(-1);
ok(card?.page.done && /2 步/.test(card.page.meta) && card.page.summary.startsWith('三次握手'), '面板里的图解卡：画完、2 步、带结论', JSON.stringify(card?.page));
ok(done?.text === '图解已生成，在讲解窗口里。', '大脑最后只回一句话');
const tool = msgs.find((m) => m.type === 'tool' && m.name === 'explain');
ok(tool?.text === '画图讲解：TCP 三次握手', '面板里的动作写成「画图讲解：主题」', tool?.text);
const pageId = show.page.id;
ok(fs.existsSync(path.join(tmp, 'data', 'explainers', `${pageId}.json`)), '讲解存进 data/explainers');

// 宿主在讲解窗口里点了图上的「客户端」
brain.send({ type: 'xw_ui', op: 'expand', page: pageId, labels: ['客户端'] });
const heard = await wait((m) => m.type === 'heard' && /展开讲讲/.test(m.text));
ok(!!heard, '点图展开：面板里冒出宿主这一问');
await wait((m) => m.type === 'done' && msgs.filter((x) => x.type === 'done').length >= 2);
const show2 = msgs.filter((m) => m.type === 'xw' && m.op === 'show').at(-1);
ok(show2 && show2.page.id !== pageId && show2.page.parent === pageId && show2.page.crumb?.[0]?.id === pageId, '点图展开：新的一页接在原来那页下面，路径能跳回去', JSON.stringify(show2?.page?.crumb));
ok(/点了「客户端」）展开讲讲这一块/.test(seen.agent.at(-1)), '点图展开：大脑收到的是「宿主点了图上哪一块，展开讲讲」', seen.agent.at(-1));

// 面板图解卡上点「打开」、托盘「讲解窗口」打开最近一页
const n = msgs.length;
brain.send({ type: 'explain_open', id: pageId });
const reopen = await wait((m, i) => m.type === 'xw' && m.op === 'show' && m.page.id === pageId && msgs.indexOf(m) >= n);
ok(!!reopen && reopen.page.no === 1 && reopen.total === 2, '图解卡「打开」：讲解窗口翻到那一页（第 1 / 2 页）');
const n2 = msgs.length;
brain.send({ type: 'explain_open' });
const latest = await wait((m) => m.type === 'xw' && m.op === 'show' && msgs.indexOf(m) >= n2);
ok(latest?.page.id === show2.page.id, '托盘「讲解窗口」：打开最近一页');
// 窗口里翻页
const n3 = msgs.length;
brain.send({ type: 'xw_ui', op: 'get', no: 1 });
const flipped = await wait((m) => m.type === 'xw' && m.op === 'show' && msgs.indexOf(m) >= n3);
ok(flipped?.page.id === pageId, '讲解窗口里翻到第 1 页');
finish();
