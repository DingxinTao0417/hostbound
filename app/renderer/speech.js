// 面板这边的嘴：收后台发来的音频块，套上系统音效（voice-fx.js）按顺序无缝播放。
// - 正在出声时通知后台（耳朵据此不把系统自己的声音当成宿主说的话）
// - 报告每句的播放进度，让回复文字跟着声音一个字一个字出现
// - 给出实时音量，让系统核心跟着声音发光
(function () {
  let ctx = null;
  let chain = null;
  let analyser = null;
  let levelBuf = null;
  let opts = { fx: 0.6, volume: 0.9 };
  let tail = 0; // 下一块音频从什么时候开始播（AudioContext 时间）
  let dingUntil = 0; // 提示音响到什么时候（performance.now 毫秒），句子要等它响完
  let playing = false;
  const items = new Map(); // 一句话：id → { msg, seg, start, dur, ended, srcs }
  const sources = new Set();
  const segs = new Map(); // `${msg}:${seg}` → { start, dur, ended, done }
  let onState = () => {};

  function ensure() {
    if (ctx) return;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    chain = VoiceFx.build(ctx, { amount: opts.fx, volume: opts.volume });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    levelBuf = new Float32Array(analyser.fftSize);
    chain.output.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function decode(b64) {
    const bin = atob(b64);
    const n = bin.length >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }

  function setPlaying(on) {
    if (on === playing) return;
    playing = on;
    onState(on);
  }

  function segKey(it) {
    return it.msg != null && it.seg != null ? `${it.msg}:${it.seg}` : null;
  }

  function finish(it) {
    items.delete(it.id);
    const k = segKey(it);
    if (k) segs.set(k, { ...(segs.get(k) || {}), done: true, failed: it.failed });
  }

  // m: { id, msg?, seg?, sr, pcm?(base64), end, failed? }
  function push(m) {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    let it = items.get(m.id);
    if (!it) {
      it = { id: m.id, msg: m.msg, seg: m.seg, start: null, dur: 0, ended: false, failed: false, srcs: 0 };
      items.set(m.id, it);
    }
    const data = m.pcm ? decode(m.pcm) : null;
    if (data && data.length) {
      const buf = ctx.createBuffer(1, data.length, m.sr || 24000);
      buf.copyToChannel(data, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(chain.input);
      const now = ctx.currentTime;
      if (it.start == null) {
        // 一句话的开头：跟上一句之间留一点停顿；刚响过提示音就等它响完
        const afterDing = Math.max(0, (dingUntil - performance.now()) / 1000);
        it.start = Math.max(now + 0.04, tail > now ? tail + 0.12 : 0, now + afterDing);
        tail = it.start;
      }
      src.start(tail);
      tail += buf.duration;
      it.dur += buf.duration;
      it.srcs++;
      sources.add(src);
      setPlaying(true);
      src.onended = () => {
        sources.delete(src);
        it.srcs--;
        if (it.ended && it.srcs === 0) finish(it);
        if (!sources.size) setTimeout(() => !sources.size && setPlaying(false), 80);
      };
    }
    const k = segKey(it);
    if (k && it.start != null) segs.set(k, { start: it.start, dur: it.dur, ended: !!m.end, done: false });
    if (m.end) {
      it.ended = true;
      it.failed = !!m.failed;
      if (it.srcs === 0) finish(it);
    }
  }

  // 一段回复文字的播放进度：null 还没开始，0~1 正在念，1 念完（或失败 / 被停）
  function progress(msg, seg) {
    const s = segs.get(`${msg}:${seg}`);
    if (!s) return null;
    if (s.done) return 1;
    if (!ctx || s.start == null) return null;
    const t = ctx.currentTime - s.start;
    if (t < 0) return null;
    return Math.min(1, t / Math.max(s.dur, 0.2));
  }

  function failed(msg, seg) {
    return !!segs.get(`${msg}:${seg}`)?.failed;
  }

  function stop() {
    for (const src of sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    }
    sources.clear();
    for (const it of items.values()) {
      const k = segKey(it);
      if (k) segs.set(k, { done: true });
    }
    items.clear();
    tail = 0;
    setPlaying(false);
  }

  // 系统声音的实时音量（0~1 左右）
  function level() {
    if (!analyser || !playing) return 0;
    analyser.getFloatTimeDomainData(levelBuf);
    let s = 0;
    for (let i = 0; i < levelBuf.length; i++) s += levelBuf[i] * levelBuf[i];
    return Math.min(1, Math.sqrt(s / levelBuf.length) * 4);
  }

  window.Speech = {
    configure(o) {
      opts = { ...opts, ...o };
    },
    push,
    stop,
    progress,
    failed,
    level,
    markDing(ms) {
      dingUntil = Math.max(dingUntil, performance.now() + ms);
    },
    onState(cb) {
      onState = cb;
    },
    get playing() {
      return playing;
    },
  };
})();
