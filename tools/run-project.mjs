// 不开界面、不开耳朵，用真的模型跑一个项目（项目模式实测用）：
//   node tools/run-project.mjs --name 贪吃蛇 --data <记录放哪> --ctl <回答放哪> "宿主原话……"
//   接着改做过的项目：加 --continue 项目名（或 id），原话写这次要改什么
// 模型、密钥跟系统一样（hostbound.config.json 里的模型，pi 里配好的密钥）。计划写好直接开工。
// 总指挥要问宿主、要授权时打印出来，等 --ctl 文件夹里出现回答：answer-<qid>.txt（回答的话）、confirm-<cid>.txt（allow / deny）；
// 授权 10 分钟没人回答就当拒绝。所有事一行一行打印出来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../brain/config.mjs';
import { Projects } from '../brain/projects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args.splice(i, 2)[1] : d;
};
const name = opt('name', '新项目');
const dataDir = opt('data', path.join(root, 'data'));
const ctl = opt('ctl', path.join(dataDir, 'ctl'));
const cont = opt('continue', '');
const request = args.join(' ').trim();
if (!request) {
  console.log('用法：node tools/run-project.mjs --name 名字 --data 记录目录 --ctl 回答目录 "宿主原话"');
  process.exit(2);
}
fs.mkdirSync(ctl, { recursive: true });

const cfg = loadConfig(root);
// 跟大脑一样：agent-browser 用系统的 Chrome（截图用单独的会话，不用宿主登录过的配置）
process.env.PATH = `${path.join(root, 'bin')};${process.env.PATH}`;
if (cfg.browser?.chrome && fs.existsSync(cfg.browser.chrome)) process.env.AGENT_BROWSER_EXECUTABLE_PATH = cfg.browser.chrome;

const t0 = Date.now();
const ts = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const say = (...a) => console.log(ts(), ...a);
const clip = (s, n = 160) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const runtime = await ModelRuntime.create({});
const available = await runtime.getAvailable();
const model = available.find((m) => m.provider === cfg.model.provider && m.id === cfg.model.id);
if (!model) {
  console.log(`模型 ${cfg.model.provider}/${cfg.model.id} 用不了（没配密钥？）`);
  process.exit(2);
}
say(`模型：${model.provider}/${model.id}；项目放在 ${cfg.projects?.root || '用户文件夹\\HostboundProjects'}；记录在 ${dataDir}`);

const projects = new Projects({ dataDir, cfg: () => cfg, runtime: () => runtime, model: () => model, root, log: (...a) => console.error(ts(), '[log]', ...a) });
let finished = null;

