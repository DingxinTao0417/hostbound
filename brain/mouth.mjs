// 系统的嘴：管声音引擎（显卡上的 Qwen3-TTS / CPU 上的 ZipVoice），把要说的话变成声音，按顺序发给面板播放。
// 模式：gpu（显卡，音质好、出声快）/ cpu（不占显卡，稍慢）/ off（不说话）。gpu 起不来时自动退回 cpu。
// 发给面板的消息：
//   voice_seg  {msg, seg, start, end, speak}  回复里的一段文字念不念（面板据此让文字跟着声音出现）
//   voice      {id, msg?, seg?, sr, pcm, end} 一句话的音频块（16 位 PCM，base64），end 表示这句结束
//   voice_stop {}                              停止播放、清空
//   speech_state {mode, engine, gpu, cpu}       引擎状态
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SpeechSplitter, splitForSpeech } from './speakable.mjs';

const EXIT_REASON = { 3: '显存不足', 4: 'Qwen3-TTS 正被别的程序占用', 5: '还没选定系统音色', 6: '没装显卡版声音（见 README）' };
const GPU_RETRY_MS = 60_000;

class Engine extends EventEmitter {
  constructor(name, spec, log) {
    super();
    this.name = name;
    this.spec = spec;
    this.log = log;
    this.state = 'off'; // off | starting | ready | down
    this.reason = '';
    this.base = spec.url || `http://127.0.0.1:${spec.port}`;
  }

  #set(state, reason = '') {
    this.state = state;
    this.reason = reason;
    this.emit('state');
  }

  async health() {
    try {
      const r = await fetch(this.base + '/health', { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async start() {
    if (this.state === 'starting' || this.state === 'ready') return;
    this.#set('starting');
    // 已经有一个在跑（自己配的 url，或者上次没退干净的）：直接用
    if (!(await this.health()) && !this.spec.url) {
      const logFile = fs.createWriteStream(this.spec.logFile, { flags: 'a' });
      const proc = spawn(this.spec.command, this.spec.args, {
        cwd: this.spec.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(this.spec.env || {}) },
      });
      this.proc = proc;
      proc.stdout.pipe(logFile);
      proc.stderr.pipe(logFile);
      proc.on('error', (e) => {
        this.log(`voice ${this.name}: 起不来`, e.message);
        if (this.proc === proc) this.#set('down', e.message);
      });
      proc.on('exit', (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        const reason = EXIT_REASON[code] || `退出码 ${code}`;
        this.log(`voice ${this.name}: 已退出（${reason}）`);
        this.#set('down', reason);
      });
    }
    const deadline = Date.now() + (this.spec.startTimeoutMs || 120_000);
    while (this.state === 'starting' && Date.now() < deadline) {
      const h = await this.health();
      if (h?.ready) {
        this.sampleRate = h.sampleRate;
        this.log(`voice ${this.name}: ready（${h.voice}）`);
        return this.#set('ready');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.state === 'starting') {
      this.stop();
      this.#set('down', '启动超时');
    }
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
    if (this.state !== 'down') this.#set('off');
  }

  // 一边生成一边产出 16 位 PCM（偶数字节）
  async *synth(text, id, signal) {
    const res = await fetch(this.base + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, id }),
      signal,
    });
    if (!res.ok) throw new Error(`${this.name} tts ${res.status}`);
    const sr = Number(res.headers.get('x-sample-rate')) || 24000;
    let rest = null;
    for await (const part of res.body) {
      let buf = Buffer.from(part);
      if (rest) buf = Buffer.concat([rest, buf]);
      const even = buf.length & ~1;
      rest = even < buf.length ? buf.subarray(even) : null;
      if (even) yield { sr, pcm: buf.subarray(0, even) };
    }
  }

  cancel(id) {
    fetch(this.base + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {});
  }
}

// 固定的话：第一次用显卡生成后存起来，以后直接播
export const FIXED_LINES = [
  '请宿主授权。',
  '任务已中止。',
  '系统进入待机。',
  '收到，系统待机。',
  '系统自检通过，进入待机。',
  '详情见面板。',
  '任务失败。',
  '模型服务器繁忙，请稍后再试。',
  '无法连接模型服务器，请检查网络。',
];

