// 面板对话里的项目卡（项目模式）：一个项目一张卡，状态实时变——写计划中 → 计划（金色，等你点开工）→ 进行中（蓝）→ 等你回答（粉紫）→ 完成（绿）。
// 卡上的按钮直接发给后台（project_action）；「打开项目页」开单独的大窗口。设计稿 design/projects.html
// 用 app.js 里的 add / addCard / logEl / bridge / wake / setPanel / ding / armSleep / scrollLog / prefill（同一个页面里的全局）。
(() => {
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  };
  const btn = (label, cls, onclick) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  };
  const yuan = (v) => `¥${(+v || 0) < 10 ? (+v || 0).toFixed(2) : Math.round(+v)}`;
  const mins = (ms) => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  };
  const ST = { work: ['进行中', 'work'], check: ['合并检查', 'check'], need: ['等你', 'need'], done: ['完成', 'done'], wait: ['等着', 'wait'] };

  async function act(c, action, extra = {}) {
    const r = await window.Pages.request({ type: 'project_action', projectId: c.projectId, action, ...extra }, 60_000);
    if (!r) add('note', '后台没回应，稍后再试。');
    else if (!r.ok && r.error) add('note', `没办成：${r.error}`);
    return r;
  }

  function kv(pairs) {
    const d = el('div', 'kv');
    for (const [k, v] of pairs) if (v) d.append(el('span', 'k', k), v instanceof Node ? v : el('span', 'v', v));
    return d;
  }

  function doneText(checks) {
    const parts = [checks?.start && '能启动', checks?.test && '测试全过', checks?.web && '首页截图检查', '评审通过'].filter(Boolean);
    return parts.join('、');
  }

  // 一个项目的卡
  function make(c) {
    const kind = c.kind;
    const tone = { plan: '', running: 'run', checking: 'run', paused: 'run', planning: 'run', ask: 'ask', done: 'ok', stopped: 'err', failed: 'err', cancelled: 'err' }[kind] ?? 'run';
    const d = el('div', `msg pj ${tone}`);
    d.dataset.pid = c.projectId;
    d.dataset.kind = kind;
    d.dataset.at = c.startedAt || Date.now();
    const total = c.tasks?.total || 0;
    const done = c.tasks?.done || 0;
    const head = {
      planning: '【项目】总指挥在写计划…',
      plan: c.continued ? '【修改计划】待你确认' : '【项目计划】待你确认',
      running: '【项目】进行中',
      checking: '【项目】最后检查中',
      paused: c.pausedReason === 'budget' ? '【项目】预算用完，暂停了' : c.pausedReason === 'restart' ? '【项目】系统重启过，暂停着' : '【项目】暂停了',
      ask: '【项目】等你回答',
      done: `【项目完成】${c.name}`,
      stopped: '【项目】已停下',
      cancelled: '【项目】不做了',
      failed: '【项目】出错了',
    }[kind] || '【项目】';
    const tt = el('div', 'tt', head);
    const small = el('small', '', kind === 'plan' ? 'PLAN' : kind === 'done' ? `${c.startedAt ? mins((c.finishedAt || Date.now()) - c.startedAt) : ''} · ${yuan(c.costCny)}` : kind === 'ask' ? c.name : total ? `${done} / ${total} 步` : '');
    tt.append(small);
    d.append(tt);
    if (kind !== 'done') d.append(el('div', 'nm', c.name));

    if (kind === 'planning') d.append(el('div', 'meta', '总指挥在拆任务、安排几个智能体，写好了在这里给你过目。'));

    if (kind === 'plan') {
      d.append(kv([['做成什么', c.summary], ['怎么做', c.approach]]));
      const ag = el('div', 'ag');
      for (const a of c.agents || []) ag.append(el('span', 'rl', a.role), el('span', 'r', a.does || ''), el('span'));
      if (!c.continued) ag.append(el('span', 'rl', '评审'), el('span', 'r', '最后对照你的原话过一遍'), el('span'));
      d.append(ag);
      if (c.planTasks?.length) d.append(el('div', 'meta tasks', `${c.planTasks.length} 个任务：${c.planTasks.map((t) => t.title).join(' → ')}`));
      const where = el('span', 'path', c.dir);
      if (!c.continued) {
        const a = el('a', '', '换个文件夹');
        a.onclick = async () => {
          const dir = await bridge.pickFolder?.();
          if (dir) act(c, 'set_dir', { value: dir });
        };
        where.append(a);
      }
      const est = c.estimate ? `约 ${c.estimate.minutes} 分钟 · ¥${c.estimate.cny?.[0] ?? '?'}～${c.estimate.cny?.[1] ?? '?'}${c.budgetCny ? `（预算 ¥${c.budgetCny}）` : ''}` : '';
      d.append(kv([['算做完', doneText(c.checks)], ['预计', est], ['放在', where]]));
      const go = btn('开工', 'btn sm', async () => {
        go.disabled = true;
        go.textContent = '开工中…';
        const r = await act(c, 'approve');
        if (!r?.ok) {
          go.disabled = false;
          go.textContent = '开工';
        }
      });
      d.append(btnRow(go, btn('改一下', 'btn ghost sm', () => prefill(`「${c.name}」的计划改一下：`)), btn('不做了', 'btn ghost sm', () => act(c, 'cancel'))));
      d.append(el('div', 'hintv', '也可以直接说「开工」，或者说要改哪'));
    }

    if (['running', 'checking', 'paused'].includes(kind)) {
      const ag = el('div', 'ag');
      for (const a of c.agents || []) {
        const [label, cls] = ST[a.state] || ST.wait;
        ag.append(el('span', 'rl', a.role), el('span', 'r', a.now || ''), el('span', `st ${cls}`, label));
      }
      d.append(ag);
      const bar = el('div', 'pbar');
      const i = el('i');
      i.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      bar.append(i);
      d.append(bar, el('div', 'meta', `${c.startedAt ? `用时 ${mins(Date.now() - c.startedAt)} · ` : ''}花费 ${yuan(c.costCny)}${c.budgetCny ? ` / ¥${c.budgetCny}` : ''}`));
      const row = [btn('打开项目页', 'btn sm', () => act(c, 'open_page'))];
      if (kind === 'paused') row.push(btn('继续', 'btn ghost sm', () => act(c, 'resume')), btn('停下', 'btn ghost sm', () => act(c, 'stop')));
      else row.push(btn('暂停', 'btn ghost sm', () => act(c, 'pause')));
      d.append(btnRow(...row));
    }

    if (kind === 'ask' && c.question) {
      const q = el('div', 'q', c.question.text);
      q.append(el('small', '', c.question.from ? `${c.question.from}问的 · 总指挥：这事得你拿主意` : '总指挥问的'));
      d.append(q);
      const row = (c.question.options || []).map((o, n) => btn(o, n ? 'btn ghost sm' : 'btn sm', () => act(c, 'answer', { qid: c.question.qid, value: o })));
      row.push(btn('打开项目页', 'btn ghost sm', () => act(c, 'open_page')));
      d.append(btnRow(...row));
      d.append(el('div', 'hintv', '也可以直接说、或者打字回答'));
    }

    if (kind === 'done' && c.result) {
      const r = c.result;
      const checks = el('span', 'v done-list');
      for (const x of r.checks || []) {
        checks.append(el('b', x.ok ? 'y' : 'n', x.ok ? '✓' : '✗'), ` ${x.name} `);
      }
      d.append(kv([['做了', r.did], ['检查', (r.checks || []).length ? checks : null], ['怎么运行', r.run ? el('span', 'path', r.run) : null], ['注意', r.notes], ['没解决', (r.issues || []).length ? `${r.issues.length} 个问题（项目页里有）` : null]]));
      if (r.shotData) {
        const img = el('img', 'shot');
        img.src = r.shotData;
        img.alt = '首页截图';
        img.title = '点开看大图';
        img.onclick = () => act(c, 'open_shot');
        d.append(img);
      }
      const row = [];
      if (r.url) {
        const site = btn('打开网站', 'btn sm', async () => {
          site.disabled = true;
          site.textContent = '启动中…';
          await act(c, 'open_site');
          site.disabled = false;
          site.textContent = '打开网站';
        });
        row.push(site);
      }
      row.push(btn('打开文件夹', r.url ? 'btn ghost sm' : 'btn sm', () => act(c, 'open_folder')), btn('项目页', 'btn ghost sm', () => act(c, 'open_page')), btn('接着改', 'btn ghost sm', () => prefill(`接着改「${c.name}」：`)));
      d.append(btnRow(...row));
    }

    if (['stopped', 'cancelled', 'failed'].includes(kind)) {
      if (c.error) d.append(el('div', 'meta err', c.error));
      else d.append(el('div', 'meta', kind === 'cancelled' ? '计划没开工。' : `做到 ${done} / ${total} 步停下了，做好的部分留在项目文件夹里。`));
      const row = [btn('项目页', 'btn ghost sm', () => act(c, 'open_page'))];
      if (c.startedAt) row.push(btn('接着改', 'btn ghost sm', () => prefill(`接着改「${c.name}」：`)));
      else if (kind === 'failed') row.push(btn('再写一次计划', 'btn sm', () => act(c, 'retry_plan')));
      d.append(btnRow(...row));
    }
    return d;
  }
  function btnRow(...bs) {
    const r = el('div', 'btns');
    r.append(...bs);
    return r;
  }

  // 卡已经在对话里就原地更新；要宿主看的（计划、提问、完成）如果已经被顶上去了，挪到最下面
  function upsert(c) {
    const old = logEl.querySelector(`.msg.pj[data-pid="${CSS.escape(c.projectId)}"]`);
    const card = make(c);
    const loud = ['plan', 'ask', 'done'].includes(c.kind);
    if (old) {
      const changed = old.dataset.kind !== c.kind;
      const tail = [...logEl.children].slice(-3).includes(old);
      if (loud && changed && !tail) {
        old.remove();
        addCard(card);
      } else old.replaceWith(card);
    } else addCard(card);
    return { card, changed: !old || old.dataset.kind !== c.kind };
  }

  bridge.onBrain((m) => {
    if (m.type !== 'project_card' || !m.card) return;
    const { changed } = upsert(m.card);
    if (!changed) return;
    const k = m.card.kind;
    if (k === 'plan' || k === 'ask' || k === 'done') {
      wake('event');
      toChat();
      ding(k === 'ask' ? 'auth' : 'quest');
      setPanel(k === 'plan' ? '项目计划' : k === 'ask' ? '项目 · 等你' : '项目完成', k === 'plan' ? 'PLAN' : k === 'ask' ? 'ASK' : 'COMPLETE', k === 'plan' ? 'gold' : k === 'ask' ? 'warn' : 'ok', 'done');
      armSleep(90_000);
      scrollLog();
    }
  });

  window.ProjectCards = { make };
})();
