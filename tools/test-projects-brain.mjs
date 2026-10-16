// 项目模式端到端测试（假模型 + 临时数据目录 + 真的 pi 干活的智能体 + 真的 git 和检查命令）：node tools/test-projects-brain.mjs
// 宿主说「帮我做一个……」→ 大脑交给项目模式 → 计划卡 → 打字「开工」（不问模型）→ 干活的问总指挥（技术问题总指挥自己答）、
// 问到要宿主拿主意的（卡片变「等你回答」，点按钮回答）→ 想删项目外面的东西（弹授权，拒绝）→ 写代码、自己测、汇报
// → 系统提交、合并、检查 → 最后检查 → 评审 → 完成卡 → 项目页快照、项目列表、对话历史里的卡 → 问大脑进度
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-projects-brain-'));
const data = path.join(tmp, 'data');
const projRoot = path.join(tmp, 'projects');
const PORT = 5193;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false }, memory: { autoReview: false, embed: { chat: false } }, projects: { root: projRoot } }),
);

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

// ---- 假模型：按系统提示认出是谁在问（大脑 / 总指挥 / 干活的 / 评审） ----
const seen = { brain: [], commander: [], worker: [], review: [] };
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
const PLAN = {
  name: '加法器',
  summary: '一个命令行加法器，带测试',
  approach: 'Node.js，一个文件',
  agents: [{ id: 'dev', role: '开发', does: '写加法器和测试' }],
  tasks: [{ id: 't1', agent: 'dev', title: '加法器', desc: '写 add.js（导出 add(a, b)）和 test.js', files: ['add.js', 'test.js'], deps: [], done: 'node test.js 过' }],
  checks: { install: '', build: '', test: 'node test.js', start: '', url: '', web: false },
  estimate: { minutes: 5, cny: [0.5, 1] },
};
const outside = 'C:\\hostbound-e2e-does-not-exist';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    const msgs = j.messages;
    const sys = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const user = textOf(msgs[lastUser]?.content);
    const tools = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    const names = (j.tools || []).map((t) => t.function.name);
    // 总指挥（一次性的调用，没有工具）
    if (/项目总指挥/.test(sys) && !names.length) {
      seen.commander.push({ sys: sys.slice(0, 60), user });
      if (/现在先写计划/.test(sys)) return sse(res, say(JSON.stringify(PLAN)));
      if (/一个干活的智能体问了你一个问题/.test(sys)) {
        if (/小数/.test(user)) return sse(res, say('{"ask":"要不要支持小数？","options":["要","不用"]}'));
        return sse(res, say('{"answer":"用 node 自带的 assert 就行，不用装测试框架"}'));
      }
      if (/写一个简短的总结/.test(sys)) return sse(res, say('{"did":"一个加法器 add.js 和 1 个测试","run":"node test.js","notes":""}'));
      return sse(res, say('{}'));
    }
    // 评审
    if (/项目里的「评审」/.test(sys)) {
      seen.review.push({ user, tools });
      return tools.length ? sse(res, say('评审完了。')) : sse(res, call('report', { status: 'done', summary: '对照宿主原话看过了，没问题', issues: [] }));
    }
    // 干活的
    if (/项目里的「开发」/.test(sys)) {
      if (!tools.length) seen.worker.push({ user, sys, names });
      const k = tools.length;
      const steps = [
        () => call('ask_commander', { question: '测试用什么写？' }),
        () => call('ask_commander', { question: '要不要支持小数？', options: ['要', '不用'] }),
        () => call('powershell', { command: `Remove-Item -Recurse '${outside}'` }),
        () => call('write', { path: 'add.js', content: "module.exports = (a, b) => Number(a) + Number(b);\n" }),
        () => call('write', { path: 'test.js', content: "const assert = require('node:assert');\nconst add = require('./add');\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add('1.5', 1), 2.5);\nconsole.log('测试都过了');\n" }),
        () => call('powershell', { command: 'node test.js' }),
        () => call('report', { status: 'done', summary: '加法器和测试写好了，node test.js 过了', files: ['add.js', 'test.js'] }),
      ];
      seen.worker.at(-1).results = tools;
      return k < steps.length ? sse(res, steps[k]()) : sse(res, say('汇报完了。'));
    }
    // 主窗口的大脑
    seen.brain.push({ user, sys, names, tools });
    if (/帮我做一个命令行加法器/.test(user)) return tools.length ? sse(res, say('收到，已交给总指挥写计划，写好了给宿主过目。')) : sse(res, call('project_start', { name: '加法器', request: '帮我做一个命令行加法器，要有测试' }));
    if (/项目怎么样了/.test(user)) return tools.length ? sse(res, say(`【进度】${tools.at(-1).slice(0, 80)}`)) : sse(res, call('project_list', {}));
    return sse(res, say(`收到：${user.slice(-30)}`));
  });
});
await new Promise((r) => server.listen(PORT, r));

