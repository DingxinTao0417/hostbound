// 系统任务（tasks.mjs）的单元测试：假时钟、假的程序列表和电源、临时文件夹，不碰真实数据。node tools/test-tasks.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tasks, FolderWatch, parseAt, nextRun, describeSchedule, isTempFile } from '../brain/tasks.mjs';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostbound-tasks-'));
const MIN = 60_000;

// ---- 时间 ----
const base = new Date(2026, 9, 15, 14, 30, 0).getTime(); // 电脑本地时间 10 月 15 日 14:30
ok('「23:00」：今天 23 点', parseAt('23:00', base) === new Date(2026, 9, 15, 23, 0).getTime());
ok('「9:00」已经过了：明天 9 点', parseAt('9:00', base) === new Date(2026, 9, 16, 9, 0).getTime());
ok('「明天 9点半」', parseAt('明天 9点半', base) === new Date(2026, 9, 16, 9, 30).getTime());
ok('「2026-10-20 08:05」', parseAt('2026-10-20 08:05', base) === new Date(2026, 9, 20, 8, 5).getTime());
const sh = parseAt('2026-10-20 08:00', base, 'Asia/Shanghai');
ok('指定时区：北京时间 8 点 = UTC 0 点', sh === Date.UTC(2026, 9, 20, 0, 0), new Date(sh).toISOString());
let bad = '';
try {
  parseAt('下周吧', base);
} catch (e) {
  bad = e.message;
}
ok('看不懂的时间：说清楚怎么写', /看不懂/.test(bad));
ok('每天 23 点：下次', nextRun({ kind: 'cron', expr: '0 23 * * *' }, base) === new Date(2026, 9, 15, 23, 0).getTime());
ok('每天 23 点：过了就是明天', nextRun({ kind: 'cron', expr: '0 23 * * *' }, new Date(2026, 9, 15, 23, 30).getTime()) === new Date(2026, 9, 16, 23, 0).getTime());
ok('每隔 30 分钟', nextRun({ kind: 'every', everyMs: 30 * MIN, anchor: base }, base + 31 * MIN) === base + 60 * MIN);
ok('写成人话：每天 / 每周一 / 一次', describeSchedule({ kind: 'cron', expr: '0 23 * * *' }) === '每天 23:00' && describeSchedule({ kind: 'cron', expr: '0 10 * * 1' }) === '每周一 10:00' && /一次/.test(describeSchedule({ kind: 'at', at: base })));
ok('临时文件认得出', isTempFile('a.zip.crdownload') && isTempFile('x.part') && isTempFile('~$doc.docx') && !isTempFile('vlog.mp4'));

// ---- 定时任务：假时钟 ----
let clock = base;
const file = path.join(tmp, 'tasks.json');
const cfg = { timezone: '', watch: { downloads: false, battery: false, live: false } };
let tasks = new Tasks({ file, cfg, now: () => clock }).start();
const fired = [];
const created = [];
tasks.on('fire', (e) => fired.push(e));
tasks.on('created', (e) => created.push(e));
const water = tasks.create({ name: '补充水分', say: '宿主，该补充水分了。', in_minutes: 30 });
ok('半小时后：下次 = 现在 + 30 分钟', water.nextAt === base + 30 * MIN && created.length === 1);
tasks.create({ name: '该睡觉了', cron: '0 23 * * *' });
tasks.create({ name: '看后台数据', do: '看一眼 B 站后台数据并汇报', at: '明天 10:00' });
ok('存盘了', JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length === 3);
ok('时间给两种：报错', /四|一种/.test((() => { try { tasks.create({ name: 'x', in_minutes: 1, at: '23:00' }); } catch (e) { return e.message; } })() || ''));
ok('过去的时间：报错', /过去/.test((() => { try { tasks.create({ name: 'x', at: '2026-10-15 08:00' }); } catch (e) { return e.message; } })() || ''));
clock = base + 30 * MIN + 100;
tasks.tick();
ok('到点：发出提醒', fired.length === 1 && fired[0].task.name === '补充水分' && fired[0].late === 0);
ok('一次的任务到点后删掉', !tasks.snapshot().tasks.some((t) => t.name === '补充水分'));
const sn = tasks.snooze(fired[0].task, 10);
ok('过十分钟再提醒', sn.nextAt === clock + 10 * MIN && sn.say === '宿主，该补充水分了。');
ok('取消：按名字里的词', tasks.cancel('补充').length === 1 && !tasks.snapshot().tasks.some((t) => t.name === '补充水分'));
tasks.stop();

