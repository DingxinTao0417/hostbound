// 系统界面：开机自检 → 收成屏幕角落的系统核心 → 唤醒展开系统面板 → 聆听 → 执行 → 授权 → 完成 / 失败 → 收起
const $ = (s) => document.querySelector(s);
const pet = $('#pet');
const grip = $('#grip');
const bubble = $('#bubble');
const titleEl = $('#title');
const codeEl = $('#code');
const logEl = $('#log');
const statusEl = $('#status');
const input = $('#input');
const stopBtn = $('#stop');
const confirmBox = $('#confirm');
const liveEl = $('#live');
const waveEl = $('#wave');
const stepsEl = $('#steps');
const steplineEl = $('#stepline');
const opvEl = $('#opv');
const navEl = $('#nav');

// 在普通浏览器里打开（预览界面）时没有 Electron 桥，用一个假的
const bridge = window.hostbound || {
  onBrain: (cb) => (window.__brain = cb),
  onCmd: (cb) => (window.__cmd = cb),
  send: (m) => console.log('to brain', m),
  setHit: () => {},
  focus: () => {},
  blur: () => {},
  log: () => {},
  config: async () => ({ sleepAfterMs: 45000, wakeWords: ['系统启动'], ui: { petSize: 76, chatWidth: 440, chatHeight: 540, sound: true } }),
};

const GREETINGS = ['系统已启动。宿主，请下达指令。', '系统在线，等待宿主指令。', '已接收唤醒信号。宿主，请吩咐。'];
const FAREWELLS = ['系统进入待机。', '收到，系统待机。'];

let cfg = { sleepAfterMs: 45000, wakeWords: ['系统启动'], ui: { petSize: 76, chatWidth: 440, chatHeight: 540, sound: true } };
let awake = false;
let booting = false;
let busy = false;
let listening = false;
let pendingConfirm = null;
let brainState = { ok: null, message: '' };
let voiceState = { ok: null, message: '' };
let curMsg = null;
let curRaw = '';
let curMsgId = null;
const msgs = new Map(); // 回复：id → 文字跟着声音出现的进度
let sleepTimer = null;
let lastUserEl = null;
const toolEls = new Map();

// ---------- 鼠标穿透：只有系统核心和面板能点，其余地方点到桌面上 ----------
let hitState = false;
let hitLocked = false;
function updateHit(x, y) {
  if (hitLocked) return; // 正在拖核心或拖面板的角，鼠标跑出去也不能放
  const el = document.elementFromPoint(x, y);
  const on = !!(el && el.closest('.hit'));
  if (on !== hitState) {
    hitState = on;
    bridge.setHit(on);
  }
}
function lockHit(on) {
  hitLocked = on;
  if (on) {
    hitState = true;
    bridge.setHit(true);
  }
}
document.addEventListener('mousemove', (e) => updateHit(e.clientX, e.clientY));
document.addEventListener('mouseleave', () => {
  if (hitState && !hitLocked) {
    hitState = false;
    bridge.setHit(false);
  }
});

// ---------- 面板的标题、配色、核心状态 ----------
// tone：''（默认幻彩）、ok（绿）、warn（粉紫）、err（红）；core：核心颜色状态
let page = 'chat';
let chatPlate = { title: '系统通知', code: 'SYS', tone: '' };
const PAGE_PLATE = { mem: ['系统记忆', 'MEMORY'], skill: ['系统技能', 'SKILLS'], task: ['系统任务', 'QUESTS'], rec: ['任务记录', 'HISTORY'], log: ['系统日志', 'LOG'], set: ['系统设置', 'CONFIG'], guide: ['新手引导', 'GUIDE'] };
function paintPlate(title, code, tone) {
  titleEl.textContent = title;
  codeEl.textContent = code;
  bubble.classList.remove('tone-ok', 'tone-warn', 'tone-err', 'tone-gold');
  if (tone) bubble.classList.add('tone-' + tone);
}
function setPanel(title, code, tone = '', core = null) {
  chatPlate = { title, code, tone };
  if (page === 'chat') paintPlate(title, code, tone);
  if (core) pet.dataset.state = core;
}

// ---------- 翻页：对话 / 记录 / 日志 / 设置 / 新手引导 ----------
// 对话页保持原来的大小；别的页面板加宽（记录、日志、设置要放两栏）
function go(p, sub) {
  if (p !== 'chat' && !PAGE_PLATE[p]) return;
  page = p;
  navEl.querySelectorAll('span').forEach((x) => x.classList.toggle('on', x.dataset.p === p));
  document.querySelectorAll('#bubble .page').forEach((x) => x.classList.toggle('on', x.dataset.page === p));
  bubble.classList.toggle('wide', p !== 'chat');
  if (p === 'chat') paintPlate(chatPlate.title, chatPlate.code, chatPlate.tone);
  else paintPlate(PAGE_PLATE[p][0], PAGE_PLATE[p][1], '');
  Pages.show(p, sub);
  layout();
  if (p === 'chat') scrollLog();
}
function toChat() {
  if (page !== 'chat') go('chat');
}
navEl.addEventListener('click', (e) => {
  const x = e.target.closest('span[data-p]');
  if (x) go(x.dataset.p);
});
// 面板是不抢焦点的透明窗口：点到输入框、下拉框时再把键盘焦点要过来
bubble.addEventListener('mousedown', (e) => {
  if (e.target.closest('input, select, textarea')) bridge.focus();
});
function setStatus(text) {
  statusEl.textContent = text || '';
}
function coreState(s) {
  pet.dataset.state = s;
}

const GAP_MS = 30 * 60_000; // 两句话隔了这么久，中间插一条时间
function lastAt() {
  for (let el = logEl.lastElementChild; el; el = el.previousElementSibling) if (el.dataset.at) return +el.dataset.at;
  return 0;
}
function timeText(t) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function timeEl(t) {
  const d = document.createElement('div');
  d.className = 'msg time';
  d.textContent = timeText(t);
  d.dataset.at = t;
  return d;
}
function add(cls, text) {
  const now = Date.now();
  const prev = lastAt();
  if (prev && now - prev > GAP_MS && !/boot/.test(cls)) logEl.appendChild(timeEl(now));
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  d.dataset.at = now;
  logEl.appendChild(d);
  // 面板里最多留 400 条，更早的往上翻时再从存盘里读
  while (logEl.children.length > 400) {
    logEl.firstChild.remove();
    hist.more = true;
  }
  scrollLog();
  return d;
}

