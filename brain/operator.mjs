// 让系统的操作「看得见」，并且跟宿主一起用电脑时不打架：
// - 操作软件界面的效果（扫描框、系统光标）由 screen.mjs 发；这里管任务统计、看屏幕、步骤条
// - 不抢焦点：干活前记下宿主在用的窗口；干完发现焦点被抢、而宿主正在忙，就把焦点还回去
// - 接管前台：宿主允许后，才用真实鼠标键盘（win32.mjs）
// 发出去的效果事件统一是 { type: 'fx', kind, ... }，坐标是屏幕物理像素（dip: true 时是 DIP），由桌面窗口画出来。
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Type } from '@earendil-works/pi-ai';
import * as win from './win32.mjs';

const SECRET = /密码|口令|password|passcode|pin\b|验证码/i;

// get_app_state 的文字结果 → 窗口标题、窗口位置、每个元素的名字和位置
export function parseAppState(text) {
  const out = { title: '', window: null, elements: new Map() };
  const t = String(text || '');
  out.title = t.match(/Window: "([^"]*)"/)?.[1] || '';
  for (const line of t.split('\n')) {
    const m = line.match(/^\t*(\d+) (.*?) Frame: \{x: (-?\d+), y: (-?\d+), width: (\d+), height: (\d+)\}/);
    if (!m) continue;
    const label = m[2].replace(/\s*Secondary Actions:.*$/, '').trim();
    const [role, ...rest] = label.split(' ');
    const rect = { x: +m[3], y: +m[4], width: +m[5], height: +m[6] };
    out.elements.set(m[1], { role, name: rest.join(' ').trim(), rect });
    if (m[1] === '0') out.window = rect;
  }
  return out;
}

