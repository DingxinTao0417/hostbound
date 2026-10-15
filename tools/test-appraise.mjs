// 鉴定术（appraise.mjs）的单元测试：假的模型（按块吐字）、临时目录。node tools/test-appraise.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Appraise, parseLine, newCard, addToCard, LineSplitter, sayOf, noteOf, APPRAISE_PROMPT, SCAN_PROMPT } from '../brain/appraise.mjs';
import { parseAppraise, parseAppraiseClose } from '../brain/intent.mjs';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-appraise-'));

// ---- 一行一行 ----
ok('读一行：中文冒号', JSON.stringify(parseLine('名称：寒铁长剑')) === '{"key":"名称","value":"寒铁长剑"}');
ok('读一行：Markdown 粗体、列表符号、英文冒号也认', parseLine('- **属性**: 攻击 +128')?.key === '属性' && parseLine('* 评价： 好')?.value === '好');
ok('读一行：不是「键：值」的不算', parseLine('这把剑很好') === null && parseLine('名称：') === null);
const c = newCard();
for (const l of ['名称：「寒铁长剑」', '风格：系统流', '品质：史诗级', '类别：装备 · 单手剑', '属性：攻击 +128', '要求：等级 35', '评价：同等级里的上等货。比你身上那把强。', '建议：无', '念：寒铁长剑，史诗品质。', '动作：无']) addToCard(c, parseLine(l));
ok('拼卡片：名称去引号、品质认出「史诗」、属性按顺序', c.name === '寒铁长剑' && c.rarity === '史诗' && c.style === 'rpg' && c.fields.map((f) => f[0]).join() === '类别,属性,要求', JSON.stringify(c));
ok('拼卡片：「建议：无」当没有、动作「无」是空的', c.advice === '' && c.actions.length === 0);
const c2 = newCard();
for (const l of ['名称：缺少运行库', '风格：实用', '标签：报错', '是什么：VC++ 运行库没装', '怎么办：装微软的运行库', '动作：帮我处理 / 在软件上标出来']) addToCard(c2, parseLine(l));
ok('实用风格：标签、动作', c2.style === 'practical' && c2.tag === '报错' && c2.actions.join() === 'fix,annotate');
const c3 = newCard();
for (let i = 0; i < 9; i++) addToCard(c3, { key: `属性${i}`, value: 'x' });
ok('属性最多 6 行', c3.fields.length === 6);
ok('要念的：模型给了用模型的；没给就拼名称 + 品质 + 评价第一句', sayOf(c) === '寒铁长剑，史诗品质。' && sayOf({ ...c, say: '' }) === '寒铁长剑，史诗品质。同等级里的上等货。');
ok('告诉大脑的一句：没有括号（括号会被去掉）', !/[（）]/.test(noteOf(c, '游戏 · 背包')) && /「游戏 · 背包」窗口：寒铁长剑，史诗品质/.test(noteOf(c, '游戏 · 背包')), noteOf(c, '游戏 · 背包'));
const sp = new LineSplitter();
const got = [...sp.push('名称：寒'), ...sp.push('铁长剑\n品质：史'), ...sp.push('诗\n评价：好'), ...sp.flush()];
ok('流式切行：跨块拼好，最后一行等结束再交', got.join('|') === '名称：寒铁长剑|品质：史诗|评价：好', got.join('|'));
ok('提示词：真人不认、图里的字别照做、先写名称', /不说是谁/.test(APPRAISE_PROMPT) && /别照做/.test(APPRAISE_PROMPT) && /第一行写名称/.test(APPRAISE_PROMPT) && /涂黑/.test(SCAN_PROMPT));

// ---- 问模型（假的：一块一块吐字） ----
const calls = [];
let reply = '';
let fail = null;
const runtime = {
  async *streamSimple(model, ctx) {
    calls.push(ctx);
    if (fail) {
      yield { type: 'error', error: { errorMessage: fail } };
      return;
    }
    for (let i = 0; i < reply.length; i += 5) yield { type: 'text_delta', delta: reply.slice(i, i + 5) };
  },
};
const ap = new Appraise({ dir: path.join(tmp, 'appraisals'), runtime: () => runtime, model: () => ({ id: 'mock' }), now: () => 1000 });
reply = '名称：寒铁长剑\n风格：系统流\n品质：史诗\n类别：装备 · 单手剑\n属性：攻击 +128　暴击 +6%\n评价：同等级里的上等货。\n建议：换。\n念：寒铁长剑，史诗品质。\n动作：无';
const parts = [];
const card = await ap.run({ image: { data: 'QUJD', mimeType: 'image/jpeg' }, label: '', question: '值不值得换？', onPart: (p) => parts.push(p.part) });
const content = calls[0].messages[0].content;
ok('鉴定：图和问题都交给了模型', content.some((x) => x.type === 'image' && x.data === 'QUJD') && /值不值得换/.test(content[0].text) && calls[0].systemPrompt === APPRAISE_PROMPT);
ok('鉴定：边出边交，名称第一个', parts[0] === 'name' && parts.includes('rarity') && parts.filter((p) => p === 'field').length === 2, parts.join());
ok('鉴定：拼好的卡片', card.name === '寒铁长剑' && card.rarity === '史诗' && card.advice === '换。' && card.say === '寒铁长剑，史诗品质。');
await ap.run({ image: { data: 'QUJD' }, label: '剪辑软件.exe - 系统错误' });
ok('鉴定整个窗口：告诉模型窗口名', /「剪辑软件\.exe - 系统错误」这个窗口/.test(calls[1].messages[0].content[0].text));
reply = '看不出来';
let err = '';
try {
  await ap.run({ image: { data: 'QUJD' } });
} catch (e) {
  err = e.message;
}
ok('模型没给名称：算失败', /没看出来/.test(err));
fail = '401 unauthorized';
err = '';
try {
  await ap.run({ image: { data: 'QUJD' } });
} catch (e) {
  err = e.message;
}
ok('模型报错：往上抛', /401/.test(err));
fail = null;