const hist = { more: true, loading: false };
function oldestAt() {
  for (const el of logEl.children) if (el.dataset.at && !el.classList.contains('boot')) return +el.dataset.at;
  return Date.now();
}
function histEl(m) {
  if (m.role === 'appraise') return appraiseMini(m.rec);
  const d = document.createElement('div');
  d.className = m.role === 'divider' ? 'msg divider' : 'msg old ' + (m.role === 'user' ? 'user' : 'sys');
  d.textContent = m.text;
  d.dataset.at = m.at;
  return d;
}
// 往上翻：从存盘里再读 40 条，插在最上面（滚动位置不跳）
async function loadOlder() {
  if (hist.loading || !hist.more || !brainState.ok || booting) return false;
  hist.loading = true;
  const r = await Pages.request({ type: 'chat_history', before: oldestAt(), limit: 40 });
  hist.loading = false;
  if (!r) return false;
  hist.more = r.more;
  if (!r.items.length) return false;
  const frag = document.createDocumentFragment();
  let prev = 0;
  for (const m of r.items) {
    if (m.role !== 'divider' && (!prev || m.at - prev > GAP_MS)) frag.append(timeEl(m.at));
    frag.append(histEl(m));
    prev = m.at;
  }
  // 原来最上面那条时间分隔：跟新读进来的挨得很近就去掉
  const first = logEl.firstElementChild;
  if (first?.classList.contains('time') && +first.dataset.at - prev < GAP_MS) first.remove();
  const h0 = logEl.scrollHeight;
  const t0 = logEl.scrollTop;
  logEl.prepend(frag);
  logEl.scrollTop = t0 + (logEl.scrollHeight - h0);
  return true;
}
logEl.addEventListener('scroll', () => {
  if (logEl.scrollTop < 40) loadOlder();
});
// 记录页「在对话里找」：往上翻到那条指令，高亮一下
async function scrollToAt(at) {
  go('chat');
  wake('event');
  for (let i = 0; i < 40; i++) {
    if (oldestAt() <= at + 1000 || !hist.more) {
      let best = null;
      for (const el of logEl.querySelectorAll('.msg.user')) {
        const d = Math.abs(+el.dataset.at - at);
        if (d < 120_000 && (!best || d < best.d)) best = { el, d };
      }
      if (best) {
        best.el.scrollIntoView({ block: 'center' });
        best.el.classList.remove('flash');
        void best.el.offsetWidth;
        best.el.classList.add('flash');
        return;
      }
      break;
    }
    if (!(await loadOlder())) break;
  }
  add('note', '那一条在对话里没找到（可能当时被当成闲聊忽略了）。');
}
// ---------- 阶段 4：【限时任务】卡、倒计时 ----------
let taskSnap = { tasks: [], watches: [], fired: [] };
const pad2 = (n) => String(n).padStart(2, '0');
function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function addCard(card) {
  add('quest-slot', '').replaceWith(card);
  scrollLog();
  return card;
}
function questCard(t, kind) {
  const d = document.createElement('div');
  d.className = 'msg quest' + (kind === 'ring' ? ' due' : kind === 'watch' ? ' due watch' : '');
  d.dataset.id = t.id || '';
  d.dataset.at = Date.now();
  const el = (cls, text) => {
    const x = document.createElement('div');
    x.className = cls;
    x.textContent = text;
    return x;
  };
  if (kind === 'new') {
    d.append(el('tt', t.do ? '【定时任务】已发布' : '【限时任务】已发布'), el('nm', t.name));
    if (t.nextAt && t.nextAt - Date.now() < 24 * 3600_000) {
      const cd = el('cd', fmtLeft(t.nextAt - Date.now()));
      cd.dataset.due = t.nextAt;
      const small = document.createElement('small');
      small.textContent = timeText(t.nextAt).replace(/^今天 /, '') + ' 到点';
      cd.append(small);
      d.append(cd);
    }
    d.append(el('meta', `${t.when || ''}${t.do ? ` · 到点系统去做：${t.do}` : ' · 到点叮一声、弹通知、念出来'}`));
  } else if (kind === 'ring') {
    d.append(el('tt', '【限时任务】到点'), el('nm', t.name), el('meta', `「${t.say}」${t.late ? ` · 错过了 ${Math.round(t.late / 60_000)} 分钟` : ''}`));
    const qb = document.createElement('div');
    qb.className = 'qb';
    for (const [label, answer, cls] of [['知道了', 'ack', 'btn'], ['10 分钟后再提醒', 'snooze', 'btn ghost']]) {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = () => bridge.send({ type: 'reminder_answer', id: t.id, answer, minutes: 10 });
      qb.append(b);
    }
    d.append(qb);
    if (voiceState.ok) d.append(el('meta', '也可以说：「知道了」「过十分钟再提醒」'));
  } else {
    d.append(el('tt', '【监测】完成'), el('nm', t.name), el('meta', t.say || ''));
  }
  return d;
}
// ---------- 阶段 6：技能卡（草稿 / 改进 / 安装检查） ----------
const RISK_TEXT = { low: '低', medium: '中', high: '高' };
function skillCard(e, { inPage = false } = {}) {
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  };
  const risk = e.install?.risk;
  const d = el('div', 'msg sk' + (e.kind === 'improve' ? ' gold' : risk === 'high' ? ' warn' : ''));
  d.dataset.id = e.id;
  if (e.kind === 'new') {
    d.append(el('div', 'tt', e.by === '从刚才做的' ? '【技能草稿】从刚才做的生成' : '【技能草稿】待你确认'), el('div', 'nm', e.title));
    const ol = el('ol');
    for (const x of e.steps) ol.append(el('li', '', x));
    d.append(ol);
    if (e.triggers.length) {
      const t = el('div', 'trigs', '口令：');
      for (const x of e.triggers) t.append(el('span', 'trig', x));
      d.append(t);
    }
    if (e.scripts.length) d.append(el('div', 'meta', `带脚本：${e.scripts.map((x) => `${x.path}（${x.lines} 行）`).join('、')} · 保存就算批准了这些脚本`));
    if (e.by === '从刚才做的') d.append(el('div', 'meta', '只留以后用得上的做法，这次才有的细节换成了通用说法'));
  } else if (e.kind === 'improve') {
    d.append(el('div', 'tt', '【技能改进】待你确认'), el('div', 'nm', e.title), el('div', 'chg', e.change));
    if (e.why) d.append(el('div', 'meta', e.why));
  } else {
    const r = e.install.report;
    d.append(el('div', 'tt', '【安装检查】还没装，等你决定'), el('div', 'nm', e.name));
    const kv = el('div', 'kv');
    for (const [k, v] of [['来源', e.install.source], ['会做什么', r.does], ['会运行', r.runs], ['联网', r.network], ['读写文件', r.files], ['需要', r.needs], ['Windows', r.windows], ['风险', `${RISK_TEXT[r.risk]}：${r.why}`]]) {
      kv.append(el('span', '', k), el('span', k === '风险' ? 'risk ' + r.risk : '', v));
    }
    d.append(kv);
  }
  const qb = el('div', 'qb');
  const note = el('div', 'meta hint', voiceState.ok && !inPage ? (e.kind === 'install' ? '也可以说：「安装」「不装」' : e.kind === 'improve' ? '也可以说：「改」「不改」' : '也可以说：「保存」「不要了」，或者直接说哪里要改') : '');
  const send = async (answer, force) => {
    qb.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const r = await window.Pages.request({ type: 'skill_decide', id: e.id, answer, force: !!force });
    if (!r?.ok) {
      qb.querySelectorAll('button').forEach((b) => (b.disabled = false));
      note.textContent = r?.error || '没办成';
      note.classList.add('err');
    }
  };
  const btn = (label, cls, fn) => {
    const x = el('button', cls, label);
    x.type = 'button';
    x.onclick = fn;
    qb.append(x);
    return x;
  };
  if (e.kind === 'new') {
    btn('保存', 'btn', () => send('save'));
    btn('改一下', 'btn ghost', () => prefill('技能草稿改一下：'));
    btn('不要了', 'btn ghost', () => send('discard'));
  } else if (e.kind === 'improve') {
    btn('改', 'btn', () => send('save'));
    btn('不改', 'btn ghost', () => send('discard'));
  } else if (risk === 'high') {
    btn('不装', 'btn', () => send('discard'));
    btn('先看看文件', 'btn ghost', () => bridge.send({ type: 'skill_open', pending: e.id }));
    const force = btn('仍要安装', 'btn ghost', () => {
      if (force.dataset.armed) return send('save', true);
      force.dataset.armed = '1';
      force.textContent = '风险高，再点一次才装';
    });
  } else {
    btn('安装', 'btn', () => send('save'));
    btn('先看看文件', 'btn ghost', () => bridge.send({ type: 'skill_open', pending: e.id }));
    btn('不装', 'btn ghost', () => send('discard'));
  }
  d.append(qb, note);
  return d;
}
// ---------- 鉴定术：对话里的小鉴定卡（屏幕上那张大的在 appraise.html） ----------
const RAR_CLS = { 普通: 'common', 精良: 'good', 稀有: 'rare', 史诗: 'epic', 传说: 'legend' };
function appraiseMini(rec) {
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  };
  const d = el('div', 'msg apr' + (rec.kind === 'scan' ? ' scan' : '') + (rec.rarity ? ' r-' + (RAR_CLS[rec.rarity] || 'rare') : ''));
  d.dataset.at = rec.at;
  if (rec.thumb) {
    const img = el('img', 'th');
    img.src = rec.thumb;
    img.alt = '';
    d.append(img);
  }
  const b = el('div', 'abody');
  b.append(el('div', 'tt', rec.kind === 'scan' ? '【全屏扫描】' : '【鉴定结果】'));
  const nm = el('div', 'nm', rec.name);
  if (rec.rarity) nm.append(el('span', 'rar ' + (RAR_CLS[rec.rarity] || 'rare'), rec.rarity));
  else if (rec.tag) nm.append(el('span', 'rar ' + (/报错|错误|警告/.test(rec.tag) ? 'fix' : 'tag'), rec.tag));
  b.append(nm);
  const fields = (rec.fields || []).slice(0, rec.kind === 'scan' ? 4 : 3);
  if (fields.length) {
    const kv = el('div', 'kv');
    for (const [k, v] of fields) kv.append(el('span', 'k', k), el('span', 'v', v));
    b.append(kv);
  }
  if (rec.verdict) b.append(el('div', 'ev', rec.verdict));
  const ops = el('div', 'ops');
  const btn = (label, fn) => {
    const x = el('a', '', label);
    x.onclick = fn;
    ops.append(x);
  };
  btn('追问', () => {
    attachAppraise = rec.kind === 'scan' ? null : rec.id;
    prefill(`关于刚才鉴定的「${rec.name}」：`);
  });
  if (rec.actions?.includes('fix')) btn('帮我处理', () => bridge.send({ type: 'appraise_action', id: rec.id, action: 'fix' }));
  btn('复制', () => bridge.copyText?.([`【鉴定结果】${rec.name}${rec.rarity ? `（${rec.rarity}）` : ''}`, ...(rec.fields || []).map(([k, v]) => `${k}：${v}`), rec.verdict && `评价：${rec.verdict}`, rec.advice && `建议：${rec.advice}`].filter(Boolean).join('\n')));
  b.append(ops);
  d.append(b);
  return d;
}

