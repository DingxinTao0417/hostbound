// 个人数据都在 data 文件夹（开源时不上传）：
// - sessions\      对话存盘（pi 自带的格式）。一直是同一段对话，宿主说「换个话题」才另开一个文件，面板上看还是一个窗口
// - history.jsonl  任务记录：每条指令、过程、结果、用时
// - logs\日期.jsonl 系统日志：系统做过的每个操作，一天一个文件，过期自动删
import fs from 'node:fs';
import path from 'node:path';

export const LOG_TYPES = { mem: '记忆', skill: '技能', task: '任务', cmd: '命令', app: '软件', web: '网页', file: '文件', auth: '授权', screen: '看屏幕', voice: '语音', err: '出错', sys: '系统' };

const pad = (n) => String(n).padStart(2, '0');
export function dayOf(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {} // 写到一半断电的那一行：跳过
  }
  return out;
}

const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : '';
// 发给大脑的每句话前面都带着「（现在是 …）」，可能还有「（宿主刚才在面板上：…）」和口令跑技能附上的 <skill> 块，显示时去掉
const STAMP = /^（现在是[^）]*）\n/;
const NOTES = /^(（宿主刚才在面板上：[^）]*）\n)+/;
const SKILL_BLOCK = /^<skill name="[^"]*" location="[^"]*">\n[\s\S]*?\n<\/skill>\n\n/;
// 带图的那句话，pi 会在后面补一行「[Image: …]」「[Image omitted: …]」：也去掉
const IMAGE_HINTS = /(\s*\[Image[^\]\n]*\])+\s*$/;
export const cleanUser = (text) => String(text || '').replace(STAMP, '').replace(NOTES, '').replace(SKILL_BLOCK, '').replace(IMAGE_HINTS, '');
const TAG = /^\s*\[([a-z-]+)\]\s*/i;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.sessionsDir = path.join(dir, 'sessions');
    this.logDir = path.join(dir, 'logs');
    this.historyFile = path.join(dir, 'history.jsonl');
    for (const d of [this.dir, this.sessionsDir, this.logDir]) fs.mkdirSync(d, { recursive: true });
    this.cache = new Map(); // 对话文件 → { size, mtime, items }
    this.listeners = new Set();
  }

  // ---- 系统日志 ----
  log(type, text, detail = '', extra = {}) {
    const e = { at: Date.now(), type, text: String(text ?? ''), ...(detail ? { detail: String(detail).slice(0, 4000) } : {}), ...extra };
    try {
      fs.appendFileSync(path.join(this.logDir, `${dayOf(e.at)}.jsonl`), JSON.stringify(e) + '\n');
    } catch {}
    for (const fn of this.listeners) fn(e);
    return e;
  }

  onLog(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  logDays() {
    try {
      return fs.readdirSync(this.logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
    } catch {
      return [];
    }
  }

  readLog(day = dayOf(), { type, q, limit = 800 } = {}) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return readJsonl(path.join(this.logDir, `${day}.jsonl`))
      .filter((e) => !type || type === 'all' || e.type === type)
      .filter((e) => words.every((w) => `${e.text} ${e.detail || ''}`.toLowerCase().includes(w)))
      .reverse()
      .slice(0, limit);
  }

  // 只留最近 keepDays 天的日志
  prune(keepDays = 30) {
    const cut = dayOf(Date.now() - keepDays * 86400_000);
    let n = 0;
    for (const day of this.logDays()) {
      if (day >= cut) continue;
      try {
        fs.unlinkSync(path.join(this.logDir, `${day}.jsonl`));
        n++;
      } catch {}
    }
    return n;
  }

  // ---- 任务记录 ----
  addTask(rec) {
    fs.appendFileSync(this.historyFile, JSON.stringify(rec) + '\n');
    return rec;
  }

  tasks({ q, result, before, limit = 80 } = {}) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = readJsonl(this.historyFile).reverse();
    const hit = all.filter(
      (t) =>
        (!before || t.at < before) &&
        (!result || result === 'all' || t.result === result) &&
        words.every((w) => `${t.text} ${t.answer || ''}`.toLowerCase().includes(w)),
    );
    return { items: hit.slice(0, limit), more: hit.length > limit };
  }

  // ---- 对话 ----
  sessionFiles() {
    try {
      return fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(this.sessionsDir, f));
    } catch {
      return [];
    }
  }

  latestSession() {
    return this.sessionFiles().at(-1) || null;
  }

  // 一个存盘文件里给宿主看的话：宿主说的、系统回的（只调工具没说话的轮次不算）
  #messagesOf(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return [];
    }
    const hit = this.cache.get(file);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.items;
    const items = [];
    for (const e of readJsonl(file)) {
      if (e.type !== 'message') continue;
      const m = e.message || {};
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const at = Date.parse(e.timestamp) || m.timestamp || 0;
      let text = textOf(m.content);
      if (m.role === 'user') text = cleanUser(text);
      else {
        const tag = text.match(TAG)?.[1]?.toLowerCase();
        if (tag === 'ignore') {
          // 被当成闲聊忽略的那句：两边都不显示
          if (items.at(-1)?.role === 'user') items.pop();
          continue;
        }
        text = text.replace(TAG, '');
      }
      text = text.trim();
      if (!text) continue;
      // 同一轮里系统分几次说的话（中间夹着调工具）：合成一条
      const last = items.at(-1);
      if (m.role === 'assistant' && last?.role === 'assistant' && at - last.at < 10 * 60_000) {
        last.text += '\n' + text;
        continue;
      }
      items.push({ role: m.role, text, at });
    }
    this.cache.set(file, { size: st.size, mtime: st.mtimeMs, items });
    return items;
  }

  // 所有对话连成一条，按时间从早到晚；换话题的地方插一条分隔
  allMessages() {
    const out = [];
    this.sessionFiles().forEach((f, i) => {
      const items = this.#messagesOf(f);
      if (i > 0 && items.length && out.length) out.push({ role: 'divider', text: '换了个话题', at: items[0].at - 1 });
      out.push(...items);
    });
    return out;
  }

  // 面板往上翻：before 之前的 limit 条
  chat({ before, limit = 40 } = {}) {
    const all = this.allMessages();
    const upto = before ? all.filter((m) => m.at < before) : all;
    return { items: upto.slice(-limit), more: upto.length > limit };
  }

  // 大脑翻以前的对话：每个词都要出现；新的在前
  searchChat(query, limit = 8) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const all = this.allMessages().filter((m) => m.role !== 'divider');
    const hits = [];
    for (let i = all.length - 1; i >= 0 && hits.length < limit; i--) {
      const m = all[i];
      const low = m.text.toLowerCase();
      const match = (x) => words.every((w) => x.text.toLowerCase().includes(w));
      if (!match(m)) continue;
      // 宿主那一问也搜到了：合成一条（问 + 答），别重复
      if (m.role === 'assistant' && all[i - 1]?.role === 'user' && match(all[i - 1])) continue;
      const pos = Math.max(0, low.indexOf(words[0]) - 40);
      const snippet = (pos ? '…' : '') + m.text.slice(pos, pos + 160) + (m.text.length > pos + 160 ? '…' : '');
      // 宿主问的，顺带系统当时怎么回的
      const reply = m.role === 'user' && all[i + 1]?.role === 'assistant' ? all[i + 1].text.slice(0, 160) : '';
      hits.push({ at: m.at, role: m.role, snippet, reply });
    }
    return hits;
  }
}
