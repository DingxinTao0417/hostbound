// 项目模式的单元测试：授权规则、存盘、真的 git 副本和合并、检查命令、计划整理、总指挥的整个流程（假模型 + 假的干活的智能体）、
// Claude Code / Codex 的接法（假的命令行程序）、Claude Code 的授权钩子。全在临时文件夹里，不碰真实数据。node tools/test-projects.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRisk, outsidePaths } from '../brain/project-gate.mjs';
import { ProjectStore } from '../brain/project-store.mjs';
import * as G from '../brain/project-git.mjs';
import { runCommand, startAndWait } from '../brain/project-checks.mjs';
import * as P from '../brain/project-prompts.mjs';
import { Commander, normalizePlan } from '../brain/project-commander.mjs';
import { CliWorker, parseFinal } from '../brain/project-workers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 30_000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await wait(step);
  }
  return false;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-projects-'));
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

// ---------- 授权规则 ----------
{
  const dir = path.join(tmp, 'gate', 'proj');
  const wt = path.join(dir, '.hostbound', 'worktrees', 'fe-t1');
  const r = (toolName, input, cwd = wt) => projectRisk({ toolName, input }, { dir, cwd });
  ok('项目里写文件：放行', r('write', { path: 'src/a.js' }) === null);
  ok('写到项目外面：要问', r('write', { path: 'C:\\Windows\\x.txt' })?.label === '改项目文件夹外面的文件');
  ok('项目里删文件：放行', r('powershell', { command: 'Remove-Item -Recurse dist' }) === null);
  ok('装依赖：放行', r('powershell', { command: 'npm install' }) === null);
  ok('全局安装：要问', /全局/.test(r('powershell', { command: 'npm install -g typescript' })?.label || ''));
  ok('winget：要问', !!r('powershell', { command: 'winget install foo' }));
  ok('删项目外面的：要问', /外面/.test(r('powershell', { command: 'Remove-Item -Recurse D:\\other\\stuff' })?.label || ''));
  ok('删家目录里的：要问', !!r('powershell', { command: 'Remove-Item -Recurse $env:USERPROFILE\\Documents\\x' }));
  ok('关机：照样要问', !!r('powershell', { command: 'Stop-Computer' }));
  ok('只读外面的：放行', r('powershell', { command: 'Get-ChildItem C:\\Windows' }) === null);
  ok('临时文件夹不算外面', outsidePaths(`Remove-Item ${path.join(os.tmpdir(), 'x')}`, dir).length === 0);
}

// ---------- 存盘 ----------
{
  let clock = 1_800_000_000_000;
  const store = new ProjectStore({ dataDir: path.join(tmp, 'data'), root: () => path.join(tmp, 'projects'), now: () => clock++ });
  const p = store.create({ name: '记账: 网站?', request: '做一个记账网站' });
  ok('新项目：文件夹名去掉了不能用的字', path.basename(p.dir) === '记账 网站' && fs.existsSync(path.join(p.dir, '.hostbound', 'request.md')));
  ok('宿主原话存下了', /做一个记账网站/.test(store.readText(p.id, 'request.md')));
  fs.writeFileSync(path.join(p.dir, 'x.txt'), '1');
  const p2 = store.create({ name: '记账: 网站?', request: '再来一个' });
  ok('重名的文件夹：加 -2', p2.dir.endsWith('记账 网站-2'));
  ok('按名字找', store.find('记账')?.id === p2.id || store.find('记账')?.id === p.id);
  store.append(p.id, { type: 'x', n: 1 });
  store.append(p.id, { type: 'x', n: 2 });
  const evs = store.events(p.id);
  ok('事件追加、读回来', evs.filter((e) => e.type === 'x').length === 2 && evs[0].type === 'created');
  ok('事件按时间往后读', store.events(p.id, { after: evs.at(-2).at }).length === 1);
  const target = path.join(tmp, 'elsewhere');
  const moved = store.move(p2.id, target);
  ok('开工前换文件夹：.hostbound 搬过去', moved.dir === target && fs.existsSync(path.join(target, '.hostbound', 'request.md')) && !fs.existsSync(path.join(tmp, 'projects', '记账 网站-2', '.hostbound')));
  fs.mkdirSync(path.join(tmp, 'full'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'full', 'keep.txt'), 'x');
  const moved2 = store.move(p2.id, path.join(tmp, 'full'));
  ok('选了个有东西的文件夹：放进同名子文件夹', moved2.dir === path.join(tmp, 'full', '记账 网站') && read(path.join(tmp, 'full', 'keep.txt')) === 'x');
}

