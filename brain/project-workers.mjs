// 项目模式里干活的智能体。三种引擎，对总指挥是同一个样子：run(任务) → { status, report }，过程用事件报出来：
//   step  { kind: 'tool' | 'tool_end' | 'say' | 'error', … }   cost  { usd }
// - pi（默认）：跟系统的大脑一样的 pi 会话，在大脑进程里跑。工具 ask_commander 问总指挥（等它回答）、report 汇报。
// - claude：Claude Code（claude -p，stream-json），用宿主自己的 Claude 账号；授权走 tools/project-hook.mjs 钩子。
// - codex：Codex CLI（codex exec --json），沙箱只许写当前文件夹。
// 后两种没有我们的工具：要问就最后一行写 QUESTION:，做完写 REPORT:，系统接着用 resume 叫它。
// 卡住检测：同样的动作、同样的结果重复 4 次就停下交回总指挥；轮数到上限也停。
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { describeTool } from './agent.mjs';
import { killTree } from './project-checks.mjs';

const TOOLS = ['read', 'write', 'edit', 'powershell', 'ls', 'find', 'grep'];
const STUCK_REPEAT = 4;
const short = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : '');

// 同样的动作 + 同样的结果重复几次了
class StuckDetector {
  constructor(limit = STUCK_REPEAT) {
    this.limit = limit;
    this.recent = [];
  }
  push(key) {
    const h = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
    this.recent.push(h);
    if (this.recent.length > 12) this.recent.shift();
    return this.recent.filter((x) => x === h).length >= this.limit;
  }
}

export class PiWorker extends EventEmitter {
  // ask({ question, options }) → 回答（总指挥或者宿主的）；confirm({ label, detail }) → 宿主允不允许；gate(event) → null 或 { label, detail }
  // preview({ path }) → { ok, text, image }：把项目在自己的副本里跑起来、截一张图、关掉（网站类项目才有）
  constructor({ id, role, cwd, sessionDir, modelRuntime, model, system, maxTurns = 80, gate, ask, confirm, preview, log = () => {} }) {
    super();
    Object.assign(this, { id, role, cwd, sessionDir, modelRuntime, model, system, maxTurns, gate, ask, confirm, preview, log });
    this.engine = 'pi';
    this.turns = 0;
    this.usd = 0;
  }

