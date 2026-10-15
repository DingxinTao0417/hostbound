// 向量检索（阶段 5）：用硅基流动的 BAAI/bge-m3 把文字变成向量（DeepSeek 没有这个接口），
// 搜的时候「关键词」和「意思」各排一次名，再合起来（RRF），OpenClaw、MemOS 也是这样混合的。
// 向量只存在本地 data/memory/.index，同一段文字只算一次；几千条直接算余弦，不用另装向量数据库。
// 断网、没配密钥、额度用完：自动退回只用关键词。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hashOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// ---------- 调硅基流动（OpenAI 一样的 /embeddings 接口） ----------
export class Embedder {
  // key()：拿密钥（设置里粘的、或者环境变量），这里不存、不打印
  constructor({ baseUrl = 'https://api.siliconflow.cn/v1', model = 'BAAI/bge-m3', key = () => null, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/+$/, ''), model, key, fetchImpl, log });
    this.status = { ok: null, reason: '' }; // null：还没试过
    this.pausedUntil = 0;
  }

  get available() {
    return !!this.key() && Date.now() >= this.pausedUntil;
  }

  // 一次最多 32 段，每段截到 2000 字
  async embed(texts) {
    const key = this.key();
    if (!key) {
      this.status = { ok: false, reason: '没配硅基流动的密钥' };
      throw new Error(this.status.reason);
    }
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32).map((t) => String(t).slice(0, 2000) || ' ');
      let r;
      try {
        r = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: this.model, input: batch, encoding_format: 'float' }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        this.#fail(`连不上硅基流动：${e.message}`, 60_000);
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        const why = r.status === 401 || r.status === 403 ? '密钥不对或者没有权限' : r.status === 402 ? '账户余额不足' : r.status === 429 ? '请求太频繁，稍后再试' : `出错了（${r.status}）`;
        this.#fail(`硅基流动：${why}${body ? ` · ${body.slice(0, 120)}` : ''}`, r.status === 429 ? 30_000 : r.status >= 500 ? 60_000 : 10 * 60_000);
      }
      const j = await r.json();
      const data = [...(j.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length) this.#fail('硅基流动返回的向量数量不对', 60_000);
      for (const d of data) out.push(normalize(Float32Array.from(d.embedding)));
    }
    this.status = { ok: true, reason: '' };
    return out;
  }

  #fail(reason, pauseMs) {
    this.status = { ok: false, reason };
    this.pausedUntil = Date.now() + pauseMs;
    throw new Error(reason);
  }
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const dot = (a, b) => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
};

// ---------- 本地向量缓存：一行一个（文字的指纹 → 向量） ----------
export class VectorCache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const { h, v } = JSON.parse(line);
          const buf = Buffer.from(v, 'base64');
          this.map.set(h, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        } catch {}
      }
    } catch {}
  }
  get(text) {
    return this.map.get(hashOf(text)) || null;
  }
  has(text) {
    return this.map.has(hashOf(text));
  }
  put(text, vec) {
    const h = hashOf(text);
    if (this.map.has(h)) return;
    this.map.set(h, vec);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ h, v: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64') }) + '\n');
  }
  get size() {
    return this.map.size;
  }
}