// ---------- git：副本、提交、合并、冲突 ----------
{
  const dir = path.join(tmp, 'git1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'readme.md'), 'hi\n');
  const repo = await G.ensureRepo(dir);
  ok('变成 git 仓库，开工前的文件提交了', repo.main === 'main' && (await G.fileTree(dir)).includes('readme.md'));
  ok('.gitignore 里有 .hostbound 和 node_modules', /\.hostbound\//.test(read(path.join(dir, '.gitignore'))) && /node_modules\//.test(read(path.join(dir, '.gitignore'))));
  const again = await G.ensureRepo(dir);
  ok('再来一次不重复提交', again.head === repo.head);
  const a = await G.addWorktree(dir, 'fe-t1', 't1');
  const b = await G.addWorktree(dir, 'be-t2', 't2');
  ok('两份副本、两个分支', fs.existsSync(path.join(a.wt, 'readme.md')) && a.branch === 'hb/t1' && b.branch === 'hb/t2');
  fs.writeFileSync(path.join(a.wt, 'a.txt'), 'A\n');
  fs.writeFileSync(path.join(a.wt, 'shared.txt'), 'from a\n');
  fs.writeFileSync(path.join(b.wt, 'b.txt'), 'B\n');
  fs.writeFileSync(path.join(b.wt, 'shared.txt'), 'from b\n');
  ok('系统替它提交', (await G.commitAll(a.wt, 'a')) === true && (await G.commitAll(b.wt, 'b')) === true);
  ok('没改东西就不提交', (await G.commitAll(a.wt, 'again')) === false);
  ok('分支改了哪些文件', (await G.changedFiles(dir, a.branch)).sort().join(',') === 'a.txt,shared.txt');
  const m1 = await G.tryMerge(dir, a.branch, '合并 a');
  ok('第一个合并成功（主线还没动）', m1.ok && (await G.headOf(dir)) === repo.head);
  await G.advanceMain(dir, m1.commit);
  ok('检查过了主线往前走', (await G.headOf(dir)) === m1.commit && read(path.join(dir, 'a.txt')) === 'A\n');
  const m2 = await G.tryMerge(dir, b.branch, '合并 b');
  ok('第二个跟第一个冲突：认出来、放弃这次合并', !m2.ok && m2.conflict && m2.files.includes('shared.txt'));
  ok('合并副本恢复干净', !(await G.git(m2.mw, ['status', '--porcelain'])).stdout.includes('UU'));
  await G.git(b.wt, ['merge', '--no-edit', 'main'], { allowFail: true });
  ok('把主线合进它的副本：冲突标记在文件里', /<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/.test(read(path.join(b.wt, 'shared.txt'))));
  fs.writeFileSync(path.join(b.wt, 'shared.txt'), 'from a\nfrom b\n');
  await G.commitAll(b.wt, '解决冲突');
  const m3 = await G.tryMerge(dir, b.branch, '合并 b');
  ok('解决完再合：成功', m3.ok);
  await G.advanceMain(dir, m3.commit);
  ok('主线上两边都在', read(path.join(dir, 'shared.txt')) === 'from a\nfrom b\n' && read(path.join(dir, 'b.txt')) === 'B\n');
  await G.removeWorktree(dir, a.wt, a.branch);
  await G.removeWorktree(dir, b.wt, b.branch);
  ok('副本收掉、分支删掉', !fs.existsSync(a.wt) && !(await G.git(dir, ['branch', '--list', 'hb/*'])).stdout.trim());
  fs.writeFileSync(path.join(dir, 'a.txt'), '宿主自己改的\n');
  const c = await G.addWorktree(dir, 'x', 't3');
  fs.writeFileSync(path.join(c.wt, 'a.txt'), 'agent\n');
  await G.commitAll(c.wt, 'c');
  const m4 = await G.tryMerge(dir, c.branch, 'c');
  let err = '';
  try {
    await G.advanceMain(dir, m4.commit);
  } catch (e) {
    err = e.message;
  }
  ok('宿主在主线上改了没提交的文件：主线不硬走', /主线没法直接往前走/.test(err) && read(path.join(dir, 'a.txt')) === '宿主自己改的\n');
  ok('diffStat / diffText', /file/.test(await G.diffStat(dir, repo.head)) && /from b/.test(await G.diffText(dir, repo.head)));
}

// ---------- 检查命令 ----------
{
  const dir = path.join(tmp, 'checks');
  fs.mkdirSync(dir, { recursive: true });
  const good = await runCommand('node -e "console.log(\'中文输出\')"', { cwd: dir });
  ok('命令过了：退出码 0、中文不乱码', good.ok && /中文输出/.test(good.output), JSON.stringify(good));
  const bad = await runCommand('node -e "process.exit(3)"', { cwd: dir });
  ok('命令没过：退出码带回来', !bad.ok && bad.code === 3);
  const slow = await runCommand('node -e "setTimeout(()=>{},20000)"', { cwd: dir, timeoutMs: 1500 });
  ok('超时：杀掉、算没过', !slow.ok && slow.timedOut && slow.ms < 8000);
  const port = 47000 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q,s)=>s.end('<h1>ok</h1>')).listen(${port}, '127.0.0.1')`);
  const s = await startAndWait('node server.js', `http://127.0.0.1:${port}`, { cwd: dir, timeoutMs: 20_000 });
  ok('启动服务器、等网址能打开', s.ok && s.status === 200, s.output);
  await s.stop();
  await wait(500);
  const gone = await fetch(`http://127.0.0.1:${port}`).then(() => false, () => true);
  ok('用完关掉（整棵进程树）', gone);
  fs.writeFileSync(path.join(dir, 'crash.js'), 'process.exit(1)');
  const crash = await startAndWait('node crash.js', `http://127.0.0.1:${port + 1}`, { cwd: dir, timeoutMs: 10_000 });
  ok('一启动就退出：马上报出来', !crash.ok && crash.ms < 8000);
}

