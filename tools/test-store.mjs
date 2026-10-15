// 个人数据（store.mjs）、配置读写、翻页口令的单元测试：全在临时目录里，不碰真实数据。node tools/test-store.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Store, dayOf } from '../brain/store.mjs';
import { parseNav } from '../brain/intent.mjs';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-store-'));
const store = new Store(path.join(tmp, 'data'));

// ---- 系统日志 ----
const seen = [];
store.onLog((e) => seen.push(e));
store.log('cmd', '运行命令：Get-ChildItem', 'Get-ChildItem D:\\Downloads');
store.log('auth', '删除 3 个文件 → 宿主拒绝（语音）');
store.log('err', '剪映 点击 没成功', 'UIA busy');
ok('写日志时通知面板', seen.length === 3);
const today = store.readLog(dayOf());
ok('读今天的日志：新的在前', today.length === 3 && today[0].type === 'err', JSON.stringify(today.map((e) => e.type)));
ok('按类型筛', store.readLog(dayOf(), { type: 'auth' }).length === 1);
ok('按词搜（也搜细节）', store.readLog(dayOf(), { q: 'downloads' }).length === 1);
// 过期的日志自动删
const old = dayOf(Date.now() - 40 * 86400_000);
fs.writeFileSync(path.join(store.logDir, `${old}.jsonl`), JSON.stringify({ at: 1, type: 'sys', text: '旧的' }) + '\n');
fs.appendFileSync(path.join(store.logDir, `${dayOf()}.jsonl`), '{"at":1,"type":"sys","text":"写到一半\n');
ok('日志按天列出', store.logDays().includes(old) && store.logDays()[0] === dayOf());
ok('写坏的一行跳过，不影响别的', store.readLog(dayOf()).length === 3);
ok('超过 30 天的删掉', store.prune(30) === 1 && !store.logDays().includes(old));

// ---- 任务记录 ----
const base = Date.now() - 3600_000;
store.addTask({ id: 'a', at: base, text: '打开计算器算七加八', result: 'ok', answer: '【结果：15】', steps: [], tools: 3, seconds: 12 });
store.addTask({ id: 'b', at: base + 1000, text: '删掉下载里的安装包', result: 'deny', answer: '宿主没让删', steps: [], tools: 1, seconds: 15 });
store.addTask({ id: 'c', at: base + 2000, text: '导出剪映视频', result: 'fail', answer: '导出对话框只认前台点击', steps: [], tools: 5, seconds: 48 });
let r = store.tasks();
ok('任务记录：新的在前', r.items.map((t) => t.id).join('') === 'cba');
ok('按结果筛', store.tasks({ result: 'deny' }).items[0]?.id === 'b');
ok('按词搜（指令和结果都搜）', store.tasks({ q: '前台' }).items[0]?.id === 'c' && store.tasks({ q: '计算器' }).items.length === 1);
r = store.tasks({ limit: 2 });
ok('分页：还有更早的', r.items.length === 2 && r.more);
ok('分页：往前翻', store.tasks({ before: r.items.at(-1).at }).items[0]?.id === 'a');

