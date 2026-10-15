// 系统任务（阶段 4）：定时任务 + 监测。全是程序自己判断，不调模型（只有「到点帮我做…」的任务，到点后交给大脑去做）。
// - 定时任务：一次（at）、每隔多久（every）、按规则重复（cron，用 croner 算下次时间）。结构参考 HKUDS/nanobot 的 cron。
// - 监测：下载完成、电量低、在直播（OBS 推流 / 直播软件开着），以及宿主让盯着的文件夹、文件、程序。参考 OpenClaw 的条件监测。
// 任务和宿主让盯着的东西存在 data/tasks.json，关机重启后照旧；关机期间错过的提醒，开机后补一次。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Type } from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const { Cron } = require('croner');

const MIN = 60_000;
const STABLE_SECONDS = 5; // 文件大小连续这么多秒不变，才算写完了
// 下载工具、浏览器写到一半的临时文件
const TEMP_FILE = /\.(crdownload|part|partial|tmp|temp|download|downloading|opdownload|xltd|td|!ut|bc!|aria2|baiduyun\.downloading|dtmp)$/i;
const IGNORED_NAME = /^(~\$|\.)|^desktop\.ini$|^thumbs\.db$/i;

// ---------- 时间：宿主那边的钟点 ↔ 时间戳（cfg.timezone 留空就跟电脑走） ----------
function tzOffset(epoch, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(epoch))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}
function wallToEpoch(y, mo, d, h, mi, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t = guess - tzOffset(guess, tz);
  return guess - tzOffset(t, tz);
}
function wallNow(now, tz) {
  if (!tz) {
    const d = new Date(now);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() };
  }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day };
}

// 「2026-10-16 09:00」「10-16 9:00」「23:00」「明天 9:00」→ 时间戳（已经过了的钟点算明天）
export function parseAt(text, now = Date.now(), tz = '') {
  let s = String(text || '').trim().replace(/[：]/g, ':').replace(/T/, ' ').replace(/\s+/g, ' ');
  let addDays = 0;
  if (/^明天/.test(s)) (addDays = 1), (s = s.replace(/^明天\s*/, ''));
  else if (/^后天/.test(s)) (addDays = 2), (s = s.replace(/^后天\s*/, ''));
  else if (/^今天/.test(s)) s = s.replace(/^今天\s*/, '');
  s = s.replace(/(\d{1,2})点半/, '$1:30').replace(/(\d{1,2})点(\d{1,2})分?/, '$1:$2').replace(/(\d{1,2})点$/, '$1:00');
  const today = wallNow(now, tz);
  let m;
  if ((m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2}):(\d{2})/))) return wallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  if ((m = s.match(/^(\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2}):(\d{2})$/))) {
    let t = wallToEpoch(today.y, +m[1], +m[2], +m[3], +m[4], tz);
    if (t < now - MIN) t = wallToEpoch(today.y + 1, +m[1], +m[2], +m[3], +m[4], tz);
    return t;
  }
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + addDays));
    let t = wallToEpoch(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), +m[1], +m[2], tz);
    if (!addDays && t < now - 30_000) {
      const nd = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
      t = wallToEpoch(nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), +m[1], +m[2], tz);
    }
    return t;
  }
  throw new Error(`时间「${text}」看不懂，用「2026-10-16 09:00」或「23:00」这种写法`);
}

// 下次什么时候到点
export function nextRun(sched, from, tz = '') {
  if (sched.kind === 'at') return sched.at;
  if (sched.kind === 'every') {
    const anchor = sched.anchor ?? from;
    const n = Math.max(1, Math.ceil((from - anchor + 1) / sched.everyMs));
    return anchor + n * sched.everyMs;
  }
  if (sched.kind === 'cron') {
    const next = new Cron(sched.expr, { timezone: tz || undefined, paused: true }).nextRun(new Date(from));
    return next ? next.getTime() : null;
  }
  return null;
}

