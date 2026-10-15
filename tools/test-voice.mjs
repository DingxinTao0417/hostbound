// 系统声音的端到端测试（假模型 + 假声音服务 + 录音）：node tools/test-voice.mjs
// 检查：回复边生成边念、分段和音频块拼接正确；系统说话时耳朵不收音、说完恢复；停止词能打断；按住说话；常用句缓存。
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wav = (n) => path.join(root, 'tools', 'testwav', n + '.wav');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-voice-'));
const TTS = 'http://127.0.0.1:5197';
fs.writeFileSync(
  path.join(tmp, 'models.json'),
  JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:5199/v1', api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }),
);
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false }, speech: { mode: 'gpu', gpu: { url: TTS }, cpu: { url: TTS } } }),
);

const mockLlm = fork(path.join(root, 'tools', 'mock-llm.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const mockTts = fork(path.join(root, 'tools', 'mock-tts.cjs'), ['5197'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let ttsLog = '';
mockTts.stderr.on('data', (d) => (ttsLog += d));
await new Promise((r) => setTimeout(r, 500));
const env = { ...process.env, HOSTBOUND_DEBUG: '1', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: tmp };
delete env.HOSTBOUND_SPEECH_MODE;
const brain = fork(path.join(root, 'brain', 'index.mjs'), [], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env });

// ---- 收消息、等消息 ----
const seen = [];
let waiters = [];
brain.on('message', (m) => {
  seen.push(m);
  fakePanel(m);
  for (const w of [...waiters]) if (w.pred(m)) {
    waiters = waiters.filter((x) => x !== w);
    w.resolve(m);
  }
});
const waitFor = (label, pred, ms = 20_000) => {
  const hit = seen.find((m) => !m.__used && pred(m));
  if (hit) {
    hit.__used = true;
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const w = { pred, resolve: (m) => ((m.__used = true), clearTimeout(w.t), resolve(m)) };
    w.t = setTimeout(() => reject(new Error(`等不到：${label}`)), ms);
    waiters.push(w);
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 新一轮开始前：之前收到的消息都不算了
const fresh = () => seen.forEach((m) => (m.__used = true));
const feed = async (name) => {
  brain.send({ type: 'debug_feed_wav', path: wav(name) });
  await waitFor(`喂完 ${name}`, (m) => m.type === 'debug_fed' && m.path === wav(name), 30_000);
};

// ---- 假面板：收到一句的音频就“开始播放”，这句结束后 150 毫秒“播完”。hold 时一直算在播 ----
const playing = new Set();
let hold = false;
const pcmBytes = new Map(); // 每句收到的音频字节数
function setPlaying() {
  brain.send({ type: 'voice_state', playing: hold || playing.size > 0 });
}
function fakePanel(m) {
  if (m.type === 'voice') {
    if (m.pcm) pcmBytes.set(m.id, (pcmBytes.get(m.id) || 0) + Buffer.from(m.pcm, 'base64').length);
    if (!playing.has(m.id) && m.pcm) {
      playing.add(m.id);
      setPlaying();
    }
    if (m.end) setTimeout(() => {
      playing.delete(m.id);
      setPlaying();
    }, 150);
  }
  if (m.type === 'voice_stop') {
    playing.clear();
    setPlaying();
  }
}

// ---- 断言 ----
let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const finish = (code) => {
  brain.kill();
  mockLlm.kill();
  mockTts.kill();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  process.exit(code);
};
setTimeout(() => {
  console.log('✗ 整体超时');
  finish(1);
}, 180_000);

try {
  await waitFor('大脑就绪', (m) => m.type === 'brain_ready');
  await waitFor('声音引擎就绪', (m) => m.type === 'speech_state' && m.engine === 'gpu');
  ok('声音引擎就绪（用的是已经在跑的服务）', true);

  // 1. 回复边生成边念
  brain.send({ type: 'prompt', text: '查一下今天几号' });
  const start = await waitFor('回复开始', (m) => m.type === 'say_start');
  ok('回复会念（文字跟着声音走）', start.voice === true);
  const seg = await waitFor('第一段', (m) => m.type === 'voice_seg' && m.msg === start.id);
  ok('第一段的位置和内容', seg.start === 0 && seg.end === 9 && seg.speak === true, JSON.stringify(seg));
  const segEnd = await waitFor('第一段念完', (m) => m.type === 'voice' && m.seg === seg.seg && m.end);
  ok('音频块拼回完整的采样（奇数字节断开也没错）', pcmBytes.get(segEnd.id) === Math.round(9 * 0.1 * 24000) * 2, `收到 ${pcmBytes.get(segEnd.id)} 字节`);

  // 2. 授权：念「请宿主授权」；系统说话时耳朵不收音
  await waitFor('弹出授权', (m) => m.type === 'confirm');
  const line = await waitFor('念授权提示', (m) => m.type === 'voice' && m.msg == null && m.end);
  ok('授权提示有声音', pcmBytes.get(line.id) > 0);
  await waitFor('听授权', (m) => m.type === 'listening' && m.mode === 'confirm');
  hold = true;
  setPlaying();
  await sleep(100);
  await feed('allow');
  await sleep(600);
  ok('系统说话时，宿主的「可以删吧」不收（当成回声）', !seen.some((m) => m.type === 'confirm_closed'));
  hold = false;
  setPlaying();
  await sleep(700);
  await feed('allow');
  const closed = await waitFor('语音授权', (m) => m.type === 'confirm_closed');
  ok('说完以后恢复收音，语音授权生效', closed.answer === 'allow' && closed.by === 'voice', JSON.stringify(closed));
  const done1 = await waitFor('第一轮完成', (m) => m.type === 'done');
  ok('第一轮完成', /日期已查到/.test(done1.text));
  // 没有自己设计的音色时用仓库自带的 voice/default，缓存按它的 id 分
  const voiceId = JSON.parse(fs.readFileSync(path.join(root, 'voice', 'default', 'voice.json'), 'utf8')).id;
  const cacheDir = path.join(tmp, 'voice', 'cache', `${voiceId}-gpu`);
  ok('常用句存进缓存', fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length >= 1);

  // 3. 停止词：系统正在说话时喊「系统停止」，先闭嘴，再中止任务
  await sleep(500);
  fresh();
  brain.send({ type: 'prompt', text: '再查一次' });
  const s2 = await waitFor('第二轮回复', (m) => m.type === 'say_start');
  await waitFor('第二轮开始出声', (m) => m.type === 'voice' && m.msg === s2.id && m.pcm);
  hold = true;
  setPlaying();
  await feed('stop');
  const vs = await waitFor('停止播放', (m) => m.type === 'voice_stop', 8000).catch(() => null);
  ok('停止词让系统闭嘴', !!vs);
  const stopped = await waitFor('任务中止', (m) => m.type === 'stopped', 8000).catch(() => null);
  ok('停止词中止任务', !!stopped);
  hold = false;
  setPlaying();
  await sleep(800);
  fresh();

  // 4. 按住说话：按下 → 说话 → 松开，当成一句指令
  brain.send({ type: 'ptt', state: 'down' });
  const pl = await waitFor('按住说话聆听', (m) => m.type === 'listening' && m.mode === 'ptt');
  ok('按下开始听', !!pl);
  await feed('followup_task');
  brain.send({ type: 'ptt', state: 'up' });
  const heard = await waitFor('听到按住时说的话', (m) => m.type === 'heard');
  ok('松开后识别成一句指令', /星期/.test(heard.text), heard.text);
  const c2 = await waitFor('第三轮授权', (m) => m.type === 'confirm');
  brain.send({ type: 'confirm_answer', id: c2.id, answer: 'deny' });
  const done3 = await waitFor('第三轮完成', (m) => m.type === 'done');
  ok('按住说话的指令照常执行', /没让删/.test(done3.text), done3.text);

  // 5. 按得太短（多半是在按快捷键）：不算
  await sleep(300);
  fresh();
  brain.send({ type: 'ptt', state: 'down' });
  await waitFor('短按聆听', (m) => m.type === 'listening' && m.mode === 'ptt');
  brain.send({ type: 'ptt', state: 'up' });
  const short = await waitFor('短按不算', (m) => m.type === 'listen_timeout' && m.mode === 'ptt');
  ok('短按不算一句话', !!short);

  // 6. 授权提示第二次用缓存，不再找声音服务生成
  const asked = (ttsLog.match(/请宿主授权/g) || []).length;
  ok('「请宿主授权」只生成过一次', asked === 1, `生成了 ${asked} 次`);
} catch (e) {
  fails++;
  console.log('✗', e.message);
}
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
finish(fails ? 1 : 0);