// 「改一下」「+ 教一个」：翻到对话，在输入框里起个头
function prefill(text) {
  go('chat');
  wake('event');
  input.value = text;
  bridge.focus();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}
function resolveSkillCards(m) {
  const text =
    m.answer === 'save'
      ? { new: '已保存 · 技能页里能看、能改', improve: '已修改 · 技能页的改动记录里能撤销', install: '已安装 · 技能页里能看' }[m.kind] || '已处理'
      : m.answer === 'replaced'
        ? '已换成新的草稿'
        : { new: '不要了', improve: '没改', install: '没装' }[m.kind] || '已处理';
  for (const card of document.querySelectorAll(`.sk[data-id="${m.id}"]`)) {
    const done = document.createElement('div');
    done.className = 'done ' + m.answer;
    done.textContent = text;
    if (m.answer === 'save' && m.folder) {
      const a = document.createElement('a');
      a.textContent = '查看';
      a.onclick = () => window.Pages.showSkill(m.folder);
      done.append(a);
    }
    card.querySelector('.qb')?.replaceWith(done);
    card.querySelector('.hint')?.remove();
    card.classList.add('resolved');
  }
}

// 每秒刷新：对话里的倒计时、核心下面的小牌子、任务页
const petCd = $('#pet-cd');
function tickCountdowns() {
  const now = Date.now();
  for (const cd of logEl.querySelectorAll('.cd[data-due]')) {
    const left = +cd.dataset.due - now;
    cd.firstChild.textContent = left > 0 ? fmtLeft(left) : '00:00';
  }
  // 一小时内到点的，挂在核心下面（显示最近的那个）
  const next = (taskSnap.tasks || []).filter((t) => t.nextAt && t.nextAt - now <= 3600_000 && t.nextAt > now).sort((a, b) => a.nextAt - b.nextAt)[0];
  if (next) {
    petCd.textContent = `⏱ ${fmtLeft(next.nextAt - now)} ${next.name.slice(0, 6)}`;
    petCd.classList.toggle('soon', next.nextAt - now < 60_000);
    petCd.classList.remove('hidden');
    placePetCd();
  } else petCd.classList.add('hidden');
  window.Pages?.tick?.(now);
}
function placePetCd() {
  const below = petY + petSize + 22 < vh();
  const w = petCd.offsetWidth || 120;
  petCd.style.left = clamp(petX + petSize / 2 - w / 2, 4, vw() - w - 4) + 'px';
  petCd.style.top = (below ? petY + petSize + 4 : petY - 22) + 'px';
}
setInterval(tickCountdowns, 1000);

// 鉴定卡的「追问」：下一句话带上那次鉴定的图
let attachAppraise = null;
function sendPrompt(text) {
  go('chat');
  wake('event');
  if (booting) endBoot(true);
  bridge.send({ type: 'cancel_listen' });
  setListening(false);
  setStatus('');
  lastUserEl = add('user', text);
  bridge.send({ type: 'prompt', text, ...(attachAppraise ? { appraise: attachAppraise } : {}) });
  attachAppraise = null;
  setPanel('解析指令', 'PARSE', '', 'busy');
}
function scrollLog() {
  logEl.scrollTop = logEl.scrollHeight;
}

