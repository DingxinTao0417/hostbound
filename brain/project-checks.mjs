// 项目模式的检查：装依赖、构建、测试（命令跑完看退出码），网站类再把它跑起来、等网址能打开、用无头浏览器截一张图。
// 命令都在 PowerShell 里跑；输出只留最后一截（够看出错在哪）。截图用 agent-browser 的单独会话，不用宿主登录过的那个浏览器。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tail = (s, n = 3000) => (s.length > n ? '…' + s.slice(-n) : s);

// 杀掉整棵进程树（开发服务器会再开子进程）
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

// 跑一条命令：{ ok, code, output, ms, timedOut }
export function runCommand(command, { cwd, timeoutMs = 10 * 60_000, env = {}, signal } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}; exit $LASTEXITCODE`], {
      cwd,
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    });
    const add = (d) => {
      out += d.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p.pid);
    }, timeoutMs);
    const abort = () => killTree(p.pid);
    signal?.addEventListener('abort', abort, { once: true });
    p.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: code === 0 && !timedOut, code, output: tail(out.replace(/\x1b\[[0-9;]*m/g, '').trim()), ms: Date.now() - t0, timedOut });
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: e.message, ms: Date.now() - t0, timedOut });
    });
  });
}

// 把项目跑起来，等网址能打开：{ ok, proc, output, ms }；用完记得 stop()
export async function startAndWait(command, url, { cwd, timeoutMs = 90_000, env = {} } = {}) {
  const t0 = Date.now();
  let out = '';
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], {
    cwd,
    windowsHide: true,
    env: { ...process.env, BROWSER: 'none', CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...env },
  });
  proc.stdout.on('data', (d) => (out = (out + d).slice(-20_000)));
  proc.stderr.on('data', (d) => (out = (out + d).slice(-20_000)));
  let exited = false;
  proc.on('close', () => (exited = true));
  const stop = () => killTree(proc.pid);
  while (Date.now() - t0 < timeoutMs) {
    if (exited) return { ok: false, output: tail(out.trim()) || '一启动就退出了', ms: Date.now() - t0, stop };
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return { ok: true, status: r.status, output: tail(out.trim(), 1500), ms: Date.now() - t0, stop };
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  return { ok: false, output: `等了 ${Math.round(timeoutMs / 1000)} 秒，${url} 还是打不开。\n${tail(out.trim(), 1500)}`, ms: Date.now() - t0, stop };
}

// 用 agent-browser 的单独会话打开网址截一张图（不显示窗口、不用宿主的登录状态）
export async function screenshot(url, file, { root, timeoutMs = 60_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const session = `hb-check-${Date.now().toString(36)}`;
  const env = { ...process.env };
  delete env.AGENT_BROWSER_HEADED;
  delete env.AGENT_BROWSER_PROFILE;
  const ab = path.join(root, 'bin', 'agent-browser.cmd');
  const run = (args) =>
    new Promise((resolve) => {
      execFile('cmd.exe', ['/d', '/s', '/c', ab, '--session', session, ...args], { env, windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
    });
  try {
    const o = await run(['open', url]);
    if (!o.ok) return { ok: false, output: tail(o.out, 800) };
    await new Promise((r) => setTimeout(r, 1500));
    const s = await run(['screenshot', file]);
    if (!s.ok || !fs.existsSync(file)) return { ok: false, output: tail(s.out, 800) };
    return { ok: true, file };
  } finally {
    await run(['close']);
  }
}
