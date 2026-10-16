// 系统的后台进程：耳朵 + 大脑。和桌面窗口之间用 Node IPC 通信（单独运行时走 stdin/stdout 的 JSON 行）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { Ear, cleanTranscript } from './ear.mjs';
import { Brain } from './agent.mjs';
import { Mouth } from './mouth.mjs';
import { isDismiss, looksLikeCommand, parseConfirm, parseTakeover, parseNav, parseReminderAnswer, parseSkillAnswer, parseAppraise, parseAppraiseClose, parseProjectGo } from './intent.mjs';
import { Store } from './store.mjs';
import { kwsTokens } from './pinyin.mjs';
import { Tasks, describeSchedule } from './tasks.mjs';
import { Memory, REVIEW_PROMPT, reviewInput, parseReviewOps, memoryTools } from './memory.mjs';
import { Embedder, Recall } from './vector.mjs';
import { Skills, skillTools, REPORT_PROMPT } from './skills.mjs';
import { Appraise, noteOf } from './appraise.mjs';
import { Projects } from './projects.mjs';
import { processNames, powerStatus } from './win32.mjs';
import { Operator } from './operator.mjs';
import { Screen } from './screen.mjs';
import { Explain, parseGuideCmd } from './explain.mjs';
import { Guide } from './guide.mjs';
import { foregroundIsFullscreen } from './win32.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(root);

// stdout 留给协议用，日志一律走 stderr
console.log = console.info = (...a) => console.error(...a);

const viaIpc = typeof process.send === 'function';
function out(msg) {
  if (viaIpc) process.send(msg);
  else process.stdout.write(JSON.stringify(msg) + '\n');
}
function log(...a) {
  console.error(new Date().toISOString(), ...a);
}

let ear = null;
// 个人数据：对话存盘、任务记录、系统日志。测试时用 HOSTBOUND_DATA_DIR 换个目录，不碰宿主真实的数据
const store = new Store(process.env.HOSTBOUND_DATA_DIR || path.join(root, 'data'));
store.onLog((entry) => out({ type: 'log_entry', entry }));
// 操作员：让操作看得见、守焦点、接管前台。Hostbound 自己的窗口属于桌面主进程（大脑的父进程）
const operator = new Operator({ ownPids: [process.ppid], log, cursor: cfg.fx.enabled && cfg.fx.cursor });
const screen = new Screen({ root, cfg, log, operator, ownPids: [process.ppid] });
// 定时任务和监测：到点、发生了都是程序自己判断，不调模型
const tasks = new Tasks({ file: path.join(store.dir, 'tasks.json'), cfg, log, win: { processNames, powerStatus } });
// 长期记忆 + 关键词 / 向量检索。硅基流动的密钥：设置页里宿主自己粘的（data/secrets.json），或者环境变量；这里只拿来用，不打印
const memory = new Memory({ dir: path.join(store.dir, 'memory'), log });
let secrets = {};
function loadSecrets() {
  try {
    secrets = JSON.parse(fs.readFileSync(path.join(store.dir, 'secrets.json'), 'utf8')) || {};
  } catch {
    secrets = {};
  }
}
loadSecrets();
const embedder = new Embedder({
  baseUrl: cfg.memory.embed.baseUrl,
  model: cfg.memory.embed.model,
  key: () => secrets.siliconflow || process.env.SILICONFLOW_API_KEY || null,
  log,
});
const recall = new Recall({ dir: memory.dir, embedder, log });
const searchMemory = (q, limit) => recall.searchMemory(q, memory.all(), limit);
// 技能：宿主教的固定流程（data/skills，Agent Skills 格式）
const skills = new Skills({ dir: path.join(store.dir, 'skills'), log });
// 项目模式：宿主说「做一个……」，总指挥写计划、派几个智能体一起做（目录 data/projects.json，记录在每个项目文件夹的 .hostbound 里）
const projects = new Projects({ dataDir: store.dir, cfg: () => cfg, runtime: () => brain.modelRuntime, model: () => brain.model, root, log });
const brain = new Brain(cfg, {
  operator,
  screen,
  store,
  tasks,
  memory,
  recall,
  memoryTools: memoryTools({ memory, search: searchMemory, enabled: () => cfg.memory.enabled !== false, onChange: (c) => memoryNotice(c) }),
  skills,
  skillTools: skillTools({ skills, install: (url, pick) => installSkill(url, pick), enabled: () => cfg.skills.enabled !== false }),
  projectTools: projects.tools(),
});
let brainReady = false;
const mouth = new Mouth({ root, cfg, log, out });
let msgSeq = 0;
// 讲东西：画图讲解（讲解窗口）、就地讲解、手把手教学。讲解和教学小结存在 data/explainers
const explain = new Explain({ dir: path.join(store.dir, 'explainers'), cfg, log, mouth, out, runtime: () => brain.modelRuntime, model: () => brain.model });
const guide = new Guide({ screen, operator, voice: explain.voice, explain, out, log });
// 鉴定术：桌面那边框好、裁好图发过来，这里问模型（边出边发回去）、存档（data/appraisals：文字 + 小缩略图）
const appraise = new Appraise({ dir: path.join(store.dir, 'appraisals'), log, runtime: () => brain.modelRuntime, model: () => brain.model });
brain.explain = explain;
brain.guide = guide;
// 宿主在讲解窗口里点图、圈字、追问：当成一句指令交给大脑
explain.on('ask', ({ text, shown }) => {
  out({ type: 'heard', text: shown });
  ask(text, 'explain');
});
// 讲解、就地讲解、教学进行中，宿主说的「停一下」「下一步」「你来」……
async function guideCommand(cmd) {
  if (await guide.command(cmd)) return true;
  const n = explain.narrator;
  if (!n.engaged) return false;
  const act = { pause: () => n.pause(), resume: () => n.play(), next: () => n.next(), prev: () => n.prev(), redo: () => n.redo(), exit: () => n.stop() }[cmd];
  if (!act) return false;
  act();
  return true;
}

// ---- 听的三种模式 ----
// command：刚被叫醒，听一句指令
// followup：醒着待命，连续听（听到的话先判断是不是对系统说的）
// confirm：确认框弹着，听「允许 / 拒绝」
// takeover：申请接管前台，听「可以 / 等一下 / 不行」
let listenMode = null;
let windowEnd = 0;

const liveMode = () => !ear || !ear.wakeEnabled;

function listen(mode, ms) {
  if (!ear) return;
  listenMode = mode;
  if (mode === 'followup') windowEnd = Date.now() + ms;
  ear.listen(ms);
}

function stopListening() {
  listenMode = null;
  ear?.cancelListen();
}

// 一轮干完以后：连续对话就接着听；直播模式下只有系统反问时才听一句
function afterReply(answer) {
  if (/^\s*\[sleep\]/i.test(answer)) return out({ type: 'dismiss', farewell: false });
  if (!ear || !brainReady) return;
  if (cfg.conversation.enabled && !liveMode()) return listen('followup', cfg.conversation.windowMs);
  if (/[?？]\s*$/.test(answer.trim())) listen('followup', cfg.voice.listenTimeoutMs + 3000);
}

// 忽略了一句闲聊：接着把剩下的待命时间听完
function resumeFollowup() {
  if (!ear || liveMode() || !cfg.conversation.enabled) return out({ type: 'listen_timeout', mode: 'followup' });
  listen('followup', Math.max(windowEnd - Date.now(), 8000));
}

// ---- 任务记录：一条指令从开始到结束的过程 ----
let task = null;
function taskBegin(text, via) {
  task = { id: Date.now().toString(36), at: Date.now(), text, via, steps: [], denied: false, error: '', skill: null, steered: false, noSuggest: false };
}
function taskEnd(result, answer) {
  if (!task) return null;
  const t = task;
  task = null;
  const clean = String(answer || '').replace(/^\s*\[[a-z-]+\]\s*/i, '').trim();
  if (result === 'ok' && t.denied) result = 'deny';
  store.addTask({
    id: t.id,
    at: t.at,
    text: t.text,
    via: t.via,
    result,
    answer: (clean || t.error).slice(0, 800),
    steps: t.steps.map(({ text, ok }) => ({ text, ok })),
    tools: t.steps.filter((x) => x.tool).length,
    seconds: Math.max(1, Math.round((Date.now() - t.at) / 1000)),
  });
  return { t, result };
}

// ---- 系统日志：系统做过的每个操作 ----
const SCREEN_TOOLS = new Set(['list_apps', 'open_app', 'read_app', 'click', 'type_text', 'press_keys', 'scroll', 'request_foreground', 'fg_click', 'fg_type', 'fg_key']);
function logTool(t) {
  const a = t.args || {};
  if (t.name === 'powershell') {
    const cmd = String(a.command || '');
    return store.log(/^\s*agent-browser\b/.test(cmd) ? 'web' : 'cmd', t.text, cmd);
  }
  if (t.name === 'write') return store.log('file', t.text, `${a.path || ''}（${String(a.content || '').length} 字）`);
  if (['read', 'edit', 'ls', 'find', 'grep'].includes(t.name)) return store.log('file', t.text, a.path || a.pattern || '');
  if (t.name === 'look_screen') return null; // 截图的时候单独记（知道截了哪个窗口）
  if (t.name === 'read_app') return store.log('app', t.text, '界面文字和截图会发给模型');
  if (SCREEN_TOOLS.has(t.name)) return store.log('app', t.text, a.app ? `软件：${a.app}` : '');
  if (t.name === 'search_chat') return store.log('sys', t.text, a.query || '');
  if (t.name.startsWith('skill_')) return store.log('skill', t.text, a.url || a.change || '');
  return store.log('sys', t.text);
}

