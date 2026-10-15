// 「哪些话念、怎么念、在哪断句」的正反例：node tools/test-speakable.mjs
import { toSpeech, SpeechSplitter, splitForSpeech } from '../brain/speakable.mjs';

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? '✓' : '✗', name.padEnd(22), ok ? '' : `\n    得到 ${JSON.stringify(got)}\n    应为 ${JSON.stringify(want)}`);
};

eq('【】结论', toSpeech('【完成】日期已查到。'), '完成，日期已查到。');
eq('路径只念文件名', toSpeech('已保存到 D:\\成品\\第3期.mp4。'), '已保存到 第3期.mp4。');
eq('盘符', toSpeech('文件在 C:\\ 根目录'), '文件在 C盘 根目录');
eq('网址', toSpeech('已打开 https://www.bilibili.com/ 首页'), '已打开 链接 首页');
eq('算式', toSpeech('7+8=15'), '7加8等于15');
eq('百分号', toSpeech('磁盘占用 50%'), '磁盘占用 百分之50');
eq('日期', toSpeech('今天是 2026-10-14'), '今天是 2026年10月14日');
eq('时间', toSpeech('21:30 提醒你，09:00 开会'), '21点30分 提醒你，9点 开会');
eq('范围', toSpeech('大约 3-5 分钟'), '大约 3到5 分钟');
eq('代码块不念', toSpeech('```js\nconsole.log(1)\n```'), '');
eq('行内命令', toSpeech('用 `Get-Date` 查到了'), '用 Get-Date 查到了');
eq('行内代码不念', toSpeech('运行 `a = f(x);` 即可'), '运行 即可');
eq('表格不念', toSpeech('| 名称 | 大小 |'), '');
eq('列表符号', toSpeech('- 打开记事本'), '打开记事本');
eq('表情', toSpeech('好的😀'), '好的');
eq('只有标点', toSpeech('，，。'), '');
eq('结尾逗号变句号', toSpeech('【失败】'), '失败。');

// 流式断句：偏移量基于去掉 [sleep] 标记后的显示文字
{
  const s = new SpeechSplitter();
  const got = [...s.push('[sl'), ...s.push('eep] 系统进入'), ...s.push('待机。')];
  eq('标记分几次到', got.map((x) => [x.start, x.end, x.speak]), [[0, 7, '系统进入待机。']]);
  eq('显示文字', s.text, '系统进入待机。');
}
{
  const s = new SpeechSplitter();
  const a = s.push('收到，先查询日期。然后');
  eq('句号处切', a.map((x) => x.text), ['收到，先查询日期。']);
  eq('剩下的等结束再切', s.flush().map((x) => x.text), ['然后']);
}
{
  const s = new SpeechSplitter();
  const long = '这是一句很长的话，没有句号，系统会一直往下说，说到超过四十个字的时候，应该在逗号处先切一段，免得等太久';
  const segs = [...s.push(long), ...s.flush()];
  eq('长句在逗号处切', segs.length >= 2 && segs.every((x) => x.text.length <= 48), true);
  eq('切完拼回原文', segs.map((x) => x.text).join(''), long);
}
{
  const s = new SpeechSplitter();
  const text = '结果如下：\n```\nGet-Date\n```\n完成。';
  const segs = [...s.push(text.slice(0, 12)), ...s.push(text.slice(12)), ...s.flush()];
  eq('代码块成段且不念', segs.map((x) => [x.text, x.speak]), [
    ['结果如下：\n', '结果如下：'],
    ['```\nGet-Date\n```', ''],
    ['\n', ''],
    ['完成。', '完成。'],
  ]);
  eq('段首尾相接', segs.every((x, i) => i === 0 || x.start === segs[i - 1].end), true);
}
{
  const s = new SpeechSplitter();
  const segs = [...s.push('[ignore]'), ...s.flush()];
  eq('只有标记什么都不念', segs, []);
}
eq('整段固定的话', splitForSpeech('任务失败。无法连接模型服务器，请检查网络。').map((x) => x.speak), ['任务失败。', '无法连接模型服务器，请检查网络。']);

console.log(fails ? `\n${fails} 个没通过` : '\n全部正确');
process.exit(fails ? 1 : 0);