// 给人看的「什么时候」
export function describeSchedule(s, tz = '') {
  const fmt = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  if (s.kind === 'at') return `${fmt(s.at)} · 一次`;
  if (s.kind === 'every') return `每 ${s.everyMs >= 3600_000 && s.everyMs % 3600_000 === 0 ? `${s.everyMs / 3600_000} 小时` : `${Math.round(s.everyMs / MIN)} 分钟`}`;
  if (s.kind === 'cron') {
    const m = s.expr.trim().split(/\s+/);
    const hm = /^\d+$/.test(m[0]) && /^\d+$/.test(m[1]) ? `${m[1].padStart(2, '0')}:${m[0].padStart(2, '0')}` : null;
    if (hm && m[2] === '*' && m[3] === '*' && m[4] === '*') return `每天 ${hm}`;
    if (hm && m[2] === '*' && m[3] === '*' && /^[0-6](,[0-6])*$/.test(m[4])) return `每周${m[4].split(',').map((d) => '日一二三四五六'[+d]).join('、')} ${hm}`;
    if (hm && m[2] === '*' && m[3] === '*' && m[4] === '1-5') return `工作日 ${hm}`;
    return `按规则：${s.expr}`;
  }
  return '';
}

const globRe = (pattern) => (pattern ? new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i') : null);
export const isTempFile = (p) => TEMP_FILE.test(p) || IGNORED_NAME.test(path.basename(p));
export function fmtSize(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ---------- 盯一个文件夹：新文件出现、不是临时文件、大小连续几秒不变 → 算写完了 ----------
export class FolderWatch {
  constructor({ dir, pattern, recursive = false, since = Date.now(), file = null, onReady, onError = () => {}, stableSeconds = STABLE_SECONDS }) {
    Object.assign(this, { dir, recursive, since, file: file ? path.resolve(file).toLowerCase() : null, onReady, onError, stableSeconds });
    this.re = globRe(pattern);
    this.cand = new Map(); // 路径 → { size, stable }
    this.done = new Map(); // 路径 → 报告的时间（同一个文件 30 秒内不重复报）
  }

  start() {
    try {
      this.w = fs.watch(this.dir, { recursive: this.recursive }, (_ev, name) => name && this.touch(path.join(this.dir, String(name))));
      this.w.on('error', (e) => this.onError(e));
    } catch (e) {
      this.onError(e);
      return this;
    }
    this.timer = setInterval(() => this.poll(), 1000);
    this.timer.unref?.();
    // 系统没开着的时候写完的：开起来扫一遍（只看创建监测以后改过的）
    try {
      for (const n of fs.readdirSync(this.dir)) this.touch(path.join(this.dir, n));
    } catch {}
    return this;
  }

  stop() {
    this.w?.close();
    clearInterval(this.timer);
  }

  touch(p) {
    if (isTempFile(p)) return;
    if (this.file && path.resolve(p).toLowerCase() !== this.file) return;
    if (this.re && !this.re.test(path.basename(p))) return;
    const doneAt = this.done.get(p);
    if (doneAt && Date.now() - doneAt < 30_000) return;
    if (!this.cand.has(p)) this.cand.set(p, { size: -1, stable: 0 });
  }

  poll() {
    for (const [p, c] of this.cand) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        this.cand.delete(p); // 没了（临时文件改名、被删）
        continue;
      }
      if (st.isDirectory() || st.mtimeMs < this.since - 2000) {
        this.cand.delete(p);
        continue;
      }
      if (st.size > 0 && st.size === c.size) c.stable++;
      else (c.stable = 0), (c.size = st.size);
      if (c.stable >= this.stableSeconds) {
        this.cand.delete(p);
        this.done.set(p, Date.now());
        this.onReady({ path: p, name: path.basename(p), size: st.size });
      }
    }
  }
}