// 回复开头的 [sleep] [ignore] 之类是给程序看的标记，不显示出来
const TAG = /^\s*\[([a-z-]+)\]\s*/i;
function stripTag(raw) {
  const m = raw.match(TAG);
  if (m) return raw.slice(m[0].length);
  if (/^\s*\[[a-z-]*$/i.test(raw)) return ''; // 标记还没传完
  return raw;
}

// ---------- 聆听波形 ----------
for (let i = 0; i < 26; i++) {
  const b = document.createElement('i');
  b.style.setProperty('--h', 12 + Math.round(Math.abs(Math.sin(i * 0.65)) * 34) + 'px');
  b.style.animationDelay = (i * 0.05).toFixed(2) + 's';
  waveEl.appendChild(b);
}
let waveMic = false;
function setListening(on, mode) {
  listening = on;
  // 只有刚被唤醒（或按住说话）、等宿主说第一句时显示大波形；待命连续听时只在状态条提示
  waveMic = on && (mode === 'command' || mode === 'ptt');
  updateWave();
  if (!on) waveEl.style.setProperty('--l', 0);
}
// 系统说话时，波形显示系统自己的声音
function updateWave() {
  const speaking = !!window.Speech?.playing && !waveMic;
  waveEl.classList.toggle('hidden', !(waveMic || speaking));
  waveEl.classList.toggle('speak', speaking);
}

// ---------- 提示音（用 Web Audio 合成，不需要音频文件） ----------
let audioCtx = null;
function ding(kind) {
  if (cfg.ui?.sound === false) return;
  Speech.markDing(320); // 系统的声音等提示音响完再开口
  try {
    audioCtx ||= new AudioContext();
    const notes = { wake: [1318, 1760], done: [1568, 2093], auth: [880, 660], error: [440, 330], quest: [1047, 1319, 1568, 2093] }[kind] || [1318];
    notes.forEach((f, i) => {
      const t = audioCtx.currentTime + i * 0.09;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
  } catch {}
}

// ---------- 展开 / 收起 ----------
function openPanel() {
  bubble.classList.remove('hidden');
  bubble.classList.remove('opening');
  void bubble.offsetWidth;
  bubble.classList.add('opening');
  pet.classList.add('awake', 'pop');
  setTimeout(() => pet.classList.remove('pop'), 520);
  layout();
}

function wake(source) {
  clearTimeout(sleepTimer);
  if (source !== 'event') toChat();
  if (booting && source !== 'event') {
    // 开机自检还没放完就被唤醒：收掉自检，按正常唤醒走（会补上问候）
    endBoot(true);
    awake = false;
  }
  if (!awake) {
    awake = true;
    openPanel();
    if (source !== 'event') {
      ding('wake');
      if (brainState.ok === false) {
        setPanel('系统异常', 'ERROR', 'err', 'error');
        add('err', brainState.message);
      } else {
        setPanel('系统通知', 'SYS', '', 'idle');
        add('sys', GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
        if (voiceState.ok === false && source !== 'voice') add('note', `听觉模块未启动，请打字输入：${voiceState.message}`);
      }
    }
  }
  if (source === 'hotkey' || source === 'click') {
    if (voiceState.ok && brainState.ok !== false) bridge.send({ type: 'listen' });
    input.focus();
  }
  armSleep();
}

function goSleep(force) {
  if (!awake) return;
  const typing = document.activeElement === input && input.value.trim();
  if (!force && (busy || pendingConfirm || listening || typing || hitState || booting)) return armSleep();
  clearTimeout(sleepTimer);
  bridge.send({ type: 'cancel_listen' });
  setListening(false);
  setStatus('');
  input.blur();
  bridge.blur();
  bubble.classList.add('hidden');
  awake = false;
  pet.classList.remove('awake');
  coreState('idle');
  if (page !== 'chat') go('chat');
}

function armSleep(ms) {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => goSleep(false), ms ?? cfg.sleepAfterMs);
}

// ---------- 开机自检 ----------
const bootLines = {};
function bootLine(key, text, state) {
  if (quietBoot) return;
  let el = bootLines[key];
  if (!el) {
    el = add('boot', '');
    bootLines[key] = el;
  }
  el.className = 'msg boot' + (state === 'fail' ? ' fail' : '');
  el.textContent = '';
  const t = document.createElement('span');
  t.textContent = text;
  const r = document.createElement('span');
  r.className = 'r';
  r.textContent = state === 'ok' ? '完成' : state === 'fail' ? '失败' : '…';
  el.append(t, r);
}
let quietBoot = false;
function startBoot() {
  booting = true;
  bubble.classList.add('booting');
  if (cfg.ui?.boot === false) {
    quietBoot = true; // 不放自检动画：准备好了直接进待机
    return;
  }
  awake = true;
  setPanel('系统启动', 'BOOT', '', 'busy');
  openPanel();
  const st = (ok) => (ok === true ? 'ok' : ok === false ? 'fail' : 'wait');
  bootLine('voice', `加载听觉模块 · 唤醒词「${(cfg.wakeWords || []).join('」「')}」`, st(voiceState.ok));
  bootLine('brain', brainState.ok ? `连接大脑 · ${brainState.message}` : '连接大脑', st(brainState.ok));
  bootSpeech();
  bootLine('skills', '加载技能 · 网页 / 软件 / 命令 / 文件', 'ok');
  bootLine('safety', '加载安全规则 · 高危操作需宿主授权', 'ok');
}
let speechState = null;
const ENGINE_NAME = { gpu: '显卡', cpu: 'CPU' };
function bootSpeech() {
  const s = speechState;
  if (!s) return bootLine('speech', '加载发声模块', 'wait');
  if (s.mode === 'off') return bootLine('speech', '加载发声模块 · 已静音', 'ok');
  if (s.engine) return bootLine('speech', `加载发声模块 · ${ENGINE_NAME[s.engine]}`, 'ok');
  bootLine('speech', '加载发声模块 · 后台加载中', 'ok');
}
function checkBootDone() {
  if (!booting || voiceState.ok === null || brainState.ok === null) return;
  if (brainState.ok && quietBoot) return endBoot(false);
  if (!brainState.ok && quietBoot) {
    quietBoot = false;
    awake = true;
    openPanel();
  }
  if (brainState.ok) {
    const el = add('boot final', voiceState.ok ? '系统自检通过，进入待机' : '系统自检完成（听觉模块不可用，可打字输入），进入待机');
    el.classList.add('final');
    bridge.send({ type: 'speak', text: '系统自检通过，进入待机。' });
    setTimeout(() => endBoot(false), 2200);
  } else {
    setPanel('系统异常', 'ERROR', 'err', 'error');
    add('err', brainState.message);
    ding('error');
    setTimeout(() => endBoot(false), 9000);
  }
}
function endBoot(keepOpen) {
  if (!booting) return;
  booting = false;
  quietBoot = false;
  bubble.classList.remove('booting');
  logEl.querySelectorAll('.msg.boot').forEach((el) => el.remove());
  for (const k of Object.keys(bootLines)) delete bootLines[k];
  if (!keepOpen) goSleep(true);
  coreState(brainState.ok === false ? 'error' : 'idle');
  // 以前的对话：读最近的一页进来，接在上面
  if (brainState.ok) loadOlder().then(() => scrollLog());
  // 第一次用：带着走一遍新手引导
  if (!cfg.onboarded) {
    cfg.onboarded = true;
    setTimeout(() => {
      wake('event');
      go('guide');
    }, keepOpen ? 0 : 700);
  }
}

// ---------- 高危操作授权 ----------
let countdown = null;
function showConfirm(c) {
  wake('event');
  pendingConfirm = c;
  setPanel('高危操作授权', 'AUTH', 'warn', 'auth');
  ding('auth');
  confirmBox.innerHTML = '';
  const top = document.createElement('div');
  top.className = 'top';
  const rw = document.createElement('div');
  rw.className = 'ringwrap';
  const ring = document.createElement('div');
  ring.className = 'ring';
  const num = document.createElement('span');
  rw.append(ring, num);
  const txt = document.createElement('div');
  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = `检测到高危操作：${c.label}`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = '宿主是否授权执行？超时将自动拒绝';
  txt.append(what, sub);
  top.append(rw, txt);
  const code = document.createElement('code');
  code.textContent = c.detail;
  const btns = document.createElement('div');
  btns.className = 'btns';
  for (const [label, answer, cls] of [['授权', 'allow', 'btn'], ['拒绝', 'deny', 'btn ghost'], ['本次全部授权', 'all', 'btn ghost']]) {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.textContent = label;
    btn.onclick = () => answerConfirm(answer);
    btns.append(btn);
  }
  confirmBox.append(top, code, btns);
  if (c.voice) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '也可以直接说：「授权」「拒绝」「全部授权」';
    confirmBox.append(hint);
  }
  confirmBox.classList.remove('hidden');
  // 倒计时：后台 90 秒没回应就当拒绝
  const total = 90;
  const startAt = Date.now();
  const tick = () => {
    const left = Math.max(0, total - (Date.now() - startAt) / 1000);
    num.textContent = Math.ceil(left);
    ring.style.setProperty('--left', (left / total).toFixed(3));
  };
  tick();
  clearInterval(countdown);
  countdown = setInterval(tick, 250);
  scrollLog();
  layout();
}
function answerConfirm(answer) {
  if (!pendingConfirm) return;
  bridge.send({ type: 'confirm_answer', id: pendingConfirm.id, answer });
  // 结果以后台发回的 confirm_closed 为准（语音回答也走那里）
}
const CONFIRM_NOTE = { allow: '授权', all: '本次任务全部授权', deny: '拒绝' };
function onConfirmClosed(m) {
  if (pendingConfirm && pendingConfirm.id !== m.id) return;
  hideConfirm();
  if (m.answer === 'timeout') add('note', `授权超时，已拒绝：${m.label}`);
  else if (CONFIRM_NOTE[m.answer]) add('note', `宿主${m.by === 'voice' ? '（语音）' : ''}${CONFIRM_NOTE[m.answer]}：${m.label}`);
  if (busy) setPanel('任务执行中', 'RUNNING', '', 'busy');
}
function hideConfirm() {
  pendingConfirm = null;
  confirmBox.classList.remove('gold');
  clearInterval(countdown);
  confirmBox.classList.add('hidden');
  confirmBox.innerHTML = '';
}

// ---------- 回复文字跟着声音一个字一个字出现 ----------
// 后台把回复切成段（voice_seg），每段念或不念；念的段跟着播放进度露出，不念的段（代码、超出字数的部分）快速打出来。
// 声音出问题时（3 秒没动静又没在播放）就不等了，直接全部显示。
let revealing = false;
function kickReveal() {
  if (revealing) return;
  revealing = true;
  requestAnimationFrame(revealTick);
}
function revealTarget(st) {
  let t = 0;
  for (const s of st.segs) {
    if (!s.speak) {
      t = s.end;
      continue;
    }
    const p = Speech.progress(st.id, s.seg);
    if (p === 1) {
      t = s.end;
      continue;
    }
    if (p == null) return Math.max(t, s.start); // 这段的声音还没开始
    return Math.max(t, s.start + Math.floor((s.end - s.start) * p));
  }
  return st.ended ? st.full.length : t;
}
function revealTick() {
  let more = false;
  const now = performance.now();
  for (const [id, st] of msgs) {
    if (!st.el) {
      if (st.ended) msgs.delete(id);
      else more = true;
      continue;
    }
    const target = st.voice ? Math.max(st.shown, revealTarget(st)) : st.full.length;
    if (st.shown < target) {
      st.shown = Math.min(target, st.shown + Math.max(1, Math.ceil((target - st.shown) / 4)));
      st.el.textContent = st.full.slice(0, st.shown);
      scrollLog();
      st.stall = now;
    } else if (st.voice && st.shown < st.full.length && !Speech.playing && now - st.stall > 3000) {
      st.voice = false; // 声音卡住了：别让文字一直等着
    }
    const finished = st.ended && st.shown >= st.full.length;
    st.el.classList.toggle('typing', !finished && st.voice);
    if (finished) {
      msgs.delete(id);
      continue;
    }
    more = true;
  }
  if (more) requestAnimationFrame(revealTick);
  else revealing = false;
}

Speech.onState((on) => {
  bridge.send({ type: 'voice_state', playing: on });
  pet.classList.toggle('speaking', on);
  updateWave();
  if (on) requestAnimationFrame(voiceTick);
});
function voiceTick() {
  if (!Speech.playing) {
    pet.style.setProperty('--vl', 0);
    return;
  }
  const l = Speech.level();
  pet.style.setProperty('--vl', l.toFixed(3));
  if (!waveMic) waveEl.style.setProperty('--l', Math.min(1, l * 1.6).toFixed(2));
  requestAnimationFrame(voiceTick);
}

// ---------- 任务步骤条 ----------
function renderSteps(m) {
  if (!m.steps) {
    stepsEl.classList.add('hidden');
    steplineEl.classList.add('hidden');
    return;
  }
  stepsEl.innerHTML = '';
  m.steps.forEach((t, i) => {
    const s = document.createElement('span');
    s.className = 'st' + (m.failed && i === m.done ? ' fail' : i < m.done ? ' done' : i === m.done ? ' now' : '');
    s.textContent = t;
    stepsEl.appendChild(s);
  });
  steplineEl.querySelector('i').style.width = (Math.min(m.done, m.steps.length) / m.steps.length) * 100 + '%';
  stepsEl.classList.remove('hidden');
  steplineEl.classList.remove('hidden');
  layout();
}

// ---------- 操作视图：系统在操作哪个软件 / 网页、最近几个动作 ----------
const opv = { on: false, name: '', trail: [] };
function openOpv(m) {
  opv.on = true;
  opv.name = m.name;
  $('#opv-name').textContent = (m.kind === 'web' ? '网页 · ' : '') + m.name;
  $('#opv-sub').textContent = m.kind === 'web' ? `系统专用 Chrome · ${m.count} 个元素` : `后台操作 · ${m.count} 个元素`;
  const els = $('#opv-els');
  els.textContent = (m.elements || []).join(' · ') || '（没有元素列表）';
  opvEl.classList.remove('hidden');
  layout();
}
opvEl.addEventListener('click', () => {
  $('#opv-els').classList.toggle('hidden');
  layout();
});
function renderTrail() {
  const tr = $('#opv-trail');
  tr.innerHTML = '';
  for (const a of opv.trail.slice(-3)) {
    const line = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = a.state === 'done' ? 'o' : a.state === 'fail' ? 'x' : 'n';
    mark.textContent = a.state === 'done' ? '✓ ' : a.state === 'fail' ? '✗ ' : '◆ ';
    line.append(mark, document.createTextNode(a.text));
    tr.appendChild(line);
  }
}
function opvAction(id, text) {
  opv.trail.push({ id, text, state: 'run' });
  renderTrail();
}
function opvDone(id, isError) {
  const a = opv.trail.find((x) => x.id === id);
  if (!a) return false;
  a.state = isError ? 'fail' : 'done';
  renderTrail();
  return true;
}
function closeOpv() {
  if (opv.on && opv.trail.length) add('tool ok', `◆ ${opv.name} · ${opv.trail.length} 个动作${opv.trail.some((a) => a.state === 'fail') ? '（有失败）' : ''}`);
  opv.on = false;
  opv.trail = [];
  opvEl.classList.add('hidden');
  $('#opv-els').classList.add('hidden');
  layout();
}

// ---------- 申请接管前台（金色卡片，跟授权卡同一个位置） ----------
function showTakeover(r) {
  wake('event');
  pendingConfirm = { id: r.id, takeover: true };
  setPanel('申请接管前台', 'TAKEOVER', 'warn', 'auth');
  ding('auth');
  confirmBox.innerHTML = '';
  confirmBox.classList.add('gold');
  const top = document.createElement('div');
  top.className = 'top';
  const rw = document.createElement('div');
  rw.className = 'ringwrap';
  const ring = document.createElement('div');
  ring.className = 'ring';
  const num = document.createElement('span');
  rw.append(ring, num);
  const txt = document.createElement('div');
  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = `「${r.app}」需要前台操作约 ${r.seconds} 秒`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `要做的事：${r.reason}。期间请别动；动一下鼠标或按 Esc 立即收回`;
  txt.append(what, sub);
  top.append(rw, txt);
  const btns = document.createElement('div');
  btns.className = 'btns';
  for (const [label, answer, cls] of [['允许', 'allow', 'btn'], ['稍后', 'later', 'btn ghost'], ['拒绝', 'deny', 'btn ghost']]) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.onclick = () => bridge.send({ type: 'takeover_answer', id: r.id, answer });
    btns.append(b);
  }
  confirmBox.append(top, btns);
  if (r.voice) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '也可以直接说：「可以」「等一下」「不行」';
    confirmBox.append(hint);
  }
  confirmBox.classList.remove('hidden');
  const total = 30;
  const startAt = Date.now();
  const tick = () => {
    const left = Math.max(0, total - (Date.now() - startAt) / 1000);
    num.textContent = Math.ceil(left);
    ring.style.setProperty('--left', (left / total).toFixed(3));
  };
  tick();
  clearInterval(countdown);
  countdown = setInterval(tick, 250);
  scrollLog();
  layout();
}

