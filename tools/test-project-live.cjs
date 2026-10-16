// 项目页实测（真的 Electron 窗口，假的大脑，不碰别的软件）：npx electron tools/test-project-live.cjs
// 真实的安全策略和桥（project-preload.cjs）下：开窗口 → 要快照 → 画出智能体、过程、通信、计划、合并 → 推事件追加一步
// → 点按钮发出去的消息（回答、暂停、跟总指挥说话）→ 换项目 → 不是这个项目的事件不显示。截图存到 HOSTBOUND_SNAP（默认临时目录下的 hostbound-project-live）
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectWindow } = require('../app/project-window.cjs');

const OUT = process.env.HOSTBOUND_SNAP || path.join(os.tmpdir(), 'hostbound-project-live');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function ok(cond, name, extra = '') {
  if (!cond) fails++;
  console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  ← ${extra}` : ''}`);
}

const now = Date.now();
const plan = {
  name: '加法器', summary: '一个命令行加法器', approach: 'Node.js',
  agents: [{ id: 'dev', role: '开发', does: '写加法器和测试' }, { id: 'review', role: '评审', does: '最后检查' }],
  tasks: [{ id: 't1', agent: 'dev', title: '加法器', desc: '写 add.js 和 test.js', files: ['add.js', 'test.js'], deps: [] }],
  checks: { test: 'node test.js' },
};
const events = [
  { at: now - 60_000, type: 'created', name: '加法器', dir: 'D:\\x\\加法器', request: '做个加法器' },
  { at: now - 50_000, type: 'approved', base: 'abc1234', main: 'main' },
  { at: now - 40_000, type: 'dispatch', agent: 'dev', role: '开发', task: 't1', title: '加法器', attempt: 1, engine: 'pi', prompt: '## 宿主原话\n做个加法器\n\n## 你的任务：加法器', system: '你是一个项目里的「开发」' },
  { at: now - 30_000, type: 'step', agent: 'dev', task: 't1', kind: 'tool', id: 's1', text: '写文件：add.js' },
  { at: now - 29_000, type: 'step', agent: 'dev', task: 't1', kind: 'tool_end', id: 's1', ok: true },
  { at: now - 20_000, type: 'question', agent: 'dev', task: 't1', qid: 'w1', text: '要不要支持小数？' },
  { at: now - 20_000, type: 'ask_host', agent: 'dev', task: 't1', qid: 'q1', text: '要不要支持小数？', options: ['要', '不用'] },
];
const card = { projectId: 'p1', name: '加法器', kind: 'ask', status: 'running', dir: 'D:\\x\\加法器', costCny: 0.4, budgetCny: 30, startedAt: now - 60_000, agents: [{ id: 'dev', role: '开发', state: 'work', now: '加法器' }], tasks: { done: 0, total: 1 }, question: { qid: 'q1', text: '要不要支持小数？', options: ['要', '不用'], from: '开发' } };

