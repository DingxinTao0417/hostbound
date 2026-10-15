// 连续对话 + 语音确认的端到端测试（假模型 + 录音）：node tools/test-conversation.mjs
// 流程：喊名字下指令 → 语音「可以」放行 → 不喊名字接着下第二个指令 → 语音「不行」拒绝
//      → 听到一句闲聊，应该被忽略 → 「没事了你去睡吧」，应该收起面板
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wav = (n) => path.join(root, 'tools', 'testwav', n + '.wav');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-test-'));
fs.writeFileSync(
  path.join(tmp, 'models.json'),
  JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:5199/v1', api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }),
);
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false } }));

const mock = fork(path.join(root, 'tools', 'mock-llm.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
await new Promise((r) => setTimeout(r, 400));
const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_DEBUG: '1', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data') },
});

const isListening = (mode) => (m) => m.type === 'listening' && m.mode === mode;
// 每一步：等到某个消息，就喂下一段录音
const steps = [
  { name: '启动', when: (m) => m.type === 'brain_ready', feed: 'wake_then_cmd' },
  { name: '第一个确认框，说「可以，删吧」', when: isListening('confirm'), feed: 'allow' },
  { name: '干完后不喊名字直接说下一句', when: isListening('followup'), feed: 'followup_task' },
  { name: '第二个确认框，说「不行」', when: isListening('confirm'), feed: 'deny' },
  { name: '待命时听到闲聊', when: isListening('followup'), feed: 'negative' },
  { name: '闲聊被忽略后说「没事了你去睡吧」', when: isListening('followup'), feed: 'dismiss' },
];
const expect = [
  ['唤醒', (m) => m.type === 'wake'],
  ['听到第一句指令', (m) => m.type === 'heard' && /记/.test(m.text)],
  ['语音放行', (m) => m.type === 'confirm_closed' && m.answer === 'allow' && m.by === 'voice'],
  ['第一轮完成', (m) => m.type === 'done'],
  ['不喊名字听到第二句', (m) => m.type === 'heard' && /星期/.test(m.text)],
  ['语音拒绝', (m) => m.type === 'confirm_closed' && m.answer === 'deny' && m.by === 'voice'],
  ['第二轮完成，说没让删', (m) => m.type === 'done' && /没让删/.test(m.text)],
  ['闲聊被忽略', (m) => m.type === 'ignored'],
  ['收起面板', (m) => m.type === 'dismiss' && m.farewell],
];

let step = 0;
let exp = 0;
// 上一段录音还没喂完（尾巴上有静音）就不能开始下一段，否则两段声音会交错
let feeding = false;
let queued = null;
function feed(s) {
  if (feeding) return (queued = s);
  feeding = true;
  console.log(`→ ${s.name}：喂 ${s.feed}.wav`);
  brain.send({ type: 'debug_feed_wav', path: wav(s.feed) });
}
const finish = (ok) => {
  for (; exp < expect.length; exp++) console.log('✗', expect[exp][0]);
  console.log(ok ? '\n全部通过' : '\n没通过');
  brain.kill();
  mock.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(ok ? 0 : 1);
};
setTimeout(() => finish(false), 90_000);

brain.on('message', (m) => {
  if (['level', 'say', 'speech_start'].includes(m.type)) return;
  const brief = { ...m };
  delete brief.detail;
  console.log('   ←', JSON.stringify(brief).slice(0, 140));
  if (exp < expect.length && expect[exp][1](m)) console.log('✓', expect[exp++][0]);
  if (m.type === 'debug_fed') {
    feeding = false;
    if (queued) {
      const s = queued;
      queued = null;
      feed(s);
    }
  }
  if (step < steps.length && steps[step].when(m)) feed(steps[step++]);
  if (m.type === 'dismiss') finish(exp === expect.length);
  if (m.type === 'error' || m.type === 'brain_missing') finish(false);
});