// ---------- 后台消息 ----------
bridge.onBrain((m) => {
  if (window.Pages?.onBrain(m)) return;
  if (['heard', 'confirm', 'takeover_request', 'error', 'brain_crashed'].includes(m.type)) toChat();
  if (m.type === 'listening' && (m.mode === 'command' || m.mode === 'ptt')) toChat();
  switch (m.type) {
    case 'nav':
      // 「打开设置」：翻页，不算一条指令
      wake('event');
      if (!busy && !pendingConfirm) setPanel('系统通知', 'SYS', '', 'idle');
      go(m.page, m.sub);
      armSleep();
      break;
    case 'status':
      setStatus(m.text);
      break;
    case 'topic_reset':
      add('divider', '换了个话题 · 大脑的上下文已清空，以前的对话还在上面');
      break;
    case 'ui_config':
      applyUi(m.key, m.value);
      break;
    case 'tasks':
      taskSnap = m;
      tickCountdowns();
      break;
    case 'quest':
      // 刚发布的【限时任务】：对话里放一张金色卡
      addCard(questCard(m.task, 'new'));
      break;
    case 'reminder':
      wake('event');
      setPanel('任务提醒', 'REMIND', 'gold', 'done');
      ding('quest');
      addCard(questCard(m.task, 'ring'));
      armSleep(90_000);
      break;
    case 'reminder_closed': {
      const card = logEl.querySelector(`.quest[data-id="${m.id}"].due`);
      const qb = card?.querySelector('.qb');
      if (qb) qb.outerHTML = `<div class="meta">${m.answer === 'snooze' ? `${m.minutes} 分钟后再提醒（${timeText(m.nextAt).replace(/^今天 /, '')}）` : '宿主知道了'}</div>`;
      if (!busy) setPanel('系统通知', 'SYS', '', 'idle');
      armSleep();
      break;
    }
    case 'report':
      // 主动报告：下载完成只记一行；宿主让盯着的事完成了要展开面板
      if (m.kind === 'watch') {
        wake('event');
        setPanel('任务完成', 'REPORT', 'ok', 'done');
        ding('quest');
        addCard(questCard({ id: m.watchId, name: m.title, say: `${m.text} · ${m.meta}` }, 'watch'));
        armSleep(60_000);
      } else add('report' + (m.kind === 'battery' ? ' err' : ''), `${m.title}：${m.text}（${m.meta}）`);
      break;
    case 'memory_update': {
      // 记了东西：对话里冒一行，能查看、能撤销（不念出来）
      const c = m.change;
      const line = add('memline', '');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = `记忆已更新${c.by === '自动整理' ? '（自动整理）' : ''}：${c.summary}`;
      const see = document.createElement('a');
      see.textContent = '查看';
      see.onclick = () => window.Pages.showChange(c);
      const undo = document.createElement('a');
      undo.textContent = '撤销';
      undo.onclick = async () => {
        const r = await window.Pages.request({ type: 'memory_undo', id: c.id });
        if (r?.ok) {
          line.classList.add('undone');
          undo.remove();
        } else undo.textContent = r?.error || '撤销不了';
      };
      line.append(t, see, undo);
      scrollLog();
      break;
    }
    case 'appraise_card':
      // 鉴定完：对话里留一张小卡（屏幕上的大卡片由鉴定层画）
      addCard(appraiseMini(m.rec));
      break;
    case 'appraise_hint':
      add('sys', m.text);
      break;
    case 'appraise_followup':
      attachAppraise = m.id;
      prefill(`关于刚才鉴定的「${m.name}」：`);
      break;
    case 'skill_pending':
      // 技能草稿、改进、安装报告：对话里放一张卡，点了才生效
      wake('event');
      addCard(skillCard(m.entry));
      break;
    case 'skill_resolved':
      resolveSkillCards(m);
      if (!busy && !pendingConfirm) {
        setPanel('系统通知', 'SYS', '', 'idle');
        armSleep();
      }
      break;
    case 'skill_run': {
      // 说了口令：先冒一行【技能】，下面照常显示每个动作
      const el = add('tool ok skillrun', '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '✓';
      const t = document.createElement('span');
      t.textContent = `【技能】${m.title}`;
      el.append(dot, t);
      break;
    }
    case 'skill_suggest': {
      // 「要存成技能吗」：只冒一行，不念、不自动存
      const line = add('skline', '');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = m.steered && m.tools < 5 ? '刚才这套你中途纠正过做法，要存成技能吗？' : `刚才这套用了 ${m.tools} 个动作，要存成技能吗？`;
      const yes = document.createElement('a');
      yes.textContent = '存成技能';
      const no = document.createElement('a');
      no.textContent = '不用';
      yes.onclick = () => {
        bridge.send({ type: 'skill_from_task', id: m.id, text: m.text });
        yes.remove();
        no.remove();
      };
      no.onclick = () => {
        bridge.send({ type: 'skill_suggest_no', id: m.id, text: m.text });
        t.textContent = '好的，这类流程以后不再问。';
        line.classList.add('undone');
        yes.remove();
        no.remove();
      };
      line.append(t, yes, no);
      scrollLog();
      break;
    }
    case 'quest_run':
      wake('event');
      toChat();
      add('note', `【定时任务】到点执行：${m.task.do}`);
      setPanel('任务执行中', 'RUNNING', '', 'busy');
      break;
    case 'voice_ready':
      voiceState = { ok: true, message: m.mic };
      liveEl.classList.toggle('hidden', m.wakeEnabled !== false);
      if (booting) bootLine('voice', `加载听觉模块 · 唤醒词「${(m.wakeWords || cfg.wakeWords || []).join('」「')}」`, 'ok');
      checkBootDone();
      break;
    case 'voice_error':
      voiceState = { ok: false, message: m.message };
      if (booting) bootLine('voice', '加载听觉模块', 'fail');
      checkBootDone();
      break;
    case 'brain_ready':
      brainState = { ok: true, message: m.model };
      pet.title = `系统核心 · 大脑：${m.model}\n拖动换位置 · Ctrl+滚轮调大小`;
      if (booting) bootLine('brain', `连接大脑 · ${m.model}`, 'ok');
      checkBootDone();
      break;
    case 'brain_missing':
      brainState = { ok: false, message: '大脑未连接：没有找到可用的模型密钥。请先配置模型密钥（步骤见 README），再从托盘菜单重启系统。' };
      if (booting) bootLine('brain', '连接大脑', 'fail');
      checkBootDone();
      break;
    case 'wake':
      wake('voice');
      break;
    case 'listening':
      setListening(true, m.mode);
      if (m.mode === 'confirm') break; // 授权卡弹着：保持授权状态
      wake('event');
      if (m.mode === 'command') {
        setPanel('聆听中', 'LISTEN', 'ok', 'listen');
        setStatus('');
      } else if (m.mode === 'ptt') {
        if (!pendingConfirm) setPanel('聆听中', 'PTT', 'ok', 'listen');
        setStatus('按住说话中 · 松开发送');
      } else {
        setStatus('聆听中 · 直接说就行');
        if (!busy) coreState('listen');
      }
      break;
    case 'level':
      waveEl.style.setProperty('--l', Math.min(1, m.v * 14).toFixed(2));
      break;
    case 'listen_timeout':
      setListening(false);
      if (m.mode === 'confirm') break;
      if (m.mode === 'ptt') {
        // 按得太短、没听到字：安静地恢复，不提示
        setStatus('');
        if (!busy && !pendingConfirm) {
          setPanel('系统通知', 'SYS', '', 'idle');
          armSleep(5000);
        }
        break;
      }
      setStatus('');
      if (busy) break;
      if (m.mode === 'followup') {
        goSleep(false); // 待命时间到了，安静地收起
      } else if (!(document.activeElement === input || input.value.trim())) {
        setPanel('系统通知', 'SYS', '', 'idle');
        add('sys', '未检测到指令。系统待机中，需要时请再次唤醒。');
        armSleep(6000);
      }
      break;
    case 'pondering':
      setStatus('判断中…');
      break;
    case 'ignored':
      // 不是对系统说的：当没听见
      if (m.removeHeard && lastUserEl) lastUserEl.remove();
      lastUserEl = null;
      setStatus('');
      break;
    case 'dismiss':
      if (m.farewell) add('sys', typeof m.farewell === 'string' ? m.farewell : FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)]);
      setListening(false);
      setTimeout(() => goSleep(true), 1100);
      break;
    case 'heard':
      setListening(false);
      setStatus('');
      lastUserEl = add('user', m.text);
      if (pendingConfirm) break;
      setPanel('解析指令', 'PARSE', '', 'busy');
      break;
    case 'confirm_closed':
      onConfirmClosed(m);
      break;
    case 'confirm_unclear':
      add('note', `未识别授权指令「${m.text}」，请说「授权」或「拒绝」`);
      break;
    case 'busy':
      busy = m.busy;
      if (!busy) closeOpv();
      stopBtn.classList.toggle('hidden', !busy);
      if (busy) {
        wake('event');
        setPanel('解析指令', 'PARSE', '', 'busy');
      } else {
        armSleep();
      }
      break;
    case 'say_start':
      curRaw = '';
      curMsg = null;
      curMsgId = m.id;
      msgs.set(m.id, { id: m.id, el: null, full: '', shown: 0, segs: [], voice: !!m.voice, ended: false, stall: performance.now() });
      break;
    case 'say': {
      curRaw += m.delta;
      const text = stripTag(curRaw);
      const st = msgs.get(curMsgId);
      if (text) {
        if (!curMsg) curMsg = add('sys', '');
        if (st) {
          st.el = curMsg;
          st.full = text;
        }
        if (st?.voice) {
          kickReveal();
        } else {
          curMsg.textContent = text;
          scrollLog();
        }
      }
      break;
    }
    case 'say_end': {
      const st = msgs.get(m.id);
      if (st) {
        st.ended = true;
        kickReveal();
      }
      break;
    }
    case 'voice_seg': {
      const st = msgs.get(m.msg);
      if (st) {
        st.segs.push({ seg: m.seg, start: m.start, end: m.end, speak: m.speak });
        kickReveal();
      }
      break;
    }
    case 'voice':
      Speech.push(m);
      kickReveal();
      break;
    case 'voice_stop':
      Speech.stop();
      for (const st of msgs.values()) st.voice = false;
      kickReveal();
      break;
    case 'speech_state':
      speechState = m;
      if (booting) bootSpeech();
      break;
    case 'tool': {
      if (!pendingConfirm) setPanel('任务执行中', 'RUNNING', '', 'busy');
      if (opv.on) {
        opvAction(m.id, m.text);
        break;
      }
      const el = add('tool run', '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '◆';
      const t = document.createElement('span');
      t.textContent = m.text;
      el.append(dot, t);
      scrollLog();
      toolEls.set(m.id, el);
      break;
    }
    case 'tool_end': {
      if (opvDone(m.id, m.isError)) break;
      const el = toolEls.get(m.id);
      if (el) {
        el.className = 'msg tool ' + (m.isError ? 'fail' : 'ok');
        el.querySelector('.dot').textContent = m.isError ? '✗' : '✓';
        toolEls.delete(m.id);
      }
      break;
    }
    case 'confirm':
      showConfirm(m);
      break;
    case 'steps':
      renderSteps(m);
      break;
    case 'target':
      openOpv(m);
      break;
    case 'takeover_request':
      showTakeover(m);
      break;
    case 'takeover_closed':
      if (pendingConfirm?.takeover && pendingConfirm.id === m.id) {
        hideConfirm();
        const note = { allow: '宿主允许接管前台', later: '宿主选了稍后', deny: '宿主拒绝接管前台', timeout: '申请超时，按稍后处理' }[m.answer];
        if (note) add('note', note);
        if (busy) setPanel('任务执行中', 'RUNNING', '', 'busy');
      }
      break;
    case 'takeover_state':
      setStatus(m.active ? '系统接管前台中 · 动鼠标或按 Esc 立即收回' : '');
      break;
    case 'done':
      hideConfirm();
      if (!/^\s*\[sleep\]/i.test(m.text || '')) {
        setPanel('任务完成', 'COMPLETE', 'ok', 'done');
        // 系统正在念结果时不再叮一声，免得盖住声音
        if (!Speech.playing && ![...msgs.values()].some((st) => st.voice)) ding('done');
      }
      armSleep();
      break;
    case 'error':
      wake('event');
      setPanel('任务失败', 'ERROR', 'err', 'error');
      add('err', m.message);
      ding('error');
      armSleep();
      break;
    case 'stopped':
      hideConfirm();
      setPanel('任务中止', 'STOPPED', 'err', 'idle');
      add('note', '任务已按宿主指令中止。');
      break;
    case 'notice':
      add('note', m.text);
      break;
    case 'wake_enabled':
      liveEl.classList.toggle('hidden', m.enabled);
      break;
    case 'brain_crashed':
      wake('event');
      setPanel('系统异常', 'ERROR', 'err', 'error');
      add('err', '后台进程异常退出，正在重启…');
      break;
  }
});