// ---------- 计划整理、解析 ----------
{
  const plan = normalizePlan({
    name: '一个名字特别特别特别特别长的记账网站项目',
    agents: [{ id: 'FE!', role: '前端' }, { id: 'fe', role: '又一个前端' }, { role: '后端' }],
    tasks: [
      { id: 't1', agent: 'fe', title: '骨架', deps: ['t9', 't2'] },
      { id: 't2', agent: 'nobody', title: '接口', deps: ['t1'] },
      { id: 't2', agent: 'fe', title: '重复的 id' },
    ],
    checks: { test: ' npm test ', url: 'http://localhost:5173' },
  });
  ok('智能体 id 规整、去重', plan.agents.map((a) => a.id).join(',') === 'fe,fex,后端'.replace('后端', plan.agents[2].id) && new Set(plan.agents.map((a) => a.id)).size === 3);
  ok('任务 id 去重', new Set(plan.tasks.map((t) => t.id)).size === 3);
  ok('不存在的依赖去掉、成环的断开', !plan.tasks[0].deps.includes('t9') && !(plan.tasks[0].deps.includes('t2') && plan.tasks[1].deps.includes('t1')));
  ok('不存在的智能体：分给现有的', plan.agents.some((a) => a.id === plan.tasks[1].agent));
  ok('检查命令去空格；有网址就算网站', plan.checks.test === 'npm test' && plan.checks.web === true);
  ok('名字截短、估算补上', plan.name.length <= 21 && plan.estimate.minutes > 0 && plan.estimate.cny.length === 2);
  const empty = normalizePlan(null);
  ok('模型什么都没给：也有一个智能体、一个任务', empty.agents.length === 1 && empty.tasks.length === 1);
  const cont = normalizePlan({ agents: [{ id: 'fe', role: '前端' }], tasks: [{ id: 't1', agent: 'fe', title: '加页面', deps: ['t1x'] }] }, { prefix: 'r2-', old: plan });
  ok('接着改：任务 id 加前缀、沿用原来的智能体', cont.tasks[0].id === 'r2-t1' && cont.agents[0] === plan.agents[0]);
  ok('JSON 夹着别的字也能读', P.parseJson('好的：\n```json\n{"a":1}\n```')?.a === 1 && P.parseJson('没有') === null);
  ok('最后一行 QUESTION:', parseFinal('看了一下。\nQUESTION: 用什么端口？').kind === 'question');
  ok('REPORT: / BLOCKED:', parseFinal('REPORT: 做完了').text === '做完了' && parseFinal('x\nBLOCKED: 缺密钥').kind === 'blocked' && parseFinal('就这样').kind === 'report');
  const tp = P.taskPrompt({ project: { name: 'x' }, plan: { summary: 's', approach: 'a', tasks: [{ id: 't1', title: '骨架', report: '定好了' }], checks: { test: 'npm test' } }, task: { id: 't2', title: '页面', desc: 'd', files: ['src/'], deps: ['t1'] }, request: '宿主原话在这', answers: '问：颜色 答：深色', retry: '测试没过' });
  ok('任务提示：带着宿主原话、补充、前面做完的、上次的问题', /宿主原话在这/.test(tp) && /深色/.test(tp) && /定好了/.test(tp) && /测试没过/.test(tp) && /src\//.test(tp));
}

// ---------- 总指挥：整个流程（假模型 + 假的干活的） ----------
class FakeWorker extends EventEmitter {
  constructor(opts, script) {
    super();
    this.o = opts;
    this.script = script;
    this.runs = 0;
    this.prompts = [];
  }
  async run(prompt) {
    this.runs++;
    this.prompts.push(prompt);
    this.stopReason = null;
    return this.script(this, prompt, this.runs);
  }
  async steer(text) {
    this.steered = text;
    return true;
  }
  stop(reason) {
    this.stopReason = reason;
    this.wake?.();
  }
  dispose() {
    this.disposed = true;
  }
  // 干一会儿（可以被 stop 打断）
  work(ms) {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      this.wake = () => {
        clearTimeout(t);
        r();
      };
    });
  }
}

function makeLlm(answers) {
  const calls = [];
  const by = new Map([
    [P.PLAN_PROMPT, 'plan'],
    [P.REPLAN_PROMPT, 'replan'],
    [P.ANSWER_PROMPT, 'answer'],
    [P.TRIAGE_PROMPT, 'triage'],
    [P.FIX_PROMPT, 'fix'],
    [P.MESSAGE_PROMPT, 'message'],
    [P.SUMMARY_PROMPT, 'summary'],
    [P.SHOT_PROMPT, 'shot'],
  ]);
  const fn = async (system, content) => {
    const kind = by.get(system) || 'other';
    calls.push({ kind, content });
    const a = answers[kind];
    const v = typeof a === 'function' ? a(content, calls) : a;
    return { text: typeof v === 'string' ? v : JSON.stringify(v ?? {}), usd: 0.001 };
  };
  fn.calls = calls;
  return fn;
}