// 关机期间错过：开机后补一次，重复的往后排
clock = new Date(2026, 9, 16, 11, 0).getTime(); // 第二天 11 点才开机
tasks = new Tasks({ file, cfg, now: () => clock });
const late = [];
tasks.on('fire', (e) => late.push(e));
tasks.start();
ok('错过的提醒：开机补上，说明错过多久', late.length === 2 && late.every((e) => e.late > 0), JSON.stringify(late.map((e) => [e.task.name, e.late])));
const sleep = tasks.snapshot().tasks.find((t) => t.name === '该睡觉了');
ok('重复的任务：补完往后排到下一次', sleep && sleep.nextAt === new Date(2026, 9, 16, 23, 0).getTime());
ok('「到点去做」的任务带着要做的事', late.some((e) => e.task.do === '看一眼 B 站后台数据并汇报'));
ok('提醒过的记下来', tasks.snapshot().fired.length >= 2);
tasks.stop();

// ---- 文件写完了吗 ----
const dl = path.join(tmp, 'Downloads');
fs.mkdirSync(dl);
fs.writeFileSync(path.join(dl, 'old.zip'), 'x'.repeat(100));
const old = Date.now() - 3600_000;
fs.utimesSync(path.join(dl, 'old.zip'), old / 1000, old / 1000);
const ready = [];
const fw = new FolderWatch({ dir: dl, stableSeconds: 2, onReady: (f) => ready.push(f) }).start();
// 浏览器下载：先写 .crdownload，写完改名
const part = path.join(dl, 'obs-studio-32.zip.crdownload');
fs.writeFileSync(part, 'a'.repeat(1000));
await wait(400);
fs.appendFileSync(part, 'b'.repeat(1000));
await wait(400);
fs.renameSync(part, path.join(dl, 'obs-studio-32.zip'));
// 另一个文件一直在变大（还没写完）
const grow = path.join(dl, 'video.mp4');
fs.writeFileSync(grow, 'c');
for (let i = 0; i < 5; i++) {
  await wait(500);
  fs.appendFileSync(grow, 'c'.repeat(500));
}
ok('改名后的下载：写完就报', ready.some((f) => f.name === 'obs-studio-32.zip') && !ready.some((f) => /crdownload/.test(f.name)), JSON.stringify(ready.map((f) => f.name)));
ok('还在变大的文件：先不报', !ready.some((f) => f.name === 'video.mp4'));
await wait(3500);
ok('不再变大以后：报了', ready.some((f) => f.name === 'video.mp4' && f.size === 2501));
ok('以前就有的旧文件：不报', !ready.some((f) => f.name === 'old.zip'));
ok('同一个文件只报一次', ready.filter((f) => f.name === 'obs-studio-32.zip').length === 1);
fw.stop();

