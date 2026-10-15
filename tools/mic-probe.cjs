// 麦克风自检：打印默认输入设备、格式，录 3 秒看音量
const { convenience } = require('node-cpal');

(async () => {
  const dev = convenience.getDefaultInputDevice();
  if (!dev) throw new Error('没有找到默认麦克风');
  const cfg = convenience.getDefaultInputConfig(dev.deviceId);
  console.log('device:', dev.name || dev.deviceId);
  console.log('config:', JSON.stringify(cfg));
  let n = 0, peak = 0, calls = 0, type = '';
  const stream = await convenience.createInputStream({
    deviceId: dev.deviceId,
    config: { channels: cfg.channels, sampleRate: cfg.sampleRate, sampleFormat: 'f32' },
    autoStart: true,
    onData(data) {
      calls++;
      type = Object.prototype.toString.call(data);
      const arr = data instanceof Float32Array ? data : new Float32Array(data.buffer || data);
      n += arr.length;
      for (const v of arr) peak = Math.max(peak, Math.abs(v));
    },
    onError(e) { console.error('stream error', e.code, e.message); },
  });
  await new Promise((r) => setTimeout(r, 3000));
  await stream.close();
  console.log({ calls, samples: n, perSecond: Math.round(n / 3), peak: peak.toFixed(4), type });
})().catch((e) => { console.error(e); process.exit(1); });