// ---------- 系统任务 ----------
export class Tasks extends EventEmitter {
  // win：{ processNames, powerStatus }（测试时换成假的）；now：取当前时间（测试时能拨快）
  constructor({ file, cfg, log = () => {}, win = null, now = () => Date.now(), obsLogDir = null, intervals = {}, stableSeconds = STABLE_SECONDS }) {
    super();
    Object.assign(this, { file, cfg, log, win, now, stableSeconds });
    // 多久看一次（毫秒）；测试时调短
    this.iv = { batteryFirst: 10_000, battery: 60_000, liveFirst: 1500, live: 5000, process: 3000, ...intervals };
    this.obsLogDir = obsLogDir ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'obs-studio', 'logs') : null);
    this.data = { version: 1, tasks: [], watches: [], fired: [] };
    this.watchers = new Map(); // 监测 id → 正在跑的 FolderWatch / 程序监测
    this.builtin = {}; // 自带的监测
    this.state = { live: false, liveSource: null, power: null };
    this.seq = 0;
  }

  get tz() {
    return this.cfg.timezone || '';
  }

  // ---- 存盘 ----
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && Array.isArray(d.tasks)) this.data = { version: 1, tasks: d.tasks, watches: d.watches || [], fired: d.fired || [] };
    } catch {}
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log('tasks: 存不了盘', e.message);
    }
    this.emit('changed', this.snapshot());
  }

  start() {
    this.load();
    const now = this.now();
    // 关机期间错过的：一次的补一次；重复的补最近一次，再往后排
    for (const t of [...this.data.tasks]) {
      if (t.nextAt != null && t.nextAt <= now) this.#fire(t, now - t.nextAt);
      else if (t.nextAt == null) t.nextAt = nextRun(t.schedule, now, this.tz);
    }
    for (const w of this.data.watches) this.#startWatch(w);
    this.applyConfig();
    this.save();
    this.#arm();
    return this;
  }

  stop() {
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    for (const k of Object.keys(this.builtin)) this.#stopBuiltin(k);
  }

  // 到点的闹钟：最多睡 30 秒就醒一次（电脑休眠、改了系统时间也不会漏）
  #arm() {
    clearTimeout(this.timer);
    const next = Math.min(...this.data.tasks.map((t) => t.nextAt ?? Infinity));
    if (!isFinite(next)) return;
    this.timer = setTimeout(() => this.tick(), Math.max(0, Math.min(next - this.now(), 30_000)));
    this.timer.unref?.();
  }

  tick() {
    const now = this.now();
    let changed = false;
    for (const t of [...this.data.tasks]) {
      if (t.nextAt != null && t.nextAt <= now + 250) {
        this.#fire(t, Math.max(0, now - t.nextAt));
        changed = true;
      }
    }
    if (changed) this.save();
    this.#arm();
  }

  #fire(t, late = 0) {
    const now = this.now();
    t.lastAt = now;
    t.runs = (t.runs || 0) + 1;
    if (t.schedule.kind === 'at') this.data.tasks = this.data.tasks.filter((x) => x !== t);
    else t.nextAt = nextRun(t.schedule, now, this.tz);
    this.#remember({ at: now, kind: t.do ? 'do' : 'remind', name: t.name, late: late > MIN ? late : 0 });
    this.emit('fire', { task: { ...t }, late: late > MIN ? late : 0 });
  }

  #remember(e) {
    this.data.fired.unshift(e);
    this.data.fired.length = Math.min(this.data.fired.length, 30);
  }

  // ---- 定时任务 ----
  // when：{ in_minutes } | { at } | { every_minutes } | { cron }
  create({ name, say, do: todo, ...when }) {
    name = String(name || '').trim().slice(0, 30);
    if (!name) throw new Error('任务要有个名字（10 个字以内，比如「补充水分」）');
    const now = this.now();
    const keys = ['in_minutes', 'at', 'every_minutes', 'cron'].filter((k) => when[k] != null && when[k] !== '');
    if (keys.length !== 1) throw new Error('时间要给且只给一种：in_minutes（多久以后）、at（几点）、every_minutes（每隔多久）、cron（按规则重复）');
    let schedule;
    if (keys[0] === 'in_minutes') {
      const m = Number(when.in_minutes);
      if (!(m > 0)) throw new Error('in_minutes 要大于 0');
      schedule = { kind: 'at', at: now + Math.round(m * MIN) };
    } else if (keys[0] === 'at') {
      const at = parseAt(when.at, now, this.tz);
      if (at < now - 30_000) throw new Error(`「${when.at}」已经过去了`);
      schedule = { kind: 'at', at };
    } else if (keys[0] === 'every_minutes') {
      const m = Number(when.every_minutes);
      if (!(m >= 1)) throw new Error('every_minutes 最少 1 分钟');
      schedule = { kind: 'every', everyMs: Math.round(m * MIN), anchor: now };
    } else {
      const expr = String(when.cron).trim();
      if (expr.split(/\s+/).length !== 5) throw new Error('cron 用 5 段：分 时 日 月 周，比如每天 23 点是「0 23 * * *」');
      try {
        new Cron(expr, { paused: true });
      } catch (e) {
        throw new Error(`cron「${expr}」写错了：${e.message}`);
      }
      schedule = { kind: 'cron', expr };
    }
    const t = {
      id: `t${now.toString(36)}${(++this.seq).toString(36)}`,
      name,
      say: String(say || '').trim() || null,
      do: String(todo || '').trim() || null,
      schedule,
      createdAt: now,
      nextAt: nextRun(schedule, now, this.tz),
    };
    if (t.nextAt == null) throw new Error('这个规则以后不会再到点了');
    this.data.tasks.push(t);
    this.save();
    this.#arm();
    this.emit('created', { task: { ...t } });
    return t;
  }

  // 「过十分钟再提醒」
  snooze(task, minutes = 10) {
    return this.create({ name: task.name, say: task.say, in_minutes: minutes });
  }

  cancel(idOrName) {
    const key = String(idOrName || '').trim();
    if (!key) return [];
    const hit = (x) => x.id === key || x.name === key || (key.length >= 2 && x.name.includes(key));
    const gone = [...this.data.tasks.filter(hit), ...this.data.watches.filter(hit)];
    if (!gone.length) return [];
    this.data.tasks = this.data.tasks.filter((x) => !gone.includes(x));
    this.data.watches = this.data.watches.filter((x) => !gone.includes(x));
    for (const w of gone) {
      this.watchers.get(w.id)?.stop();
      this.watchers.delete(w.id);
    }
    this.save();
    this.#arm();
    return gone;
  }

  // ---- 宿主让盯着的：文件夹来新文件、某个文件生成完、某个程序退出 ----
  watch({ name, kind, path: p, pattern, process: proc, keep = false, say, recursive = false }) {
    name = String(name || '').trim().slice(0, 30);
    if (!name) throw new Error('监测要有个名字，比如「剪映导出完成」');
    const now = this.now();
    const w = { id: `w${now.toString(36)}${(++this.seq).toString(36)}`, name, kind, keep: !!keep, say: String(say || '').trim() || null, createdAt: now };
    if (kind === 'folder' || kind === 'file') {
      const full = path.resolve(String(p || ''));
      if (!p) throw new Error('要给 path（完整路径）');
      if (kind === 'folder' && !(fs.existsSync(full) && fs.statSync(full).isDirectory())) throw new Error(`文件夹不存在：${full}`);
      if (kind === 'file' && !fs.existsSync(path.dirname(full))) throw new Error(`文件所在的文件夹不存在：${path.dirname(full)}`);
      Object.assign(w, { path: full, pattern: pattern || null, recursive: !!recursive });
    } else if (kind === 'process') {
      const exe = String(proc || '').trim().toLowerCase().replace(/^(.*[\\/])/, '');
      if (!exe) throw new Error('要给 process（程序名，比如 ffmpeg.exe）');
      const full = exe.endsWith('.exe') ? exe : exe + '.exe';
      if (this.win && !this.win.processNames().has(full)) throw new Error(`「${full}」现在没在运行，没法等它退出。先用 powershell 的 Get-Process 看看程序名对不对`);
      w.process = full;
    } else throw new Error('kind 只能是 folder（文件夹来新文件）、file（某个文件生成完）、process（某个程序退出）');
    this.data.watches.push(w);
    this.#startWatch(w);
    this.save();
    return w;
  }

  #startWatch(w) {
    const fire = (text, meta) => {
      this.#remember({ at: this.now(), kind: 'watch', name: w.name, text });
      this.emit('report', { kind: 'watch', title: w.name, text, meta, say: w.say || `宿主，${w.name}。`, watchId: w.id });
      if (!w.keep) this.cancel(w.id);
      else this.save();
    };
    if (w.kind === 'folder' || w.kind === 'file') {
      const dir = w.kind === 'folder' ? w.path : path.dirname(w.path);
      const fw = new FolderWatch({
        dir,
        pattern: w.kind === 'folder' ? w.pattern : null,
        file: w.kind === 'file' ? w.path : null,
        recursive: w.recursive,
        since: w.createdAt,
        stableSeconds: this.stableSeconds,
        onReady: (f) => fire(f.name, `${fmtSize(f.size)} · ${f.path}`),
        onError: (e) => this.log('tasks: 盯不了文件夹', dir, e.message),
      }).start();
      this.watchers.set(w.id, fw);
    } else if (w.kind === 'process') {
      let missing = 0;
      const timer = setInterval(() => {
        if (!this.win) return;
        missing = this.win.processNames().has(w.process) ? 0 : missing + 1;
        if (missing >= 2) {
          clearInterval(timer);
          fire(`${w.process} 已经退出`, '程序结束了');
        }
      }, this.iv.process);
      timer.unref?.();
      this.watchers.set(w.id, { stop: () => clearInterval(timer) });
    }
  }

  // ---- 自带的监测：下载完成、电量低、在直播。设置里能开关 ----
  applyConfig() {
    const c = this.cfg.watch || {};
    this.#toggle('downloads', c.downloads !== false, () => {
      const dir = c.downloadsDir || path.join(os.homedir(), 'Downloads');
      return new FolderWatch({
        dir,
        since: this.now(),
        stableSeconds: this.stableSeconds,
        onReady: (f) => {
          this.#remember({ at: this.now(), kind: 'download', name: '下载完成', text: f.name });
          this.emit('report', { kind: 'download', title: '下载完成', text: f.name, meta: `${fmtSize(f.size)} · 下载文件夹`, say: null, path: f.path });
          this.save();
        },
        onError: (e) => this.log('tasks: 盯不了下载文件夹', dir, e.message),
      }).start();
    });
    this.#toggle('battery', c.battery !== false && !!this.win, () => {
      const reported = new Set();
      const check = () => {
        const p = this.win.powerStatus();
        this.state.power = p;
        if (!p?.battery || p.percent == null) return;
        if (p.ac !== false || p.percent > 25) return reported.clear(); // 插上电了：下次没电再报
        const level = [10, 20].find((x) => p.percent <= x && !reported.has(x));
        if (level == null) return;
        reported.add(level);
        if (level === 10) reported.add(20);
        const left = p.secondsLeft ? `，还能用大约 ${Math.max(1, Math.round(p.secondsLeft / 60))} 分钟` : '';
        this.#remember({ at: this.now(), kind: 'battery', name: '电量低', text: `${p.percent}%` });
        this.emit('report', { kind: 'battery', title: '电量低', text: `剩余 ${p.percent}%，没插电`, meta: `低于 ${level}%${left}`, say: `宿主，电量低于百分之${level === 10 ? '十' : '二十'}，请连接电源。`, level });
        this.save();
      };
      const first = setTimeout(check, this.iv.batteryFirst);
      const timer = setInterval(check, this.iv.battery);
      timer.unref?.();
      first.unref?.();
      return { stop: () => (clearInterval(timer), clearTimeout(first)) };
    });
    this.#toggle('live', c.live !== false && !!this.win, () => {
      const obs = { file: null, offset: 0, live: false };
      const check = () => this.#checkLive(obs);
      const timer = setInterval(check, this.iv.live);
      timer.unref?.();
      setTimeout(check, this.iv.liveFirst).unref?.();
      return { stop: () => clearInterval(timer) };
    });
  }

  restart(key) {
    this.#stopBuiltin(key);
    this.applyConfig();
  }

  #toggle(key, on, make) {
    if (on && !this.builtin[key]) this.builtin[key] = make();
    else if (!on && this.builtin[key]) this.#stopBuiltin(key);
  }
  #stopBuiltin(key) {
    this.builtin[key]?.stop();
    delete this.builtin[key];
    if (key === 'live' && this.state.live) this.#setLive(false, null);
  }

  // 在直播：直播软件开着（直播姬、直播伴侣……），或者 OBS 日志里最后一条是「开始推流」
  #checkLive(obs) {
    const procs = this.win.processNames();
    const apps = (this.cfg.watch?.liveApps || []).map((x) => String(x).toLowerCase());
    const app = apps.find((a) => procs.has(a));
    let obsLive = false;
    if (procs.has('obs64.exe') || procs.has('obs32.exe') || procs.has('obs.exe')) obsLive = this.#obsStreaming(obs);
    else obs.live = false;
    const on = !!app || obsLive;
    if (on !== this.state.live) this.#setLive(on, app ? app.replace(/\.exe$/, '') : obsLive ? 'OBS 推流' : null);
  }

  #obsStreaming(obs) {
    if (!this.obsLogDir) return false;
    try {
      const newest = fs
        .readdirSync(this.obsLogDir)
        .filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f: path.join(this.obsLogDir, f), t: fs.statSync(path.join(this.obsLogDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0]?.f;
      if (!newest) return false;
      if (newest !== obs.file) Object.assign(obs, { file: newest, offset: 0, live: false });
      const size = fs.statSync(newest).size;
      if (size > obs.offset) {
        const fd = fs.openSync(newest, 'r');
        const buf = Buffer.alloc(size - obs.offset);
        fs.readSync(fd, buf, 0, buf.length, obs.offset);
        fs.closeSync(fd);
        obs.offset = size;
        for (const line of buf.toString('utf8').split('\n')) {
          if (line.includes('==== Streaming Start')) obs.live = true;
          else if (line.includes('==== Streaming Stop')) obs.live = false;
        }
      }
      return obs.live;
    } catch {
      return false;
    }
  }

  #setLive(on, source) {
    this.state.live = on;
    this.state.liveSource = source;
    this.emit('live', { on, source });
  }

  // ---- 给面板看的 ----
  snapshot() {
    return {
      tasks: this.data.tasks
        .map((t) => ({ id: t.id, name: t.name, say: t.say, do: t.do, kind: t.schedule.kind, when: describeSchedule(t.schedule, this.tz), nextAt: t.nextAt }))
        .sort((a, b) => a.nextAt - b.nextAt),
      watches: this.data.watches.map((w) => ({ id: w.id, name: w.name, kind: w.kind, keep: w.keep, what: w.kind === 'process' ? `等 ${w.process} 退出` : w.kind === 'file' ? `等 ${w.path} 生成完` : `${w.path} 里出现${w.pattern ? ` ${w.pattern} ` : '新'}文件、写完` })),
      fired: this.data.fired.slice(0, 15),
      builtin: { downloads: !!this.builtin.downloads, battery: !!this.builtin.battery, live: !!this.builtin.live },
      live: this.state.live,
      liveSource: this.state.liveSource,
      power: this.state.power,
    };
  }

  // ---- 给大脑的工具 ----
  tools() {
    const self = this;
    const ok = (text, details) => ({ content: [{ type: 'text', text }], details });
    const list = () => {
      const s = self.snapshot();
      const lines = [];
      for (const t of s.tasks) lines.push(`- [${t.id}] ${t.name}：${t.when}${t.do ? `（到点去做：${t.do}）` : ''}`);
      for (const w of s.watches) lines.push(`- [${w.id}] ${w.name}：${w.what}${w.keep ? '（一直盯着）' : '（报告一次就撤）'}`);
      return lines.length ? lines.join('\n') : '（现在没有定时任务和监测）';
    };
    return [
      {
        name: 'task_create',
        label: '建定时任务',
        description:
          '建一个定时任务（宿主说「半小时后提醒我喝水」「每天 23 点提醒我睡觉」「明早 9 点提醒我交稿」时用，不要用 Start-Sleep 或 Windows 计划任务）。到点系统会叮一声、弹通知、念出来，不花钱。' +
          '时间四选一：in_minutes（多久以后，分钟，可以带小数）；at（宿主那边的钟点，「2026-10-16 09:00」或「23:00」）；every_minutes（每隔多久）；cron（5 段：分 时 日 月 周，比如每天 23 点「0 23 * * *」、每周一 10 点「0 10 * * 1」）。' +
          '宿主明确说「到点帮我做…」时才给 do（到点让系统去做这件事，会用模型）；只是提醒就别给 do。',
        parameters: Type.Object({
          name: Type.String({ description: '任务名，10 个字以内，比如「补充水分」' }),
          say: Type.Optional(Type.String({ description: '到点时念的一句话，比如「宿主，该补充水分了。」' })),
          do: Type.Optional(Type.String({ description: '到点让系统去做的事，一句完整的指令' })),
          in_minutes: Type.Optional(Type.Number()),
          at: Type.Optional(Type.String()),
          every_minutes: Type.Optional(Type.Number()),
          cron: Type.Optional(Type.String()),
        }),
        async execute(_id, p) {
          const t = self.create(p);
          return ok(`已发布：${t.name}，${describeSchedule(t.schedule, self.tz)}${t.do ? '，到点系统去做' : ''}。（id ${t.id}）`, { id: t.id });
        },
      },
      {
        name: 'watch_create',
        label: '建监测',
        description:
          '让系统盯着一件事，发生了就报告宿主（宿主说「等这个视频导出完叫我」「下载完告诉我」「等渲染结束叫我」时用），不花钱。' +
          'kind：folder（文件夹里出现新文件并写完，可以给 pattern 比如 *.mp4）；file（某个文件生成完）；process（某个程序退出，给 process 程序名）。' +
          '不知道软件把文件导出到哪：先用 read / powershell 找软件的设置或最近的文件，确实找不到再问宿主。默认报告一次就撤，keep=true 一直盯着。',
        parameters: Type.Object({
          name: Type.String({ description: '监测名，比如「剪映导出完成」' }),
          kind: Type.Union([Type.Literal('folder'), Type.Literal('file'), Type.Literal('process')]),
          path: Type.Optional(Type.String({ description: '文件夹或文件的完整路径' })),
          pattern: Type.Optional(Type.String({ description: '只看这类文件，比如 *.mp4' })),
          process: Type.Optional(Type.String({ description: '程序名，比如 ffmpeg.exe' })),
          keep: Type.Optional(Type.Boolean()),
          say: Type.Optional(Type.String({ description: '发生时念的一句话' })),
        }),
        async execute(_id, p) {
          const w = self.watch(p);
          return ok(`已开始盯着：${w.name}。（id ${w.id}）`, { id: w.id });
        },
      },
      {
        name: 'task_list',
        label: '看任务',
        description: '列出现在所有的定时任务和监测（带 id）。',
        parameters: Type.Object({}),
        async execute() {
          return ok(list());
        },
      },
      {
        name: 'task_cancel',
        label: '取消任务',
        description: '取消定时任务或监测。给 id（task_list 里的），或者任务名里的词（比如「喝水」）。',
        parameters: Type.Object({ id: Type.String({ description: 'id 或者任务名里的词' }) }),
        async execute(_id, p) {
          const gone = self.cancel(p.id);
          return ok(gone.length ? `已取消：${gone.map((x) => x.name).join('、')}` : `没找到「${p.id}」。现在的有：\n${list()}`);
        },
      },
    ];
  }
}
