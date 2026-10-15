// 用耳朵的 SenseVoice 听写 wav 文件，检查 TTS 有没有念错、漏念、多念：node tools/transcribe.mjs a.wav b.wav …
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = path.join(root, 'models');
const svDir = path.join(models, fs.readdirSync(models).find((d) => d.startsWith('sherpa-onnx-sense-voice')));

const asr = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: path.join(svDir, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 0 },
    tokens: path.join(svDir, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
});

for (const file of process.argv.slice(2)) {
  const wave = sherpa.readWave(file);
  const stream = asr.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  asr.decode(stream);
  console.log(`${path.basename(file).padEnd(12)} ${(wave.samples.length / wave.sampleRate).toFixed(1).padStart(5)}s  ${asr.getResult(stream).text}`);
}
