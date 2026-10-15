// 端到端测试大脑：起一个假模型，拉起后台进程，发一句话，遇到确认就点“拒绝”，打印全过程
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-test-'));
fs.writeFileSync(
  path.join(tmp, 'models.json'),
  JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:5199/v1', api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1' }] } } }),
);
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false } }));

const mock = fork(path.join(root, 'tools', 'mock-llm.cjs'), [], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 400));

const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_DEBUG: '1', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data') },
});

let said = '';
const finish = (code) => {
  brain.kill();
  mock.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(code);
};
setTimeout(() => {
  console.log('超时');
  finish(1);
}, 30000);

brain.on('message', (m) => {
  if (m.type === 'level') return;
  if (m.type === 'say') {
    said += m.delta;
    return;
  }
  if (m.type === 'say_start') said = '';
  console.log('←', JSON.stringify(m));
  if (m.type === 'brain_ready') {
    // --voice：用录音走“喊名字 → 说指令”的完整语音流程；否则直接发文字
    if (process.argv.includes('--voice')) brain.send({ type: 'debug_feed_wav', path: path.join(root, 'tools', 'testwav', 'wake_then_cmd.wav') });
    else brain.send({ type: 'prompt', text: '今天几号？顺便把 C 盘那个测试文件删了' });
  }
  if (m.type === 'confirm') brain.send({ type: 'confirm_answer', id: m.id, answer: 'deny' });
  if (m.type === 'tool_end' || m.type === 'tool') said && console.log('   (系统说)', said);
  if (m.type === 'done') {
    console.log('   (最终回复)', m.text);
    finish(0);
  }
  if (m.type === 'error' || m.type === 'brain_missing') finish(1);
});
