// Hostbound 声音服务（CPU 备用）：sherpa-onnx ZipVoice，拿系统音色的一小段录音当参考来克隆，接口跟 voice/server.py 一样：
//   GET  /health                       → {"ready": true, "engine": "cpu", "voice": "...", "sampleRate": 24000}
//   POST /tts    {"text": "...", "id"} → 16 位单声道 PCM（分块传输），响应头 X-Sample-Rate
//   POST /cancel {"id"}                → 丢掉正在生成的那一句
// 用法：node voice/cpu-server.mjs [--port 5182] [--threads 4] [--steps 4] [--parent-pid PID] [--bench]
// 带 --parent-pid 时，那个进程（大脑）一退出，服务就跟着退出。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', 5182));
const THREADS = Number(arg('threads', 4));
const STEPS = Number(arg('steps', 4));
const BENCH = process.argv.includes('--bench');
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

const modelDir = path.join(root, 'models', 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia');
// 系统音色：自己设计过的在 data/voice/system，没有就用仓库自带的 voice/default
const voiceDir = [path.join(root, 'data', 'voice', 'system'), path.join(root, 'voice', 'default')].find((d) => fs.existsSync(path.join(d, 'voice.json')));
const meta = JSON.parse(fs.readFileSync(path.join(voiceDir, 'voice.json'), 'utf8'));
const prompt = sherpa.readWave(path.join(voiceDir, meta.cpuPrompt));

const PARENT = Number(arg('parent-pid', 0));
if (PARENT) {
  setInterval(() => {
    try {
      process.kill(PARENT, 0); // 只检查进程还在不在
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
}

let started = Date.now();
const tts = await sherpa.OfflineTts.createAsync({
  model: {
    zipvoice: {
      tokens: path.join(modelDir, 'tokens.txt'),
      encoder: path.join(modelDir, 'encoder.int8.onnx'),
      decoder: path.join(modelDir, 'decoder.int8.onnx'),
      vocoder: path.join(root, 'models', 'vocos_24khz.onnx'),
      dataDir: path.join(modelDir, 'espeak-ng-data'),
      lexicon: path.join(modelDir, 'lexicon.txt'),
    },
    numThreads: THREADS,
    provider: 'cpu',
    debug: 0,
  },
  maxNumSentences: 1,
});
log(`模型加载 ${((Date.now() - started) / 1000).toFixed(1)}s`);

// 同一时间只生成一句
let chain = Promise.resolve();
let current = null;
const cancelled = new Set();
function synth(text, id) {
  const run = chain.then(async () => {
    current = id;
    const t = Date.now();
    const audio = await tts.generateAsync({
      text,
      sid: 0,
      speed: 1.0,
      generationConfig: new sherpa.GenerationConfig({
        referenceAudio: prompt.samples,
        referenceSampleRate: prompt.sampleRate,
        referenceText: meta.cpuPromptText,
        numSteps: STEPS,
      }),
    });
    current = null;
    return { ...audio, spent: (Date.now() - t) / 1000 };
  });
  chain = run.catch(() => {});
  return run;
}

function toPcm(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return out;
}

if (BENCH) {
  const out = path.join(root, 'data', 'voice', 'bench-cpu');
  fs.mkdirSync(out, { recursive: true });
  const lines = ['系统已启动。宿主，请下达指令。', '检测到高危操作，请宿主授权。', '任务完成。已为宿主打开计算器，七加八等于十五。', '限时任务：补充水分。剩余时间，二十九分五十九秒。'];
  await synth('预热。');
  for (const [i, text] of lines.entries()) {
    const a = await synth(text);
    const sec = a.samples.length / a.sampleRate;
    sherpa.writeWave(path.join(out, `${i + 1}.wav`), { samples: a.samples, sampleRate: a.sampleRate });
    log(`${i + 1}: 音频 ${sec.toFixed(1)}s，用时 ${a.spent.toFixed(1)}s（${(sec / a.spent).toFixed(2)} 倍实时）`);
  }
  process.exit(0);
}

let ready = false;
const body = (req) => new Promise((res) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => {
    try {
      res(JSON.parse(s || '{}'));
    } catch {
      res({});
    }
  });
});
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ready, engine: 'cpu', voice: meta.name, sampleRate: tts.sampleRate });
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
  const q = await body(req);
  if (req.url === '/cancel') {
    if (q.id == null || q.id === current) cancelled.add(current);
    return json(res, 200, { ok: true });
  }
  if (req.url !== '/tts') return json(res, 404, { error: 'not found' });
  if (!ready) return json(res, 503, { error: 'warming up' });
  const text = String(q.text || '').trim();
  if (!text) return json(res, 400, { error: 'empty text' });
  try {
    const a = await synth(text, q.id ?? null);
    if (cancelled.delete(q.id ?? null) || res.destroyed) return res.destroyed || res.end();
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(a.sampleRate) });
    const pcm = toPcm(a.samples);
    const step = a.sampleRate; // 每块约 0.5 秒
    for (let i = 0; i < pcm.length; i += step) res.write(pcm.subarray(i, i + step));
    res.end();
    const sec = a.samples.length / a.sampleRate;
    log(`tts ${text.length} 字：音频 ${sec.toFixed(1)}s，用时 ${a.spent.toFixed(1)}s（${(sec / a.spent).toFixed(2)} 倍实时）`);
  } catch (e) {
    log('tts 失败', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => log(`监听 127.0.0.1:${PORT}`));
started = Date.now();
await synth('预热。');
ready = true;
log(`预热 ${((Date.now() - started) / 1000).toFixed(1)}s`);
log('ready');