const stripMarkers = (s) => s.split(/\r?\n/).filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join('\n');

{
  // 场景一：三个智能体；前端问了个要宿主拿主意的问题；后端跟前端改了同一个文件（冲突）、第一次的代码测试不过；
  // 评审第一次提了问题 → 派一轮修 → 再评审没问题 → 完成
  const store = new ProjectStore({ dataDir: path.join(tmp, 'data-a'), root: () => path.join(tmp, 'pa') });
  const p = store.create({ name: '小网站', request: '做一个小网站，分前端后端' });
  const cfgObj = { projects: { maxConcurrent: 12, budget: 30, maxTurns: 80, usdToCny: 7.2 } };
  const llm = makeLlm({
    plan: {
      name: '小网站',
      summary: '前后端两块的小网站',
      approach: 'Node.js',
      agents: [{ id: 'arch', role: '架构' }, { id: 'fe', role: '前端' }, { id: 'be', role: '后端' }],
      tasks: [
        { id: 't1', agent: 'arch', title: '骨架', desc: '定目录和测试', files: ['package.json', 'test.js', 'parts/'] },
        { id: 't2', agent: 'fe', title: '前端', desc: '写 parts/fe.js', files: ['parts/fe.js'], deps: ['t1'] },
        { id: 't3', agent: 'be', title: '后端', desc: '写 parts/be.js', files: ['parts/be.js'], deps: ['t1'] },
      ],
      checks: { install: '', build: '', test: 'node test.js', start: '', url: '', web: false },
      estimate: { minutes: 20, cny: [2, 5] },
    },
    answer: (content) => (/颜色/.test(content) ? { ask: '页面要深色还是浅色？', options: ['深色', '浅色'] } : { answer: '用 node 自带的就行' }),
    fix: { tasks: [{ agent: 'fe', title: '加深色', desc: 'fe.js 要有 dark', files: ['parts/fe.js'] }] },
    summary: { did: '做了前端后端两块，1 个测试', run: 'node test.js', notes: '' },
    triage: { action: 'retry', note: '再改改' },
    message: { reply: '收到，已经转给前端', forward: [{ agent: 'fe', message: '按钮大一点' }], tasks: [] },
  });
  let active = 0;
  let maxActive = 0;
  let reviews = 0;
  const workers = [];
  const script = async (w, prompt, n) => {
    const { cwd, task } = w.o;
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      w.emit('step', { kind: 'tool', name: 'write', text: `写文件：${task.id}` });
      w.emit('cost', { usd: 0.01 });
      if (task.kind === 'review') {
        reviews++;
        await w.work(50);
        return { status: 'reported', report: { status: 'done', summary: reviews === 1 ? '有一个问题' : '没问题', issues: reviews === 1 ? ['parts/fe.js 没有 dark 主题'] : [] } };
      }
      if (/冲突/.test(prompt)) {
        const f = path.join(cwd, 'shared.txt');
        fs.writeFileSync(f, stripMarkers(read(f)));
      }
      if (task.id === 't1') {
        fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"x","scripts":{"test":"node test.js"}}');
        fs.mkdirSync(path.join(cwd, 'parts'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'parts', '.keep'), '');
        fs.writeFileSync(path.join(cwd, 'test.js'), `const fs=require('fs');for(const f of fs.readdirSync('parts').filter(f=>f.endsWith('.js'))){const m=require('./parts/'+f);if(m.ok!==true){console.error(f+' 不对');process.exit(1)}}console.log('测试都过了')`);
      }
      if (task.id === 't2') {
        await w.work(400);
        w.answer = await w.o.ask({ question: '页面颜色用什么？', options: [] });
        fs.writeFileSync(path.join(cwd, 'parts', 'fe.js'), 'module.exports={ok:true}');
        if (!/冲突/.test(prompt)) fs.writeFileSync(path.join(cwd, 'shared.txt'), 'fe line\n');
      }
      if (task.id === 't3') {
        await w.work(n === 1 ? 1500 : 50);
        w.techAnswer = w.techAnswer || (await w.o.ask({ question: '用哪个测试库？', options: [] }));
        fs.writeFileSync(path.join(cwd, 'parts', 'be.js'), n >= 3 || /测试没过|没过/.test(prompt) ? 'module.exports={ok:true}' : 'module.exports={ok:false}');
        if (n === 1) fs.writeFileSync(path.join(cwd, 'shared.txt'), 'be line\n');
      }
      if (task.kind === 'fix') fs.writeFileSync(path.join(cwd, 'parts', 'fe.js'), 'module.exports={ok:true,dark:true}');
      if (w.stopReason) return { status: w.stopReason };
      return { status: 'reported', report: { status: 'done', summary: `${task.title} 做完了` } };
    } finally {
      active--;
    }
  };
  const asks = [];
  const says = [];
  const cards = [];
  const c = new Commander({
    store,
    id: p.id,
    cfg: () => cfgObj,
    runtime: () => null,
    model: () => null,
    root: ROOT,
    complete: llm,
    workerFactory: (o) => {
      const w = new FakeWorker(o, script);
      workers.push(w);
      return w;
    },
  });
  c.on('ask', (q) => asks.push(q));
  c.on('say', (t) => says.push(t));
  c.on('card', (x) => cards.push(x));
  c.on('ask', (q) => {
    if (q.kind === 'question') setTimeout(() => c.answer(q.qid, '深色'), 30);
  });
  await c.start();
  ok('写好计划：等宿主看', c.state.status === 'awaiting_approval' && c.card().kind === 'plan' && c.card().planTasks.length === 3);
  ok('计划存进 plan.json', store.readJson(p.id, 'plan.json')?.tasks?.length === 3);
  const before = await c.approve();
  ok('开工：念「项目开工」', before && says.some((s) => /项目开工/.test(s)) && c.state.status === 'running');
  const done = await until(() => c.state.status === 'done', 90_000);
  ok('整个项目做完了', done, `status=${c.state.status} tasks=${JSON.stringify(c.state.tasks)}`);
  const evs = store.events(p.id);
  const types = new Set(evs.map((e) => e.type));
  ok('前端后端同时干', maxActive >= 2, `max=${maxActive}`);
  ok('派活的提示词记下了（带系统提示）', evs.some((e) => e.type === 'dispatch' && e.task === 't2' && /做一个小网站/.test(e.prompt) && e.system !== undefined));
  ok('技术问题：总指挥自己答', evs.some((e) => e.type === 'answer' && e.by === 'commander') && /node 自带/.test(workers.find((w) => w.o.task.id === 't3')?.techAnswer || ''));
  ok('要宿主拿主意的：转给宿主，回答带回去', asks.some((q) => q.kind === 'question' && /深色/.test(q.text)) && workers.find((w) => w.o.task.id === 't2')?.answer === '宿主回答：深色');
  ok('宿主的回答记进 request.md', /深色/.test(store.readText(p.id, 'request.md')));
  ok('合并冲突：认出来、退回给原来那个', evs.some((e) => e.type === 'merge' && e.conflict) && evs.some((e) => e.type === 'retry' && /冲突/.test(e.why)));
  ok('合并后测试没过：退回去改', evs.some((e) => e.type === 'check' && e.scope === 'merge' && !e.ok) && evs.some((e) => e.type === 'retry' && /测试没过/.test(e.why)));
  ok('评审提了问题 → 派一轮修', evs.some((e) => e.type === 'review' && e.issues.length) && evs.some((e) => e.type === 'fix') && c.plan.tasks.some((t) => t.kind === 'fix'));
  ok('修完又评审了一次', reviews === 2);
  ok('最后检查在项目文件夹里跑过', evs.some((e) => e.type === 'check' && e.scope === 'final' && e.ok));
  ok('主线上东西齐了', /dark:true/.test(read(path.join(p.dir, 'parts', 'fe.js'))) && /ok:true/.test(read(path.join(p.dir, 'parts', 'be.js'))) && /fe line/.test(read(path.join(p.dir, 'shared.txt'))) && /be line/.test(read(path.join(p.dir, 'shared.txt'))));
  const wts = fs.existsSync(G.worktreesDir(p.dir)) ? fs.readdirSync(G.worktreesDir(p.dir)).filter((n) => n !== '_merge') : [];
  ok('干活的副本都收掉了', wts.length === 0, wts.join(','));
  ok('完成：念「项目完成」、卡片有总结', says.some((s) => /项目完成/.test(s)) && c.card().kind === 'done' && /前端后端/.test(c.card().result?.did || ''));
  ok('花费记下了（人民币）', c.card().costCny > 0 && c.state.costUsd > 0.05);
  ok('事件种类齐', ['plan', 'approved', 'dispatch', 'step', 'question', 'ask_host', 'host_answer', 'report', 'commit', 'merge', 'merged', 'check', 'retry', 'review', 'fix', 'task_done', 'done'].every((t) => types.has(t)), [...types].join(','));
  ok('git 历史里是系统的身份', /Hostbound/.test((await G.git(p.dir, ['log', '-1', '--format=%an'])).stdout));
  const snap = c.snapshot();
  ok('项目页的快照：计划、状态、事件', snap.plan && snap.state && snap.events.length > 20 && snap.card.name === '小网站');
  ok('给大脑的一句话', /小网站（做完了，任务 \d+\/\d+/.test(c.brief()), c.brief());
  c.dispose();
}

