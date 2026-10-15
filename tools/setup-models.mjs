// 下载本地语音模型（耳朵和 CPU 发声用）到 models\：都是 k2-fsa/sherpa-onnx 在 GitHub 上发布的文件，一共约 360MB。
// 用法：npm run setup（已经有的会跳过）；node tools/setup-models.mjs --check 只检查缺哪些，不下载
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'models');
const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const MODELS = [
  { name: 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01', url: `${BASE}/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2`, size: 32654866, what: '唤醒词' },
  { name: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09', url: `${BASE}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2`, size: 165783878, what: '语音识别（SenseVoice）' },
  { name: 'silero_vad.onnx', url: `${BASE}/asr-models/silero_vad.onnx`, size: 643854, what: '断句（Silero VAD）' },
  { name: 'sherpa-onnx-zipvoice-distill-int8-zh-en-emilia', url: `${BASE}/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2`, size: 109162785, what: 'CPU 发声（ZipVoice）' },
  { name: 'vocos_24khz.onnx', url: `${BASE}/vocoder-models/vocos_24khz.onnx`, size: 54157409, what: 'CPU 发声的声码器（Vocos）' },
];
const mb = (n) => `${(n / 1048576).toFixed(0)}MB`;
const have = (m) => fs.existsSync(path.join(dir, m.name));

const missing = MODELS.filter((m) => !have(m));
for (const m of MODELS) console.log(`${have(m) ? '✓' : '·'} ${m.what}：${m.name}${have(m) ? '' : `（${mb(m.size)}）`}`);
if (!missing.length) {
  console.log('\n模型都在，不用下载。');
  process.exit(0);
}
console.log(`\n还缺 ${missing.length} 个，一共约 ${mb(missing.reduce((n, m) => n + m.size, 0))}。`);
if (process.argv.includes('--check')) process.exit(1);

fs.mkdirSync(dir, { recursive: true });
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
for (const m of missing) {
  const file = path.join(dir, path.basename(new URL(m.url).pathname));
  const part = file + '.part';
  process.stdout.write(`下载 ${m.what}（${mb(m.size)}）…`);
  const r = await fetch(m.url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`下载失败：HTTP ${r.status} ${m.url}`);
  const out = fs.createWriteStream(part);
  let got = 0;
  let shown = 0;
  for await (const chunk of r.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = Math.floor((got / m.size) * 100);
    if (pct >= shown + 10) {
      shown = pct - (pct % 10);
      process.stdout.write(` ${shown}%`);
    }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  if (got !== m.size) throw new Error(`${m.name} 大小不对（下载了 ${got} 字节，应该是 ${m.size}），网络断了？重新运行一次就行`);
  fs.renameSync(part, file);
  if (file.endsWith('.tar.bz2')) {
    process.stdout.write(' 解压…');
    execFileSync(tar, ['-xjf', file, '-C', dir], { stdio: 'inherit' });
    fs.rmSync(file);
  }
  console.log(' 好了');
}
console.log('\n模型都装好了。');