// ---- 对话：用 pi 真的写一个存盘文件 ----
const t0 = Date.now() - 7200_000;
function writeSession(msgs) {
  const sm = SessionManager.create(tmp, store.sessionsDir);
  for (const [role, text, extra] of msgs) {
    if (role === 'user') sm.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
    else sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text }, ...(extra || [])], api: 'openai-completions', provider: 'deepseek', model: 'x', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
  }
  return sm.getSessionFile();
}
const f1 = writeSession([
  ['user', '（现在是 2026/10/15 周四 14:02）\n打开计算器，算一下七加八'],
  ['assistant', '计算器已在后台打开。【结果：7 + 8 = 15】'],
  ['user', '（现在是 2026/10/15 周四 14:05）\n哈哈这个太好笑了'],
  ['assistant', '[ignore]'],
  ['user', '（现在是 2026/10/15 周四 14:06）\n剪映的导出按钮在哪'],
  ['assistant', '[sleep] 剪映的导出按钮在右上角。'],
]);
ok('pi 写出了存盘文件', fs.existsSync(f1 || ''), String(f1));
// 换个话题：另一个文件（文件名按时间排）
await new Promise((res) => setTimeout(res, 20));
writeSession([['user', '（现在是 2026/10/15 周四 18:41）\n今天天气怎么样'], ['assistant', '本系统查不到天气，需要联网。']]);
const all = store.allMessages();
ok('读出宿主和系统的话', all.filter((m) => m.role !== 'divider').length === 6, JSON.stringify(all.map((m) => m.role)));
ok('去掉每句开头的时间', all[0].text === '打开计算器，算一下七加八', all[0].text);
ok('当成闲聊忽略的那一问一答不显示', !all.some((m) => /好笑|\[ignore\]/.test(m.text)));
ok('回复开头的 [sleep] 这类标记去掉', all.some((m) => m.text === '剪映的导出按钮在右上角。'));
ok('换话题的地方有一条分隔', all.some((m) => m.role === 'divider'));
const page = store.chat({ limit: 2 });
ok('往上翻：最近 2 条、还有更早的', page.items.length === 2 && page.more && page.items[1].text.includes('天气'));
ok('往上翻：before 之前的', store.chat({ before: page.items[0].at, limit: 50 }).items.every((m) => m.at < page.items[0].at));
const hits = store.searchChat('剪映 导出');
ok('翻以前的对话：每个词都要有', hits.length === 1 && hits[0].role === 'user' && /导出按钮在右上角/.test(hits[0].reply), JSON.stringify(hits));
ok('翻以前的对话：搜不到返回空', store.searchChat('火星').length === 0);
ok('最近的存盘文件', store.latestSession() === store.sessionFiles().at(-1) && store.sessionFiles().length === 2);

// ---- 配置读写：只写跟默认不一样的，手写的项保留 ----
process.env.HOSTBOUND_CONFIG = path.join(tmp, 'config.json');
fs.writeFileSync(process.env.HOSTBOUND_CONFIG, JSON.stringify({ model: { thinking: 'high' }, myNote: '手写的' }, null, 2));
const { saveConfig } = await import('../brain/config.mjs');
let c = saveConfig(tmp, 'ui.panelOpacity', 0.6);
ok('改一项：合并后的配置里生效', c.ui.panelOpacity === 0.6 && c.ui.petSize === 76);
c = saveConfig(tmp, 'model.thinking', 'low');
const file = JSON.parse(fs.readFileSync(process.env.HOSTBOUND_CONFIG, 'utf8'));
ok('改回默认值：从文件里去掉', !file.model && file.myNote === '手写的' && file.ui.panelOpacity === 0.6, JSON.stringify(file));
c = saveConfig(tmp, 'safety.blockedApps', ['微信']);
ok('数组也能存', c.safety.blockedApps[0] === '微信');

// ---- 翻页口令 ----
const NAV = [['系统，打开设置', 'set'], ['看看日志', 'log'], ['回到对话', 'chat'], ['打开任务记录', 'rec'], ['打开快捷键设置', 'set:keys'], ['打开安全中心', 'set:safe']];
for (const [t, want] of NAV) {
  const n = parseNav(t);
  ok(`翻页：「${t}」`, n && (n.sub ? `${n.page}:${n.sub}` : n.page) === want, JSON.stringify(n));
}
for (const t of ['打开记录本', '把日志删了', '打开设置里的蓝牙', '声音', '对话', '帮我记录一下今天的开销']) ok(`不是翻页：「${t}」`, parseNav(t) === null, JSON.stringify(parseNav(t)));

// ---- 唤醒词自动转拼音：跟 README 里的例子一样、每个音节模型都认识 ----
const { kwsTokens } = await import('../brain/pinyin.mjs');
const kwsDir = fs.readdirSync(path.resolve('models')).find((n) => n.startsWith('sherpa-onnx-kws-zipformer-wenetspeech'));
const known = new Set(fs.readFileSync(path.resolve('models', kwsDir, 'tokens.txt'), 'utf8').split(/\r?\n/).map((l) => l.split(' ')[0]));
for (const [t, want] of [['系统启动', 'x ì t ǒng q ǐ d òng'], ['呼叫系统', 'h ū j iào x ì t ǒng'], ['你好系统', 'n ǐ h ǎo x ì t ǒng'], ['我要说话', 'w ǒ y ào sh uō h uà'], ['重新开始', 'ch óng x īn k āi sh ǐ']]) {
  const got = kwsTokens(t);
  ok(`拼音：${t}`, got === want && got.split(' ').every((x) => known.has(x)), got);
}
let threw = '';
try {
  kwsTokens('hey系统');
} catch (e) {
  threw = e.message;
}
ok('拼音：夹了字母的不收', /只能是汉字/.test(threw));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
