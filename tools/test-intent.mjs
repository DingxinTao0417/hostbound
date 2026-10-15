// 退下 / 指令 / 确认这几条规则的正反例：node tools/test-intent.mjs
import { isDismiss, looksLikeCommand, parseConfirm, parseReminderAnswer } from '../brain/intent.mjs';

const cases = [
  // [函数, 输入, 期望]
  [isDismiss, '没事了', true],
  [isDismiss, '好了，没事了，你去睡吧。', true],
  [isDismiss, '行，谢谢系统，拜拜', true],
  [isDismiss, '没有了', true],
  [isDismiss, '那你再躺会儿吧', true],
  [isDismiss, '你去歇着吧', true],
  [isDismiss, '你去帮我躺着看看', false],
  [isDismiss, '好了，系统待机吧', true],
  [isDismiss, '这个系统不错', false],
  [isDismiss, '帮我把没事了那个文件删了', false],
  [isDismiss, '今天没事干', false],
  [isDismiss, '好的', false],
  [looksLikeCommand, '帮我打开记事本', true],
  [looksLikeCommand, '再看看下载文件夹', true],
  [looksLikeCommand, '把这个关了', true],
  [looksLikeCommand, '你能不能查一下天气', true],
  [looksLikeCommand, '现在几点了', false],
  [looksLikeCommand, '哈哈哈笑死我了', false],
  [looksLikeCommand, '你们看这个弹幕', false],
  [looksLikeCommand, '等下我去倒杯水', false],
  [parseConfirm, '允许', 'allow'],
  [parseConfirm, '授权', 'allow'],
  [parseConfirm, '不授权', 'deny'],
  [parseConfirm, '全部授权', 'all'],
  [parseConfirm, '可以，关吧', 'allow'],
  [parseConfirm, '好的', 'allow'],
  [parseConfirm, 'OK', 'allow'],
  [parseConfirm, '不行', 'deny'],
  [parseConfirm, '不可以', 'deny'],
  [parseConfirm, '算了别删了', 'deny'],
  [parseConfirm, '拒绝', 'deny'],
  [parseConfirm, '这次都允许', 'all'],
  [parseConfirm, '都可以', 'all'],
  [parseConfirm, '嗯嗯', null],
  [parseConfirm, '哈哈这个弹幕说可以的我觉得也是', null],
  [parseConfirm, '等一下', null],
  // 到点提醒以后的回答
  [parseReminderAnswer, '知道了', 'ack'],
  [parseReminderAnswer, '好的。', 'ack'],
  [parseReminderAnswer, '过十分钟再提醒我', { snooze: 10 }],
  [parseReminderAnswer, '五分钟后再叫我', { snooze: 5 }],
  [parseReminderAnswer, '半小时后再提醒', { snooze: 30 }],
  [parseReminderAnswer, '一个小时后再提醒', { snooze: 60 }],
  [parseReminderAnswer, '稍后提醒', { snooze: 10 }],
  [parseReminderAnswer, '提醒我明天交稿', null],
  [parseReminderAnswer, '帮我打开计算器', null],
];

let bad = 0;
for (const [fn, input, want] of cases) {
  const got = fn(input);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(ok ? '  ' : '✗ ', fn.name.padEnd(16), JSON.stringify(input).padEnd(28), '→', JSON.stringify(got), ok ? '' : `（应该是 ${JSON.stringify(want)}）`);
}
console.log(bad ? `\n${bad} 个不对` : '\n全部正确');
process.exit(bad ? 1 : 0);
