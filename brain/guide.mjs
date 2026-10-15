// 就地讲解和手把手教学：不开新窗口，直接在宿主屏幕上那个软件上标注。
// - 就地讲解（point_out）：依次给按钮标编号、框起来，系统光标飞过去，边指边念；宿主一点鼠标或者窗口挪了就暂停
// - 手把手教学（tutor_step）：亮出这一步要点的地方，等宿主自己点；点对了、界面也变了才算这一步做完
// 标注都画在效果层上（点不到、不挡宿主），坐标是屏幕物理像素，跟 screen.mjs 读到的元素位置一样。
import { EventEmitter } from 'node:events';
import { Type } from '@earendil-works/pi-ai';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = (v, n) => String(v ?? '').slice(0, n);
const short = (v, n) => (String(v ?? '').length > n ? String(v).slice(0, n) + '…' : String(v ?? ''));
const inside = (x, y, r, pad = 0) => !!r && x >= r.x - pad && y >= r.y - pad && x <= r.x + r.width + pad && y <= r.y + r.height + pad;
const moved = (a, b) => !!a && !!b && (Math.abs(a.x - b.x) > 4 || Math.abs(a.y - b.y) > 4 || Math.abs(a.width - b.width) > 4 || Math.abs(a.height - b.height) > 4);
const shift = (r, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy });
const TUTOR_WAIT_MS = 180_000;

export class Guide extends EventEmitter {
  // voice：explain.mjs 的 VoiceLine（念一段、等念完）；explain：教完存小结用
  constructor({ screen, operator, voice, explain, out = () => {}, log = () => {} }) {
    super();
    this.screen = screen;
    this.operator = operator;
    this.voice = voice;
    this.explain = explain;
    this.out = out;
    this.log = log;
    this.token = 0;
    this.tour = null; // 就地讲解
    this.tutor = null; // 教学
  }

  get active() {
    return !!(this.tour && this.tour.status !== 'done') || !!this.tutor;
  }
  // 讲解、教学进行中：大脑的回复不念（免得跟旁白抢着说）
  get holdsVoice() {
    return this.tour?.status === 'playing' || !!this.tutor;
  }