{
  // 场景二：一个智能体；中途要授权（宿主拒绝）；预算不够了（加预算）；暂停、系统「重启」、继续；
  // 第二个任务做不下去（宿主说跳过）；网站：启动 + 截图看首页；做完以后接着改
  const store = new ProjectStore({ dataDir: path.join(tmp, 'data-b'), root: () => path.join(tmp, 'pb') });
  const p = store.create({ name: '小站', request: '做一个只有首页的小站' });
  const port = 48000 + Math.floor(Math.random() * 1000);
  const cfgObj = { projects: { maxConcurrent: 12, budget: 1, maxTurns: 80, usdToCny: 7.2 } };
  const llm = makeLlm({
    plan: {
      name: '小站',
      summary: '一个首页',
      approach: 'Node http',
      agents: [{ id: 'dev', role: '开发' }],
      tasks: [
        { id: 'a1', agent: 'dev', title: '首页', desc: '写 server.js', files: ['server.js'] },
        { id: 'a2', agent: 'dev', title: '统计', desc: '加统计', files: ['stats.js'], deps: ['a1'] },
      ],
      checks: { start: 'node server.js', url: `http://127.0.0.1:${port}`, web: true },
    },
    triage: { action: 'ask', ask: '统计做不了（要账号），跳过吗？', options: ['跳过'] },
    shot: { ok: true, note: '首页正常' },
    summary: { did: '做了一个首页', run: 'node server.js', notes: '统计没做' },
    replan: { agents: [{ id: 'dev', role: '开发' }], tasks: [{ id: 't1', agent: 'dev', title: '关于页', desc: '加 /about' }] },
  });
  const confirms = [];
  const asks = [];
  let shots = 0;
  let a1Runs = 0;
  const script = async (w, prompt, n) => {
    const { cwd, task } = w.o;
    if (task.kind === 'review') return { status: 'reported', report: { status: 'done', summary: '没问题', issues: [] } };
    if (task.id === 'a1') {
      a1Runs++;
      if (a1Runs === 1) {
        const allowed = await w.o.confirm({ label: '删除文件（项目文件夹外面）', detail: 'Remove-Item D:\\x' });
        w.allowed = allowed;
        w.emit('cost', { usd: 0.12 }); // ¥0.86：到八成
        await w.work(5000); // 等着被暂停
        return { status: w.stopReason || 'reported', report: { status: 'done', summary: '没做完' } };
      }
      w.emit('cost', { usd: 0.03 }); // 超过 ¥1
      fs.writeFileSync(path.join(cwd, 'server.js'), `require('http').createServer((q,s)=>s.end(q.url==='/about'?'about':'<h1>home</h1>')).listen(${port}, '127.0.0.1')`);
      w.secondPrompt = prompt;
      return { status: 'reported', report: { status: 'done', summary: '首页好了' } };
    }
    if (task.id === 'a2') return { status: 'blocked', report: { status: 'blocked', summary: '要统计平台的账号' } };
    fs.writeFileSync(path.join(cwd, 'about.txt'), 'about');
    return { status: 'reported', report: { status: 'done', summary: '关于页好了' } };
  };
  const workers = [];
  const make = () =>
    new Commander({
      store,
      id: p.id,
      cfg: () => cfgObj,
      runtime: () => null,
      model: () => null,
      root: ROOT,
      complete: llm,
      workerFactory: (o) => {
        const w = new FakeWorker(o, script);
        workers.push(w);
        return w;
      },
      checks: {
        shot: async (url, file) => {
          shots++;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
          return { ok: true, file };
        },
      },
    });
  let c = make();
  const wire = (c) => {
    c.on('confirm', (x) => {
      confirms.push(x);
      setTimeout(() => c.confirmAnswer(x.cid, 'deny'), 20);
    });
    c.on('ask', (q) => asks.push(q));
  };
  wire(c);
  await c.start();
  const newDir = path.join(tmp, 'pb-picked');
  c.setDir(newDir);
  ok('开工前换了文件夹', c.dir === newDir && fs.existsSync(path.join(newDir, '.hostbound', 'plan.json')));
  await c.approve();
  ok('要授权的操作：问宿主，拒绝了就不做', (await until(() => workers[0]?.allowed === false, 5000)) && confirms[0]?.label.includes('外面') && confirms[0]?.agent === '开发');
  await until(() => c.state.warned, 3000);
  ok('花到八成：提醒', c.state.warned && store.events(p.id).some((e) => e.type === 'budget' && e.level === 'warn'));
  ok('暂停：正在干的停下、任务回到没做完', c.pause() && (await until(() => c.state.tasks.a1?.status === 'pending', 3000)) && c.card().kind === 'paused');
  c.dispose();
  c = make(); // 系统重启
  wire(c);
  ok('重启后：还是暂停着', c.state.status === 'paused');
  c.resume();
  ok('继续：接着做（告诉它上次做到一半）', await until(() => /做到一半/.test(workers.at(-1)?.secondPrompt || ''), 10_000), workers.at(-1)?.prompts?.[0]?.slice(0, 200));
  ok('预算用完：先问宿主', await until(() => asks.some((q) => q.kind === 'budget'), 10_000));
  ok('等宿主决定时不派新活', c.state.tasks.a2?.status !== 'running');
  c.answer(asks.find((q) => q.kind === 'budget').qid, '再加 ¥5');
  ok('加了预算接着做', await until(() => c.budgetCny === 6, 3000), String(c.budgetCny));
  ok('做不下去：总指挥问宿主', await until(() => asks.some((q) => q.kind === 'triage'), 15_000));
  c.answer(asks.find((q) => q.kind === 'triage').qid, '跳过这个任务');
  ok('宿主说跳过：做完', await until(() => c.state.status === 'done', 60_000), c.state.status);
  const evs = store.events(p.id);
  ok('网站：启动过、截图看过首页', shots === 1 && evs.some((e) => e.type === 'check' && e.name === 'start' && e.ok) && evs.some((e) => e.type === 'check' && e.name === 'shot' && e.ok));
  ok('跳过的任务记下了', c.state.tasks.a2.status === 'skipped');
  ok('完成卡：网址、启动命令', c.card().result.url === `http://127.0.0.1:${port}` && c.card().result.start === 'node server.js');
  const site = await c.openSite();
  const page = site.ok ? await fetch(site.url).then((r) => r.text()) : '';
  ok('「打开网站」：宿主点了才跑起来', site.ok && /home/.test(page));
  await c.closeSite();
  // 接着改
  const reply = await c.message('加一个关于页');
  ok('做完了再说要改：写一个小计划等宿主看', /修改计划/.test(reply) && c.card().kind === 'plan' && c.card().continued && c.state.pendingPlan.tasks[0].id === 'r2-t1');
  await c.approve();
  ok('接着改的也做完了', await until(() => c.state.status === 'done' && c.state.tasks['r2-t1']?.status === 'done', 60_000), c.state.status);
  ok('改的东西进了主线', fs.existsSync(path.join(c.dir, 'about.txt')));
  c.dispose();
}

