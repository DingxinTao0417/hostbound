// 用 wav 文件测试耳朵：node tools/test-ear.mjs [wav...]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ear } from '../brain/ear.mjs';
import { loadConfig } from '../brain/config.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(root);

const t0 = Date.now();
const ear = new Ear({ modelsDir: path.join(root, 'models'), ...cfg.voice });
console.log(`模型加载 ${Date.now() - t0}ms`);

let pos = 0;
const at = () => (pos / 16000).toFixed(2) + 's';
ear.on('wake', (k) => { console.log(`  [${at()}] 唤醒: ${k}`); ear.listen(60000); });
ear.on('stopword', (k) => console.log(`  [${at()}] 停止词: ${k}`));
ear.on('speech_start', () => console.log(`  [${at()}] 开始说话`));
ear.on('transcript', (t) => console.log(`  [${at()}] 识别: 「${t}」`));

const files = process.argv.slice(2);
const list = files.length ? files : ['wake_then_cmd', 'wake_fast', 'negative', 'stop'].map((n) => path.join(root, 'tools', 'testwav', n + '.wav'));
for (const f of list) {
  console.log(path.basename(f));
  const wave = sherpa.readWave(f);
  ear.cancelListen();
  pos = 0;
  const step = 1600;
  const t = Date.now();
  for (let i = 0; i < wave.samples.length; i += step) {
    const chunk = wave.samples.subarray(i, i + step);
    pos += chunk.length;
    ear.feed(chunk);
  }
  ear.feed(new Float32Array(16000)); // 补 1 秒静音
  console.log(`  处理 ${(wave.samples.length / 16000).toFixed(1)}s 音频用了 ${Date.now() - t}ms`);
}
process.exit(0);
