// 鉴定术端到端测试（假模型 + 临时数据目录，不截屏、不开窗口）：node tools/test-appraise-brain.mjs
// 说「我要鉴定」→ 让桌面进鉴定模式；桌面发来裁好的图 → 卡片边出边发 → 存档、念、对话里的小卡
// → 接着问带上那张图 → 对话记录里有鉴定卡 → 帮我处理 → 全屏扫描 → 出错 → 清空存档
import { fork } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-appraise-brain-'));
const PORT = 5193;
fs.writeFileSync(path.join(tmp, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'mock-1', input: ['text', 'image'] }] } } }));
fs.writeFileSync(path.join(tmp, 'auth.json'), '{}');
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({ model: { provider: 'mock', id: 'mock-1', thinking: 'off' }, workdir: tmp, watch: { downloads: false, battery: false, live: false }, memory: { autoReview: false, embed: { chat: false } } }),
);

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

// ---- 假模型 ----
const seen = []; // { kind: appraise | scan | chat, text, images }
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '');
const imagesOf = (c) => (Array.isArray(c) ? c.filter((x) => x.type === 'image_url').length : 0);
function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: '' }));
  for (let i = 0; i < text.length; i += 6) res.write(chunk({ content: text.slice(i, i + 6) }));
  res.write(chunk({}, 'stop'));
  res.end('data: [DONE]\n\n');
}
let appraiseReply = '';
let failNext = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    const sys = textOf(j.messages.find((m) => m.role === 'system' || m.role === 'developer')?.content);
    const lastUser = j.messages.filter((m) => m.role === 'user').at(-1);
    const text = textOf(lastUser?.content);
    const images = j.messages.filter((m) => m.role === 'user').reduce((n, m) => n + imagesOf(m.content), 0);
    if (/鉴定术：宿主在屏幕上框出了一块/.test(sys)) {
      seen.push({ kind: 'appraise', text, images: imagesOf(lastUser.content) });
      if (failNext) {
        failNext = false;
        return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'server overloaded' } }));
      }
      return sse(res, appraiseReply);
    }
    if (/全屏扫描/.test(sys) && /每块屏幕的截图/.test(sys)) {
      seen.push({ kind: 'scan', text, images: imagesOf(lastUser.content) });
      return sse(res, 'w1：在看视频网站，播放到 12:40\nw2：不该出现的标签\n评价：宿主正在看视频。');
    }
    const lastImgs = imagesOf(lastUser?.content);
    seen.push({ kind: 'chat', text, images: lastImgs, total: images });
    return sse(res, `收到：${text.replace(/^（[^）]*）\n/gm, '').slice(0, 30)}`);
  });
});
await new Promise((r) => server.listen(PORT, r));

