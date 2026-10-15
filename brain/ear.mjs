// 系统的耳朵：唤醒词（KWS）一直开着；被叫醒后用 VAD 等你说完一句，再用 SenseVoice 转成文字。
// 全部本地运行，不联网。
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

function findDir(modelsDir, prefix) {
  const hit = fs.readdirSync(modelsDir).find((n) => n.startsWith(prefix));
  if (!hit) throw new Error(`models 目录里找不到 ${prefix}*`);
  return path.join(modelsDir, hit);
}

// keywords: [{ text, tokens, boost?, threshold? }] -> sherpa 的关键词文件格式
function writeKeywordsFile(file, keywords, tokenSet) {
  const lines = [];
  for (const k of keywords) {
    const missing = k.tokens.split(/\s+/).filter((t) => !tokenSet.has(t));
    if (missing.length) throw new Error(`关键词「${k.text}」里有模型不认识的音节：${missing.join(' ')}`);
    let line = k.tokens;
    if (k.boost != null) line += ` :${k.boost}`;
    if (k.threshold != null) line += ` #${k.threshold}`;
    lines.push(`${line} @${k.text}`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

export function cleanTranscript(text, wakeTexts) {
  let t = (text || '').trim();
  // 识别结果里偶尔会带上唤醒词本身，去掉
  for (const w of wakeTexts) {
    const re = new RegExp('^[\\s，,。.!！?？、]*' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s，,。.!！?？、]*');
    t = t.replace(re, '');
  }
  t = t.replace(/^[\s，,。.!！?？、]+/, '');
  return t;
}

export class Ear extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    const { modelsDir, wakeWords, stopWords } = opts;
    this.wakeTexts = wakeWords.map((k) => k.text);
    this.stopTexts = new Set(stopWords.map((k) => k.text));

    const kwsDir = findDir(modelsDir, 'sherpa-onnx-kws-zipformer-wenetspeech');
    const tokenSet = new Set(
      fs.readFileSync(path.join(kwsDir, 'tokens.txt'), 'utf8').split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean),
    );
    const keywordsFile = path.join(modelsDir, 'keywords.txt');
    writeKeywordsFile(keywordsFile, [...wakeWords, ...stopWords], tokenSet);

    const m = (name) => path.join(kwsDir, name);
    this.kws = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: m('encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          decoder: m('decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          joiner: m('joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        },
        tokens: m('tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile,
      keywordsScore: opts.kwsScore ?? 1.5,
      keywordsThreshold: opts.kwsThreshold ?? 0.25,
    });
    this.kwsStream = this.kws.createStream();

    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: path.join(modelsDir, 'silero_vad.onnx'),
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: opts.endSilence ?? 0.8,
          maxSpeechDuration: 20,
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      30,
    );
    this.vadBuffer = new sherpa.CircularBuffer(30 * SAMPLE_RATE);

    const svDir = findDir(modelsDir, 'sherpa-onnx-sense-voice');
    this.asr = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: path.join(svDir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
        tokens: path.join(svDir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    });

    this.wakeEnabled = opts.wakeEnabled !== false;
    this.listening = false;
    this.speechSeen = false;
    this.noSpeechTimer = null;
    this.levelAcc = 0;
    this.levelN = 0;
    // 系统自己在说话：外放的声音会被麦克风听到，这段时间不当成宿主说的话（停止词照样认）
    this.outputActive = false;
    this.outputSince = 0;
    // 按住说话：按下到松开之间的声音全部录下来
    this.capturing = false;
    this.capture = [];
    this.captureLen = 0;
  }

  setOutputActive(on, tailMs = 350) {
    clearTimeout(this.outputTail);
    if (on) {
      if (!this.outputActive) {
        this.outputActive = true;
        this.outputSince = Date.now();
        clearTimeout(this.noSpeechTimer);
      }
      return;
    }
    if (!this.outputActive) return;
    // 声音停了以后再等一小会儿：房间里还有回声
    this.outputTail = setTimeout(() => {
      this.outputActive = false;
      this.vad.reset();
      this.vadBuffer.reset();
      if (this.listening) {
        // 系统说话的时间不算在“等你开口”的时间里
        this.deadline += Date.now() - this.outputSince;
        this.speechSeen = false;
        this.#armNoSpeechTimer();
      }
    }, tailMs);
  }

  startCapture() {
    this.cancelListen();
    this.capturing = true;
    this.capture = [];
    this.captureLen = 0;
  }

  // 返回录下的 16k 单声道音频
  endCapture() {
    this.capturing = false;
    const out = new Float32Array(this.captureLen);
    let o = 0;
    for (const c of this.capture) {
      out.set(c, o);
      o += c.length;
    }
    this.capture = [];
    this.captureLen = 0;
    return out;
  }

  setWakeEnabled(on) {
    this.wakeEnabled = !!on;
    this.kws.reset(this.kwsStream);
  }

  // 进入“听一句话”模式：timeoutMs 内没人开口就算了
  listen(timeoutMs = 7000) {
    this.vad.reset();
    this.vadBuffer.reset();
    this.listening = true;
    this.speechSeen = false;
    this.deadline = Date.now() + timeoutMs;
    this.#armNoSpeechTimer();
    this.emit('listening');
  }

  #armNoSpeechTimer() {
    clearTimeout(this.noSpeechTimer);
    const left = Math.max(1500, this.deadline - Date.now());
    this.noSpeechTimer = setTimeout(() => {
      if (this.listening && !this.speechSeen) {
        this.listening = false;
        this.emit('listen_timeout');
      }
    }, left);
  }

  cancelListen() {
    if (!this.listening) return;
    this.listening = false;
    clearTimeout(this.noSpeechTimer);
  }

  // samples: 16k 单声道 Float32Array
  feed(samples) {
    if (this.capturing) {
      if (this.captureLen < 30 * SAMPLE_RATE) {
        this.capture.push(samples);
        this.captureLen += samples.length;
      }
      this.#level(samples);
      return;
    }
    if (this.wakeEnabled || this.stopTexts.size) this.#feedKws(samples);
    if (this.listening && !this.outputActive) this.#feedVad(samples);
  }

  #level(samples) {
    // 给界面一个音量，做“正在听”的动画
    for (let i = 0; i < samples.length; i++) this.levelAcc += samples[i] * samples[i];
    this.levelN += samples.length;
    if (this.levelN >= SAMPLE_RATE / 10) {
      this.emit('level', Math.sqrt(this.levelAcc / this.levelN));
      this.levelAcc = 0;
      this.levelN = 0;
    }
  }

  #feedKws(samples) {
    this.kwsStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    while (this.kws.isReady(this.kwsStream)) {
      this.kws.decode(this.kwsStream);
      const keyword = this.kws.getResult(this.kwsStream).keyword;
      if (!keyword) continue;
      this.kws.reset(this.kwsStream);
      if (this.stopTexts.has(keyword)) {
        this.emit('stopword', keyword);
      } else if (this.wakeEnabled && !this.listening && !this.outputActive) {
        // 系统说话时不认唤醒词：它自己说的「系统已启动」之类会被外放的麦克风听到
        this.emit('wake', keyword);
      }
    }
  }

  #feedVad(samples) {
    this.#level(samples);
    this.vadBuffer.push(samples);
    while (this.vadBuffer.size() >= VAD_WINDOW) {
      const win = this.vadBuffer.get(this.vadBuffer.head(), VAD_WINDOW);
      this.vadBuffer.pop(VAD_WINDOW);
      this.vad.acceptWaveform(win);
      if (!this.speechSeen && this.vad.isDetected()) {
        this.speechSeen = true;
        clearTimeout(this.noSpeechTimer);
        this.emit('speech_start');
      }
    }
    while (this.listening && !this.vad.isEmpty()) {
      const seg = this.vad.front();
      this.vad.pop();
      const text = cleanTranscript(this.transcribe(seg.samples), this.wakeTexts);
      if (text.length >= 2) {
        this.listening = false;
        clearTimeout(this.noSpeechTimer);
        this.emit('transcript', text);
      } else {
        // 咳嗽、敲键盘之类识别不出字：当没听到，接着等，别让计时器失效
        this.speechSeen = false;
        this.#armNoSpeechTimer();
      }
    }
  }

  // 测试用：把一个 16k wav 当成麦克风输入，按实时速度喂进来
  async feedWave(file) {
    const wave = sherpa.readWave(file);
    const step = 1600;
    this.micMuted = true; // 不然真麦克风的声音会和录音交错在一起
    try {
      for (let i = 0; i < wave.samples.length; i += step) {
        this.feed(wave.samples.slice(i, i + step));
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      this.micMuted = false;
    }
  }

  transcribe(samples) {
    const stream = this.asr.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    this.asr.decode(stream);
    return this.asr.getResult(stream).text || '';
  }

  // 打开麦克风：name 是设备名（设置里选的），没给或者找不到就用系统默认的
  async startMic(name = '') {
    const { convenience } = require('node-cpal');
    const picked = name ? [...convenience.getDevices()].find((d) => d.supportsInput && d.direction !== 'output' && d.name === name) : null;
    const dev = picked || convenience.getDefaultInputDevice();
    if (!dev) throw new Error('没有找到麦克风');
    const cfg = convenience.getDefaultInputConfig(dev.deviceId);
    const channels = cfg.channels;
    const resampler = cfg.sampleRate === SAMPLE_RATE ? null : new sherpa.LinearResampler(cfg.sampleRate, SAMPLE_RATE);
    this.micName = dev.name || dev.deviceId;
    this.mic = await convenience.createInputStream({
      deviceId: dev.deviceId,
      config: { channels, sampleRate: cfg.sampleRate, sampleFormat: 'f32' },
      // 默认只缓冲约 0.3 秒，加载模型、识别时进程忙一下就会丢音频；放到约 5 秒
      queueCapacityBuffers: 512,
      autoStart: true,
      onData: (data) => {
        if (this.micMuted) return;
        let mono = data;
        if (channels > 1) {
          mono = new Float32Array(Math.floor(data.length / channels));
          for (let i = 0; i < mono.length; i++) {
            let s = 0;
            for (let c = 0; c < channels; c++) s += data[i * channels + c];
            mono[i] = s / channels;
          }
        } else {
          mono = Float32Array.from(data); // data 只在回调里有效，先拷一份
        }
        try {
          this.feed(resampler ? resampler.resample(mono) : mono);
        } catch (e) {
          this.emit('error', e);
        }
      },
      onError: (e) => {
        // 丢几帧音频无伤大雅，别刷屏
        if (e?.code === 'INPUT_OVERFLOW') {
          if (Date.now() - (this.lastOverflowLog || 0) > 60_000) {
            this.lastOverflowLog = Date.now();
            this.emit('error', new Error('麦克风缓冲溢出，丢了一点音频'));
          }
          return;
        }
        this.emit('error', e);
      },
    });
    return this.micName;
  }

  async stopMic() {
    if (this.mic) await this.mic.close().catch(() => {});
    this.mic = null;
  }
}