// 每件事一行
const roleOf = (c, id) => c?.plan?.agents?.find((a) => a.id === id)?.role || id || '总指挥';
projects.on('event', ({ projectId, ev: e }) => {
  const c = projects.get(projectId);
  const who = roleOf(c, e.agent);
  switch (e.type) {
    case 'plan':
      say('【计划】', JSON.stringify(e.plan, null, 1));
      break;
    case 'dispatch':
      say(`【派活】${who}「${e.title}」第 ${e.attempt} 次`);
      break;
    case 'preview':
      say(`  ${who} ◐ 预览 ${e.url}`);
      break;
    case 'step':
      if (e.kind === 'tool') say(`  ${who} ◆ ${clip(e.text, 120)}${e.detail && e.detail !== e.text ? `  | ${clip(e.detail, 120)}` : ''}`);
      else if (e.kind === 'tool_end' && !e.ok) say(`  ${who} ✗ ${clip(e.error, 200)}`);
      else if (e.kind === 'say') say(`  ${who} › ${clip(e.text, 200)}`);
      else if (e.kind === 'error') say(`  ${who} ! ${clip(e.text, 200)}`);
      break;
    case 'question':
      say(`【提问】${who}：${e.text}`);
      break;
    case 'answer':
      say(`【回答】${e.by === 'host' ? '宿主' : '总指挥'} → ${who}：${clip(e.text, 200)}`);
      break;
    case 'report':
      say(`【汇报】${who}（${e.status}）：${clip(e.summary, 300)}${e.issues?.length ? ` 问题：${e.issues.join('；')}` : ''}`);
      break;
    case 'commit':
      say(`【提交】${who}：${(e.files || []).length} 个文件 ${clip((e.files || []).join(' '), 160)}`);
      break;
    case 'merge':
      say(`【合并】${who}：${e.ok ? '合上了，开始检查' : e.conflict ? `冲突 ${(e.files || []).join(' ')}` : `失败 ${clip(e.output, 200)}`}`);
      break;
    case 'check':
      say(`【检查·${e.scope}】${e.name} ${e.ok ? '过' : '没过'}${e.ms ? ` ${(e.ms / 1000).toFixed(1)}s` : ''}${e.ok ? (e.name === 'shot' ? ` ${e.output}` : '') : `\n${String(e.output || '').slice(-800)}`}`);
      break;
    case 'retry':
      say(`【退回】${who}：${clip(e.why, 300)}`);
      break;
    case 'triage':
      say(`【处理】${who}：${e.action} ${clip(e.note, 200)}`);
      break;
    case 'review':
      say(`【评审】${e.issues?.length ? e.issues.join('；') : '没问题'}`);
      break;
    case 'fix':
      say(`【修】第 ${e.round} 轮：${(e.tasks || []).map((t) => t.title).join('、')}`);
      break;
    case 'budget':
      say(`【预算】${e.level} ¥${(e.costCny || 0).toFixed(2)} / ¥${e.budgetCny}`);
      break;
    case 'status':
      say(`【状态】${e.status}${e.reason ? `（${e.reason}）` : ''}`);
      break;
    case 'error':
      say(`【出错】${e.text}`);
      break;
    case 'done':
      say('【完成】', JSON.stringify(e.result));
      break;
    case 'task_done':
      say(`【任务完成】${who}「${e.title}」`);
      break;
  }
});

// 问宿主 / 授权：打印出来，等回答文件
const waitFile = async (file, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf8').trim();
      fs.rmSync(file, { force: true });
      return v;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};
projects.on('ask', async (q, c) => {
  say(`【问宿主】qid=${q.qid} ${q.text}${q.options?.length ? `  选项：${q.options.join(' / ')}` : ''}  → 回答写到 ${path.join(ctl, `answer-${q.qid}.txt`)}`);
  const a = await waitFile(path.join(ctl, `answer-${q.qid}.txt`), 24 * 3600_000);
  if (a) c.answer(q.qid, a);
});
projects.on('confirm', async (x, c) => {
  say(`【要授权】cid=${x.cid} ${x.label}（${x.agent}）：${clip(x.detail, 300)}  → 写 allow / deny 到 ${path.join(ctl, `confirm-${x.cid}.txt`)}`);
  const a = await waitFile(path.join(ctl, `confirm-${x.cid}.txt`), 10 * 60_000);
  c.confirmAnswer(x.cid, a === 'allow' ? 'allow' : 'deny');
});
let approved = 0;
projects.on('card', (card) => {
  if (card.kind === 'plan' && approved < (card.continued ? 2 : 1)) {
    approved++;
    const c = projects.get(card.projectId);
    if (card.continued) say('【修改计划】', JSON.stringify(c.state.pendingPlan, null, 1));
    say('【开工】计划写好了，直接开工');
    c.approve();
  }
  if (['done', 'stopped', 'failed', 'cancelled'].includes(card.kind)) finished = card;
});

let c;
if (cont) {
  c = projects.resolve(cont);
  if (!c) {
    console.log(`没有叫「${cont}」的项目`);
    process.exit(2);
  }
  approved = 1;
  say(`【接着改】${c.project.name} → ${c.dir}`);
  c.continueWith(request);
} else {
  c = projects.create({ name, request });
  say(`【项目】${c.project.name} → ${c.dir}`);
}
while (!finished) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 1500));
const card = c.card();
say(`【结束】${card.kind}，用时 ${ts()}，花费 ¥${card.costCny}（${(c.state.costUsd || 0).toFixed(4)} 美元）`);
say(`文件夹：${c.dir}`);
c.dispose();
process.exit(0);
