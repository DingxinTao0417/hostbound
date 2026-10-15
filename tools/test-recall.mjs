// 阶段 5 端到端测试（假模型 + 假的硅基流动 + 临时数据目录）：node tools/test-recall.mjs
// 说「记住」→ 马上记、对话里冒「记忆已更新」；按意思回忆；聊满 10 轮自动整理；换话题后新记的进提示；撤销；按意思翻以前的对话
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-recall-'));
const PORT = 5195;
const SF = 5194;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false }, memory: { embed: { baseUrl: `http://127.0.0.1:${SF}/v1` } } }),
);

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '');

// ---- 假的硅基流动：同义词落在同一维 ----
const GROUPS = [['视频', '影片', '片子'], ['导出', '保存', '存', '放'], ['目录', '文件夹', '位置', '哪'], ['直播', '开播', '推流'], ['抖音'], ['伴侣', '软件', '工具']];
const vec = (t) => GROUPS.map((g) => (g.some((w) => t.includes(w)) ? 1 : 0)).concat([0.05]);
let embedCalls = 0;
let embedAuth = '';
const sf = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    embedCalls++;
    embedAuth = req.headers.authorization;
    const j = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: j.input.map((t, i) => ({ index: i, embedding: vec(t) })) }));
  });
});
await new Promise((r) => sf.listen(SF, r));

// ---- 假模型 ----
const requests = [];
let n = 0;
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'mock-1', choices: [c] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const say = (t) => [{ index: 0, delta: { role: 'assistant', content: t } }, { index: 0, delta: {}, finish_reason: 'stop' }];
const call = (name, args) => [
  { index: 0, delta: { tool_calls: [{ index: 0, id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
  { index: 0, delta: {}, finish_reason: 'tool_calls' },
];
let reviews = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const msgs = JSON.parse(body).messages;
    const sys = textOf(msgs[0]?.content);
    // 自动整理：回 JSON
    if (/整理长期记忆/.test(sys)) {
      reviews++;
      const convo = textOf(msgs.at(-1).content);
      const m = convo.match(/\[(\d+-\d+ \d+:\d+)\] 宿主：我以后直播都用抖音直播伴侣/);
      return sse(res, say(JSON.stringify({ ops: m ? [{ op: 'add', file: '宿主', text: '直播用抖音直播伴侣', at: m[1] }] : [] })));
    }
    const lastUser = msgs.map((x) => x.role).lastIndexOf('user');
    const user = textOf(msgs[lastUser]?.content).replace(/^（现在是[^）]*）\n/, '');
    const tools = msgs.slice(lastUser + 1).filter((x) => x.role === 'tool').map((x) => textOf(x.content));
    requests.push({ user, sys, tools, toolNames: (JSON.parse(body).tools || []).map((t) => t.function.name) });
    if (tools.length) return sse(res, say(`结果：${tools.at(-1).slice(0, 200)}`));
    if (/^记住/.test(user)) return sse(res, call('remember', { text: '剪映导出目录是 D:\\剪映导出', file: '记忆' }));
    if (/视频存在哪/.test(user)) return sse(res, call('recall', { query: '视频存在哪个文件夹' }));
    if (/翻一下以前/.test(user)) return sse(res, call('search_chat', { query: '开播用什么软件' }));
    return sse(res, say(`收到：${user}`));
  });
});
await new Promise((r) => server.listen(PORT, r));

const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data'), SILICONFLOW_API_KEY: 'test-sf' },
});
const msgs = [];
brain.on('message', (m) => msgs.push(m));
function waitFor(pred, ms = 20000) {
  const start = msgs.length;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = msgs.slice(start).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error('等不到：' + pred.toString().slice(0, 90)));
      setTimeout(tick, 30);
    };
    tick();
  });
}
const ask = (text) => {
  const p = waitFor((m) => m.type === 'done' || m.type === 'error');
  brain.send({ type: 'prompt', text });
  return p;
};
let rq = 0;
const query = (m) => {
  const id = ++rq;
  const p = waitFor((x) => x.reqId === id);
  brain.send({ ...m, reqId: id });
  return p;
};
const memFile = (f) => {
  try {
    return fs.readFileSync(path.join(tmp, 'data', 'memory', f), 'utf8');
  } catch {
    return '';
  }
};
const timer = setTimeout(() => {
  console.log('超时');
  process.exit(1);
}, 120000);

