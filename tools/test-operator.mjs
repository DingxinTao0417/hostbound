// 任务统计、步骤条、接管前台的单元测试（不碰真鼠标键盘）：node tools/test-operator.mjs
import { Operator, parseAppState, pngSize } from '../brain/operator.mjs';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(cond ? '✓' : '✗', name, cond ? '' : extra);
};

// 一段跟 Open Computer Use 一样格式的界面描述（计算器）。坐标是相对窗口左上角的物理像素（screen.mjs 用它解析）
const STATE = [
  'App=calc (pid 100)',
  'Window: "计算器", App: calc.',
  '\t0 window 计算器 Frame: {x: 0, y: 0, width: 480, height: 760}',
  '\t\t1 button 七 Frame: {x: 20, y: 400, width: 100, height: 80}',
  '\t\t2 button 加 Secondary Actions: ScrollIntoView Frame: {x: 350, y: 500, width: 100, height: 80}',
  '\t\t3 edit 密码 Frame: {x: 20, y: 100, width: 400, height: 40}',
].join('\n');
// 1×1 的 PNG 文件头里改成 480×760
const png = Buffer.alloc(33);
png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
png.writeUInt32BE(13, 8);
png.write('IHDR', 12);
png.writeUInt32BE(480, 16);
png.writeUInt32BE(760, 20);
const PNG = png.toString('base64');

const st = parseAppState(STATE);
ok('读出窗口标题', st.title === '计算器', st.title);
ok('读出窗口大小', JSON.stringify(st.window) === JSON.stringify({ x: 0, y: 0, width: 480, height: 760 }));
ok('读出元素（去掉 Secondary Actions）', st.elements.get('2')?.name === '加' && st.elements.size === 4, JSON.stringify([...st.elements]));
ok('PNG 宽高', JSON.stringify(pngSize(PNG)) === JSON.stringify({ width: 480, height: 760 }));

const op = new Operator({ ownPids: [] });
const fx = [];
const events = [];
op.on('fx', (m) => fx.push(m));
for (const ev of ['steps', 'takeover_request', 'takeover_state']) op.on(ev, (m) => events.push({ ev, m }));
op.taskStart();

// 每个工具调用都算一个动作（操作软件界面的效果在 test-screen.mjs 里测）
for (const toolName of ['powershell', 'read_app', 'click']) {
  await op.beforeTool({ toolName, input: {} });
  op.afterTool({ toolName, input: {}, content: [], isError: false });
}

// 任务步骤
const tools = Object.fromEntries(op.tools().map((x) => [x.name, x]));
ok('新工具都在', ['task_steps', 'look_screen', 'request_foreground', 'fg_click', 'fg_type', 'fg_key'].every((n) => tools[n]));
events.length = 0;
await tools.task_steps.execute('1', { steps: ['打开计算器', '读取界面', '输入 7+8', '汇报'], done: 0 });
await tools.task_steps.execute('2', { done: 2 });
const last = events.filter((e) => e.ev === 'steps').at(-1)?.m;
ok('任务步骤：只给 done 也能更新', last?.steps.length === 4 && last.done === 2, JSON.stringify(last));

// 接管前台：宿主选「稍后」→ 不接管；没接管时不能动真鼠标
op.on('takeover_request', (r) => setTimeout(() => op.answerTakeover(r.id, 'later'), 50));
const later = await tools.request_foreground.execute('3', { app: 'calc', reason: '点导出', seconds: 5 });
ok('接管前台：宿主选稍后就不接管', /没空|稍后/.test(later.content[0].text) && !op.takeover, later.content[0].text);
let threw = '';
try {
  await tools.fg_click.execute('4', { x: 10, y: 10 });
} catch (e) {
  threw = e.message;
}
ok('没有接管时 fg_click 被拒绝（不会动真鼠标）', /没有前台控制权/.test(threw), threw);

// 任务结束：清掉扫描框、光标回家
fx.length = 0;
const stats = op.taskEnd();
ok('任务结束：清掉扫描框、光标回家', fx.some((m) => m.kind === 'scan' && m.all) && fx.some((m) => m.kind === 'home'));
ok('任务统计：动作数', stats.tools === 3, JSON.stringify(stats));

console.log(fails ? `\n${fails} 项没通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