const brain = fork(path.join(root, 'brain', 'index.mjs'), [], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  env: { ...process.env, HOSTBOUND_SPEECH_MODE: 'off', HOSTBOUND_CONFIG: path.join(tmp, 'config.json'), HOSTBOUND_MODELS_PATH: path.join(tmp, 'models.json'), HOSTBOUND_AUTH_PATH: path.join(tmp, 'auth.json'), HOSTBOUND_DATA_DIR: path.join(tmp, 'data') },
});
const msgs = [];
brain.on('message', (m) => msgs.push(m));
function waitFor(pred, ms = 20000, from = msgs.length) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = msgs.slice(from).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error('等不到：' + pred.toString().slice(0, 90)));
      setTimeout(tick, 30);
    };
    tick();
  });
}
const ask = (text, extra = {}) => {
  const p = waitFor((m) => m.type === 'done' || m.type === 'error');
  brain.send({ type: 'prompt', text, ...extra });
  return p;
};
let rid = 200;
const request = (msg, type) => {
  const reqId = ++rid;
  const p = waitFor((m) => m.type === type && m.reqId === reqId);
  brain.send({ ...msg, reqId });
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timer = setTimeout(() => {
  console.log('超时');
  process.exit(1);
}, 120000);
// 一张 16×16 的真 JPEG（pi 会先解码、缩放再发，假数据会被它丢掉）
const IMG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDySiiiv6gPsz//2Q==';

try {
  await waitFor((m) => m.type === 'brain_ready');

  // ---- 说「我要鉴定」：让桌面进鉴定模式，不问模型 ----
  const before = seen.length;
  let mark = msgs.length;
  brain.send({ type: 'prompt', text: '系统，我要鉴定' });
  const st = await waitFor((m) => m.type === 'appraise_start', 5000, mark);
  const hint = await waitFor((m) => m.type === 'appraise_hint', 5000, mark);
  ok('说「我要鉴定」：桌面进选择，面板冒一句，不问模型', st.mode === 'select' && /点窗口、拖框/.test(hint.text) && seen.length === before);
  mark = msgs.length;
  brain.send({ type: 'prompt', text: '扫描全屏' });
  ok('说「扫描全屏」：直接扫', (await waitFor((m) => m.type === 'appraise_start', 5000, mark)).mode === 'screen');

  // ---- 桌面发来框好的图 ----
  appraiseReply = '名称：寒铁长剑\n风格：系统流\n品质：史诗\n类别：装备 · 单手剑\n属性：攻击 +128　暴击 +6%\n评价：同等级里的上等货。\n建议：换。\n念：寒铁长剑，史诗品质。同等级里的上等货。\n动作：无';
  mark = msgs.length;
  brain.send({ type: 'appraise_state', open: true });
  brain.send({ type: 'appraise_req', id: 'a1', kind: 'region', label: '', question: '值不值得换？', image: { data: IMG, mimeType: 'image/jpeg', width: 176, height: 190 }, thumb: IMG, masked: 0 });
  const res1 = await waitFor((m) => m.type === 'appraise_result' && m.id === 'a1', 20000, mark);
  const parts = msgs.slice(mark).filter((m) => m.type === 'appraise_part' && m.id === 'a1');
  ok('鉴定：模型收到了图和宿主问的那句', seen.at(-1).kind === 'appraise' && seen.at(-1).images === 1 && /值不值得换/.test(seen.at(-1).text));
  ok('鉴定：卡片边出边发（先出名称）', parts[0]?.part === 'name' && parts[0].value === '寒铁长剑' && parts.some((p) => p.part === 'rarity' && p.value === '史诗'), JSON.stringify(parts.slice(0, 3)));
  ok('鉴定：完整的卡片', res1.ok && res1.card.name === '寒铁长剑' && res1.card.fields.length === 2 && res1.card.advice === '换。');
  const mini = await waitFor((m) => m.type === 'appraise_card' && m.rec.id === 'a1', 5000, mark);
  ok('对话里的小卡：带缩略图', mini.rec.name === '寒铁长剑' && /^data:image\/jpeg;base64,/.test(mini.rec.thumb) && mini.rec.rarity === '史诗');
  ok('存档：文字 + 缩略图在 data/appraisals', fs.existsSync(path.join(tmp, 'data', 'appraisals', 'a1.jpg')) && /寒铁长剑/.test(fs.readFileSync(path.join(tmp, 'data', 'appraisals', 'index.jsonl'), 'utf8')));

  // ---- 接着问：带上那张图和鉴定结果；再下一句就不带了 ----
  await ask('跟我身上那把比呢？');
  const q1 = seen.at(-1);
  ok('接着问：这句话带上了那张图', q1.kind === 'chat' && q1.images === 1, JSON.stringify(q1));
  ok('接着问：大脑知道刚鉴定了什么', /宿主刚才在面板上：鉴定了屏幕上的一块：寒铁长剑，史诗品质/.test(q1.text), q1.text.slice(0, 200));
  await ask('好的');
  ok('再下一句：不再带图', seen.at(-1).images === 0);
  const hist = await request({ type: 'chat_history', limit: 40 }, 'chat_history');
  const idx = hist.items.findIndex((m) => m.role === 'appraise');
  ok('对话记录：鉴定卡按时间插在那两句前面，宿主的话干干净净', idx >= 0 && hist.items[idx].rec.name === '寒铁长剑' && /^data:image/.test(hist.items[idx].rec.thumb) && hist.items[idx + 1]?.text === '跟我身上那把比呢？', JSON.stringify(hist.items.map((m) => m.role + ':' + (m.text || m.rec?.name))));

  // ---- 实用：报错 → 帮我处理 ----
  appraiseReply = '名称：缺少运行库\n风格：实用\n标签：报错\n是什么：VC++ 运行库没装\n怎么办：装微软官方的 VC++ 运行库\n评价：装上就好。\n念：缺少运行库，装上就好。\n动作：帮我处理';
  mark = msgs.length;
  brain.send({ type: 'appraise_req', id: 'a2', kind: 'window', label: '剪辑软件.exe - 系统错误', app: { title: '剪辑软件.exe - 系统错误', exe: 'editor.exe' }, question: '', image: { data: IMG, mimeType: 'image/jpeg', width: 330, height: 140 }, thumb: IMG, masked: 0 });
  const res2 = await waitFor((m) => m.type === 'appraise_result' && m.id === 'a2', 20000, mark);
  ok('鉴定窗口：模型知道是哪个窗口；卡片是实用的', /「剪辑软件\.exe - 系统错误」这个窗口/.test(seen.at(-1).text) && res2.card.tag === '报错' && res2.card.actions.includes('fix'));
  const fixDone = waitFor((m) => m.type === 'done');
  brain.send({ type: 'appraise_action', id: 'a2', action: 'fix' });
  await fixDone;
  ok('帮我处理：交给大脑，带上图', /帮我处理刚才鉴定的「缺少运行库」：装微软官方的 VC\+\+ 运行库|帮我处理刚才鉴定的「缺少运行库」：装上就好/.test(seen.at(-1).text) && seen.at(-1).images === 1, JSON.stringify(seen.at(-1)).slice(0, 200));
  mark = msgs.length;
  brain.send({ type: 'appraise_action', id: 'a1', action: 'followup' });
  const fu = await waitFor((m) => m.type === 'appraise_followup', 5000, mark);
  ok('追问：让面板起个头', fu.id === 'a1' && fu.name === '寒铁长剑');
  await ask('关于刚才鉴定的「寒铁长剑」：能卖多少钱', { appraise: 'a1' });
  ok('点了某张卡的追问：带那张图', seen.at(-1).images === 1);

  // ---- 全屏扫描 ----
  mark = msgs.length;
  brain.send({
    type: 'appraise_scan_req',
    id: 's1',
    count: 2,
    screens: [{ id: '1', image: { data: IMG, mimeType: 'image/jpeg', width: 1600, height: 900 }, windows: [{ id: 'w1', exe: 'chrome.exe', title: '视频网站', rect: { x: 0, y: 0, width: 800, height: 600 }, masked: false }, { id: 'w2', exe: 'wechat.exe', title: '', rect: { x: 900, y: 0, width: 400, height: 600 }, masked: true }] }],
  });
  const done = await waitFor((m) => m.type === 'appraise_scan_done' && m.id === 's1', 20000, mark);
  const tags = msgs.slice(mark).filter((m) => m.type === 'appraise_tag');
  ok('扫描：模型只看到没涂黑的窗口', seen.at(-1).kind === 'scan' && /w1：chrome\.exe/.test(seen.at(-1).text) && !/wechat/.test(seen.at(-1).text));
  ok('扫描：标签一个一个发，涂黑的不收', tags.length === 1 && tags[0].windowId === 'w1' && tags[0].label === '在看视频网站，播放到 12:40');
  ok('扫描：评价、对话里一张汇总卡', done.verdict === '宿主正在看视频。' && msgs.slice(mark).some((m) => m.type === 'appraise_card' && m.rec.kind === 'scan'));

  // ---- 出错 ----
  failNext = true;
  mark = msgs.length;
  brain.send({ type: 'appraise_req', id: 'a3', kind: 'region', label: '', question: '', image: { data: IMG, mimeType: 'image/jpeg', width: 50, height: 50 }, thumb: IMG, masked: 0 });
  const res3 = await waitFor((m) => m.type === 'appraise_result' && m.id === 'a3', 30000, mark);
  ok('模型出错：卡片上说清楚', !res3.ok && /服务器繁忙|过载|500|overloaded/.test(res3.error), res3.error);

  // ---- 日志、存档 ----
  const log = await request({ type: 'log_query', logType: 'screen' }, 'log');
  ok('系统日志：鉴定发了什么给模型都记了', ['鉴定：框住的一块（176×190），截图发给了模型', '鉴定：窗口「剪辑软件.exe - 系统错误」', '鉴定结果：寒铁长剑（史诗）', '全屏扫描：1 块屏幕、2 个窗口'].every((w) => log.items.some((e) => e.text.includes(w))), JSON.stringify(log.items.map((e) => e.text)));
  const info = await request({ type: 'appraise_info' }, 'appraise_info');
  ok('存档：3 张卡（两次鉴定 + 一次扫描）', info.count === 3, JSON.stringify(info));
  await request({ type: 'appraise_clear' }, 'appraise_info');
  ok('清空存档', (await request({ type: 'appraise_info' }, 'appraise_info')).count === 0 && !fs.existsSync(path.join(tmp, 'data', 'appraisals', 'a1.jpg')));
} catch (e) {
  fails++;
  console.log('✗ 出错', e.message);
}

clearTimeout(timer);
brain.kill();
server.close();
await sleep(400);
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {}
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
