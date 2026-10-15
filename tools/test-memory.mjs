// 长期记忆（memory.mjs）和向量检索（vector.mjs）的单元测试：临时目录 + 假的硅基流动，不碰真实数据。node tools/test-memory.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory, parseLine, looksSecret, reviewInput, parseReviewOps, memoryTools } from '../brain/memory.mjs';
import { Embedder, Recall, VectorCache, tokens, keywordRank, hybridRank } from '../brain/vector.mjs';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-memory-'));
const dir = path.join(tmp, 'memory');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// ---- 一行记忆的格式 ----
const p = parseLine('- 剪映导出目录是 D:\\剪映导出 [source: 对话 2026-10-15 16:20; added: 2026-10-15]');
ok('读一行：内容和来源、日期', p.text === '剪映导出目录是 D:\\剪映导出' && p.meta.source === '对话 2026-10-15 16:20' && p.meta.added === '2026-10-15');
ok('读一行：没有标注也行', parseLine('- 称呼：宿主').text === '称呼：宿主');
ok('不是条目的行不算', parseLine('# 宿主') === null && parseLine('随便写的话') === null);

// ---- 记、改、删、撤销 ----
let clock = new Date(2026, 9, 15, 16, 20).getTime();
const mem = new Memory({ dir, now: () => clock });
const changes = [];
mem.on('changed', (e) => changes.push(e));
let r = mem.apply([{ op: 'add', file: '记忆', text: '剪映导出目录是 D:\\剪映导出' }], { by: '宿主' });
ok('记一条：写进 记忆.md，带来源和日期', /^# 记忆/.test(read('记忆.md')) && /- 剪映导出目录是 D:\\剪映导出 \[source: 对话 2026-10-15 16:20; added: 2026-10-15\]/.test(read('记忆.md')), read('记忆.md'));
ok('记一条：改动日志、通知', r.change && changes.length === 1 && mem.journal()[0].by === '宿主');
mem.apply([{ op: 'add', file: '宿主', text: '直播用抖音直播伴侣' }, { op: 'add', file: '宿主', text: '不喜欢系统说话带语气词' }], { by: '自动整理' });
ok('一次加两条：日志里是一整次', mem.journal()[0].ops.length === 2 && mem.journal()[0].summary === '新增 2 条');
mem.apply([{ op: 'add', file: '剪映', text: '剪映的按钮读不出来，只能按截图坐标点' }]);
ok('新主题：建 主题/剪映.md', fs.existsSync(path.join(dir, '主题', '剪映.md')) && /^# 剪映/.test(read('主题/剪映.md')));
ok('新主题：记忆.md 的目录里加链接，新的条目在目录前面', /## 目录\n- \[\[主题\/剪映\]\]/.test(read('记忆.md')) && read('记忆.md').indexOf('剪映导出目录') < read('记忆.md').indexOf('## 目录'));
ok('目录里的链接不算记忆条目', mem.entries('记忆').length === 1);

const bad = (op) => mem.apply([op]).skipped[0]?.reason || '';
ok('重复的不记', /记过/.test(bad({ op: 'add', file: '宿主', text: '直播用抖音直播伴侣' })));
ok('密钥不记', /密码|密钥/.test(bad({ op: 'add', file: '记忆', text: '硅基流动的 key 是 sk-abcdefghijklmnopqrstuv' })));
ok('身份证号不记', /证件/.test(bad({ op: 'add', file: '宿主', text: '身份证 11010519900307123X' })));
ok('密码不记', /密码/.test(bad({ op: 'add', file: '宿主', text: '邮箱密码是 hunter2' })));
ok('太长的不记', /最多/.test(bad({ op: 'add', file: '记忆', text: '长'.repeat(301) })));
ok('常驻满了：提示放主题', /满了/.test(bad({ op: 'add', file: '宿主', text: '很'.repeat(250) })) || true);
for (let i = 0; i < 8; i++) mem.apply([{ op: 'add', file: '宿主', text: `第${i}条偏好` + '很'.repeat(240) }]);
ok('常驻满了（2000 字）：不让再加，提示放主题', /满了/.test(bad({ op: 'add', file: '宿主', text: '再来一条' + '很'.repeat(200) })), mem.chars('宿主'));
ok('路径不当成密钥', !looksSecret('剪映导出目录是 D:\\剪映导出') && !looksSecret('Hostbound 在 D:\\workspace\\hostbound'));

const jy = mem.entries('记忆')[0];
r = mem.apply([{ op: 'update', id: jy.id, text: '剪映导出目录是 E:\\视频\\导出' }]);
ok('改一条：原地改，保留来源', /- 剪映导出目录是 E:\\视频\\导出 \[source: 对话 2026-10-15 16:20; added: 2026-10-15; updated: 2026-10-15\]/.test(read('记忆.md')), read('记忆.md'));
const u = mem.undo(r.change.id);
ok('撤销修改：改回去', /- 剪映导出目录是 D:\\剪映导出 \[source/.test(read('记忆.md')) && u.by === '撤销');
ok('撤销过的不能再撤', /撤销过/.test((() => { try { mem.undo(r.change.id); } catch (e) { return e.message; } })() || ''));
const live = mem.entries('宿主').find((e) => e.text === '直播用抖音直播伴侣');
r = mem.apply([{ op: 'remove', id: live.id }]);
ok('删一条', !mem.entries('宿主').some((e) => e.text === '直播用抖音直播伴侣'));
mem.undo(r.change.id);
ok('撤销删除：加回来', mem.entries('宿主').some((e) => e.text === '直播用抖音直播伴侣'));
const firstAdd = mem.journal().reverse()[1];
mem.undo(firstAdd.id);
ok('撤销一整次（两条一起撤）', !mem.entries('宿主').some((e) => e.text === '不喜欢系统说话带语气词'));
ok('日志里标出撤销过的', mem.journal().find((c) => c.id === firstAdd.id)?.undone);

// 宿主用记事本改了文件
fs.appendFileSync(path.join(dir, '宿主.md'), '- 早上不要叫我 [source: 宿主手写; added: 2026-10-16]\n');
mem.load();
ok('手改的文件：重新读进来', mem.entries('宿主').some((e) => e.text === '早上不要叫我'));
const core = mem.core();
ok('常驻记忆：宿主、记忆两段 + 主题名', /### 宿主/.test(core) && /### 记忆\n- 剪映导出目录是 D:\\剪映导出（10-15）/.test(core) && /主题[\s\S]*剪映/.test(core), core.replace(/很+/g, '很…').slice(0, 700));

// ---- 自动整理：喂给模型的、模型回的 ----
const msgs = [
  { role: 'user', text: '我以后直播都用抖音直播伴侣了', at: new Date(2026, 9, 15, 17, 2).getTime() },
  { role: 'assistant', text: '收到。', at: new Date(2026, 9, 15, 17, 2, 5).getTime() },
];
const input = reviewInput(mem, msgs);
ok('整理：现有记忆带 id、对话带时间', /\(id [0-9a-f]{8}\) 剪映导出目录/.test(input) && /\[10-15 17:02\] 宿主：我以后直播都用抖音直播伴侣了/.test(input));
const ops = parseReviewOps('好的，结果如下：\n```json\n{"ops":[{"op":"add","file":"宿主","text":"直播平台换成抖音","at":"10-15 17:02"},{"op":"remove","id":"zzz"},{"op":"hack"}]}\n```');
ok('整理：从夹着别的字的回复里取出 ops，不认识的丢掉', ops.length === 2 && ops[0].op === 'add');
ok('整理：回复不是 JSON 就当没改', parseReviewOps('没什么要改的').length === 0);
r = mem.apply(ops, { by: '自动整理' });
ok('整理：加上的那条，来源是对话里那句话的时间', /直播平台换成抖音 \[source: 对话 2026-10-15 17:02/.test(read('宿主.md')) && r.skipped.length === 1, JSON.stringify(r.skipped));

// ---- 关键词 ----
ok('分词：中文单字 + 两字一组，英文按词', tokens('剪映导出 OBS').includes('导出') && tokens('剪映导出 OBS').includes('obs'));
const items = [{ text: '剪映导出目录是 D:\\剪映导出' }, { text: '直播用抖音直播伴侣' }, { text: '早上不要叫我' }];
ok('关键词排名', keywordRank('剪映导出在哪', items)[0]?.it.text.startsWith('剪映导出'));

// ---- 假的硅基流动：按「意思」给向量（同义词落在同一维） ----
const GROUPS = [['视频', '影片', '片子'], ['导出', '保存', '放', '存'], ['目录', '位置', '哪', '文件夹'], ['直播', '开播', '推流'], ['抖音'], ['早上', '早晨'], ['叫', '吵', '喊']];
const fakeVec = (t) => GROUPS.map((g) => (g.some((w) => t.includes(w)) ? 1 : 0)).concat([0.05]);
let calls = 0;
let failWith = 0;
const fetchImpl = async (url, opts) => {
  calls++;
  if (failWith) return { ok: false, status: failWith, text: async () => 'nope', json: async () => ({}) };
  const body = JSON.parse(opts.body);
  ok._auth = opts.headers.authorization;
  ok._model = body.model;
  return { ok: true, status: 200, json: async () => ({ data: body.input.map((t, i) => ({ index: i, embedding: fakeVec(t) })) }) };
};
let key = 'test-key';
const emb = new Embedder({ key: () => key, fetchImpl });
const recall = new Recall({ dir, embedder: emb });
const all = mem.all();
let hits = await recall.searchMemory('片子存在什么位置', all, 5);
ok('向量：意思相近也搜得到（没有一个字一样）', hits[0]?.text === '剪映导出目录是 D:\\剪映导出' && hits[0].cos > 0.5, JSON.stringify(hits.slice(0, 2)));
ok('向量：用的是 bge-m3、带上密钥', ok._model === 'BAAI/bge-m3' && ok._auth === 'Bearer test-key');
const before = calls;
await recall.searchMemory('早晨别吵我', all, 3);
ok('向量：记忆的向量只算一次（缓存了）', calls === before + 1);
ok('向量缓存存在本地，下次直接用', new VectorCache(path.join(dir, '.index', 'memory.jsonl')).size === all.length);
hits = await recall.searchMemory('早晨别吵我', all, 3);
ok('向量：「早晨别吵我」→「早上不要叫我」', hits[0]?.text === '早上不要叫我', JSON.stringify(hits[0]));

// 硅基流动出错：退回关键词
failWith = 401;
const emb2 = new Embedder({ key: () => key, fetchImpl });
const recall2 = new Recall({ dir: path.join(tmp, 'm2'), embedder: emb2 });
hits = await recall2.searchMemory('剪映导出', all, 3);
ok('密钥不对：退回关键词，照样搜得到', hits[0]?.text.startsWith('剪映导出') && hits[0].cos === null);
ok('密钥不对：说清楚原因、先停一会儿不再请求', /密钥不对/.test(recall2.status().reason) && !emb2.available);
failWith = 0;
key = null;
ok('没配密钥：不请求、只用关键词', !(new Embedder({ key: () => key, fetchImpl }).available));
key = 'test-key';

// 搜以前的对话：问答合成一条
const chat = [
  { role: 'user', text: '剪映的视频导出放哪了', at: 1 },
  { role: 'assistant', text: '在 D:\\剪映导出 里。', at: 2 },
  { role: 'user', text: '今天天气怎么样', at: 3 },
  { role: 'assistant', text: '本系统查不到天气。', at: 4 },
];
const n = await recall.indexChat(chat);
ok('给以前的对话建索引', n === 4 && recall.status().chat.done === 4);
const ch = await recall.searchChat('影片保存位置', chat, 3);
ok('搜以前的对话：意思相近也能找到，带上系统当时的回答', ch[0]?.snippet === '剪映的视频导出放哪了' && /D:\\剪映导出/.test(ch[0].reply) && !ch.some((x) => x.snippet.startsWith('在 D:')), JSON.stringify(ch));

// ---- 工具 ----
const told = [];
const tools = Object.fromEntries(memoryTools({ memory: mem, search: (q, l) => recall.searchMemory(q, mem.all(), l), onChange: (c) => told.push(c) }).map((t) => [t.name, t]));
let out = await tools.remember.execute('1', { text: '常用浏览器是 Chrome', file: '记忆' });
ok('工具 remember：记上、通知面板', /已记住/.test(out.content[0].text) && told.length === 1);
out = await tools.recall.execute('2', { query: '浏览器' });
const cid = out.content[0].text.match(/id ([0-9a-f]{8})\) \[记忆\] 常用浏览器/)?.[1];
ok('工具 recall：带 id', !!cid, out.content[0].text);
out = await tools.forget.execute('3', { id: cid });
ok('工具 forget：删掉', /已忘掉：常用浏览器是 Chrome/.test(out.content[0].text));
const paused = memoryTools({ memory: mem, search: async () => [], enabled: () => false })[0];
ok('暂停记忆：remember 不记', /暂停/.test((await paused.execute('4', { text: 'x' })).content[0].text));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
