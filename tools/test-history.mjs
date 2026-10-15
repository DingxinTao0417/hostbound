// 阶段 3 端到端测试（假模型 + 临时数据目录，不碰真实数据）：node tools/test-history.mjs
// 任务记录、系统日志、对话存盘、重启后接着聊、大脑翻以前的对话、换话题、「打开设置」直接翻页、设置实时生效
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-history-'));
const PORT = 5197;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1', contextWindow: 200000 }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false } }));

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

// ---- 假模型：看最后一句宿主的话决定怎么回；记下每次请求里有哪些消息 ----
const requests = [];
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '');
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'm', object: 'chat.completion.chunk', created: 1, model: 'mock-1' };
  for (const c of chunks) res.write(`data: ${JSON.stringify({ ...base, choices: [c] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const say = (t) => [{ index: 0, delta: { role: 'assistant', content: t } }, { index: 0, delta: {}, finish_reason: 'stop' }];
const call = (name, args) => [
  { index: 0, delta: { tool_calls: [{ index: 0, id: `c${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
  { index: 0, delta: {}, finish_reason: 'tool_calls' },
];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    const msgs = j.messages;
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const userText = textOf(msgs[lastUser]?.content);
    const tools = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool');
    // pi 压缩对话时让模型写摘要：回一句短摘要
    if (/context summarization assistant/.test(textOf(msgs[0]?.content))) return sse(res, say('## 摘要\n宿主前面发了几段很长的测试资料。'));
    requests.push({ userText, all: msgs.map((m) => `${m.role}:${textOf(m.content)}`).join('\n'), tools: tools.map((t) => textOf(t.content)), toolNames: (j.tools || []).map((t) => t.function.name) });
    if (/跑个命令/.test(userText) && !tools.length) return sse(res, call('powershell', { command: "Get-Date -Format 'yyyy'" }));
    if (/翻一下/.test(userText) && !tools.length) return sse(res, call('search_chat', { query: '暗号' }));
    if (tools.length) return sse(res, say(`查到了：${textOf(tools.at(-1).content).includes('七加八') ? '暗号是七加八' : '没找到'}`));
    return sse(res, say(`收到：${userText.replace(/^（现在是[^）]*）\n/, '')}`));
  });
});
await new Promise((r) => server.listen(PORT, r));

// ---- 后台进程：发消息、等某种回复 ----
function startBrain() {
  const b = fork(path.join(root, 'brain', 'index.mjs'), [], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data') },
  });
  b.msgs = [];
  b.on('message', (m) => b.msgs.push(m));
  return b;
}
function waitFor(b, pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    const start = b.msgs.length;
    const t0 = Date.now();
    const tick = () => {
      const hit = b.msgs.slice(start).find(pred) || null;
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error('等不到：' + pred.toString().slice(0, 80)));
      setTimeout(tick, 30);
    };
    tick();
  });
}
async function ask(b, text) {
  const p = waitFor(b, (m) => m.type === 'done' || m.type === 'error');
  b.send({ type: 'prompt', text });
  return p;
}
let rq = 0;
async function query(b, msg) {
  const id = ++rq;
  const p = waitFor(b, (m) => m.reqId === id);
  b.send({ ...msg, reqId: id });
  return p;
}

const timer = setTimeout(() => {
  console.log('超时');
  process.exit(1);
}, 90000);