try {
  await waitFor((m) => m.type === 'brain_ready');

  // ---- 说「记住」 ----
  const upd = waitFor((m) => m.type === 'memory_update');
  await ask('记住，我剪映导出的视频都放在 D:\\剪映导出');
  const u = await upd;
  ok('说记住：对话里冒「记忆已更新」', u.change.by === '宿主' && /剪映导出目录是 D:\\剪映导出/.test(u.change.summary), JSON.stringify(u.change));
  ok('说记住：写进 记忆.md（带来源和日期）', /- 剪映导出目录是 D:\\剪映导出 \[source: 对话 \d{4}-\d\d-\d\d \d\d:\d\d; added: /.test(memFile('记忆.md')), memFile('记忆.md'));
  ok('大脑有 remember / forget / recall', ['remember', 'forget', 'recall', 'search_chat'].every((t) => requests[0].toolNames.includes(t)));

  // ---- 按意思回忆 ----
  await ask('视频存在哪个文件夹来着');
  const rec = requests.at(-1).tools.at(-1) || '';
  ok('回忆：按意思搜到（关键词 + 向量）', /剪映导出目录是 D:\\剪映导出/.test(rec), rec);
  ok('向量：用的是设置里的密钥', embedAuth === 'Bearer test-sf' && embedCalls > 0);

  // ---- 聊满 10 轮：自动整理 ----
  ok('不到 10 轮：还没整理', reviews === 0);
  const auto = waitFor((m) => m.type === 'memory_update' && m.change.by === '自动整理', 30000);
  for (const t of ['我以后直播都用抖音直播伴侣', '今天天气不错', '帮我看看几点了', '好的', '再说一句', '第七句', '第八句', '第九句']) await ask(t);
  const a = await auto;
  ok('第 10 轮：自动整理一次，记下宿主说的', reviews === 1 && /直播用抖音直播伴侣/.test(memFile('宿主.md')) && /新增|直播用抖音/.test(a.change.summary), memFile('宿主.md'));
  ok('自动整理：来源是那句话的时间', /直播用抖音直播伴侣 \[source: 对话 \d{4}-\d\d-\d\d \d\d:\d\d/.test(memFile('宿主.md')));
  const st = await query({ type: 'memory_query' });
  ok('记忆页：两个常驻文件 + 改动日志', st.files.some((f) => f.name === '宿主' && f.entries.length === 1) && st.journal.length === 2 && st.status.since === 0, JSON.stringify(st.status));

  // ---- 换话题：新记的进提示 ----
  brain.send({ type: 'new_session' });
  await waitFor((m) => m.type === 'topic_reset');
  await ask('你还记得我什么');
  const sys = requests.at(-1).sys;
  ok('新一段对话：常驻记忆放进提示', /你记得的（长期记忆/.test(sys) && /剪映导出目录是 D:\\剪映导出/.test(sys) && /直播用抖音直播伴侣/.test(sys), sys.slice(-400));

  // ---- 按意思翻以前的对话 ----
  await new Promise((r) => setTimeout(r, 1500)); // 等后台把对话算完向量
  await ask('翻一下以前说的直播');
  const sc = requests.at(-1).tools.at(-1) || '';
  ok('翻以前的对话：按意思搜到原话', /我以后直播都用抖音直播伴侣/.test(sc), sc);

  // ---- 撤销 ----
  const r = await query({ type: 'memory_undo', id: a.change.id });
  ok('撤销自动整理：那条没了', r.ok && !/直播用抖音直播伴侣/.test(memFile('宿主.md')));
  const e = await query({ type: 'memory_edit', op: 'add', file: '宿主', text: '我的密码是 abc123456' });
  ok('记忆页加密码：拒绝', !e.ok && /密码/.test(e.error));
  const t = await query({ type: 'embed_test' });
  ok('设置里「测试」向量检索', t.ok);
  const log = await query({ type: 'log_query', logType: 'mem' });
  ok('系统日志里有「记忆」一类', log.items.some((x) => /自动整理/.test(x.text)));
} catch (err) {
  fails++;
  console.log('✗ 出错', err.message);
}

clearTimeout(timer);
brain.kill();
server.close();
sf.close();
await new Promise((r) => setTimeout(r, 400));
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {}
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