  #fx(data) {
    this.operator?.fx('guide', data);
  }

  // ======== 就地讲解 ========
  async startTour(app, items) {
    if (!this.screen?.available) throw new Error('现在不能操作软件界面（没装 Cua Driver / Open Computer Use），没法在软件上标注；可以改用 explain 画图讲解');
    if (!items?.length) throw new Error('items 至少要有一个');
    this.stopTour(true);
    const list = [];
    for (const it of items.slice(0, 12)) {
      const loc = await this.screen.locate(app, { element: it.element, x: it.x, y: it.y });
      list.push({ name: s(it.name || loc.name, 24) || '这里', say: s(it.say, 300), rect: loc.rect, est: loc.est, wid: loc.w.wid });
    }
    const wid = list[0].wid;
    const t = { app, title: this.screen.titleOf?.(wid) || app, wid, base: this.screen.rectOf(wid), items: list, i: 0, status: 'playing' };
    this.tour = t;
    this.#tourPanel();
    this.#tourLoop(++this.token);
    return t;
  }

  #tourShow() {
    const t = this.tour;
    if (!t) return;
    const win = this.screen.rectOf(t.wid) || t.base;
    this.#fx({ phase: 'frame', key: 'tour', rect: win });
    t.items.forEach((it, k) => this.#fx({ phase: 'mark', key: 'tour', n: k + 1, rect: it.rect, state: k === t.i ? 'cur' : k < t.i ? 'past' : 'later', est: it.est }));
    const it = t.items[t.i];
    this.#fx({ phase: 'focus', key: 'tour', mode: 'tour', rect: it.rect, label: `${t.i + 1} · ${it.name}`, name: it.name, text: it.say, sub: `${t.i + 1} / ${t.items.length}`, est: it.est, paused: t.status !== 'playing' });
    this.#tourPanel();
  }

  #tourPanel() {
    const t = this.tour;
    if (!t) return;
    this.out({ type: 'guide', state: { app: t.title, items: t.items.map((x) => x.name), i: t.i, status: t.status, say: t.items[t.i]?.say || '' } });
  }

  // 窗口挪了：标注跟着挪
  #realign(t) {
    const now = this.screen.isWindow?.(t.wid) === false ? null : this.screen.rectOf(t.wid);
    if (!now) return 'gone';
    if (!moved(now, t.base)) return false;
    const dx = now.x - t.base.x;
    const dy = now.y - t.base.y;
    t.items = t.items.map((it) => ({ ...it, rect: shift(it.rect, dx, dy) }));
    t.base = now;
    return true;
  }

  async #tourLoop(token) {
    const t = this.tour;
    const cancelled = () => token !== this.token || this.tour !== t || t.status !== 'playing';
    while (!cancelled()) {
      if (this.#realign(t) === 'gone') return this.stopTour(false, '窗口关掉了');
      this.#tourShow();
      const since = Date.now();
      let why = '';
      // 宿主点了鼠标、按了键，或者窗口挪了：暂停（标注跟着窗口重新对齐）
      const interrupt = () => {
        if (cancelled()) return true;
        if ((this.operator?.userInputAt || 0) > since + 250) why = 'input';
        else if (moved(this.screen.rectOf(t.wid), t.base)) why = 'moved';
        return !!why;
      };
      let r = await this.voice.speak(t.items[t.i].say, interrupt);
      if (r === 'manual') {
        // 声音关着：字幕放一会儿（按字数算），再往下
        r = 'done';
        for (let k = 0; k < 2000 + t.items[t.i].say.length * 220; k += 200) {
          if (interrupt()) {
            r = 'cancelled';
            break;
          }
          await sleep(200);
        }
      }
      if (token !== this.token || this.tour !== t) return;
      if (r === 'cancelled' || r === 'interrupted') {
        if (t.status !== 'playing') return; // 宿主自己按了暂停 / 下一个
        t.status = 'paused';
        if (r === 'cancelled' && this.voice.mouth?.mode !== 'off') this.voice.mouth?.stop();
        if (why === 'moved') this.#realign(t);
        this.#tourShow();
        return;
      }
      await sleep(700);
      if (cancelled()) return;
      if (t.i < t.items.length - 1) t.i++;
      else return this.#tourDone();
    }
  }

  #tourDone() {
    const t = this.tour;
    if (!t) return;
    t.status = 'done';
    this.#tourPanel();
    setTimeout(() => {
      if (this.tour === t) {
        this.#fx({ phase: 'clear', key: 'tour', rect: t.base });
        this.tour = null;
      }
    }, 1500);
  }

  stopTour(silent = false, why = '') {
    const t = this.tour;
    if (!t) return;
    this.token++;
    if (t.status === 'playing' && this.voice.mouth?.mode !== 'off') this.voice.mouth?.stop();
    this.#fx({ phase: 'clear', key: 'tour', rect: t.base });
    this.tour = null;
    if (!silent) this.out({ type: 'guide', state: { app: t.title, items: t.items.map((x) => x.name), i: t.i, status: 'exit', say: why } });
  }

  tourCmd(cmd) {
    const t = this.tour;
    if (!t || t.status === 'done') return false;
    const play = () => {
      t.status = 'playing';
      this.#tourLoop(++this.token);
    };
    const halt = () => {
      this.token++;
      if (t.status === 'playing' && this.voice.mouth?.mode !== 'off') this.voice.mouth?.stop();
    };
    switch (cmd) {
      case 'pause':
        if (t.status !== 'playing') return true;
        halt();
        t.status = 'paused';
        this.#tourShow();
        return true;
      case 'resume':
      case 'play':
        halt();
        this.#realign(t);
        play();
        return true;
      case 'next':
      case 'prev':
        halt();
        t.i = Math.max(0, Math.min(t.items.length - 1, t.i + (cmd === 'next' ? 1 : -1)));
        play();
        return true;
      case 'redo':
        halt();
        play();
        return true;
      case 'exit':
        this.stopTour();
        return true;
    }
    return false;
  }

  // ======== 手把手教学 ========
  async tutorStep(p, signal) {
    if (!this.screen?.available) throw new Error('现在不能操作软件界面（没装 Cua Driver / Open Computer Use），没法手把手教');
    this.stopTour(true);
    const index = Math.max(1, Math.round(p.index || 1));
    if (!this.tutor || index === 1 || (p.title && p.title !== this.tutor.title)) {
      this.tutor = { app: p.app, title: s(p.title, 40) || '手把手教学', steps: (p.steps || []).map((x) => s(x, 24)), records: [], wid: null };
    }
    const tu = this.tutor;
    if (p.steps?.length) tu.steps = p.steps.map((x) => s(x, 24));
    const loc = await this.screen.locate(p.app, { element: p.element, x: p.x, y: p.y });
    tu.wid = loc.w.wid;
    tu.app = p.app;
    const total = Math.max(tu.steps.length, index);
    const before = await this.screen.fingerprint(p.app).catch(() => null);
    const w = { index, total, say: s(p.say, 200), title: tu.steps[index - 1] || s(loc.name, 24) || `第 ${index} 步`, rect: loc.rect, est: loc.est, win: this.screen.rectOf(loc.w.wid), before, wrong: 0, asking: false, busy: false, warn: '' };
    tu.wait = w;
    this.#tutorShow();
    this.voice.mouth?.say(w.say);
    this.out({ type: 'watch_clicks', on: true });
    const result = await new Promise((resolve) => {
      w.resolve = resolve;
      w.timer = setTimeout(() => resolve({ kind: 'timeout' }), TUTOR_WAIT_MS);
      signal?.addEventListener?.('abort', () => resolve({ kind: 'abort' }), { once: true });
    });
    clearTimeout(w.timer);
    this.out({ type: 'watch_clicks', on: false });
    if (this.tutor === tu) tu.wait = null;
    return this.#tutorResult(tu, w, result);
  }

  #tutorShow() {
    const tu = this.tutor;
    const w = tu?.wait;
    if (!w) return;
    const now = this.screen.rectOf(tu.wid);
    if (now && w.win && moved(now, w.win)) {
      w.rect = shift(w.rect, now.x - w.win.x, now.y - w.win.y);
      w.win = now;
    }
    this.#fx({ phase: 'frame', key: 'tutor', rect: w.win });
    this.#fx({ phase: 'focus', key: 'tutor', mode: 'tutor', rect: w.rect, label: '点这里', text: w.say, sub: `${w.index} / ${w.total}`, est: w.est });
    this.#tutorPanel();
  }

  #tutorPanel(extra = {}) {
    const tu = this.tutor;
    if (!tu) return;
    const w = tu.wait;
    this.out({ type: 'tutor', state: { title: tu.title, app: tu.app, steps: tu.steps, index: w?.index || tu.records.length, total: w?.total || tu.steps.length, say: w?.say || '', warn: w?.warn || '', asking: !!w?.asking, status: 'waiting', ...extra } });
  }

  // 宿主点了鼠标（桌面主进程报过来的，屏幕物理像素）
  async onClick(x, y) {
    const tu = this.tutor;
    const w = tu?.wait;
    if (!w || w.busy || w.asking) return;
    if (!inside(x, y, w.win)) return; // 点在别处（比如系统面板）：不算
    if (!inside(x, y, w.rect, w.est ? 20 : 8)) {
      w.wrong++;
      w.warn = w.wrong >= 3 ? '这一步点错 3 次了，要不要系统来做这一步？说「你来」或点「你来做这步」' : '点错了，没关系，再看一眼亮着的地方';
      this.#fx({ phase: 'hint', key: 'tutor', rect: w.rect, text: '不是这里，要点的是亮着的那个' });
      if (w.wrong === 3) this.voice.mouth?.say('要不要系统来做这一步？说你来就行。');
      return this.#tutorPanel();
    }
    // 点在框里：等界面反应一下，看看变没变
    w.busy = true;
    this.#fx({ phase: 'ripple', key: 'tutor', rect: { x, y, width: 0, height: 0 } });
    try {
      for (const ms of [700, 900]) {
        await sleep(ms);
        if (tu.wait !== w) return;
        const after = await this.screen.fingerprint(tu.app).catch(() => null);
        if (!w.before || !after || !after.count) break; // 读不出界面：问宿主
        if (after.sig !== w.before.sig) return w.resolve({ kind: 'done', changed: true, after });
      }
      if (tu.wait !== w) return;
      w.asking = true;
      w.warn = '';
      this.voice.mouth?.say('做好了吗？');
      this.#tutorPanel();
    } finally {
      w.busy = false;
    }
  }

  async tutorCmd(cmd) {
    const tu = this.tutor;
    if (!tu) return false;
    const w = tu.wait;
    switch (cmd) {
      case 'do':
      case 'skip':
        if (!w) return true;
        w.resolve({ kind: cmd });
        return true;
      case 'done': {
        if (!w) return true;
        const after = await this.screen.fingerprint(tu.app).catch(() => null);
        w.resolve({ kind: 'done', changed: !!(after && w.before && after.sig !== w.before.sig), after, byHost: true });
        return true;
      }
      case 'notyet':
        if (w) {
          w.asking = false;
          w.warn = '好，再点一下亮着的地方试试';
          this.#tutorPanel();
        }
        return true;
      case 'again':
      case 'redo':
        if (w) {
          this.#tutorShow();
          this.voice.mouth?.say(w.say);
        }
        return true;
      case 'exit':
        if (w) w.resolve({ kind: 'exit' });
        else this.endTutor('exit');
        return true;
    }
    return false;
  }

  #tutorResult(tu, w, r) {
    const text = (t) => ({ content: [{ type: 'text', text: t }], details: { result: r.kind, index: w.index } });
    const last = w.index >= w.total;
    if (r.kind === 'done') {
      tu.records[w.index - 1] = { title: w.title, say: w.say, shot: r.after?.image || null, result: r.byHost ? '宿主说做好了' : '界面变了' };
      this.#fx({ phase: 'clear', key: 'tutor', rect: w.win });
      this.#tutorPanel({ index: w.index, status: 'step_done' });
      return text(`宿主做完了第 ${w.index} 步${r.changed ? '（界面变了）' : r.byHost ? '（宿主说做好了）' : ''}。${last ? '这是最后一步了：用 tutor_finish 存小结。' : '接着用 tutor_step 教下一步；界面变了，先 read_app 重新读一遍拿新编号。'}`);
    }
    if (r.kind === 'do') return text(`宿主让你来做第 ${w.index} 步（${w.say}）：用 click / type_text / press_keys 替他做（照常走授权），做完${last ? '用 tutor_finish 存小结' : '再用 tutor_step 教下一步（界面变了先 read_app）'}。`);
    if (r.kind === 'skip') {
      tu.records[w.index - 1] = { title: w.title, say: w.say, shot: null, result: '跳过了' };
      return text(`宿主跳过了第 ${w.index} 步。${last ? '用 tutor_finish 存小结。' : '接着教下一步。'}`);
    }
    if (r.kind === 'exit') {
      this.endTutor('exit');
      return text('宿主退出了教学。停下来，回一句话就行，不要再调 tutor_step。');
    }
    if (r.kind === 'abort') {
      this.endTutor('exit');
      return text('教学被中止了。');
    }
    this.#fx({ phase: 'clear', key: 'tutor', rect: w.win });
    this.#tutorPanel({ status: 'timeout', warn: '等了 3 分钟没动静，教学先停在这一步' });
    return text(`等了 3 分钟宿主都没动，教学先停在第 ${w.index} 步。告诉宿主：说「继续」就接着教（到时候重新调 tutor_step 教这一步）。`);
  }

  endTutor(status = 'exit') {
    const tu = this.tutor;
    if (!tu) return;
    if (tu.wait) {
      clearTimeout(tu.wait.timer);
      tu.wait.resolve?.({ kind: 'exit' });
    }
    this.#fx({ phase: 'clear', key: 'tutor', rect: this.screen.rectOf(tu.wid) || tu.wait?.win || { x: 0, y: 0, width: 1, height: 1 } });
    this.out({ type: 'watch_clicks', on: false });
    this.out({ type: 'tutor', state: { title: tu.title, app: tu.app, steps: tu.steps, index: tu.records.length, total: tu.steps.length, status } });
    this.tutor = null;
  }

  finishTutor(summary) {
    const tu = this.tutor;
    if (!tu) throw new Error('现在没有在教学（没调过 tutor_step）');
    const steps = tu.steps.map((title, i) => ({ title, say: tu.records[i]?.say || title, shot: tu.records[i]?.shot || null, result: tu.records[i]?.result || '' }));
    for (let i = steps.length; i < tu.records.length; i++) if (tu.records[i]) steps.push({ title: tu.records[i].title, say: tu.records[i].say, shot: tu.records[i].shot, result: tu.records[i].result });
    const page = this.explain?.saveTutor({ title: tu.title, summary, app: tu.app, steps });
    const done = tu.records.filter((r) => r && r.result !== '跳过了').length;
    this.#fx({ phase: 'clear', key: 'tutor', rect: this.screen.rectOf(tu.wid) || { x: 0, y: 0, width: 1, height: 1 } });
    this.out({ type: 'watch_clicks', on: false });
    this.out({ type: 'tutor', state: { title: tu.title, app: tu.app, steps: tu.steps, index: steps.length, total: steps.length, status: 'done', page: page?.id || null, done } });
    this.tutor = null;
    return { page, steps: steps.length, done };
  }

  // 宿主说的短句：先给教学，再给就地讲解
  async command(cmd) {
    if (this.tutor) return this.tutorCmd(cmd === 'resume' ? 'again' : cmd);
    if (this.tour) return this.tourCmd(cmd);
    return false;
  }

  stopAll() {
    this.stopTour(true);
    if (this.tutor) this.endTutor('exit');
  }

  // ======== 给大脑的工具 ========
  tools() {
    const self = this;
    const text = (t, details) => ({ content: [{ type: 'text', text: t }], details });
    const target = {
      element: Type.Optional(Type.Integer({ description: 'read_app 读到的编号' })),
      x: Type.Optional(Type.Number({ description: '读不出按钮时：最近一次 read_app 截图上的 x' })),
      y: Type.Optional(Type.Number()),
    };
    return [
      {
        name: 'point_out',
        label: '就地讲解',
        description:
          '在宿主屏幕上那个软件本身上标注着讲（宿主问「这些按钮都是干嘛的」「给我讲讲这个窗口」时用）：依次给每个元素标编号、框起来，系统光标飞过去，边指边念你写的旁白。先 read_app 读界面，items 用读到的编号（element）；读不出按钮的界面给截图坐标 x、y。最多 8 个，挑最常用的，宿主说「全部讲一遍」才多讲。工具马上返回，讲解在后台进行，宿主可以暂停、跳过；你回复宿主一句话就行，别把旁白再说一遍。',
        parameters: Type.Object({
          app: Type.String({ description: '窗口标题或程序名' }),
          items: Type.Array(Type.Object({ ...target, name: Type.String({ description: '名字，6 个字以内' }), say: Type.String({ description: '要念的旁白：这是干嘛的、什么时候用，一两句，30～60 字' }) })),
        }),
        async execute(_id, p) {
          const t = await self.startTour(p.app, p.items);
          return text(`已开始在「${short(t.title, 20)}」上就地讲解 ${t.items.length} 个元素（边指边念，宿主可以暂停、跳过，讲完自动收起）。回复宿主一句话就行，别把旁白再说一遍。`, { count: t.items.length });
        },
      },
      {
        name: 'tutor_step',
        label: '教学一步',
        description:
          '手把手教学的一步（宿主说「教我…」「带我做一遍」时用）：在真实软件上亮出这一步要点的地方，念一句要做什么，然后等宿主自己去点；宿主点对了、界面也变了才返回（最多等 3 分钟）。第一步要给 title（教什么）和 steps（全部步骤，每步 8 个字以内）。element 用最近一次 read_app 的编号；读不出按钮的界面给截图坐标 x、y。返回「做完了」就接着教下一步（界面变了先 read_app 拿新编号）；返回「宿主让你来做」就用 click 等工具替他做这一步。全部做完用 tutor_finish。',
        parameters: Type.Object({
          app: Type.String(),
          index: Type.Integer({ description: '第几步，从 1 开始' }),
          say: Type.String({ description: '这一步要做什么，一句话，比如「点来源下面的加号」' }),
          ...target,
          title: Type.Optional(Type.String({ description: '第一步给：教的是什么，比如「在 OBS 里添加窗口采集」' })),
          steps: Type.Optional(Type.Array(Type.String(), { description: '第一步给：全部步骤，每步 8 个字以内' })),
        }),
        async execute(_id, p, signal) {
          return self.tutorStep(p, signal);
        },
      },
      {
        name: 'tutor_finish',
        label: '教学完成',
        description: '手把手教学全部做完时用：把每一步和截图存成一页讲解（以后在讲解窗口里能翻），收起标注。summary：一两句话总结宿主学会了什么。',
        parameters: Type.Object({ summary: Type.String() }),
        async execute(_id, p) {
          const r = self.finishTutor(p.summary);
          return text(`教学完成：${r.done} / ${r.steps} 步宿主自己做完了，小结已存成讲解窗口第 ${r.page ? self.explain.pageNo(r.page.id) : '?'} 页。回复宿主一句话就行。`, { page: r.page?.id });
        },
      },
    ];
  }

  describe(name, args = {}) {
    if (name === 'point_out') return `就地讲解：${short(args.app, 16)}（${(args.items || []).length} 个）`;
    if (name === 'tutor_step') return `教学第 ${args.index} 步：${short(args.say, 20)}`;
    if (name === 'tutor_finish') return '教学完成，存小结';
    return undefined;
  }
}