// ---- 大脑事件 -> 窗口 ----
brain.on('notice', (text) => out({ type: 'notice', text }));
brain.on('busy', (busy) => out({ type: 'busy', busy }));
brain.on('say_start', () => {
  const id = ++msgSeq;
  // 讲解正在念、就地讲解或教学进行中：大脑的回复只显示不念（免得跟讲解抢着说）
  out({ type: 'say_start', id, voice: mouth.beginMessage(id, { mute: explain.holdsVoice || guide.holdsVoice }) });
});
brain.on('say', (delta) => {
  out({ type: 'say', delta });
  mouth.pushDelta(delta);
});
brain.on('say_end', () => {
  mouth.endMessage();
  out({ type: 'say_end', id: msgSeq });
});
const NO_SUGGEST = new Set(['skill_draft', 'skill_install', 'skill_list', 'explain', 'explain_open', 'point_out', 'tutor_step', 'tutor_finish', 'remember', 'forget', 'task_create', 'watch_create', 'task_cancel']);
brain.on('tool', (t) => {
  out({ type: 'tool', id: t.id, name: t.name, text: t.text });
  task?.steps.push({ id: t.id, text: t.text, ok: null, tool: true });
  logTool(t);
  if (task && NO_SUGGEST.has(t.name)) task.noSuggest = true;
  if (t.name === 'read' && /SKILL\.md$/i.test(String(t.args?.path || ''))) {
    const folder = skills.folderOf(path.resolve(brain.workdir || '', String(t.args.path)));
    if (folder) {
      skills.markUsed(folder);
      if (task) task.skill ||= folder;
    }
  }
});
brain.on('tool_end', (t) => {
  out({ type: 'tool_end', id: t.id, name: t.name, isError: t.isError });
  const step = task?.steps.find((x) => x.id === t.id);
  if (step) step.ok = !t.isError;
  if (t.isError) store.log('err', `${step?.text || t.name} 没成功`, t.error);
});
brain.on('compaction', (c) => {
  if (c.phase === 'start') reviewMemory('压缩前');
  else if (c.ok) scheduleReload('压缩完，常驻记忆换成新的');
  if (c.phase === 'start') {
    out({ type: 'status', text: '整理前面的对话…' });
    store.log('sys', '对话太长，把前面的内容压缩成摘要（原文还在存盘里）');
  } else {
    out({ type: 'status', text: '' });
    if (!c.ok && c.error) store.log('err', '压缩对话没成功', c.error);
  }
});
brain.on('confirm', (c) => {
  out({ type: 'confirm', ...c, voice: !!(ear && cfg.voiceConfirm) });
  mouth.say('请宿主授权。');
  if (ear && cfg.voiceConfirm) listen('confirm', 90_000);
});
const CONFIRM_TEXT = { allow: '宿主允许', all: '宿主全部允许', deny: '宿主拒绝', timeout: '没人回应，当作拒绝', cancel: '任务结束，取消' };
brain.on('confirm_closed', (c) => {
  log('confirm:', c.label, '→', c.answer, `(${c.by})`);
  const how = `${CONFIRM_TEXT[c.answer] || c.answer}${c.by === 'voice' ? '（语音）' : c.by === 'click' ? '（点击）' : ''}`;
  store.log('auth', `${c.label} → ${how}`);
  if (task && c.answer !== 'cancel') {
    task.steps.push({ text: `申请授权：${c.label} → ${how}`, ok: c.answer === 'allow' || c.answer === 'all' });
    if (c.answer === 'deny' || c.answer === 'timeout') task.denied = true;
  }
  out({ type: 'confirm_closed', ...c });
  if (listenMode === 'confirm') stopListening();
});
// ---- 项目模式 -> 窗口 ----
// 完成卡上的首页截图：小于 2MB 就直接放进卡片（面板读不了任意本地文件）
const shotCache = new Map();
function cardOut(card) {
  const file = card?.result?.shot;
  if (!file) return card;
  if (!shotCache.has(file)) {
    try {
      const st = fs.statSync(file);
      shotCache.set(file, st.size < 2 * 1024 * 1024 ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null);
    } catch {
      shotCache.set(file, null);
    }
  }
  return { ...card, result: { ...card.result, shotData: shotCache.get(file) } };
}
projects.on('card', (card) => out({ type: 'project_card', card: cardOut(card) }));
projects.on('event', ({ projectId, ev }) => out({ type: 'project_event', projectId, ev }));
projects.on('say', (text) => mouth.say(text));
projects.on('note', (text) => brain.note(text));
projects.on('open', (projectId) => out({ type: 'project_open', projectId }));
projects.on('ask', (q, c) => {
  brain.note(`项目「${c.project?.name}」的总指挥在问宿主：${q.text}${q.options?.length ? `，选项：${q.options.join(' / ')}` : ''}。宿主回答的话用 project_answer 转过去`);
  store.log('task', `项目「${c.project?.name}」问宿主：${q.text}`);
});
// 项目里要授权的操作：跟大脑的授权用同一张卡（id 前面带 p:项目:）
projects.on('confirm', (x) => {
  out({ type: 'confirm', id: `p:${x.projectId}:${x.cid}`, label: `${x.label}（项目「${x.project}」· ${x.agent}）`, detail: x.detail, tool: 'project', voice: !!(ear && cfg.voiceConfirm) });
  mouth.say('项目请宿主授权。');
  if (ear && cfg.voiceConfirm && !brain.busy) listen('confirm', 90_000);
});
projects.on('confirm_closed', (x) => {
  store.log('auth', `项目授权 → ${CONFIRM_TEXT[x.answer] || x.answer}`);
  out({ type: 'confirm_closed', id: `p:${x.projectId}:${x.cid}`, answer: x.answer });
  if (listenMode === 'confirm' && !brain.confirmPending && !projects.confirmPending) stopListening();
});