bridge.onCmd((c) => {
  if (c.type === 'wake') wake('hotkey');
  if (c.type === 'nav') {
    if (booting) endBoot(true);
    wake('event');
    go(c.page, c.sub);
  }
  if (c.type === 'reset_pos') resetPos();
});

// ---------- 交互 ----------
$('#ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendPrompt(text);
});
function hush() {
  if (!Speech.playing) return;
  Speech.stop();
  bridge.send({ type: 'voice_stop' });
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hush();
    goSleep(true);
  }
});
input.addEventListener('input', () => armSleep());
stopBtn.addEventListener('click', () => bridge.send({ type: 'stop' }));
$('#close').addEventListener('click', () => {
  if (booting) endBoot(false);
  hush();
  goSleep(true);
});

// ---------- 位置、拖动、面板摆放 ----------
// 窗口铺满整个屏幕工作区，系统核心和面板都在里面用 CSS 定位
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('sys.' + k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem('sys.' + k);
      else localStorage.setItem('sys.' + k, JSON.stringify(v));
    } catch {}
  },
};
const GAP = 14; // 核心和面板之间的空隙
const DOCK = 48; // 离屏幕边这么近，算“贴着边”
const SNAP = 32; // 松手时离边这么近，就吸过去
const MARGIN = 8;
const TOP_ROOM = 26; // 面板顶上的标题牌会探出框外，留出位置
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const vw = () => window.innerWidth;
const vh = () => window.innerHeight;

