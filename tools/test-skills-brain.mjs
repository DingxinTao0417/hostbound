// 阶段 6 端到端测试（假模型 + 临时数据目录）：node tools/test-skills-brain.mjs
// 口头教 → 草稿卡 → 打字「保存」→ 大脑目录里有了 → 说口令直接跑（附技能块、步骤条、批准过的脚本不问）
// → 脚本被改过要重新问 → 自己改进 → 「要存成技能吗」和「不用」→ 从网址装（报告卡）→ 直接写技能文件被拦下
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-skills-brain-'));
const data = path.join(tmp, 'data');
const skillsDir = path.join(data, 'skills');
const PORT = 5194;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false }, memory: { autoReview: false, embed: { chat: false } } }),
);

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

// ---- 假模型（也兼当放技能文件的网站） ----
const seen = []; // 每次请求：{ user, sys, tools }
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
const TIDY = {
  title: '整理桌面',
  description: '把桌面上的文件按类型收进文件夹。',
  triggers: ['整理一下桌面'],
  steps: '1. 运行 scripts/tidy.ps1（在技能文件夹里）\n2. 一句话汇报',
  step_labels: ['跑脚本', '汇报'],
  scripts: [{ path: 'scripts/tidy.ps1', content: "Write-Output 'tidy-ok'" }],
};
const WEATHER = '---\nname: weather\ndescription: 查天气。宿主问天气时用。\nmetadata:\n  hostbound:\n    title: 查天气\n---\n# 查天气\n\n1. 打开 https://weather.example.com\n';
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/skills/weather/SKILL.md') return res.writeHead(200, { 'content-type': 'text/markdown' }).end(WEATHER);
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    const msgs = j.messages;
    const sys = textOf(msgs.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    // 装技能的检查报告（单独一次调用）
    if (/检查一个从网上下载的技能/.test(sys)) {
      seen.push({ report: textOf(msgs.at(-1).content) });
      return sse(res, say('{"does":"告诉它城市，查当地天气","runs":"不运行脚本","network":"会，访问 weather.example.com","files":"不读不写","needs":"不需要","windows":"能用","risk":"low","why":"只是打开网页"}'));
    }
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const user = textOf(msgs[lastUser]?.content).replace(/^（现在是[^）]*）\n/, '');
    const tools = msgs.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => textOf(m.content));
    if (!tools.length) seen.push({ user, sys, tools: (j.tools || []).map((t) => t.function.name) });
    if (/学一个技能/.test(user)) return tools.length ? sse(res, say('草稿已经弹给宿主看了，请看一下卡片。')) : sse(res, call('skill_draft', TIDY));
    if (/^(（[^）]*）\n)*<skill name=/.test(user)) {
      if (tools.length) return sse(res, say(`【完成】桌面整理好了。${/tidy-ok/.test(tools.at(-1)) ? '' : `（${tools.at(-1).slice(0, 60)}）`}`));
      const base = user.match(/References are relative to (.+)\.\n/)[1];
      return sse(res, call('powershell', { command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(base, 'scripts', 'tidy.ps1')}"` }));
    }
    if (/提改进/.test(user)) return tools.length ? sse(res, say('改进建议已经弹出来了。')) : sse(res, call('skill_draft', { ...TIDY, scripts: undefined, improve: '整理桌面', steps: TIDY.steps + '\n   - 桌面上有快捷方式的不动', change: '第 1 步加了：快捷方式不动', why: '这次把快捷方式也收走了' }));
    if (/复杂的事/.test(user)) return tools.length < 5 ? sse(res, call('powershell', { command: 'Get-Date -Format yyyy' })) : sse(res, say('【完成】五步都做完了。'));
    if (/直接写技能文件/.test(user)) return tools.length ? sse(res, say(`写不了：${tools.at(-1).slice(0, 60)}`)) : sse(res, call('write', { path: path.join(skillsDir, '偷偷加的', 'SKILL.md'), content: '---\nname: sneaky\ndescription: x\n---\n' }));
    return sse(res, say(`收到：${user.slice(0, 30)}`));
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
function waitFor(pred, ms = 20000, from = msgs.length) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = msgs.slice(from).find(pred);
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
let rid = 100;
const request = (msg, type) => {
  const reqId = ++rid;
  const p = waitFor((m) => m.type === type && m.reqId === reqId);
  brain.send({ ...msg, reqId });
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timer = setTimeout(() => {
  console.log('超时');
  process.exit(1);
}, 150000);

try {
  await waitFor((m) => m.type === 'brain_ready');

  // ---- 口头教 ----
  const pend = waitFor((m) => m.type === 'skill_pending');
  await ask('学一个技能：整理桌面，把文件按类型收好');
  const p1 = (await pend).entry;
  ok('口头教：大脑看得到技能这一节和 skill_draft', /## 技能（宿主教你的固定流程）/.test(seen[0].sys) && seen[0].tools.includes('skill_draft') && seen[0].tools.includes('skill_install'));
  ok('口头教：对话里出草稿卡（步骤、口令、脚本）', p1.kind === 'new' && p1.title === '整理桌面' && p1.steps.length === 2 && p1.triggers[0] === '整理一下桌面' && p1.scripts[0].path === 'scripts/tidy.ps1', JSON.stringify(p1));
  ok('还没保存：技能文件夹里没有', !fs.existsSync(path.join(skillsDir, '整理桌面')));

  // 打字「保存」：本地处理，不问模型
  const before = seen.length;
  const resolved = waitFor((m) => m.type === 'skill_resolved');
  brain.send({ type: 'prompt', text: '保存' });
  const r1 = await resolved;
  ok('说「保存」：直接保存，不问模型', r1.answer === 'save' && r1.folder === '整理桌面' && seen.length === before && fs.existsSync(path.join(skillsDir, '整理桌面', 'SKILL.md')));
  await sleep(2500); // 空闲时重新加载大脑，技能目录换成新的

  // ---- 说口令：直接跑 ----
  const run = waitFor((m) => m.type === 'skill_run');
  const steps = waitFor((m) => m.type === 'steps' && m.steps);
  const confirmEarly = msgs.length;
  const d1 = await ask('系统，整理一下桌面');
  const sr = await run;
  const st = await steps;
  const req = seen.at(-1);
  ok('口令：本地认出来，冒一行【技能】', sr.title === '整理桌面');
  ok('口令：步骤条按技能列好', st.steps.join() === '跑脚本,汇报' && st.done === 0, JSON.stringify(st));
  ok('口令：大脑收到附了技能块的话', /<skill name="zheng-li-zhuo-mian" location="/.test(req.user) && /系统，整理一下桌面$/.test(req.user), req.user.slice(0, 200));
  ok('口令：顺便告诉大脑宿主刚保存了技能', /（宿主刚才在面板上：保存了技能「整理桌面」）/.test(req.user));
  ok('重新加载后：大脑的技能目录里有它', /<available_skills>[\s\S]*zheng-li-zhuo-mian[\s\S]*整理桌面[\s\S]*SKILL\.md/.test(req.sys), req.sys.slice(-600));
  ok('批准过的脚本：不弹授权，跑成了', !msgs.slice(confirmEarly).some((m) => m.type === 'confirm') && /桌面整理好了。$/.test(d1.text), d1.text);
  const hist = await request({ type: 'chat_history', limit: 40 }, 'chat_history');
  ok('对话记录里只显示宿主说的那句（技能块、面板消息都去掉）', hist.items.some((m) => m.role === 'user' && m.text === '系统，整理一下桌面') && !hist.items.some((m) => /<skill|宿主刚才在面板上/.test(m.text)), JSON.stringify(hist.items.map((m) => m.text)));
  let snap = await request({ type: 'skills_query' }, 'skills');
  ok('用了一次：次数记上', snap.skills.find((s) => s.folder === '整理桌面')?.uses === 1);

  // ---- 脚本被改过：重新问 ----
  fs.writeFileSync(path.join(skillsDir, '整理桌面', 'scripts', 'tidy.ps1'), "Write-Output 'tidy-ok'; Write-Output 'changed'");
  await sleep(1500); // 等它发现文件变了
  const conf = waitFor((m) => m.type === 'confirm', 20000);
  const d2p = ask('整理一下桌面');
  const c = await conf;
  ok('脚本内容变了：弹授权，说清楚', /运行技能脚本（内容变了/.test(c.label) && /scripts\/tidy\.ps1/.test(c.detail), JSON.stringify(c));
  brain.send({ type: 'confirm_answer', id: c.id, answer: 'allow' });
  await d2p;
  snap = await request({ type: 'skills_query' }, 'skills');
  ok('宿主允许以后：新的内容算批准过', snap.skills.find((s) => s.folder === '整理桌面').scripts[0].status === 'approved');

  // ---- 自己改进 ----
  const pend2 = waitFor((m) => m.type === 'skill_pending');
  await ask('提改进：快捷方式别动');
  const p2 = (await pend2).entry;
  ok('改进：金色卡片（改了什么、为什么）', p2.kind === 'improve' && p2.change === '第 1 步加了：快捷方式不动' && p2.why === '这次把快捷方式也收走了');
  const dec = await request({ type: 'skill_decide', id: p2.id, answer: 'save' }, 'skill_decided');
  ok('点「改」：技能改了', dec.ok && /快捷方式的不动/.test(fs.readFileSync(path.join(skillsDir, '整理桌面', 'SKILL.md'), 'utf8')));
  snap = await request({ type: 'skills_query' }, 'skills');
  const undoId = snap.journal.find((j) => j.by === '自己改进')?.id;
  const undone = await request({ type: 'skill_op', op: 'undo', id: undoId }, 'skill_op_done');
  ok('技能页撤销改进', undone.ok && !/快捷方式的不动/.test(fs.readFileSync(path.join(skillsDir, '整理桌面', 'SKILL.md'), 'utf8')));

  // ---- 要存成技能吗 ----
  const sug = waitFor((m) => m.type === 'skill_suggest', 20000);
  await ask('帮我做一套复杂的事');
  const sg = await sug;
  ok('五个动作以上做成了：冒一行「要存成技能吗」', sg.tools >= 5 && sg.text === '帮我做一套复杂的事');
  brain.send({ type: 'skill_suggest_no', id: sg.id, text: sg.text });
  await sleep(200);
  const mark = msgs.length;
  await ask('帮我做一套复杂的事');
  await sleep(300);
  ok('说过「不用」：同一类不再问', !msgs.slice(mark).some((m) => m.type === 'skill_suggest'));
  const fromTask = waitFor((m) => m.type === 'done');
  brain.send({ type: 'skill_from_task', id: 'x', text: '帮我做一套复杂的事' });
  await fromTask;
  ok('点「存成技能」：等于说了「把刚才……做成技能」', /把刚才「帮我做一套复杂的事」这套做成技能/.test(seen.at(-1).user));

  // ---- 从网址装 ----
  const ins = await request({ type: 'skill_install', url: `http://127.0.0.1:${PORT}/skills/weather/SKILL.md` }, 'skill_install_result');
  ok('从网址装：下载、检查、模型写报告', ins.ok && ins.pending?.install?.llm && ins.pending.install.report.does === '告诉它城市，查当地天气' && seen.some((x) => x.report && /<file path="SKILL.md">/.test(x.report)), JSON.stringify(ins).slice(0, 300));
  ok('报告：程序查出来联网，风险至少按程序的算', ['low', 'medium'].includes(ins.pending.install.risk));
  ok('还没点安装：技能库里没有', !fs.existsSync(path.join(skillsDir, 'weather')));
  const dec2 = await request({ type: 'skill_decide', id: ins.pending.id, answer: 'save' }, 'skill_decided');
  snap = await request({ type: 'skills_query' }, 'skills');
  ok('点「安装」：进技能库，标社区·已检查', dec2.ok && snap.skills.some((s) => s.name === 'weather' && s.origin === 'community' && s.checked));

  // ---- 直接写技能文件：拦下 ----
  const d3 = await ask('直接写技能文件');
  ok('大脑直接写技能文件：被拦下', !fs.existsSync(path.join(skillsDir, '偷偷加的')) && /skill_draft/.test(d3.text), d3.text);

  // ---- 翻页、开关、日志 ----
  const nav = waitFor((m) => m.type === 'nav');
  brain.send({ type: 'prompt', text: '打开技能' });
  ok('「打开技能」：翻到技能页', (await nav).page === 'skill');
  await request({ type: 'skill_op', op: 'toggle', folder: '整理桌面', on: false }, 'skill_op_done');
  const mark2 = msgs.length;
  await ask('整理一下桌面');
  ok('停用以后：口令不认，交给大脑', !msgs.slice(mark2).some((m) => m.type === 'skill_run'));
  await request({ type: 'skill_op', op: 'remove', folder: '整理桌面' }, 'skill_op_done');
  snap = await request({ type: 'skills_query' }, 'skills');
  ok('删除：进回收区', !snap.skills.some((s) => s.folder === '整理桌面') && snap.trash.some((t) => t.title === '整理桌面'));
  const log = await request({ type: 'log_query', logType: 'skill' }, 'log');
  ok('系统日志：技能一类都记了', ['技能草稿「整理桌面」', '保存了技能「整理桌面」', '跑技能「整理桌面」', '改了技能', '不存成技能', '检查完「查天气」', '安装了技能「查天气」', '停用技能「整理桌面」', '删除技能「整理桌面」'].every((w) => log.items.some((e) => e.text.includes(w))), JSON.stringify(log.items.map((e) => e.text)));
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