// 项目卡、项目页上的按钮
async function projectAction(m) {
  const c = projects.get(m.projectId);
  const reply = (r) => out({ type: 'project_action_result', reqId: m.reqId, projectId: m.projectId, action: m.action, ...r });
  if (!c) return reply({ ok: false, error: '没有这个项目了' });
  const name = c.project?.name;
  try {
    switch (m.action) {
      case 'approve':
        store.log('task', `项目「${name}」开工`);
        return reply({ ok: await c.approve() });
      case 'cancel':
        store.log('task', `项目「${name}」不做了`);
        return reply({ ok: c.cancel() });
      case 'pause':
        return reply({ ok: c.pause() });
      case 'resume':
        return reply({ ok: c.resume() });
      case 'stop':
        store.log('task', `项目「${name}」停下`);
        return reply({ ok: c.stop() });
      case 'answer':
        store.log('task', `回答项目「${name}」：${String(m.value || '').slice(0, 80)}`);
        return reply({ ok: c.answer(m.qid, String(m.value || '')) });
      case 'set_dir':
        return reply({ ok: true, dir: c.setDir(String(m.value || '')) });
      case 'message':
        return reply({ ok: true, reply: await c.message(String(m.value || '')) });
      case 'open_page':
        return out({ type: 'project_open', projectId: c.id });
      case 'open_folder':
        if (!fs.existsSync(c.dir)) return reply({ ok: false, error: '文件夹不在了' });
        spawn('explorer.exe', [c.dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return reply({ ok: true });
      case 'open_shot': {
        const file = c.state.result?.shot || c.state.lastShot?.file;
        if (!file || !fs.existsSync(file)) return reply({ ok: false, error: '没有截图' });
        spawn('explorer.exe', [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return reply({ ok: true });
      }
      case 'open_site': {
        const r = await c.openSite();
        if (r.ok) out({ type: 'open_url', url: r.url });
        store.log('task', r.ok ? `打开项目「${name}」的网站：${r.url}` : `项目「${name}」的网站没跑起来`, r.error || '');
        return reply(r);
      }
      case 'close_site':
        return reply({ ok: await c.closeSite() });
      case 'retry_plan':
        if (c.state.startedAt) return reply({ ok: false, error: '已经开过工了，要改就说「接着改」' });
        c.start().catch((e) => log('project plan failed', e));
        return reply({ ok: true });
    }
    return reply({ ok: false, error: `不认识的操作：${m.action}` });
  } catch (e) {
    log('project action failed', m.action, e);
    return reply({ ok: false, error: String(e?.message || e) });
  }
}

// ---- 操作员事件 -> 窗口 ----
operator.on('fx', (m) => out(m));
operator.on('steps', (st) => out({ type: 'steps', ...(st || { steps: null }) }));
operator.on('target', (t) => out({ type: 'target', ...t }));
operator.on('injecting', (ms) => out({ type: 'injecting', ms }));
operator.on('takeover_state', (st) => out({ type: 'takeover_state', ...st }));
operator.on('takeover_request', (r) => {
  out({ type: 'takeover_request', ...r, voice: !!ear });
  mouth.say(`需要占用前台约 ${r.seconds} 秒，请宿主允许。`);
  if (ear) listen('takeover', 30_000);
});
operator.on('takeover_closed', (c) => {
  log('takeover:', c.answer);
  const how = { allow: '宿主允许', later: '宿主选了稍后', deny: '宿主拒绝', timeout: '没人回应，按稍后处理' }[c.answer] || c.answer;
  store.log('auth', `申请接管前台 → ${how}`);
  task?.steps.push({ text: `申请接管前台 → ${how}`, ok: c.answer === 'allow' });
  out({ type: 'takeover_closed', ...c });
  if (listenMode === 'takeover') stopListening();
});

// 截图：让桌面窗口藏起面板、放扫描特效、截图，再把图发回来
const captures = new Map();
let captureSeq = 0;
operator.capture = (req) =>
  new Promise((resolve, reject) => {
    const id = ++captureSeq;
    const timer = setTimeout(() => {
      captures.delete(id);
      reject(new Error('截图超时'));
    }, 15_000);
    captures.set(id, (r) => {
      clearTimeout(timer);
      captures.delete(id);
      r.ok ? resolve(r) : reject(new Error(r.error || '截图失败'));
    });
    out({ type: 'capture', id, ...req });
    store.log('screen', `截了「${req.label || (req.scope === 'screen' ? '整个屏幕' : '当前窗口')}」，发给了模型`, '截图本身不存');
  });

// 干完活的提示：用过工具或者超过 10 秒的任务，弹全屏通知；直播模式或者有全屏程序时只在角落弹小提示
function noticeMode() {
  if (liveMode()) return 'toast';
  try {
    return foregroundIsFullscreen([process.ppid]) ? 'toast' : 'full';
  } catch {
    return 'full';
  }
}

function summarize(answer) {
  let t = String(answer || '').replace(/^\s*\[[a-z-]+\]\s*/i, '').split(/\n/)[0];
  t = t.split(/(?<=[。！？!?])/)[0].replace(/[。！？!?]$/, '');
  t = t.replace(/^【([^】]*)】/, (_, g) => (/^(完成|已完成|成功|执行完毕)$/.test(g) ? '' : `${g}：`)).trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}
function taskNotice(ok, text) {
  const st = brain.lastStats;
  if (!cfg.fx.enabled || !cfg.fx.notice) return;
  if (!st || (st.tools === 0 && st.seconds < 10)) return;
  out({
    type: 'fx',
    kind: 'notice',
    mode: noticeMode(),
    tone: ok ? 'ok' : 'err',
    title: ok ? '任务完成' : '任务失败',
    text: ok ? summarize(text) : text,
    meta: `用时 ${st.seconds} 秒 · 动作 ${st.tools}`,
  });
}

brain.on('model_error', (message) => {
  log('model error:', message);
  store.log('err', '模型报错', message);
  if (task) task.error = friendlyError(message);
  reportError(friendlyError(message), false); // 任务还没结束，统计还没出来，先不弹通知
});

// 报错：面板显示完整原因，嘴上只说一句（括号里的补充说明不念）
function reportError(message, notice = true) {
  out({ type: 'error', message });
  if (notice) taskNotice(false, message.replace(/（[^）]*）/g, '').slice(0, 40));
  mouth.say('任务失败。');
  if (/[\u4e00-\u9fff]/.test(message)) mouth.say(message.replace(/（[^）]*）/g, '').split(/(?<=[。！？])/)[0]);
}

function friendlyError(message) {
  const m = String(message || '');
  if (/401|unauthor|invalid.*key|api key/i.test(m)) return '模型密钥无效或已过期，请检查密钥配置。';
  if (/429|rate|quota|insufficient|balance/i.test(m)) return '模型服务额度不足或请求过于频繁，请稍后重试或检查账户余额。';
  if (/\b50[234]\b|too busy|overload|unavailable/i.test(m)) return '模型服务器繁忙（服务商那边过载），请稍后再试。';
  if (/ENOTFOUND|ECONN|network|fetch failed|timeout/i.test(m)) return '无法连接模型服务器，请检查网络。';
  return m.slice(0, 300);
}

async function ask(text, via = 'text', opts = {}) {
  if (!brainReady) {
    out({ type: 'error', message: '大脑未连接：没有找到可用的模型密钥。请先配置模型密钥（步骤见 README），再从托盘菜单重启系统。' });
    return;
  }
  stopListening();
  mouth.stop();
  const steer = brain.busy;
  if (steer) {
    task?.steps.push({ text: `宿主插话：${text}`, ok: true });
    if (task) task.steered = true;
  } else taskBegin(text, via);
  const sk = !steer && opts.skill ? opts.skill : null;
  const images = steer ? undefined : attachImages(opts.appraise);
  if (sk) {
    task.skill = sk.folder;
    task.steps.push({ text: `【技能】${sk.title}`, ok: true });
    out({ type: 'skill_run', title: sk.title, folder: sk.folder });
  }
  try {
    const answer = await brain.ask(text, { ...(sk ? { skill: skills.block(sk), steps: sk.labels } : {}), images });
    if (answer == null) return; // 插话，已经并进当前任务
    if (/^\s*\[ignore\]\s*$/i.test(answer)) {
      log('ignored (not for host):', text);
      task = null;
      store.log('voice', `当成闲聊忽略：「${text}」`);
      out({ type: 'ignored', text, removeHeard: true });
      return resumeFollowup();
    }
    log('done:', answer.replace(/\s+/g, ' ').slice(0, 200));
    if (/^\s*\[sleep\]/i.test(answer)) task = null;
    else {
      const rec = taskEnd(task?.error && !answer.trim() ? 'fail' : 'ok', answer);
      if (rec) maybeSuggest(rec.t, rec.result);
    }
    out({ type: 'done', text: answer });
    setTimeout(afterTurn, 300);
    if (!/^\s*\[(sleep|ignore)\]/i.test(answer)) taskNotice(true, answer);
    afterReply(answer);
  } catch (e) {
    log('ask failed', e);
    store.log('err', '任务出错', String(e?.message || e));
    taskEnd('fail', friendlyError(e?.message || e));
    reportError(friendlyError(e?.message || e));
  }
}

async function stop() {
  stopListening();
  mouth.stop();
  if (task) task.steps.push({ text: '宿主喊停', ok: false });
  store.log('sys', '宿主让系统停下当前任务');
  guide.stopAll();
  await brain.abort().catch((e) => log('abort failed', e));
  taskEnd('stopped', '任务已按宿主指令中止。');
  out({ type: 'stopped' });
  mouth.say('任务已中止。');
}

const FAREWELLS = ['系统进入待机。', '收到，系统待机。'];

// ---- 按住说话：按下开始录，松开就识别并当成一句指令 ----
let ptt = null;
function pttDown() {
  if (!ear || ptt) return;
  mouth.stop();
  stopListening();
  ear.startCapture();
  ptt = { since: Date.now(), confirm: !!(brain.confirmPending && cfg.voiceConfirm), takeover: operator.takeoverPending };
  out({ type: 'listening', mode: 'ptt' });
}
function pttUp(cancelled) {
  if (!ear || !ptt) return;
  const { since, confirm, takeover } = ptt;
  ptt = null;
  const samples = ear.endCapture();
  // 按得太短（多半是在按快捷键）或者中途按了别的键：不算
  if (cancelled || Date.now() - since < 300 || samples.length < 16000 * 0.3) return out({ type: 'listen_timeout', mode: 'ptt' });
  const text = cleanTranscript(ear.transcribe(samples), ear.wakeTexts);
  if (!text) return out({ type: 'listen_timeout', mode: 'ptt' });
  listenMode = takeover ? 'takeover' : confirm ? 'confirm' : 'ptt';
  onTranscript(text).catch((e) => log('transcript failed', e));
}

async function onTranscript(text) {
  let mode = listenMode;
  listenMode = null;
  log('heard:', text, `(${mode})`);
  store.log('voice', `听到「${text}」`, { command: '叫醒后的指令', followup: '连续对话', confirm: '回答授权', takeover: '回答接管前台', ptt: '按住说话' }[mode] || '');

  if (mode === 'takeover') {
    const answer = parseTakeover(text);
    if (answer) {
      out({ type: 'heard', text });
      operator.answerTakeover(null, answer);
    } else {
      out({ type: 'confirm_unclear', text });
      if (operator.takeoverPending) listen('takeover', 20_000);
    }
    return;
  }

  if (mode === 'reminder') {
    const answer = parseReminderAnswer(text);
    if (answer && lastReminder) {
      out({ type: 'heard', text });
      return answerReminder(lastReminder.id, answer, 'voice');
    }
    // 不是在回答提醒：当成醒着时听到的普通的话（不是对系统说的就不理）
    mode = 'followup';
  }

  if (mode === 'confirm') {
    const answer = parseConfirm(text);
    if (answer) {
      out({ type: 'heard', text });
      if (brain.confirmPending) brain.answerConfirm(null, answer, 'voice');
      else projects.answerConfirm(null, answer);
    } else {
      out({ type: 'confirm_unclear', text });
      if (brain.confirmPending || projects.confirmPending) listen('confirm', 60_000);
    }
    return;
  }

  // 讲解、就地讲解、教学进行中的短句：直接处理，不用问大脑
  const gcmd = guide.active || explain.narrator.engaged ? parseGuideCmd(text) : null;
  if (gcmd && (await guideCommand(gcmd))) {
    out({ type: 'heard', text });
    store.log('voice', `讲解控制：「${text}」`);
    return resumeFollowup();
  }

  // 鉴定卡开着：「关掉」；「我要鉴定」「鉴定一下这个窗口」「扫描全屏」：直接进鉴定，不用问大脑
  if (appraiseOpen && parseAppraiseClose(text)) {
    out({ type: 'heard', text });
    out({ type: 'appraise_close' });
    return resumeFollowup();
  }
  const ap = parseAppraise(text);
  if (ap) {
    out({ type: 'heard', text });
    return startAppraise(ap);
  }

  // 技能卡片弹着：「保存」「不要了」「安装」「不装」直接处理
  if (skillAnswer(text, 'voice')) return resumeFollowup();

  // 项目计划卡弹着：「开工」「就按这个做」直接开工
  if (projectGo(text)) return resumeFollowup();

  if (isDismiss(text)) {
    const farewell = FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)];
    out({ type: 'heard', text });
    out({ type: 'dismiss', farewell });
    mouth.say(farewell);
    return;
  }

  // 「打开设置」「看看日志」：直接翻面板，不用问大脑
  const nav = parseNav(text);
  if (nav) {
    out({ type: 'heard', text });
    out({ type: 'nav', ...nav });
    return;
  }

  // 技能口令：整句就是口令，直接跑（不用等模型猜）
  const hit = skillHit(text);
  if (hit) {
    out({ type: 'heard', text });
    return runSkill(hit, text, 'voice');
  }

  // 待命时顺便听到的话：明显是指令就直接干，拿不准再问一下模型
  if (mode === 'followup' && cfg.conversation.filter && !looksLikeCommand(text)) {
    out({ type: 'pondering' });
    const forHost = await brain.isForHost(text);
    if (!forHost) {
      log('ignored:', text);
      store.log('voice', `当成闲聊忽略：「${text}」`);
      out({ type: 'ignored', text });
      return resumeFollowup();
    }
  }

  out({ type: 'heard', text });
  ask(text, 'voice');
}

// ---- 窗口 -> 后台 ----
async function handle(msg) {
  switch (msg.type) {
    case 'prompt': {
      const text = String(msg.text || '').trim();
      if (skillAnswer(text, 'text', false)) return;
      if (projectGo(text)) return;
      const ap = parseAppraise(text);
      if (ap) return startAppraise(ap);
      if (msg.appraise) return ask(text, 'text', { appraise: msg.appraise });
      const nav = parseNav(text);
      if (nav) return out({ type: 'nav', ...nav });
      const hit = skillHit(text);
      if (hit) return runSkill(hit, text, 'text');
      return ask(text, 'text');
    }
    case 'history_query':
      return out({ type: 'history', reqId: msg.reqId, ...store.tasks({ q: msg.q, result: msg.result, before: msg.before, limit: msg.limit }) });
    case 'log_query': {
      const days = store.logDays();
      const day = msg.day || days[0] || null;
      return out({ type: 'log', reqId: msg.reqId, day, days, items: day ? store.readLog(day, { type: msg.logType, q: msg.q }) : [] });
    }
    case 'chat_history': {
      const r = store.chat({ before: msg.before, limit: msg.limit || 40 });
      const lo = r.more && r.items.length ? r.items[0].at : 0;
      const cards = appraise.list({ after: lo - 1, before: msg.before || Infinity }).map((rec) => ({ role: 'appraise', at: rec.at, rec: cardForPanel(rec) }));
      const pcards = projects.cardsBetween(lo - 1, msg.before || Infinity).map((x) => ({ role: 'project', at: x.at, card: cardOut(x.card) }));
      return out({ type: 'chat_history', reqId: msg.reqId, more: r.more, items: [...r.items, ...cards, ...pcards].sort((a, b) => a.at - b.at) });
    }
    case 'info_query':
      return out({ type: 'info', reqId: msg.reqId, ...(await systemInfo()) });
    case 'ping':
      try {
        return out({ type: 'ping_result', reqId: msg.reqId, ms: await brain.ping() });
      } catch (e) {
        return out({ type: 'ping_result', reqId: msg.reqId, error: friendlyError(e?.message || e) });
      }
    case 'config': // 设置页改了一项（主进程已经写进配置文件）
      return applyConfig(msg.key, msg.value, msg.label).catch((e) => {
        log('apply config failed', e);
        out({ type: 'config_error', key: msg.key, message: String(e?.message || e) });
      });
    case 'to_pinyin': // 设置页加唤醒词：汉字自动转成拼音
      try {
        const tokens = kwsTokens(msg.text);
        return out({ type: 'pinyin', reqId: msg.reqId, tokens, ...checkKeyword(tokens) });
      } catch (e) {
        return out({ type: 'pinyin', reqId: msg.reqId, tokens: '', ok: false, error: e.message });
      }
    case 'check_keyword':
      return out({ type: 'keyword_check', reqId: msg.reqId, ...checkKeyword(msg.tokens) });
    case 'memory_query':
      return out({ type: 'memory', reqId: msg.reqId, ...memory.list(), journal: memory.journal(40), status: memoryStatus() });
    case 'memory_search':
      return out({ type: 'memory_hits', reqId: msg.reqId, items: await searchMemory(String(msg.q || ''), 30) });
    case 'memory_edit': {
      // 记忆页上加、改、删（宿主自己动手的，不在对话里冒提示）
      const op = msg.op === 'add' ? { op: 'add', file: msg.file, text: msg.text } : msg.op === 'update' ? { op: 'update', id: msg.id, text: msg.text } : { op: 'remove', id: msg.id };
      const { change, skipped } = memory.apply([op], { by: '记忆页' });
      if (change) store.log('mem', `记忆页：${change.summary}`);
      return out({ type: 'memory_edited', reqId: msg.reqId, ok: !!change, error: skipped[0]?.reason || '' });
    }
    case 'memory_undo':
      try {
        const c = memory.undo(msg.id);
        store.log('mem', c.summary);
        return out({ type: 'memory_undone', reqId: msg.reqId, ok: true, id: msg.id, summary: c.summary });
      } catch (e) {
        return out({ type: 'memory_undone', reqId: msg.reqId, ok: false, id: msg.id, error: e.message });
      }
    case 'memory_review': {
      const r = await reviewMemory('手动');
      return out({ type: 'memory_reviewed', reqId: msg.reqId, ...r });
    }
    case 'secrets_changed': // 设置页里换了硅基流动的密钥
      loadSecrets();
      embedder.pausedUntil = 0;
      embedder.status = { ok: null, reason: '' };
      if (cfg.memory.embed.chat) setTimeout(indexChat, 1000);
      return out({ type: 'memory_status', status: memoryStatus() });
    case 'embed_test':
      try {
        await embedder.embed(['宿主系统向量检索测试']);
        return out({ type: 'embed_result', reqId: msg.reqId, ok: true });
      } catch (e) {
        return out({ type: 'embed_result', reqId: msg.reqId, ok: false, error: e.message });
      }
    case 'skills_query':
      return out({ type: 'skills', reqId: msg.reqId, ...skills.snapshot(), enabled: cfg.skills.enabled !== false, suggest: cfg.skills.suggest !== false });
    case 'skill_decide': // 卡片、技能页上点了「保存 / 改 / 安装」「不要了 / 不改 / 不装」
      try {
        const r = decideSkill(msg.id, msg.answer, 'click', !!msg.force);
        return out({ type: 'skill_decided', reqId: msg.reqId, ok: true, folder: r.folder || null, title: r.title });
      } catch (e) {
        return out({ type: 'skill_decided', reqId: msg.reqId, ok: false, error: e.message });
      }
    case 'skill_op': // 技能页：开关、改口令、删除、恢复、撤销
      try {
        return out({ type: 'skill_op_done', reqId: msg.reqId, ok: true, ...skillOp(msg) });
      } catch (e) {
        return out({ type: 'skill_op_done', reqId: msg.reqId, ok: false, error: e.message });
      }
    case 'skill_diff':
      return out({ type: 'skill_diff', reqId: msg.reqId, ...(skills.diff(msg.id) || {}) });
    case 'skill_install': // 技能页「从网址装」
      try {
        const r = await installSkill(msg.url, msg.pick);
        return out({ type: 'skill_install_result', reqId: msg.reqId, ok: true, candidates: r.candidates || null, pending: r.pending || null, source: r.source || '' });
      } catch (e) {
        return out({ type: 'skill_install_result', reqId: msg.reqId, ok: false, error: e.message });
      }
    case 'skill_run': {
      // 技能页「现在跑一次」
      const sk = skills.get(msg.folder);
      if (!sk) return out({ type: 'notice', text: '这个技能已经不在了。' });
      if (!sk.avail.ok) return out({ type: 'notice', text: `技能「${sk.title}」在这台电脑上用不了：${sk.avail.reasons.join('；')}` });
      if (!brainReady || brain.busy) return out({ type: 'notice', text: '系统正在忙，等这件事做完再跑。' });
      const text = `跑一次技能「${sk.title}」`;
      out({ type: 'heard', text });
      return runSkill(sk, text, 'skill');
    }
    case 'skill_open': {
      // 「用记事本改」「先看看文件」「打开文件夹」：只开技能文件夹里的东西
      let target = null;
      let notepad = false;
      if (msg.folder) {
        const sk = skills.get(msg.folder);
        if (sk) [target, notepad] = msg.file ? [sk.file, true] : [sk.dir, false];
      } else if (msg.pending) target = skills.pending().find((x) => x.id === msg.pending)?.install?.dir || null;
      else target = skills.dir;
      if (!target || !fs.existsSync(target)) return out({ type: 'notice', text: '找不到这个文件了。' });
      spawn(notepad ? 'notepad.exe' : 'explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      store.log('skill', notepad ? `用记事本打开技能「${skills.get(msg.folder)?.title}」` : `打开文件夹 ${target}`);
      return;
    }
    case 'skill_from_task': {
      // 「要存成技能吗」点了「存成技能」：等于宿主说了这句话
      const text = `把刚才「${String(msg.text || '').slice(0, 40)}」这套做成技能`;
      out({ type: 'heard', text });
      return ask(text, 'text');
    }
    case 'skill_suggest_no':
      skills.declineSuggest(String(msg.text || ''));
      store.log('skill', `不存成技能：「${String(msg.text || '').slice(0, 40)}」，这类流程以后不再问`);
      return;
    case 'appraise_state': // 桌面那边：鉴定卡开着没有
      appraiseOpen = !!msg.open;
      return;
    case 'appraise_req':
      return runAppraise(msg);
    case 'appraise_scan_req':
      return runScan(msg);
    case 'appraise_action': // 卡片上的「追问」「帮我处理」「在软件上标出来」
      return appraiseAction(msg.id, msg.action);
    case 'appraise_failed':
      out({ type: 'notice', text: msg.error });
      return mouth.say('鉴定失败。');
    case 'appraise_start': // 面板、托盘之外的入口（目前没用到）
      return startAppraise(msg.mode || 'select');
    case 'appraise_info':
      return out({ type: 'appraise_info', reqId: msg.reqId, count: appraise.count() });
    case 'appraise_clear':
      appraise.clear();
      store.log('sys', '清空了鉴定存档');
      return out({ type: 'appraise_info', reqId: msg.reqId, count: 0 });
    case 'tasks_query':
      return out({ type: 'tasks', reqId: msg.reqId, ...tasks.snapshot() });
    case 'task_cancel': {
      const gone = tasks.cancel(msg.id);
      if (gone.length) store.log('task', `取消：${gone.map((x) => x.name).join('、')}`);
      return;
    }
    case 'reminder_answer': // 提醒卡片上点了「知道了」或「10 分钟后再提醒」
      return answerReminder(msg.id, msg.answer === 'snooze' ? { snooze: msg.minutes || 10 } : 'ack', 'click');
    case 'wake_test': // 设置页「边说边测」：听到唤醒词只报告，不叫醒
      wakeTest = !!msg.on;
      return;
    case 'listen': // 快捷键或点击叫醒
      if ((brain.confirmPending || projects.confirmPending) && cfg.voiceConfirm) return listen('confirm', 90_000);
      return listen('command', cfg.voice.listenTimeoutMs);
    case 'cancel_listen':
      return stopListening();
    case 'stop':
      return stop();
    case 'confirm_answer':
      if (String(msg.id).startsWith('p:')) return projects.answerConfirm(msg.id, msg.answer);
      return brain.answerConfirm(msg.id, msg.answer, 'click');
    case 'projects_query':
      return out({ type: 'projects', reqId: msg.reqId, items: projects.list().map((p) => ({ ...p, card: p.card ? cardOut(p.card) : null })) });
    case 'project_snapshot': {
      const c = projects.get(msg.projectId);
      return out({ type: 'project_snapshot', reqId: msg.reqId, projectId: msg.projectId, ...(c ? { ...c.snapshot({ events: !msg.light }), card: cardOut(c.card()) } : { error: '没有这个项目了' }) });
    }
    case 'project_action':
      return projectAction(msg);
    case 'takeover_answer':
      return operator.answerTakeover(msg.id, msg.answer);
    case 'user_input': // 宿主最近一次按键 / 点鼠标（判断宿主是不是在忙）
      operator.userInputAt = msg.at || Date.now();
      return;
    case 'user_takeback': // 接管前台期间宿主动了鼠标或按了 Esc
      return operator.userTookBack();
    case 'capture_result':
      return captures.get(msg.id)?.(msg);
    case 'xw_ui': // 讲解窗口里点的（翻页、播放、点图展开、圈字、追问、画好没有）
      return explain.fromWindow(msg).catch((e) => log('explain window failed', e));
    case 'explain_open': {
      // 面板图解卡的「打开」；托盘「讲解窗口」不带 id：打开最近一页
      const page = explain.load(msg.id || explain.index().at(-1)?.id);
      if (page) explain.open(page);
      else out({ type: 'notice', text: '还没有讲解。跟系统说「画图给我讲讲……」试试。' });
      return;
    }
    case 'explain_spoken': // 面板报告一段讲解旁白念完了
      return explain.voice.spoken(msg.key);
    case 'explain_clear': // 设置页「清空讲解」
      store.log('sys', '清空了讲解存档');
      return explain.clear();
    case 'guide_ctl': // 就地讲解卡上的按钮
      return guide.tourCmd(msg.op);
    case 'tutor_ctl': // 教学卡上的按钮
      return guide.tutorCmd(msg.op);
    case 'host_click': // 教学时宿主点了哪（屏幕物理像素）
      return guide.onClick(msg.x, msg.y);
    case 'set_wake': // 直播模式开关：关掉语音唤醒和连续对话
      ear?.setWakeEnabled(msg.enabled);
      if (!msg.enabled && listenMode === 'followup') stopListening();
      return out({ type: 'wake_enabled', enabled: !!msg.enabled });
    case 'new_session': // 换个话题：大脑的上下文清空，面板上还是同一个窗口
      if (brainReady) await brain.reset();
      store.log('sys', '换了个话题（大脑的上下文清空，以前的对话还在）');
      return out({ type: 'topic_reset' });
    case 'voice_state': // 面板在不在放系统的声音
      return ear?.setOutputActive(!!msg.playing && !cfg.speech.headphones);
    case 'speak': // 面板要系统念一句（开机自检通过之类）
      return mouth.say(String(msg.text || ''));
    case 'voice_stop':
      return mouth.stop();
    case 'set_speech':
      return mouth.setMode(msg.mode);
    case 'ptt':
      if (msg.state === 'down') return pttDown();
      return pttUp(msg.state === 'cancel');
    case 'debug_feed_wav':
      if (process.env.HOSTBOUND_DEBUG && ear) await ear.feedWave(msg.path);
      return out({ type: 'debug_fed', path: msg.path });
    case 'quit':
      if (task) taskEnd('stopped', '系统退出，任务中止。');
      tasks.stop();
      memory.close();
      skills.close();
      projects.dispose();
      mouth.shutdown();
      screen.close();
      await ear?.stopMic();
      process.exit(0);
  }
}

if (viaIpc) {
  process.on('message', (m) => handle(m).catch((e) => log('handle failed', e)));
  process.on('disconnect', () => process.exit(0));
} else {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    handle(JSON.parse(line)).catch((e) => log('handle failed', e));
  });
}

// ---- 启动 ----
(async () => {
  // 声音引擎先起：显卡模型要加载十来秒，跟耳朵、大脑一起准备
  mouth.setMode(process.env.HOSTBOUND_SPEECH_MODE || cfg.speech.mode);
  process.env.HOSTBOUND_FX_URL = await operator.startFxServer();
  await startEar();
  store.prune(cfg.logKeepDays || 30);
  startTasks();
  memory.watch();
  skills.prune();
  skills.watch();
  projects.init();
  setInterval(() => {
    store.prune(cfg.logKeepDays || 30);
    skills.prune();
  }, 6 * 3600_000).unref();

  try {
    brainReady = await brain.init();
    log(brainReady ? `brain ready: ${brain.modelName}` : 'brain missing: no usable model');
    store.log('sys', brainReady ? `系统启动 · 大脑：${brain.modelName}` : '系统启动 · 没找到能用的模型密钥');
    out(brainReady ? { type: 'brain_ready', model: brain.modelName, workdir: brain.workdir } : { type: 'brain_missing' });
    if (brainReady) setTimeout(indexChat, 5000);
  } catch (e) {
    log('brain init failed', e);
    store.log('err', '大脑起不来', String(e?.message || e));
    out({ type: 'brain_missing', message: String(e?.message || e) });
  }
})();

// ---- 系统任务：到点提醒、到点去做、主动报告、直播检测 ----
let lastReminder = null; // 最近一次到点的提醒（等宿主说「知道了」「过十分钟再提醒」）
const doQueue = []; // 到点要去做的事：大脑忙着就排队
function startTasks() {
  tasks.on('changed', (snap) => out({ type: 'tasks', ...snap }));
  tasks.on('created', ({ task: t }) => {
    out({ type: 'quest', task: { id: t.id, name: t.name, do: t.do, nextAt: t.nextAt, when: describeSchedule(t.schedule, cfg.timezone || '') } });
    store.log('task', `发布：${t.name} · ${describeSchedule(t.schedule, cfg.timezone || '')}`, t.do ? `到点去做：${t.do}` : t.say || '');
  });
  tasks.on('fire', ({ task: t, late }) => {
    const missed = late ? `（错过了 ${Math.round(late / 60_000)} 分钟）` : '';
    if (t.do) {
      store.log('task', `到点去做：${t.name}${missed}`, t.do);
      doQueue.push(t);
      return runQueue();
    }
    store.log('task', `到点提醒：${t.name}${missed}`, t.say || '');
    lastReminder = t;
    const say = t.say || `宿主，到点了：${t.name}。`;
    out({ type: 'reminder', task: { id: t.id, name: t.name, say, late } });
    if (cfg.fx.enabled && cfg.fx.notice) out({ type: 'fx', kind: 'notice', mode: noticeMode(), tone: 'gold', title: '【任务提醒】', text: t.name, meta: late ? `错过了 ${Math.round(late / 60_000)} 分钟 · 刚开机补上` : '限时任务到点' });
    mouth.say(missed ? `${say}这条提醒错过了${Math.round(late / 60_000)}分钟。` : say);
    if (ear && !liveMode() && !brain.busy && !brain.confirmPending) listen('reminder', 20_000);
  });
  tasks.on('report', (r) => {
    store.log('task', `${r.title}：${r.text}`, r.meta);
    out({ type: 'report', ...r });
    // 下载完成只在角落弹个小提示；电量低、宿主让盯着的，照提醒的规矩来
    if (cfg.fx.enabled) out({ type: 'fx', kind: 'notice', mode: r.kind === 'watch' ? noticeMode() : 'toast', tone: r.kind === 'battery' ? 'err' : 'ok', title: r.title, text: r.text, meta: r.meta });
    if (r.say) mouth.say(r.say);
  });
  tasks.on('live', ({ on, source }) => {
    store.log('task', on ? `检测到在直播（${source}）` : '直播结束');
    out({ type: 'auto_live', on, source });
  });
  tasks.start();
}
// 到点去做的事：等大脑空下来，一件一件做
function runQueue() {
  if (!brainReady || brain.busy || brain.confirmPending || !doQueue.length) return;
  const t = doQueue.shift();
  out({ type: 'quest_run', task: { id: t.id, name: t.name, do: t.do } });
  ask(t.do, 'task').finally(() => setTimeout(runQueue, 500));
}
brain.on('busy', (b) => {
  if (!b) setTimeout(runQueue, 800);
  if (!b && reloadWhy) setTimeout(reloadIfIdle, 1500);
});
// 大脑的提示（常驻记忆、技能目录）跟着一段对话冻结：要换就等它空下来重新加载一次（对话接着原来的）
let reloadWhy = '';
function scheduleReload(why) {
  reloadWhy ||= why;
  if (!brain.busy) setTimeout(reloadIfIdle, 1500);
}
function reloadIfIdle() {
  if (!reloadWhy || !brainReady || brain.busy || brain.confirmPending) return;
  const why = reloadWhy;
  reloadWhy = '';
  brain.reload().then(() => log(`brain reloaded: ${why}`)).catch((e) => log('reload failed', e));
}
function answerReminder(id, answer, by) {
  const t = lastReminder && (!id || lastReminder.id === id) ? lastReminder : null;
  if (listenMode === 'reminder') stopListening();
  if (!t) return;
  lastReminder = null;
  if (answer?.snooze) {
    const n = tasks.snooze(t, answer.snooze);
    store.log('task', `${t.name}：${answer.snooze} 分钟后再提醒${by === 'voice' ? '（语音）' : ''}`);
    out({ type: 'reminder_closed', id: t.id, answer: 'snooze', minutes: answer.snooze, nextAt: n.nextAt });
    mouth.say(`收到，${answer.snooze}分钟后再提醒宿主。`);
  } else {
    store.log('task', `${t.name}：宿主说知道了${by === 'voice' ? '（语音）' : ''}`);
    out({ type: 'reminder_closed', id: t.id, answer: 'ack' });
  }
}

// ---- 长期记忆：自动整理、提示、向量 ----
// 记了东西：对话里冒一行「记忆已更新」（记忆页上宿主自己改的不冒）
function memoryNotice(change) {
  if (!change || change.by === '记忆页') return;
  out({ type: 'memory_update', change: { id: change.id, by: change.by, summary: change.summary, ops: change.ops.map((o) => ({ op: o.op, file: o.file, id: o.id, text: o.after || o.before })) } });
}
memory.on('changed', ({ change, external }) => {
  out({ type: 'memory_status', status: memoryStatus() });
  if (external) store.log('mem', '宿主手动改了记忆文件，已重新读');
});
function sinceReview() {
  const c = memory.cursor;
  return store.allMessages().filter((m) => m.role === 'user' && m.at > c).length;
}
function memoryStatus() {
  return {
    enabled: cfg.memory.enabled !== false,
    autoReview: cfg.memory.autoReview !== false,
    every: cfg.memory.reviewEvery || 10,
    since: sinceReview(),
    lastReview: memory.cursor || null,
    reviewing: !!reviewing,
    vector: recall.status(),
    chatVectors: cfg.memory.embed.chat !== false,
  };
}
// 自动整理：每 10 轮对话、对话压缩前；记忆页上也能手动跑一次
let reviewing = null;
async function reviewMemory(why) {
  if (cfg.memory.enabled === false) return { ok: false, error: '记忆已暂停' };
  if (why !== '手动' && cfg.memory.autoReview === false) return { ok: false, error: '自动整理关着' };
  if (!brainReady) return { ok: false, error: '大脑还没准备好' };
  if (reviewing) return reviewing;
  reviewing = (async () => {
    const cursor = memory.cursor;
    const msgs = store.allMessages().filter((m) => m.role !== 'divider' && m.at > cursor);
    if (!msgs.some((m) => m.role === 'user')) return { ok: true, change: null, note: '没有新的对话' };
    out({ type: 'memory_status', status: { ...memoryStatus(), reviewing: true } });
    try {
      const r = await brain.modelRuntime.completeSimple(
        brain.model,
        { systemPrompt: REVIEW_PROMPT, messages: [{ role: 'user', content: reviewInput(memory, msgs), timestamp: Date.now() }] },
        { reasoning: 'low', maxTokens: 3000 },
      );
      if (r.errorMessage) throw new Error(r.errorMessage);
      const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const { change, skipped } = memory.apply(parseReviewOps(text), { by: '自动整理' });
      memory.cursor = msgs.at(-1).at;
      store.log('mem', `自动整理（${why}）：${change ? change.summary : '没有要改的'}`, skipped.length ? `没采用 ${skipped.length} 条：${skipped.map((s) => s.reason).join('；')}` : '');
      memoryNotice(change);
      return { ok: true, change: change ? { id: change.id, summary: change.summary } : null, skipped: skipped.length };
    } catch (e) {
      log('memory review failed', e);
      store.log('err', `自动整理记忆没成功（${why}）`, String(e?.message || e));
      return { ok: false, error: String(e?.message || e) };
    } finally {
      out({ type: 'memory_status', status: { ...memoryStatus(), reviewing: false } });
    }
  })().finally(() => (reviewing = null));
  return reviewing;
}
// 以前的对话：后台补算向量
function indexChat() {
  if (cfg.memory.embed.chat === false || !embedder.available) return;
  recall.indexChat(store.allMessages()).then((n) => {
    if (n) log(`memory: 给 ${n} 句对话算了向量`);
    out({ type: 'memory_status', status: memoryStatus() });
  });
}
function afterTurn() {
  if (sinceReview() >= (cfg.memory.reviewEvery || 10)) reviewMemory('每 10 轮');
  indexChat();
}

// ---- 鉴定术 ----
let appraiseOpen = false; // 屏幕上的鉴定卡、选择层开着没有
const appraiseImages = new Map(); // 最近几次鉴定的图（追问、帮我处理时带给大脑）：id → { image, card, label, at }
let attachNext = null; // 刚鉴定完：下一句话（5 分钟内）带上那张图
const APPRAISE_HINT = { select: '鉴定模式已开启。点窗口、拖框，或者按 F 鉴定整块屏幕。', window: '开始鉴定当前窗口。', screen: '开始扫描全屏。' };
function startAppraise(mode) {
  out({ type: 'appraise_start', mode });
  out({ type: 'appraise_hint', text: APPRAISE_HINT[mode] || APPRAISE_HINT.select });
  mouth.say(mode === 'screen' ? '开始扫描全屏。' : mode === 'window' ? '开始鉴定。' : '鉴定模式已开启。');
}
const cardForPanel = (rec) => ({ ...rec, thumb: rec.thumb ? `data:image/jpeg;base64,${appraise.thumb(rec.id) || ''}` : null });
function keepImage(id, v) {
  appraiseImages.set(id, v);
  while (appraiseImages.size > 6) appraiseImages.delete(appraiseImages.keys().next().value);
}
// 这句话要带的图：点了某张卡的「追问」就带那张；刚鉴定完 5 分钟内的下一句话带刚才那张
function attachImages(id) {
  let a = id ? appraiseImages.get(id) : null;
  if (id && !a) {
    const thumb = appraise.thumb(id);
    if (thumb) a = { image: { data: thumb, mimeType: 'image/jpeg' } };
  }
  if (!a && attachNext && Date.now() - attachNext.at < 5 * 60_000) a = appraiseImages.get(attachNext.id);
  attachNext = null;
  return a?.image ? [{ type: 'image', data: a.image.data, mimeType: a.image.mimeType || 'image/jpeg' }] : undefined;
}
async function runAppraise(m) {
  if (!brainReady) return out({ type: 'appraise_result', id: m.id, ok: false, error: '大脑还没连上：没有可用的模型密钥' });
  const what = m.kind === 'window' ? `窗口「${m.label}」` : m.kind === 'display' ? '整块屏幕' : `框住的一块（${m.image?.width}×${m.image?.height}）`;
  store.log('screen', `鉴定：${what}，截图发给了模型`, m.masked ? `禁止操作的软件涂黑了 ${m.masked} 块` : '截图本身不存，只存一张小缩略图');
  try {
    const card = await appraise.run({
      image: m.image,
      label: m.kind === 'window' ? m.label : '',
      question: m.question,
      onPart: (p) => out({ type: 'appraise_part', id: m.id, key: p.key, value: p.value, part: p.part }),
    });
    out({ type: 'appraise_result', id: m.id, ok: true, card });
    const rec = appraise.save({ id: m.id, kind: m.kind, label: m.label, app: m.app, question: m.question, ...card }, m.thumb);
    out({ type: 'appraise_card', rec: { ...rec, thumb: m.thumb ? `data:image/jpeg;base64,${m.thumb}` : null } });
    keepImage(m.id, { image: m.image, card, label: m.label, app: m.app, at: Date.now() });
    attachNext = { id: m.id, at: Date.now() };
    brain.note(noteOf(card, m.kind === 'window' ? m.label : ''));
    store.log('screen', `鉴定结果：${card.name}${card.rarity ? `（${card.rarity}）` : card.tag ? `（${card.tag}）` : ''}`, card.verdict);
    mouth.say(`鉴定完成。${card.say}`);
  } catch (e) {
    log('appraise failed', e);
    store.log('err', '鉴定没成功', String(e?.message || e));
    out({ type: 'appraise_result', id: m.id, ok: false, error: friendlyError(e?.message || e) });
    mouth.say('鉴定失败。');
  }
}
async function runScan(m) {
  if (!brainReady) return out({ type: 'appraise_scan_done', id: m.id, verdict: '大脑还没连上，扫描不了', count: m.count });
  const all = m.screens.flatMap((s) => s.windows);
  store.log('screen', `全屏扫描：${m.screens.length} 块屏幕、${all.length} 个窗口，截图发给了模型`, '聊天软件、禁止操作的软件先涂黑了');
  try {
    const r = await appraise.scan({ screens: m.screens, onTag: (t) => out({ type: 'appraise_tag', id: m.id, windowId: t.id, label: t.label }) });
    out({ type: 'appraise_scan_done', id: m.id, verdict: r.verdict, count: all.length });
    const name = (w) => String(w.exe || '').replace(/\.exe$/i, '') || '窗口';
    const lines = r.tags.map((t) => `${name(all.find((w) => w.id === t.id) || {})}：${t.label}`);
    const rec = appraise.save({ id: m.id, kind: 'scan', name: `检测到 ${all.length} 个窗口`, style: 'practical', tag: '全屏', fields: lines.slice(0, 6).map((l) => l.split('：')), verdict: r.verdict, advice: '', actions: [] }, null);
    out({ type: 'appraise_card', rec: cardForPanel(rec) });
    brain.note(`全屏扫描了一遍：${lines.join('；')}${r.verdict ? `。评价：${r.verdict}` : ''}`.slice(0, 400));
    mouth.say(`扫描完成，检测到${all.length}个窗口。${String(r.verdict || '').split(/(?<=[。！？])/)[0]}`);
  } catch (e) {
    log('scan failed', e);
    store.log('err', '全屏扫描没成功', String(e?.message || e));
    out({ type: 'appraise_scan_done', id: m.id, verdict: `扫描失败：${friendlyError(e?.message || e)}`, count: all.length });
    mouth.say('扫描失败。');
  }
}
// 卡片上的按钮：追问（翻到对话、起个头）、帮我处理（交给大脑去做）、在软件上标出来（就地讲解）
function appraiseAction(id, action) {
  const a = appraiseImages.get(id);
  const rec = a ? { name: a.card.name, ...a.card, label: a.label } : appraise.list().find((r) => r.id === id);
  if (!rec) return out({ type: 'notice', text: '这次鉴定的记录找不到了。' });
  if (action === 'followup') return out({ type: 'appraise_followup', id, name: rec.name });
  const text =
    action === 'fix'
      ? `帮我处理刚才鉴定的「${rec.name}」：${rec.advice || rec.verdict || ''}`
      : `在软件上给我讲讲「${rec.label || rec.name}」这个窗口，把常用的地方标出来`;
  out({ type: 'heard', text });
  return ask(text, 'text', { appraise: id });
}

// ---- 技能：口令、卡片、「要存成技能吗」、从网址装 ----
let pendingShownAt = 0;
skills.on('pending', (v) => {
  pendingShownAt = Date.now();
  out({ type: 'skill_pending', entry: v });
  if (v.kind === 'new') store.log('skill', `技能草稿「${v.title}」等宿主确认（${v.by}）`);
  else if (v.kind === 'improve') store.log('skill', `技能「${v.title}」的改进等宿主确认`, v.change);
});
skills.on('resolved', (r) => out({ type: 'skill_resolved', ...r }));
skills.on('changed', ({ external } = {}) => {
  out({ type: 'skills_changed' });
  if (external) store.log('skill', '宿主手动改了技能文件，已重新读');
  if (brainReady && cfg.skills.enabled !== false && skills.indexKey() !== brain.skillsKey) scheduleReload('技能变了，技能目录换成新的');
});

function skillHit(text) {
  if (cfg.skills.enabled === false || !brainReady || brain.busy) return null;
  return skills.match(text);
}
function runSkill(sk, text, via) {
  store.log('skill', `跑技能「${sk.title}」`, via === 'skill' ? '技能页点的' : `口令「${text}」`);
  skills.markUsed(sk.folder);
  return ask(text, via, { skill: sk });
}

// 卡片上点的、嘴上说的「保存 / 不要了」都走这里；顺便在下一句话里告诉大脑
function decideSkill(id, answer, by = 'click', force = false) {
  const how = by === 'voice' ? '（语音）' : '';
  if (answer === 'save') {
    const r = skills.approve(id, { force });
    const what = { new: '保存了技能', improve: '改了技能', install: '安装了技能' }[r.kind];
    store.log('skill', `${what}「${r.title}」${how}`);
    brain.note(`${what}「${r.title}」`);
    return r;
  }
  const r = skills.reject(id);
  const what = { new: '没要技能草稿', improve: '没采用技能改进', install: '没装技能' }[r.kind];
  store.log('skill', `${what}「${r.title}」${how}`);
  brain.note(`${what}「${r.title}」`);
  return r;
}
// 技能卡片弹出来 10 分钟内，整句是「保存」「不要了」「安装」「不装」：直接处理，不问大脑
function projectGo(text) {
  const c = parseProjectGo(text) ? projects.pendingPlan() : null;
  if (!c) return false;
  out({ type: 'heard', text });
  store.log('task', `项目「${c.project?.name}」开工（宿主说「${text}」）`);
  c.approve().catch((e) => log('project approve failed', e));
  return true;
}

function skillAnswer(text, by, speak = true) {
  const e = skills.latestPending();
  if (!e || Date.now() - pendingShownAt > 10 * 60_000) return false;
  const answer = parseSkillAnswer(text, e.kind);
  if (!answer) return false;
  if (by === 'voice') out({ type: 'heard', text });
  try {
    decideSkill(e.id, answer, by);
    if (speak) mouth.say(answer === 'save' ? { new: '技能已保存。', improve: '技能已修改。', install: '技能已安装。' }[e.kind] : '收到，不要了。');
  } catch (err) {
    out({ type: 'notice', text: `没办成：${err.message}` });
    if (speak) mouth.say('没办成。');
  }
  return true;
}

// 一条指令做完：用了很多动作、或者宿主中途纠正过，冒一行「要存成技能吗」（不念、不自动存）
function maybeSuggest(t, result) {
  if (!t || result !== 'ok' || cfg.skills.enabled === false || cfg.skills.suggest === false) return;
  if (t.skill || t.noSuggest || !['voice', 'text'].includes(t.via)) return;
  const tools = t.steps.filter((x) => x.tool).length;
  if (!(tools >= (cfg.skills.minActions || 5) || (t.steered && tools >= 2))) return;
  if (skills.suggestDeclined(t.text)) return;
  out({ type: 'skill_suggest', id: t.id, text: t.text, tools, steered: t.steered });
}

function skillOp(m) {
  switch (m.op) {
    case 'toggle': {
      const sk = skills.setEnabled(m.folder, !!m.on);
      store.log('skill', `${m.on ? '启用' : '停用'}技能「${sk.title}」`);
      return {};
    }
    case 'triggers': {
      const c = skills.setTriggers(m.folder, m.triggers);
      store.log('skill', `技能「${c.title}」${c.summary}`);
      return {};
    }
    case 'remove': {
      const c = skills.remove(m.folder);
      store.log('skill', `删除技能「${c.title}」（回收区里 30 天内能恢复）`);
      return {};
    }
    case 'restore': {
      const c = skills.restore(m.key);
      store.log('skill', `恢复技能「${c.title}」`);
      return { folder: c.folder };
    }
    case 'undo': {
      const c = skills.undo(m.id);
      store.log('skill', `技能「${c.title}」：${c.summary}`);
      return {};
    }
    case 'refresh':
      skills.refresh();
      return {};
  }
  throw new Error('不认识的操作');
}

// 从网址装：下载到隔离区、程序查一遍、模型写大白话报告，弹卡片等宿主点「安装」
async function installSkill(url, pick) {
  if (cfg.skills.enabled === false) throw new Error('技能功能关着');
  store.log('skill', `检查技能：${url}${pick ? `（${pick}）` : ''}`);
  const r = await skills.prepareInstall(url, { pick, report: brainReady ? skillReport : null });
  if (r.pending) store.log('skill', `检查完「${r.pending.title}」：风险${{ low: '低', medium: '中', high: '高' }[r.pending.install.risk]}`, r.pending.install.report.why);
  return r;
}
async function skillReport(input) {
  const r = await brain.modelRuntime.completeSimple(
    brain.model,
    { systemPrompt: REPORT_PROMPT, messages: [{ role: 'user', content: input, timestamp: Date.now() }] },
    { reasoning: 'low', maxTokens: 1500 },
  );
  if (r.errorMessage) throw new Error(r.errorMessage);
  return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
}

// ---- 耳朵：开机时起一次；换麦克风、改唤醒词、灵敏度时重启 ----
let wakeTest = false;
async function startEar() {
  try {
    ear = new Ear({ modelsDir: path.join(root, 'models'), ...cfg.voice });
    ear.on('wake', (keyword) => {
      log('wake:', keyword);
      if (wakeTest) return out({ type: 'wake_test_hit', keyword });
      store.log('voice', `唤醒 · ${keyword}`);
      out({ type: 'wake', keyword });
      listen('command', cfg.voice.listenTimeoutMs);
    });
    ear.on('listening', () => out({ type: 'listening', mode: listenMode }));
    ear.on('speech_start', () => out({ type: 'speech_start' }));
    ear.on('level', (v) => out({ type: 'level', v }));
    ear.on('listen_timeout', () => {
      const mode = listenMode;
      listenMode = null;
      log('listen timeout', `(${mode})`);
      if (mode === 'confirm' && brain.confirmPending) return listen('confirm', 60_000);
      if (mode === 'reminder') return out({ type: 'listen_timeout', mode });
      out({ type: 'listen_timeout', mode });
    });
    ear.on('transcript', (text) => onTranscript(text).catch((e) => log('transcript failed', e)));
    ear.on('stopword', () => {
      mouth.stop(); // 系统正在说话：先闭嘴
      if (brain.busy) stop();
    });
    ear.on('error', (e) => log('ear error', e));
    const mic = await ear.startMic(cfg.voice.mic);
    log('voice ready:', mic);
    out({ type: 'voice_ready', mic, wakeWords: cfg.voice.wakeWords.map((w) => w.text), wakeEnabled: ear.wakeEnabled });
  } catch (e) {
    log('voice init failed', e);
    store.log('err', '听觉模块起不来', String(e?.message || e));
    ear = null;
    out({ type: 'voice_error', message: String(e?.message || e) });
  }
}

async function restartEar() {
  const wakeOn = ear ? ear.wakeEnabled : cfg.voice.wakeEnabled !== false;
  stopListening();
  if (ear) {
    ear.removeAllListeners();
    await ear.stopMic();
  }
  ear = null;
  cfg.voice.wakeEnabled = wakeOn;
  await startEar();
}

// 唤醒词的拼音：模型认不认识这些音节
function checkKeyword(tokens) {
  try {
    const dir = fs.readdirSync(path.join(root, 'models')).find((n) => n.startsWith('sherpa-onnx-kws-zipformer-wenetspeech'));
    const known = new Set(fs.readFileSync(path.join(root, 'models', dir, 'tokens.txt'), 'utf8').split(/\r?\n/).map((l) => l.split(' ')[0]).filter(Boolean));
    const missing = String(tokens || '').split(/\s+/).filter((t) => t && !known.has(t));
    return { ok: !missing.length && !!String(tokens || '').trim(), missing };
  } catch (e) {
    return { ok: false, missing: [], error: e.message };
  }
}

// 设置页「大脑」「操作」「听觉」要显示的状态
async function systemInfo() {
  let mics = [];
  try {
    const { convenience } = createRequire(import.meta.url)('node-cpal');
    mics = [...convenience.getDevices()].filter((d) => d.supportsInput && d.direction !== 'output').map((d) => ({ name: d.name, isDefault: !!d.isDefaultInput }));
  } catch {}
  return {
    brain: brainReady ? await brain.info() : null,
    mic: ear?.micName || null,
    mics,
    engines: { cua: fs.existsSync(screen.cuaPath), ocu: fs.existsSync(screen.ocuPath) },
    voice: !!ear,
  };
}

// ---- 设置页改了一项：在这边生效 ----
function setPath(obj, key, value) {
  const keys = key.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}
const EAR_KEYS = /^voice\.(wakeWords|stopWords|kwsThreshold|kwsScore|endSilence|mic)$/;
const RELOAD_KEYS = /^(workdir|computerUse\.enabled|browser\.enabled|browser\.headed|safety\.blockedApps)$/;
async function applyConfig(key, value, label) {
  setPath(cfg, key, value);
  store.log('sys', `改了设置：${label || key}`, JSON.stringify(value).slice(0, 200));
  if (EAR_KEYS.test(key)) {
    out({ type: 'status', text: '耳朵重新加载中…' });
    await restartEar();
    out({ type: 'status', text: '' });
  } else if (key === 'voice.wakeEnabled') {
    ear?.setWakeEnabled(value);
    out({ type: 'wake_enabled', enabled: !!value });
  } else if (key === 'model') {
    await brain.setModel(value.provider, value.id);
    out({ type: 'brain_ready', model: brain.modelName, workdir: brain.workdir });
  } else if (key === 'model.thinking') {
    brain.setThinking(value);
  } else if (key === 'conversation.contextBudget') {
    brain.applyCompaction();
  } else if (key === 'fx.cursor' || key === 'fx.enabled') {
    operator.cursor = cfg.fx.enabled && cfg.fx.cursor;
  } else if (key.startsWith('watch.')) {
    if (key === 'watch.downloadsDir') tasks.restart('downloads');
    tasks.applyConfig();
    out({ type: 'tasks', ...tasks.snapshot() });
  } else if (key === 'skills.enabled') {
    out({ type: 'skills_changed' });
    if (brainReady) await brain.reload();
  } else if (key === 'logKeepDays') {
    store.prune(value);
  } else if (RELOAD_KEYS.test(key)) {
    if (key === 'browser.headed') {
      if (value) process.env.AGENT_BROWSER_HEADED = '1';
      else delete process.env.AGENT_BROWSER_HEADED;
    }
    if (brainReady) await brain.reload();
  }
  out({ type: 'config_applied', key });
}
