// 画图讲解（讲解窗口）。大脑用 explain 工具交一个主题和要点，这里另开一次模型调用，让模型按「积木」一块块写
// （结论 → 主图 → 分步 → 比方 → 需要时加表格 / 时间线 / 数据图 / 模拟），写好一块就交给讲解窗口画一块：
// - 画不出来的图把报错发回模型改，最多改 2 次，还不行就换成文字说明
// - 整页画完，截图让模型看一眼有没有画歪、字挤在一起（设置里能关）
// - 结论一到就开始念，分步一到就边念边指：念到哪一步，图上对应的节点就亮
// 讲解存在 data/explainers：index.json 是目录，每页一个 <id>.json（说人话 / 专业两个版本都留着），教学截图是 <id>-<n>.png。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';

const KINDS = new Set(['summary', 'diagram', 'steps', 'analogy', 'table', 'timeline', 'bars', 'sim', 'text', 'shot']);
const RENDER_WAIT_MS = 9000; // 窗口画一块图最多等多久
const FIXES = 2; // 画不出来的图最多改几次
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = (v, n) => String(v ?? '').replace(/\u0000/g, '').slice(0, n);
const short = (v, n) => (String(v ?? '').length > n ? String(v).slice(0, n) + '…' : String(v ?? ''));

// ---- 积木：模型写的东西先过一遍，字段不对、太长的截掉 ----
export function normBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const kind = String(b.kind || '').toLowerCase();
  if (!KINDS.has(kind)) return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  switch (kind) {
    case 'summary':
    case 'analogy':
      return b.text ? { kind, text: s(b.text, 800) } : null;
    case 'text':
      return b.text ? { kind, title: s(b.title, 60), text: s(b.text, 3000) } : null;
    case 'diagram': {
      const mermaid = s(b.mermaid, 8000).replace(/^\s*```(?:mermaid)?\s*|\s*```\s*$/g, '').trim();
      return mermaid ? { kind, title: s(b.title, 60), mermaid } : null;
    }
    case 'steps': {
      const items = arr(b.items)
        .slice(0, 8)
        .map((it) => ({ title: s(it?.title, 40), text: s(it?.text, 400), say: s(it?.say || it?.text, 240), nodes: arr(it?.nodes).map((x) => s(x, 40)).filter(Boolean).slice(0, 8) }))
        .filter((it) => it.title || it.text);
      return items.length ? { kind, title: s(b.title, 60), items } : null;
    }
    case 'table': {
      const rows = arr(b.rows).slice(0, 13).map((r) => arr(r).slice(0, 6).map((c) => s(c, 120)));
      return rows.length > 1 ? { kind, title: s(b.title, 60), rows } : null;
    }
    case 'timeline': {
      const items = arr(b.items).slice(0, 12).map((it) => ({ label: s(it?.label, 30), text: s(it?.text, 300) })).filter((it) => it.label || it.text);
      return items.length ? { kind, title: s(b.title, 60), items } : null;
    }
    case 'bars': {
      const items = arr(b.items).slice(0, 12).map((it) => ({ label: s(it?.label, 30), value: Number(it?.value) })).filter((it) => Number.isFinite(it.value));
      return items.length ? { kind, title: s(b.title, 60), unit: s(b.unit, 12), items } : null;
    }
    case 'sim':
      return b.html ? { kind, title: s(b.title, 60), html: s(b.html, 40000) } : null;
    case 'shot':
      return b.src ? { kind, title: s(b.title, 60), text: s(b.text, 300), src: s(b.src, 120) } : null;
  }
  return null;
}