let petSize = 76;
let petX = 0;
let petY = 0;
let bw = 440;
let bh = 540;
let bubbleFixed = false; // 拖过大小以后，面板固定这个高度；没拖过就随内容长高
const WIDE = { w: 760, h: 560 }; // 记录、日志、设置这几页的默认大小
let ww = WIDE.w;
let wh = WIDE.h;

function applyPet() {
  petX = clamp(petX, 0, vw() - petSize);
  petY = clamp(petY, 0, vh() - petSize);
  pet.style.setProperty('--p', petSize + 'px');
  pet.style.left = petX + 'px';
  pet.style.top = petY + 'px';
  if (!petCd.classList.contains('hidden')) placePetCd();
  bridge.petRect?.({ x: petX, y: petY, w: petSize, h: petSize });
}
window.addEventListener('resize', () => bridge.petRect?.({ x: petX, y: petY, w: petSize, h: petSize }));
function savePet() {
  store.set('pet', { x: petX, y: petY, size: petSize });
}
function resetPos() {
  const ui = cfg.ui || {};
  petSize = ui.petSize || 76;
  bw = ui.chatWidth || 440;
  bh = ui.chatHeight || 540;
  bubbleFixed = false;
  store.set('bubble', null);
  petX = vw() - petSize - 16;
  petY = vh() - petSize - 12;
  applyPet();
  savePet();
  layout();
}
function initPet() {
  const ui = cfg.ui || {};
  const saved = store.get('pet', null);
  const b = store.get('bubble', null);
  const bw2 = store.get('bubbleWide', null);
  ww = bw2?.w ?? WIDE.w;
  wh = bw2?.h ?? WIDE.h;
  petSize = clamp(saved?.size ?? ui.petSize ?? 76, 44, 200);
  bw = b?.w ?? ui.chatWidth ?? 440;
  bh = b?.h ?? ui.chatHeight ?? 540;
  bubbleFixed = !!b?.fixed;
  if (saved) {
    petX = saved.x;
    petY = saved.y;
    applyPet();
  } else {
    resetPos();
  }
  pet.style.visibility = '';
  layout();
}

// 面板摆在哪：核心贴左边 → 右侧；贴右边 → 左侧；贴上边 → 下面；贴下边 → 上面；
// 悬在中间就放在空间大的那一侧。放不下就换下一个方向，再放不下就压矮。
// 拖角改大小的时候不换方向（rs.side），免得面板跳到另一边。
let rs = null; // 正在拖角改大小
let geo = null; // 上一次摆放的结果：在核心哪一侧、哪两条边能自由伸缩
function layout() {
  const wide = page !== 'chat';
  const W = Math.min(wide ? Math.max(ww, bw) : bw, vw() - 2 * MARGIN);
  let Hmax = Math.min(wide ? Math.max(wh, bh) : bh, vh() - MARGIN - TOP_ROOM);
  const setH = (h) => {
    bubble.style.setProperty('--bw', W + 'px');
    bubble.style.setProperty('--bh', h + 'px');
    bubble.style.height = bubbleFixed || wide ? h + 'px' : '';
    return bubble.offsetHeight || h;
  };
  let H = setH(Hmax);

  const p = { x: petX, y: petY, w: petSize, h: petSize, cx: petX + petSize / 2, cy: petY + petSize / 2 };
  const nearL = p.x < DOCK;
  const nearR = vw() - (p.x + p.w) < DOCK;
  const nearT = p.y < DOCK;
  const nearB = vh() - (p.y + p.h) < DOCK;
  const room = { above: p.y - TOP_ROOM, below: vh() - p.y - p.h - TOP_ROOM, left: p.x, right: vw() - p.x - p.w };
  let first;
  if (nearL && !nearT && !nearB) first = 'right';
  else if (nearR && !nearT && !nearB) first = 'left';
  else if (nearT) first = 'below';
  else if (nearB) first = 'above';
  else first = room.above >= room.below ? 'above' : 'below';
  const order = [first, ...['above', 'below', 'left', 'right'].sort((a, b) => room[b] - room[a])];
  const need = { above: H + GAP, below: H + GAP, left: W + GAP, right: W + GAP };
  let side = rs?.side || order.find((s) => room[s] >= need[s] + MARGIN);
  if (!side) {
    side = room.above >= room.below ? 'above' : 'below';
    Hmax = Math.max(220, Math.min(Hmax, room[side] - GAP - MARGIN));
    H = setH(Hmax);
  }

  const alignX = () => (p.cx > vw() / 2 ? p.x + p.w - W : p.x);
  const alignY = () => p.cy - H / 2;
  let x;
  let y;
  if (side === 'above') [x, y] = [alignX(), p.y - GAP - H];
  else if (side === 'below') [x, y] = [alignX(), p.y + p.h + GAP + TOP_ROOM];
  else if (side === 'left') [x, y] = [p.x - GAP - W, alignY()];
  else [x, y] = [p.x + p.w + GAP, alignY()];
  x = clamp(x, MARGIN, vw() - W - MARGIN);
  y = clamp(y, TOP_ROOM, vh() - H - MARGIN);
  bubble.style.left = x + 'px';
  bubble.style.top = y + 'px';
  bubble.style.transformOrigin = `${clamp(p.cx - x, 0, W)}px ${clamp(p.cy - y, 0, H)}px`;
  // 面板有一条边贴着核心（固定），对面那条边能自由伸缩。拖动改大小的角放在能伸缩的那个角上，
  // 拖的时候角才会跟着鼠标走：面板在核心上方就放上角，在下方就放下角，在左右两侧（上下居中）放下角
  const freeH = side === 'left' ? 'l' : side === 'right' ? 'r' : p.cx > vw() / 2 ? 'l' : 'r';
  const freeV = side === 'above' ? 't' : side === 'below' ? 'b' : 'c';
  const corner = (freeV === 't' ? 't' : 'b') + freeH;
  grip.className = corner;
  bubble.classList.toggle('close-left', corner === 'tr'); // 右上角给了拖动角，关闭按钮挪到左上
  geo = { side, freeH, freeV, room, p };
}
new ResizeObserver(() => layout()).observe(bubble);
window.addEventListener('resize', () => {
  applyPet();
  layout();
});

