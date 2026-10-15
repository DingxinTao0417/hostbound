// Hostbound 用的 agent-browser 包装：参数原样转给 agent-browser 本体，另外做两件事：
// 1. open 最多等 15 秒。B 站这类页面一直有东西在加载，原版 open 会一直等“加载完成”卡住；超时后页面照样在加载，直接 snapshot 就能用。
// 2. 让网页操作「看得见」：在系统里运行时（有 HOSTBOUND_FX_URL），点击、填写之前先查出元素在屏幕上的位置报给系统，
//    系统光标飞过去之后再真正点；读页面时报告扫描框。查不到位置也不影响原本的操作。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
const args = process.argv.slice(2);
const cmdAt = args.findIndex((a) => !a.startsWith('-'));
const cmd = args[cmdAt];
const FX = process.env.HOSTBOUND_FX_URL;
const REFS = path.join(os.tmpdir(), 'hostbound-agent-browser-refs.txt'); // 上一次 snapshot 的结果：用来查 @e12 是什么按钮
const ACT = { click: '点击', dblclick: '双击', fill: '填写', type: '输入', hover: '指向', check: '勾选', uncheck: '取消勾选', select: '选择' };
const SECRET = /密码|口令|password|验证码/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 跑一次 agent-browser，拿到输出（给查位置用，不转出去）
function capture(argv, ms = 6000) {
  return new Promise((resolve) => {
    const child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), ms);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('error', () => resolve(''));
  });
}
const data = (out) => {
  try {
    return JSON.parse(out).data;
  } catch {
    return null;
  }
};

// 浏览器窗口在屏幕上的位置（DIP），以及页面内容区左上角
async function geometry() {
  const d = data(await capture(['eval', 'JSON.stringify([screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, location.host])', '--json'], 3000));
  if (!d?.result) return null;
  const [sx, sy, ow, oh, iw, ih, host] = JSON.parse(d.result);
  const border = Math.max(0, (ow - iw) / 2);
  return { win: { x: sx, y: sy, width: ow, height: oh }, origin: { x: sx + border, y: sy + (oh - ih) - border }, host };
}

async function post(m) {
  try {
    await fetch(FX, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m), signal: AbortSignal.timeout(600) });
  } catch (e) {
    if (process.env.HOSTBOUND_FX_DEBUG) console.error('[fx] 报告失败', e.message);
  }
}

// @e12 在上一次 snapshot 里是什么（按钮名字、是不是密码框）
function refInfo(sel) {
  const ref = /^@?(e\d+)$/.exec(sel || '')?.[1];
  if (!ref) return { name: sel, secret: false };
  try {
    const line = fs.readFileSync(REFS, 'utf8').split('\n').find((l) => l.includes(`[ref=${ref}]`)) || '';
    const m = line.match(/-\s*([\w-]+)\s+"([^"]*)"/);
    return { name: m ? m[2] || m[1] : ref, secret: SECRET.test(line) };
  } catch {
    return { name: ref, secret: false };
  }
}

async function beforeAction() {
  if (!FX || !cmd) return;
  if (ACT[cmd] && args[cmdAt + 1]) {
    const sel = args[cmdAt + 1];
    const [g, box] = await Promise.all([geometry(), capture(['get', 'box', sel, '--json']).then(data)]);
    if (!g || !box?.width) return;
    const info = refInfo(sel);
    const rect = { x: g.origin.x + box.x, y: g.origin.y + box.y, width: box.width, height: box.height };
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await post({ kind: 'scan', key: 'browser', rect: g.win, phase: 'locked', label: `已锁定 · ${g.host || '网页'}`, sub: 'Chrome' });
    await post({ kind: 'click', rect, point, label: `${ACT[cmd]} · ${info.name.slice(0, 16)}` });
    if ((cmd === 'fill' || cmd === 'type') && args[cmdAt + 2] != null) await post({ kind: 'type', rect, text: info.secret ? '••••' : args[cmdAt + 2] });
    await sleep(520);
  } else if (cmd === 'press' && args[cmdAt + 1]) {
    const g = await geometry();
    if (g) await post({ kind: 'keys', rect: g.win, keys: args[cmdAt + 1] });
  } else if (cmd === 'snapshot') {
    const g = await geometry();
    if (g) await post({ kind: 'scan', key: 'browser', rect: g.win, phase: 'scanning', label: `扫描中 · ${g.host || '网页'}`, sub: 'Chrome' });
  }
}

async function afterAction(out) {
  if (cmd === 'snapshot') {
    try {
      fs.writeFileSync(REFS, out);
    } catch {}
  }
  if (!FX) return;
  if (cmd === 'snapshot' || ['open', 'goto', 'navigate'].includes(cmd)) {
    const g = await geometry();
    const count = cmd === 'snapshot' ? (out.match(/\[ref=/g) || []).length : null;
    if (g) await post({ kind: 'scan', key: 'browser', rect: g.win, phase: 'locked', label: `已锁定 · ${g.host || '网页'}`, sub: count != null ? `${count} 元素` : 'Chrome', host: g.host, count });
  }
}

await beforeAction().catch((e) => process.env.HOSTBOUND_FX_DEBUG && console.error('[fx] 出错', e.stack));

// 不能用 stdio: 'inherit'：第一次 open 会顺带拉起 agent-browser 的后台进程和 Chrome，它们会继承输出管道一直不放，
// PowerShell 就会一直等这个管道关闭而卡死。所以这里自己接管输出再转出去，等本体退出就结束
const isOpen = ['open', 'goto', 'navigate'].includes(cmd);
const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));
let timer = null;
let finished = false;
const finish = async (code) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  await afterAction(out).catch(() => {});
  process.exit(code ?? 0);
};
if (isOpen) {
  timer = setTimeout(() => {
    child.kill();
    console.log('（页面还在加载，已经可以用 snapshot -i 读页面了）');
    finish(0);
  }, 15000);
}
child.on('exit', (code) => finish(code));
child.on('error', (e) => {
  console.error(`agent-browser 启动失败：${e.message}`);
  process.exit(1);
});