const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: data },
});
const msgs = [];
brain.on('message', (m) => msgs.push(m));
function waitFor(pred, ms = 30000, from = 0) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = msgs.slice(from).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error('等不到：' + pred.toString().slice(0, 120)));
      setTimeout(tick, 30);
    };
    tick();
  });
}
const ask = (text) => {
  const from = msgs.length;
  brain.send({ type: 'prompt', text });
  return waitFor((m) => m.type === 'done' || m.type === 'error', 30000, from);
};
let rid = 100;
const request = (msg, type) => {
  const reqId = ++rid;
  const p = waitFor((m) => m.type === type && m.reqId === reqId);
  brain.send({ ...msg, reqId });
  return p;
};
const timer = setTimeout(() => {
  console.log('超时');
  console.log(JSON.stringify(msgs.filter((m) => m.type === 'project_card').map((m) => m.card.kind)));
  process.exit(1);
}, 240000);
const cardOf = (kind, from = 0) => waitFor((m) => m.type === 'project_card' && m.card.kind === kind, 120000, from);

try {
  await waitFor((m) => m.type === 'brain_ready');

  // ---- 说要做个东西：大脑交给项目模式 ----
  const d1 = await ask('帮我做一个命令行加法器');
  const b0 = seen.brain[0];
  ok('大脑看得到项目这一节和项目工具', /## 项目（做软件、网站、小游戏、小工具）/.test(b0.sys) && ['project_start', 'project_list', 'project_answer', 'project_control'].every((t) => b0.names.includes(t)), b0.names.join(','));
  ok('大脑调了 project_start，马上回一句', /交给总指挥/.test(d1.text) && /已交给总指挥写计划：项目「加法器」/.test(seen.brain[1]?.tools?.[0] || ''), d1.text);
  const toolStep = msgs.find((m) => m.type === 'tool' && m.name === 'project_start');
  ok('面板步骤：开项目', toolStep?.text === '开项目：加法器', toolStep?.text);
  const plan = await cardOf('plan');
  const pid = plan.card.projectId;
  const dir = plan.card.dir;
  ok('计划卡：项目名、做成什么、分工、任务、放在哪', plan.card.name === '加法器' && plan.card.summary === PLAN.summary && plan.card.agents[0].role === '开发' && plan.card.planTasks[0].title === '加法器' && dir === path.join(projRoot, '加法器'), JSON.stringify(plan.card));
  ok('总指挥写计划时看到宿主原话', /帮我做一个命令行加法器，要有测试/.test(seen.commander[0]?.user || ''));
  ok('项目文件夹建好了，宿主原话存下了', /要有测试/.test(fs.readFileSync(path.join(dir, '.hostbound', 'request.md'), 'utf8')));
  ok('还没开工：没派活', !seen.worker.length);

  // ---- 打字「开工」：不问模型直接开工 ----
  const before = seen.brain.length;
  const mark = msgs.length;
  brain.send({ type: 'prompt', text: '开工' });
  await cardOf('running', mark);
  ok('打字「开工」：直接开工，不问大脑', seen.brain.length === before);

  // ---- 干活的问了个要宿主拿主意的问题 ----
  const askCard = await cardOf('ask', mark);
  ok('等你回答：卡片上有问题和选项、谁问的', askCard.card.question.text === '要不要支持小数？' && askCard.card.question.options.join() === '要,不用' && askCard.card.question.from === '开发', JSON.stringify(askCard.card.question));
  ok('技术问题：总指挥自己答了（带着宿主原话、计划）', seen.commander.some((c) => /测试用什么写/.test(c.user) && /宿主原话/.test(c.user)));
  ok('干活的收到了总指挥的回答', /node 自带的 assert/.test(seen.worker[0]?.results?.[0] || ''), JSON.stringify(seen.worker[0]?.results));
  const ans = await request({ type: 'project_action', projectId: pid, action: 'answer', qid: askCard.card.question.qid, value: '要' }, 'project_action_result');
  ok('点「要」：回答转过去', ans.ok);

  // ---- 想删项目外面的东西：弹授权，拒绝 ----
  const conf = await waitFor((m) => m.type === 'confirm' && String(m.id).startsWith('p:'), 60000, mark);
  ok('项目外面的删除：跟大脑的授权一张卡，写清楚是哪个项目谁要做', /删除文件（项目文件夹外面）/.test(conf.label) && /项目「加法器」· 开发/.test(conf.label) && conf.tool === 'project' && conf.detail.includes(outside), JSON.stringify(conf));
  ok('干活的收到宿主的回答（问宿主的那个）', /宿主回答：要/.test(seen.worker[0]?.results?.[1] + (seen.worker[0]?.results?.[2] || '') || ''), JSON.stringify(seen.worker[0]?.results));
  brain.send({ type: 'confirm_answer', id: conf.id, answer: 'deny' });
  await waitFor((m) => m.type === 'confirm_closed' && m.id === conf.id, 10000, mark);

  // ---- 做完：提交、合并、检查、评审、完成 ----
  const done = await cardOf('done', mark);
  const r = done.card.result;
  ok('完成卡：做了什么、怎么运行、检查结果', /加法器/.test(r.did) && r.run === 'node test.js' && r.checks.some((c) => c.name === '测试' && c.ok) && r.checks.some((c) => c.name === '评审' && c.ok), JSON.stringify(r));
  ok('拒绝了就没删：干活的收到被拦下的原因', /宿主没允许/.test(seen.worker[0]?.results?.[2] || ''), seen.worker[0]?.results?.[2]);
  ok('代码进了主线（项目文件夹里）', /Number\(a\) \+ Number\(b\)/.test(fs.readFileSync(path.join(dir, 'add.js'), 'utf8')) && fs.existsSync(path.join(dir, 'test.js')));
  const log = execFileSync('git', ['log', '--format=%an|%s'], { cwd: dir, encoding: 'utf8' });
  ok('git 历史：开始、任务提交、合并（系统的身份）', /Hostbound\|项目开始/.test(log) && /Hostbound\|加法器（开发）/.test(log), log);
  ok('干活的副本收掉了', !fs.existsSync(path.join(dir, '.hostbound', 'worktrees', 'dev-t1')));
  ok('干活的任务里带着宿主原话、只许改哪些、怎么检查', /## 宿主原话\n帮我做一个命令行加法器，要有测试/.test(seen.worker[0].user) && /只改：add\.js、test\.js/.test(seen.worker[0].user) && /测试 node test\.js/.test(seen.worker[0].user), seen.worker[0].user.slice(0, 400));
  ok('干活的只有总指挥给的工具（问总指挥、汇报），没有大脑的', seen.worker[0].names.includes('ask_commander') && seen.worker[0].names.includes('report') && !seen.worker[0].names.includes('project_start') && !seen.worker[0].names.includes('remember'), seen.worker[0].names.join(','));
  ok('评审看到了宿主原话和改动', /宿主原话/.test(seen.review[0]?.user || '') && /add\.js/.test(seen.review[0]?.user || ''));

  // ---- 项目页：快照 ----
  const snap = await request({ type: 'project_snapshot', projectId: pid }, 'project_snapshot');
  const types = new Set(snap.events.map((e) => e.type));
  ok('项目页快照：计划、状态、事件都有', snap.plan.tasks.length >= 2 && snap.state.status === 'done' && ['created', 'plan', 'approved', 'dispatch', 'question', 'answer', 'ask_host', 'host_answer', 'confirm', 'confirm_done', 'step', 'report', 'commit', 'merge', 'merged', 'check', 'review', 'done'].every((t) => types.has(t)), [...types].join(','));
  ok('派活的提示词记下了', snap.events.some((e) => e.type === 'dispatch' && /宿主原话/.test(e.prompt) && /项目里的「开发」/.test(e.system || '')));
  ok('合并后、最后都跑了测试', snap.events.some((e) => e.type === 'check' && e.scope === 'merge' && e.name === 'test' && e.ok) && snap.events.some((e) => e.type === 'check' && e.scope === 'final' && e.name === 'test' && e.ok));
  const light = await request({ type: 'project_snapshot', projectId: pid, light: true }, 'project_snapshot');
  ok('不带事件的快照', light.state && !light.events);
  const list = await request({ type: 'projects_query' }, 'projects');
  ok('项目列表', list.items.length === 1 && list.items[0].card.kind === 'done');
  const hist = await request({ type: 'chat_history', limit: 40 }, 'chat_history');
  ok('对话历史里有项目卡', hist.items.some((m) => m.role === 'project' && m.card.projectId === pid));

  // ---- 问大脑进度 ----
  const d2 = await ask('项目怎么样了');
  ok('问进度：大脑用 project_list，看得到做完了', /加法器（做完了，任务 \d\/\d/.test(d2.text), d2.text);
  ok('大脑那句话里顺便知道宿主刚才回答过的问题', seen.brain.some((b) => /总指挥在问宿主：要不要支持小数/.test(b.user)));

  // ---- 打开项目页、打开文件夹的消息 ----
  const open = waitFor((m) => m.type === 'project_open' && m.projectId === pid, 5000, msgs.length);
  brain.send({ type: 'project_action', projectId: pid, action: 'open_page' });
  ok('「打开项目页」交给桌面开窗口', !!(await open));
} catch (e) {
  fails++;
  console.log('✗', e.message);
} finally {
  clearTimeout(timer);
  brain.send({ type: 'quit' });
  server.close();
  await new Promise((r) => setTimeout(r, 800));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
console.log(fails ? `\n${fails} 项没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
