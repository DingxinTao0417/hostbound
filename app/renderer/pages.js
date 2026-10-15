// 阶段 3：面板的记录、日志、设置、新手引导几页。对话页在 app.js 里；翻页、面板变宽由 app.js 的 App.go 管
(() => {
  const B = () => window.App.bridge;
  const $p = (s, el = document) => el.querySelector(s);

  // 小工具：造元素
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

  // ---- 跟后台要数据：发一条带编号的请求，等同编号的回复 ----
  const waiting = new Map();
  let seq = 0;
  function request(msg, ms = 15000) {
    return new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      B().send({ ...msg, reqId: id });
      setTimeout(() => {
        if (waiting.delete(id)) resolve(null);
      }, ms);
    });
  }

  const pad = (n) => String(n).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const hms = (t) => { const d = new Date(t); return `${hm(t)}:${pad(d.getSeconds())}`; };
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const WEEK = '日一二三四五六';
  function dayLabel(t) {
    const d = new Date(t);
    const k = dayKey(t);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    if (k === dayKey(Date.now())) return `今天 · ${md}`;
    if (k === dayKey(Date.now() - 86400_000)) return `昨天 · ${md}`;
    return `${md}（周${WEEK[d.getDay()]}）`;
  }

  // =================== 任务 ===================
  const T = { built: false };
  function buildTask() {
    $p('#pg-task').append(h('div', { class: 'task-wrap' }, h('div', { id: 'task-left' }), h('div', { id: 'task-right' })));
    T.built = true;
  }
  const KIND_HINT = { at: '一次', every: '重复', cron: '重复' };
  function renderTask() {
    if (!T.built) return;
    const snap = window.App.tasks();
    const now = Date.now();
    const left = $p('#task-left');
    const right = $p('#task-right');
    left.innerHTML = '';
    right.innerHTML = '';
    const cancel = (id) => h('span', { class: 'x', title: '取消', text: '×', onclick: () => B().send({ type: 'task_cancel', id }) });
    left.append(h('div', { class: 'tsec' }, '定时任务', h('small', { text: `${snap.tasks?.length || 0} 个` })));
    if (!snap.tasks?.length) left.append(h('div', { class: 'empty', style: 'padding:14px 0', text: '还没有。跟系统说「半小时后提醒我喝水」试试。' }));
    for (const t of snap.tasks || []) {
      const once = t.kind === 'at';
      left.append(h('div', { class: 'ti' + (once ? '' : ' rep') },
        h('span', {}, h('span', { class: 'n', text: t.name }), t.do ? h('span', { class: 'do', text: '到点去做' }) : null, h('span', { class: 's', text: t.do ? `${t.when} · ${t.do}` : t.when })),
        h('span', { class: 'c', 'data-due': t.nextAt, text: once ? window.App.fmtLeft(t.nextAt - now) : `下次 ${new Date(t.nextAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` }),
        cancel(t.id)));
    }
    left.append(h('div', { class: 'tsec' }, '最近提醒过的'));
    const hist = h('div', { class: 'thist' });
    for (const e of snap.fired || []) hist.append(h('div', {}, h('span', { class: 't', text: dayKey(e.at) === dayKey(now) ? hm(e.at) : `${new Date(e.at).getMonth() + 1}/${new Date(e.at).getDate()}` }), `${e.name}${e.text ? `：${e.text}` : ''}${e.late ? `（错过 ${Math.round(e.late / 60000)} 分钟）` : ''}`));
    if (!snap.fired?.length) hist.append(h('div', { class: 'empty', style: 'padding:8px 0', text: '还没有' }));
    left.append(hist);

    right.append(h('div', { class: 'tsec' }, '正在盯着的', h('small', { text: '发生了就报告' })));
    if (!snap.watches?.length) right.append(h('div', { class: 'empty', style: 'padding:14px 0', text: '没有。说「等这个视频导出完叫我」，系统会自己建一条。' }));
    for (const w of snap.watches || []) right.append(h('div', { class: 'ti watch' }, h('span', {}, h('span', { class: 'n', text: w.name }), h('span', { class: 's', text: `${w.what}${w.keep ? ' · 一直盯着' : ' · 报告一次就撤'}` })), h('span', { class: 'c', text: '盯着' }), cancel(w.id)));
    right.append(h('div', { class: 'tsec' }, '自带的监测', h('small', { text: '设置里也能开关' })));
    const builtin = [
      ['watch.downloads', '下载完成', '下载文件夹出现新文件 · 角落小提示', snap.builtin?.downloads],
      ['watch.battery', '电量低', '不插电时低于 20% 和 10% 各报一次 · 念出来', snap.builtin?.battery],
      ['watch.live', '直播检测', `OBS 开始推流或直播软件开着：自动开直播模式${snap.live ? `（现在：${snap.liveSource}）` : ''}`, snap.builtin?.live],
    ];
    for (const [key, name, desc, on] of builtin) {
      const t = h('span', { class: 'tog' + (on ? ' on' : '') });
      t.addEventListener('click', async () => {
        const v = !t.classList.contains('on');
        t.classList.toggle('on', v);
        const r = await B().setSetting(key, v, `${name} · ${v ? '开' : '关'}`);
        if (!r?.ok) t.classList.toggle('on', !v);
      });
      right.append(h('div', { class: 'ti watch' }, h('span', {}, h('span', { class: 'n', text: name }), h('span', { class: 's', text: desc })), t, h('span')));
    }
  }
  // 每秒刷新任务页上的倒计时
  function tickTask(now) {
    if (current !== 'task') return;
    for (const c of document.querySelectorAll('#task-left .ti:not(.rep) .c[data-due]')) c.textContent = window.App.fmtLeft(+c.dataset.due - now);
  }

  // =================== 记忆 ===================
  const M = { built: false, group: '宿主', data: null, q: '', hits: null, hl: new Set() };
  function buildMem() {
    const page = $p('#pg-mem');
    const search = h('input', { class: 'pg-input', placeholder: '搜记忆（意思相近的也能搜到，比如「视频放哪」）', spellcheck: 'false' });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        M.q = search.value.trim();
        M.hits = M.q ? (await request({ type: 'memory_search', q: M.q }))?.items || [] : null;
        renderMemList();
      }, 350);
    });
    page.append(
      h('div', { class: 'toolbar' }, search,
        h('button', { class: 'btn sm', text: '+ 加一条', onclick: () => $p('#mem-form').classList.toggle('hidden') }),
        h('button', { class: 'btn ghost sm', id: 'mem-review', text: '现在整理一次', onclick: reviewNow })),
      h('div', { class: 'mform hidden', id: 'mem-form' }),
      h('div', { class: 'mem-wrap' }, h('div', { class: 'mgroups', id: 'mem-groups' }), h('div', { class: 'mlist', id: 'mem-list' }), h('div', { class: 'mjournal', id: 'mem-journal' })),
      h('div', { class: 'mfoot', id: 'mem-foot' }),
    );
    M.built = true;
  }
  async function loadMem() {
    const r = await request({ type: 'memory_query' });
    if (!r) return;
    M.data = r;
    if (!r.files.some((x) => x.name === M.group)) M.group = '宿主';
    renderMem();
  }
  function renderMem() {
    if (!M.data) return;
    const groups = $p('#mem-groups');
    groups.innerHTML = '';
    const g = (file) => h('span', { class: 'g' + (M.group === file.name && !M.hits ? ' on' : ''), onclick: () => ((M.group = file.name), (M.hits = null), renderMem()) }, file.name.replace(/^主题\//, ''), h('small', { text: file.entries.length }));
    groups.append(h('div', { class: 'lbl', text: '常驻' }), ...M.data.files.filter((x) => x.core).map(g));
    const topics = M.data.files.filter((x) => !x.core);
    if (topics.length) groups.append(h('div', { class: 'lbl', text: '主题' }), ...topics.map(g));
    renderMemList();
    renderJournal();
    renderMemFoot(M.data.status);
    renderMemForm();
  }
  function entryRow(e, extra) {
    const row = h('div', { class: 'me' + (M.hl.has(e.id) ? ' hl' : ''), 'data-id': e.id });
    const text = h('div', { class: 't', text: e.text });
    const meta = h('div', { class: 'm' }, `${e.added ? e.added.slice(5) + ' 记下' : ''}${extra ? ' · ' + extra : ''}`, e.source ? ' · 来源：' : '', e.source ? (e.at ? h('a', { text: e.source.replace(/^对话 /, ''), title: '跳到那次对话', onclick: () => window.App.scrollToAt(e.at) }) : e.source) : null);
    const ops = h('div', { class: 'ops' },
      h('span', { title: '改', text: '✎', onclick: () => {
        if (row.querySelector('.edit')) return;
        const inp = h('input', { class: 'pg-input', value: e.text });
        const done = async (save) => {
          if (save && inp.value.trim() && inp.value.trim() !== e.text) {
            const r = await request({ type: 'memory_edit', op: 'update', id: e.id, text: inp.value.trim() });
            if (!r?.ok) return (inp.title = r?.error || '没改成'), inp.classList.add('err');
            return loadMem();
          }
          row.querySelector('.edit')?.remove();
        };
        inp.addEventListener('keydown', (ev) => ev.key === 'Enter' ? done(true) : ev.key === 'Escape' && done(false));
        row.append(h('div', { class: 'edit' }, inp, h('button', { class: 'btn sm', text: '保存', onclick: () => done(true) }), h('button', { class: 'btn ghost sm', text: '取消', onclick: () => done(false) })));
        window.App.bridge.focus();
        inp.focus();
      } }),
      h('span', { class: 'del', title: '删', text: '✕', onclick: async () => {
        await request({ type: 'memory_edit', op: 'remove', id: e.id });
        loadMem();
      } }));
    row.append(text, meta, ops);
    return row;
  }
  function renderMemList() {
    const list = $p('#mem-list');
    list.innerHTML = '';
    if (M.hits) {
      list.append(h('div', { class: 'mhead' }, h('b', { text: `搜「${M.q}」` }), `${M.hits.length} 条`, h('span', { class: 'r', text: M.data?.status?.vector?.ok === false ? '向量暂时用不了，只按关键词' : '按相关程度' })));
      if (!M.hits.length) list.append(h('div', { class: 'empty', text: '没搜到' }));
      for (const e of M.hits) list.append(entryRow(e, `${e.file}${e.cos != null ? ` · 意思 ${Math.round(e.cos * 100)}%` : ''}${e.kw ? ' · 关键词' : ''}`));
      return;
    }
    const file = M.data.files.find((x) => x.name === M.group);
    if (!file) return;
    list.append(h('div', { class: 'mhead' }, h('b', { text: file.name + (file.core ? ' · 常驻' : '') }), `${file.entries.length} 条`, h('span', { class: 'r', text: `${file.chars} / ${file.limit} 字` })));
    if (!file.entries.length) list.append(h('div', { class: 'empty', text: file.name === '宿主' ? '还没记下关于你的事。跟系统说「记住……」，或者多聊几轮，它会自己整理。' : '空的' }));
    for (const e of file.entries) list.append(entryRow(e));
  }
  function renderJournal() {
    const box = $p('#mem-journal');
    box.innerHTML = '';
    box.append(h('div', { class: 'h', text: '最近改动' }));
    if (!M.data.journal.length) box.append(h('div', { class: 'empty', style: 'padding:10px 0', text: '还没有' }));
    for (const c of M.data.journal) {
      const when = new Date(c.at);
      const row = h('div', { class: 'mj' + (c.undone ? ' undone' : '') },
        h('span', { class: 'w', text: `${dayKey(c.at) === dayKey(Date.now()) ? hm(c.at) : `${when.getMonth() + 1}/${when.getDate()} ${hm(c.at)}`} ${c.by}` }), h('br'));
      for (const o of (c.ops || []).slice(0, 4)) row.append(h('span', { class: 'k ' + o.op, text: { add: '新增', update: '改', remove: '删' }[o.op] }), o.after || o.before || '', h('br'));
      if ((c.ops || []).length > 4) row.append(`……共 ${c.ops.length} 条`, h('br'));
      if (!c.undone && c.by !== '撤销') row.append(h('a', { text: '撤销这次', onclick: async () => {
        await request({ type: 'memory_undo', id: c.id });
        loadMem();
      } }));
      else if (c.undone) row.append(h('span', { class: 'w', text: '已撤销' }));
      box.append(row);
    }
  }
  function renderMemFoot(st) {
    const foot = $p('#mem-foot');
    if (!foot || !st) return;
    foot.innerHTML = '';
    const tog = (key, label, on) => {
      const t = h('span', { class: 'tog' + (on ? ' on' : '') });
      t.addEventListener('click', async () => {
        const v = !t.classList.contains('on');
        t.classList.toggle('on', v);
        if (!(await B().setSetting(key, v, `${label} · ${v ? '开' : '关'}`))?.ok) t.classList.toggle('on', !v);
      });
      return [label, t];
    };
    const v = st.vector || {};
    const vec = !v.configured ? '向量检索：没配密钥（设置 · 大脑里填）' : v.ok === false ? `向量检索暂时用不了：${v.reason}` : `向量检索：可用${v.chat?.total ? ` · 对话 ${v.chat.done}/${v.chat.total}` : ''}`;
    const files = M.data?.files || [];
    const core = files.filter((x) => x.core).map((x) => `${x.name} ${x.chars}/${x.limit}`).join(' · ');
    foot.append(...tog('memory.enabled', '记新的', st.enabled), ...tog('memory.autoReview', '自动整理', st.autoReview),
      h('span', { text: st.reviewing ? '正在整理…' : `${st.lastReview ? `上次整理 ${hm(st.lastReview)} · ` : ''}再聊 ${Math.max(0, st.every - st.since)} 轮整理` }),
      h('span', { class: 'vec ' + (v.configured && v.ok !== false ? 'ok' : 'bad'), text: vec }),
      h('span', { class: 'r', text: core }));
  }
  function renderMemForm() {
    const form = $p('#mem-form');
    form.innerHTML = '';
    const sel = h('select', { class: 'pg-input', style: 'flex:none;width:120px' });
    for (const x of (M.data?.files || []).map((f) => f.name)) sel.append(h('option', { value: x, text: x }));
    sel.append(h('option', { value: '__new', text: '新主题…' }));
    sel.value = M.group;
    const topic = h('input', { class: 'pg-input hidden', placeholder: '主题名', style: 'flex:none;width:100px' });
    sel.addEventListener('change', () => topic.classList.toggle('hidden', sel.value !== '__new'));
    const text = h('input', { class: 'pg-input', placeholder: '一条一件事，比如「剪映导出目录是 D:\\剪映导出」', style: 'flex:1;min-width:200px' });
    const msg = h('span', { class: 'hint' });
    form.append(sel, topic, text, h('button', { class: 'btn sm', text: '记下', onclick: async () => {
      const file = sel.value === '__new' ? topic.value.trim() : sel.value;
      if (!file || !text.value.trim()) return (msg.textContent = '要写内容');
      const r = await request({ type: 'memory_edit', op: 'add', file, text: text.value.trim() });
      if (!r?.ok) return (msg.textContent = r?.error || '没记上');
      M.group = file.length && !['宿主', '记忆'].includes(file) ? `主题/${file.replace(/^主题\//, '')}` : file;
      loadMem();
    } }), msg);
  }
  async function reviewNow() {
    const btn = $p('#mem-review');
    btn.textContent = '整理中…';
    btn.disabled = true;
    const r = await request({ type: 'memory_review' }, 120000);
    btn.textContent = !r ? '超时了' : !r.ok ? `没成功：${r.error}` : r.change ? `整理完：${r.change.summary}` : r.note || '没有要改的';
    setTimeout(() => ((btn.textContent = '现在整理一次'), (btn.disabled = false)), 4000);
    loadMem();
  }
  // 对话里「记忆已更新 · 查看」：翻到记忆页、高亮那几条
  function showChange(change) {
    M.hl = new Set((change?.ops || []).map((o) => o.id));
    const first = change?.ops?.[0];
    if (first?.file) M.group = first.file;
    M.hits = null;
    window.App.go('mem');
    setTimeout(() => (M.hl = new Set()), 3000);
  }

  // =================== 技能 ===================
  // 左边所有技能（我的 / 社区 / 这台电脑用不了 / 回收区），右边详情；也能切到「待确认」「从网址装」
  const K = { built: false, data: null, sel: null, view: 'skill', q: '', install: null, diff: null };
  const shortDay = (t) => (dayKey(t) === dayKey(Date.now()) ? `今天 ${hm(t)}` : dayKey(t) === dayKey(Date.now() - 86400_000) ? '昨天' : `${new Date(t).getMonth() + 1}-${new Date(t).getDate()}`);
  function buildSkill() {
    const page = $p('#pg-skill');
    const search = h('input', { class: 'pg-input', placeholder: '搜技能（名字、口令、说明）', spellcheck: 'false' });
    search.addEventListener('input', () => {
      K.q = search.value.trim().toLowerCase();
      renderSkillList();
    });
    page.append(
      h('div', { class: 'toolbar' }, search,
        h('button', { class: 'btn sm', text: '+ 教一个', onclick: () => window.App.prefill('学一个技能：') }),
        h('button', { class: 'btn ghost sm', text: '从网址装', onclick: () => ((K.view = 'install'), renderSkill()) }),
        h('span', { class: 'pend hidden', id: 'sk-pend', onclick: () => ((K.view = 'pending'), renderSkill()) })),
      h('div', { class: 'sk-wrap' }, h('div', { class: 'sklist', id: 'sk-list' }), h('div', { class: 'skdetail', id: 'sk-detail' })),
      h('div', { class: 'mfoot', id: 'sk-foot' }),
    );
    K.built = true;
  }
  async function loadSkill() {
    const r = await request({ type: 'skills_query' });
    if (!r) return;
    K.data = r;
    if (K.sel && !r.skills.some((x) => x.folder === K.sel)) K.sel = null;
    if (!K.sel) K.sel = r.skills[0]?.folder || null;
    if (K.view === 'pending' && !r.pending.length) K.view = 'skill';
    renderSkill();
  }
  function renderSkill() {
    if (!K.data) return;
    const n = K.data.pending.length;
    const pend = $p('#sk-pend');
    pend.textContent = `待确认 ${n}`;
    pend.classList.toggle('hidden', !n);
    pend.classList.toggle('on', K.view === 'pending');
    renderSkillList();
    renderSkillDetail();
    renderSkillFoot();
  }
  const badgeOf = (x) =>
    !x.avail.ok ? ['na', '用不了'] : x.origin === 'mine' ? ['mine', '我的'] : x.origin === 'community' ? ['trusted', x.checked ? '社区·已检查' : '社区'] : ['community', '没检查'];
  function skillRow(x) {
    const [cls, label] = badgeOf(x);
    const tog = h('span', { class: 'tog' + (x.enabled ? ' on' : ''), title: x.enabled ? '停用' : '启用' });
    tog.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      tog.classList.toggle('on');
      const r = await request({ type: 'skill_op', op: 'toggle', folder: x.folder, on: tog.classList.contains('on') });
      if (!r?.ok) tog.classList.toggle('on');
      loadSkill();
    });
    const desc = !x.avail.ok
      ? x.avail.reasons[0]
      : !x.enabled
        ? '停用中'
        : `${x.triggers.length ? `口令：${x.triggers[0]}` : x.description.slice(0, 24)} · ${x.lastUsed ? `上次用：${shortDay(x.lastUsed)}` : '还没用过'}`;
    return h('div', { class: 'ski' + (K.view === 'skill' && K.sel === x.folder ? ' on' : '') + (x.enabled ? '' : ' off') + (x.avail.ok ? '' : ' na'), onclick: () => ((K.sel = x.folder), (K.view = 'skill'), (K.diff = null), renderSkill()) },
      h('div', { class: 'n' }, h('span', { class: 'nm', text: x.title }), h('span', { class: 'b ' + cls, text: label }), tog),
      h('div', { class: 'd', text: desc }));
  }
  function renderSkillList() {
    const box = $p('#sk-list');
    box.innerHTML = '';
    const all = K.data.skills.filter((x) => !K.q || [x.title, x.name, x.description, ...x.triggers].join(' ').toLowerCase().includes(K.q));
    const groups = [
      ['我的', all.filter((x) => x.avail.ok && x.origin === 'mine')],
      ['社区', all.filter((x) => x.avail.ok && x.origin !== 'mine')],
      ['这台电脑用不了', all.filter((x) => !x.avail.ok)],
    ];
    if (!K.data.skills.length) box.append(h('div', { class: 'empty', text: '还没有技能。说「学一个技能：……」试试。' }));
    else if (!all.length) box.append(h('div', { class: 'empty', text: '没搜到' }));
    for (const [name, list] of groups) {
      if (!list.length) continue;
      box.append(h('div', { class: 'tsec' }, name, h('small', { text: `${list.length} 个` })));
      for (const x of list) box.append(skillRow(x));
    }
    if (K.data.trash.length) {
      box.append(h('div', { class: 'tsec' }, '回收区', h('small', { text: '30 天内能恢复' })));
      for (const t of K.data.trash) {
        box.append(h('div', { class: 'ski off trash' },
          h('div', { class: 'n' }, h('span', { class: 'nm', text: t.title }), h('a', { class: 'restore', text: '恢复', onclick: async () => {
            const r = await request({ type: 'skill_op', op: 'restore', key: t.key });
            if (r?.ok) K.sel = r.folder;
            loadSkill();
          } })),
          h('div', { class: 'd', text: `${shortDay(t.at)} 删的 · 还剩 ${t.left} 天` })));
      }
    }
  }
  function renderSkillDetail() {
    const box = $p('#sk-detail');
    box.innerHTML = '';
    if (K.view === 'pending') return renderPending(box);
    if (K.view === 'install') return renderInstall(box);
    const x = K.data.skills.find((y) => y.folder === K.sel);
    if (!x) {
      box.append(h('div', { class: 'sk-howto' },
        h('h4', { text: '三种教法' }),
        h('p', {}, h('b', { text: '口头教：' }), '说「学一个技能：每次做新一期，先建个今天日期的文件夹，再打开剪映」，系统问一两句，写成草稿给你看。'),
        h('p', {}, h('b', { text: '从刚才做的：' }), '让系统做完一件事后说「把刚才这套做成技能」。'),
        h('p', {}, h('b', { text: '系统主动问：' }), '一件事用了很多步、或者你中途纠正过，对话里会冒一行「要存成技能吗」。'),
        h('p', { class: 'hint', text: '技能都要你点了「保存」才生效；以后说口令就直接跑。' })));
      return;
    }
    const [cls, label] = badgeOf(x);
    box.append(h('h4', {}, x.title, h('span', { class: 'b ' + cls, text: label })));
    box.append(h('div', { class: 'sub', text: [x.description, x.source, x.sourceUrl ? `来自 ${x.sourceUrl}` : '', `用过 ${x.uses} 次`].filter(Boolean).join(' · ') }));
    if (!x.avail.ok) box.append(h('div', { class: 'warnline', text: `这台电脑用不了：${x.avail.reasons.join('；')}。大脑看不到它，口令也不认。` }));

    // 口令
    box.append(h('h5', { text: '口令' }));
    const trig = h('div', { class: 'trigs' });
    const saveTrig = async (list, msg) => {
      const r = await request({ type: 'skill_op', op: 'triggers', folder: x.folder, triggers: list });
      if (!r?.ok) return (msg.textContent = r?.error || '没改成');
      loadSkill();
    };
    const msg = h('span', { class: 'hint err' });
    for (const t of x.triggers) trig.append(h('span', { class: 'trig' }, t, h('i', { title: '去掉', text: '×', onclick: () => saveTrig(x.triggers.filter((y) => y !== t), msg) })));
    const add = h('a', { class: 'addtrig', text: '+ 加一个', onclick: () => {
      const inp = h('input', { class: 'pg-input', placeholder: '至少 3 个字', style: 'width:140px;flex:none;height:24px' });
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && inp.value.trim()) saveTrig([...x.triggers, inp.value.trim()], msg);
        if (ev.key === 'Escape') renderSkillDetail();
      });
      add.replaceWith(inp);
      window.App.bridge.focus();
      inp.focus();
    } });
    trig.append(add, msg);
    box.append(trig);
    if (!x.triggers.length) box.append(h('div', { class: 'hint', text: '没有口令：大脑看说明自己决定用不用。加一个口令，说了就一定用。' }));

    // 步骤
    box.append(h('h5', { text: '步骤（SKILL.md）' }), h('div', { class: 'md', text: x.body }));

    // 脚本
    if (x.scripts.length) {
      box.append(h('h5', { text: '脚本' }));
      for (const sc of x.scripts) {
        const st = sc.status === 'approved' ? ['ok2', `✓ 你批准过（${shortDay(sc.approvedAt)}）`] : sc.status === 'changed' ? ['chg', '⚠ 内容变了，下次跑会再问你'] : ['chg', '还没批准，第一次跑会问你'];
        box.append(h('div', { class: 'scr' }, h('span', { text: sc.rel }), h('span', { class: st[0], text: st[1] })));
      }
    }

    // 改动记录
    const changes = K.data.journal.filter((c) => c.folder === x.folder);
    if (changes.length) {
      box.append(h('h5', { text: '改动记录' }));
      for (const c of changes.slice(0, 12)) {
        const row = h('div', { class: 'mj' + (c.undone ? ' undone' : '') }, h('span', { class: 'w', text: `${shortDay(c.at)} ${c.by}` }), ' ', c.summary || '', ' ');
        if (c.hasDiff) row.append(h('a', { text: K.diff?.id === c.id ? '收起' : '看改了什么', onclick: () => showDiff(c.id) }), ' ');
        if (!c.undone && c.by !== '撤销' && c.op !== 'delete') row.append(h('a', { text: '撤销', onclick: async () => {
          const r = await request({ type: 'skill_op', op: 'undo', id: c.id });
          if (!r?.ok) row.append(h('span', { class: 'hint err', text: r?.error || '撤销不了' }));
          else loadSkill();
        } }));
        else if (c.undone) row.append(h('span', { class: 'w', text: '已撤销' }));
        box.append(row);
        if (K.diff?.id === c.id) box.append(diffView(K.diff));
      }
    }

    // 按钮
    const del = h('button', { class: 'btn ghost sm danger', text: '删除', onclick: async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = '1';
        del.textContent = '再点一次删除（放进回收区）';
        return;
      }
      await request({ type: 'skill_op', op: 'remove', folder: x.folder });
      K.sel = null;
      loadSkill();
    } });
    box.append(h('div', { class: 'skbtns' },
      h('button', { class: 'btn sm', text: '现在跑一次', disabled: !x.avail.ok || undefined, onclick: () => {
        window.App.go('chat');
        B().send({ type: 'skill_run', folder: x.folder });
      } }),
      h('button', { class: 'btn ghost sm', text: '用记事本改', onclick: () => B().send({ type: 'skill_open', folder: x.folder, file: true }) }),
      h('button', { class: 'btn ghost sm', text: '打开文件夹', onclick: () => B().send({ type: 'skill_open', folder: x.folder }) }),
      del));
  }
  async function showDiff(id) {
    if (K.diff?.id === id) {
      K.diff = null;
      return renderSkillDetail();
    }
    const r = await request({ type: 'skill_diff', id });
    K.diff = r ? { id, before: r.before || '', after: r.after || '' } : null;
    renderSkillDetail();
  }
  // 简单的逐行对比：去掉的标红、加上的标绿
  function diffView(d) {
    const a = d.before.replace(/\r\n/g, '\n').split('\n');
    const b = d.after.replace(/\r\n/g, '\n').split('\n');
    const inA = new Set(a);
    const inB = new Set(b);
    const box = h('div', { class: 'md diff' });
    for (const l of a) if (!inB.has(l)) box.append(h('div', { class: 'del', text: '- ' + l }));
    for (const l of b) if (!inA.has(l)) box.append(h('div', { class: 'add', text: '+ ' + l }));
    if (!box.children.length) box.append(h('div', { class: 'hint', text: '只改了空行或顺序' }));
    return box;
  }
  function renderPending(box) {
    box.append(h('h4', {}, '待确认', h('small', { text: '草稿、改进、安装检查：点了才生效' })));
    if (!K.data.pending.length) return box.append(h('div', { class: 'empty', text: '没有要确认的' }));
    for (const e of K.data.pending) {
      box.append(window.App.skillCard(e, { inPage: true }));
      if (e.kind !== 'install') box.append(h('details', { class: 'mdbox' }, h('summary', { text: '看完整的 SKILL.md' }), h('div', { class: 'md', text: e.md })));
    }
  }
  function renderInstall(box) {
    box.append(h('h4', { text: '从网址装别人写好的技能' }));
    const url = h('input', { class: 'pg-input', placeholder: 'GitHub 仓库或技能文件夹的网址，比如 github.com/作者/仓库', spellcheck: 'false', value: K.install?.url || '' });
    const go = h('button', { class: 'btn sm', text: '检查' });
    const out = h('div', { class: 'skinstall' });
    const run = async (pick) => {
      const u = url.value.trim();
      if (!u) return;
      K.install = { url: u };
      go.disabled = true;
      out.innerHTML = '';
      out.append(h('div', { class: 'hint', text: '检查中…（下载到隔离区、程序扫一遍、让模型写报告，大概十几秒）' }));
      const r = await request({ type: 'skill_install', url: u, pick }, 180000);
      go.disabled = false;
      out.innerHTML = '';
      if (!r) return out.append(h('div', { class: 'hint err', text: '超时了，再试一次' }));
      if (!r.ok) return out.append(h('div', { class: 'hint err', text: r.error }));
      if (r.candidates) {
        out.append(h('div', { class: 'hint', text: `${r.source} 里有 ${r.candidates.length} 个技能，选一个检查：` }));
        for (const c of r.candidates) out.append(h('div', { class: 'ski cand', onclick: () => run(c.name) }, h('div', { class: 'n' }, h('span', { class: 'nm', text: c.name })), h('div', { class: 'd', text: c.description })));
        return;
      }
      if (r.pending) {
        out.append(h('div', { class: 'hint', text: '报告出来了（对话里也放了一份）：' }), window.App.skillCard(r.pending, { inPage: true }));
        loadSkill();
      }
    };
    go.onclick = () => run();
    url.addEventListener('keydown', (ev) => ev.key === 'Enter' && run());
    box.append(h('div', { class: 'toolbar' }, url, go), out,
      h('div', { class: 'hint', text: '只装你信得过的来源。会先下载到隔离区，不加载、不运行；程序查一遍脚本、联网、读写的文件、像不像在骗 AI，再写成大白话报告给你看，你点「安装」才装。ClawHub 这类技能市场先不接。' }));
    setTimeout(() => {
      window.App.bridge.focus();
      url.focus();
    }, 0);
  }
  function renderSkillFoot() {
    const foot = $p('#sk-foot');
    foot.innerHTML = '';
    const tog = (key, label, on) => {
      const t = h('span', { class: 'tog' + (on ? ' on' : '') });
      t.addEventListener('click', async () => {
        const v = !t.classList.contains('on');
        t.classList.toggle('on', v);
        if (!(await B().setSetting(key, v, `${label} · ${v ? '开' : '关'}`))?.ok) t.classList.toggle('on', !v);
      });
      return [label, t];
    };
    const sk = K.data.skills;
    foot.append(...tog('skills.enabled', '用技能', K.data.enabled), ...tog('skills.suggest', '主动问要不要存成技能', K.data.suggest),
      h('span', { text: `${sk.length} 个技能 · 大脑能用 ${sk.filter((x) => x.enabled && x.avail.ok).length} 个` }),
      h('a', { class: 'r', text: '打开技能文件夹', onclick: () => B().send({ type: 'skill_open' }) }));
  }
  // 对话里「已保存 · 查看」：翻到技能页、选中那个
  function showSkill(folder) {
    K.sel = folder;
    K.view = 'skill';
    window.App.go('skill');
  }

  // =================== 记录 ===================
  const RES = { ok: ['完成', 'ok'], fail: ['失败', 'fail'], deny: ['被拒绝', 'deny'], stopped: ['中止', 'stopped'] };
  const rec = { q: '', result: 'all', items: [], more: false, sel: null, built: false };
  function buildRec() {
    const page = $p('#pg-rec');
    const search = h('input', { class: 'pg-input', placeholder: '搜索指令或结果', spellcheck: 'false' });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => ((rec.q = search.value.trim()), loadRec()), 250);
    });
    const chips = [['all', '全部'], ['ok', '完成'], ['fail', '失败'], ['deny', '被拒绝']].map(([k, label]) =>
      h('span', { class: 'chip pick' + (k === 'all' ? ' on' : ''), 'data-k': k, text: label, onclick: (e) => {
        rec.result = k;
        page.querySelectorAll('.toolbar .chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
        loadRec();
      } }),
    );
    page.append(
      h('div', { class: 'rec-wrap' },
        h('div', {}, h('div', { class: 'toolbar' }, search, ...chips), h('div', { class: 'pscroll', id: 'rec-list' })),
        h('div', { class: 'detail' }, h('div', { class: 'card' }, h('div', { class: 'hd' }, h('span', { class: 'dia' }), '这一次', h('small', { id: 'rec-when' })), h('div', { class: 'ct', id: 'rec-body' })),
          h('div', { class: 'btns' },
            h('button', { class: 'btn sm', id: 'rec-redo', text: '再做一遍' }),
            h('button', { class: 'btn ghost sm', id: 'rec-find', text: '在对话里找' }))),
      ),
    );
    rec.built = true;
  }
  async function loadRec(append = false) {
    const before = append ? rec.items.at(-1)?.at : undefined;
    const r = await request({ type: 'history_query', q: rec.q, result: rec.result, before, limit: 60 });
    if (!r) return;
    rec.items = append ? rec.items.concat(r.items) : r.items;
    rec.more = r.more;
    renderRec();
  }
  function renderRec() {
    const list = $p('#rec-list');
    list.innerHTML = '';
    if (!rec.items.length) {
      list.append(h('div', { class: 'empty', text: rec.q || rec.result !== 'all' ? '没有符合条件的记录' : '还没有记录。下一条指令做完就会出现在这里。' }));
      showRecDetail(null);
      return;
    }
    let day = '';
    for (const r of rec.items) {
      const d = dayLabel(r.at);
      if (d !== day) list.append(h('div', { class: 'day', text: (day = d) }));
      const [label, cls] = RES[r.result] || [r.result, 'stopped'];
      list.append(h('div', { class: 'rec' + (rec.sel?.id === r.id ? ' sel' : ''), 'data-id': r.id, onclick: () => showRecDetail(r) },
        h('span', { class: 't', text: hm(r.at) }), h('span', { class: 'q', text: r.text, title: r.text }), h('span', { class: 'res ' + cls, text: label }), h('span', { class: 's', text: `${r.seconds}s` })));
    }
    if (rec.more) list.append(h('button', { class: 'btn ghost sm more-btn', text: '加载更早的', onclick: () => loadRec(true) }));
    if (!rec.sel || !rec.items.some((x) => x.id === rec.sel.id)) showRecDetail(rec.items[0]);
  }
  function showRecDetail(r) {
    rec.sel = r;
    document.querySelectorAll('#rec-list .rec').forEach((el) => el.classList.toggle('sel', el.dataset.id === r?.id));
    const body = $p('#rec-body');
    body.innerHTML = '';
    $p('#rec-when').textContent = r ? `${dayLabel(r.at).replace(/^.* · /, '')} ${hm(r.at)}` : '';
    $p('#rec-redo').disabled = $p('#rec-find').disabled = !r;
    if (!r) return;
    body.append(h('div', { class: 'q', text: r.text }));
    body.append(h('div', { class: 'meta', text: `${r.via === 'voice' ? '语音' : '打字'} · ${r.tools ? `${r.tools} 个动作 · ` : ''}用时 ${r.seconds} 秒` }));
    if (r.steps?.length) body.append(h('ul', {}, r.steps.map((s) => h('li', { class: s.ok === true ? 'ok' : s.ok === false ? 'no' : '', text: s.text }))));
    else body.append(h('div', { class: 'meta', text: '直接回答，没动手' }));
    const tone = r.result === 'ok' ? '' : r.result === 'deny' ? 'color:#ffb0e6' : r.result === 'fail' ? 'color:#ffb3bf' : 'color:var(--muted)';
    body.append(h('div', { class: 'ans', style: tone, text: r.answer || '' }));
    $p('#rec-redo').onclick = () => window.App.sendPrompt(r.text);
    $p('#rec-find').onclick = () => window.App.scrollToAt(r.at);
  }

  // =================== 日志 ===================
  const LOG_TYPES = { all: '全部', mem: '记忆', skill: '技能', task: '任务', cmd: '命令', app: '软件', web: '网页', file: '文件', auth: '授权', screen: '看屏幕', voice: '语音', err: '出错', sys: '系统' };
  const lg = { type: 'all', day: null, q: '', days: [], built: false };
  function buildLog() {
    const page = $p('#pg-log');
    const chips = Object.entries(LOG_TYPES).map(([k, label]) =>
      h('span', { class: 'chip pick' + (k === 'all' ? ' on' : ''), text: label, onclick: (e) => {
        lg.type = k;
        page.querySelectorAll('.toolbar .chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
        loadLog();
      } }),
    );
    const daySel = h('select', { class: 'pg-input', id: 'log-day', style: 'flex:none;width:118px', onchange: (e) => ((lg.day = e.target.value), loadLog()) });
    const search = h('input', { class: 'pg-input', placeholder: '搜索', style: 'flex:none;width:110px', spellcheck: 'false' });
    let t = null;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => ((lg.q = search.value.trim()), loadLog()), 250);
    });
    page.append(h('div', { class: 'toolbar' }, ...chips), h('div', { class: 'toolbar' }, daySel, search, h('span', { class: 'hint', style: 'font-size:11.5px;color:var(--dim)', text: '点一行看细节 · 保留 30 天' })), h('div', { class: 'pscroll lg', id: 'log-list' }));
    lg.built = true;
  }
  async function loadLog() {
    const r = await request({ type: 'log_query', day: lg.day, logType: lg.type, q: lg.q });
    if (!r) return;
    lg.days = r.days;
    lg.day = r.day;
    const sel = $p('#log-day');
    sel.innerHTML = '';
    for (const d of r.days.length ? r.days : [dayKey(Date.now())]) sel.append(h('option', { value: d, text: d === dayKey(Date.now()) ? `今天 ${d.slice(5)}` : d }));
    if (r.day) sel.value = r.day;
    const list = $p('#log-list');
    list.innerHTML = '';
    if (!r.items.length) list.append(h('div', { class: 'empty', text: '这一天没有符合条件的记录' }));
    for (const e of r.items) list.append(logRow(e));
  }
  function logRow(e, fresh) {
    return h('div', { class: 'e' + (fresh ? ' new' : ''), 'data-type': e.type, onclick: (ev) => ev.currentTarget.classList.toggle('open') },
      h('span', { class: 'tm', text: hms(e.at) }), h('span', { class: 'ty', text: LOG_TYPES[e.type] || e.type }), h('span', { text: e.text }),
      e.detail ? h('div', { class: 'more', text: e.detail }) : null);
  }
  function onLogEntry(e) {
    if (!lg.built || current !== 'log') return;
    if (lg.day && lg.day !== dayKey(e.at)) return;
    if (lg.type !== 'all' && lg.type !== e.type) return;
    if (lg.q && !`${e.text} ${e.detail || ''}`.toLowerCase().includes(lg.q.toLowerCase())) return;
    const list = $p('#log-list');
    list.querySelector('.empty')?.remove();
    list.prepend(logRow(e, true));
  }

  // =================== 设置 ===================
  const S = { values: {}, defaults: {}, info: null, sub: 'ear', built: false, snap: null };
  const save = async (key, value, label, el) => {
    const r = await B().setSetting(key, value, label);
    const foot = $p('#set-foot');
    if (r?.ok) {
      S.values[key] = value;
      foot.className = 'sfoot ok';
      foot.textContent = `已保存：${label}`;
    } else {
      foot.className = 'sfoot err';
      foot.textContent = `没改成：${r?.error || '不知道为什么'}`;
      if (el) renderSub();
    }
    return r?.ok;
  };
  const debounce = (fn, ms = 350) => {
    let t = null;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  // 一行一个设置项
  function row(label, ...kids) {
    return h('div', { class: 'srow' }, h('span', { class: 'lbl', text: label }), ...kids);
  }
  function toggle(key, label, hint, badge) {
    const on = !!S.values[key];
    const t = h('span', { class: 'tog' + (on ? ' on' : ''), title: on ? '开' : '关' });
    t.addEventListener('click', async () => {
      const v = !t.classList.contains('on');
      t.classList.toggle('on', v);
      if (!(await save(key, v, `${label} · ${v ? '开' : '关'}`))) t.classList.toggle('on', !v);
    });
    return row(label, hint ? h('span', { class: 'hint', text: hint }) : null, h('span', { class: 'r' }, badge ? h('span', { class: 'badge', text: badge }) : null, t));
  }
  function slider(key, label, { min, max, step, fmt, badge, hint }) {
    const v = S.values[key] ?? S.defaults[key];
    const val = h('span', { class: 'val', text: fmt(v) });
    const rng = h('input', { type: 'range', class: 'rng', min, max, step, value: v });
    const commit = debounce((x) => save(key, x, `${label} · ${fmt(x)}`));
    rng.addEventListener('input', () => {
      val.textContent = fmt(+rng.value);
      commit(+rng.value);
    });
    return h('div', {}, row(label, rng, val, badge ? h('span', { class: 'badge', text: badge }) : null), hint ? h('div', { class: 'srow', style: 'border:0;min-height:0;padding-top:0' }, h('span', { class: 'lbl' }), h('span', { class: 'hint', text: hint })) : null);
  }
  function chips(key, label, options, badge, after) {
    const cur = S.values[key];
    const box = h('span', { class: 'r' });
    for (const [v, text] of options) {
      box.append(h('span', { class: 'chip pick' + (v === cur ? ' on' : ''), text, onclick: async (e) => {
        if (await save(key, v, `${label} · ${text}`)) box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget));
        after?.(v);
      } }));
    }
    if (badge) box.append(h('span', { class: 'badge', text: badge }));
    return row(label, box);
  }
  const head = (text) => h('h5', { text });
  const note = (text) => h('div', { class: 'srow' }, h('span', { class: 'hint', text }));

  // 唤醒词：可以加、可以删（至少留一个）
  function wakeWords() {
    const list = S.values['voice.wakeWords'] || [];
    const box = h('span', { class: 'r', style: 'flex-wrap:wrap' });
    for (const w of list) {
      box.append(h('span', { class: 'chip on', title: w.tokens }, w.text, list.length > 1 ? h('span', { class: 'x', style: 'cursor:pointer;color:var(--muted)', text: ' ×', onclick: () => {
        save('voice.wakeWords', list.filter((x) => x !== w), `删掉唤醒词「${w.text}」`).then(renderSub);
      } }) : null));
    }
    const form = h('div', { class: 'form hidden' });
    const tx = h('input', { class: 'pg-input', placeholder: '汉字，比如：你好系统', style: 'flex:none;width:130px' });
    const tk = h('input', { class: 'pg-input', placeholder: '拼音（自动填，也能手改）', style: 'flex:1;min-width:150px' });
    const msg = h('span', { class: 'hint' });
    // 打汉字：自动转成拼音（宿主手改过拼音就不覆盖）
    let tkEdited = false;
    tk.addEventListener('input', () => (tkEdited = true));
    tx.addEventListener('input', debounce(async () => {
      if (tkEdited || !tx.value.trim()) return;
      const r = await request({ type: 'to_pinyin', text: tx.value.trim() });
      if (!r || tkEdited) return;
      tk.value = r.tokens || '';
      msg.textContent = r.error || (r.ok ? '' : r.missing?.length ? `模型不认识这些音节：${r.missing.join(' ')}，手改一下` : '');
    }, 300));
    const ok = h('button', { class: 'btn sm', text: '加上', onclick: async () => {
      const text = tx.value.trim();
      const tokens = tk.value.trim().replace(/\s+/g, ' ');
      if (!text || !tokens) return (msg.textContent = '汉字和拼音都要填');
      const c = await request({ type: 'check_keyword', tokens });
      if (!c?.ok) return (msg.textContent = c?.missing?.length ? `模型不认识这些音节：${c.missing.join(' ')}` : '拼音格式不对');
      save('voice.wakeWords', [...list, { text, tokens }], `加上唤醒词「${text}」`).then(renderSub);
    } });
    form.append(tx, tk, ok, msg);
    box.append(h('span', { class: 'chip pick', text: '+ 添加', onclick: () => form.classList.toggle('hidden') }), h('span', { class: 'badge', text: '自动重启耳朵' }));
    return h('div', {}, row('唤醒词', box), form, h('div', { class: 'srow', style: 'border:0;min-height:0;padding-top:0' }, h('span', { class: 'lbl' }), h('span', { class: 'hint', text: '打汉字会自动填拼音（每个字拆成「声母 + 带声调的韵母」）。三个字的唤醒词更容易误唤醒，四个字以上更稳' })));
  }

  // 边说边测：开着时听到唤醒词只在这里闪一下，不叫醒
  let testing = false;
  function wakeTest() {
    const hit = h('span', { class: 'testhit', id: 'test-hit' });
    const btn = h('button', { class: 'btn ghost sm', text: testing ? '停止测试' : '边说边测', onclick: () => {
      testing = !testing;
      B().send({ type: 'wake_test', on: testing });
      btn.textContent = testing ? '停止测试' : '边说边测';
      hit.textContent = testing ? '现在说唤醒词试试…' : '';
    } });
    return row('', btn, hit);
  }
  function stopTest() {
    if (!testing) return;
    testing = false;
    B().send({ type: 'wake_test', on: false });
  }

  function micRow() {
    const sel = h('select', { class: 'pg-input', style: 'flex:1' });
    sel.append(h('option', { value: '', text: '跟系统默认走' }));
    for (const m of S.info?.mics || []) sel.append(h('option', { value: m.name, text: m.name + (m.isDefault ? '（默认）' : '') }));
    sel.value = S.values['voice.mic'] || '';
    sel.addEventListener('change', () => save('voice.mic', sel.value, `麦克风 · ${sel.value || '系统默认'}`));
    return row('麦克风', sel, h('span', { class: 'badge', text: '自动重启耳朵' }));
  }

  // 快捷键：点「改」以后直接按
  function accel(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const k = e.key.length === 1 ? e.key.toUpperCase() : { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: null }[e.key] ?? e.key;
    if (!k || ['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return null;
    return mods.length ? [...mods, k].join('+') : null; // 全局快捷键要带修饰键
  }
  const PRETTY = { Control: 'Ctrl', Super: 'Win', Mouse4: '鼠标侧键（后）', Mouse5: '鼠标侧键（前）', RightCtrl: '右 Ctrl', RightAlt: '右 Alt', RightShift: '右 Shift' };
  const keycaps = (s) => String(s).split('+').map((k) => h('span', { class: 'key', text: PRETTY[k] || k }));
  function hotkey(key, label) {
    const show = h('span', {}, ...keycaps(S.values[key]));
    const btn = h('button', { class: 'btn ghost sm', text: '改' });
    btn.addEventListener('click', () => {
      window.App.bridge.focus();
      show.innerHTML = '';
      show.append(h('span', { class: 'key rec', text: '按下新的组合键…' }));
      const onKey = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return done(null);
        const a = accel(e);
        if (a) done(a);
      };
      const done = async (a) => {
        window.removeEventListener('keydown', onKey, true);
        if (a) await save(key, a, `${label} · ${a}`);
        renderSub();
      };
      window.addEventListener('keydown', onKey, true);
    });
    return row(label, show, h('span', { class: 'r' }, btn));
  }
  // 按住说话：键盘上单个键（右 Ctrl、F8……）或鼠标侧键
  const CODE_TO = { ControlRight: 'RightCtrl', AltRight: 'RightAlt', ShiftRight: 'RightShift', ControlLeft: 'LeftCtrl', AltLeft: 'LeftAlt', ShiftLeft: 'LeftShift' };
  function pttRow() {
    const list = [].concat(S.values['hotkeys.pushToTalk'] || []);
    const box = h('span', {});
    for (const k of list) box.append(h('span', { class: 'key' }, PRETTY[k] || k, h('span', { class: 'x', text: '×', onclick: () => save('hotkeys.pushToTalk', list.filter((x) => x !== k), `按住说话 · 去掉 ${PRETTY[k] || k}`).then(renderSub) })));
    const btn = h('button', { class: 'btn ghost sm', text: '添加' });
    btn.addEventListener('click', () => {
      window.App.bridge.focus();
      box.append(h('span', { class: 'key rec', text: '按一下键盘上的键或鼠标侧键…' }));
      const finish = async (name) => {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousedown', onMouse, true);
        if (name && !list.includes(name)) await save('hotkeys.pushToTalk', [...list, name], `按住说话 · 加上 ${PRETTY[name] || name}`);
        renderSub();
      };
      const onKey = (e) => {
        e.preventDefault();
        if (e.key === 'Escape') return finish(null);
        finish(CODE_TO[e.code] || (/^F\d+$/.test(e.code) ? e.code : e.code.replace(/^Key/, '')));
      };
      const onMouse = (e) => {
        if (e.button === 3 || e.button === 4) {
          e.preventDefault();
          finish(e.button === 3 ? 'Mouse4' : 'Mouse5');
        }
      };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('mousedown', onMouse, true);
    });
    return row('按住说话', box, h('span', { class: 'r' }, btn));
  }

  // 直播软件：这些程序开着就算在直播
  function liveApps() {
    const list = S.values['watch.liveApps'] || [];
    const NAMES = { 'livehime.exe': 'B站直播姬', '直播伴侣.exe': '抖音直播伴侣' };
    const box = h('div', { class: 'srow', style: 'flex-wrap:wrap' }, h('span', { class: 'lbl', text: '直播软件' }));
    for (const n of list) box.append(h('span', { class: 'chip', title: n }, NAMES[n.toLowerCase()] || n, h('span', { style: 'cursor:pointer;color:var(--muted)', text: ' ×', onclick: () => save('watch.liveApps', list.filter((x) => x !== n), `直播软件 · 去掉 ${n}`).then(renderSub) })));
    const inp = h('input', { class: 'pg-input', placeholder: '程序名，比如 livehime.exe', style: 'flex:1;min-width:160px' });
    const add = h('button', { class: 'btn sm', text: '加上', onclick: () => {
      let v = inp.value.trim().replace(/^.*[\\/]/, '');
      if (v && !/\.exe$/i.test(v)) v += '.exe';
      if (v && !list.includes(v)) save('watch.liveApps', [...list, v], `直播软件 · 加上 ${v}`).then(renderSub);
    } });
    return h('div', {}, box, h('div', { class: 'form' }, inp, add), note('程序名可以在任务管理器「详细信息」里看到。B站直播姬是 livehime.exe，抖音直播伴侣是 直播伴侣.exe。'));
  }

  // 禁止操作的软件
  function blockedApps() {
    const list = S.values['safety.blockedApps'] || [];
    const box = h('div', { class: 'srow', style: 'flex-wrap:wrap' });
    for (const n of list) box.append(h('span', { class: 'chip' }, n, h('span', { style: 'cursor:pointer;color:var(--muted)', text: ' ×', onclick: () => save('safety.blockedApps', list.filter((x) => x !== n), `禁止名单 · 去掉 ${n}`).then(renderSub) })));
    const inp = h('input', { class: 'pg-input', placeholder: '软件名或窗口标题里的词，比如：微信', style: 'flex:1;min-width:180px' });
    const add = h('button', { class: 'btn sm', text: '加上', onclick: () => {
      const v = inp.value.trim();
      if (v && !list.includes(v)) save('safety.blockedApps', [...list, v], `禁止名单 · 加上 ${v}`).then(renderSub);
    } });
    return h('div', {}, list.length ? box : note('还没有。加进来的软件系统读都不读，更不会点；你让它做也会拒绝并说明。'), h('div', { class: 'form' }, inp, add, h('span', { class: 'badge', text: '马上生效' })));
  }

  // 讲解：画图用的模型（留空跟聊天同一个）、清空讲解存档（点两次才清）
  function explainModelRow() {
    const sel = h('select', { class: 'pg-input', style: 'flex:1' });
    sel.append(h('option', { value: '', text: '跟聊天用同一个' }));
    for (const m of S.info?.brain?.models || []) sel.append(h('option', { value: `${m.provider}/${m.id}`, text: `${m.name || m.id}（${m.provider}）` }));
    sel.value = S.values['explain.model'] || '';
    sel.addEventListener('change', () => save('explain.model', sel.value, `画图用的模型 · ${sel.value || '跟聊天同一个'}`));
    return row('画图用的模型', sel);
  }
  function explainClearRow() {
    let armed = false;
    const b = h('button', { class: 'btn ghost sm', text: '清空' });
    b.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        b.textContent = '再点一次确认清空';
        setTimeout(() => {
          armed = false;
          b.textContent = '清空';
        }, 4000);
        return;
      }
      B().send({ type: 'explain_clear' });
      b.textContent = '已清空';
      b.disabled = true;
    });
    return row('讲解存档', h('span', { class: 'hint', text: '画过的讲解和教学小结存在 data\\explainers' }), h('span', { class: 'r' }, b));
  }

  // 鉴定存档：对话里的鉴定卡（文字 + 小缩略图，存在 data\appraisals）
  function appraiseClearRow() {
    let armed = false;
    const info = h('span', { class: 'hint', text: '对话里的鉴定卡和小缩略图存在 data\\appraisals（只在本地）' });
    const b = h('button', { class: 'btn ghost sm', text: '清空' });
    request({ type: 'appraise_info' }).then((r) => r && (info.textContent = `${r.count} 张鉴定卡和小缩略图，存在 data\\appraisals（只在本地）`));
    b.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        b.textContent = '再点一次确认清空';
        setTimeout(() => {
          armed = false;
          b.textContent = '清空';
        }, 4000);
        return;
      }
      await request({ type: 'appraise_clear' });
      b.textContent = '已清空';
      b.disabled = true;
      info.textContent = '没有鉴定存档';
    });
    return row('鉴定存档', info, h('span', { class: 'r' }, b));
  }

  const k10 = (v) => `${Math.round(v / 10000)} 万`;
  const SUBS = {
    ear: ['听觉', () => [
      head('唤醒'), wakeWords(),
      slider('voice.kwsThreshold', '唤醒灵敏度', { min: 0.05, max: 0.6, step: 0.01, fmt: (v) => (+v).toFixed(2), badge: '自动重启耳朵', hint: '越小越容易叫醒，也越容易误唤醒' }),
      wakeTest(), micRow(),
      head('说话'),
      slider('voice.endSilence', '说完等待', { min: 0.4, max: 2, step: 0.1, fmt: (v) => `${(+v).toFixed(1)} 秒`, badge: '自动重启耳朵' }),
      slider('voice.listenTimeoutMs', '叫醒后等多久', { min: 3000, max: 20000, step: 1000, fmt: (v) => `${v / 1000} 秒` }),
      toggle('conversation.enabled', '连续对话', '叫醒一次后接着听，不用每句都喊唤醒词'),
      slider('conversation.windowMs', '多久没说话收起', { min: 10000, max: 120000, step: 5000, fmt: (v) => `${v / 1000} 秒` }),
      toggle('conversation.filter', '忽略闲聊', '醒着时听到不是对系统说的话就不理'),
    ]],
    voice: ['声音', () => [
      head('发声'),
      chips('speech.mode', '用什么发声', [['gpu', '显卡'], ['cpu', 'CPU'], ['off', '静音']]),
      row('试听', h('button', { class: 'btn ghost sm', text: '念一句', onclick: () => B().send({ type: 'speak', text: '系统音频测试：发声模块正常。' }) })),
      slider('speech.fx', '电子音效', { min: 0, max: 1, step: 0.05, fmt: (v) => (+v).toFixed(2) }),
      slider('speech.volume', '音量', { min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` }),
      slider('speech.maxChars', '最多念几个字', { min: 20, max: 300, step: 10, fmt: (v) => `${v} 字`, hint: '后面的只显示，末尾念一句「详情见面板」' }),
      toggle('speech.headphones', '戴耳机', '系统说话时也照样听你说话（外放时别开）'),
    ]],
    brain: ['大脑', () => brainPage()],
    hand: ['操作', () => [
      head('软件界面'),
      toggle('computerUse.enabled', '操作软件', '读软件界面、在后台点击和输入', '重新加载大脑'),
      row('引擎', h('span', { class: 'eng' }, h('i', { class: 'dot' + (S.info?.engines?.cua ? '' : ' off') }), `Cua Driver${S.info?.engines?.cua ? '' : '（没装）'}`), h('span', { class: 'eng' }, h('i', { class: 'dot' + (S.info?.engines?.ocu ? '' : ' off') }), `Open Computer Use${S.info?.engines?.ocu ? '' : '（没装）'}`)),
      head('网页'),
      toggle('browser.enabled', '操作网页', '用系统专用的 Chrome（登录状态单独保存）', '重新加载大脑'),
      toggle('browser.headed', '显示浏览器窗口', '关掉就在后台开网页，看不见'),
      row('专用 Chrome', h('span', { class: 'hint', text: '碰不到你日常 Chrome 里的账号' }), h('span', { class: 'r' }, h('button', { class: 'btn ghost sm', text: '打开配置目录', onclick: () => B().openPath('browser-profile') }))),
      head('效果'),
      toggle('fx.cursor', '系统光标', '关掉后点击不等光标飞过去，更快'),
      toggle('fx.notice', '完成通知', '干完活屏幕中央弹全屏通知'),
      head('讲解'),
      toggle('explain.selfCheck', '画完自检', '画完截图让模型看一眼有没有画歪、字挤在一起（每页多一次看图请求）'),
      explainModelRow(),
      explainClearRow(),
      appraiseClearRow(),
    ]],
    safe: ['安全中心', () => [
      head('这些操作一定先问你（不能关）'),
      h('div', { class: 'lockline', text: '删除、移动、改名、覆盖文件；改工作目录以外的文件' }),
      h('div', { class: 'lockline', text: '结束程序、关机重启、改注册表和系统设置、以管理员身份运行' }),
      h('div', { class: 'lockline', text: '安装卸载软件、联网下载、运行脚本、git push 这类危险操作' }),
      h('div', { class: 'lockline', text: '点「删除」「发送」「发布」「付款」这类按钮，在聊天软件里按回车' }),
      head('禁止操作的软件'), blockedApps(),
      head('授权'),
      toggle('voiceConfirm', '能用嘴回答', '说「授权」「拒绝」'),
      row('没人回应', h('span', { class: 'hint', text: '90 秒后当作拒绝' })),
    ]],
    live: ['直播模式', () => [
      (() => {
        const t = h('span', { class: 'tog' + (S.snap?.live ? ' on' : '') });
        t.addEventListener('click', async () => {
          const v = !t.classList.contains('on');
          if (await save('live', v, `直播模式 · ${v ? '开' : '关'}`)) {
            t.classList.toggle('on', v);
            S.snap.live = v;
          }
        });
        return row('直播模式', h('span', { class: 'r' }, t));
      })(),
      head('打开后'),
      note('关掉语音唤醒和连续对话（按住说话还能用）'),
      note('面板顶上显示「直播模式」标记'),
      note('干完活只在角落弹小提示，不弹全屏通知'),
      head('自动检测'),
      toggle('watch.live', '自动开关', 'OBS 开始推流、或者下面的直播软件开着，就自动开直播模式；停了自动关'),
      liveApps(),
    ]],
    keys: ['快捷键', () => [
      hotkey('hotkeys.wake', '叫醒系统'),
      hotkey('hotkeys.stop', '停止当前任务'),
      hotkey('hotkeys.appraise', '鉴定（框选屏幕上的东西）'),
      pttRow(),
      note('全局快捷键要带 Ctrl / Alt / Shift；按 Esc 取消。跟别的软件冲突会提示。'),
    ]],
    look: ['外观', () => [
      slider('ui.panelOpacity', '面板不透明度', { min: 0.3, max: 1, step: 0.02, fmt: (v) => `${Math.round(v * 100)}%` }),
      slider('ui.petSize', '核心大小', { min: 44, max: 200, step: 2, fmt: (v) => `${v}` }),
      row('面板大小', h('span', { class: 'hint', text: '拖面板的角也能改' }), h('span', { class: 'r' }, h('button', { class: 'btn ghost sm', text: '恢复默认', onclick: () => window.App.resetSize() }))),
      toggle('ui.sound', '提示音', '唤醒、完成、需要授权时叮一声'),
      toggle('ui.boot', '开机自检动画', '每次启动先放一遍自检'),
    ]],
    about: ['关于', () => aboutPage()],
  };

  function brainPage() {
    const b = S.info?.brain;
    const out = [];
    const lat = h('span', { class: 'val', style: 'width:auto', text: '' });
    out.push(h('div', { class: 'card', style: 'margin-bottom:8px' }, h('div', { class: 'hd' }, h('span', { class: 'dia' }), '当前模型'),
      h('div', { class: 'ct' },
        b?.model ? h('div', {}, h('b', { text: b.model.name || b.model.id }), h('span', { class: 'hint', style: 'margin-left:8px;color:var(--muted)', text: `${b.model.provider}/${b.model.id}` })) : h('div', { class: 'bad', text: '大脑没连上：没有找到能用的模型密钥' }),
        h('div', {}, '密钥：', b?.model ? h('span', { style: 'color:var(--green)', text: '已配置' }) : h('span', { style: 'color:var(--red)', text: '没配置' }), h('span', { class: 'hint', style: 'margin-left:8px;color:var(--dim)', text: '密钥本身不在这里显示和输入' })),
        h('div', {}, '延迟：', lat, ' ', h('button', { class: 'btn ghost sm', text: '测一下', onclick: async () => {
          lat.textContent = '测试中…';
          const r = await request({ type: 'ping' }, 30000);
          lat.textContent = !r ? '超时' : r.error ? r.error : `${(r.ms / 1000).toFixed(1)} 秒`;
        } })))));
    out.push(head('换模型'));
    const cur = b?.model ? `${b.model.provider}/${b.model.id}` : '';
    for (const m of b?.models || []) {
      const id = `${m.provider}/${m.id}`;
      out.push(row(m.name || m.id, h('span', { class: 'hint', text: id }), h('span', { class: 'r' }, id === cur ? h('span', { class: 'chip on', text: '使用中' }) : h('span', { class: 'chip pick', text: '切换', onclick: () => save('model', { ...S.values.model, provider: m.provider, id: m.id }, `模型 · ${m.name || m.id}`).then(refreshInfo) }))));
    }
    out.push(note('要用别的模型：在终端里运行 npm run pi，输入 /login 配好密钥，再重启系统。'));
    out.push(chips('model.thinking', '思考深度', [['off', '关'], ['low', '低'], ['medium', '中'], ['high', '高']]));
    out.push(head('对话'));
    out.push(slider('conversation.contextBudget', '记得多长', { min: 32000, max: 500000, step: 8000, fmt: k10, hint: '对话超过这么多 token 时，把前面的压缩成摘要（原文还在存盘里，系统能翻）。越大记得越细，也越慢越贵' }));
    out.push(row('换个话题', h('span', { class: 'hint', text: '清空大脑的上下文，以前的对话还能往上翻' }), h('span', { class: 'r' }, h('button', { class: 'btn ghost sm', text: '换个话题', onclick: () => {
      B().send({ type: 'new_session' });
      $p('#set-foot').textContent = '已换话题';
    } }))));
    out.push(head('长期记忆'));
    out.push(toggle('memory.enabled', '记新的记忆', '关掉就是暂停：已经记下的照样用，只是不再记新的'));
    out.push(toggle('memory.autoReview', '自动整理', '每 10 轮对话、对话压缩前，自己看看有什么该记、该改、该忘'));
    out.push(toggle('memory.embed.chat', '对话也用向量', '「翻以前的对话」按意思也能找到；以前对话的原文会发给硅基流动算向量'));
    out.push(secretRow());
    out.push(head('其他'));
    const wd = h('span', { class: 'hint', style: 'flex:1;color:#c7d6f5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: S.values.workdir, title: S.values.workdir });
    out.push(row('工作目录', wd, h('span', { class: 'r' }, h('button', { class: 'btn ghost sm', text: '选文件夹', onclick: async () => {
      const dir = await B().pickFolder();
      if (dir && (await save('workdir', dir, `工作目录 · ${dir}`))) wd.textContent = dir;
    } }))));
    const tz = h('select', { class: 'pg-input', style: 'flex:none;width:190px' });
    for (const [v, t] of [['', '跟电脑走'], ['Asia/Shanghai', '北京时间'], ['Asia/Tokyo', '东京'], ['Asia/Singapore', '新加坡'], ['Europe/London', '伦敦'], ['America/Los_Angeles', '洛杉矶'], ['America/New_York', '纽约']]) tz.append(h('option', { value: v, text: t }));
    if (S.values.timezone && ![...tz.options].some((o) => o.value === S.values.timezone)) tz.append(h('option', { value: S.values.timezone, text: S.values.timezone }));
    tz.value = S.values.timezone || '';
    tz.addEventListener('change', () => save('timezone', tz.value, `时区 · ${tz.selectedOptions[0].text}`));
    out.push(row('时区', tz));
    return out;
  }

  // 硅基流动的密钥：宿主自己粘，存进 data/secrets.json；之后只显示「已配置」，不再显示出来
  function secretRow() {
    const st = h('span', { class: 'hint', text: '查询中…' });
    const inp = h('input', { class: 'pg-input', type: 'password', placeholder: '粘贴硅基流动的 API 密钥', style: 'flex:1;min-width:160px', autocomplete: 'off' });
    const res = h('span', { class: 'hint' });
    const refresh = async () => {
      const s2 = await B().secretStatus?.();
      st.textContent = s2?.siliconflow === 'file' ? '✓ 已配置' : s2?.siliconflow === 'env' ? '✓ 用的环境变量 SILICONFLOW_API_KEY' : '没配置';
      st.style.color = s2?.siliconflow ? 'var(--green)' : 'var(--muted)';
    };
    refresh();
    const box = h('div', {},
      row('向量检索', h('span', { class: 'hint', text: '硅基流动 · BAAI/bge-m3' }), st),
      h('div', { class: 'form' }, inp,
        h('button', { class: 'btn sm', text: '保存', onclick: async () => {
          if (!inp.value.trim()) return (res.textContent = '先粘贴密钥');
          const r = await B().setSecret('siliconflow', inp.value.trim());
          inp.value = '';
          res.textContent = r?.ok ? '已保存' : r?.error || '没保存上';
          refresh();
        } }),
        h('button', { class: 'btn ghost sm', text: '测试', onclick: async () => {
          res.textContent = '测试中…';
          const r = await request({ type: 'embed_test' }, 40000);
          res.textContent = !r ? '超时了' : r.ok ? '✓ 能用' : `✗ ${r.error}`;
          res.style.color = r?.ok ? 'var(--green)' : 'var(--red)';
        } }),
        h('button', { class: 'btn ghost sm', text: '清除', onclick: async () => {
          await B().setSecret('siliconflow', '');
          res.textContent = '已清除';
          refresh();
        } }), res),
      note('密钥存在 data\\secrets.json（开源时不上传），系统不会显示出来。没配也能用，只是只按关键词搜。'));
    return box;
  }

  function aboutPage() {
    return [
      h('div', { style: 'display:flex;gap:14px;align-items:center;margin-bottom:10px' },
        h('div', { style: 'position:relative;width:46px;height:46px;flex:none' }, h('div', { class: 'core', style: 'animation:none' }, h('i'))),
        h('div', {}, h('div', { style: 'font-size:16px;font-weight:700;letter-spacing:.1em', text: 'Hostbound（宿主系统）' }), h('div', { class: 'hint', style: 'font:12px Consolas,monospace;color:var(--muted)', text: `v${S.snap?.version || '?'}` }))),
      head('用到的模块'),
      h('div', { class: 'mods' },
        ...[['pi（大脑内核）', 'MIT'], ['sherpa-onnx（耳朵、CPU 发声）', 'Apache-2.0'], ['Qwen3-TTS · faster-qwen3-tts（显卡发声）', 'Apache-2.0 · MIT'], ['Cua Driver（操作软件）', 'MIT'], ['Open Computer Use（操作软件，备用）', 'MIT'], ['agent-browser（操作网页）', 'Apache-2.0'], ['Electron · koffi · uiohook-napi', 'MIT']].flatMap(([a, b]) => [h('span', { text: a }), h('span', { text: b })])),
      head('数据'),
      note(`对话、任务记录、系统日志都存在 ${S.snap?.dataDir || 'data'}，开源时不上传。`),
      h('div', { class: 'form' },
        h('button', { class: 'btn ghost sm', text: '打开数据文件夹', onclick: () => B().openPath('data') }),
        h('button', { class: 'btn ghost sm', text: '打开配置文件', onclick: () => B().openPath('config') }),
        h('button', { class: 'btn ghost sm', text: '再看一遍新手引导', onclick: () => window.App.go('guide') })),
    ];
  }

  function buildSet() {
    const page = $p('#pg-set');
    const nav = h('div', { class: 'snav' });
    for (const [k, [label]] of Object.entries(SUBS)) nav.append(h('span', { class: (k === S.sub ? 'on' : '') + (k === 'safe' ? ' warn' : ''), 'data-s': k, text: label, onclick: () => showSub(k) }));
    page.append(h('div', { class: 'set-wrap' }, nav, h('div', { class: 'sbody' }, h('div', { class: 'pscroll', id: 'set-body' }), h('div', { class: 'sfoot', id: 'set-foot' }))));
    S.built = true;
  }
  function showSub(k) {
    if (k !== 'ear') stopTest();
    S.sub = k;
    document.querySelectorAll('#pg-set .snav span').forEach((s) => s.classList.toggle('on', s.dataset.s === k));
    $p('#set-foot').textContent = '';
    renderSub();
    window.App.tone(k === 'safe' ? 'warn' : '');
  }
  function renderSub() {
    const body = $p('#set-body');
    const top = body.scrollTop;
    body.innerHTML = '';
    body.append(...SUBS[S.sub][1]().filter(Boolean));
    body.scrollTop = top;
  }
  async function refreshInfo() {
    S.info = await request({ type: 'info_query' }, 20000);
    if (current === 'set' && (S.sub === 'brain' || S.sub === 'ear' || S.sub === 'hand')) renderSub();
  }
  async function loadSet(sub) {
    S.snap = await B().settings();
    S.values = S.snap.values;
    S.defaults = S.snap.defaults;
    S.values['speech.mode'] = S.snap.speechMode;
    if (sub && SUBS[sub]) S.sub = sub;
    showSub(S.sub);
    refreshInfo();
  }

  // =================== 新手引导 ===================
  const G = { step: 0, heard: false };
  function buildGuide() {
    $p('#pg-guide').append(h('div', { class: 'ob-steps', id: 'ob-steps' }), h('div', { class: 'ob-body', id: 'ob-body' }), h('div', { class: 'ob-foot', id: 'ob-foot' }));
  }
  const EXAMPLES = ['现在几点', '打开计算器，算一下七加八', '看看我屏幕上这是什么'];
  async function renderGuide() {
    const steps = ['① 连接大脑', '② 试麦克风', '③ 试一个任务'];
    const st = $p('#ob-steps');
    st.innerHTML = '';
    steps.forEach((s, i) => st.append(h('span', { class: i < G.step ? 'done' : i === G.step ? 'on' : '', text: s })));
    const body = $p('#ob-body');
    const foot = $p('#ob-foot');
    body.innerHTML = '';
    foot.innerHTML = '';
    const { brainState, voiceState } = window.App.state();
    if (G.step === 0) {
      body.append(h('div', { class: 'big', text: '连接大脑' }));
      if (brainState.ok) body.append(h('div', { class: 'ok', text: `✓ 已连接：${brainState.message}` }), h('div', { text: '模型密钥已经配好。系统自己从不看、也不碰密钥。' }));
      else body.append(h('div', { class: 'bad', text: '✗ 还没连上：没有找到能用的模型密钥' }), h('div', {}, '在项目文件夹打开终端，运行 ', h('code', { text: 'npm run pi' }), '，输入 ', h('code', { text: '/login' }), ' 选模型服务商、填好密钥，然后从托盘菜单「重启系统」。'));
    } else if (G.step === 1) {
      body.append(h('div', { class: 'big', text: '试麦克风和唤醒词' }));
      if (!voiceState.ok) body.append(h('div', { class: 'bad', text: `✗ 听觉模块没起来：${voiceState.message || ''}` }), h('div', { text: '可以先跳过，打字也能用。' }));
      else {
        body.append(h('div', {}, `麦克风：${voiceState.message}`), h('div', {}, '对着麦克风说「', h('b', { style: 'color:var(--cyan)', text: (window.App.cfg().wakeWords || ['系统启动'])[0] }), '」'),
          h('div', { id: 'ob-hit', class: G.heard ? 'ok' : '', text: G.heard ? '✓ 听到了' : '等你说…' }));
        B().send({ type: 'wake_test', on: true });
        testing = true;
      }
      foot.append(h('button', { class: 'btn ghost sm', text: '叫不醒？调灵敏度', onclick: () => window.App.go('set', 'ear') }));
    } else {
      body.append(h('div', { class: 'big', text: '试一个任务' }), h('div', { text: '点一个试试，系统会在对话页里做给你看：' }),
        h('div', { class: 'ob-ex' }, EXAMPLES.map((t) => h('button', { class: 'btn ghost', text: `「${t}」`, onclick: () => finishGuide(t) }))));
    }
    if (G.step < 2) foot.append(h('button', { class: 'btn', text: '下一步', onclick: () => ((G.step += 1), stopTest(), renderGuide()) }));
    foot.append(h('button', { class: 'btn ghost sm', text: '跳过引导', onclick: () => finishGuide() }));
  }
  function finishGuide(prompt) {
    stopTest();
    B().onboarded();
    G.step = 0;
    if (prompt) window.App.sendPrompt(prompt);
    else window.App.go('chat');
  }

  // =================== 翻页 ===================
  let current = 'chat';
  function show(page, sub) {
    if (current === 'guide' && page !== 'guide') stopTest();
    if (current === 'set' && page !== 'set') stopTest();
    current = page;
    if (page === 'mem') {
      if (!M.built) buildMem();
      loadMem();
    } else if (page === 'skill') {
      if (!K.built) buildSkill();
      loadSkill();
    } else if (page === 'task') {
      if (!T.built) buildTask();
      renderTask();
      request({ type: 'tasks_query' });
    } else if (page === 'rec') {
      if (!rec.built) buildRec();
      loadRec();
    } else if (page === 'log') {
      if (!lg.built) buildLog();
      lg.day = null;
      loadLog();
    } else if (page === 'set') {
      if (!S.built) buildSet();
      loadSet(sub);
    } else if (page === 'guide') {
      if (!$p('#ob-steps')) buildGuide();
      renderGuide();
    }
  }

  // 后台来的消息：请求的回复、实时日志、唤醒测试。返回 true 表示这边处理完了
  function onBrain(m) {
    if (m.reqId && waiting.has(m.reqId)) {
      waiting.get(m.reqId)(m);
      waiting.delete(m.reqId);
      if (m.type === 'tasks') {
        setTimeout(() => current === 'task' && renderTask(), 0);
        return false;
      }
      return true;
    }
    switch (m.type) {
      case 'log_entry':
        onLogEntry(m.entry);
        return true;
      case 'tasks':
        setTimeout(() => current === 'task' && renderTask(), 0);
        return false; // app.js 也要（核心下面的倒计时）
      case 'memory_status':
        if (M.data) M.data.status = m.status;
        if (current === 'mem') {
          renderMemFoot(m.status);
          clearTimeout(M.reload);
          M.reload = setTimeout(loadMem, 400);
        }
        return true;
      case 'skills_changed':
      case 'skill_pending':
      case 'skill_resolved':
        if (current === 'skill') {
          clearTimeout(K.reload);
          K.reload = setTimeout(loadSkill, 300);
        }
        return m.type === 'skills_changed';
      case 'wake_test_hit': {
        const el = $p('#test-hit');
        if (el) el.textContent = `✓ 听到了「${m.keyword}」 ${hms(Date.now())}`;
        if (current === 'guide' && G.step === 1) {
          G.heard = true;
          const hit = $p('#ob-hit');
          if (hit) {
            hit.className = 'ok';
            hit.textContent = `✓ 听到了「${m.keyword}」`;
          }
        }
        return true;
      }
      case 'config_error': {
        const foot = $p('#set-foot');
        if (foot) {
          foot.className = 'sfoot err';
          foot.textContent = `设置没生效：${m.message}`;
        }
        return true;
      }
      case 'config_applied':
        if (current === 'set' && (m.key === 'model' || m.key === 'voice.mic' || m.key.startsWith('computerUse') || m.key.startsWith('browser'))) refreshInfo();
        return true;
      case 'done':
      case 'error':
      case 'stopped':
        if (current === 'rec') setTimeout(loadRec, 300);
        return false;
    }
    return false;
  }

  window.Pages = { show, onBrain, request, tick: tickTask, showChange, showSkill, get current() { return current; } };
})();