// ---------- 关键词：英文按词、中文按单字和两字一组 ----------
export function tokens(s) {
  const t = String(s || '').toLowerCase();
  const out = [];
  for (const w of t.match(/[a-z0-9_.:\\/-]{2,}/g) || []) out.push(w);
  const cjk = t.match(/[㐀-鿿]+/g) || [];
  for (const run of cjk) {
    for (const ch of run) out.push(ch);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}
// 简化的 BM25：词在越少的条目里出现越值钱
export function keywordRank(query, items) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const docs = items.map((it) => new Set(tokens(it.text)));
  const N = docs.length || 1;
  const idf = Object.fromEntries(q.map((w) => [w, Math.log(1 + (N - docs.filter((d) => d.has(w)).length + 0.5) / (docs.filter((d) => d.has(w)).length + 0.5))]));
  // 两字一组的词更值钱（「导出」比「导」「出」更说明问题）
  const weight = (w) => (/[㐀-鿿]/.test(w) ? (w.length >= 2 ? 1.6 : 0.4) : 1.2);
  return items
    .map((it, i) => ({ it, s: q.reduce((sum, w) => sum + (docs[i].has(w) ? idf[w] * weight(w) : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
}

// ---------- 混合检索：关键词名次 + 意思名次，RRF 合起来 ----------
// items：[{ text, ... }]；vecs：跟 items 一一对应的向量（没有的为 null）；qvec：问题的向量（没有就只用关键词）
export function hybridRank(query, items, vecs, qvec, { limit = 8, minCos = 0.35 } = {}) {
  const K = 60;
  const score = new Map();
  keywordRank(query, items).forEach((x, rank) => score.set(x.it, { kw: x.s, cos: null, rrf: 1 / (K + rank) }));
  if (qvec) {
    const sims = items.map((it, i) => ({ it, cos: vecs[i] ? dot(qvec, vecs[i]) : -1 })).filter((x) => x.cos >= minCos).sort((a, b) => b.cos - a.cos);
    sims.forEach((x, rank) => {
      const cur = score.get(x.it) || { kw: 0, cos: null, rrf: 0 };
      cur.cos = x.cos;
      cur.rrf += 1 / (K + rank);
      score.set(x.it, cur);
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf)
    .slice(0, limit)
    .map(([it, s]) => ({ ...it, score: +s.rrf.toFixed(4), kw: +s.kw.toFixed(2), cos: s.cos == null ? null : +s.cos.toFixed(3) }));
}

// ---------- 记忆和对话的检索：缓存向量、后台补算 ----------
export class Recall {
  constructor({ dir, embedder, log = () => {} }) {
    Object.assign(this, { embedder, log });
    this.memCache = new VectorCache(path.join(dir, '.index', 'memory.jsonl'));
    this.chatCache = new VectorCache(path.join(dir, '.index', 'chat.jsonl'));
    this.indexing = null;
    this.progress = { done: 0, total: 0 };
  }

  // 问题的向量（拿不到就 null，只用关键词）
  async #qvec(query) {
    if (!this.embedder.available) return null;
    try {
      return (await this.embedder.embed([query]))[0];
    } catch (e) {
      this.log('recall: 向量暂时用不了', e.message);
      return null;
    }
  }

  // 给还没向量的补上（一次最多 batch 条），失败就算了，下次再补
  async #fill(cache, texts, batch = 64) {
    if (!this.embedder.available) return 0;
    const todo = [...new Set(texts.filter((t) => t && !cache.has(t)))].slice(0, batch);
    if (!todo.length) return 0;
    try {
      const vs = await this.embedder.embed(todo);
      todo.forEach((t, i) => cache.put(t, vs[i]));
      return todo.length;
    } catch (e) {
      this.log('recall: 算向量没成功', e.message);
      return 0;
    }
  }

  // 搜记忆：entries 是 memory.all()
  async searchMemory(query, entries, limit = 8) {
    await this.#fill(this.memCache, entries.map((e) => e.text), 200);
    const qvec = await this.#qvec(query);
    return hybridRank(query, entries, entries.map((e) => this.memCache.get(e.text)), qvec, { limit });
  }

  // 搜以前的对话：messages 是 store.allMessages()（不含分隔）
  async searchChat(query, messages, limit = 8) {
    const items = messages.filter((m) => m.role !== 'divider');
    const qvec = await this.#qvec(query);
    const hits = hybridRank(query, items, items.map((m) => this.chatCache.get(m.text)), qvec, { limit: limit * 2 });
    // 宿主问的那句和系统回的那句都搜到了：合成一条
    const out = [];
    for (const h of hits) {
      const i = items.indexOf(items.find((m) => m.at === h.at && m.text === h.text));
      if (h.role === 'assistant' && items[i - 1]?.role === 'user' && out.some((o) => o.at === items[i - 1].at)) continue;
      const reply = h.role === 'user' && items[i + 1]?.role === 'assistant' ? items[i + 1].text.slice(0, 160) : '';
      out.push({ at: h.at, role: h.role, snippet: h.text.length > 200 ? h.text.slice(0, 200) + '…' : h.text, reply, score: h.score });
      if (out.length >= limit) break;
    }
    return out;
  }

  // 后台给以前的对话建索引：一批 32 条，批与批之间歇一下，别把接口打满
  indexChat(messages) {
    if (this.indexing) return this.indexing;
    const texts = [...new Set(messages.filter((m) => m.role !== 'divider').map((m) => m.text))];
    const todo = texts.filter((t) => !this.chatCache.has(t));
    this.progress = { done: texts.length - todo.length, total: texts.length };
    if (!todo.length || !this.embedder.available) return Promise.resolve(0);
    this.indexing = (async () => {
      let n = 0;
      for (let i = 0; i < todo.length; i += 32) {
        if (!this.embedder.available) break;
        const got = await this.#fill(this.chatCache, todo.slice(i, i + 32), 32);
        if (!got) break;
        n += got;
        this.progress.done += got;
        await new Promise((r) => setTimeout(r, 300));
      }
      return n;
    })().finally(() => (this.indexing = null));
    return this.indexing;
  }

  status() {
    return {
      ok: this.embedder.status.ok,
      reason: this.embedder.status.reason,
      configured: !!this.embedder.key(),
      memory: this.memCache.size,
      chat: this.progress,
    };
  }
}
