// 项目模式的存盘：每个项目一个文件夹（宿主的代码，一个 git 仓库），里面 .hostbound\ 是项目模式自己的记录：
//   request.md   宿主原话、问答        plan.json   计划（目标、智能体、任务、怎么检查）
//   state.json   状态、花费、任务进度    events.jsonl 所有事（分派、每一步、提问、回答、合并、检查、花费），项目页就读它
//   agents\名字\  这个智能体的会话存盘    worktrees\   干活的那份代码副本（git worktree）
// 所有项目的目录在 data\projects.json。设计稿 design/projects.html
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const folderName = (name) => String(name || '新项目').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^\.+/, '').trim().slice(0, 40) || '新项目';

export class ProjectStore extends EventEmitter {
  // dataDir：data 目录（放 projects.json）；root()：默认放项目的文件夹
  constructor({ dataDir, root, now = () => Date.now() }) {
    super();
    Object.assign(this, { dataDir, root, now });
    this.indexFile = path.join(dataDir, 'projects.json');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // ---- 目录 ----
  list() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')).projects || [];
    } catch {
      return [];
    }
  }
  #saveIndex(list) {
    fs.writeFileSync(this.indexFile, JSON.stringify({ projects: list }, null, 1));
  }
  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }
  // 按名字找（「接着改记账网站」）：完全一样的优先，再找包含的
  find(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    const list = this.list();
    return list.find((p) => p.id === n || p.name.toLowerCase() === n) || list.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase())) || null;
  }
  // 新项目：名字 → 文件夹（重名就加 2、3…）
  create({ name, request, dir }) {
    const now = this.now();
    const id = `p${now.toString(36)}`;
    const base = dir || path.join(this.root(), folderName(name));
    let target = base;
    for (let i = 2; fs.existsSync(target) && fs.readdirSync(target).length; i++) target = `${base}-${i}`;
    const p = { id, name: clip(name, 40) || '新项目', dir: target, status: 'planning', createdAt: now, updatedAt: now, summary: '' };
    this.#saveIndex([p, ...this.list()]);
    fs.mkdirSync(this.hb(p), { recursive: true });
    fs.writeFileSync(path.join(this.hb(p), 'request.md'), `# ${p.name}\n\n## 宿主原话\n\n${request}\n`);
    this.append(id, { type: 'created', name: p.name, dir: target, request });
    return p;
  }
  update(id, patch) {
    const list = this.list();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch, updatedAt: this.now() };
    this.#saveIndex(list);
    this.emit('changed', list[i]);
    return list[i];
  }
  // 换文件夹（只在开工前）：把 .hostbound 搬过去
  move(id, dir) {
    const p = this.get(id);
    if (!p) throw new Error('没有这个项目');
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n !== '.hostbound')) {
      // 选的是一个已有内容的文件夹：项目放进它下面的同名子文件夹
      dir = path.join(dir, folderName(p.name));
    }
    fs.mkdirSync(dir, { recursive: true });
    const from = this.hb(p);
    const to = path.join(dir, '.hostbound');
    if (path.resolve(from) !== path.resolve(to)) {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      try {
        if (!fs.readdirSync(p.dir).length) fs.rmdirSync(p.dir);
      } catch {}
    }
    return this.update(id, { dir });
  }
  remove(id) {
    this.#saveIndex(this.list().filter((p) => p.id !== id));
  }

  // ---- 项目里的文件 ----
  hb(p) {
    const proj = typeof p === 'string' ? this.get(p) : p;
    return path.join(proj.dir, '.hostbound');
  }
  file(id, name) {
    return path.join(this.hb(id), name);
  }
  readJson(id, name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.file(id, name), 'utf8'));
    } catch {
      return fallback;
    }
  }
  writeJson(id, name, data) {
    const f = this.file(id, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
  }
  readText(id, name) {
    try {
      return fs.readFileSync(this.file(id, name), 'utf8');
    } catch {
      return '';
    }
  }
  writeText(id, name, text) {
    const f = this.file(id, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  appendRequest(id, text) {
    fs.appendFileSync(this.file(id, 'request.md'), `\n${text}\n`);
  }

  // ---- 事件：追加写，项目页按它显示 ----
  append(id, ev) {
    const e = { at: this.now(), ...ev };
    try {
      fs.appendFileSync(this.file(id, 'events.jsonl'), JSON.stringify(e) + '\n');
    } catch {}
    this.emit('event', { projectId: id, ev: e });
    return e;
  }
  events(id, { after = 0, limit = 5000 } = {}) {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file(id, 'events.jsonl'), 'utf8');
    } catch {}
    const out = [];
    for (const l of raw.split('\n')) {
      if (!l) continue;
      try {
        const e = JSON.parse(l);
        if (e.at > after) out.push(e);
      } catch {}
    }
    return out.slice(-limit);
  }
}
