// 把 data/voice/samples 里每个候选音色的示例句，用面板同一套系统音效（app/renderer/voice-fx.js）离线渲染成试听文件：
//   X-fx.wav（系统音效）和 X-raw.wav（原声），开头带唤醒提示音，句与句之间留停顿。
// 用法：node_modules\electron\dist\electron.exe tools\render-voice-samples.cjs [音效强度 0~1，默认 0.6]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'data', 'voice', 'samples');
const amount = Number(process.argv.find((a) => /^(0(\.\d+)?|1(\.0+)?)$/.test(a)) ?? 0.6);

const PAGE_JS = `
async function renderSample(lines, amount) {
  const rate = 48000;
  const probe = new OfflineAudioContext(1, 1, rate);
  const bufs = [];
  for (const b64 of lines) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    bufs.push(await probe.decodeAudioData(bytes.buffer));
  }
  const start = 0.5, gap = 0.75;
  const total = start + bufs.reduce((s, b) => s + b.duration + gap, 0) + 0.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * rate), rate);
  const chain = VoiceFx.build(ctx, { amount });
  chain.output.connect(ctx.destination);
  VoiceFx.ding(ctx, 'wake', 0.05);
  let t = start;
  for (const b of bufs) {
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(chain.input);
    s.start(t);
    t += b.duration + gap;
  }
  const out = await ctx.startRendering();
  // 16 位 PCM 双声道 WAV
  const n = out.length, chs = [out.getChannelData(0), out.getChannelData(1)];
  const view = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0, o = 44; i < n; i++) for (const c of chs) {
    const v = Math.max(-1, Math.min(1, c[i]));
    peak = Math.max(peak, Math.abs(v));
    view.setInt16(o, v * 32767, true);
    o += 2;
  }
  const u8 = new Uint8Array(view.buffer);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { b64: btoa(bin), seconds: total, peak };
}`;

app.whenReady().then(async () => {
  const fx = fs.readFileSync(path.join(root, 'app', 'renderer', 'voice-fx.js'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body><script>${fx}</script><script>${PAGE_JS}</script></body></html>`));
  const ids = [...new Set(fs.readdirSync(dir).map((f) => f.match(/^([A-Z])-\d+\.wav$/)?.[1]).filter(Boolean))].sort();
  for (const id of ids) {
    const lines = fs.readdirSync(dir).filter((f) => new RegExp(`^${id}-\\d+\\.wav$`).test(f)).sort()
      .map((f) => fs.readFileSync(path.join(dir, f)).toString('base64'));
    for (const [tag, amt] of [['fx', amount], ['raw', 0]]) {
      const r = await win.webContents.executeJavaScript(`renderSample(${JSON.stringify(lines)}, ${amt})`);
      fs.writeFileSync(path.join(dir, `${id}-${tag}.wav`), Buffer.from(r.b64, 'base64'));
      console.log(`${id}-${tag}.wav  ${r.seconds.toFixed(1)}s  peak ${r.peak.toFixed(2)}`);
    }
  }
  app.quit();
});
