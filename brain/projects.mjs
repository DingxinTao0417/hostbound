// 项目模式的总管：所有项目（ProjectStore，目录在 data\projects.json）和每个项目的总指挥（project-commander.mjs）。
// 给主窗口的大脑几个工具（开项目、接着改、转话、回答、暂停继续……），把总指挥的卡片、提问、授权、要念的话交给大脑入口。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { ProjectStore } from './project-store.mjs';
import { Commander } from './project-commander.mjs';
import { projectsDir } from './config.mjs';

const FINISHED = new Set(['done', 'cancelled', 'stopped', 'failed']);
const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });

export class Projects extends EventEmitter {
  // cfg()：当前配置；runtime() / model()：大脑的模型运行时和模型；root：Hostbound 的目录
  // commanderOpts：测试时换掉总指挥的模型、干活的、检查（见 Commander）
  constructor({ dataDir, cfg, runtime, model, root, log = () => {}, commanderOpts = {} }) {
    super();
    Object.assign(this, { cfg, runtime, model, root, log, commanderOpts });
    this.store = new ProjectStore({ dataDir, root: () => projectsDir(cfg()) });
    this.store.on('event', (e) => this.emit('event', e));
    this.cs = new Map();
  }

  // 启动时：没做完的项目接上总指挥（正在干的会停在「暂停」，等宿主点继续）
  init() {
    for (const p of this.store.list()) {
      if (FINISHED.has(p.status)) continue;
      try {
        this.get(p.id);
      } catch (e) {
        this.log('project load failed', p.id, e.message);
      }
    }
  }

  get(id) {
    if (!id) return null;
    if (this.cs.has(id)) return this.cs.get(id);
    const p = this.store.get(id);
    if (!p || !fs.existsSync(path.join(p.dir, '.hostbound'))) return null;
    const c = new Commander({ store: this.store, id, cfg: this.cfg, runtime: this.runtime, model: this.model, root: this.root, log: this.log, ...this.commanderOpts });
    for (const ev of ['card', 'ask', 'confirm', 'confirm_closed', 'say', 'note']) c.on(ev, (x) => this.emit(ev, x, c));
    this.cs.set(id, c);
    return c;
  }

  // 按名字或 id 找；不给就找最需要宿主的那个（有问题等回答 > 等看计划 > 最近的）
  resolve(name) {
    if (name) {
      const p = this.store.find(name);
      return p ? this.get(p.id) : null;
    }
    return this.openQuestion()?.c || this.pendingPlan() || this.get(this.store.list()[0]?.id);
  }

  pendingPlan() {
    for (const p of this.store.list()) if (p.status === 'awaiting_approval') return this.get(p.id);
    return null;
  }
  openQuestion() {
    for (const p of this.store.list()) {
      const c = this.cs.get(p.id);
      const q = c?.openQuestion;
      if (q) return { c, q };
    }
    return null;
  }
  get confirmPending() {
    return [...this.cs.values()].some((c) => c.confirmPending);
  }
  // 授权卡上的回答（id 是 p:项目:授权）；不给 id 就是最近那个
  answerConfirm(id, answer) {
    if (id) {
      const [, pid, cid] = String(id).split(':');
      return this.cs.get(pid)?.confirmAnswer(cid, answer) || false;
    }
    for (const c of this.cs.values()) if (c.confirmPending) return c.confirmAnswer(null, answer);
    return false;
  }

  // 新项目：建文件夹、总指挥开始写计划（不等写完）
  create({ name, request, dir }) {
    if (dir && !path.isAbsolute(dir)) throw new Error(`文件夹要写完整路径：${dir}`);
    const p = this.store.create({ name, request, dir: dir || undefined });
    const c = this.get(p.id);
    c.start().catch((e) => this.log('project plan failed', e));
    return c;
  }

  list() {
    return this.store.list().map((p) => {
      const c = FINISHED.has(p.status) ? null : this.get(p.id);
      return { ...p, card: c ? c.card() : this.#cardFromDisk(p) };
    });
  }
  // 做完的项目不常驻：卡片从存盘里拼
  #cardFromDisk(p) {
    try {
      return this.get(p.id)?.card() || null;
    } catch {
      return null;
    }
  }
  // 对话里要显示的项目卡（按建项目的时间插在对话里）
  cardsBetween(after, before) {
    return this.store
      .list()
      .filter((p) => p.createdAt > after && p.createdAt < before)
      .map((p) => ({ at: p.createdAt, card: this.get(p.id)?.card() }))
      .filter((x) => x.card);
  }

  dispose() {
    for (const c of this.cs.values()) c.dispose();
  }

