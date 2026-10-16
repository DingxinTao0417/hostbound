// 项目模式：干活的智能体做什么不用问、什么要问宿主。
// 项目文件夹里读写文件、装依赖、跑脚本都放行；出了项目文件夹、全局安装、关机改系统这类，照常要宿主授权。
// 干活的智能体（pi）在 tool_call 钩子里用它；Claude Code 通过 tools/project-hook.mjs 用它。这是一道提醒网，不是沙箱。
import path from 'node:path';
import os from 'node:os';
import { assessRisk, isInside } from './risk.mjs';

// 在项目文件夹里做就不用问的几类
const SAFE_IN_PROJECT = new Set(['删除文件', '移动、复制或改名文件', '写入文件', '强制新建（可能覆盖）文件', '把输出写进文件', '覆盖已有文件', '修改文件', '安装或卸载软件', '联网下载或上传', '运行脚本文件']);
// 就算在项目里也要问：装到全局、装到系统里的
const GLOBAL_INSTALL = /(?:^|[\s;|&])(?:npm|pnpm|yarn)\s+(?:i|install|add|remove|uninstall)\b[^\n;|&]*(?:\s-g\b|--global)|(?:^|[\s;|&])(?:winget|choco|scoop)\b|Install-Module|Install-Package|(?:^|[\s;|&])pip3?\s+install\b[^\n;|&]*--user/im;
// 命令里写着的绝对路径（C:\…、D:/…）、家目录
const ABS_PATH = /(?:^|[\s'"=(])([a-zA-Z]:[\\/][^\s'";|&)]*)/g;
const HOME_REF = /(?:\$env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles|SystemRoot|windir)|\$HOME\b|~[\\/]|%USERPROFILE%|%APPDATA%)/i;

// 命令里提到了项目文件夹以外的地方吗（系统临时文件夹不算）
export function outsidePaths(command, dir) {
  const tmp = os.tmpdir();
  const out = [];
  for (const m of String(command || '').matchAll(ABS_PATH)) {
    const p = m[1].replace(/[\\/]+$/, '');
    if (!p || isInside(p, dir) || isInside(p, tmp)) continue;
    out.push(p);
  }
  return out;
}

// event：{ toolName, input }；dir：项目文件夹；cwd：这个智能体干活的地方（它那份 worktree，在项目文件夹里）
// 返回 null（放行）或 { label, detail }（要问宿主）
export function projectRisk(event, { dir, cwd = dir }) {
  const input = event.input || {};
  const t = event.toolName;
  if (t === 'write' || t === 'edit') {
    const file = path.resolve(cwd, String(input.path || input.file_path || ''));
    return isInside(file, dir) ? null : { label: '改项目文件夹外面的文件', detail: file };
  }
  if (t !== 'powershell' && t !== 'bash') return null;
  const command = String(input.command || '');
  if (GLOBAL_INSTALL.test(command)) return { label: '装到全局 / 装进系统', detail: command };
  const risk = assessRisk(event, cwd);
  const outside = outsidePaths(command, dir);
  // 没危险、也没碰外面：放行
  if (!risk && !outside.length) return null;
  if (!risk) {
    // 只是读外面的东西（比如 Get-ChildItem C:\…）也放行；写外面的另算
    return null;
  }
  if (SAFE_IN_PROJECT.has(risk.label) && !outside.length && !HOME_REF.test(command)) return null;
  return { label: outside.length ? `${risk.label}（项目文件夹外面）` : risk.label, detail: command };
}