// PNG 的宽高在文件头里
export function pngSize(b64) {
  try {
    const buf = Buffer.from(String(b64).slice(0, 64), 'base64');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}


export class Operator extends EventEmitter {
  constructor({ ownPids = [], log = () => {}, cursor = true } = {}) {
    super();
    this.ownPids = ownPids;
    this.cursor = cursor; // 系统光标：关掉就不发点击动画、也不等光标飞过去
    this.log = log;
    this.lastShot = null; // 最近一张截图：{ rect, width, height, hwnd }，接管前台时坐标按它换算
    this.steps = null;
    this.userInputAt = 0; // 宿主最近一次按键 / 点鼠标（桌面窗口报过来的）
    this.userFg = null;
    this.takeover = null;
    this.pending = new Map(); // 接管请求等宿主回答
    this.seq = 0;
    this.capture = null; // 截图：由大脑入口接上桌面窗口
    this.task = { tools: 0, since: 0 };
  }

  fx(kind, data) {
    this.emit('fx', { type: 'fx', kind, ...data });
  }

  own(h) {
    return !h || this.ownPids.includes(win.pidOf(h));
  }

  // ---- 一次任务 ----
  taskStart() {
    this.task = { tools: 0, since: Date.now() };
    this.userFg = null;
    this.steps = null;
    this.emit('steps', null);
  }

  // 口令跑技能：步骤条先按技能列好，大脑每做完一步再用 task_steps 更新 done
  presetSteps(steps) {
    this.steps = steps.slice(0, 8);
    this.emit('steps', { steps: this.steps, done: 0, failed: false });
  }

  taskEnd() {
    this.fx('scan', { phase: 'off', all: true });
    this.fx('home');
    this.endTakeover('end');
    return { tools: this.task.tools, seconds: Math.round((Date.now() - this.task.since) / 1000) };
  }

  userBusy() {
    return Date.now() - this.userInputAt < 4000;
  }

  // ---- 工具调用前后：数动作、记下宿主在用的窗口；干完看看焦点有没有被抢 ----
  // （操作软件界面时的扫描框、系统光标由 screen.mjs 自己发）
  async beforeTool() {
    this.task.tools++;
    if (!this.takeover) {
      const fg = win.foreground();
      this.userFg = fg && !this.own(fg) ? fg : null;
    }
  }

  afterTool() {
    this.guardFocus();
  }

  // 焦点被新开的窗口抢走、而宿主正在打字或点东西：还给宿主
  guardFocus() {
    if (this.takeover || !this.userFg) return;
    const now = win.foreground();
    if (!now || now === this.userFg || this.own(now) || !win.isWindow(this.userFg) || !this.userBusy()) return;
    const stolen = win.title(now) || '新窗口';
    if (win.giveFocus(this.userFg)) {
      this.log('focus: 把焦点还给宿主，被抢走的是', stolen);
      this.fx('notice', { mode: 'toast', tone: 'info', title: '后台打开', text: `${stolen.slice(0, 24)}，没有打断你` });
    }
  }

  // ---- 网页操作：agent-browser 包装通过这个本机接口报告要点哪里（坐标是 DIP） ----
  startFxServer() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          try {
            const m = JSON.parse(body || '{}');
            if (['click', 'scan', 'type', 'keys'].includes(m.kind)) {
              if (m.kind === 'scan' && m.count != null) this.emit('target', { kind: 'web', name: m.host || '网页', count: m.count });
              this.fx(m.kind, { ...m, dip: true });
            }
          } catch {}
          res.end('{}');
        });
      });
      server.listen(0, '127.0.0.1', () => {
        this.fxUrl = `http://127.0.0.1:${server.address().port}`;
        resolve(this.fxUrl);
      });
      server.unref();
    });
  }

  // ---- 接管前台 ----
  answerTakeover(id, answer) {
    const fn = id == null ? [...this.pending.values()].at(-1) : this.pending.get(id);
    if (fn) fn(answer);
  }

  get takeoverPending() {
    return this.pending.size > 0;
  }

  endTakeover(why) {
    if (!this.takeover) return;
    clearInterval(this.takeover.tick);
    this.takeover = null;
    this.fx('takeover', { phase: why === 'aborted' ? 'aborted' : 'end' });
    this.emit('takeover_state', { active: false, why });
  }

  // 宿主动了鼠标或按了 Esc（桌面窗口报过来的，已经排除了系统自己模拟的输入）
  userTookBack() {
    if (this.takeover) {
      this.log('takeover: 宿主收回了控制权');
      this.endTakeover('aborted');
    }
  }

  // 要接管的窗口：最近读过 / 截过的那个；没有就用宿主最上面的窗口
  #findWindow() {
    if (this.lastShot?.hwnd && win.isWindow(this.lastShot.hwnd)) return this.lastShot.hwnd;
    return win.topWindow(this.ownPids);
  }

  #toScreen(x, y) {
    const s = this.lastShot;
    if (!s) throw new Error('还没有截图：先用 look_screen 或读一次软件界面，坐标按截图上的像素位置给');
    return { x: s.rect.x + (x * s.rect.width) / s.width, y: s.rect.y + (y * s.rect.height) / s.height };
  }

  #requireTakeover() {
    if (!this.takeover) throw new Error('现在没有前台控制权（没申请、已到时间，或者宿主收回了）。需要的话重新用 request_foreground 申请，不要硬做。');
  }

  // 模拟输入前后通知桌面窗口：这段时间的鼠标键盘动作是系统自己的，别当成宿主收回
  #inject(fn) {
    this.emit('injecting', 400);
    fn();
  }

  // ---- 给大脑的工具 ----
  tools() {
    const self = this;
    const ok = (text, extra) => ({ content: [{ type: 'text', text }], details: extra });
    return [
      {
        name: 'task_steps',
        label: '任务步骤',
        description:
          '在系统面板顶部显示任务步骤条。需要 3 步以上的任务，开始时调用一次列出步骤（steps，每步 8 个字以内，3～6 步），之后每做完一步调用一次只更新 done（已完成几步）；失败时 failed=true。一问一答、一步就能做完的事不要用。',
        parameters: Type.Object({
          steps: Type.Optional(Type.Array(Type.String(), { description: '全部步骤，只在第一次或计划变了时给' })),
          done: Type.Integer({ description: '已经完成了几步（0 表示刚开始）' }),
          failed: Type.Optional(Type.Boolean({ description: '当前这一步失败了' })),
        }),
        async execute(_id, p) {
          if (p.steps?.length) self.steps = p.steps.slice(0, 8);
          if (!self.steps) return ok('还没有步骤：第一次调用要给 steps');
          self.emit('steps', { steps: self.steps, done: Math.max(0, Math.min(p.done, self.steps.length)), failed: !!p.failed });
          return ok('已更新');
        },
      },
      {
        name: 'look_screen',
        label: '看屏幕',
        description:
          '截取宿主屏幕给你看。宿主问屏幕上的东西时用（「这个报错怎么回事」「看看我屏幕上这是什么」「这个窗口里写了啥」）。scope=window 只截宿主正在用的窗口（默认）；宿主明确说整个屏幕、全屏时才用 screen。截图会显示一遍扫描特效。',
        parameters: Type.Object({ scope: Type.Optional(Type.Union([Type.Literal('window'), Type.Literal('screen')])) }),
        async execute(_id, p) {
          if (!self.capture) throw new Error('现在没法截图（桌面窗口没连上）');
          const scope = p.scope === 'screen' ? 'screen' : 'window';
          const h = win.topWindow(self.ownPids);
          if (!h && scope === 'window') throw new Error('没找到宿主正在用的窗口，可以改用 scope=screen');
          const rect = scope === 'screen' ? win.monitorOf(h || win.foreground()) : win.rectOf(h);
          const label = scope === 'screen' ? '整个屏幕' : win.title(h) || '当前窗口';
          const shot = await self.capture({ rect, scope, label });
          self.lastShot = { rect, width: shot.width, height: shot.height, hwnd: scope === 'window' ? h : null };
          return {
            content: [
              { type: 'text', text: `${scope === 'screen' ? '整个屏幕' : `窗口「${label}」`}的截图，${shot.width}×${shot.height} 像素（坐标从左上角算）。` },
              { type: 'image', data: shot.data, mimeType: shot.mimeType },
            ],
            details: { scope, label },
          };
        },
      },
      {
        name: 'request_foreground',
        label: '申请接管前台',
        description:
          '向宿主申请暂时使用真实的鼠标和键盘（会占用宿主的电脑，宿主要等你做完）。只在后台操作不起作用时用：工具报「收不到后台的…」、后台 click 点了没反应。说清楚要干什么、大约几秒（最多 30）。宿主同意后在时限内：再做一次刚才那个 click / type_text / press_keys / scroll（会自动走前台），或者用 fg_click / fg_type / fg_key 按截图坐标操作；宿主一动鼠标就会收回。',
        parameters: Type.Object({
          app: Type.String({ description: '要操作的软件' }),
          reason: Type.String({ description: '要干什么，一句话，比如「点导出按钮」' }),
          seconds: Type.Integer({ description: '大约需要几秒，1～30' }),
        }),
        async execute(_id, p) {
          const seconds = Math.max(3, Math.min(30, p.seconds || 10));
          const id = ++self.seq;
          const answer = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), 30_000);
            self.pending.set(id, (a) => {
              clearTimeout(timer);
              resolve(a);
            });
            self.emit('takeover_request', { id, app: p.app, reason: p.reason, seconds });
          });
          self.pending.delete(id);
          self.emit('takeover_closed', { id, answer });
          if (answer === 'later' || answer === 'timeout') return ok('宿主现在没空（选了稍后或没回应）。停在这一步，告诉宿主需要占用前台几秒、等他说可以了再继续。');
          if (answer !== 'allow') return ok('宿主拒绝了。不要占用前台，告诉宿主这一步只能他自己来做。');
          const hwnd = self.#findWindow();
          const rect = hwnd ? win.rectOf(hwnd) : self.lastShot?.rect;
          self.fx('takeover', { phase: 'countdown', rect });
          await new Promise((r) => setTimeout(r, 3000));
          if (hwnd) win.giveFocus(hwnd);
          const until = Date.now() + seconds * 1000;
          self.takeover = { hwnd, until, rect };
          self.emit('takeover_state', { active: true, seconds });
          self.fx('takeover', { phase: 'active', rect, left: seconds });
          self.takeover.tick = setInterval(() => {
            const left = Math.ceil((until - Date.now()) / 1000);
            if (left <= 0) return self.endTakeover('end');
            self.fx('takeover', { phase: 'active', rect, left });
          }, 1000);
          return ok(`宿主允许了，「${p.app}」已经在最前面。${seconds} 秒内：再做一次刚才那个操作（会走前台），或者用 fg_click / fg_type / fg_key（坐标用最近一张截图上的像素位置）；做完就停，宿主一动鼠标会立刻收回。`);
        },
      },
      {
        name: 'fg_click',
        label: '前台点击',
        description: '接管前台期间，用真实鼠标点击。x、y 是最近一张截图（look_screen 或读软件界面得到的）上的像素坐标。',
        parameters: Type.Object({
          x: Type.Number(),
          y: Type.Number(),
          button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right')])),
          double: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, p) {
          self.#requireTakeover();
          const pt = self.#toScreen(p.x, p.y);
          self.fx('click', { rect: { ...pt, width: 0, height: 0 }, point: pt, label: '前台点击', instant: true });
          self.#inject(() => win.click(pt.x, pt.y, { button: p.button || 'left', double: !!p.double }));
          await new Promise((r) => setTimeout(r, 300));
          return ok('已点击');
        },
      },
      {
        name: 'fg_type',
        label: '前台输入',
        description: '接管前台期间，用真实键盘往当前焦点处输入文字（中文也行）。',
        parameters: Type.Object({ text: Type.String() }),
        async execute(_id, p) {
          self.#requireTakeover();
          if (self.takeover.rect) self.fx('type', { rect: self.takeover.rect, text: SECRET.test(p.text) ? '••••' : p.text });
          self.#inject(() => win.typeText(p.text));
          return ok('已输入');
        },
      },
      {
        name: 'fg_key',
        label: '前台按键',
        description: '接管前台期间，按真实的键或组合键，例如 enter、ctrl+s、alt+f4。',
        parameters: Type.Object({ keys: Type.String() }),
        async execute(_id, p) {
          self.#requireTakeover();
          if (self.takeover.rect) self.fx('keys', { rect: self.takeover.rect, keys: p.keys });
          self.#inject(() => win.pressKeys(p.keys));
          return ok('已按下');
        },
      },
    ];
  }
}