{
  // 场景三：宿主在项目页对总指挥说话：转给正在干的那个；暂停后停下
  const store = new ProjectStore({ dataDir: path.join(tmp, 'data-c'), root: () => path.join(tmp, 'pc') });
  const p = store.create({ name: '说话', request: '做一个东西' });
  const llm = makeLlm({
    plan: { agents: [{ id: 'fe', role: '前端' }], tasks: [{ id: 't1', agent: 'fe', title: '页面' }], checks: {} },
    message: { reply: '好，转给前端了', forward: [{ agent: 'fe', message: '按钮做大一点' }], tasks: [{ agent: 'fe', title: '加页脚', desc: '页面底下加页脚' }] },
  });
  let w0;
  const c = new Commander({
    store,
    id: p.id,
    cfg: () => ({ projects: { budget: 0 } }),
    runtime: () => null,
    model: () => null,
    root: ROOT,
    complete: llm,
    workerFactory: (o) => (w0 = new FakeWorker(o, async (w) => (await w.work(10_000), { status: w.stopReason || 'reported', report: { status: 'done', summary: 'x' } }))),
  });
  await c.start();
  await c.message('页面要有个大标题');
  ok('开工前补充要求：重写计划', llm.calls.filter((x) => x.kind === 'plan').length === 2 && /大标题/.test(llm.calls.at(-1).content) && c.state.status === 'awaiting_approval');
  await c.approve();
  await until(() => w0, 3000);
  const reply = await c.message('按钮大一点');
  ok('宿主说话：总指挥回一句、插给正在干的', reply === '好，转给前端了' && /按钮做大一点/.test(w0.steered || ''));
  ok('宿主说话：加了新任务', c.plan.tasks.some((t) => t.kind === 'extra' && t.title === '加页脚'));
  ok('预算 0：不限', !c.state.budgetAsked);
  ok('停下：干活的都停了', c.stop() && (await until(() => w0.stopReason === 'stopped', 2000)) && c.card().kind === 'stopped');
  c.dispose();
}