try {
  // ---- 第一次启动 ----
  let b = startBrain();
  await waitFor(b, (m) => m.type === 'brain_ready');
  let d = await ask(b, '记住暗号是七加八');
  ok('第一句：回复', d.text === '收到：记住暗号是七加八', d.text);
  d = await ask(b, '跑个命令');
  ok('第二句：调了命令再回复', /查到了/.test(d.text), d.text);
  const before = requests.length;
  b.send({ type: 'prompt', text: '系统，打开设置' });
  const nav = await waitFor(b, (m) => m.type === 'nav');
  ok('「打开设置」直接翻页', nav.page === 'set');
  await new Promise((r) => setTimeout(r, 300));
  ok('「打开设置」没去问模型', requests.length === before);

  const hist = await query(b, { type: 'history_query' });
  ok('任务记录：两条，新的在前', hist.items.length === 2 && hist.items[0].text === '跑个命令', JSON.stringify(hist.items.map((t) => t.text)));
  ok('任务记录：过程里有那条命令、做成了', hist.items[0].tools === 1 && hist.items[0].steps[0]?.ok === true && hist.items[0].result === 'ok', JSON.stringify(hist.items[0]));
  ok('任务记录：结果、打字还是语音', hist.items[1].answer === '收到：记住暗号是七加八' && hist.items[1].via === 'text');

  const log = await query(b, { type: 'log_query' });
  ok('系统日志：记了命令和完整的命令行', log.items.some((e) => e.type === 'cmd' && /Get-Date/.test(e.detail)), JSON.stringify(log.items.map((e) => e.type)));
  ok('系统日志：记了系统启动', log.items.some((e) => e.type === 'sys' && /系统启动/.test(e.text)));
  ok('系统日志：按类型筛', (await query(b, { type: 'log_query', logType: 'cmd' })).items.every((e) => e.type === 'cmd'));
  const live = waitFor(b, (m) => m.type === 'log_entry');
  b.send({ type: 'config', key: 'model.thinking', value: 'high', label: '思考深度 · 高' });
  ok('改设置：生效', !!(await waitFor(b, (m) => m.type === 'config_applied' && m.key === 'model.thinking')));
  ok('改设置：日志里记一笔、面板实时收到', /思考深度/.test((await live).entry.text));

  const chat = await query(b, { type: 'chat_history' });
  ok('对话存盘：读回四句', chat.items.length === 4 && chat.items[0].text === '记住暗号是七加八' && chat.items[0].role === 'user', JSON.stringify(chat.items.map((m) => m.text)));

  // ---- 重启：接着原来的对话 ----
  b.kill();
  await new Promise((r) => setTimeout(r, 500));
  b = startBrain();
  await waitFor(b, (m) => m.type === 'brain_ready');
  const n0 = requests.length;
  d = await ask(b, '翻一下以前说的暗号');
  const first = requests[n0];
  ok('重启后：大脑还看得到重启前的对话', /记住暗号是七加八/.test(first?.all || ''), (first?.all || '').slice(0, 300));
  ok('重启后：大脑有「翻以前的对话」工具', first?.toolNames.includes('search_chat'));
  ok('翻以前的对话：搜到了原文', /七加八/.test(requests.at(-1).tools.at(-1) || '') && d.text === '查到了：暗号是七加八', d.text);

  // ---- 换个话题：大脑的上下文清空，面板上看还是接着的 ----
  b.send({ type: 'new_session' });
  await waitFor(b, (m) => m.type === 'topic_reset');
  const n1 = requests.length;
  d = await ask(b, '新话题');
  ok('换话题后：大脑看不到以前的话了', !/暗号/.test(requests[n1]?.all || ''), (requests[n1]?.all || '').slice(0, 300));
  const chat2 = await query(b, { type: 'chat_history', limit: 100 });
  ok('换话题后：面板上还能往上翻到以前的', chat2.items.some((m) => m.text === '记住暗号是七加八') && chat2.items.some((m) => m.role === 'divider') && chat2.items.at(-1).text === '收到：新话题', JSON.stringify(chat2.items.map((m) => m.role + ':' + m.text)));
  const page = await query(b, { type: 'chat_history', limit: 2 });
  ok('往上翻：分页', page.items.length === 2 && page.more);

  // ---- 对话太长：超过预算就把前面的压缩成摘要（原文还在存盘里）----
  b.send({ type: 'config', key: 'conversation.contextBudget', value: 30000, label: '记得多长 · 3 万' });
  await waitFor(b, (m) => m.type === 'config_applied' && m.key === 'conversation.contextBudget');
  const long = (n) => `第${n}段长资料：` + `这是一段很长的测试资料，用来把对话撑长。`.repeat(1400);
  for (let i = 1; i <= 6; i++) await ask(b, long(i));
  const st = b.msgs.find((m) => m.type === 'status' && /整理/.test(m.text));
  ok('对话超过预算：压缩了一次（面板显示「整理前面的对话」）', !!st);
  const n2 = requests.length;
  await ask(b, '还记得吗');
  const last = requests.slice(n2).find((r) => /还记得吗/.test(r.userText));
  ok('压缩以后：发给大脑的不再带第 1 段原文', last && !/第1段长资料/.test(last.all), (last?.all || '').slice(0, 200));
  const chat3 = await query(b, { type: 'chat_history', limit: 200 });
  ok('压缩以后：面板上原文都还在', chat3.items.some((m) => m.text.startsWith('第1段长资料')));
  b.kill();
} catch (e) {
  fails++;
  console.log('✗ 出错', e.message);
}

clearTimeout(timer);
server.close();
await new Promise((r) => setTimeout(r, 400));
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {}
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
