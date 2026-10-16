// 操作软件界面。两个引擎：Cua Driver（主力：快、能读 Electron 应用、打开软件不抢焦点）
// 和 Open Computer Use（备用：Office 这类 Cua 读得少的软件）。对大脑只露出一套工具，引擎由这里自动挑：
// 读界面时先用 Cua，读出来的可操作元素太少就再用 Open Computer Use 读一遍，哪个多用哪个，之后这个窗口都用它操作。
// 两个都读不出按钮时，按截图坐标点（还是后台）；再不行就让大脑申请接管前台。
import path from 'node:path';
import fs from 'node:fs';
import { Type } from '@earendil-works/pi-ai';
import { McpClient } from './mcp-client.mjs';
import * as win from './win32.mjs';
import { parseAppState, pngSize } from './operator.mjs';

const SESSION = 'hostbound';
const CURSOR_FLIGHT_MS = 520;
const BUSY_RETRY_MS = [800, 2000, 4000]; // 按坐标点报 busy 时，隔多久再试
// 点这些按钮之前先让宿主授权（能读出按钮名字时才拦得住）
const DANGER_BUTTON = /删除|发送|发布|付款|支付|购买|下单|提交|转账|卸载|清空|注销|退出登录|格式化|永久|send|delete|publish|pay|purchase|submit|uninstall/i;
const SECRET = /密码|口令|password|passcode|验证码/i;
// 在这些聊天软件里按回车就是发消息，也要授权
const CHAT_APP = /微信|weixin|wechat|qq|钉钉|dingtalk|飞书|feishu|lark|企业微信|wxwork|telegram|discord|slack|whatsapp|teams/i;
// 中文叫法 → 窗口标题或程序名里可能出现的英文
const ALIAS = { 计算器: 'calculator', 记事本: 'notepad', 微信: 'weixin', 设置: 'settings', 资源管理器: 'explorer', 文件资源管理器: 'explorer', 画图: 'paint', 照片: 'photos' };
// 打开软件时，系统自带的应用要用英文名
const LAUNCH_NAME = { 计算器: 'Calculator', 记事本: 'Notepad', 画图: 'Paint', 设置: 'Settings', 照片: 'Photos', 文件资源管理器: 'File Explorer' };
// 常见键名 → Cua 认的键名
const CUA_KEY = { enter: 'return', esc: 'escape', del: 'delete', backspace: 'backspace', pgup: 'pageup', pgdn: 'pagedown', 'page up': 'pageup', 'page down': 'pagedown', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', control: 'ctrl', cmd: 'win', windows: 'win', option: 'alt', 回车: 'return', 空格: 'space' };
const OCU_INTERACTIVE = /^(button|edit|menu ?item|check ?box|combo ?box|list ?item|tab ?item|hyperlink|link|radio ?button|slider|tree ?item|split ?button|按钮|编辑|菜单项|复选框|组合框|列表项|选项卡项|超链接|单选按钮|滑块|树项)$/i;
const short = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

// 「计算器」「剪映」「Notepad」跟窗口有多像：3 完全一样，2 包含，1 程序名在里面，0 不像
function score(w, app) {
  const want = String(app || '').trim().toLowerCase();
  const alt = ALIAS[app] || want;
  const t = w.title.toLowerCase();
  const e = w.exe.toLowerCase().replace(/\.exe$/, '');
  if (t === want || e === want || t === alt || e === alt) return 3;
  if (t.includes(want) || t.includes(alt) || e.includes(alt)) return 2;
  if (want.includes(e) && e.length > 2) return 1;
  return 0;
}
const best = (list, app) => list.map((w) => [score(w, app), w]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0]?.[1];

export class Screen {
  constructor({ root, cfg, log = () => {}, operator, ownPids = [] }) {
    this.root = root;
    this.cfg = cfg.computerUse || {};
    this.all = cfg; // 整份配置：禁止操作的软件在 safety.blockedApps
    this.log = log;
    this.operator = operator;
    this.ownPids = ownPids;
    this.apps = new Map(); // 窗口 id → 读到的界面 { engine, title, exe, pid, wid, elements, snapshot, capture, shot }
    this.clients = {};
    // 窗口位置（测试时换成假的）。rect：看得见的部分；raw：含隐形边框
    this.rectOf = (h) => win.rectOf(h);
    this.rawRectOf = (h) => win.rawRectOf(h);
    this.isWindow = (h) => win.isWindow(h);
    this.ocuNoBetter = new Set(); // Open Computer Use 也读不出更多的窗口
    this.cuaCalls = 0; // 调过 Cua 几次：截图编号只在它是最近一次调用时才算数
  }

  get cuaPath() {
    return path.resolve(this.root, this.cfg.cua || 'tools/cua-driver/cua-driver.exe');
  }

  get ocuPath() {
    return path.resolve(this.root, this.cfg.command || '');
  }

  get available() {
    return fs.existsSync(this.cuaPath) || fs.existsSync(this.ocuPath);
  }

  async #client(name) {
    if (this.clients[name]) return this.clients[name];
    const exe = name === 'cua' ? this.cuaPath : this.ocuPath;
    if (!fs.existsSync(exe)) return null;
    const c = await new McpClient(exe, ['mcp']).init();
    if (name === 'cua') {
      const call = c.call.bind(c);
      c.call = (...a) => (this.cuaCalls++, call(...a));
      // Cua 自带一个 AI 光标；系统光标由我们自己画，把它关掉
      await c.call('start_session', { session: SESSION }).catch(() => {});
      await c.call('set_agent_cursor_enabled', { session: SESSION, enabled: false }).catch(() => {});
    }
    this.clients[name] = c;
    return c;
  }

  close() {
    for (const c of Object.values(this.clients)) c.close();
    this.clients = {};
  }

  // ---- 窗口 ----
  async windows() {
    const cua = await this.#client('cua');
    if (!cua) return [];
    const r = await cua.call('list_windows', {});
    return r.text
      .split('\n')
      // 程序名里可能有空格（Qoder CN.exe）
      .map((l) => l.match(/^- (.+?) \(pid (\d+)\) "(.*)" \[window_id: (\d+)\]/))
      .filter(Boolean)
      .map((m) => ({ exe: m[1], pid: +m[2], title: m[3], wid: +m[4] }))
      .filter((w) => w.title && !this.ownPids.includes(w.pid) && !/^(explorer|TextInputHost|cua-driver|AsMonitorControl|AsHotplugCtrl)\.exe$/i.test(w.exe));
  }

  // 宿主在安全中心里禁止系统碰的软件
  blocked(w) {
    const names = (this.all?.safety?.blockedApps || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    const hay = `${w.title || ''} ${w.exe || ''} ${w.name || ''}`.toLowerCase();
    return names.find((n) => hay.includes(n) || (ALIAS[n] ? hay.includes(ALIAS[n]) : false)) || null;
  }

  #refuse(w) {
    const b = this.blocked(w);
    if (b) throw new Error(`宿主在安全中心里禁止系统操作「${b}」，这个软件不能读也不能点。告诉宿主这一步要他自己来。`);
  }

  // 「计算器」「剪映」「Notepad」→ 具体哪个窗口
  async resolve(app) {
    this.#refuse({ name: app });
    const list = await this.windows();
    const hit = best(list, app);
    if (hit) this.#refuse(hit);
    if (!hit) throw new Error(`没找到「${app}」的窗口。开着的有：${list.map((w) => w.title).slice(0, 12).join('、') || '（没有）'}。没开的话先用 open_app 打开。`);
    return hit;
  }

  // ---- 读界面 ----
  async read(app, { query } = {}) {
    const w = await this.resolve(app);
    const bounds = this.rectOf(w.wid);
    this.operator?.fx('scan', { key: String(w.wid), rect: bounds, phase: 'scanning', label: `扫描中 · ${short(w.title, 20)}`, sub: 'UIA' });
    let state = null;
    const cua = await this.#client('cua');
    if (cua) state = await this.#readCua(cua, w, query).catch((e) => (this.log('screen: Cua 读不了', e.message), null));
    // Cua 读出的可操作元素太少：再用 Open Computer Use 读一遍，哪个多用哪个
    // 这个窗口上次 Open Computer Use 也没读出更多（自己画界面的软件，比如剪映），就不再白等它（约 0.7 秒）
    if ((!state || state.count < 8) && !this.ocuNoBetter.has(w.wid)) {
      const ocu = await this.#client('ocu');
      const alt = ocu ? await this.#readOcu(ocu, w).catch((e) => (this.log('screen: OCU 读不了', e.message), null)) : null;
      if (alt && (!state || alt.count > Math.max(8, state.count * 1.5))) state = alt;
      else if (state) this.ocuNoBetter.add(w.wid);
    }
    if (!state) throw new Error(`读不了「${w.title}」的界面`);
    this.apps.set(w.wid, state);
    if (state.shot && this.operator) this.operator.lastShot = { rect: state.shotRect, width: state.shot.width, height: state.shot.height, hwnd: w.wid };
    this.operator?.fx('scan', { key: String(w.wid), rect: bounds, phase: 'locked', label: `已锁定 · ${short(w.title, 20)}`, sub: `${state.count} 元素`, delay: 700 });
    this.operator?.emit('target', { kind: 'app', name: w.title, count: state.count, elements: [...state.elements.values()].map((e) => e.name).filter(Boolean).slice(0, 40) });
    const head =
      `窗口「${w.title}」（${w.exe}，引擎：${state.engine === 'cua' ? 'Cua Driver' : 'Open Computer Use'}）：${state.count} 个可操作元素，` +
      (state.count ? '前面的 [编号] 就是 element。' : '读不出按钮（自己画的界面），看截图按坐标 x、y 点。') +
      (state.truncated ? '界面太大没读完，可以用 query 只看包含某个词的元素。' : '');
    const content = [{ type: 'text', text: `${head}\n\n${state.tree}` }];
    if (state.image) content.push(state.image);
    return { content, details: { engine: state.engine, count: state.count } };
  }

  async #readCua(cua, w, query) {
    const args = { pid: w.pid, window_id: w.wid, full_output: true, max_elements: 400, max_image_dimension: 1600, session: SESSION };
    if (query) args.query = query;
    const r = await cua.call('get_window_state', args, 60_000);
    if (r.isError) throw new Error(r.text.slice(0, 120));
    const st = r.structured || {};
    const elements = new Map();
    for (const e of st.elements || []) {
      if (!e.element_token) continue;
      const f = e.frame || {};
      elements.set(String(e.element_index), { ref: e.element_token, role: e.role, name: e.label || '', actions: e.actions || [], rect: { x: f.x, y: f.y, width: f.w, height: f.h } });
    }
    const img = (r.raw.content || []).find((c) => c.type === 'image');
    const wb = st.window_bounds || this.rectOf(w.wid);
    return {
      engine: 'cua',
      ...w,
      tree: st.tree_markdown || r.text,
      count: elements.size,
      elements,
      truncated: !!st.truncated,
      capture: st.capture_id,
      capturedAt: this.cuaCalls,
      image: img,
      shot: st.screenshot_width ? { width: st.screenshot_width, height: st.screenshot_height } : null,
      shotRect: { x: wb.x, y: wb.y, width: wb.width, height: wb.height },
    };
  }

  async #readOcu(ocu, w) {
    // Open Computer Use 按软件名认：用 pid 在它的列表里找名字
    const list = await ocu.call('list_apps', {});
    const name = list.text.split('\n').map((l) => l.match(/^(.+?) -- .*pid=(\d+)/)).find((m) => m && +m[2] === w.pid)?.[1]?.trim();
    if (!name) throw new Error('Open Computer Use 的列表里没有这个软件');
    const r = await ocu.call('get_app_state', { app: name }, 90_000);
    if (r.isError) throw new Error(r.text.slice(0, 120));
    const st = parseAppState(r.text);
    // 它的坐标是相对窗口左上角（含隐形边框）的，换成屏幕坐标
    const raw = this.rawRectOf(w.wid);
    const elements = new Map();
    for (const [i, e] of st.elements) {
      if (i === '0') continue;
      elements.set(i, { ref: i, role: e.role, name: e.name, rect: { ...e.rect, x: raw.x + e.rect.x, y: raw.y + e.rect.y }, interactive: OCU_INTERACTIVE.test(e.role) });
    }
    const img = r.images[0];
    const size = img ? pngSize(img.data) : null;
    return {
      engine: 'ocu',
      ...w,
      ocuName: name,
      tree: r.text,
      count: [...elements.values()].filter((e) => e.interactive).length,
      elements,
      image: img,
      shot: size,
      shotRect: raw,
    };
  }

  // 操作前：这个窗口读过没有（没读过先读一遍）、要操作的元素是哪个
  // 读过的窗口直接用，不再去列窗口：多调一次 Cua，刚才那张截图的编号就不是最新的了
  async #target(app, element) {
    const known = best([...this.apps.values()].filter((s) => this.isWindow(s.wid)), app);
    if (known) this.#refuse(known);
    const w = known || (await this.resolve(app));
    let st = this.apps.get(w.wid);
    if (!st) {
      await this.read(app);
      st = this.apps.get(w.wid);
    }
    const el = element != null ? st.elements.get(String(element)) : null;
    if (element != null && !el) throw new Error(`「${w.title}」里没有编号 ${element} 的元素（界面可能变了），先 read_app 重新读一遍`);
    return { w, st, el };
  }

  // Cua 的动作统一走这里。平时一律后台（绝不切前台）；有的软件收不到后台输入（Chromium / Electron 的网页内容、
  // 一些老 Win32 软件的快捷键），Cua 会直接报 background_unavailable，这时让大脑先申请接管前台，
  // 宿主同意后（operator.takeover 还在）同样的动作改走前台：Cua 短暂切到那个窗口、做完再切回来。
  async #cua(name, args, what) {
    const cua = await this.#client('cua');
    const fg = !!this.operator?.takeover;
    if (fg) this.operator.emit('injecting', 2000); // 这段时间的键鼠是 Cua 模拟的，别当成宿主收回控制权
    const r = await cua.call(name, { ...args, session: SESSION, delivery_mode: fg ? 'foreground' : 'background' });
    if (r.isError && /background_unavailable|Background delivery is not available/i.test(r.text)) {
      const tip = what === '打字' ? '有输入框编号的话给 element 直接填值；不然' : '';
      throw new Error(`这个软件收不到后台的${what}。${tip}用 request_foreground 申请接管前台，宿主同意后再做一次同样的操作。`);
    }
    return r;
  }

  async #fly(el, point, label) {
    if (!this.operator?.cursor) return;
    this.operator.fx('click', { rect: el?.rect || { ...point, width: 0, height: 0 }, point, label });
    await new Promise((r) => setTimeout(r, CURSOR_FLIGHT_MS));
  }

  // 重截一张拿新的截图编号（只截图、不读元素，快）。窗口大小变了的话，大脑手里那张截图的坐标就对不上了，让它重新读
  async #recapture(w, st) {
    const cua = await this.#client('cua');
    const r = await cua.call('get_window_state', { pid: w.pid, window_id: w.wid, max_image_dimension: 1600, session: SESSION }, 60_000);
    const s = r.structured || {};
    if (r.isError || !s.capture_id) throw new Error(`「${w.title}」截不了图：${short(r.text, 100)}`);
    if (st.shot && (s.screenshot_width !== st.shot.width || s.screenshot_height !== st.shot.height)) {
      this.apps.delete(w.wid);
      throw new Error(`「${w.title}」的窗口大小变了，截图坐标对不上了。先 read_app 重新读一遍，按新截图的坐标点`);
    }
    st.capture = s.capture_id;
    st.capturedAt = this.cuaCalls;
    if (s.window_bounds) st.shotRect = { x: s.window_bounds.x, y: s.window_bounds.y, width: s.window_bounds.width, height: s.window_bounds.height };
  }

  // 截图坐标 → 屏幕坐标（画系统光标用）
  #toScreen(st, x, y) {
    const sx = st.shot ? st.shotRect.width / st.shot.width : 1;
    const sy = st.shot ? st.shotRect.height / st.shot.height : 1;
    return { x: st.shotRect.x + x * sx, y: st.shotRect.y + y * sy };
  }

  // ---- 就地讲解、手把手教学用（guide.mjs） ----
  // 一个元素（或截图坐标）在屏幕上的位置。读过的窗口不重读；est：按截图坐标估的位置（读不出按钮的软件），框画成虚线
  async locate(app, { element, x, y } = {}) {
    const { w, st, el } = await this.#target(app, element);
    if (el) return { w, rect: el.rect, name: el.name || el.role || '', est: false };
    if (x == null || y == null) throw new Error('要么给 element（编号），要么给截图上的坐标 x、y');
    const p = this.#toScreen(st, x, y);
    const k = st.shot ? st.shotRect.width / st.shot.width : 1;
    const size = Math.round(48 * k);
    return { w, rect: { x: Math.round(p.x - size / 2), y: Math.round(p.y - size / 2), width: size, height: size }, name: '', est: true };
  }

  titleOf(wid) {
    return [...this.apps.values()].find((s) => s.wid === wid)?.title || '';
  }

  // 悄悄读一遍窗口（不放扫描特效、不报给面板、不换掉大脑手里的编号），拿界面的「指纹」：教学时看宿主点完界面变没变。
  // image：这个窗口的截图（PNG base64），教学小结用
  async fingerprint(app) {
    const known = best([...this.apps.values()].filter((s) => this.isWindow(s.wid)), app);
    const w = known || (await this.resolve(app));
    this.#refuse(w);
    const prev = this.apps.get(w.wid);
    let st = null;
    if (prev?.engine !== 'ocu') {
      const cua = await this.#client('cua');
      if (cua) st = await this.#readCua(cua, w).catch(() => null);
    }
    if (!st) {
      const ocu = await this.#client('ocu');
      if (ocu) st = await this.#readOcu(ocu, w).catch(() => null);
    }
    if (!st) return null;
    const names = [...st.elements.values()].map((e) => `${e.role}:${e.name}`).sort().join('|');
    const image = st.image?.data || null;
    // 读不出按钮的界面：拿截图大小粗略比一比
    const sig = st.count ? `${st.count}#${names}` : `img#${image ? image.length : 0}`;
    return { sig, count: st.count, image };
  }

  async click(app, { element, x, y, double = false, right = false }) {
    const { w, st, el } = await this.#target(app, element);
    if (!el && (x == null || y == null)) throw new Error('要么给 element（编号），要么给截图上的坐标 x、y');
    const point = el ? center(el.rect) : this.#toScreen(st, x, y);
    await this.#fly(el, point, `${double ? '双击' : right ? '右键' : '点击'} · ${short(el?.name || '这里', 16)}`);
    let r;
    if (st.engine === 'cua') {
      const args = { pid: w.pid, window_id: w.wid, ...(double ? { count: 2 } : {}), ...(right ? { button: 'right' } : {}) };
      if (el) {
        args.element_token = el.ref;
        r = await this.#cua('click', args, '点击');
      } else {
        // 按截图坐标点：截图编号要是最近一次调用拿到的，旧了就先悄悄重截一张。
        // 自己画界面的软件（剪映）偶尔报「busy」：界面接口忙，Cua 说明了没发出任何输入，等一会儿换张新截图再试
        if (!st.capture || st.capturedAt !== this.cuaCalls) await this.#recapture(w, st);
        r = await this.#cua('click', { ...args, x, y, capture_id: st.capture }, '点击');
        for (const ms of BUSY_RETRY_MS) {
          if (!(r.isError && /busy/i.test(r.text))) break;
          await new Promise((ok) => setTimeout(ok, ms));
          await this.#recapture(w, st);
          r = await this.#cua('click', { ...args, x, y, capture_id: st.capture }, '点击');
        }
        st.capture = null; // 截图编号用一次就作废
        if (r.isError && /busy/i.test(r.text)) {
          throw new Error(`「${w.title}」的界面接口一直在忙，后台点不进去（这次什么都没点）。过几秒再试；还不行就用 request_foreground 申请接管前台再点`);
        }
      }
    } else {
      const ocu = await this.#client('ocu');
      r = await ocu.call('click', { app: st.ocuName, ...(el ? { element_index: el.ref } : { x, y }), ...(double ? { click_count: 2 } : {}), ...(right ? { mouse_button: 'right' } : {}) });
    }
    if (r.isError) throw new Error(short(r.text, 200));
    return `已点击「${el?.name || `(${x}, ${y})`}」。界面可能变了，需要的话 read_app 再看一眼结果。`;
  }

  async type(app, { text, element }) {
    const { w, st, el } = await this.#target(app, element);
    const secret = SECRET.test(el?.name || '');
    if (el) await this.#fly(el, center(el.rect), `填写 · ${short(el.name, 16)}`);
    this.operator?.fx('type', { rect: el?.rect || this.rectOf(w.wid), text: secret ? '••••' : text });
    let r;
    if (st.engine === 'cua') {
      r = el?.actions.includes('set_value')
        ? await this.#cua('set_value', { pid: w.pid, window_id: w.wid, element_token: el.ref, value: text }, '输入')
        : await this.#cua('type_text', { pid: w.pid, window_id: w.wid, text, ...(el ? { element_token: el.ref } : {}) }, '打字');
    } else {
      const ocu = await this.#client('ocu');
      r = el ? await ocu.call('set_value', { app: st.ocuName, element_index: el.ref, value: text }) : await ocu.call('type_text', { app: st.ocuName, text });
    }
    if (r.isError) throw new Error(short(r.text, 200));
    return el ? `已在「${el.name || element}」里填好` : '已输入';
  }

  async keys(app, { keys }) {
    const { w, st } = await this.#target(app);
    this.operator?.fx('keys', { rect: this.rectOf(w.wid), keys });
    const parts = String(keys).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean).map((k) => CUA_KEY[k] || k);
    let r;
    if (st.engine === 'cua') {
      r = parts.length > 1
        ? await this.#cua('hotkey', { pid: w.pid, window_id: w.wid, keys: parts }, '快捷键')
        : await this.#cua('press_key', { pid: w.pid, window_id: w.wid, key: parts[0] }, '按键');
    } else {
      const ocu = await this.#client('ocu');
      r = await ocu.call('press_key', { app: st.ocuName, key: keys });
    }
    if (r.isError) throw new Error(short(r.text, 200));
    return `已按 ${keys}`;
  }

  async scroll(app, { direction, element, amount }) {
    const { w, st, el } = await this.#target(app, element);
    let r;
    if (st.engine === 'cua') {
      r = await this.#cua('scroll', { pid: w.pid, window_id: w.wid, direction, amount: amount || 3, ...(el ? { element_token: el.ref } : {}) }, '滚动');
    } else {
      const ocu = await this.#client('ocu');
      const target = el?.ref || [...st.elements.keys()][0];
      r = await ocu.call('scroll', { app: st.ocuName, element_index: target, direction, pages: Math.max(1, Math.round((amount || 3) / 3)) });
    }
    if (r.isError) throw new Error(short(r.text, 200));
    return '已滚动';
  }

  async open(name) {
    this.#refuse({ name });
    const cua = await this.#client('cua');
    if (!cua) throw new Error('打开软件要用 Cua Driver，它没装；改用 powershell 的 Start-Process');
    const r = await cua.call('launch_app', { name: LAUNCH_NAME[name] || name, session: SESSION }, 60_000);
    if (r.isError) throw new Error(`打不开「${name}」：${short(r.text, 160)}。可以改用 powershell 的 Start-Process`);
    const ws = r.structured?.windows || [];
    this.operator?.fx('notice', { mode: 'toast', tone: 'info', title: '后台打开', text: `${short(name, 20)}，没有打断你` });
    return ws.length
      ? `已在后台打开「${name}」（没抢宿主的焦点），窗口：${ws.map((x) => x.title).filter(Boolean).join('、')}。接着用 read_app 读界面。`
      : `已经启动「${name}」，窗口还没出来；等一两秒再 list_apps 看看。`;
  }

  // ---- 面板里怎么写这个动作、要不要授权 ----
  #known(args) {
    for (const st of this.apps.values()) {
      const t = String(args.app || '').toLowerCase();
      if (st.title.toLowerCase().includes(t) || st.exe.toLowerCase().includes(ALIAS[args.app] || t)) {
        return { st, el: args.element != null ? st.elements.get(String(args.element)) : null };
      }
    }
    return {};
  }

  describe(name, args = {}) {
    const { st, el } = this.#known(args);
    const where = st ? `${short(st.title, 12)}：` : args.app ? `${short(args.app, 12)}：` : '';
    switch (name) {
      case 'list_apps':
        return '看看开着哪些软件';
      case 'open_app':
        return `后台打开：${short(args.name, 20)}`;
      case 'read_app':
        return `${where}读界面${args.query ? `（找「${short(args.query, 10)}」）` : ''}`;
      case 'click':
        return `${where}${args.double ? '双击' : '点击'}${el ? `「${short(el.name || el.role, 16)}」` : args.element != null ? ` ${args.element} 号` : ` (${args.x}, ${args.y})`}`;
      case 'type_text':
        return `${where}输入：${SECRET.test(el?.name || '') ? '••••' : short(args.text, 30)}`;
      case 'press_keys':
        return `${where}按 ${short(args.keys, 20)}`;
      case 'scroll':
        return `${where}往${{ up: '上', down: '下', left: '左', right: '右' }[args.direction] || ''}滚动`;
      default:
        return null;
    }
  }

  // 点「发送」「删除」「付款」这类按钮、在聊天软件里按回车之前要宿主授权
  risk(event) {
    const args = event.input || {};
    if (event.toolName === 'press_keys' && /enter|return/i.test(args.keys || '')) {
      const { st } = this.#known(args);
      const where = st ? `${st.title} ${st.exe}` : String(args.app || '');
      if (CHAT_APP.test(where)) return { label: `在「${short(st?.title || args.app, 16)}」按 ${args.keys}（会把消息发出去）`, detail: `${st?.title || args.app} · 按 ${args.keys}` };
      return null;
    }
    if (event.toolName !== 'click' && event.toolName !== 'type_text') return null;
    const { st, el } = this.#known(args);
    if (!el || !DANGER_BUTTON.test(el.name || '')) return null;
    return { label: `在「${short(st.title, 16)}」点击「${short(el.name, 16)}」`, detail: `${st.title} · ${el.role || ''}「${el.name}」` };
  }

  // ---- 给大脑的工具 ----
  tools() {
    const self = this;
    const text = (t, details) => ({ content: [{ type: 'text', text: t }], details });
    return [
      {
        name: 'list_apps',
        label: '开着的软件',
        description: '列出宿主电脑上开着的软件窗口（窗口标题和程序名）。操作软件前用它确认窗口名字。',
        parameters: Type.Object({}),
        async execute() {
          const ws = (await self.windows()).filter((w) => !self.blocked(w));
          return text(ws.length ? ws.map((w) => `- ${w.title}（${w.exe}）`).join('\n') : '（没有开着的窗口）');
        },
      },
      {
        name: 'open_app',
        label: '打开软件',
        description: '在后台打开一个软件，不抢宿主的焦点（宿主正在打字也不会被打断）。name 用软件名，比如 计算器、记事本、剪映专业版、OBS Studio、Word。打开网页用 agent-browser，不用这个。',
        parameters: Type.Object({ name: Type.String() }),
        async execute(_id, p) {
          return text(await self.open(p.name));
        },
      },
      {
        name: 'read_app',
        label: '读软件界面',
        description:
          '读取一个软件窗口的界面：按钮、输入框、文字；能操作的元素前面有 [编号]，同时附一张截图。操作前先读，界面变了（点完、翻页后）要重新读。query：只看名字里包含这个词的元素（界面很大时用）。',
        parameters: Type.Object({ app: Type.String({ description: '窗口标题或程序名，见 list_apps' }), query: Type.Optional(Type.String()) }),
        async execute(_id, p) {
          return self.read(p.app, { query: p.query });
        },
      },
      {
        name: 'click',
        label: '点击',
        description: '在后台点击软件里的元素，不动宿主的鼠标。element 用 read_app 里的编号；读不出按钮的界面用 x、y（最近一次 read_app 截图上的像素坐标）。',
        parameters: Type.Object({
          app: Type.String(),
          element: Type.Optional(Type.Integer()),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          double: Type.Optional(Type.Boolean()),
          right: Type.Optional(Type.Boolean({ description: '右键' })),
        }),
        async execute(_id, p) {
          return text(await self.click(p.app, p));
        },
      },
      {
        name: 'type_text',
        label: '输入',
        description: '在后台往软件里输入文字（中文也行），不抢宿主的键盘。给 element 时直接填进那个输入框（会替换原来的内容）；不给就输入到当前焦点处。',
        parameters: Type.Object({ app: Type.String(), text: Type.String(), element: Type.Optional(Type.Integer()) }),
        async execute(_id, p) {
          return text(await self.type(p.app, p));
        },
      },
      {
        name: 'press_keys',
        label: '按键',
        description: '在后台给软件按键或组合键，例如 enter、tab、escape、ctrl+s、ctrl+a。',
        parameters: Type.Object({ app: Type.String(), keys: Type.String() }),
        async execute(_id, p) {
          return text(await self.keys(p.app, p));
        },
      },
      {
        name: 'scroll',
        label: '滚动',
        description: '在后台滚动软件里的列表或页面。direction：up / down / left / right；element：要滚动的区域编号（不给就滚当前焦点区域）。',
        parameters: Type.Object({
          app: Type.String(),
          direction: Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')]),
          element: Type.Optional(Type.Integer()),
          amount: Type.Optional(Type.Integer({ description: '滚几格，默认 3' })),
        }),
        async execute(_id, p) {
          return text(await self.scroll(p.app, p));
        },
      },
    ];
  }
}
