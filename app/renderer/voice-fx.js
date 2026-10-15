// 系统音效：把 TTS 原声处理成「系统音」。面板播放和 tools/render-voice-samples.cjs 离线渲染共用这一份。
// 链路：高通（去掉胸腔低频，声音更“薄”更像广播）→ 存在感/空气感提升 → 两条慢速调制的短延迟（电子合唱感）
//      → 短混响（空间感）→ 压缩。amount 0 是原声，1 是很重的系统音。
(function () {
  // 确定性的噪声冲激响应，保证每次渲染结果一样
  function impulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let seed = ch ? 48271 : 16807;
      for (let i = 0; i < len; i++) {
        seed = (seed * 16807) % 2147483647;
        d[i] = ((seed / 2147483647) * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function build(ctx, opts = {}) {
    const amount = Math.max(0, Math.min(1, opts.amount ?? 0.6));
    const input = ctx.createGain();
    const output = ctx.createGain();
    output.gain.value = opts.volume ?? 1;
    const lfos = [];
    if (amount === 0) {
      input.connect(output);
      return { input, output, amount, stop() {} };
    }

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90 + 160 * amount;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3200;
    presence.Q.value = 0.9;
    presence.gain.value = 4 * amount;
    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 8000;
    air.gain.value = 3 * amount;
    input.connect(hp).connect(presence).connect(air);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.15;
    comp.connect(output);
    air.connect(comp);

    const chorus = ctx.createGain();
    chorus.gain.value = 0.32 * amount;
    chorus.connect(comp);
    for (const [base, rate, depth] of [[0.011, 0.7, 0.0018], [0.017, 1.1, 0.0023]]) {
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = base;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = depth;
      lfo.connect(lfoGain).connect(delay.delayTime);
      lfo.start();
      lfos.push(lfo);
      air.connect(delay).connect(chorus);
    }

    const pre = ctx.createDelay(0.1);
    pre.delayTime.value = 0.018;
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 0.8, 3.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.22 * amount;
    air.connect(pre).connect(reverb).connect(wet).connect(comp);

    return {
      input,
      output,
      amount,
      stop() {
        for (const l of lfos) try { l.stop(); } catch {}
      },
    };
  }

  // 提示音：跟面板里的 ding() 同一套音高
  const DING = { wake: [1318, 1760], done: [1568, 2093], auth: [880, 660], error: [440, 330], remind: [1568, 1318, 1568] };
  function ding(ctx, kind, when = ctx.currentTime, dest = ctx.destination) {
    (DING[kind] || [1318]).forEach((f, i) => {
      const t = when + i * 0.09;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.3);
    });
    return 0.09 * ((DING[kind] || [1318]).length - 1) + 0.3;
  }

  (typeof window !== 'undefined' ? window : globalThis).VoiceFx = { build, ding, impulse };
})();
