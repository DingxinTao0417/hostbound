// 项目页：左边总指挥和每个干活的智能体（状态、在做什么），右边四页——
// 过程（选中那个收到的完整提示词、每一步、提问和回答、汇报）、通信（谁对谁说了什么）、计划、合并（每次合并和检查的结果）。
// 数据：打开时要一次完整快照，之后后台一条条推事件；结构变了（派活、合并、状态）再要一次不带事件的快照。
// 在普通浏览器里打开（design/project-preview.html）时没有桥，用预览页给的假数据。
(() => {
  const bridge = window.pw || window.PW_DEMO;
  const app = document.getElementById('app');

  // ---------- 小工具 ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (t) => {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const clip = (s, n) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  const yuan = (v) => `¥${(+v || 0) < 10 ? (+v || 0).toFixed(2) : Math.round(+v)}`;
  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(s / 3600);
    return hh ? `${hh}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };
  const AGENT_ST = { work: ['进行中', 'work'], check: ['合并检查', 'check'], need: ['等你', 'need'], done: ['完成', 'done'], wait: ['等着', 'wait'] };
  const KIND = { planning: ['写计划', 'check'], plan: ['等你看计划', 'need'], running: ['进行中', 'work'], checking: ['最后检查', 'check'], paused: ['暂停', 'wait'], ask: ['等你回答', 'need'], done: ['完成', 'done'], stopped: ['停下了', 'err'], cancelled: ['不做了', 'wait'], failed: ['出错', 'err'] };
  const CHECK = { install: '装依赖', build: '构建', test: '测试', start: '启动', shot: '看首页' };

  // ---------- 状态 ----------
  const S = { id: null, snap: null, events: [], sel: 'boss', tab: 'proc', projects: [], showAll: false, stepEls: new Map(), reply: '' };
  const agents = () => [...(S.snap?.plan?.agents || []), ...(S.snap?.pendingPlan?.agents || []).filter((a) => !(S.snap?.plan?.agents || []).some((x) => x.id === a.id))];
  const roleOf = (id) => (id === 'boss' ? '总指挥' : agents().find((a) => a.id === id)?.role || id || '总指挥');
  const taskOf = (id) => (S.snap?.plan?.tasks || []).find((t) => t.id === id);
  const agentOfEvent = (e) => e.agent || (e.task ? taskOf(e.task)?.agent : null) || null;
  // 总指挥那一栏：不属于哪个智能体的事（计划、开工、最后检查、评审、预算、宿主说的话），再加上它经手的提问、回答、问宿主、处理失败
  const BOSS_ALSO = new Set(['question', 'answer', 'ask_host', 'host_answer', 'triage', 'review', 'fix', 'merged']);
  const forBoss = (e) => e.type !== 'check_start' && e.type !== 'step' && (!agentOfEvent(e) || BOSS_ALSO.has(e.type));
  const forAgent = (e, id) => (id === 'boss' ? forBoss(e) : agentOfEvent(e) === id && e.type !== 'check_start');

  function send(m) {
    bridge?.send(m);
  }
  const act = (action, extra = {}) => send({ op: 'action', projectId: S.id, action, ...extra });

  // ---------- 后台消息 ----------
  let refreshTimer = null;
  const STRUCT = new Set(['plan', 'approved', 'status', 'dispatch', 'report', 'commit', 'merge', 'merged', 'retry', 'triage', 'skip', 'task_done', 'fix', 'review_start', 'review', 'tasks_added', 'done', 'dir', 'ask_host', 'host_answer', 'budget', 'error']);
  function refreshLater() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => send({ op: 'snapshot', projectId: S.id, light: true }), 700);
  }
  bridge?.on((m) => {
    switch (m.type) {
      case 'open':
        if (m.projectId && m.projectId !== S.id) {
          S.id = m.projectId;
          S.snap = null;
          S.events = [];
          S.sel = 'boss';
          S.showAll = false;
          render();
        }
        send({ op: 'snapshot', projectId: S.id });
        send({ op: 'list' });
        break;
      case 'project_snapshot':
        if (m.projectId !== S.id) break;
        if (m.error) {
          S.snap = { error: m.error };
          return render();
        }
        if (m.events) S.events = m.events;
        S.snap = m;
        render();
        break;
      case 'project_event':
        if (m.projectId !== S.id || !S.snap) break;
        S.events.push(m.ev);
        onEvent(m.ev);
        if (STRUCT.has(m.ev.type)) refreshLater();
        break;
      case 'project_card':
        if (m.card?.projectId !== S.id || !S.snap) break;
        S.snap.card = m.card;
        renderHead();
        renderAgents();
        renderBanner();
        break;
      case 'card_other': {
        const p = S.projects.find((x) => x.id === m.card?.projectId);
        if (p) p.card = m.card;
        else send({ op: 'list' });
        renderSwitch();
        break;
      }
      case 'projects':
        S.projects = m.items || [];
        renderSwitch();
        break;
      case 'project_action_result':
        if (!m.ok && m.error) toast(m.error, true);
        if (m.action === 'message' && m.reply) {
          S.reply = m.reply;
          const r = document.getElementById('pp-reply');
          if (r) r.textContent = `总指挥：${m.reply}`;
        }
        if (m.action === 'set_dir' || m.action === 'approve' || m.action === 'answer') refreshLater();
        break;
    }
  });

  // ---------- 整页 ----------
  function render() {
    app.innerHTML = '';
    S.stepEls.clear();
    if (!S.id) return app.append(h('div', { class: 'empty', text: '没有打开项目。' }));
    if (!S.snap) return app.append(h('div', { class: 'empty', text: '读取中…' }));
    if (S.snap.error) return app.append(h('div', { class: 'empty', text: S.snap.error }));
    app.append(
      h('div', { class: 'pphead', id: 'pp-head' }),
      h('div', { id: 'pp-banner' }),
      h('div', { class: 'ppgrid' },
        h('div', { class: 'agl scroll', id: 'pp-agents' }),
        h('div', { class: 'pane' },
          h('div', { class: 'tabs2', id: 'pp-tabs' }),
          h('div', { class: 'tabbody scroll', id: 'pp-body' }))),
      foot());
    renderHead();
    renderBanner();
    renderAgents();
    renderTabs();
    renderBody();
  }

  function foot() {
    const inp = h('input', { class: 'inp', id: 'pp-say', placeholder: '对总指挥说……（比如「前端那个按钮大一点」「进度怎么样」）', autocomplete: 'off', spellcheck: 'false' });
    const go = () => {
      const v = inp.value.trim();
      if (!v) return;
      act('message', { value: v });
      inp.value = '';
      const r = document.getElementById('pp-reply');
      if (r) r.textContent = '总指挥在想…';
    };
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    return h('div', { class: 'ppfoot' }, inp, h('span', { class: 'reply', id: 'pp-reply', text: S.reply ? `总指挥：${S.reply}` : '' }), h('button', { class: 'btn', text: '发送', onclick: go }));
  }

  // ---------- 顶栏 ----------
  function renderHead() {
    const box = document.getElementById('pp-head');
    if (!box) return;
    const c = S.snap.card || {};
    const [label, cls] = KIND[c.kind] || [c.kind, 'wait'];
    const spent = c.costCny || 0;
    const budget = c.budgetCny || 0;
    const ratio = budget ? Math.min(1, spent / budget) : 0;
    const bar = h('span', { class: 'pbar' + (ratio >= 0.8 ? ' warn' : '') }, h('i', { style: `width:${Math.round(ratio * 100)}%` }));
    const time = c.startedAt ? dur((c.finishedAt || Date.now()) - c.startedAt) : '--:--';
    const btns = h('span', { class: 'btns' });
    if (['running', 'checking', 'ask'].includes(c.kind) && c.status !== 'paused') btns.append(h('button', { class: 'btn ghost', text: '暂停', onclick: () => act('pause') }));
    if (c.status === 'paused') btns.append(h('button', { class: 'btn', text: '继续', onclick: () => act('resume') }));
    if (['running', 'checking', 'paused', 'ask'].includes(c.kind) && !['done', 'stopped'].includes(c.status)) {
      let armed = false;
      const b = h('button', { class: 'btn ghost', text: '停止' });
      b.onclick = () => {
        if (!armed) {
          armed = true;
          b.textContent = '再点一次停下';
          return setTimeout(() => ((armed = false), (b.textContent = '停止')), 4000);
        }
        act('stop');
      };
      btns.append(b);
    }
    if (c.kind === 'done' && c.result?.url) btns.append(h('button', { class: 'btn', text: '打开网站', onclick: () => act('open_site') }));
    btns.append(h('button', { class: 'btn ghost', text: '打开文件夹', onclick: () => act('open_folder') }));
    box.innerHTML = '';
    box.append(
      h('span', { class: 'nm', text: c.name || S.snap.project?.name || '' }),
      h('span', { class: `st ${cls}`, text: c.pausedReason === 'budget' ? '预算用完' : label }),
      h('span', { class: 'cost', title: c.dir || '' }, `⏱ ${time} · ${yuan(spent)}${budget ? ` / ¥${budget}` : ''}`, budget ? bar : null),
      h('span', { id: 'pp-switch' }),
      btns);
    renderSwitch();
  }

  function renderSwitch() {
    const box = document.getElementById('pp-switch');
    if (!box || S.projects.length < 2) return box && (box.innerHTML = '');
    const sel = h('select', { class: 'inp', title: '换个项目看' });
    for (const p of S.projects) sel.append(h('option', { value: p.id, text: `${p.name}${p.card ? ` · ${(KIND[p.card.kind] || [p.card.kind])[0]}` : ''}` }));
    sel.value = S.id;
    sel.onchange = () => send({ op: 'switch', projectId: sel.value });
    box.innerHTML = '';
    box.append(sel);
  }

  // ---------- 横幅：等开工 / 等回答 / 做完了 / 出错 ----------
  function renderBanner() {
    const box = document.getElementById('pp-banner');
    if (!box) return;
    box.innerHTML = '';
    const c = S.snap.card || {};
    if (c.kind === 'plan') {
      const est = c.estimate ? `约 ${c.estimate.minutes} 分钟 · ¥${c.estimate.cny?.[0]}～${c.estimate.cny?.[1]}${c.budgetCny ? `（预算 ¥${c.budgetCny}）` : ''}` : '';
      const row = h('div', { class: 'row' }, h('button', { class: 'btn', text: '开工', onclick: (e) => ((e.target.disabled = true), act('approve')) }));
      if (!c.continued) row.append(h('button', { class: 'btn ghost', text: '换个文件夹', onclick: () => send({ op: 'pick_folder', projectId: S.id }) }));
      row.append(h('button', { class: 'btn ghost', text: '不做了', onclick: () => act('cancel') }));
      box.append(h('div', { class: 'banner' }, h('div', { class: 't' }, c.continued ? '修改计划等你确认' : '计划等你确认（「计划」页里有每个任务）', h('small', { text: `${est} · 放在 ${c.dir}` })), row));
    } else if (c.kind === 'ask' && c.question) {
      const q = c.question;
      const inp = h('input', { class: 'inp', placeholder: '或者直接写你的回答，回车发出', autocomplete: 'off' });
      const answer = (v) => v && act('answer', { qid: q.qid, value: v });
      inp.addEventListener('keydown', (e) => e.key === 'Enter' && answer(inp.value.trim()));
      box.append(h('div', { class: 'banner ask' }, h('div', { class: 't' }, q.text, h('small', { text: q.from ? `${q.from}问的 · 总指挥：这事得你拿主意` : '总指挥问的' })),
        h('div', { class: 'row' }, ...(q.options || []).map((o, i) => h('button', { class: i ? 'btn ghost' : 'btn', text: o, onclick: () => answer(o) })), inp)));
    } else if (c.kind === 'done' && c.result) {
      const r = c.result;
      const t = h('div', { class: 't' }, r.did || '做完了', h('small', { text: [r.run && `运行：${r.run}`, r.notes, r.issues?.length && `还有 ${r.issues.length} 个问题没解决：${r.issues.map((x) => clip(x, 60)).join('；')}`].filter(Boolean).join(' · ') }));
      const b = h('div', { class: 'banner ok' }, t);
      if (r.shotData) b.append(h('img', { src: r.shotData, alt: '首页截图', title: '点开看大图', onclick: () => act('open_shot') }));
      b.append(h('div', { class: 'row' }, h('button', { class: 'btn ghost', text: '接着改：在下面跟总指挥说要改什么', onclick: () => document.getElementById('pp-say')?.focus() })));
      box.append(b);
    } else if (['failed', 'stopped'].includes(c.kind)) {
      const row = h('div', { class: 'row' });
      if (c.kind === 'failed' && !c.startedAt) row.append(h('button', { class: 'btn', text: '再写一次计划', onclick: () => act('retry_plan') }));
      box.append(h('div', { class: 'banner err' }, h('div', { class: 't' }, c.error || (c.kind === 'stopped' ? '项目停下了。做好的部分留在项目文件夹里，可以在下面说「接着改……」。' : '出错了')), row));
    } else if (c.kind === 'paused') {
      const why = c.pausedReason === 'budget' ? `预算 ¥${c.budgetCny} 用完了，先停着。` : c.pausedReason === 'restart' ? '系统重启过，项目先停在这里。' : '暂停着。';
      box.append(h('div', { class: 'banner' }, h('div', { class: 't' }, `${why}点「继续」接着做（做到一半的任务会接着做完）。`)));
    }
  }

  // ---------- 左边：智能体 ----------
  function renderAgents() {
    const box = document.getElementById('pp-agents');
    if (!box) return;
    const c = S.snap.card || {};
    box.innerHTML = '';
    const steps = (id) => S.events.filter((e) => e.type === 'step' && e.kind === 'tool' && e.agent === id).length;
    const [bl, bc] = KIND[c.kind] || ['', 'wait'];
    box.append(h('div', { class: 'agi boss' + (S.sel === 'boss' ? ' on' : ''), onclick: () => select('boss') },
      h('div', { class: 'n' }, '总指挥', h('span', { class: `st ${bc}`, text: bl })),
      h('div', { class: 'd', text: `规划、答疑、合并、检查 · 共花 ${yuan(c.costCny)}` })));
    const states = new Map((c.agents || []).map((a) => [a.id, a]));
    for (const a of agents()) {
      const st = states.get(a.id) || {};
      const [label, cls] = AGENT_ST[st.state] || AGENT_ST.wait;
      const n = steps(a.id);
      box.append(h('div', { class: 'agi' + (a.id === 'review' ? ' rev' : '') + (S.sel === a.id ? ' on' : ''), onclick: () => select(a.id), title: a.does || '' },
        h('div', { class: 'n' }, a.role, h('span', { class: `st ${cls}`, text: label })),
        h('div', { class: 'd', text: [st.now || a.does, n ? `${n} 步` : ''].filter(Boolean).join(' · ') })));
    }
  }
  function select(id) {
    S.sel = id;
    S.showAll = false;
    if (S.tab !== 'proc') S.tab = 'proc';
    renderAgents();
    renderTabs();
    renderBody();
  }

  // ---------- 右边：四页 ----------
  const TABS = [['proc', '过程'], ['comm', '通信'], ['plan', '计划'], ['merge', '合并']];
  function renderTabs() {
    const box = document.getElementById('pp-tabs');
    if (!box) return;
    box.innerHTML = '';
    const comm = S.events.filter(isComm).length;
    for (const [k, label] of TABS) {
      box.append(h('span', { class: S.tab === k ? 'on' : '', onclick: () => ((S.tab = k), renderTabs(), renderBody()) }, k === 'proc' ? `过程 · ${roleOf(S.sel)}` : label, k === 'comm' && comm ? h('span', { class: 'cnt', text: comm }) : null));
    }
  }
  function renderBody() {
    const box = document.getElementById('pp-body');
    if (!box) return;
    box.innerHTML = '';
    S.stepEls.clear();
    if (S.tab === 'proc') renderProc(box);
    else if (S.tab === 'comm') renderComm(box);
    else if (S.tab === 'plan') renderPlan(box);
    else renderMerge(box);
    if (S.tab === 'proc' || S.tab === 'comm') box.scrollTop = box.scrollHeight;
  }

  // 新事件：在开着的那页上追加（不整页重画）
  function onEvent(e) {
    const box = document.getElementById('pp-body');
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    if (S.tab === 'proc' && forAgent(e, S.sel)) procItem(box, e);
    else if (S.tab === 'comm' && isComm(e)) commItem(box, e);
    else if (S.tab === 'merge' && ['merge', 'merged', 'check', 'commit'].includes(e.type)) renderBody();
    if (atBottom && (S.tab === 'proc' || S.tab === 'comm')) box.scrollTop = box.scrollHeight;
    if (e.type === 'step' && e.kind === 'tool') {
      clearTimeout(S.agentTimer);
      S.agentTimer = setTimeout(renderAgents, 500);
    }
    if (isComm(e)) {
      clearTimeout(S.tabTimer);
      S.tabTimer = setTimeout(renderTabs, 500);
    }
  }

  // ---- 过程 ----
  const LIMIT = 500;
  function renderProc(box) {
    const list = S.events.filter((e) => forAgent(e, S.sel));
    if (!list.length) return box.append(h('div', { class: 'empty', text: S.sel === 'boss' ? '还没有动静。' : `${roleOf(S.sel)}还没开始干活。` }));
    const from = S.showAll ? 0 : Math.max(0, list.length - LIMIT);
    if (from > 0) box.append(h('div', { class: 'more', text: `前面还有 ${from} 条，点这里全部显示`, onclick: () => ((S.showAll = true), renderBody()) }));
    // 派活的提示词：只展开最新的那份
    const lastDispatch = list.filter((e) => e.type === 'dispatch').at(-1);
    for (const e of list.slice(from)) procItem(box, e, e === lastDispatch);
  }
  function stp(cls, icon, at, ...x) {
    return h('div', { class: `stp ${cls}` }, h('span', { class: 't', text: hm(at) }), h('span', { class: 'i', text: icon }), h('span', { class: 'x' }, ...x));
  }
  function procItem(box, e, open = true) {
    const role = roleOf(agentOfEvent(e));
    switch (e.type) {
      case 'dispatch': {
        const p = h('div', { class: 'prompt' + (open ? '' : ' fold') },
          h('div', { class: 'h', onclick: () => p.classList.toggle('fold') }, `总指挥 → ${e.role || role}：「${e.title}」${e.attempt > 1 ? `（第 ${e.attempt} 次）` : ''}`, h('small', { text: `${hm(e.at)} · ${e.engine === 'pi' ? '跟总指挥同一个模型' : e.engine === 'claude' ? 'Claude Code' : e.engine === 'codex' ? 'Codex' : e.engine || ''} · 点开收起` })),
          h('pre', { text: e.prompt || '' }),
          e.system ? h('pre', { class: 'sys', text: `（系统提示）\n${e.system}` }) : null);
        return box.append(p);
      }
      case 'step': {
        if (e.kind === 'tool_end') {
          const el = S.stepEls.get(e.id);
          if (el) {
            el.className = `stp ${e.ok ? '' : 'fail'}`;
            el.querySelector('.i').textContent = e.ok ? '✓' : '✗';
            if (!e.ok && e.error) el.querySelector('.x').append(h('span', { class: 'err', text: e.error }));
          }
          return;
        }
        if (e.kind === 'tool') {
          const el = stp(e.done ? '' : 'run', e.done ? '✓' : '◆', e.at, e.text || e.name, e.detail && e.detail !== e.text ? h('small', { text: clip(e.detail, 160) }) : null);
          if (e.id) S.stepEls.set(e.id, el);
          return box.append(el);
        }
        if (e.kind === 'say') return box.append(stp('say', '›', e.at, e.text));
        if (e.kind === 'error') return box.append(stp('bad', '!', e.at, e.text));
        return;
      }
      case 'question':
        return box.append(stp('msg', '?', e.at, `${role}问总指挥：${e.text}${e.options?.length ? `（${e.options.join(' / ')}）` : ''}`));
      case 'answer':
        return box.append(stp('ans', '↩', e.at, e.by === 'host' ? `总指挥（转宿主）：${e.text}` : `总指挥：${e.text}`));
      case 'report':
        return box.append(stp('rep', e.status === 'blocked' ? '✗' : '✓', e.at, `${role}汇报${e.status === 'blocked' ? '（做不下去）' : ''}：${e.summary || ''}${e.files?.length ? `\n改了：${e.files.join('、')}` : ''}${e.issues?.length ? `\n要改的问题：\n${e.issues.map((x) => `· ${x}`).join('\n')}` : ''}`));
      case 'commit':
        return box.append(stp('sys2', '⎇', e.at, e.empty ? '没改文件' : `系统提交了 ${e.files?.length || 0} 个文件：${clip((e.files || []).join('、'), 160)}`));
      case 'merge':
        return box.append(stp(e.ok ? 'sys2' : 'bad', e.ok ? '⇢' : '✗', e.at, e.ok ? '合并进主线（合并副本里），开始检查' : e.conflict ? `合并时跟别人的改动冲突了：${(e.files || []).join('、')}` : `合并失败：${clip(e.output, 300)}`));
      case 'merged':
        return box.append(stp('sys2', '✓', e.at, '检查过了，主线往前走了'));
      case 'check_start':
        return;
      case 'preview':
        return box.append(stp('sys2', '◐', e.at, `预览页面：${e.url}`));
      case 'preview_shot':
        return box.append(stp('sys2', '✓', e.at, '截了一张图给它看'));
      case 'check':
        return box.append(stp(e.ok ? 'sys2' : 'bad', e.ok ? '✓' : '✗', e.at, `${e.scope === 'final' ? '最后检查' : '合并后'} · ${CHECK[e.name] || e.name}${e.command ? `（${e.command}）` : ''}${e.ok ? ' 过了' : ' 没过'}${e.ms ? ` · ${(e.ms / 1000).toFixed(1)} 秒` : ''}`, !e.ok && e.output ? h('span', { class: 'err', text: e.output }) : e.skipped ? h('small', { text: e.output }) : e.name === 'shot' && e.output ? h('small', { text: e.output }) : null));
      case 'retry':
        return box.append(stp('bad', '↺', e.at, `退回去改：${clip(e.why, 600)}`));
      case 'triage':
        return box.append(stp('sys2', '◇', e.at, `总指挥：${{ retry: '让它再改一次', skip: '这个任务不要了', ask: '问宿主' }[e.action] || e.action}${e.note ? ` · ${e.note}` : ''}`));
      case 'skip':
        return box.append(stp('sys2', '–', e.at, `跳过这个任务：${e.why || ''}`));
      case 'task_done':
        return box.append(stp('sys2', '★', e.at, `「${e.title}」完成`));
      case 'confirm':
        return box.append(stp('msg', '⚠', e.at, `要宿主授权：${e.label}`, h('small', { text: clip(e.detail, 200) })));
      case 'confirm_done':
        return box.append(stp('ans', '↩', e.at, `宿主${{ allow: '允许了', all: '允许了这个项目里的全部', deny: '没允许' }[e.answer] || e.answer}`));
      case 'forward':
        return box.append(stp('msg', '✉', e.at, `总指挥转来宿主的话${e.live ? '（插进正在做的）' : '（下次派活时带上）'}：${e.text}`));
      // 总指挥那一栏
      case 'created':
        return box.append(stp('sys2', '◆', e.at, `新项目：${e.name}（${e.dir}）\n宿主原话：${e.request}`));
      case 'plan':
        return box.append(stp('sys2', '◆', e.at, `${e.continued ? '写好了修改计划' : '写好了计划'}：${e.plan?.agents?.length || 0} 个智能体、${e.plan?.tasks?.length || 0} 个任务（「计划」页里看）`));
      case 'approved':
        return box.append(stp('sys2', '▶', e.at, `宿主点了开工 · 主线 ${e.main || 'main'} · 起点 ${String(e.base || '').slice(0, 7)}`));
      case 'status':
        return box.append(stp('sys2', '·', e.at, `状态：${(KIND[e.status] || [e.status])[0]}${e.reason ? `（${{ host: '宿主暂停', budget: '预算用完', restart: '系统重启' }[e.reason] || e.reason}）` : ''}`));
      case 'review_start':
        return box.append(stp('sys2', '◆', e.at, '派评审对照宿主原话过一遍'));
      case 'review':
        return box.append(stp(e.issues?.length ? 'bad' : 'sys2', e.issues?.length ? '!' : '✓', e.at, e.issues?.length ? `评审提了 ${e.issues.length} 个问题：\n${e.issues.map((x) => `· ${x}`).join('\n')}` : '评审没发现问题'));
      case 'fix':
        return box.append(stp('sys2', '↺', e.at, `第 ${e.round} 轮修：${(e.tasks || []).map((t) => `${roleOf(t.agent)}「${t.title}」`).join('、')}`));
      case 'budget':
        return box.append(stp(e.level === 'raised' ? 'sys2' : 'bad', '¥', e.at, e.level === 'warn' ? `花费到了预算的八成（${yuan(e.costCny)} / ¥${e.budgetCny}）` : e.level === 'out' ? `预算用完了（${yuan(e.costCny)} / ¥${e.budgetCny}），先问宿主` : `宿主加了预算，现在 ¥${e.budgetCny}`));
      case 'host_msg':
        return box.append(stp('msg', '✉', e.at, `宿主：${e.text}`));
      case 'commander_reply':
        return box.append(stp('ans', '↩', e.at, `总指挥：${e.text}`));
      case 'ask_host':
        return box.append(stp('msg', '?', e.at, `问宿主：${e.text}${e.options?.length ? `（${e.options.join(' / ')}）` : ''}`));
      case 'host_answer':
        return box.append(stp('ans', '↩', e.at, `宿主回答：${e.text}`));
      case 'tasks_added':
        return box.append(stp('sys2', '+', e.at, `加了任务：${(e.tasks || []).map((t) => `${roleOf(t.agent)}「${t.title}」`).join('、')}`));
      case 'dir':
        return box.append(stp('sys2', '·', e.at, `换了文件夹：${e.dir}`));
      case 'site':
        return box.append(stp('sys2', '·', e.at, e.running ? `网站跑起来了：${e.url}` : '网站关掉了'));
      case 'done':
        return box.append(stp('rep', '★', e.at, `项目完成：${e.result?.did || ''}${e.result?.run ? `\n运行：${e.result.run}` : ''}`));
      case 'error':
        return box.append(stp('bad', '!', e.at, e.text));
    }
  }

  // ---- 通信 ----
  const COMM_TYPES = new Set(['dispatch', 'report', 'question', 'answer', 'ask_host', 'host_answer', 'forward', 'host_msg', 'commander_reply', 'merged', 'retry', 'confirm', 'review', 'fix']);
  const isComm = (e) => COMM_TYPES.has(e.type) || (e.type === 'merge' && !e.ok);
  function renderComm(box) {
    const list = S.events.filter(isComm);
    if (!list.length) return box.append(h('div', { class: 'empty', text: '还没有通信。' }));
    for (const e of list.slice(-800)) commItem(box, e);
  }
  function commItem(box, e) {
    const a = roleOf(agentOfEvent(e));
    const who = (...xs) => h('span', { class: 'who' }, ...xs.flatMap((x, i) => (i ? [h('i', { text: '→' }), x] : [x])));
    const row = (k, cls, w, x) => box.append(h('div', { class: 'cm' }, h('span', { class: 't', text: hm(e.at) }), h('span', { class: `k ${cls}`, text: k }), w, h('span', { class: 'x' }, x)));
    switch (e.type) {
      case 'dispatch':
        return row(e.attempt > 1 ? '退回' : '分派', 'as', who('总指挥', a), `「${e.title}」${e.attempt > 1 ? `第 ${e.attempt} 次` : ''}`);
      case 'report':
        return row('汇报', 'rp', who(a, '总指挥'), clip(e.summary, 400));
      case 'question':
        return row('提问', 'qs', who(a, '总指挥'), e.text);
      case 'ask_host':
        return row('问宿主', 'qs', who('总指挥', '宿主'), e.text);
      case 'host_answer':
        return row('回答', 'an', who('宿主', '总指挥'), e.text);
      case 'answer':
        return row('回答', 'an', e.by === 'host' ? who('宿主', '总指挥', a) : who('总指挥', a), e.text);
      case 'forward':
        return row('转达', 'an', who('宿主', '总指挥', roleOf(e.agent)), e.text);
      case 'host_msg':
        return row('宿主说', 'hs', who('宿主', '总指挥'), e.text);
      case 'commander_reply':
        return row('回复', 'an', who('总指挥', '宿主'), e.text);
      case 'merged':
        return row('合并', 'mg', who('总指挥'), `合并${a}的「${taskOf(e.task)?.title || e.task}」· 检查都过了`);
      case 'merge':
        return row('合并', 'er', who('总指挥'), `${a}的「${taskOf(e.task)?.title || e.task}」${e.conflict ? `冲突：${(e.files || []).join('、')}` : '合并失败'}`);
      case 'retry':
        return row('退回', 'er', who('总指挥', a), clip(e.why, 300));
      case 'confirm':
        return row('授权', 'qs', who(a, '宿主'), `${e.label}：${clip(e.detail, 120)}`);
      case 'review':
        return row('评审', e.issues?.length ? 'er' : 'rp', who('评审', '总指挥'), e.issues?.length ? `${e.issues.length} 个问题：${e.issues.map((x) => clip(x, 80)).join('；')}` : '没问题');
      case 'fix':
        return row('分派', 'as', who('总指挥', ...[...new Set((e.tasks || []).map((t) => roleOf(t.agent)))]), `第 ${e.round} 轮修：${(e.tasks || []).map((t) => t.title).join('、')}`);
    }
  }

  // ---- 计划 ----
  const TASK_ST = { pending: ['等着', 'wait'], running: ['进行中', 'work'], merging: ['合并检查', 'check'], done: ['完成', 'done'], failed: ['等你', 'need'], skipped: ['跳过', 'wait'] };
  function renderPlan(box) {
    const plan = S.snap.pendingPlan || S.snap.plan;
    const wrap = h('div', { class: 'pl' });
    const req = String(S.snap.request || '').replace(/^#[^\n]*\n+/, '').replace(/^## 宿主原话\s*/, '').trim();
    wrap.append(h('h4', { text: '宿主原话' }), h('div', { class: 'req', text: req || '（没有）' }));
    if (!plan) {
      wrap.append(h('div', { class: 'empty', text: '计划还没写好。' }));
      return box.append(wrap);
    }
    wrap.append(h('h4', { text: S.snap.pendingPlan ? '这次的修改计划（等你确认）' : '做成什么' }), h('div', { class: 'kv' }, h('span', { text: '目标' }), h('span', { text: plan.summary || '' }), h('span', { text: '做法' }), h('span', { text: plan.approach || '' }), h('span', { text: '放在' }), h('span', { text: S.snap.project?.dir || '' })));
    const ag = h('table', {}, h('tr', {}, h('th', { text: '智能体' }), h('th', { text: '负责什么' })));
    for (const a of plan.agents || []) ag.append(h('tr', {}, h('td', { text: a.role }), h('td', { class: 'd', text: a.does || '' })));
    wrap.append(h('h4', { text: '分工' }), ag);
    const tt = h('table', {}, h('tr', {}, h('th', { text: '任务' }), h('th', { text: '谁' }), h('th', { text: '做什么' }), h('th', { text: '只许改' }), h('th', { text: '状态' })));
    const tasks = S.snap.state?.tasks || {};
    for (const t of plan.tasks || []) {
      const [label, cls] = S.snap.pendingPlan ? TASK_ST.pending : TASK_ST[tasks[t.id]?.status || 'pending'] || TASK_ST.pending;
      const deps = (t.deps || []).map((d) => (plan.tasks || []).find((x) => x.id === d)?.title || d);
      tt.append(h('tr', {},
        h('td', {}, t.title, deps.length ? h('div', { class: 'd', style: 'font-size:11px', text: `在${deps.map((d) => `「${d}」`).join('')}之后` }) : null),
        h('td', { text: roleOf(t.agent) }),
        h('td', { class: 'd' }, clip(t.desc, 400), t.done ? h('div', { style: 'font-size:11px;color:var(--dim)', text: `算做完：${t.done}` }) : null),
        h('td', { class: 'f', text: (t.files || []).join('\n') || '—' }),
        h('td', {}, h('span', { class: `st ${cls}`, text: tasks[t.id]?.attempts > 1 ? `${label} · 第 ${tasks[t.id].attempts} 次` : label }))));
    }
    wrap.append(h('h4', { text: `任务（${(plan.tasks || []).length} 个）` }), tt);
    const c = plan.checks || {};
    const kv = h('div', { class: 'kv' });
    for (const [k, label] of [['install', '装依赖'], ['build', '构建'], ['test', '测试'], ['start', '启动'], ['url', '网址']]) if (c[k]) kv.append(h('span', { text: label }), h('span', {}, h('code', { text: c[k] })));
    kv.append(h('span', { text: '算做完' }), h('span', { text: ['合并一次就构建、测试一次', c.start && '最后能启动', c.web && '首页截图看过', '评审通过'].filter(Boolean).join('，') }));
    wrap.append(h('h4', { text: '怎么检查' }), kv);
    if (plan.estimate) wrap.append(h('h4', { text: '预计' }), h('div', { text: `约 ${plan.estimate.minutes} 分钟 · ¥${plan.estimate.cny?.[0]}～${plan.estimate.cny?.[1]}` }));
    box.append(wrap);
  }

  // ---- 合并 ----
  function renderMerge(box) {
    const rows = [];
    let cur = new Map();
    for (const e of S.events) {
      if (e.type === 'commit' && !e.empty) cur.set(e.task, { files: e.files || [] });
      if (e.type === 'merge') {
        const r = { at: e.at, task: e.task, agent: agentOfEvent(e), files: cur.get(e.task)?.files || e.files || [], ok: e.ok, conflict: e.conflict, output: e.output, checks: {}, merged: false };
        rows.push(r);
        cur.set(e.task, { ...(cur.get(e.task) || {}), row: r });
      }
      if (e.type === 'check' && e.scope === 'merge') {
        const r = cur.get(e.task)?.row;
        if (r) r.checks[e.name] = e;
      }
      if (e.type === 'merged') {
        const r = cur.get(e.task)?.row;
        if (r) r.merged = true;
      }
    }
    if (!rows.length) box.append(h('div', { class: 'empty', text: '还没有合并。每个智能体做完一件事，系统替它提交，再一个一个合进主线、跑一遍检查。' }));
    else {
      box.append(h('div', { class: 'mqi h' }, h('span', { text: '谁的' }), h('span', { text: '改了什么' }), h('span', { text: '合并' }), h('span', { text: '装依赖' }), h('span', { text: '构建' }), h('span', { text: '测试' })));
      const attempts = new Map();
      for (const r of rows) {
        const n = (attempts.get(r.task) || 0) + 1;
        attempts.set(r.task, n);
        const out = h('div', { class: 'outbox hidden' });
        const cell = (e, pending) => {
          if (!e) return h('span', { class: 'c w', text: pending ? '排队' : '—' });
          const c = h('span', { class: `c ${e.ok ? 'y' : 'n'}`, text: e.ok ? '✓' : '✗', title: e.ok ? `${(e.ms / 1000 || 0).toFixed(1)} 秒` : '点开看输出' });
          if (!e.ok) c.onclick = () => ((out.textContent = `${e.command}\n${e.output || ''}`), out.classList.toggle('hidden'));
          return c;
        };
        const mergeCell = h('span', { class: `c ${r.ok ? 'y' : 'n'}`, text: r.ok ? (r.merged ? '✓' : '…') : r.conflict ? '冲突' : '✗' });
        if (!r.ok) mergeCell.onclick = () => ((out.textContent = r.conflict ? `冲突的文件：\n${(r.files || []).join('\n')}` : r.output || ''), out.classList.toggle('hidden'));
        const waiting = r.ok && !r.merged && !Object.values(r.checks).some((x) => !x.ok);
        const t = taskOf(r.task);
        box.append(h('div', { class: 'mqi' },
          h('span', { text: `${roleOf(r.agent)}${n > 1 ? ` #${n}` : ''}` }),
          h('span', { class: 'f', title: (r.files || []).join('\n') }, `「${t?.title || r.task}」`, h('small', { text: ` ${r.files.length} 个文件 · ${clip(r.files.slice(0, 4).join('、'), 80)}` })),
          mergeCell, cell(r.checks.install, false), cell(r.checks.build, waiting), cell(r.checks.test, waiting)), out);
      }
    }
    const fin = S.events.filter((e) => e.type === 'check' && e.scope === 'final');
    if (fin.length) {
      box.append(h('div', { class: 'mtitle', text: '最后检查（在项目文件夹里）' }));
      for (const e of fin) {
        const out = h('div', { class: 'outbox hidden', text: `${e.command || ''}\n${e.output || ''}` });
        box.append(stp(e.ok ? 'sys2' : 'bad', e.ok ? '✓' : '✗', e.at, `${CHECK[e.name] || e.name}${e.command ? `（${e.command}）` : ''}${e.skipped ? ' · 跳过' : e.ok ? ' · 过了' : ' · 没过'}${e.name === 'shot' && e.output ? ` · ${e.output}` : ''}`, e.output && !e.ok ? h('a', { style: 'color:var(--cyan);cursor:pointer;margin-left:6px', text: '看输出', onclick: () => out.classList.toggle('hidden') }) : null), out);
      }
    }
  }

  // ---------- 提示 ----------
  function toast(text, bad) {
    const t = h('div', { style: `position:fixed;left:50%;bottom:56px;transform:translateX(-50%);padding:6px 14px;background:rgba(9,15,42,.97);border:1px solid ${bad ? 'var(--red)' : 'var(--cyan)'};color:#fff;font-size:12.5px;z-index:20`, text });
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // 窗口按钮
  document.querySelectorAll('.winbtns [data-op]').forEach((b) => b.addEventListener('click', () => send({ op: b.dataset.op })));
  // 用时每 30 秒刷新一下
  setInterval(() => S.snap && !S.snap.error && renderHead(), 30_000);
  send({ op: 'ready' });
  render();
})();