// ---------- Claude Code / Codex：假的命令行程序 ----------
{
  const dir = path.join(tmp, 'cli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'fake-claude.mjs'),
    `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const args=process.argv.slice(2);const resume=args.includes('--resume');const o=(j)=>console.log(JSON.stringify(j));
o({type:'system',subtype:'init',session_id:'sess-1'});
o({type:'assistant',message:{content:[{type:'text',text:'看一下'},{type:'tool_use',id:'tu1',name:'Bash',input:{command:'npm test'}}]}});
o({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tu1',content:'ok',is_error:false}]}});
if(!resume){o({type:'result',subtype:'success',session_id:'sess-1',total_cost_usd:0.02,result:'先问一下。\\nQUESTION: 用什么端口？ ARGS='+(args.includes('--append-system-prompt')?'sys':'')+(args.includes('--settings')?'+settings':'')});}
else{o({type:'result',subtype:'success',session_id:'sess-1',total_cost_usd:0.05,result:'REPORT: 端口用了 3000，'+input.trim()});}
});`,
  );
  fs.writeFileSync(path.join(dir, 'claude.cmd'), `@node "%~dp0fake-claude.mjs" %*\r\n`);
  const asked = [];
  const steps = [];
  let usd = 0;
  const w = new CliWorker({ engine: 'claude', id: 'fe', role: '前端', cwd: dir, system: '系统提示', bin: path.join(dir, 'claude.cmd'), ask: async (q) => (asked.push(q.question), '3000'), hook: 'node hook.mjs', settingsFile: path.join(dir, 'settings.json') });
  w.on('step', (s) => steps.push(s));
  w.on('cost', (c) => (usd += c.usd));
  const r = await w.run('做个页面');
  ok('Claude Code：问的问题转给总指挥', /端口/.test(asked[0] || '') && /sys\+settings/.test(asked[0] || ''), JSON.stringify({ asked, r }));
  ok('Claude Code：回答后 resume 接着做、汇报', r.status === 'reported' && /3000/.test(r.report.summary) && /总指挥回答：3000/.test(r.report.summary));
  ok('Claude Code：步骤和花费', steps.some((s) => s.kind === 'tool' && /npm test/.test(s.text)) && steps.some((s) => s.kind === 'tool_end') && Math.abs(usd - 0.07) < 1e-9, `usd=${usd}`);
  ok('Claude Code：授权钩子写进设置文件', /PreToolUse/.test(read(path.join(dir, 'settings.json'))) && /hook\.mjs/.test(read(path.join(dir, 'settings.json'))));
  fs.writeFileSync(
    path.join(dir, 'fake-codex.mjs'),
    `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const o=(j)=>console.log(JSON.stringify(j));const args=process.argv.slice(2);
o({type:'thread.started',thread_id:'th-9'});
o({type:'item.started',item:{id:'i1',type:'command_execution',command:'npm run build'}});
o({type:'item.completed',item:{id:'i1',type:'command_execution',command:'npm run build',exit_code:0,status:'completed'}});
o({type:'item.completed',item:{id:'i2',type:'file_change',changes:[{path:'src/a.js'}]}});
o({type:'item.completed',item:{id:'i3',type:'agent_message',text:'REPORT: 好了 '+(args.includes('workspace-write')?'sandbox':'')+(input.includes('系统提示')?'+sys':'')+(args.join(' ').includes('network_access=true')?'+net':'')}});
});`,
  );
  fs.writeFileSync(path.join(dir, 'codex.cmd'), `@node "%~dp0fake-codex.mjs" %*\r\n`);
  const cs = [];
  const cw = new CliWorker({ engine: 'codex', id: 'be', role: '后端', cwd: dir, system: '系统提示', bin: path.join(dir, 'codex.cmd') });
  cw.on('step', (s) => cs.push(s));
  const cr = await cw.run('做接口');
  ok('Codex：沙箱只许写这个文件夹、能联网、带系统提示', cr.status === 'reported' && /sandbox\+sys\+net/.test(cr.report.summary), JSON.stringify(cr));
  ok('Codex：命令和改文件都记成步骤', cs.some((s) => /npm run build/.test(s.text)) && cs.some((s) => /src\/a\.js/.test(s.text)) && cw.sessionId === 'th-9');
  const missing = await new CliWorker({ engine: 'codex', id: 'x', role: 'x', cwd: dir, system: '', bin: 'no-such-codex-xyz' }).run('x');
  ok('没装：说清楚', missing.status === 'error' && /没找到/.test(missing.error));
}