function wavBuffer(pcm, sr) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export class Mouth extends EventEmitter {
  constructor({ root, cfg, log, out }) {
    super();
    this.root = root;
    this.cfg = cfg.speech;
    this.log = log;
    this.out = out;
    this.mode = 'off';
    this.queue = [];
    this.gen = 0; // 每次 stop() 加一，正在生成的旧句子作废
    this.seq = 0;
    this.msg = null;
    this.current = null;
    // 个人数据（选定的音色、常用句缓存）放在 data 目录；测试时用环境变量换到临时目录
    this.dataDir = process.env.HOSTBOUND_DATA_DIR || path.join(root, 'data');
    // 系统音色：自己设计过的在 data/voice/system，没有就用仓库自带的 voice/default
    let voice = {};
    for (const dir of [path.join(this.dataDir, 'voice', 'system'), path.join(root, 'voice', 'default')]) {
      try {
        voice = JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8'));
        break;
      } catch {}
    }
    this.voiceId = voice.id || 'none';
    const logDir = path.join(root, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const g = this.cfg.gpu;
    const c = this.cfg.cpu;
    this.engines = {
      gpu: new Engine('gpu', {
        url: g.url,
        port: g.port,
        command: path.resolve(root, g.python),
        // --parent-pid：大脑一退出，声音服务就跟着退出
        args: [path.join(root, 'voice', 'server.py'), '--port', String(g.port), '--parent-pid', String(process.pid)],
        cwd: root,
        // Qwen3-TTS 装在哪（模型在它的 models 下面）；不填就是 voice/qwen3-tts
        env: g.qwenHome ? { QWEN3_TTS_HOME: path.resolve(root, g.qwenHome) } : {},
        logFile: path.join(logDir, 'voice-gpu.log'),
        startTimeoutMs: 180_000,
      }, log),
      cpu: new Engine('cpu', {
        url: c.url,
        port: c.port,
        command: process.execPath,
        args: [path.join(root, 'voice', 'cpu-server.mjs'), '--port', String(c.port), '--threads', String(c.threads), '--parent-pid', String(process.pid)],
        cwd: root,
        logFile: path.join(logDir, 'voice-cpu.log'),
        startTimeoutMs: 60_000,
      }, log),
    };
    for (const e of Object.values(this.engines)) e.on('state', () => this.#onEngineState(e));
  }

  // ---- 模式和引擎 ----
  setMode(mode) {
    if (!['gpu', 'cpu', 'off'].includes(mode)) mode = 'off';
    this.mode = mode;
    clearTimeout(this.gpuRetry);
    const { gpu, cpu } = this.engines;
    if (mode === 'off') {
      this.stop(false);
      gpu.stop();
      cpu.stop();
    } else if (mode === 'cpu') {
      gpu.stop(); // 把显存让出来
      cpu.start();
    } else {
      gpu.start();
    }
    this.#report();
  }

  #onEngineState(e) {
    const { gpu, cpu } = this.engines;
    if (e === gpu && this.mode === 'gpu') {
      if (gpu.state === 'down') {
        // 显卡用不了：先用 CPU 顶上，过一会儿再试显卡（比如 Qwen3-TTS 配音工具关掉以后）
        cpu.start();
        clearTimeout(this.gpuRetry);
        if ([EXIT_REASON[3], EXIT_REASON[4], '启动超时'].includes(gpu.reason)) {
          this.gpuRetry = setTimeout(() => this.mode === 'gpu' && gpu.start(), GPU_RETRY_MS);
          this.gpuRetry.unref?.();
        }
      } else if (gpu.state === 'ready') {
        if (cpu.state !== 'off') cpu.stop();
        this.#prewarm();
      }
    }
    if (e === cpu && cpu.state === 'ready') this.#prewarm();
    this.#report();
  }

  #report() {
    const { gpu, cpu } = this.engines;
    this.out({
      type: 'speech_state',
      mode: this.mode,
      engine: this.#engine()?.name || null,
      gpu: gpu.state === 'down' ? `down:${gpu.reason}` : gpu.state,
      cpu: cpu.state === 'down' ? `down:${cpu.reason}` : cpu.state,
    });
  }

  #engine() {
    if (this.mode === 'off') return null;
    const { gpu, cpu } = this.engines;
    if (this.mode === 'gpu' && gpu.state === 'ready') return gpu;
    if (cpu.state === 'ready') return cpu;
    return null;
  }

  get ready() {
    return !!this.#engine();
  }

  // ---- 要说的话 ----
  // 一整段固定的话（授权提示、报错、待机……）
  say(text, { cache = true } = {}) {
    if (this.mode === 'off') return;
    for (const s of splitForSpeech(text)) this.#enqueue({ text: s.speak, cache });
  }

  // 讲解的旁白：念一段，每一句都带上编号（msg 是讲解给的名字），面板据此报告这段念完没有。声音没准备好返回 null
  sayTagged(text, msg) {
    if (this.mode === 'off' || !this.ready) return null;
    const segs = [];
    for (const s of splitForSpeech(text)) {
      const seg = ++this.seq;
      segs.push(seg);
      this.#enqueue({ text: s.speak, msg, seg, cache: false });
    }
    return segs;
  }

  // 流式回复：beginMessage → pushDelta… → endMessage。返回这条回复是否会念（面板据此决定文字要不要跟着声音走）
  // mute：讲解正在边念边讲，这条回复只显示不念
  beginMessage(id, { mute = false } = {}) {
    this.msg = { id, splitter: new SpeechSplitter(), spoken: 0, truncated: false, voice: this.ready && !mute };
    return this.msg.voice;
  }

  pushDelta(delta) {
    if (this.msg) this.#segs(this.msg.splitter.push(delta));
  }

  endMessage() {
    const m = this.msg;
    if (!m) return;
    this.#segs(m.splitter.flush());
    if (m.voice && m.truncated) this.#enqueue({ text: '详情见面板。', cache: true });
    this.msg = null;
  }

  #segs(segs) {
    const m = this.msg;
    if (!m.voice) return;
    for (const s of segs) {
      let speak = s.speak;
      if (speak && (m.truncated || (m.spoken > 0 && m.spoken + speak.length > this.cfg.maxChars))) {
        m.truncated = true;
        speak = '';
      }
      const seg = ++this.seq;
      this.out({ type: 'voice_seg', msg: m.id, seg, start: s.start, end: s.end, speak: !!speak });
      if (speak) {
        m.spoken += speak.length;
        this.#enqueue({ text: speak, msg: m.id, seg, cache: false });
      }
    }
  }

  #enqueue(item) {
    item.id = ++this.seq;
    this.queue.push(item);
    this.#pump();
  }

  // 停下：清空队列，打断正在生成的那句，让面板停止播放
  stop(notify = true) {
    this.gen++;
    this.queue = [];
    if (this.current) {
      this.current.abort.abort();
      this.current.engine?.cancel(this.current.id);
      this.current = null;
    }
    if (notify) this.out({ type: 'voice_stop' });
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        await this.#render(item, this.gen).catch((e) => {
          this.log('voice: 生成失败', item.text, e.message);
          this.out({ type: 'voice', id: item.id, msg: item.msg, seg: item.seg, end: true, failed: true });
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  #cacheFile(engine, text) {
    const dir = path.join(this.dataDir, 'voice', 'cache', `${this.voiceId}-${engine}`);
    return path.join(dir, crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) + '.wav');
  }

  async #render(item, gen) {
    const base = { type: 'voice', id: item.id, msg: item.msg, seg: item.seg };
    // 缓存：优先显卡生成的版本
    if (item.cache) {
      for (const name of ['gpu', 'cpu']) {
        const file = this.#cacheFile(name, item.text);
        if (!fs.existsSync(file)) continue;
        const wav = fs.readFileSync(file);
        this.out({ ...base, sr: wav.readUInt32LE(24), pcm: wav.subarray(44).toString('base64'), end: true });
        return;
      }
    }
    const engine = this.#engine();
    if (!engine) {
      this.out({ ...base, end: true, failed: true });
      return;
    }
    const abort = new AbortController();
    this.current = { id: String(item.id), engine, abort };
    const parts = [];
    let sr = 24000;
    try {
      for await (const chunk of engine.synth(item.text, String(item.id), abort.signal)) {
        if (gen !== this.gen) return;
        sr = chunk.sr;
        parts.push(chunk.pcm);
        this.out({ ...base, sr, pcm: chunk.pcm.toString('base64'), end: false });
      }
    } catch (e) {
      if (gen !== this.gen) return; // 被 stop() 打断，不算失败
      throw e;
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
    if (gen !== this.gen) return;
    this.out({ ...base, sr, end: true });
    if (item.cache && parts.length) {
      const file = this.#cacheFile(engine.name, item.text);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, wavBuffer(Buffer.concat(parts), sr));
    }
  }

  // 闲着的时候把固定的话先生成好存起来
  async #prewarm() {
    if (this.prewarming) return;
    this.prewarming = true;
    try {
      for (const text of FIXED_LINES) {
        const engine = this.#engine();
        if (!engine) break;
        const file = this.#cacheFile(engine.name, text);
        if (fs.existsSync(file)) continue;
        while (this.pumping || this.queue.length) await new Promise((r) => setTimeout(r, 500));
        const parts = [];
        let sr = 24000;
        for await (const c of engine.synth(text, `warm-${text}`)) {
          sr = c.sr;
          parts.push(c.pcm);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, wavBuffer(Buffer.concat(parts), sr));
      }
    } catch (e) {
      this.log('voice: 预生成常用句失败', e.message);
    } finally {
      this.prewarming = false;
    }
  }

  shutdown() {
    this.stop(false);
    for (const e of Object.values(this.engines)) e.stop();
  }
}