// 拖动核心：按下后挪动超过 5 像素算拖，否则算点击
let drag = null;
pet.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // 记住鼠标抓在核心的哪个位置：窗口搬到别的屏幕后，用新坐标接着算
  drag = { sx: e.clientX, sy: e.clientY, offX: e.clientX - petX, offY: e.clientY - petY, moved: false, edgeAt: 0 };
  pet.setPointerCapture(e.pointerId);
  lockHit(true);
});
pet.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    pet.classList.add('dragging');
  }
  // 鼠标出了窗口（窗口只盖一块屏幕）：让主进程看看鼠标是不是到了另一块屏幕上，是就把窗口搬过去
  const out = e.clientX < 0 || e.clientY < 0 || e.clientX >= vw() || e.clientY >= vh();
  if (out && performance.now() - drag.edgeAt > 120) {
    drag.edgeAt = performance.now();
    bridge.dragEdge?.();
  }
  petX = e.clientX - drag.offX;
  petY = e.clientY - drag.offY;
  applyPet();
  layout();
});
function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  pet.classList.remove('dragging');
  lockHit(false);
  if (d.moved) {
    if (petX < SNAP) petX = 0;
    if (vw() - petX - petSize < SNAP) petX = vw() - petSize;
    if (petY < SNAP) petY = 0;
    if (vh() - petY - petSize < SNAP) petY = vh() - petSize;
    applyPet();
    savePet();
    layout();
  } else if (!awake || booting) {
    wake('click');
  } else if (Speech.playing) {
    hush();
    if (!busy && voiceState.ok) bridge.send({ type: 'listen' });
  } else if (!listening && !busy && voiceState.ok) {
    bridge.send({ type: 'listen' });
  }
  updateHit(e.clientX, e.clientY);
}
pet.addEventListener('pointerup', endDrag);
pet.addEventListener('pointercancel', endDrag);
// 窗口搬屏幕时万一丢了鼠标捕获：当作松手，免得整块屏幕一直点不穿
pet.addEventListener('lostpointercapture', endDrag);

// Ctrl + 滚轮：调核心大小（贴着边的缩放后还贴着）
pet.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const old = petSize;
    const dock = { l: petX <= 0, r: petX + old >= vw(), t: petY <= 0, b: petY + old >= vh() };
    petSize = clamp(petSize + (e.deltaY < 0 ? 6 : -6), 44, 200);
    petX += (old - petSize) / 2;
    petY += (old - petSize) / 2;
    if (dock.l) petX = 0;
    if (dock.r) petX = vw() - petSize;
    if (dock.t) petY = 0;
    if (dock.b) petY = vh() - petSize;
    applyPet();
    savePet();
    layout();
  },
  { passive: false },
);

// 拖面板的角改大小（rs 在 layout 前面声明）
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // 最大能拖多大：固定的那条边不动，另一边不能超出屏幕
  const g = geo;
  const maxW = Math.min(900, vw() - 2 * MARGIN,
    g.side === 'left' ? g.room.left - GAP - MARGIN : g.side === 'right' ? g.room.right - GAP - MARGIN : g.freeH === 'r' ? vw() - g.p.x - MARGIN : g.p.x + g.p.w - MARGIN);
  const maxH = Math.min(vh() - MARGIN - TOP_ROOM,
    g.side === 'above' ? g.room.above - GAP : g.side === 'below' ? g.room.below - GAP - MARGIN : Infinity);
  rs = { sx: e.clientX, sy: e.clientY, w: bubble.offsetWidth, h: bubble.offsetHeight, side: g.side, freeH: g.freeH, freeV: g.freeV, maxW, maxH };
  grip.setPointerCapture(e.pointerId);
  lockHit(true);
  bubble.classList.add('resizing');
  bubbleFixed = true;
});
grip.addEventListener('pointermove', (e) => {
  if (!rs) return;
  const dx = e.clientX - rs.sx;
  const dy = e.clientY - rs.sy;
  // 最小尺寸不低于开始拖时的大小：面板本来就矮的话，一按下去不会先跳高一截
  const nw = clamp(rs.w + (rs.freeH === 'r' ? dx : -dx), Math.min(page === 'chat' ? 320 : 600, rs.w), rs.maxW);
  // 上下居中的面板往两头同时长，拖的距离要乘 2，角才跟得上鼠标
  const nh = clamp(rs.h + (rs.freeV === 't' ? -dy : rs.freeV === 'b' ? dy : 2 * dy), Math.min(page === 'chat' ? 260 : 420, rs.h), rs.maxH);
  if (page === 'chat') [bw, bh] = [nw, nh];
  else [ww, wh] = [nw, nh];
  layout();
});
function endResize(e) {
  if (!rs) return;
  rs = null;
  lockHit(false);
  bubble.classList.remove('resizing');
  if (page === 'chat') store.set('bubble', { w: bw, h: bh, fixed: true });
  else store.set('bubbleWide', { w: ww, h: wh });
  updateHit(e.clientX, e.clientY);
}
grip.addEventListener('pointerup', endResize);
grip.addEventListener('pointercancel', endResize);

function applyUi(key, value) {
  if (key === 'ui.panelOpacity') bubble.style.setProperty('--pa', Math.min(1, Math.max(0.3, value)));
  else if (key === 'ui.petSize') {
    petSize = clamp(value, 44, 200);
    applyPet();
    savePet();
    layout();
  } else if (key === 'ui.sound') cfg.ui.sound = value;
  else if (key === 'ui.boot') cfg.ui.boot = value;
  else if (key === 'speech.fx') Speech.configure({ fx: value });
  else if (key === 'speech.volume') Speech.configure({ volume: value });
}
function resetSize() {
  const ui = cfg.ui || {};
  bw = ui.chatWidth || 440;
  bh = ui.chatHeight || 540;
  [ww, wh] = [WIDE.w, WIDE.h];
  bubbleFixed = false;
  store.set('bubble', null);
  store.set('bubbleWide', null);
  layout();
}

// 给 pages.js 用
window.App = {
  bridge,
  go,
  sendPrompt,
  scrollToAt,
  resetSize,
  layout,
  state: () => ({ brainState, voiceState }),
  tasks: () => taskSnap,
  fmtLeft,
  prefill,
  skillCard,
  cfg: () => cfg,
  tone: (t) => page !== 'chat' && paintPlate(titleEl.textContent, codeEl.textContent, t),
};

pet.style.visibility = 'hidden'; // 读到配置、摆好位置再出现
bridge.config().then((c) => {
  cfg = { ...cfg, ...c, ui: { ...cfg.ui, ...(c.ui || {}) } };
  if (c.speech) Speech.configure({ fx: c.speech.fx, volume: c.speech.volume });
  if (cfg.ui.panelOpacity != null) bubble.style.setProperty('--pa', Math.min(1, Math.max(0.3, cfg.ui.panelOpacity)));
  initPet();
  startBoot();
  // 后台可能比界面先准备好：已经收到的状态在 bootLine 里补上
  checkBootDone();
});