// ---------- Claude Code 的授权钩子 ----------
{
  const dir = path.join(tmp, 'hook', 'proj');
  const confirmDir = path.join(tmp, 'hook', 'confirm');
  fs.mkdirSync(dir, { recursive: true });
  const runHook = (ev, onReq) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'project-hook.mjs')], { env: { ...process.env, HOSTBOUND_PROJECT_DIR: dir, HOSTBOUND_CONFIRM_DIR: confirmDir } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => {
        try {
          resolve(JSON.parse(out).hookSpecificOutput);
        } catch {
          resolve({ raw: out });
        }
      });
      p.stdin.end(JSON.stringify(ev));
      if (onReq) {
        const t = setInterval(() => {
          const reqs = fs.existsSync(confirmDir) ? fs.readdirSync(confirmDir).filter((n) => n.endsWith('.json')) : [];
          if (!reqs.length) return;
          clearInterval(t);
          const req = JSON.parse(read(path.join(confirmDir, reqs[0])));
          fs.writeFileSync(path.join(confirmDir, reqs[0].replace('.json', '.answer')), onReq(req));
        }, 100);
      }
    });
  const a = await runHook({ tool_name: 'Bash', tool_input: { command: 'npm install' }, cwd: dir });
  ok('钩子：项目里装依赖放行', a.permissionDecision === 'allow', JSON.stringify(a));
  const b = await runHook({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'a.js') }, cwd: dir });
  ok('钩子：项目里写文件放行', b.permissionDecision === 'allow');
  let seen = null;
  const c = await runHook({ tool_name: 'Bash', tool_input: { command: 'npm install -g typescript' }, cwd: dir }, (req) => ((seen = req), 'deny'));
  ok('钩子：全局安装写请求问宿主，拒绝就不做', c.permissionDecision === 'deny' && /全局/.test(seen?.label || ''), JSON.stringify(c));
  const d = await runHook({ tool_name: 'Write', tool_input: { file_path: 'C:\\Windows\\x.txt' }, cwd: dir }, () => 'allow');
  ok('钩子：宿主允许了就放行', d.permissionDecision === 'allow');
  ok('钩子：请求文件用完删掉', fs.readdirSync(confirmDir).length === 0);
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
console.log(fails ? `\n${fails} 项没过` : '\n全部通过');
process.exit(fails ? 1 : 0);
