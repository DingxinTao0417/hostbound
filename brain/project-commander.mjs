// 项目模式的总指挥：一个项目一个。写计划 → 宿主点开工 → 按先后、并发上限派活（每个智能体一次一个任务，各在一份代码副本里）
// → 干完由系统提交、排队合并（合并副本里构建、测试过了主线才往前走，不过就退回给原来那个智能体改）
// → 全做完：最后检查（装依赖、构建、测试、启动、截图看首页）→ 评审 → 有问题再派一轮修（最多两轮）→ 写总结。
// 干活的问问题：总指挥能答的自己答，要宿主拿主意的转给宿主；要授权的操作一律问宿主。花费到预算 80% 提醒，用完先停下问宿主。
// 所有事写进 .hostbound\events.jsonl（项目页就读它）。设计稿 design/projects.html，调研 docs/research-projects.md
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import * as G from './project-git.mjs';
import { runCommand, startAndWait, screenshot } from './project-checks.mjs';
import { projectRisk } from './project-gate.mjs';
import { assessRisk } from './risk.mjs';
import { PiWorker, CliWorker } from './project-workers.mjs';
import * as P from './project-prompts.mjs';

const MAX_ATTEMPTS = 3; // 一个任务最多做几次（第一次 + 退回来改两次），再不行就问宿主
const FIX_ROUNDS = 2; // 最后检查 / 评审发现问题，最多再派几轮修
const BUSY = new Set(['running', 'checking']);
const CHECK_NAMES = { install: '装依赖', build: '构建', test: '测试', start: '启动', shot: '看首页' };

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const fwd = (p) => String(p).split(path.sep).join('/');
const slugId = (s, i) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 16) || `a${i + 1}`;