  // ---------- 给主窗口大脑的工具 ----------
  tools() {
    const self = this;
    const need = (name) => {
      const c = self.resolve(name);
      if (!c) throw new Error(name ? `没有叫「${name}」的项目。先用 project_list 看看有哪些。` : '现在没有项目。');
      return c;
    };
    return [
      {
        name: 'project_start',
        label: '开项目',
        description: '宿主要做一个软件 / 网站 / 小游戏 / 小工具（要写很多代码的东西）时，交给项目模式：总指挥写计划，宿主在面板上点「开工」以后几个智能体一起做。request 写宿主的原话加上问清楚的要点（不要改写成你的理解）；name 是 10 个字以内的项目名；宿主指定了放哪个文件夹才填 dir（完整路径）。马上返回，计划写好会以卡片出现在面板上。',
        parameters: Type.Object({ name: Type.String(), request: Type.String(), dir: Type.Optional(Type.String()) }),
        async execute(_id, p) {
          const c = self.create({ name: clip(p.name, 20), request: p.request, dir: p.dir });
          return ok(`已交给总指挥写计划：项目「${c.project.name}」，放在 ${c.dir}。计划写好会以卡片出现在面板上，宿主看过点「开工」才开始。跟宿主说一句就行，别把计划内容编出来。`, { projectId: c.id });
        },
      },
      {
        name: 'project_list',
        label: '看项目',
        description: '看有哪些项目、各自进行到哪、花了多少钱。宿主问「项目怎么样了」「做到哪了」时用。',
        parameters: Type.Object({}),
        async execute() {
          const list = self.store.list().slice(0, 12);
          if (!list.length) return ok('还没有项目。');
          return ok(list.map((p) => `- ${self.get(p.id)?.brief() || `${p.name}（${p.status}）`}`).join('\n'));
        },
      },
      {
        name: 'project_continue',
        label: '接着改项目',
        description: '做完（或者停下）的项目，宿主要接着改：「接着改记账网站，加个预算提醒」。总指挥写一个小计划给宿主看，宿主点开工再做。project 是项目名。',
        parameters: Type.Object({ project: Type.String(), request: Type.String() }),
        async execute(_id, p) {
          const c = need(p.project);
          c.continueWith(p.request).catch((e) => self.log('project continue failed', e));
          return ok(`总指挥在写「${c.project.name}」的修改计划，写好会以卡片出现在面板上。`);
        },
      },
      {
        name: 'project_message',
        label: '转给总指挥',
        description: '宿主对某个项目说的话（「前端那个按钮大一点」「计划里不要导出 Excel 了」「进度怎么样」），原话转给那个项目的总指挥，它会回一句。project 不给就是最近的项目。',
        parameters: Type.Object({ project: Type.Optional(Type.String()), text: Type.String() }),
        async execute(_id, p) {
          const c = need(p.project);
          const reply = await c.message(p.text);
          return ok(`总指挥（${c.project.name}）回：${reply}`);
        },
      },
      {
        name: 'project_answer',
        label: '回答项目的问题',
        description: '项目的总指挥在问宿主一个问题（面板上有「项目 · 等你回答」的卡），宿主回答了：用这个把宿主的原话转过去。project 不给就是在等回答的那个。',
        parameters: Type.Object({ project: Type.Optional(Type.String()), answer: Type.String() }),
        async execute(_id, p) {
          const hit = p.project ? { c: need(p.project) } : self.openQuestion();
          if (!hit?.c?.openQuestion) return ok('现在没有项目在等宿主回答。宿主的话要是对项目说的，用 project_message。');
          const q = hit.c.openQuestion;
          hit.c.answer(q.qid, p.answer);
          return ok(`已转给「${hit.c.project.name}」的总指挥（问的是：${clip(q.text, 60)}）。`);
        },
      },
      {
        name: 'project_control',
        label: '管项目',
        description: 'approve：宿主看过计划说「开工」「就这么做」；pause 暂停；resume 继续；stop 停下不做了；open 打开项目页（大窗口，能看每个智能体在干什么）；set_dir 开工前换文件夹（dir 写完整路径）。project 不给就是最近的项目。',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('approve'), Type.Literal('pause'), Type.Literal('resume'), Type.Literal('stop'), Type.Literal('open'), Type.Literal('set_dir')]),
          project: Type.Optional(Type.String()),
          dir: Type.Optional(Type.String()),
        }),
        async execute(_id, p) {
          const c = p.action === 'approve' && !p.project ? self.pendingPlan() || need() : need(p.project);
          const name = c.project.name;
          switch (p.action) {
            case 'approve':
              if (c.state.status !== 'awaiting_approval') return ok(`「${name}」现在不是在等开工（${c.brief()}）。`);
              c.approve().catch((e) => self.log('approve failed', e));
              return ok(`「${name}」开工了。`);
            case 'pause':
              return ok(c.pause() ? `「${name}」暂停了。` : `「${name}」没在进行，不用暂停。`);
            case 'resume':
              return ok(c.resume() ? `「${name}」接着做了。` : `「${name}」没在暂停。`);
            case 'stop':
              return ok(c.stop() ? `「${name}」停下了（做到一半的东西留着，以后可以接着改）。` : `「${name}」已经结束了。`);
            case 'open':
              self.emit('open', c.id);
              return ok(`打开了「${name}」的项目页。`);
            case 'set_dir':
              if (!p.dir || !path.isAbsolute(p.dir)) return ok('文件夹要写完整路径，比如 D:\\workspace。');
              return ok(`「${name}」改放在 ${c.setDir(p.dir)}。`);
          }
          return ok('不认识的操作。');
        },
      },
    ];
  }
}

export { describeProjectTool } from './project-describe.mjs';
