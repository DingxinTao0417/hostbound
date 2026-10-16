// 项目模式里 Claude Code 的授权钩子（PreToolUse）。Claude Code 在 -p 模式下没法弹窗问人，所以：
// 项目文件夹里的寻常操作直接放行；要宿主点头的，写一个请求文件到 HOSTBOUND_CONFIRM_DIR，
// 等系统（project-workers.mjs 的 CliWorker）把宿主的回答写回来。规则跟 pi 干活的智能体一样（brain/project-gate.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectRisk } from '../brain/project-gate.mjs';

const out = (decision, reason = '') => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  let ev = {};
  try {
    ev = JSON.parse(raw || '{}');
  } catch {}
  const dir = process.env.HOSTBOUND_PROJECT_DIR;
  const confirmDir = process.env.HOSTBOUND_CONFIRM_DIR;
  if (!dir) out('ask', '不在宿主系统的项目里');
  const name = String(ev.tool_name || '');
  const input = ev.tool_input || {};
  const toolName = /^(Bash|PowerShell)$/.test(name) ? 'powershell' : /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name) ? 'write' : name.toLowerCase();
  const risk = projectRisk({ toolName, input: { command: input.command, path: input.file_path || input.notebook_path || input.path } }, { dir, cwd: ev.cwd || process.cwd() });
  if (!risk) out('allow');
  if (!confirmDir) out('deny', `要宿主授权：${risk.label}`);
  fs.mkdirSync(confirmDir, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const req = path.join(confirmDir, `${id}.json`);
  const ans = path.join(confirmDir, `${id}.answer`);
  fs.writeFileSync(req, JSON.stringify({ label: risk.label, detail: String(risk.detail || '').slice(0, 600), tool: name }));
  const t0 = Date.now();
  while (Date.now() - t0 < 14 * 60_000) {
    if (fs.existsSync(ans)) {
      const a = fs.readFileSync(ans, 'utf8').trim();
      try {
        fs.rmSync(ans, { force: true });
        fs.rmSync(req, { force: true });
      } catch {}
      if (a === 'allow') out('allow', '宿主允许了');
      out('deny', '宿主没允许这个操作。换个不需要它的做法；实在绕不开，最后一条消息写 QUESTION: 说明。');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fs.rmSync(req, { force: true });
  out('deny', '等了很久宿主都没回应，这个操作没做。');
});