  async #ensure() {
    if (this.session) return;
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => this.system,
      appendSystemPromptOverride: () => [],
      extensionFactories: [(pi) => this.#hooks(pi)],
    });
    await loader.reload();
    const settingsManager = SettingsManager.inMemory();
    const win = this.model?.contextWindow || 128000;
    settingsManager.applyOverrides({ defaultTools: TOOLS, compaction: { enabled: true, reserveTokens: Math.max(16384, win - 100000), keepRecentTokens: 20000 } });
    const sessionManager = SessionManager.create(this.cwd, this.sessionDir);
    const { session } = await createAgentSession({ cwd: this.cwd, model: this.model, thinkingLevel: 'low', modelRuntime: this.modelRuntime, resourceLoader: loader, settingsManager, sessionManager });
    this.session = session;
    session.subscribe((ev) => this.#onEvent(ev));
    await session.bindExtensions({ onError: (e) => this.emit('step', { kind: 'error', text: `扩展出错：${e?.error?.message || e?.message || e}` }) });
  }

  #hooks(pi) {
    pi.on('tool_call', async (event) => {
      if (this.stopReason) return { block: true, reason: '项目停下了，这一轮到此为止，别再做别的。' };
      const risk = this.gate?.(event);
      if (!risk) return undefined;
      const ok = await this.confirm?.({ ...risk, tool: event.toolName });
      return ok ? undefined : { block: true, reason: '宿主没允许这个操作。换个不需要它的做法；实在绕不开，用 ask_commander 跟总指挥说明。' };
    });
    const self = this;
    const ok = (text, details) => ({ content: [{ type: 'text', text }], details });
    pi.registerTool({
      name: 'ask_commander',
      label: '问总指挥',
      description: '拿不准、计划里没写、要改别人负责的地方时，问项目总指挥（会等它回答；需要的话它会去问宿主）。问得具体，能给选项就给。',
      parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
      async execute(_id, p, signal) {
        const answer = await Promise.race([
          Promise.resolve(self.ask?.({ question: p.question, options: p.options || [] })),
          new Promise((res) => signal?.addEventListener?.('abort', () => res('（项目停下了，不用再等了）'), { once: true })),
        ]);
        return ok(String(answer || '总指挥没回答，按你觉得最合理的做，并在汇报里写明你的假设。'));
      },
    });
    if (this.preview) {
      pi.registerTool({
        name: 'preview',
        label: '预览页面',
        description: '看看你做的网页现在长什么样：系统在你的副本里把项目跑起来（用项目的启动命令）、打开网址截一张图给你看，再自己关掉。path 是要看的页面路径（比如 /about），不给就是首页。改完界面要检查时用它，不要自己去启动服务器或者结束进程。',
        parameters: Type.Object({ path: Type.Optional(Type.String()) }),
        async execute(_id, p, signal) {
          const r = await Promise.race([
            Promise.resolve(self.preview({ path: p.path || '' })).catch((e) => ({ ok: false, text: `预览出错：${e?.message || e}` })),
            new Promise((res) => signal?.addEventListener?.('abort', () => res({ ok: false, text: '（项目停下了）' }), { once: true })),
          ]);
          const content = [{ type: 'text', text: r.text }];
          if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType || 'image/png' });
          return { content, details: { ok: r.ok } };
        },
      });
    }
    pi.registerTool({
      name: 'report',
      label: '汇报',
      description: '做完了（status=done）或者做不下去了（status=blocked）时汇报给总指挥。summary 写做了什么、改了哪些文件、自己检查的结果；评审用 issues 列出要改的问题。汇报完这一轮就结束，不要再做别的。',
      parameters: Type.Object({
        status: Type.Union([Type.Literal('done'), Type.Literal('blocked')]),
        summary: Type.String(),
        files: Type.Optional(Type.Array(Type.String())),
        issues: Type.Optional(Type.Array(Type.String())),
        checks: Type.Optional(Type.Object({ install: Type.Optional(Type.String()), build: Type.Optional(Type.String()), test: Type.Optional(Type.String()), start: Type.Optional(Type.String()), url: Type.Optional(Type.String()) })),
      }),
      async execute(_id, p) {
        self.reported = p;
        return ok('已汇报给总指挥。这一轮结束，不要再调用别的工具。');
      },
    });
  }

  #onEvent(ev) {
    switch (ev.type) {
      case 'message_end': {
        const m = ev.message;
        if (m?.role !== 'assistant') break;
        this.turns++;
        const usd = m.usage?.cost?.total || 0;
        if (usd) {
          this.usd += usd;
          this.emit('cost', { usd });
        }
        const text = textOf(m.content).trim();
        if (text) this.emit('step', { kind: 'say', text: short(text, 1200) });
        if (m.errorMessage) this.emit('step', { kind: 'error', text: short(m.errorMessage, 300) });
        if (this.turns >= this.maxTurns && !this.stopReason) this.stop('turns');
        break;
      }
      case 'tool_execution_start': {
        if (ev.toolName === 'report' || ev.toolName === 'ask_commander') break; // 这两个由总指挥那边记
        this.pendingKey = this.pendingKey || new Map();
        this.pendingKey.set(ev.toolCallId, `${ev.toolName}:${JSON.stringify(ev.args || {})}`);
        const a = ev.args || {};
        this.emit('step', { kind: 'tool', id: ev.toolCallId, name: ev.toolName, text: describeTool(ev.toolName, a), detail: short(a.command || a.path || a.pattern || '', 400) });
        break;
      }
      case 'tool_execution_end': {
        if (ev.toolName === 'report' || ev.toolName === 'ask_commander') break;
        const result = short(textOf(ev.result?.content ?? ev.result), 300);
        this.emit('step', { kind: 'tool_end', id: ev.toolCallId, name: ev.toolName, ok: !ev.isError, error: ev.isError ? result : '' });
        this.stuck = this.stuck || new StuckDetector();
        const key = `${this.pendingKey?.get(ev.toolCallId) || ev.toolName}|${result}`;
        this.pendingKey?.delete(ev.toolCallId);
        if (this.stuck.push(key) && !this.stopReason) this.stop('stuck');
        break;
      }
    }
  }

  // 派一个任务（第一次、或者退回来再改）
  async run(text) {
    await this.#ensure();
    this.stopReason = null;
    this.reported = null;
    this.turns = 0;
    this.stuck = new StuckDetector();
    try {
      await this.session.prompt(text);
      if (!this.reported && !this.stopReason) await this.session.prompt('（系统）你还没用 report 汇报。现在就用 report 汇报：做完了写 done；做不下去写 blocked 并说明原因。');
    } catch (e) {
      if (!this.stopReason) return { status: 'error', error: String(e?.message || e) };
    }
    if (this.stopReason) return { status: this.stopReason, report: this.reported };
    if (!this.reported) return { status: 'reported', report: { status: 'done', summary: short(this.session.getLastAssistantText?.() || '', 1500), noReport: true } };
    return { status: this.reported.status === 'blocked' ? 'blocked' : 'reported', report: this.reported };
  }

  // 正在干的时候插一句（宿主经总指挥转来的话）
  async steer(text) {
    if (!this.session) return false;
    try {
      await this.session.prompt(text, { streamingBehavior: 'steer' });
      return true;
    } catch {
      return false;
    }
  }

  stop(reason = 'stopped') {
    this.stopReason = reason;
    this.session?.abort().catch(() => {});
  }

  dispose() {
    try {
      this.session?.dispose();
    } catch {}
    this.session = null;
  }
}