// 模型写的计划可能缺这少那：补齐、去重、去掉指向不存在任务的依赖和成环的依赖
export function normalizePlan(raw, { prefix = '', old = null } = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const agents = [];
  const seen = new Set(old?.agents?.map((a) => a.id) || []);
  for (const [i, a] of (Array.isArray(p.agents) ? p.agents : []).entries()) {
    let id = slugId(a?.id || a?.role, i);
    const existing = old?.agents?.find((x) => x.id === id);
    if (existing) {
      agents.push(existing);
      continue;
    }
    while (agents.some((x) => x.id === id) || (seen.has(id) && !existing)) id += 'x';
    agents.push({ id, role: clip(a?.role || '开发', 8), does: clip(a?.does || '', 80) });
  }
  if (!agents.length) agents.push(old?.agents?.[0] || { id: 'dev', role: '开发', does: '全部' });
  const tasks = [];
  const ids = new Set(old?.tasks?.map((t) => t.id) || []);
  const rename = new Map();
  for (const [i, t] of (Array.isArray(p.tasks) ? p.tasks : []).slice(0, 40).entries()) {
    let id = `${prefix}${String(t?.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 16) || `t${i + 1}`}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    if (t?.id) rename.set(String(t.id), id);
    const agent = [...agents, ...(old?.agents || [])].find((a) => a.id === slugId(t?.agent, -1))?.id || agents[i % agents.length].id;
    tasks.push({ id, agent, title: clip(t?.title || `任务 ${i + 1}`, 16), desc: String(t?.desc || t?.title || '').slice(0, 2000), files: (Array.isArray(t?.files) ? t.files : []).map(String).slice(0, 20), deps: Array.isArray(t?.deps) ? t.deps.map(String) : [], done: clip(t?.done || '', 200) });
  }
  if (!tasks.length) tasks.push({ id: `${prefix}t1`, agent: agents[0].id, title: '做出来', desc: String(p.summary || ''), files: [], deps: [], done: '' });
  // 依赖：只留指向存在的任务的（新计划里的先改名），再按顺序去掉成环的
  const known = new Set([...(old?.tasks?.map((t) => t.id) || []), ...tasks.map((t) => t.id)]);
  for (const t of tasks) t.deps = [...new Set(t.deps.map((d) => rename.get(d) || d).filter((d) => known.has(d) && d !== t.id))];
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  const reach = (from, to, stack = new Set()) => {
    if (from === to) return true;
    if (stack.has(from)) return false;
    stack.add(from);
    return (tasks.find((t) => t.id === from)?.deps || []).some((d) => reach(d, to, stack));
  };
  for (const t of tasks) t.deps = t.deps.filter((d) => !(order.has(d) && reach(d, t.id)));
  const c = p.checks && typeof p.checks === 'object' ? p.checks : old?.checks || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const checks = { install: str(c.install), build: str(c.build), test: str(c.test), start: str(c.start), url: str(c.url), web: c.web === true || (c.web !== false && !!str(c.url)) };
  const e = p.estimate || {};
  const cny = Array.isArray(e.cny) ? e.cny.map(Number).filter((x) => x >= 0).slice(0, 2) : [];
  return {
    name: clip(p.name || old?.name || '新项目', 20),
    summary: clip(p.summary || old?.summary || '', 200),
    approach: clip(p.approach || old?.approach || '', 160),
    agents,
    tasks,
    checks,
    estimate: { minutes: Math.max(1, Math.round(Number(e.minutes) || tasks.length * 8)), cny: cny.length === 2 ? cny : [1, Math.max(3, tasks.length * 2)] },
  };
}

export class Commander extends EventEmitter {
  // store：ProjectStore；id：项目；cfg()：当前配置；runtime() / model()：大脑的模型运行时和模型；root：Hostbound 的目录（找 agent-browser、钩子）
  // 测试可以换掉：complete(system, content) → { text, usd }、workerFactory(opts) → 干活的、checks { run, start, shot }
  constructor({ store, id, cfg, runtime, model, root, complete, workerFactory, checks, log = () => {}, now = () => Date.now() }) {
    super();
    Object.assign(this, { store, id, cfg, runtime, model, root, log, now });
    this.completeFn = complete || null;
    this.workerFactory = workerFactory || null;
    this.check = { run: runCommand, start: startAndWait, shot: screenshot, ...(checks || {}) };
    this.plan = store.readJson(id, 'plan.json');
    this.state = store.readJson(id, 'state.json') || { status: 'planning', costUsd: 0, round: 1, tasks: {}, questions: [], answers: '', agentNotes: {}, fixRounds: 0, reviewed: 0 };
    this.workers = new Map(); // 任务 id → 干活的
    this.waiters = new Map(); // 问题 id → 宿主回答了就调
    this.confirms = new Map(); // 授权 id → 宿主回答了就调
    this.mergeQueue = [];
    this.merging = false;
    this.seq = 0;
    this.ctl = new AbortController();
    // 重启以后：正在干的项目先停在「暂停」，宿主点继续再接着做
    if (BUSY.has(this.state.status) || this.state.status === 'planning') {
      for (const ts of Object.values(this.state.tasks)) if (ts.status === 'running') ts.status = 'pending';
      if (this.state.status !== 'planning') this.#setStatus('paused', 'restart');
      else if (this.state.pendingPlan || (this.plan && !this.state.startedAt)) this.#setStatus('awaiting_approval');
      else if (this.state.startedAt) this.#setStatus('done'); // 接着改的计划写到一半：回到做完的样子，宿主再说一遍
      else {
        this.state.error = '计划写到一半系统重启了，再说一遍要做什么';
        this.#setStatus('failed');
      }
      this.#save();
    }
  }

  get project() {
    return this.store.get(this.id);
  }
  get dir() {
    return this.project?.dir;
  }
  get pcfg() {
    return this.cfg()?.projects || {};
  }

  // ---------- 存盘、事件、卡片 ----------
  #save() {
    this.store.writeJson(this.id, 'state.json', this.state);
  }
  #event(ev) {
    return this.store.append(this.id, ev);
  }
  #setStatus(status, reason = null) {
    this.state.status = status;
    this.state.pausedReason = status === 'paused' ? reason : null;
    this.store.update(this.id, { status });
    this.#event({ type: 'status', status, reason });
  }
  #ts(id) {
    return (this.state.tasks[id] ||= { status: 'pending', attempts: 0 });
  }
  #allTasks() {
    return this.plan?.tasks || [];
  }
  #agent(id) {
    return this.plan?.agents?.find((a) => a.id === id) || { id, role: id };
  }
  get usdToCny() {
    return Number(this.pcfg.usdToCny) || 7.2;
  }
  get budgetCny() {
    return this.state.budgetCny ?? Number(this.pcfg.budget ?? 30);
  }
  get costCny() {
    return (this.state.costUsd || 0) * this.usdToCny;
  }

  // 主聊天里的那张卡要的东西
  card() {
    const p = this.project || {};
    const tasks = this.#allTasks();
    const done = tasks.filter((t) => ['done', 'skipped'].includes(this.#ts(t.id).status)).length;
    const q = this.state.questions.find((x) => x.status === 'open');
    const st = this.state.status;
    const kind = st === 'awaiting_approval' ? 'plan' : q && !['stopped', 'done'].includes(st) ? 'ask' : st === 'done' ? 'done' : st;
    const plan = this.state.pendingPlan || this.plan;
    return {
      projectId: this.id,
      name: p.name,
      dir: p.dir,
      status: st,
      kind,
      continued: !!this.state.pendingPlan,
      pausedReason: this.state.pausedReason || null,
      summary: plan?.summary || '',
      approach: plan?.approach || '',
      agents: (plan?.agents || []).map((a) => ({ ...a, ...(plan === this.plan ? this.#agentState(a.id) : { state: 'wait', now: '' }) })),
      tasks: plan === this.plan ? { done, total: tasks.length } : { done: 0, total: plan?.tasks?.length || 0 },
      planTasks: kind === 'plan' ? (this.state.pendingPlan?.tasks || this.plan?.tasks || []).map((t) => ({ id: t.id, title: t.title, agent: t.agent, deps: t.deps })) : undefined,
      checks: plan?.checks,
      estimate: plan?.estimate,
      costCny: Math.round(this.costCny * 100) / 100,
      budgetCny: this.budgetCny,
      question: q ? { qid: q.qid, text: q.text, options: q.options || [], from: q.from ? this.#agent(q.from).role : '' } : null,
      result: st === 'done' ? this.state.result || null : null,
      error: st === 'failed' ? this.state.error || '' : '',
      startedAt: this.state.startedAt || null,
      finishedAt: this.state.finishedAt || null,
    };
  }
  // 一个智能体现在怎么样：work 在干 / check 合并检查 / need 等宿主 / done 都做完了 / wait 等着
  #agentState(id) {
    const mine = this.#allTasks().filter((t) => t.agent === id);
    const by = (st) => mine.find((t) => this.#ts(t.id).status === st);
    const run = by('running');
    if (run) return { state: 'work', now: run.title, busy: true };
    const merging = by('merging');
    if (merging) return { state: 'check', now: merging.title };
    const failed = by('failed');
    if (failed) return { state: 'need', now: failed.title };
    if (mine.length && mine.every((t) => ['done', 'skipped'].includes(this.#ts(t.id).status))) return { state: 'done', now: this.#ts(mine.at(-1).id).report || mine.at(-1).title };
    const next = by('pending');
    const dep = next?.deps?.map((d) => this.#allTasks().find((x) => x.id === d)).find((d) => d && !['done', 'skipped'].includes(this.#ts(d.id).status));
    return { state: 'wait', now: dep ? `等「${dep.title}」` : next ? next.title : '' };
  }

  #card(now = false) {
    clearTimeout(this.cardTimer);
    if (now) return this.emit('card', this.card());
    this.cardTimer = setTimeout(() => this.emit('card', this.card()), 800);
  }

  // 项目页要的；events: false 只要状态（项目页已经有事件了，结构变了再要一次）
  snapshot({ events = true } = {}) {
    return { project: this.project, plan: this.plan, pendingPlan: this.state.pendingPlan || null, state: this.state, card: this.card(), request: this.store.readText(this.id, 'request.md'), events: events ? this.store.events(this.id) : undefined };
  }

  // 给大脑的一句话（project_list 用）
  brief() {
    const c = this.card();
    const label = { plan: '等宿主看计划', running: '进行中', paused: '暂停了', ask: '有问题等宿主回答', done: '做完了', stopped: '停下了', failed: '出错了', checking: '最后检查中', planning: '在写计划', cancelled: '取消了' }[c.kind] || c.kind;
    return `${c.name}（${label}，任务 ${c.tasks.done}/${c.tasks.total}，花了 ¥${c.costCny.toFixed(2)}，在 ${c.dir}）`;
  }

  // ---------- 模型 ----------
  async #model() {
    const want = this.pcfg.commanderModel;
    if (want && this.runtime?.()) {
      const [provider, ...rest] = String(want).split('/');
      const m = (await this.runtime().getAvailable()).find((x) => x.provider === provider && x.id === rest.join('/'));
      if (m) return m;
    }
    return this.model();
  }
  async #workerModel() {
    const want = this.pcfg.workerModel;
    if (want && this.runtime?.()) {
      const [provider, ...rest] = String(want).split('/');
      const m = (await this.runtime().getAvailable()).find((x) => x.provider === provider && x.id === rest.join('/'));
      if (m) return m;
    }
    return this.#model();
  }
  // 总指挥问一次模型（不进任何会话）
  async #llm(system, content, { maxTokens = 2500, reasoning = 'off' } = {}) {
    if (this.completeFn) {
      const r = await this.completeFn(system, content);
      if (r?.usd) this.#addCost(r.usd);
      return String(r?.text ?? r ?? '');
    }
    const rt = this.runtime();
    const model = await this.#model();
    if (!rt || !model) throw new Error('大脑还没准备好');
    const r = await rt.completeSimple(model, { systemPrompt: system, messages: [{ role: 'user', content, timestamp: Date.now() }] }, { reasoning, maxTokens, signal: AbortSignal.timeout(180_000) });
    if (r.usage?.cost?.total) this.#addCost(r.usage.cost.total);
    if (r.errorMessage) throw new Error(r.errorMessage);
    return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  async #llmJson(system, content, opts) {
    let text = await this.#llm(system, content, opts);
    let j = P.parseJson(text);
    if (!j) {
      text = await this.#llm(system, `${typeof content === 'string' ? content : ''}\n\n（上一次你的输出不是合法的 JSON。这次只输出 JSON。）`, opts);
      j = P.parseJson(text);
    }
    return j;
  }

  // ---------- 花费 ----------
  #addCost(usd) {
    if (!(usd > 0)) return;
    this.state.costUsd = (this.state.costUsd || 0) + usd;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#save(), 1000);
    const budget = this.budgetCny;
    if (budget > 0) {
      const ratio = this.costCny / budget;
      if (ratio >= 0.8 && !this.state.warned) {
        this.state.warned = true;
        this.#event({ type: 'budget', level: 'warn', costCny: this.costCny, budgetCny: budget });
        this.emit('note', `项目「${this.project?.name}」花费到了预算的八成：¥${this.costCny.toFixed(2)} / ¥${budget}`);
      }
      if (ratio >= 1 && !this.state.budgetAsked && this.state.status === 'running') this.#budgetOut();
      if (ratio >= 1.15 && this.state.status === 'running') this.pause('budget');
    }
    this.#card();
  }
  async #budgetOut() {
    this.state.budgetAsked = true;
    this.#event({ type: 'budget', level: 'out', costCny: this.costCny, budgetCny: this.budgetCny });
    const add = Number(this.pcfg.budget) || 30;
    const a = await this.#askHost({ text: `预算 ¥${this.budgetCny} 用完了（已经花了 ¥${this.costCny.toFixed(2)}）。再加 ¥${add} 接着做，还是先停下？`, options: [`再加 ¥${add}`, '先停下'], kind: 'budget' });
    this.#applyBudget(a);
  }
  #applyBudget(a) {
    if (/停|不/.test(a) && !/加/.test(a)) return this.pause('budget');
    const n = Number(String(a).match(/(\d+(?:\.\d+)?)/)?.[1]) || Number(this.pcfg.budget) || 30;
    this.state.budgetCny = this.budgetCny + n;
    this.state.budgetAsked = false;
    this.state.warned = false;
    this.#event({ type: 'budget', level: 'raised', budgetCny: this.state.budgetCny });
    this.#save();
    if (this.state.status === 'paused' && this.state.pausedReason === 'budget') this.resume();
    else this.#pump();
  }
  #overBudget() {
    return this.budgetCny > 0 && this.costCny >= this.budgetCny;
  }

  // ---------- 计划 ----------
  // 新项目：写计划，等宿主点开工
  async start() {
    this.#setStatus('planning');
    this.#card(true);
    try {
      const request = this.#request();
      const plan = normalizePlan(await this.#llmJson(P.PLAN_PROMPT, `宿主原话：${request}${this.state.answers ? `\n宿主补充：${this.state.answers}` : ''}`, { maxTokens: 6000, reasoning: 'low' }));
      this.plan = plan;
      this.store.writeJson(this.id, 'plan.json', plan);
      this.store.update(this.id, { summary: plan.summary });
      this.#event({ type: 'plan', plan });
      this.#setStatus('awaiting_approval');
    } catch (e) {
      this.state.error = `计划没写出来：${e.message}`;
      this.#event({ type: 'error', text: this.state.error });
      this.#setStatus('failed');
    }
    this.#save();
    this.#card(true);
  }
  #request() {
    const t = this.store.readText(this.id, 'request.md');
    return (t.split('## 宿主原话')[1] || t).replace(/^\s+/, '').split(/\n## /)[0].trim();
  }

  // 做完了的项目接着改：写一个小计划，宿主点开工再做
  async continueWith(text) {
    if (BUSY.has(this.state.status)) return this.message(text);
    this.state.round = (this.state.round || 1) + 1;
    this.store.appendRequest(this.id, `## 接着改（第 ${this.state.round - 1} 次）\n\n${text}\n`);
    this.state.lastRequest = text;
    this.#setStatus('planning');
    this.#card(true);
    try {
      const tree = (await G.fileTree(this.dir, 200)).join('\n');
      const old = { name: this.plan?.name, summary: this.plan?.summary, approach: this.plan?.approach, agents: this.plan?.agents, tasks: this.plan?.tasks?.map((t) => ({ id: t.id, agent: t.agent, title: t.title })), checks: this.plan?.checks };
      const raw = await this.#llmJson(P.REPLAN_PROMPT, `原来的计划：${JSON.stringify(old)}\n\n现在的文件：\n${tree}\n\n宿主原话（最开始）：${this.#request()}\n\n宿主这次要：${text}`, { maxTokens: 4000, reasoning: 'low' });
      const plan = normalizePlan(raw, { prefix: `r${this.state.round}-`, old: this.plan });
      this.state.pendingPlan = plan;
      this.#event({ type: 'plan', plan, continued: true });
      this.#setStatus('awaiting_approval');
    } catch (e) {
      this.state.error = `计划没写出来：${e.message}`;
      this.#event({ type: 'error', text: this.state.error });
      this.#setStatus('failed');
    }
    this.#save();
    this.#card(true);
    return null;
  }

  // 开工前换个文件夹
  setDir(dir) {
    if (this.state.startedAt) throw new Error('已经开工了，不能换文件夹');
    this.store.move(this.id, dir);
    this.#event({ type: 'dir', dir: this.dir });
    this.#card(true);
    return this.dir;
  }

  cancel() {
    if (this.state.status !== 'awaiting_approval') return false;
    if (this.state.pendingPlan) {
      this.state.pendingPlan = null;
      this.#setStatus('done');
    } else this.#setStatus('cancelled');
    this.#save();
    this.#card(true);
    return true;
  }

  // 宿主点了开工
  async approve() {
    if (this.state.status !== 'awaiting_approval') return false;
    try {
      const repo = await G.ensureRepo(this.dir);
      if (this.state.pendingPlan) {
        const np = this.state.pendingPlan;
        this.plan = { ...this.plan, agents: [...this.plan.agents, ...np.agents.filter((a) => !this.plan.agents.some((x) => x.id === a.id))], tasks: [...this.plan.tasks, ...np.tasks.map((t) => ({ ...t, round: this.state.round }))], checks: { ...this.plan.checks, ...Object.fromEntries(Object.entries(np.checks).filter(([, v]) => v !== '')) } };
        this.state.pendingPlan = null;
        this.state.roundBase = repo.head;
        this.state.finishedAt = null;
      } else {
        this.state.base = repo.head;
        this.state.roundBase = repo.head;
        this.state.startedAt = this.now();
      }
      this.state.main = repo.main;
      this.state.roundStartedAt = this.now();
      this.state.fixRounds = 0;
      this.state.reviewed = 0;
      this.state.lastFixFrom = null;
      this.state.result = null;
      this.store.writeJson(this.id, 'plan.json', this.plan);
      this.#event({ type: 'approved', base: repo.head, main: repo.main });
      this.#setStatus('running');
      this.#save();
      this.emit('say', `项目开工：${this.project.name}`);
      this.#card(true);
      this.#pump();
      return true;
    } catch (e) {
      this.state.error = `开不了工：${e.message}`;
      this.#event({ type: 'error', text: this.state.error });
      this.#setStatus('failed');
      this.#save();
      this.#card(true);
      return false;
    }
  }

  // ---------- 派活 ----------
  #pump() {
    if (this.state.status !== 'running') return;
    if (this.#overBudget()) {
      if (!this.state.budgetAsked) this.#budgetOut();
      return;
    }
    const tasks = this.#allTasks();
    const st = (id) => this.#ts(id).status;
    const running = tasks.filter((t) => st(t.id) === 'running');
    const busyAgents = new Set(running.map((t) => t.agent));
    const max = Number(this.pcfg.maxConcurrent) > 0 ? Number(this.pcfg.maxConcurrent) : Infinity;
    for (const t of tasks) {
      if (running.length >= max) break;
      if (st(t.id) !== 'pending' || busyAgents.has(t.agent)) continue;
      if (!(t.deps || []).every((d) => ['done', 'skipped'].includes(st(d)))) continue;
      busyAgents.add(t.agent);
      running.push(t);
      this.#runTask(t).catch((e) => this.#taskCrash(t, e));
    }
    const open = tasks.filter((t) => !['done', 'skipped'].includes(st(t.id)));
    if (!open.length && !this.merging && !this.mergeQueue.length) this.#finish().catch((e) => this.#fail(`最后检查出错：${e.message}`));
    this.#card();
  }

  #taskCrash(t, e) {
    this.log(`project ${this.id} task ${t.id} crashed`, e?.stack || e);
    this.#event({ type: 'error', task: t.id, agent: t.agent, text: clip(e?.message || e, 400) });
    this.#triage(t, `系统出错：${e?.message || e}`);
  }

  #fail(text) {
    this.state.error = text;
    this.#event({ type: 'error', text });
    this.#setStatus('failed');
    this.#save();
    this.#card(true);
  }

  async #makeWorker(t, wt) {
    const agent = this.#agent(t.agent);
    const want = this.pcfg.workerEngine;
    const engine = want === 'claude' || want === 'codex' ? want : 'pi';
    const system = P.workerSystem({ role: agent.role, engine });
    const common = {
      id: agent.id,
      role: agent.role,
      cwd: wt,
      system,
      maxTurns: Number(this.pcfg.maxTurns) || 80,
      ask: (q) => this.#workerAsk(t, q),
      confirm: (r) => this.#workerConfirm(t, r),
      log: this.log,
    };
    let w;
    if (this.workerFactory) w = await this.workerFactory({ ...common, engine, task: t, agent, dir: this.dir });
    else if (engine === 'pi') {
      const gate = this.pcfg.autoAllow === false ? (ev) => assessRisk(ev, wt) : (ev) => projectRisk(ev, { dir: this.dir, cwd: wt });
      w = new PiWorker({ ...common, sessionDir: path.join(this.store.hb(this.id), 'agents', agent.id), modelRuntime: this.runtime(), model: await this.#workerModel(), gate });
    } else {
      const left = this.budgetCny > 0 ? Math.max(0.5, (this.budgetCny - this.costCny) / this.usdToCny) : 0;
      w = new CliWorker({
        ...common,
        engine,
        projectDir: this.dir,
        confirmDir: path.join(this.store.hb(this.id), 'confirm', `${agent.id}-${t.id}`),
        settingsFile: path.join(this.store.hb(this.id), 'agents', agent.id, 'claude-settings.json'),
        // 钩子命令可能在 bash 里跑，也可能在 cmd 里跑：路径用正斜杠两边都认
        hook: `"${fwd(process.execPath)}" "${fwd(path.join(this.root, 'tools', 'project-hook.mjs'))}"`,
        budgetUsd: Math.round(left * 100) / 100,
      });
    }
    w.on('step', (s) => this.#event({ type: 'step', agent: t.agent, task: t.id, ...s }));
    w.on('cost', ({ usd }) => this.#addCost(usd));
    return { w, engine, system };
  }

  async #runTask(t) {
    const ts = this.#ts(t.id);
    const agent = this.#agent(t.agent);
    ts.status = 'running';
    ts.attempts = (ts.attempts || 0) + 1;
    ts.startedAt = this.now();
    this.#save();
    this.#card();
    if (!ts.wt || !fs.existsSync(ts.wt)) {
      const { wt, branch } = await G.addWorktree(this.dir, `${t.agent}-${t.id}`, t.id, 'HEAD');
      Object.assign(ts, { wt, branch });
      this.#save();
    }
    let entry = this.workers.get(t.id);
    const fresh = !entry;
    if (fresh) {
      entry = await this.#makeWorker(t, ts.wt);
      this.workers.set(t.id, entry);
    }
    const notes = this.state.agentNotes[t.agent]?.splice(0) || [];
    const review = t.kind === 'review';
    let prompt;
    if (review) prompt = await this.#reviewPrompt(entry.engine);
    else if (fresh)
      prompt = P.taskPrompt({ project: this.project, plan: this.#planWithReports(), task: t, request: this.#request() + (this.state.lastRequest && t.round > 1 ? `\n\n（这次接着改：${this.state.lastRequest}）` : ''), answers: this.state.answers, notes: [...(ts.notes || []), ...notes], retry: ts.retry || (ts.attempts > 1 ? '上次做到一半停下了（暂停或者系统重启），副本里是你上次改到的样子：先看看现在的状态，再接着做完。' : '') });
    else prompt = `## 上一次的问题，这次要改好\n${ts.retry || '接着做完这个任务。'}${notes.length ? `\n\n## 总指挥另外交代\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}\n\n改好以后照样自己检查，再汇报。`;
    ts.notes = [];
    ts.retry = null;
    this.#event({ type: 'dispatch', agent: t.agent, role: agent.role, task: t.id, title: t.title, attempt: ts.attempts, engine: entry.engine, prompt, system: fresh ? entry.system : undefined });
    const r = await entry.w.run(prompt);
    if (r.status === 'stopped' || this.state.status === 'stopped' || this.state.status === 'paused') {
      // 暂停 / 停下：任务回到「没做完」，副本留着，继续时接着做
      ts.status = 'pending';
      this.#save();
      this.#card();
      return;
    }
    if (r.report) this.#event({ type: 'report', agent: t.agent, task: t.id, status: r.report.status, summary: r.report.summary, files: r.report.files, issues: r.report.issues, noReport: r.report.noReport });
    if (r.status === 'reported') {
      ts.report = clip(r.report?.summary, 600);
      if (review) return this.#onReview(t, r.report);
      const changed = await G.commitAll(ts.wt, `${t.title}（${agent.role}）`);
      if (!changed && !(await G.changedFiles(this.dir, ts.branch, 'HEAD')).length) {
        this.#event({ type: 'commit', agent: t.agent, task: t.id, files: [], empty: true });
        return this.#taskDone(t);
      }
      const files = await G.changedFiles(this.dir, ts.branch, 'HEAD');
      this.#event({ type: 'commit', agent: t.agent, task: t.id, files });
      ts.status = 'merging';
      this.#save();
      this.mergeQueue.push(t.id);
      this.#drainMerges();
      this.#pump();
      return;
    }
    const why = {
      blocked: `${agent.role}说做不下去：${r.report?.summary || ''}`,
      stuck: `${agent.role}卡住了（同样的操作重复了好几次，结果一样）`,
      turns: `${agent.role}用完了 ${Number(this.pcfg.maxTurns) || 80} 轮还没做完`,
      error: `${agent.role}出错了：${r.error || ''}`,
    }[r.status] || `${agent.role}没做完（${r.status}）`;
    await this.#triage(t, why);
  }

  // 依赖任务做完的汇报也给后面的看
  #planWithReports() {
    return { ...this.plan, tasks: this.plan.tasks.map((x) => ({ ...x, report: this.#ts(x.id).report })) };
  }

  async #taskDone(t) {
    const ts = this.#ts(t.id);
    ts.status = 'done';
    ts.finishedAt = this.now();
    this.#event({ type: 'task_done', agent: t.agent, task: t.id, title: t.title });
    if (ts.wt) await G.removeWorktree(this.dir, ts.wt, ts.branch).catch((e) => this.log('removeWorktree', e.message));
    ts.wt = null;
    this.workers.get(t.id)?.w.dispose();
    this.workers.delete(t.id);
    this.#save();
    this.#card();
    this.#pump();
  }

  // 退回给原来那个智能体再改一次；改了好几次还不行就交给 triage
  async #sendBack(t, why) {
    const ts = this.#ts(t.id);
    this.#event({ type: 'retry', agent: t.agent, task: t.id, why: clip(why, 1500), attempt: ts.attempts });
    if (ts.attempts >= MAX_ATTEMPTS) return this.#triage(t, why, { forceAsk: true });
    ts.status = 'pending';
    ts.retry = why;
    this.#save();
    this.#pump();
  }

  // 任务出了问题：总指挥决定再试、跳过，还是问宿主
  async #triage(t, why, { forceAsk = false } = {}) {
    const ts = this.#ts(t.id);
    ts.status = 'failed';
    this.#save();
    this.#card();
    let j = null;
    if (!forceAsk && ts.attempts < MAX_ATTEMPTS) {
      try {
        j = await this.#llmJson(P.TRIAGE_PROMPT, `任务「${t.title}」（${this.#agent(t.agent).role}）：${t.desc}\n出的问题：${clip(why, 2000)}\n已经做了 ${ts.attempts} 次。`, { maxTokens: 600 });
      } catch {}
    }
    this.#event({ type: 'triage', agent: t.agent, task: t.id, why: clip(why, 1500), action: j?.action || 'ask', note: j?.note || j?.why || '' });
    if (j?.action === 'retry') return this.#sendBack(t, `${why}\n总指挥：${j.note || '照着问题改好'}`);
    if (j?.action === 'skip') return this.#skip(t, j.why);
    const options = Array.isArray(j?.options) && j.options.length ? [...j.options.slice(0, 3).map(String), '跳过这个任务'] : ['再试一次', '跳过这个任务', '停下项目'];
    const a = await this.#askHost({ text: j?.ask || `「${t.title}」做不下去了：${clip(why, 120)}。怎么办？`, options, kind: 'triage', task: t.id, from: t.agent });
    this.#applyTriage(t, a, why);
  }
  #applyTriage(t, a, why = '') {
    const ts = this.#ts(t.id);
    if (/跳过/.test(a)) return this.#skip(t, '宿主说跳过');
    if (/停下|停止|别做了/.test(a)) return this.stop();
    if (/接着合并/.test(a) && ts.status === 'failed' && ts.mergeError) {
      ts.mergeError = null;
      ts.status = 'merging';
      this.mergeQueue.push(t.id);
      this.#save();
      return this.#drainMerges();
    }
    ts.attempts = 0;
    ts.status = 'pending';
    ts.retry = `${why ? `${clip(why, 1500)}\n` : ''}宿主说：${a}`;
    this.#save();
    this.#pump();
  }
  async #skip(t, why) {
    const ts = this.#ts(t.id);
    ts.status = 'skipped';
    this.#event({ type: 'skip', agent: t.agent, task: t.id, why: clip(why, 300) });
    if (ts.wt) await G.removeWorktree(this.dir, ts.wt, ts.branch).catch(() => {});
    ts.wt = null;
    this.workers.get(t.id)?.w.dispose();
    this.workers.delete(t.id);
    this.#save();
    this.#pump();
  }

  // ---------- 合并（一次一个）----------
  async #drainMerges() {
    if (this.merging) return;
    this.merging = true;
    try {
      while (this.mergeQueue.length && this.state.status === 'running') {
        const id = this.mergeQueue.shift();
        const t = this.#allTasks().find((x) => x.id === id);
        if (t && this.#ts(id).status === 'merging') await this.#merge(t).catch((e) => this.#taskCrash(t, e));
      }
    } finally {
      this.merging = false;
    }
    this.#pump();
  }

  async #merge(t) {
    const ts = this.#ts(t.id);
    const agent = this.#agent(t.agent);
    const changed = await G.changedFiles(this.dir, ts.branch, 'HEAD');
    const m = await G.tryMerge(this.dir, ts.branch, `${t.title}（${agent.role}）`);
    this.#event({ type: 'merge', agent: t.agent, task: t.id, ok: m.ok, conflict: !!m.conflict, files: m.files || changed, output: m.ok ? '' : clip(m.output, 800) });
    if (!m.ok) {
      if (m.conflict) {
        // 把主线合进它的副本（冲突标记留在文件里），让它自己整理
        await G.git(ts.wt, ['merge', '--no-edit', this.state.main || 'main'], { allowFail: true });
        return this.#sendBack(t, `合并进主线时跟别人的改动冲突了，冲突的文件：${m.files.join('、')}。系统已经把主线合进你的副本，这些文件里有 <<<<<<< ======= >>>>>>> 冲突标记：两边的改动都保留，整理成能用的样子，再构建、测试一遍。`);
      }
      return this.#sendBack(t, `合并失败：${m.output}`);
    }
    const pkg = fs.existsSync(path.join(m.mw, 'package.json'));
    const install = pkg && (!fs.existsSync(path.join(m.mw, 'node_modules')) || changed.some((f) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f)));
    const res = await this.#runChecks(m.mw, 'merge', { install, task: t.id });
    if (this.state.status !== 'running') return void this.mergeQueue.unshift(t.id); // 检查到一半暂停了：继续时重来
    if (!res.ok) return this.#sendBack(t, `你的改动合进主线以后，${CHECK_NAMES[res.name] || res.name}没过（命令：${res.command}）。输出的最后一段：\n${clip(res.output, 2500)}\n照着改好（可能是跟别人的改动合在一起才出的问题），再自己构建、测试一遍。`);
    try {
      await G.advanceMain(this.dir, m.commit);
    } catch (e) {
      ts.status = 'failed';
      ts.mergeError = e.message;
      this.#save();
      this.#event({ type: 'error', task: t.id, text: e.message });
      const a = await this.#askHost({ text: `主线合不进去：${clip(e.message, 100)}。你在项目文件夹里改了东西的话，先提交或者撤掉，再点「接着合并」。`, options: ['我处理好了，接着合并', '停下项目'], kind: 'triage', task: t.id });
      return this.#applyTriage(t, a);
    }
    this.#event({ type: 'merged', agent: t.agent, task: t.id, commit: m.commit });
    await this.#taskDone(t);
  }

  // 装依赖、构建、测试（没写的跳过）：{ ok, name, command, output }
  async #runChecks(cwd, scope, { install = false, task } = {}) {
    const c = this.plan?.checks || {};
    const steps = [];
    if (install && c.install) steps.push(['install', c.install, 15 * 60_000]);
    if (c.build) steps.push(['build', c.build, 10 * 60_000]);
    if (c.test) steps.push(['test', c.test, 10 * 60_000]);
    for (const [name, command, timeoutMs] of steps) {
      this.#event({ type: 'check_start', scope, name, command, task });
      const r = await this.check.run(command, { cwd, timeoutMs, signal: this.ctl.signal });
      this.#event({ type: 'check', scope, name, command, task, ok: r.ok, ms: r.ms, output: clip(r.output, 1500), timedOut: r.timedOut });
      if (!r.ok) return { ok: false, name, command, output: r.output };
    }
    return { ok: true };
  }

  // ---------- 全做完：最后检查、评审、修、总结 ----------
  async #finish() {
    if (this.finishing || this.state.status !== 'running') return;
    this.finishing = true;
    try {
      this.#setStatus('checking');
      this.#card(true);
      const c = this.plan.checks || {};
      const issues = [];
      const res = await this.#runChecks(this.dir, 'final', { install: fs.existsSync(path.join(this.dir, 'package.json')) });
      if (this.state.status !== 'checking') return;
      if (!res.ok) issues.push(`最后在项目文件夹里${CHECK_NAMES[res.name] || res.name}没过（命令：${res.command}），输出的最后一段：${clip(res.output, 1500)}`);
      let shot = null;
      if (res.ok && c.start && c.url && c.web) {
        this.#event({ type: 'check_start', scope: 'final', name: 'start', command: c.start });
        const s = await this.check.start(c.start, c.url, { cwd: this.dir });
        this.#event({ type: 'check', scope: 'final', name: 'start', command: c.start, ok: s.ok, ms: s.ms, output: clip(s.output, 1500) });
        if (!s.ok) issues.push(`项目启动不起来（命令：${c.start}，网址：${c.url}）：${clip(s.output, 1200)}`);
        else {
          try {
            const file = path.join(this.store.hb(this.id), 'shots', `home-${this.now()}.png`);
            const sh = await this.check.shot(c.url, file, { root: this.root });
            if (sh.ok) {
              const v = await this.#judgeShot(file, c.url);
              shot = { file, ...v };
              this.#event({ type: 'check', scope: 'final', name: 'shot', ok: v.ok, file, output: v.note });
              if (!v.ok) issues.push(`网站首页看着不对：${v.note}`);
            } else this.#event({ type: 'check', scope: 'final', name: 'shot', ok: true, skipped: true, output: `截图没截成，跳过：${clip(sh.output, 300)}` });
          } finally {
            await s.stop();
          }
        }
      }
      if (this.state.status !== 'checking') return;
      this.state.lastShot = shot;
      if (issues.length) {
        if ((this.state.fixRounds || 0) < FIX_ROUNDS) return await this.#fix(issues, 'checks');
        const a = await this.#askHost({ text: `修了 ${FIX_ROUNDS} 轮，最后检查还是没过：${clip(issues[0], 100)}。再修一轮，还是就这样收工？`, options: ['再修一轮', '就这样收工'], kind: 'final' });
        if (/再修/.test(a)) {
          this.state.fixRounds = FIX_ROUNDS - 1;
          return await this.#fix(issues, 'checks');
        }
        this.state.finalIssues = issues;
        return await this.#complete();
      }
      // 检查都过了：评审（第一次，或者上一轮修的是评审提的问题）
      if (!this.state.reviewed || (this.state.lastFixFrom === 'review' && this.state.reviewed < FIX_ROUNDS)) return this.#startReview();
      await this.#complete();
    } finally {
      this.finishing = false;
    }
  }

  async #judgeShot(file, url) {
    try {
      const data = fs.readFileSync(file).toString('base64');
      const j = P.parseJson(await this.#llm(P.SHOT_PROMPT, [{ type: 'text', text: `网址：${url}。项目：${this.plan.summary}` }, { type: 'image', data, mimeType: 'image/png' }], { maxTokens: 300 }));
      return j && typeof j.ok === 'boolean' ? { ok: j.ok, note: clip(j.note, 200) } : { ok: true, note: '没看出结果，当作正常' };
    } catch (e) {
      return { ok: true, note: `看不了截图（${clip(e.message, 60)}），跳过` };
    }
  }

  #startReview() {
    this.state.reviewed = (this.state.reviewed || 0) + 1;
    if (!this.plan.agents.some((a) => a.id === 'review')) this.plan.agents.push({ id: 'review', role: '评审', does: '最后对照宿主原话检查' });
    const id = `review${this.state.round > 1 ? `-r${this.state.round}` : ''}-${this.state.reviewed}`;
    this.plan.tasks.push({ id, agent: 'review', kind: 'review', title: '评审', desc: '对照宿主原话检查做出来的东西', files: [], deps: [], done: '列出要改的问题' });
    this.store.writeJson(this.id, 'plan.json', this.plan);
    this.#event({ type: 'review_start', task: id });
    this.#setStatus('running');
    this.#save();
    this.#pump();
  }

  async #reviewPrompt(engine) {
    const diff = await G.diffText(this.dir, this.state.roundBase || this.state.base, 'HEAD', 50_000);
    const checks = this.store
      .events(this.id)
      .filter((e) => e.type === 'check' && e.scope === 'final')
      .slice(-5)
      .map((e) => `- ${CHECK_NAMES[e.name] || e.name}：${e.ok ? '过了' : '没过'}${e.output ? `（${clip(e.output, 200)}）` : ''}`)
      .join('\n');
    const p = P.reviewPrompt({ request: this.#request() + (this.state.lastRequest ? `\n\n（这次接着改：${this.state.lastRequest}）` : ''), answers: this.state.answers, plan: this.plan, diff: diff || '（没有改动）', checks: checks || '（没有检查命令）' });
    return engine === 'pi' ? p : `${p}\n（汇报格式：最后一条消息写「REPORT: 结论」，每个要改的问题单独一行，以「ISSUE: 」开头。）`;
  }

  async #onReview(t, report) {
    let issues = Array.isArray(report?.issues) ? report.issues.map(String).filter((s) => s.trim()) : [];
    if (!issues.length) issues = [...String(report?.summary || '').matchAll(/(?:^|\n)\s*ISSUE:\s*(.+)/gi)].map((m) => m[1].trim());
    this.#event({ type: 'review', task: t.id, issues, summary: report?.summary || '' });
    const ts = this.#ts(t.id);
    ts.status = 'done';
    ts.finishedAt = this.now();
    if (ts.wt) await G.removeWorktree(this.dir, ts.wt, ts.branch).catch(() => {});
    ts.wt = null;
    this.workers.get(t.id)?.w.dispose();
    this.workers.delete(t.id);
    this.#save();
    if (issues.length && (this.state.fixRounds || 0) < FIX_ROUNDS) return this.#fix(issues, 'review');
    if (issues.length) this.state.finalIssues = issues;
    // 评审没问题（或者修够了）：收工（不再跑一遍最后检查——评审前刚跑过，主线没变）
    await this.#complete();
  }

  // 把问题分给原来负责的智能体，再派一轮
  async #fix(issues, from) {
    this.state.fixRounds = (this.state.fixRounds || 0) + 1;
    this.state.lastFixFrom = from;
    const n = this.state.fixRounds;
    let tasks = [];
    try {
      const j = await this.#llmJson(P.FIX_PROMPT, `计划：${JSON.stringify({ agents: this.plan.agents.filter((a) => a.id !== 'review'), tasks: this.plan.tasks.filter((t) => t.kind !== 'review').map((t) => ({ agent: t.agent, title: t.title, files: t.files })) })}\n\n要改的问题：\n${issues.map((s) => `- ${s}`).join('\n')}`, { maxTokens: 2000 });
      tasks = Array.isArray(j?.tasks) ? j.tasks : [];
    } catch {}
    const workers = this.plan.agents.filter((a) => a.id !== 'review');
    if (!tasks.length) tasks = [{ agent: workers[0].id, title: '修问题', desc: issues.join('\n'), files: [] }];
    const prefix = `fix${this.state.round > 1 ? `-r${this.state.round}` : ''}-${n}-`;
    const added = tasks.slice(0, 8).map((x, i) => ({
      id: `${prefix}${i + 1}`,
      agent: workers.find((a) => a.id === x.agent)?.id || workers[i % workers.length].id,
      kind: 'fix',
      title: clip(x.title || '修问题', 16),
      desc: `${String(x.desc || '').slice(0, 2000)}\n\n（这是${from === 'review' ? '评审' : '最后检查'}发现的问题。全部问题：\n${issues.map((s) => `- ${clip(s, 300)}`).join('\n')}）`,
      files: Array.isArray(x.files) ? x.files.map(String) : [],
      deps: [],
      done: '问题改好了，构建、测试都过',
    }));
    this.plan.tasks.push(...added);
    this.store.writeJson(this.id, 'plan.json', this.plan);
    this.#event({ type: 'fix', from, round: n, issues, tasks: added.map((t) => ({ id: t.id, agent: t.agent, title: t.title })) });
    this.#setStatus('running');
    this.#save();
    this.#pump();
  }

  async #complete() {
    let result = { did: '', run: '', notes: '' };
    try {
      const stat = await G.diffStat(this.dir, this.state.roundBase || this.state.base, 'HEAD');
      const reports = this.plan.tasks.map((t) => `- ${t.title}（${this.#agent(t.agent).role}，${this.#ts(t.id).status}）：${this.#ts(t.id).report || ''}`).join('\n');
      const j = await this.#llmJson(P.SUMMARY_PROMPT, `宿主原话：${this.#request()}\n${this.state.lastRequest ? `这次接着改：${this.state.lastRequest}\n` : ''}计划：${this.plan.summary}\n检查命令：${JSON.stringify(this.plan.checks)}\n改动：${stat}\n各任务的汇报：\n${reports}${this.state.finalIssues?.length ? `\n没解决的问题：\n${this.state.finalIssues.map((s) => `- ${clip(s, 200)}`).join('\n')}` : ''}`, { maxTokens: 800 });
      if (j) result = { did: clip(j.did, 200), run: clip(j.run, 200), notes: clip(j.notes, 300) };
    } catch (e) {
      result.did = '做完了（总结没写出来）';
    }
    result.url = this.plan.checks?.web ? this.plan.checks.url : '';
    result.start = this.plan.checks?.start || '';
    result.shot = this.state.lastShot?.file || null;
    result.issues = this.state.finalIssues || [];
    const fin = this.store.events(this.id).filter((e) => e.type === 'check' && e.scope === 'final' && e.at >= (this.state.roundStartedAt || 0));
    const last = (n) => fin.filter((e) => e.name === n).at(-1);
    result.checks = ['install', 'build', 'test', 'start', 'shot']
      .map((n) => ({ name: CHECK_NAMES[n], ok: last(n)?.ok, skipped: !!last(n)?.skipped }))
      .filter((c) => c.ok !== undefined && !c.skipped);
    const review = this.store.events(this.id).filter((e) => e.type === 'review').at(-1);
    if (review) result.checks.push({ name: '评审', ok: !(this.state.finalIssues || []).length });
    result.stat = await G.diffStat(this.dir, this.state.base, 'HEAD').catch(() => '');
    this.state.result = result;
    this.state.finishedAt = this.now();
    this.state.finalIssues = null;
    this.#event({ type: 'done', result });
    this.#setStatus('done');
    this.store.update(this.id, { summary: result.did || this.plan.summary });
    this.#save();
    this.emit('say', `项目完成：${this.project.name}`);
    this.emit('note', `项目「${this.project.name}」做完了：${result.did}${result.run ? `。运行：${result.run}` : ''}`);
    this.#card(true);
  }

  // ---------- 提问、授权 ----------
  // 干活的问总指挥
  async #workerAsk(t, { question, options = [] }) {
    const qid = `w${this.now().toString(36)}${++this.seq}`;
    this.#event({ type: 'question', agent: t.agent, task: t.id, qid, text: clip(question, 1500), options });
    let j = null;
    try {
      j = await this.#llmJson(P.ANSWER_PROMPT, `宿主原话：${this.#request()}\n${this.state.answers ? `宿主补充过：${this.state.answers}\n` : ''}计划：${JSON.stringify({ summary: this.plan.summary, approach: this.plan.approach, tasks: this.plan.tasks.map((x) => ({ id: x.id, agent: x.agent, title: x.title, files: x.files })) })}\n\n${this.#agent(t.agent).role}（在做「${t.title}」）问：${question}${options.length ? `\n它给的选项：${options.join(' / ')}` : ''}`, { maxTokens: 1000 });
    } catch {}
    if (j?.answer) {
      this.#event({ type: 'answer', agent: t.agent, task: t.id, qid, by: 'commander', text: clip(j.answer, 1500) });
      return String(j.answer);
    }
    const a = await this.#askHost({ text: clip(j?.ask || question, 300), options: (Array.isArray(j?.options) && j.options.length ? j.options : options).slice(0, 4).map(String), kind: 'question', task: t.id, from: t.agent });
    this.#event({ type: 'answer', agent: t.agent, task: t.id, qid, by: 'host', text: clip(a, 1500) });
    return `宿主回答：${a}`;
  }

  // 问宿主：主聊天里出一张卡（也念出来），等宿主回答
  #askHost({ text, options = [], kind, task, from }) {
    const qid = `q${this.now().toString(36)}${++this.seq}`;
    this.state.questions.push({ qid, text, options, kind, task, from, status: 'open', at: this.now() });
    this.#save();
    this.#event({ type: 'ask_host', qid, text, options, kind, task, agent: from });
    this.emit('ask', { projectId: this.id, qid, text, options, kind, from: from ? this.#agent(from).role : '' });
    this.emit('say', `项目「${this.project?.name}」有个问题：${text}`);
    this.#card(true);
    return new Promise((resolve) => this.waiters.set(qid, resolve));
  }

  get openQuestion() {
    return this.state.questions.find((q) => q.status === 'open') || null;
  }

  // 宿主回答了（qid 不给就是最早那个没回答的）
  answer(qid, text) {
    const q = qid ? this.state.questions.find((x) => x.qid === qid && x.status === 'open') : this.openQuestion;
    if (!q) return false;
    q.status = 'answered';
    q.answer = String(text);
    if (q.kind === 'question') {
      this.state.answers = `${this.state.answers ? `${this.state.answers}\n` : ''}问：${q.text} 答：${text}`;
      this.store.appendRequest(this.id, `## 宿主补充\n\n- 问：${q.text}\n  答：${text}`);
    }
    this.#save();
    this.#event({ type: 'host_answer', qid: q.qid, text: q.answer, kind: q.kind });
    const fn = this.waiters.get(q.qid);
    this.waiters.delete(q.qid);
    if (fn) fn(q.answer);
    else this.#lateAnswer(q); // 重启前问的：没人在等了，按问题的种类办
    this.#card(true);
    return true;
  }
  #lateAnswer(q) {
    const t = this.#allTasks().find((x) => x.id === q.task);
    if (q.kind === 'budget') return this.#applyBudget(q.answer);
    if (q.kind === 'triage' && t) return this.#applyTriage(t, q.answer);
    if (q.kind === 'question' && t) {
      const ts = this.#ts(t.id);
      ts.notes = [...(ts.notes || []), `你上次问「${q.text}」，宿主回答：${q.answer}`];
      if (ts.status === 'failed') ts.status = 'pending';
      this.#save();
      return this.#pump();
    }
    if (q.kind === 'final') return /再修/.test(q.answer) ? this.#fix([q.text], 'checks') : this.#complete();
  }

  async #workerConfirm(t, risk) {
    if (this.state.allowAll) return true;
    const cid = `c${this.now().toString(36)}${++this.seq}`;
    const role = this.#agent(t.agent).role;
    this.#event({ type: 'confirm', cid, agent: t.agent, task: t.id, label: risk.label, detail: clip(risk.detail, 600) });
    this.emit('confirm', { projectId: this.id, cid, label: risk.label, detail: clip(risk.detail, 600), agent: role, project: this.project?.name });
    const answer = await new Promise((resolve) => this.confirms.set(cid, resolve));
    this.confirms.delete(cid);
    if (answer === 'all') this.state.allowAll = true;
    this.#event({ type: 'confirm_done', cid, answer });
    this.emit('confirm_closed', { projectId: this.id, cid, answer });
    return answer === 'allow' || answer === 'all';
  }
  confirmAnswer(cid, answer) {
    const fn = cid ? this.confirms.get(cid) : [...this.confirms.values()].at(-1);
    if (!fn) return false;
    fn(answer);
    return true;
  }
  get confirmPending() {
    return this.confirms.size > 0;
  }

  // ---------- 宿主跟总指挥说话 ----------
  async message(text) {
    this.#event({ type: 'host_msg', text: clip(text, 2000) });
    if (['done', 'stopped', 'cancelled', 'failed'].includes(this.state.status) && this.plan && this.state.startedAt) {
      await this.continueWith(text);
      return '收到，写好修改计划了，看一下没问题就点开工。';
    }
    if (this.state.status === 'awaiting_approval' || (this.state.status === 'failed' && !this.state.startedAt)) {
      // 还没开工：把这句并进要求，重写计划
      this.state.answers = `${this.state.answers ? `${this.state.answers}
` : ''}宿主说：${text}`;
      this.store.appendRequest(this.id, `## 宿主补充

- ${text}`);
      if (this.state.pendingPlan) {
        this.state.pendingPlan = null;
        await this.continueWith(`${this.state.lastRequest || ''}；${text}`);
      } else await this.start();
      return '计划按你说的改好了，再看一下。';
    }
    this.state.answers = `${this.state.answers ? `${this.state.answers}\n` : ''}宿主说：${text}`;
    this.store.appendRequest(this.id, `## 宿主补充\n\n- ${text}`);
    const running = this.#allTasks().filter((t) => this.#ts(t.id).status === 'running');
    let j = null;
    try {
      j = await this.#llmJson(P.MESSAGE_PROMPT, `项目：${this.plan?.summary}\n智能体：${JSON.stringify(this.plan?.agents || [])}\n任务：\n${this.#allTasks().map((t) => `- ${t.id} ${t.title}（${this.#agent(t.agent).role}，${this.#ts(t.id).status}）`).join('\n')}\n花费：¥${this.costCny.toFixed(2)} / ¥${this.budgetCny}\n\n宿主说：${text}`, { maxTokens: 1200 });
    } catch (e) {
      j = { reply: `收到（总指挥没想明白：${clip(e.message, 40)}），已经记下，后面派活时带上。` };
      for (const a of this.plan?.agents || []) (this.state.agentNotes[a.id] ||= []).push(`宿主说：${text}`);
    }
    for (const f of Array.isArray(j?.forward) ? j.forward : []) {
      const msg = `（总指挥转来宿主的话）${f.message}`;
      const t = running.find((x) => x.agent === f.agent);
      const ok = t ? await this.workers.get(t.id)?.w.steer(msg) : false;
      if (!ok) (this.state.agentNotes[f.agent] ||= []).push(`宿主说：${f.message}`);
      this.#event({ type: 'forward', agent: f.agent, task: t?.id, text: clip(f.message, 1000), live: !!ok });
    }
    const added = [];
    for (const [i, x] of (Array.isArray(j?.tasks) ? j.tasks : []).slice(0, 6).entries()) {
      const agent = this.plan.agents.find((a) => a.id === x.agent && a.id !== 'review')?.id || this.plan.agents[0].id;
      const t = { id: `m${this.now().toString(36)}${i}`, agent, kind: 'extra', title: clip(x.title || '宿主加的', 16), desc: String(x.desc || text).slice(0, 2000), files: Array.isArray(x.files) ? x.files.map(String) : [], deps: [], done: '' };
      this.plan.tasks.push(t);
      added.push(t);
    }
    if (added.length) {
      this.store.writeJson(this.id, 'plan.json', this.plan);
      this.#event({ type: 'tasks_added', tasks: added.map((t) => ({ id: t.id, agent: t.agent, title: t.title })) });
      if (this.state.status === 'checking') this.#setStatus('running');
    }
    const reply = clip(j?.reply || '收到。', 300);
    this.#event({ type: 'commander_reply', text: reply });
    this.#save();
    this.#pump();
    this.#card(true);
    return reply;
  }

  // ---------- 暂停、继续、停下 ----------
  pause(reason = 'host') {
    if (!BUSY.has(this.state.status)) return false;
    this.#setStatus('paused', reason);
    this.ctl.abort();
    this.ctl = new AbortController();
    for (const { w } of this.workers.values()) w.stop('stopped');
    this.#save();
    this.#card(true);
    return true;
  }
  resume() {
    if (this.state.status !== 'paused') return false;
    if (this.state.pausedReason === 'budget' && this.#overBudget()) this.state.budgetAsked = false; // 再问一次加不加预算
    this.#setStatus('running');
    for (const t of this.#allTasks()) {
      const ts = this.#ts(t.id);
      if (ts.status === 'merging' && !this.mergeQueue.includes(t.id)) this.mergeQueue.push(t.id);
    }
    this.#save();
    this.#card(true);
    this.#drainMerges();
    this.#pump();
    return true;
  }
  stop() {
    if (['done', 'stopped', 'cancelled'].includes(this.state.status)) return false;
    this.#setStatus('stopped');
    this.ctl.abort();
    for (const { w } of this.workers.values()) w.stop('stopped');
    for (const q of this.state.questions) if (q.status === 'open') q.status = 'dropped';
    for (const fn of this.waiters.values()) fn('停下项目');
    this.waiters.clear();
    for (const fn of this.confirms.values()) fn('deny');
    this.#save();
    this.#card(true);
    return true;
  }

  // ---------- 打开网站（宿主点了按钮才跑） ----------
  async openSite() {
    const c = this.plan?.checks || {};
    if (!c.start || !c.url) return { ok: false, error: '这个项目没有网址' };
    if (this.site) return { ok: true, url: c.url };
    const s = await this.check.start(c.start, c.url, { cwd: this.dir, timeoutMs: 120_000 });
    if (!s.ok) return { ok: false, error: clip(s.output, 300) };
    this.site = s;
    this.#event({ type: 'site', running: true, url: c.url });
    return { ok: true, url: c.url };
  }
  async closeSite() {
    if (!this.site) return false;
    await this.site.stop();
    this.site = null;
    this.#event({ type: 'site', running: false });
    return true;
  }

  dispose() {
    clearTimeout(this.cardTimer);
    clearTimeout(this.saveTimer);
    if (BUSY.has(this.state.status)) this.pause('restart');
    for (const { w } of this.workers.values()) w.dispose();
    this.closeSite().catch(() => {});
    this.#save();
  }
}