// ---- 宿主让盯着的：文件夹、程序；自带的：电量、直播 ----
const procs = new Set(['explorer.exe', 'ffmpeg.exe']);
let power = { ac: false, battery: true, percent: 40, secondsLeft: 3000 };
const obsDir = path.join(tmp, 'obs-logs');
fs.mkdirSync(obsDir);
const cfg2 = { timezone: '', watch: { downloads: false, battery: true, live: true, liveApps: ['livehime.exe', '直播伴侣.exe'] } };
tasks = new Tasks({
  file: path.join(tmp, 'tasks2.json'),
  cfg: cfg2,
  win: { processNames: () => procs, powerStatus: () => power },
  obsLogDir: obsDir,
  stableSeconds: 1,
  intervals: { batteryFirst: 50, battery: 150, liveFirst: 50, live: 150, process: 150 },
}).start();
const reports = [];
const lives = [];
tasks.on('report', (r) => reports.push(r));
tasks.on('live', (l) => lives.push(l));
const out = path.join(tmp, 'export');
fs.mkdirSync(out);
const w1 = tasks.watch({ name: '剪映导出完成', kind: 'folder', path: out, pattern: '*.mp4', say: '宿主，视频导出好了。' });
ok('建监测：存盘', JSON.parse(fs.readFileSync(path.join(tmp, 'tasks2.json'), 'utf8')).watches[0]?.id === w1.id);
fs.writeFileSync(path.join(out, 'cover.png'), 'p');
fs.writeFileSync(path.join(out, 'vlog-1015.mp4'), 'v'.repeat(3000));
const w2 = tasks.watch({ name: '渲染结束', kind: 'process', process: 'ffmpeg' });
ok('等程序退出：名字补上 .exe', w2.process === 'ffmpeg.exe');
ok('等没在运行的程序：报错', /没在运行/.test((() => { try { tasks.watch({ name: 'x', kind: 'process', process: 'nope.exe' }); } catch (e) { return e.message; } })() || ''));
ok('盯不存在的文件夹：报错', /不存在/.test((() => { try { tasks.watch({ name: 'x', kind: 'folder', path: path.join(tmp, 'nope') }); } catch (e) { return e.message; } })() || ''));
await wait(2600);
const exp = reports.find((r) => r.kind === 'watch' && r.title === '剪映导出完成');
ok('导出完成：报告（只认 mp4）', exp && exp.text === 'vlog-1015.mp4' && exp.say === '宿主，视频导出好了。' && !reports.some((r) => r.text === 'cover.png'), JSON.stringify(reports));
ok('报告一次就撤掉', !tasks.snapshot().watches.some((w) => w.id === w1.id));
procs.delete('ffmpeg.exe');
await wait(600);
ok('程序退出：报告', reports.some((r) => r.title === '渲染结束' && /退出/.test(r.text)));

// 电量：没插电、掉到 20% 以下报一次，10% 以下再报一次，插上电重来
power = { ac: false, battery: true, percent: 19, secondsLeft: 2400 };
await wait(400);
power = { ac: false, battery: true, percent: 18, secondsLeft: 2300 };
await wait(400);
const low = reports.filter((r) => r.kind === 'battery');
ok('电量低于 20%：报一次', low.length === 1 && low[0].level === 20 && /二十/.test(low[0].say) && /40 分钟/.test(low[0].meta), JSON.stringify(low));
power = { ac: false, battery: true, percent: 9, secondsLeft: 600 };
await wait(400);
ok('电量低于 10%：再报一次', reports.filter((r) => r.kind === 'battery').at(-1)?.level === 10);
power = { ac: true, battery: true, percent: 9, secondsLeft: null };
await wait(400);
ok('插着电：不报', reports.filter((r) => r.kind === 'battery').length === 2);

// 直播：直播软件开着，或者 OBS 日志里最后是「开始推流」
procs.add('直播伴侣.exe');
await wait(400);
ok('直播伴侣开着：算在直播', lives.at(-1)?.on === true && lives.at(-1).source === '直播伴侣');
procs.delete('直播伴侣.exe');
await wait(400);
ok('直播伴侣关了：不算了', lives.at(-1)?.on === false);
fs.writeFileSync(path.join(obsDir, '2026-10-15 14-00-00.txt'), '14:00:00.000: ==== Recording Start ====\n');
procs.add('obs64.exe');
await wait(400);
ok('OBS 只是在录制：不算直播', !tasks.snapshot().live);
fs.appendFileSync(path.join(obsDir, '2026-10-15 14-00-00.txt'), '14:05:00.000: ==== Streaming Start ===============================================\n');
await wait(400);
ok('OBS 开始推流：算在直播', lives.at(-1)?.on === true && lives.at(-1).source === 'OBS 推流');
fs.appendFileSync(path.join(obsDir, '2026-10-15 14-00-00.txt'), '15:05:00.000: ==== Streaming Stop ================================================\n');
await wait(400);
ok('OBS 停止推流：不算了', lives.at(-1)?.on === false);
cfg2.watch.live = false;
tasks.applyConfig();
ok('设置里关掉：停止检测', !tasks.snapshot().builtin.live && tasks.snapshot().builtin.battery);

// 工具
const tools = Object.fromEntries(tasks.tools().map((t) => [t.name, t]));
const r1 = await tools.task_create.execute('1', { name: '交稿', at: '23:59' });
ok('工具：建任务', /已发布：交稿/.test(r1.content[0].text));
ok('工具：看任务', /交稿/.test((await tools.task_list.execute('2', {})).content[0].text));
ok('工具：取消', /已取消：交稿/.test((await tools.task_cancel.execute('3', { id: '交稿' })).content[0].text));
tasks.stop();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