// ---------- Claude Code / Codex：子进程 ----------
// 它们的最后一条消息里找 QUESTION: / REPORT: / BLOCKED:
export function parseFinal(text) {
  const t = String(text || '').trim();
  const q = t.match(/(?:^|\n)\s*QUESTION:\s*([\s\S]+)$/i);
  if (q) return { kind: 'question', text: q[1].trim() };
  const b = t.match(/(?:^|\n)\s*BLOCKED:\s*([\s\S]+)$/i);
  if (b) return { kind: 'blocked', text: b[1].trim() };
  const r = t.match(/(?:^|\n)\s*REPORT:\s*([\s\S]+)$/i);
  return { kind: 'report', text: (r ? r[1] : t).trim() };
}

// 在 PATH 里找可执行文件：.exe 直接跑，.cmd（npm 装的 codex）经 cmd.exe 跑
export function resolveBin(name) {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

export class CliWorker extends EventEmitter {
  // engine：claude | codex；bin：可执行文件（默认在 PATH 里找 claude / codex）
  // projectDir：项目文件夹；confirmDir：Claude Code 的授权钩子写请求的地方；hook：钩子命令；confirm({label, detail}) → 宿主允不允许
  constructor({ engine, id, role, cwd, system, maxTurns = 80, budgetUsd = 0, ask, confirm, hook, bin, projectDir, confirmDir, settingsFile, log = () => {} }) {
    super();
    Object.assign(this, { engine, id, role, cwd, system, maxTurns, budgetUsd, ask, confirm, hook, projectDir, confirmDir, settingsFile, log });
    this.bin = bin || (engine === 'claude' ? 'claude' : 'codex');
    this.sessionId = null;
    this.turns = 0;
    this.usd = 0;
  }

  #args(resume) {
    if (this.engine === 'claude') {
      const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
      if (this.budgetUsd > 0) a.push('--max-budget-usd', String(this.budgetUsd));
      if (this.hook && this.settingsFile) {
        // 钩子写进一个设置文件（命令行里传 JSON 在 Windows 上容易被引号搞坏）
        fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
        fs.writeFileSync(this.settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: this.hook, timeout: 900 }] }] } }, null, 1));
        a.push('--settings', this.settingsFile);
      }
      if (resume && this.sessionId) a.push('--resume', this.sessionId);
      else a.push('--append-system-prompt', this.system);
      return a;
    }
    // codex：沙箱只许写当前文件夹，但要能联网装依赖；resume 时子进程的 cwd 就是副本
    const net = ['-c', 'sandbox_workspace_write.network_access=true'];
    // 最后的「-」：任务从标准输入读（命令行里放长文字在 Windows 上容易被引号搞坏）
    return resume && this.sessionId ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...net, this.sessionId, '-'] : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...net, '-'];
  }

  // Claude Code 的钩子要宿主授权时写一个请求文件，这里看到就去问，回答写回去
  #pollConfirms() {
    if (!this.confirmDir) return () => {};
    const busy = new Set();
    const timer = setInterval(() => {
      let names = [];
      try {
        names = fs.readdirSync(this.confirmDir).filter((n) => n.endsWith('.json'));
      } catch {
        return;
      }
      for (const n of names) {
        if (busy.has(n)) continue;
        busy.add(n);
        let req = {};
        try {
          req = JSON.parse(fs.readFileSync(path.join(this.confirmDir, n), 'utf8'));
        } catch {}
        Promise.resolve(this.confirm?.({ label: req.label || '要宿主授权的操作', detail: req.detail || '', tool: req.tool }))
          .catch(() => false)
          .then((ok) => {
            try {
              fs.writeFileSync(path.join(this.confirmDir, n.replace(/\.json$/, '.answer')), ok ? 'allow' : 'deny');
            } catch {}
          });
      }
    }, 500);
    return () => clearInterval(timer);
  }

  // 跑一次（读到结束），返回最后一条消息
  #once(input, resume) {
    return new Promise((resolve) => {
      let final = '';
      let buf = '';
      let err = '';
      this.usdThisRun = 0; // Claude Code 的 total_cost_usd 按这一次进程算
      const bin = resolveBin(this.bin);
      if (!bin) return resolve({ code: -1, final: '', err: `没找到 ${this.bin}（没装，或者不在 PATH 里）` });
      const args = this.#args(resume);
      const env = { ...process.env, CI: '1', HOSTBOUND_PROJECT_DIR: this.projectDir || this.cwd, ...(this.confirmDir ? { HOSTBOUND_CONFIRM_DIR: this.confirmDir } : {}) };
      const p = /\.cmd$/i.test(bin) ? spawn('cmd.exe', ['/d', '/c', bin, ...args], { cwd: this.cwd, windowsHide: true, env }) : spawn(bin, args, { cwd: this.cwd, windowsHide: true, env });
      this.proc = p;
      const stopPoll = this.#pollConfirms();
      const line = (l) => {
        let j;
        try {
          j = JSON.parse(l);
        } catch {
          return;
        }
        final = this.#event(j) ?? final;
      };
      p.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) if (l.trim()) line(l.trim());
      });
      p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
      p.on('close', (code) => {
        stopPoll();
        if (buf.trim()) line(buf.trim());
        this.proc = null;
        resolve({ code, final, err });
      });
      p.on('error', (e) => {
        stopPoll();
        resolve({ code: -1, final: '', err: e.message });
      });
      p.stdin.on('error', () => {});
      p.stdin.end(input);
    });
  }

  // 一行事件 → 步骤；返回最后的结果文字（有的话）
  #event(j) {
    if (this.engine === 'claude') {
      if (j.type === 'system' && j.session_id) this.sessionId = j.session_id;
      if (j.type === 'assistant') {
        this.turns++;
        for (const c of j.message?.content || []) {
          if (c.type === 'text' && c.text?.trim()) this.emit('step', { kind: 'say', text: short(c.text, 1200) });
          if (c.type === 'tool_use') this.emit('step', { kind: 'tool', id: c.id, name: c.name, text: describeTool(String(c.name).toLowerCase(), { command: c.input?.command, path: c.input?.file_path || c.input?.path, pattern: c.input?.pattern }), detail: short(c.input?.command || c.input?.file_path || '', 400) });
        }
        if (this.turns >= this.maxTurns) this.stop('turns');
      }
      if (j.type === 'user') for (const c of j.message?.content || []) if (c.type === 'tool_result') this.emit('step', { kind: 'tool_end', id: c.tool_use_id, ok: !c.is_error, error: c.is_error ? short(textOf(c.content), 300) : '' });
      if (j.type === 'result') {
        if (j.session_id) this.sessionId = j.session_id;
        const usd = Number(j.total_cost_usd || 0) - this.usdThisRun;
        if (usd > 0) {
          this.usd += usd;
          this.usdThisRun += usd;
          this.emit('cost', { usd });
        }
        if (j.is_error && !j.result) this.emit('step', { kind: 'error', text: short(j.subtype || 'Claude Code 出错', 200) });
        return String(j.result || '');
      }
      return null;
    }
    // codex
    if (j.type === 'thread.started' && j.thread_id) this.sessionId = j.thread_id;
    const it = j.item || {};
    if (j.type === 'item.started' && it.type === 'command_execution') this.emit('step', { kind: 'tool', id: it.id, name: 'powershell', text: describeTool('powershell', { command: it.command }), detail: short(it.command, 400) });
    if (j.type === 'item.completed') {
      if (it.type === 'command_execution') this.emit('step', { kind: 'tool_end', id: it.id, ok: it.exit_code === 0 || it.status === 'completed', error: it.exit_code ? short(it.aggregated_output, 300) : '' });
      if (it.type === 'file_change') for (const c of it.changes || []) this.emit('step', { kind: 'tool', id: `${it.id}:${c.path}`, name: 'edit', text: `改文件：${short(c.path, 70)}`, done: true });
      if (it.type === 'agent_message' && it.text) {
        this.turns++;
        this.emit('step', { kind: 'say', text: short(it.text, 1200) });
        if (this.turns >= this.maxTurns) this.stop('turns');
        return String(it.text);
      }
    }
    if (j.type === 'turn.failed' || j.type === 'error') this.emit('step', { kind: 'error', text: short(j.error?.message || j.message || 'Codex 出错', 300) });
    return null;
  }

  async run(text) {
    this.stopReason = null;
    this.turns = 0;
    this.usdThisRun = 0;
    let input = this.engine === 'codex' && !this.sessionId ? `${this.system}\n\n${text}` : text;
    let resume = !!this.sessionId;
    for (let round = 0; round < 8; round++) {
      const r = await this.#once(input, resume);
      if (this.stopReason) return { status: this.stopReason };
      if (r.code !== 0 && !r.final) return { status: 'error', error: short(r.err || `退出码 ${r.code}`, 600) };
      const f = parseFinal(r.final);
      if (f.kind === 'question') {
        const answer = await this.ask?.({ question: f.text, options: [] });
        if (this.stopReason) return { status: this.stopReason };
        input = `总指挥回答：${answer}\n接着做。做完最后一条消息写 REPORT:，还要问就写 QUESTION:。`;
        resume = true;
        continue;
      }
      return { status: f.kind === 'blocked' ? 'blocked' : 'reported', report: { status: f.kind === 'blocked' ? 'blocked' : 'done', summary: short(f.text, 2000) } };
    }
    return { status: 'stuck' };
  }

  async steer() {
    return false; // 子进程跑着的时候插不进话：等它这一轮结束，下次派活时带上
  }

  stop(reason = 'stopped') {
    this.stopReason = reason;
    if (this.proc) killTree(this.proc.pid);
  }

  dispose() {}
}
