// 阶段 4 端到端测试（假模型 + 临时数据目录）：node tools/test-quests.mjs
// 说「提醒我喝水」→ 大脑建定时任务 → 面板出【限时任务】卡 → 到点提醒 → 稍后再提醒；
// 说「等导出完叫我」→ 大脑建监测 → 文件写完报告；「到点帮我做」→ 到点交给大脑去做
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-quests-'));
const exportDir = path.join(tmp, 'export');
fs.mkdirSync(exportDir);
const PORT = 5196;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
// 自带的监测关掉：测试不碰宿主真实的下载文件夹
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false } }));

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

// ---- 假模型 ----
const prompts = [];
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '');
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'mock-1', choices: [c] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const say = (t) => [{ index: 0, delta: { role: 'assistant', content: t } }, { index: 0, delta: {}, finish_reason: 'stop' }];
let n = 0;
const call = (name, args) => [
  { index: 0, delta: { tool_calls: [{ index: 0, id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } },
  { index: 0, delta: {}, finish_reason: 'tool_calls' },
];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const msgs = JSON.parse(body).messages;
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const user = textOf(msgs[lastUser]?.content).replace(/^（现在是[^）]*）\n/, '');
    const tools = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    if (!tools.length) prompts.push(user);
    if (tools.length) return sse(res, say(`好的。${tools.at(-1).slice(0, 40)}`));
    if (/提醒我喝水/.test(user)) return sse(res, call('task_create', { name: '补充水分', say: '宿主，该补充水分了。', in_minutes: 0.04 }));
    if (/导出完叫我/.test(user)) return sse(res, call('watch_create', { name: '视频导出完成', kind: 'folder', path: exportDir, pattern: '*.mp4', say: '宿主，视频导出好了。' }));
    if (/到点帮我/.test(user)) return sse(res, call('task_create', { name: '查数据', do: '查一下今天的数据', in_minutes: 0.04 }));
    if (/取消/.test(user)) return sse(res, call('task_cancel', { id: '补充' }));
    return sse(res, say(`收到：${user}`));
  });
});
await new Promise((r) => server.listen(PORT, r));

const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data') },
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
const timer = setTimeout(() => {
  console.log('超时');
  process.exit(1);
}, 90000);

try {
  await waitFor((m) => m.type === 'brain_ready');

  // ---- 定时提醒 ----
  const quest = waitFor((m) => m.type === 'quest');
  const reminder = waitFor((m) => m.type === 'reminder', 15000);
  await ask('两秒后提醒我喝水');
  const q = await quest;
  ok('建任务：面板收到【限时任务】卡', q.task.name === '补充水分' && q.task.nextAt > Date.now() - 5000, JSON.stringify(q.task));
  const tasksFile = path.join(tmp, 'data', 'tasks.json');
  ok('建任务：存进 data/tasks.json', JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks.some((t) => t.name === '补充水分'));
  const r = await reminder;
  ok('到点：提醒（带要念的话）', r.task.name === '补充水分' && r.task.say === '宿主，该补充水分了。');
  ok('到点：弹通知（金色）', msgs.some((m) => m.type === 'fx' && m.kind === 'notice' && m.tone === 'gold' && m.text === '补充水分'));
  const closed = waitFor((m) => m.type === 'reminder_closed');
  brain.send({ type: 'reminder_answer', id: r.task.id, answer: 'snooze', minutes: 10 });
  const c = await closed;
  ok('点「10 分钟后再提醒」：又排了一次', c.answer === 'snooze' && Math.abs(c.nextAt - Date.now() - 10 * 60_000) < 5000);
  const snap = await (async () => {
    const p = waitFor((m) => m.type === 'tasks' && m.reqId === 7);
    brain.send({ type: 'tasks_query', reqId: 7 });
    return p;
  })();
  ok('任务页能看到稍后的那条', snap.tasks.some((t) => t.name === '补充水分') && snap.fired.some((e) => e.name === '补充水分'));
  await ask('取消喝水提醒');
  ok('说取消：任务没了', !JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks.some((t) => t.name === '补充水分'));

  // ---- 监测：等导出完 ----
  const report = waitFor((m) => m.type === 'report' && m.kind === 'watch', 20000);
  await ask('等导出完叫我');
  ok('建监测：存盘', JSON.parse(fs.readFileSync(tasksFile, 'utf8')).watches.some((w) => w.name === '视频导出完成'));
  fs.writeFileSync(path.join(exportDir, 'vlog.mp4'), 'v'.repeat(5000));
  const rep = await report;
  ok('导出写完：报告', rep.title === '视频导出完成' && rep.text === 'vlog.mp4' && rep.say === '宿主，视频导出好了。');
  await new Promise((res) => setTimeout(res, 300));
  ok('报告完：监测自己撤掉', !JSON.parse(fs.readFileSync(tasksFile, 'utf8')).watches.length);

  // ---- 到点去做 ----
  const run = waitFor((m) => m.type === 'quest_run', 15000);
  const didIt = waitFor((m) => m.type === 'done' && /查一下今天的数据/.test(m.text), 20000);
  await ask('两秒后到点帮我查一下数据');
  const qr = await run;
  ok('到点：交给大脑去做', qr.task.do === '查一下今天的数据');
  await didIt;
  ok('大脑收到了要做的事', prompts.includes('查一下今天的数据'), JSON.stringify(prompts));
  const hist = await (async () => {
    const p = waitFor((m) => m.type === 'history' && m.reqId === 8);
    brain.send({ type: 'history_query', reqId: 8 });
    return p;
  })();
  ok('任务记录里标成「定时任务」', hist.items[0]?.via === 'task' && hist.items[0]?.text === '查一下今天的数据');
  const log = await (async () => {
    const p = waitFor((m) => m.type === 'log' && m.reqId === 9);
    brain.send({ type: 'log_query', reqId: 9, logType: 'task' });
    return p;
  })();
  ok('系统日志：任务一类都记了', ['发布：补充水分', '到点提醒：补充水分', '视频导出完成', '到点去做：查数据'].every((w) => log.items.some((e) => e.text.includes(w))), JSON.stringify(log.items.map((e) => e.text)));
} catch (e) {
  fails++;
  console.log('✗ 出错', e.message);
}

clearTimeout(timer);
brain.kill();
server.close();
await new Promise((r) => setTimeout(r, 400));
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {}
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