// ---- 模型一边写、这边一边切：一行一块（JSON Lines）。写成多行的 JSON 也认（攒到能解析为止） ----
export class BlockParser {
  constructor() {
    this.buf = '';
    this.pending = '';
  }
  push(text) {
    this.buf += text;
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const b = this.#line(line);
      if (b) out.push(b);
    }
    return out;
  }
  flush() {
    const out = [];
    const b = this.#line(this.buf);
    this.buf = '';
    if (b) out.push(b);
    if (this.pending) {
      const last = this.#try(this.pending);
      this.pending = '';
      if (last) out.push(last);
    }
    return out;
  }
  #line(line) {
    const t = line.trim();
    if (!t || /^```/.test(t)) return null;
    if (!this.pending && !t.startsWith('{')) return null; // 模型多说的话
    this.pending += (this.pending ? '\n' : '') + t;
    const b = this.#try(this.pending);
    if (b !== undefined) this.pending = '';
    else if (this.pending.length > 60000) this.pending = ''; // 怎么也拼不成：扔掉
    return b || null;
  }
  // 解析成功返回积木（不认识的返回 null），还没写完返回 undefined
  #try(text) {
    try {
      return normBlock(JSON.parse(text.replace(/,\s*$/, '')));
    } catch {
      return undefined;
    }
  }
}

// ---- 给画图模块的提示 ----
export const GEN_PROMPT = `你是「宿主系统」的讲解绘制模块：把一个主题画成一页图解讲解，显示在讲解窗口里，系统会边念边指。
只输出 JSON Lines：每行一个 JSON 对象，一块积木一行。不要 Markdown、不要代码块、不要别的文字。

按这个顺序输出：
1. {"kind":"summary","text":"…"}：结论，一两句话，不超过 50 个字，第一句直接说答案。细节放到分步里，别都塞进结论。
2. {"kind":"diagram","title":"…","mermaid":"…"}：一张主图（流程图 flowchart、时序图 sequenceDiagram，或者用 flowchart TD 画结构图）。
3. {"kind":"steps","title":"…","items":[{"title":"…","text":"…","say":"…","nodes":["…"]}]}：分步说明，3～6 步。
   - title 8 个字以内；text 一两句；
   - say 是系统要念的旁白：口语，能念出口（「第一步，……」），25～50 个字（念十秒左右），一定不要超过 50 个字；数字和符号写成读法（「零点八秒」）；
   - nodes：这一步对应主图里的哪几块（念到这一步时它们会发光）。流程图、结构图写节点的 id，只写这一步真正涉及的一两个；
     时序图写第几条消息，比如 ["#2"]（消息从 1 数，Note 不算）。
4. {"kind":"analogy","text":"…"}：打个比方，用生活里的东西类比。
5. 需要时再加，最多两块，用不上就不加：
   - {"kind":"table","title":"…","rows":[["","甲","乙"],["速度","快","慢"]]}：对比，第一行是表头，最多 8 行。
   - {"kind":"timeline","title":"…","items":[{"label":"2019","text":"…"}]}：按先后发生了什么。
   - {"kind":"bars","title":"…","unit":"…","items":[{"label":"…","value":12}]}：几个数比大小。
   - {"kind":"sim","title":"…","html":"…"}：能动手玩的小模拟（滑块、按钮，拖一下看变化）。只有「拖一下看变化」比看图更好懂时才做（阈值、比例、速度、概率这类），一页最多一个。
     html 是一段完整的 HTML（带 <style> 和 <script>）：深色背景、浅色字、宽度自适应、高度 360 像素以内；不能联网，不能引外部文件。

Mermaid 规则（很重要，写错了画不出来）：
- 第一行写图的类型：flowchart LR（从左到右）、flowchart TD（从上到下）或 sequenceDiagram。超过 5 个节点连成一串时横着放不下，用 TD，或者用 subgraph 分成两三组。
- 节点 id 只用英文字母和数字（A、mic、asr）；显示的文字一律写成 id["文字"]，文字里不要再出现双引号和方括号。
- 连线写 A --> B；要写说明就写 A -->|说明| B。
- 不要写 style、classDef、click、%%{init}%% 这类配置，不要用 HTML 标签；一张图最多 12 个节点。
- 时序图的参与者写 participant A as 名字。
- mermaid 字段里的换行写成 \\n。

讲多深：
- plain（说人话）：少用术语，非用不可就顺手解释；多打比方，句子短。
- pro（专业）：用准确的术语，讲清楚机制、关键参数和边界情况，可以更紧凑。
内容要准确，拿不准的不写，不要编；宿主给的要点和具体事实要用上。`;

const CHECK_PROMPT = `你在检查一页图解讲解的截图（讲解窗口里画出来的样子，每张图是其中一块）。
只报真毛病：字被截断或者看不清、图画乱了（线和框缠在一起、箭头指错地方）、元素互相盖住挡住了字、表格行列错乱。
这些不算问题：两边留白多、构图不够平衡、颜色风格；金色发光的框、线、卡片是正在讲的那一步，也不算问题。
只输出 JSON Lines：有真毛病的每块一行 {"block":"b2","problem":"…","fix":"怎么改"}；没有就只输出 {"ok":true}。`;

// 念的旁白太长：在句号、问号、分号处截断（实在没有就在逗号处），一段不超过 max 个字
export function clipSay(text, max) {
  const t = String(text || '').replace(/[【】]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  // 只在引号、括号外面断
  let depth = 0;
  let stop = -1;
  let comma = -1;
  for (let k = 0; k < Math.min(t.length, max + 1); k++) {
    const c = t[k];
    if ('「“（(《'.includes(c)) depth++;
    else if ('」”）)》'.includes(c)) depth = Math.max(0, depth - 1);
    else if (!depth && '。！？；!?;'.includes(c)) stop = k + 1;
    else if (!depth && '，,、：:'.includes(c)) comma = k + 1;
  }
  let i = stop >= max * 0.4 ? stop : comma >= max * 0.4 ? comma : stop > 0 ? stop : comma > 0 ? comma : max;
  return t.slice(0, i).replace(/[，,、：:；;]$/, '') + (/[。！？!?]$/.test(t.slice(0, i)) ? '' : '。');
}

// ---- 念：交给嘴念一段，等面板报告这段念完 ----
export class VoiceLine {
  constructor({ mouth, out, log = () => {} }) {
    this.mouth = mouth;
    this.out = out;
    this.log = log;
    this.n = 0;
    this.waiters = new Map();
  }
  get mode() {
    if (!this.mouth || this.mouth.mode === 'off') return 'off';
    return this.mouth.ready ? 'on' : 'notready';
  }
  // 返回 done 念完 / interrupted 被打断（宿主按住说话、喊停）/ manual 声音关着 / cancelled 调用方不要了
  async speak(text, cancelled = () => false) {
    const mode = this.mode;
    if (mode === 'off') return 'manual';
    const est = 1500 + String(text).length * 230;
    if (mode === 'notready' || !this.mouth.sayTagged) {
      for (let t = 0; t < est; t += 200) {
        if (cancelled()) return 'cancelled';
        await sleep(200);
      }
      return 'done';
    }
    const key = `xn${++this.n}`;
    const gen = this.mouth.gen;
    const segs = this.mouth.sayTagged(text, key);
    if (!segs?.length) return 'done';
    this.out({ type: 'explain_narr', key, segs });
    let done = false;
    this.waiters.set(key, () => (done = true));
    const until = Date.now() + est * 2.5 + 8000; // 面板没报回来也别一直等
    try {
      while (!done) {
        if (cancelled()) return 'cancelled';
        if (this.mouth.gen !== gen) return 'interrupted';
        if (Date.now() > until) return 'done';
        await sleep(150);
      }
      return this.mouth.gen !== gen ? 'interrupted' : 'done';
    } finally {
      this.waiters.delete(key);
    }
  }
  spoken(key) {
    this.waiters.get(key)?.();
  }
}

// ---- 边念边指：讲解窗口当前这一页的旁白（结论 + 每一步） ----
class Narrator extends EventEmitter {
  constructor(voice) {
    super();
    this.voice = voice;
    this.page = null;
    this.version = 'plain';
    this.items = [];
    this.i = 0;
    this.status = 'idle'; // idle | playing | paused | done
    this.complete = false; // 这一页的积木写完了没有
    this.token = 0;
    this.more = null;
  }
  get active() {
    return this.status === 'playing';
  }
  // 宿主这时说「下一步」「停一下」算在跟讲解说话：正在念，或者暂停 / 念完没多久（讲完 2 分钟、暂停 10 分钟以后就不算了）
  get engaged() {
    if (this.status === 'playing') return true;
    const ago = Date.now() - (this.touched || 0);
    return this.status === 'paused' ? ago < 600_000 : this.status === 'done' ? ago < 120_000 : false;
  }
  load(page, version, blocks, { complete = true, play = false } = {}) {
    this.#halt();
    this.page = page;
    this.version = version;
    this.items = [];
    this.complete = false;
    this.i = 0;
    this.status = 'paused';
    this.add(blocks);
    this.complete = complete;
    if (play) this.play();
    else this.#state();
  }
  // 新到的积木：结论念一遍，分步一步一句。模型写长了也只念前面一两句（屏幕上照样是全文）
  add(blocks) {
    for (const b of blocks) {
      if (b.kind === 'summary') this.items.unshift({ say: clipSay(b.text, 60), step: null, title: '结论' });
      if (b.kind === 'steps') b.items.forEach((it, k) => this.items.push({ say: clipSay(it.say || it.text, 70), step: { block: b.id, index: k, nodes: it.nodes }, title: it.title }));
    }
    this.more?.();
  }
  finish() {
    this.complete = true;
    this.more?.();
  }
  play() {
    if (!this.page || this.status === 'playing') return;
    if (this.status === 'done') this.i = 0;
    this.status = 'playing';
    const token = ++this.token;
    this.#loop(token);
  }
  pause() {
    if (this.status !== 'playing') return;
    this.#halt();
    this.status = 'paused';
    this.#state();
  }
  go(i, play = this.voice.mode !== 'off') {
    if (!this.items.length) return;
    this.#halt();
    this.i = Math.max(0, Math.min(this.items.length - 1, i));
    this.status = 'paused';
    if (play) this.play();
    else this.#state(true);
  }
  next() {
    this.go(this.i + 1);
  }
  prev() {
    this.go(this.i - 1);
  }
  redo() {
    this.go(this.i, true);
  }
  stop() {
    this.#halt();
    this.status = this.page ? 'paused' : 'idle';
    this.#state();
  }
  #halt() {
    this.token++;
    if (this.status === 'playing' && this.voice.mouth?.mode !== 'off') this.voice.mouth?.stop();
    this.more?.();
    this.more = null;
  }
  async #loop(token) {
    const cancelled = () => token !== this.token;
    while (!cancelled() && this.status === 'playing') {
      const it = this.items[this.i];
      if (!it) {
        if (this.complete) {
          this.status = 'done';
          this.i = Math.max(0, this.items.length - 1);
          return this.#state();
        }
        await new Promise((r) => (this.more = r));
        this.more = null;
        continue;
      }
      this.#state(this.voice.mode === 'off');
      const r = await this.voice.speak(it.say, cancelled);
      if (cancelled()) return;
      if (r === 'interrupted' || r === 'manual') {
        this.status = 'paused';
        return this.#state(r === 'manual');
      }
      await sleep(650);
      if (cancelled()) return;
      if (this.i < this.items.length - 1 || !this.complete) this.i++;
      else {
        this.status = 'done';
        return this.#state();
      }
    }
  }
  #state(full = false) {
    this.touched = Date.now();
    const it = this.items[this.i];
    const steps = this.items.filter((x) => x.step).length;
    const stepNo = it?.step ? this.items.slice(0, this.i + 1).filter((x) => x.step).length : 0;
    this.emit('state', { page: this.page, version: this.version, status: this.status, i: this.i, n: this.items.length, step: it?.step || null, stepNo, steps, title: it?.title || '', say: it?.say || '', full });
  }
}

// ---- 讲解：存档 + 生成 + 给大脑的工具 ----
export class Explain extends EventEmitter {
  // runtime() / model()：大脑的模型运行时和当前模型（大脑起来以后才有）
  constructor({ dir, cfg, log = () => {}, mouth = null, out = () => {}, runtime = () => null, model = () => null }) {
    super();
    this.dir = dir;
    this.cfg = cfg;
    this.log = log;
    this.out = out;
    this.runtime = runtime;
    this.chatModel = model;
    this.voice = new VoiceLine({ mouth, out, log });
    this.narrator = new Narrator(this.voice);
    this.narrator.on('state', (st) => this.#onNarr(st));
    this.renders = new Map(); // `${page}:${version}:${block}` → 等窗口报告画没画出来
    this.captures = new Map();
    this.seq = 0;
    this.current = null; // 讲解窗口里正在看的那一页
    this.parentHint = null; // 宿主从讲解窗口里点图 / 圈字来问：新的一页接在那一页下面
    this.generating = new Set();
    this.live = new Map(); // 正在写的页：还没写完的积木在这里，不在文件里
  }

  // ---- 存档 ----
  #ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }
  #indexFile() {
    return path.join(this.dir, 'index.json');
  }
  index() {
    try {
      const j = JSON.parse(fs.readFileSync(this.#indexFile(), 'utf8'));
      return Array.isArray(j.pages) ? j.pages : [];
    } catch {
      return [];
    }
  }
  #saveIndex(pages) {
    this.#ensureDir();
    fs.writeFileSync(this.#indexFile(), JSON.stringify({ pages }, null, 1));
  }
  load(id) {
    if (!/^[\w-]+$/.test(String(id || ''))) return null;
    if (this.live.has(id)) return this.live.get(id);
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }
  save(page) {
    this.#ensureDir();
    fs.writeFileSync(path.join(this.dir, `${page.id}.json`), JSON.stringify(page));
    const pages = this.index().filter((p) => p.id !== page.id);
    const plain = page.versions.plain?.blocks || [];
    pages.push({ id: page.id, kind: page.kind, title: page.title, summary: plain.find((b) => b.kind === 'summary')?.text || page.summary || '', at: page.at, parent: page.parent || null, done: !!page.done });
    pages.sort((a, b) => a.at - b.at);
    this.#saveIndex(pages);
  }
  // 宿主在设置里点「清空讲解」
  clear() {
    this.narrator.stop();
    this.current = null;
    try {
      for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true, recursive: true });
    } catch {}
    this.out({ type: 'xw', op: 'close' });
    this.out({ type: 'explain_cleared' });
  }
  newId() {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}-${(++this.seq).toString(36)}`;
  }
  // 第几页（从 1 数）
  pageNo(id) {
    return this.index().findIndex((p) => p.id === id) + 1;
  }
  // 从这一页往上数的路径（点图展开出来的页面才有）
  crumb(page) {
    const out = [];
    let p = page;
    for (let i = 0; p?.parent && i < 6; i++) {
      p = this.load(p.parent);
      if (p) out.unshift({ id: p.id, title: p.title });
    }
    return out;
  }
  // 发给窗口的一整页
  view(page) {
    return { ...page, no: this.pageNo(page.id), total: this.index().length, crumb: this.crumb(page) };
  }

  // ---- 窗口 ----
  open(page, { version } = {}) {
    this.current = page.id;
    this.out({ type: 'xw', op: 'show', page: this.view(page), version: version || page.depth || 'plain', total: this.index().length });
  }
  card(page, extra = {}) {
    const blocks = page.versions[page.depth || 'plain']?.blocks || page.versions.plain?.blocks || [];
    const count = (k) => blocks.filter((b) => b.kind === k).length;
    const steps = blocks.filter((b) => b.kind === 'steps').reduce((a, b) => a + b.items.length, 0);
    const meta = [steps ? `${steps} 步` : '', count('diagram') ? `${count('diagram')} 张图` : '', count('table') ? '对比表' : '', count('sim') ? '模拟' : '', count('shot') ? `${count('shot')} 张截图` : '', `讲解窗口第 ${this.pageNo(page.id)} 页`].filter(Boolean).join(' · ');
    this.out({ type: 'explain_card', page: { id: page.id, kind: page.kind, title: page.title, summary: blocks.find((b) => b.kind === 'summary')?.text || '', meta, done: !!page.done }, ...extra });
  }

  // 讲解窗口里发生的事
  async fromWindow(m) {
    switch (m.op) {
      case 'ready': {
        const page = this.current && this.load(this.current);
        if (page) this.open(page, { version: m.version });
        return;
      }
      case 'get': {
        const list = this.index();
        const id = m.page || (m.no ? list[m.no - 1]?.id : null);
        const page = id && this.load(id);
        if (!page) return;
        this.current = page.id;
        this.out({ type: 'xw', op: 'show', page: this.view(page), version: page.depth || 'plain', total: list.length });
        // 翻到别的页：念的跟着换（先不念，宿主按播放再念）
        if (this.narrator.page !== page.id) this.narrator.load(page.id, page.depth || 'plain', page.versions[page.depth || 'plain']?.blocks || [], { complete: !!page.done });
        return;
      }
      case 'render': {
        this.renders.get(`${m.page}:${m.version}:${m.block}`)?.(m);
        return;
      }
      case 'closed': // 宿主关了讲解窗口：别再念了
        this.narrator.stop();
        return;
      case 'narr': {
        const n = this.narrator;
        if (m.page && n.page !== m.page) {
          const page = this.load(m.page);
          if (page) n.load(page.id, m.version || page.depth || 'plain', page.versions[m.version || page.depth || 'plain']?.blocks || [], { complete: !!page.done });
        }
        if (m.cmd === 'play') n.status === 'playing' ? n.pause() : n.play();
        if (m.cmd === 'pause') n.pause();
        if (m.cmd === 'next') n.next();
        if (m.cmd === 'prev') n.prev();
        if (m.cmd === 'redo') n.redo();
        if (m.cmd === 'goto') n.go(Number(m.i) || 0, true);
        return;
      }
      case 'depth':
        return this.switchDepth(m.page, m.depth).catch((e) => this.log('explain: 换深浅失败', e));
      case 'capture_result':
        this.captures.get(m.id)?.(m);
        return;
      case 'expand':
      case 'ask_sel':
      case 'ask': {
        const page = this.load(m.page);
        if (!page) return;
        const where = `讲解窗口第 ${this.pageNo(page.id)} 页「${page.title}」`;
        let text;
        let shown;
        if (m.op === 'expand') {
          const names = [].concat(m.labels || m.label || []).map((x) => s(x, 30)).filter(Boolean);
          text = `（宿主在${where}的图上点了「${names.join('」「')}」）展开讲讲${names.length > 1 ? '这几块' : '这一块'}：用 explain 画新的一页。`;
          shown = `展开讲讲「${names.join('」「')}」`;
        } else if (m.op === 'ask_sel') {
          const how = { rephrase: '换个说法讲', example: '多举几个具体的例子讲' }[m.how] || '讲得更细、更好懂一点';
          text = `（宿主在${where}里选中了这段：「${s(m.text, 300)}」，说「${{ rephrase: '换个说法', example: '举个例子' }[m.how] || '这里没看懂'}」）只针对这段${how}：用 explain 画新的一页。`;
          shown = `「${short(m.text, 24)}」${{ rephrase: '换个说法', example: '举个例子' }[m.how] || '这里没看懂'}`;
        } else {
          text = `（宿主在${where}的追问框里问）${s(m.text, 500)}\n（用 explain 画新的一页来回答。）`;
          shown = s(m.text, 200);
        }
        this.parentHint = { id: page.id, at: Date.now() };
        this.emit('ask', { text, shown });
        return;
      }
    }
  }

  #onNarr(st) {
    this.out({ type: 'xw', op: 'narr', ...st });
    const page = st.page && this.load(st.page);
    if (!page) return;
    const live = st.status === 'playing' ? (st.step ? `正在讲第 ${st.stepNo} / ${st.steps} 步：${st.title}` : '正在讲：结论') : st.status === 'paused' && st.i > 0 ? `已暂停 · 第 ${st.stepNo || 0} / ${st.steps} 步` : '';
    this.out({ type: 'explain_live', id: page.id, live });
  }

  // 宿主现在在听讲解：大脑这时的回复就不念了（免得跟讲解抢着说）
  get holdsVoice() {
    return this.narrator.active;
  }

  // ---- 生成 ----
  async #model() {
    const want = String(this.cfg.explain?.model || '').trim();
    const rt = this.runtime();
    if (want && rt) {
      const [provider, ...rest] = want.split('/');
      const id = rest.join('/');
      const m = (await rt.getAvailable()).find((x) => x.provider === provider && x.id === id);
      if (m) return m;
    }
    return this.chatModel();
  }

  // 让模型写积木：一边写一边交出来
  async *#generate(model, user, signal) {
    const rt = this.runtime();
    if (!rt || !model) throw new Error('大脑还没准备好');
    const stream = rt.streamSimple(model, { systemPrompt: GEN_PROMPT, messages: [{ role: 'user', content: user, timestamp: Date.now() }] }, { reasoning: 'off', maxTokens: 8000, signal });
    const parser = new BlockParser();
    for await (const ev of stream) {
      if (ev.type === 'text_delta') for (const b of parser.push(ev.delta)) yield b;
      if (ev.type === 'error') throw new Error(ev.error?.errorMessage || '画图模型出错');
    }
    for (const b of parser.flush()) yield b;
  }

  async #complete(model, system, content, maxTokens = 3000) {
    const rt = this.runtime();
    const r = await rt.completeSimple(model, { systemPrompt: system, messages: [{ role: 'user', content, timestamp: Date.now() }] }, { reasoning: 'off', maxTokens });
    if (r.errorMessage) throw new Error(r.errorMessage);
    return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }

  #addBlock(page, version, b) {
    const v = page.versions[version];
    // 结论、主图、分步、比方各只要一块；多出来的当文字
    if (['summary', 'analogy'].includes(b.kind) && v.blocks.some((x) => x.kind === b.kind)) return null;
    b.id = `b${++v.seq}`;
    v.blocks.push(b);
    return b;
  }

  // 等窗口报告这块画没画出来（窗口没开着、没回音的话当作画出来了）
  #waitRender(page, version, block) {
    const key = `${page.id}:${version}:${block.id}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.renders.delete(key);
        resolve({ ok: true, timeout: true });
      }, RENDER_WAIT_MS);
      this.renders.set(key, (m) => {
        clearTimeout(timer);
        this.renders.delete(key);
        resolve(m);
      });
    });
  }

  // 改一块：画不出来的图、截图检查发现的问题
  async #fixBlock(model, page, version, block, why, asText = false) {
    const ask = asText
      ? `这一块图画了几次都画不出来：${JSON.stringify(block)}\n改成一块 {"kind":"text","title":"${block.title || '说明'}","text":"…"}，用文字把这张图要表达的内容讲清楚。只输出这一行 JSON。`
      : `主题：${page.title}\n这一块有问题：${JSON.stringify(block)}\n问题：${why}\n只输出改好的这一行 JSON（同样的 kind${block.kind === 'diagram' ? '，节点 id 不要变' : ''}），别的都不要。`;
    const text = await this.#complete(model, GEN_PROMPT, ask);
    const parser = new BlockParser();
    const fixed = [...parser.push(text + '\n'), ...parser.flush()][0];
    if (!fixed) return null;
    fixed.id = block.id;
    const v = page.versions[version];
    v.blocks[v.blocks.findIndex((x) => x.id === block.id)] = fixed;
    return fixed;
  }

  // 一页（某个深浅的版本）从头写到尾。返回写出来的积木
  async build(page, version, user, { signal, narrate = true } = {}) {
    const model = await this.#model();
    page.versions[version] = { blocks: [], seq: 0, done: false };
    const key = `${page.id}:${version}`;
    this.generating.add(key);
    const renders = [];
    const visual = [];
    try {
      if (narrate) this.narrator.load(page.id, version, [], { complete: false, play: true });
      for await (const raw of this.#generate(model, user, signal)) {
        const b = this.#addBlock(page, version, raw);
        if (!b) continue;
        this.out({ type: 'xw', op: 'block', page: page.id, version, block: b });
        if (['diagram', 'bars', 'table', 'timeline', 'sim'].includes(b.kind)) visual.push(b.id);
        if (b.kind === 'diagram') renders.push(this.#waitRender(page, version, b).then((r) => ({ block: b, r })));
        if (narrate && this.narrator.page === page.id) this.narrator.add([b]);
        if (b.kind === 'summary') this.card(page);
      }
      // 画不出来的图：把报错发回去改
      for (const { block, r } of await Promise.all(renders)) {
        if (r.ok) continue;
        let cur = block;
        let res = r;
        for (let k = 0; k <= FIXES && !res.ok; k++) {
          const asText = k === FIXES;
          this.log('explain: 图画不出来，第', k + 1, '次改', res.error);
          const fixed = await this.#fixBlock(model, page, version, cur, `Mermaid 报错：${res.error || '画不出来'}`, asText).catch((e) => (this.log('explain: 改图失败', e.message), null));
          if (!fixed) break;
          this.out({ type: 'xw', op: 'block', page: page.id, version, block: fixed, replace: true });
          if (fixed.kind !== 'diagram') break;
          cur = fixed;
          res = await this.#waitRender(page, version, fixed);
        }
      }
      // 截图检查一遍
      if (this.cfg.explain?.selfCheck !== false && visual.length && model?.input?.includes?.('image')) await this.#selfCheck(model, page, version, visual).catch((e) => this.log('explain: 自检失败', e.message));
    } finally {
      this.generating.delete(key);
      page.versions[version].done = true;
      if (narrate && this.narrator.page === page.id) this.narrator.finish();
    }
    return page.versions[version].blocks;
  }

  async #selfCheck(model, page, version, ids) {
    const shots = await this.#capture(page.id, version, ids.slice(0, 3));
    if (!shots?.length) return;
    const blocks = page.versions[version].blocks.map(({ id, kind, title }) => ({ id, kind, title }));
    const content = [{ type: 'text', text: `主题：${page.title}\n这一页的积木：${JSON.stringify(blocks)}\n下面是 ${shots.map((x) => x.block).join('、')} 这几块画出来的截图。` }];
    for (const x of shots) content.push({ type: 'image', data: x.data, mimeType: x.mimeType || 'image/jpeg' });
    const text = await this.#complete(model, CHECK_PROMPT, content, 1200);
    const problems = text
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l.trim());
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.block && x.problem);
    // 同一块的几个问题合起来改一次；一页最多改两块
    const byBlock = new Map();
    for (const p of problems) byBlock.set(p.block, [...(byBlock.get(p.block) || []), `${p.problem}${p.fix ? `（建议：${p.fix}）` : ''}`]);
    for (const [id, list] of [...byBlock].slice(0, 2)) {
      const block = page.versions[version].blocks.find((b) => b.id === id);
      if (!block) continue;
      this.log('explain: 自检发现', id, list.join('；'));
      const fixed = await this.#fixBlock(model, page, version, block, list.join('；')).catch(() => null);
      if (!fixed) continue;
      this.out({ type: 'xw', op: 'block', page: page.id, version, block: fixed, replace: true });
      if (fixed.kind === 'diagram') {
        const r = await this.#waitRender(page, version, fixed);
        if (!r.ok) {
          // 改坏了：换回原来那块
          const v = page.versions[version];
          v.blocks[v.blocks.findIndex((x) => x.id === block.id)] = block;
          this.out({ type: 'xw', op: 'block', page: page.id, version, block, replace: true });
        }
      }
    }
  }

  // 让窗口把这几块截下来（主进程截讲解窗口自己的画面，不截别的）
  #capture(page, version, blocks) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.captures.delete(id);
        resolve(null);
      }, 15000);
      this.captures.set(id, (m) => {
        clearTimeout(timer);
        this.captures.delete(id);
        resolve(m.ok ? m.images : null);
      });
      this.out({ type: 'xw', op: 'capture', id, page, version, blocks });
    });
  }

  // 新的一页
  #newPage({ title, brief, depth, kind = 'explain' }) {
    const parent = this.parentHint && Date.now() - this.parentHint.at < 5 * 60_000 ? this.parentHint.id : null;
    this.parentHint = null;
    return { id: this.newId(), kind, title: s(title, 60) || '讲解', brief: s(brief, 4000), at: Date.now(), parent, depth: depth === 'pro' ? 'pro' : 'plain', versions: {}, done: false };
  }

  // explain 工具：画一页
  async run({ title, brief, depth }, signal) {
    const page = this.#newPage({ title, brief, depth });
    const version = page.depth;
    page.versions[version] = { blocks: [], seq: 0, done: false };
    this.live.set(page.id, page);
    this.save(page);
    this.open(page);
    this.card(page);
    const parent = page.parent ? this.load(page.parent) : null;
    const user = `主题：${page.title}\n深浅：${version}\n要讲清楚的：${page.brief}${parent ? `\n（这一页是从上一页「${parent.title}」展开的，接着它讲，别重复上一页已经讲过的。）` : ''}`;
    let blocks = [];
    let error = '';
    try {
      blocks = await this.build(page, version, user, { signal });
    } catch (e) {
      error = String(e?.message || e);
      this.log('explain: 生成失败', error);
      blocks = page.versions[version].blocks;
    }
    page.done = true;
    this.save(page);
    this.live.delete(page.id);
    this.card(page);
    this.out({ type: 'xw', op: 'done', page: page.id, version });
    if (!blocks.length) throw new Error(`讲解没画出来：${error || '画图模型什么都没写'}`);
    const summary = blocks.find((b) => b.kind === 'summary')?.text || '';
    const steps = blocks.find((b) => b.kind === 'steps')?.items.length || 0;
    const voice = this.voice.mode === 'off' ? '系统声音关着，讲解窗口里只高亮不念' : '讲解窗口正在边念边指';
    return {
      content: [{ type: 'text', text: `已画好第 ${this.pageNo(page.id)} 页「${page.title}」${error ? `（中途出错，只画出 ${blocks.length} 块：${short(error, 80)}）` : ''}：${blocks.length} 块，分 ${steps} 步。结论：${summary}\n${voice}。你回复宿主一句话就行（比如「图解已生成，在讲解窗口里。」），别把讲解内容再说一遍。` }],
      details: { page: page.id, blocks: blocks.length },
    };
  }

  // 讲解窗口里切「说人话 / 专业」：另一个版本没有就现写，两个版本都留着
  async switchDepth(id, depth) {
    const page = this.load(id);
    if (!page || !['plain', 'pro'].includes(depth)) return;
    page.depth = depth;
    this.save(page);
    if (page.versions[depth]?.blocks?.length) {
      this.out({ type: 'xw', op: 'show', page: this.view(page), version: depth, total: this.index().length });
      this.narrator.load(page.id, depth, page.versions[depth].blocks, { complete: true });
      return;
    }
    if (this.generating.has(`${id}:${depth}`)) return;
    this.live.set(id, page);
    this.out({ type: 'xw', op: 'version', page: id, version: depth, blocks: [] });
    const other = page.versions[depth === 'pro' ? 'plain' : 'pro'];
    const ref = other?.blocks?.length ? `\n这一页已经有${depth === 'pro' ? '「说人话」' : '「专业」'}版本（下面），按${depth === 'pro' ? '专业' : '说人话'}的深浅重写同一个主题，结构可以不一样：\n${JSON.stringify(other.blocks.map(({ id: _i, ...b }) => b)).slice(0, 12000)}` : '';
    const user = `主题：${page.title}\n深浅：${depth}\n要讲清楚的：${page.brief}${ref}`;
    try {
      await this.build(page, depth, user, { narrate: this.narrator.page === page.id });
    } finally {
      this.save(page);
      this.live.delete(id);
      this.card(page);
      this.out({ type: 'xw', op: 'done', page: id, version: depth });
    }
  }

  // 找以前的讲解
  search(query) {
    const words = String(query || '').toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    const list = this.index();
    if (!words.length) return list.slice(-5).reverse();
    return list
      .map((p) => {
        // 标题里有的比结论里有的排前面
        const t = String(p.title || '').toLowerCase();
        const sm = String(p.summary || '').toLowerCase();
        return [words.reduce((n, w) => n + (t.includes(w) ? 2 : sm.includes(w) ? 1 : 0), 0), p];
      })
      .filter(([n]) => n > 0)
      .sort((a, b) => b[0] - a[0] || b[1].at - a[1].at)
      .map(([, p]) => p);
  }

  // 教学结束：步骤和截图存成一页
  saveTutor({ title, summary, app, steps }) {
    const page = { id: this.newId(), kind: 'tutor', title: s(title, 60) || '教学', brief: '', at: Date.now(), parent: null, depth: 'plain', versions: {}, done: true };
    const blocks = [];
    let seq = 0;
    const add = (b) => blocks.push({ ...b, id: `b${++seq}` });
    add({ kind: 'summary', text: s(summary, 600) || `在「${app}」里${title}，一共 ${steps.length} 步。` });
    add({ kind: 'steps', title: '步骤', items: steps.map((x, i) => ({ title: s(x.title || `第 ${i + 1} 步`, 40), text: s(x.say, 300), say: s(x.say, 240), nodes: [] })) });
    steps.forEach((x, i) => {
      if (!x.shot) return;
      const src = `${page.id}-${i + 1}.png`;
      try {
        this.#ensureDir();
        fs.writeFileSync(path.join(this.dir, src), Buffer.from(x.shot, 'base64'));
        add({ kind: 'shot', title: `第 ${i + 1} 步 · ${s(x.title, 30)}`, text: s(x.result, 200), src });
      } catch (e) {
        this.log('explain: 存教学截图失败', e.message);
      }
    });
    page.versions.plain = { blocks, seq, done: true };
    this.save(page);
    this.card(page);
    return page;
  }

  // ---- 给大脑的工具 ----
  tools() {
    const self = this;
    return [
      {
        name: 'explain',
        label: '画图讲解',
        description:
          '画一页图解讲解，在讲解窗口里打开（宿主说「画图讲讲」「图解一下」「画个图」「可视化一下」时用；宿主从讲解窗口里点图、圈字、追问时也用）。画图模块会按 结论 → 主图 → 分步 → 比方 的顺序一块块画出来，画好一块显示一块，并且自动边念边指。title：主题；brief：要讲清楚哪些点、你已经知道的具体事实（画图模块看不到你们的对话和宿主的屏幕，用得上的内容都写进来）；depth：plain 说人话（默认），宿主要专业的才用 pro。',
        parameters: Type.Object({
          title: Type.String({ description: '主题，比如「TCP 三次握手」' }),
          brief: Type.String({ description: '要讲清楚的要点和已知事实' }),
          depth: Type.Optional(Type.Union([Type.Literal('plain'), Type.Literal('pro')])),
        }),
        async execute(_id, p, signal) {
          return self.run(p, signal);
        },
      },
      {
        name: 'explain_open',
        label: '打开以前的讲解',
        description: '按关键词找以前画过的讲解（也包括教学小结），在讲解窗口里重新打开。宿主说「把上次讲声音的那张图再打开」时用。',
        parameters: Type.Object({ query: Type.String({ description: '关键词；空着就打开最近一页' }) }),
        async execute(_id, p) {
          const hits = self.search(p.query);
          if (!hits.length) return { content: [{ type: 'text', text: `没找到跟「${p.query}」有关的讲解。` }], details: { count: 0 } };
          const page = self.load(hits[0].id);
          if (page) self.open(page);
          const more = hits.slice(1, 5).map((h) => `「${h.title}」`).join('、');
          return { content: [{ type: 'text', text: `已在讲解窗口打开第 ${self.pageNo(hits[0].id)} 页「${hits[0].title}」。${more ? `相关的还有：${more}。` : ''}` }], details: { count: hits.length } };
        },
      },
    ];
  }

  describe(name, args = {}) {
    if (name === 'explain') return `画图讲解：${short(args.title, 20)}`;
    if (name === 'explain_open') return `打开讲解：${short(args.query, 16) || '最近一页'}`;
    return undefined;
  }
}

// 讲解、就地讲解、教学进行中，宿主说的短句（「停一下」「下一步」「你来」……）。整句只是这个意思才算
const CMDS = [
  ['pause', /^(停一?下|暂停|暂停一?下|先停|先停一?下|等一?下|等等|停)$/],
  ['resume', /^(继续|继续讲|接着讲|接着|往下讲|开始|播放|讲)$/],
  ['next', /^(下一步|下一个|下一页|跳到下一步|往后)$/],
  ['prev', /^(上一步|上一个|回去|退回去|往前)$/],
  ['redo', /^(再讲一遍|这步再讲一遍|这一步再讲一遍|重讲|再说一遍|没听清|没听清楚|再来一遍)$/],
  ['again', /^(再指一遍|在哪|在哪里|在哪儿|哪个|找不到|没找到)$/],
  ['do', /^(你来|你来做|你做|你帮我点|你帮我做|帮我点|你点)$/],
  ['skip', /^(跳过|跳过这步|跳过这一步|这步跳过)$/],
  ['done', /^(做好了|好了|点好了|点了|完成了|做完了|弄好了|搞定了|搞定|我点了|我做好了)$/],
  ['exit', /^(退出|退出讲解|退出教学|不讲了|别讲了|不学了|关掉讲解|结束讲解|结束教学|算了)$/],
];
export function parseGuideCmd(text) {
  const t = String(text || '').replace(/[\s，,。.!！?？、~～…:：;；"“”'‘’]/g, '').replace(/^(系统|那|嗯)+(?=.)/, '');
  if (!t || t.length > 10) return null;
  const tt = t.replace(/(吧|啊|呀|哈|嘛|哦)+$/, '');
  for (const [cmd, re] of CMDS) if (re.test(tt) || re.test(t)) return cmd;
  return null;
}