app.whenReady().then(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-pw-'));
  const sent = [];
  let pw = null;
  const toBrain = (m) => {
    sent.push(m);
    if (m.type === 'project_snapshot') {
      if (m.projectId === 'p2') return setTimeout(() => pw.fromBrain({ type: 'project_snapshot', reqId: m.reqId, projectId: 'p2', project: { id: 'p2', name: '贪吃蛇' }, plan: { ...plan, name: '贪吃蛇', agents: [{ id: 'g', role: '游戏', does: '写游戏' }], tasks: [] }, state: { status: 'done', tasks: {} }, card: { projectId: 'p2', name: '贪吃蛇', kind: 'done', status: 'done', costCny: 1, budgetCny: 30, agents: [], tasks: { done: 1, total: 1 }, result: { did: '一个贪吃蛇', run: 'npm start', checks: [] } }, request: '', events: m.light ? undefined : [] }), 20);
      setTimeout(() => pw.fromBrain({ type: 'project_snapshot', reqId: m.reqId, projectId: 'p1', project: { id: 'p1', name: '加法器', dir: 'D:\\x\\加法器' }, plan, pendingPlan: null, state: { status: 'running', tasks: { t1: { status: 'running', attempts: 1 } } }, card, request: '# 加法器\n\n## 宿主原话\n\n做个加法器\n', events: m.light ? undefined : events }), 20);
    }
    if (m.type === 'projects_query') setTimeout(() => pw.fromBrain({ type: 'projects', reqId: m.reqId, items: [{ id: 'p1', name: '加法器', card }, { id: 'p2', name: '贪吃蛇', card: { projectId: 'p2', kind: 'done' } }] }), 20);
  };
  pw = new ProjectWindow({ dataDir, toBrain, coreHome: () => null });
  pw.show('p1');
  const logs = [];
  pw.win.webContents.on('console-message', (_e, level, message) => level >= 2 && logs.push(message));
  const js = (code) => pw.win.webContents.executeJavaScript(code);
  for (let i = 0; i < 50; i++) {
    await wait(200);
    if (await js(`!!document.querySelector('.agi')`).catch(() => false)) break;
  }
  ok(pw.win.isVisible(), '项目页开出来了');
  ok(sent.some((m) => m.type === 'project_snapshot' && m.projectId === 'p1' && !m.light) && sent.some((m) => m.type === 'projects_query'), '开窗口就要快照和项目列表');
  const head = await js(`document.querySelector('.pphead').innerText`);
  ok(/加法器/.test(head) && /等你回答/.test(head) && /¥0\.40 \/ ¥30/.test(head), '顶栏：名字、状态、花费 / 预算', head);
  const banner = await js(`document.querySelector('.banner.ask')?.innerText || ''`);
  ok(/要不要支持小数/.test(banner) && /开发问的/.test(banner), '横幅：等你回答的问题', banner);
  const agents = await js(`[...document.querySelectorAll('.agi .n')].map(x => x.innerText.replace(/\\s+/g, ' '))`);
  ok(agents.length === 3 && /总指挥/.test(agents[0]) && /开发 进行中/.test(agents[1]) && /评审/.test(agents[2]), '左边：总指挥、开发（进行中）、评审', JSON.stringify(agents));
  // 选中开发：看到提示词和步骤
  await js(`document.querySelectorAll('.agi')[1].click()`);
  await wait(200);
  const proc = await js(`document.getElementById('pp-body').innerText`);
  ok(/总指挥 → 开发：「加法器」/.test(proc) && /## 宿主原话/.test(proc) && /✓\s*写文件：add\.js/.test(proc) && /开发问总指挥：要不要支持小数/.test(proc), '过程：收到的提示词、每一步、提问', proc.slice(0, 300));
  // 推一条新事件：追加到过程里
  pw.fromBrain({ type: 'project_event', projectId: 'p1', ev: { at: Date.now(), type: 'step', agent: 'dev', task: 't1', kind: 'tool', id: 's2', text: '执行命令：node test.js' } });
  pw.fromBrain({ type: 'project_event', projectId: 'p2', ev: { at: Date.now(), type: 'step', agent: 'dev', task: 't1', kind: 'tool', id: 's3', text: '别的项目的一步' } });
  await wait(300);
  const proc2 = await js(`document.getElementById('pp-body').innerText`);
  ok(/执行命令：node test\.js/.test(proc2) && !/别的项目的一步/.test(proc2), '新事件追加上去；别的项目的不显示');
  // 通信、计划、合并
  const tab = async (name) => {
    await js(`[...document.querySelectorAll('.tabs2 span')].find(s => s.textContent.startsWith(${JSON.stringify(name)})).click()`);
    await wait(150);
    return js(`document.getElementById('pp-body').innerText`);
  };
  const comm = await tab('通信');
  ok(/分派\s*总指挥\s*→\s*开发/.test(comm) && /问宿主\s*总指挥\s*→\s*宿主/.test(comm), '通信：分派、问宿主', comm.slice(0, 200));
  const planText = await tab('计划');
  ok(/做个加法器/.test(planText) && /add\.js/.test(planText) && /node test\.js/.test(planText), '计划：宿主原话、任务、检查命令', planText.slice(0, 200));
  const merge = await tab('合并');
  ok(/还没有合并/.test(merge), '合并：还没有');
  fs.writeFileSync(path.join(OUT, 'project-page.png'), (await pw.win.webContents.capturePage()).toPNG());
  // 按钮：回答、暂停、跟总指挥说话
  await js(`[...document.querySelectorAll('.banner.ask button')].find(b => b.textContent === '要').click()`);
  await js(`[...document.querySelectorAll('.pphead button')].find(b => b.textContent === '暂停').click()`);
  await js(`(() => { const i = document.getElementById('pp-say'); i.value = '按钮大一点'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await wait(200);
  const acts = sent.filter((m) => m.type === 'project_action');
  ok(acts.some((m) => m.action === 'answer' && m.qid === 'q1' && m.value === '要') && acts.some((m) => m.action === 'pause') && acts.some((m) => m.action === 'message' && m.value === '按钮大一点'), '按钮发出去：回答、暂停、跟总指挥说话', JSON.stringify(acts));
  ok(acts.every((m) => m.projectId === 'p1' && /^pw\d+$/.test(m.reqId)), '发出去的都带着项目和回给项目页的编号');
  // 回复显示在底下
  pw.fromBrain({ type: 'project_action_result', reqId: acts.find((m) => m.action === 'message').reqId, projectId: 'p1', action: 'message', ok: true, reply: '好，转给开发了' });
  await wait(150);
  ok(/总指挥：好，转给开发了/.test(await js(`document.getElementById('pp-reply').textContent`)), '总指挥的回复显示在底下');
  // 卡片更新：横幅跟着变
  pw.fromBrain({ type: 'project_card', card: { ...card, kind: 'paused', status: 'paused', pausedReason: 'host', question: null } });
  await wait(150);
  ok(/暂停着/.test(await js(`document.getElementById('pp-banner').innerText`)) && /继续/.test(await js(`document.querySelector('.pphead').innerText`)), '暂停了：横幅和按钮跟着变');
  // 换项目
  await js(`(() => { const s = document.querySelector('#pp-switch select'); s.value = 'p2'; s.dispatchEvent(new Event('change')); })()`);
  for (let i = 0; i < 20 && !/贪吃蛇/.test(await js(`document.querySelector('.pphead')?.innerText || ''`)); i++) await wait(100);
  ok(/贪吃蛇/.test(await js(`document.querySelector('.pphead').innerText`)) && pw.projectId === 'p2', '换项目：切过去了');
  ok(!logs.length, '没有报错（安全策略下脚本都能跑）', logs.join(' | '));
  pw.win.close();
  await wait(200);
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fails ? `\n${fails} 项没过（截图在 ${OUT}）` : `\n全部通过（截图在 ${OUT}）`);
  app.exit(fails ? 1 : 0);
});
app.on('window-all-closed', () => {});