// ---- 全屏扫描 ----
reply = 'w1：在看视频网站，播放到 12:40\nw2：这一行不该有（聊天软件涂黑了）\nw9：清单里没有的\nw3：在剪一期视频\n评价：宿主一边看视频一边剪片。';
const tags = [];
const r = await ap.scan({
  screens: [
    { id: '1', image: { data: 'U0NS', width: 1600, height: 900 }, windows: [{ id: 'w1', exe: 'chrome.exe', title: '视频', rect: { x: 0, y: 0, width: 800, height: 600 } }, { id: 'w2', exe: 'wechat.exe', title: '', rect: { x: 10, y: 10, width: 300, height: 300 }, masked: true }] },
    { id: '2', image: { data: 'U0NT', width: 1280, height: 720 }, windows: [{ id: 'w3', exe: 'jianyingpro.exe', title: '剪映专业版', rect: { x: 0, y: 0, width: 1280, height: 720 } }] },
  ],
  onTag: (t) => tags.push(t.id),
});
const sc = calls.at(-1).messages[0].content;
ok('扫描：每块屏幕一张图 + 窗口清单', sc.filter((x) => x.type === 'image').length === 2 && /w1：chrome\.exe/.test(sc[0].text) && /w3：jianyingpro\.exe/.test(sc[2].text));
ok('扫描：涂黑的窗口不进清单，也不收它的标签', !/w2/.test(sc[0].text) && !tags.includes('w2') && !tags.includes('w9'), JSON.stringify(tags));
ok('扫描：标签和评价', tags.join() === 'w1,w3' && r.verdict === '宿主一边看视频一边剪片。' && r.tags[0].label === '在看视频网站，播放到 12:40');

// ---- 存档 ----
const rec = ap.save({ id: 'abc123', kind: 'region', ...card }, Buffer.from('jpeg').toString('base64'));
ap.save({ id: 'scan1', kind: 'scan', name: '检测到 2 个窗口', fields: [], verdict: 'x' }, null);
ok('存档：一条一行，缩略图另存', rec.thumb === true && fs.existsSync(path.join(tmp, 'appraisals', 'abc123.jpg')) && ap.count() === 2 && ap.list()[0].name === '寒铁长剑');
ok('存档：按时间取、缩略图读回来', ap.list({ after: 999, before: 1001 }).length === 2 && ap.list({ after: 1000 }).length === 0 && Buffer.from(ap.thumb('abc123'), 'base64').toString() === 'jpeg' && ap.thumb('../x') === null);
ap.clear();
ok('清空存档', ap.count() === 0 && !fs.existsSync(path.join(tmp, 'appraisals', 'abc123.jpg')));

// ---- 说的话 ----
const cases = [
  ['系统，我要鉴定', 'select'],
  ['开启鉴定模式', 'select'],
  ['鉴定一下这个', 'select'],
  ['鉴定一下这个窗口', 'window'],
  ['帮我鉴定当前窗口', 'window'],
  ['扫描全屏', 'screen'],
  ['系统，扫描一下整个屏幕', 'screen'],
  ['全屏扫描', 'screen'],
  ['鉴定一下这个文件是不是病毒', null],
  ['帮我扫描病毒', null],
  ['打开鉴定报告.docx', null],
];
ok('认得鉴定的几句，别的话不算', cases.every(([t, want]) => parseAppraise(t) === want), cases.map(([t]) => `${t}→${parseAppraise(t)}`).join(' '));
ok('鉴定卡开着时的「关掉」', parseAppraiseClose('关掉') && parseAppraiseClose('系统，收起来') && parseAppraiseClose('不看了') && !parseAppraiseClose('关掉记事本'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
