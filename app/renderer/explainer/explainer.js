// 讲解窗口的页面：把大脑交来的积木拼成一页（结论、主图、分步、比方、表格、时间线、数据图、模拟、截图）。
// - 边念边指：念到哪一步，分步卡片和图上对应的节点一起亮
// - 点哪问哪：点图上的一块展开成新的一页；在图上框住几块、或者选中一段字，弹出「这里没看懂 / 换个说法 / 举个例子」
// - 浏览器里单独打开（导出的那一页）时没有桥，只显示内容
(() => {
  const bridge = window.xw || null;
  const BASE = new URL('.', document.currentScript.src).href;
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const pad2 = (n) => String(n).padStart(2, '0');

  const S = { page: null, version: 'plain', total: 0, assets: '', narr: null, typing: null, mseq: 0, sims: new Map(), pinned: false };

  // ---------- 骨架 ----------
  $('#app').innerHTML = `
    <div class="dragbar"></div>
    <section class="fr"><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>
      <div class="plate"><span class="wing l"></span><span class="p">系统讲解</span><span class="wing r"></span></div>
      <span class="code" id="code">EXPLAIN</span>
      <div class="body">
        <div class="xbar">
          <span class="t" id="title">系统讲解</span>
          <span class="crumb" id="crumb"></span>
          <span class="tm" id="time"></span>
          <span class="r">
            <span class="seg" id="depth" title="切换讲的深浅（会按另一种深浅重写这一页，两个版本都留着）"><span data-v="plain" class="on">说人话</span><span data-v="pro">专业</span></span>
            <button class="ib" id="prev" title="上一页">◂</button><span class="pg" id="pg">– / –</span><button class="ib" id="next" title="下一页">▸</button>
            <button class="ib" id="pin" title="钉在最上面">钉住</button>
            <button class="ib" id="browser" title="用默认浏览器打开这一页">浏览器打开</button>
            <button class="ib" id="min" title="最小化">—</button>
            <button class="ib x" id="close" title="关闭">×</button>
          </span>
        </div>
        <div class="xdoc" id="doc"><div class="empty">还没有讲解。跟系统说「画图给我讲讲……」试试。</div></div>
        <div class="narr" id="narr">
          <button class="ib" id="play" title="播放 / 暂停">▶</button><button class="ib" id="nprev">上一步</button><button class="ib" id="nnext">下一步</button><button class="ib" id="redo">重讲</button>
          <span class="sub" id="sub"></span><span class="st" id="st"></span>
        </div>
        <form class="ask" id="ask"><div class="field"><input id="q" placeholder="对这一页接着问……（也可以直接说）" autocomplete="off" spellcheck="false"></div><button class="btn" type="submit">发送</button></form>
      </div>
    </section>
    <div class="selbub hidden" id="selbub"><span data-how="unclear">这里没看懂</span><span data-how="rephrase">换个说法</span><span data-how="example">举个例子</span></div>
    <div class="toast-x" id="toast"></div>`;
  const doc = $('#doc');
  const send = (m) => bridge?.send(m);
  let toastT = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.style.top = doc.getBoundingClientRect().top + 10 + 'px';
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 2400);
  }

  // ---------- Mermaid：深色、系统配色；strict 模式（图里的文字不当 HTML，不能挂点击脚本） ----------
  const MM = typeof window.mermaid !== 'undefined' ? window.mermaid : null;
  MM?.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif',
    themeVariables: {
      darkMode: true, background: 'transparent', fontSize: '15px',
      primaryColor: '#101c46', primaryTextColor: '#e9f4ff', primaryBorderColor: '#5fe6ff',
      secondaryColor: '#1d1446', secondaryTextColor: '#e9f4ff', secondaryBorderColor: '#b15bff',
      tertiaryColor: '#0b1438', tertiaryTextColor: '#e9f4ff', tertiaryBorderColor: '#4f7bff',
      lineColor: '#5fe6ff', textColor: '#e9f4ff', mainBkg: '#101c46', nodeBorder: '#5fe6ff', nodeTextColor: '#e9f4ff',
      clusterBkg: 'rgba(95,230,255,0.05)', clusterBorder: '#4f7bff', edgeLabelBackground: '#0b1438', titleColor: '#5fe6ff',
      actorBkg: '#101c46', actorBorder: '#5fe6ff', actorTextColor: '#e9f4ff', actorLineColor: '#5d6f96', signalColor: '#5fe6ff', signalTextColor: '#e9f4ff',
      labelBoxBkgColor: '#1d1446', labelBoxBorderColor: '#b15bff', labelTextColor: '#e9f4ff', loopTextColor: '#e9f4ff',
      noteBkgColor: '#1d1446', noteTextColor: '#e9f4ff', noteBorderColor: '#b15bff', activationBkgColor: '#1d1446', activationBorderColor: '#b15bff', sequenceNumberColor: '#050817',
    },
    flowchart: { curve: 'basis', padding: 12, useMaxWidth: true },
    sequence: { useMaxWidth: true, mirrorActors: false },
  });

  // ---------- 积木 ----------
  const TITLES = { diagram: '一张图看全程', steps: '分步讲', analogy: '打个比方', table: '对比', timeline: '时间线', bars: '比一比', sim: '动手试试', text: '说明', shot: '截图' };
  function heading(b, small) {
    return h('h3', {}, b.title || TITLES[b.kind] || '', small ? h('small', { text: small }) : null);
  }
  function renderBlock(b) {
    const wrap = h('div', { class: `blk k-${b.kind}`, 'data-block': b.id, 'data-kind': b.kind });
    switch (b.kind) {
      case 'summary':
        wrap.append(h('div', { class: 'tldr' }, h('b', { text: '【结论】' }), b.text));
        break;
      case 'diagram': {
        const box = h('div', { class: 'fig' }, h('div', { class: 'wait', text: '正在画图…' }));
        wrap.append(heading(b, bridge ? '点任意一块，展开成新的一页；按住拖动可以框选几块' : ''), box);
        renderDiagram(b, box);
        break;
      }
      case 'steps': {
        const grid = h('div', { class: 'five' });
        b.items.forEach((it, k) => grid.append(h('div', { 'data-k': k, title: bridge ? '点一下，从这一步讲' : null, onclick: () => gotoStep(b.id, k) }, h('b', {}, h('span', { text: pad2(k + 1) }), it.title), it.text)));
        wrap.append(heading(b), grid);
        break;
      }
      case 'analogy':
        wrap.append(heading(b), h('div', { class: 'analogy', text: b.text }));
        break;
      case 'text':
        wrap.append(heading(b), h('p', { text: b.text }));
        break;
      case 'table': {
        const t = h('table', { class: 'tbl' });
        b.rows.forEach((row, i) => t.append(h('tr', {}, row.map((c) => h(i === 0 ? 'th' : 'td', { text: c })))));
        wrap.append(heading(b), t);
        break;
      }
      case 'timeline':
        wrap.append(heading(b), h('div', { class: 'tl' }, b.items.map((it) => h('div', {}, h('b', { text: it.label }), it.text))));
        break;
      case 'bars': {
        const max = Math.max(...b.items.map((x) => Math.abs(x.value)), 1e-9);
        wrap.append(heading(b, b.unit ? `单位：${b.unit}` : ''), h('div', { class: 'bars' }, b.items.map((x) => h('div', {}, h('span', { class: 'lb', text: x.label, title: x.label }), h('span', { class: 'tr' }, h('i', { style: `width:${Math.max(1.5, (Math.abs(x.value) / max) * 100)}%` })), h('span', { class: 'v', text: String(x.value) })))));
        break;
      }
      case 'sim': {
        const f = h('iframe', { sandbox: 'allow-scripts', src: BASE + 'sim.html', title: b.title || '模拟', loading: 'eager' });
        S.sims.set(f, b.html);
        wrap.append(heading(b, '拖一拖、点一点，看会怎么变'), h('div', { class: 'sim' }, f));
        break;
      }
      case 'shot':
        wrap.append(heading(b), h('div', { class: 'shot' }, h('figure', {}, h('img', { src: S.assets + b.src, alt: b.title || '截图' }), b.text ? h('figcaption', { text: b.text }) : null)));
        break;
    }
    return wrap;
  }
  // 模拟：sim.html 准备好了再把内容递进去
  addEventListener('message', (e) => {
    if (!e.data?.simReady) return;
    for (const [f, html] of S.sims) {
      if (!f.isConnected) S.sims.delete(f);
      else if (f.contentWindow === e.source) f.contentWindow.postMessage({ html }, '*');
    }
  });

  async function renderDiagram(b, box) {
    const page = S.page?.id;
    const version = S.version;
    const id = `mm${++S.mseq}`;
    try {
      if (!MM) throw new Error('Mermaid 没加载上');
      await MM.parse(b.mermaid);
      const { svg } = await MM.render(id, b.mermaid);
      if (!box.isConnected) return report(page, version, b.id, true);
      box.innerHTML = svg;
      fitSvg(box);
      markNodes(box);
      report(page, version, b.id, true);
    } catch (e) {
      document.getElementById('d' + id)?.remove();
      document.getElementById(id)?.remove();
      box.innerHTML = '';
      box.append(h('div', { class: 'err', text: bridge ? '这张图没画出来，正在重画…' : '这张图没画出来' }));
      report(page, version, b.id, false, String(e?.message || e).replace(/\s+/g, ' ').slice(0, 400));
    }
  }
  function report(page, version, block, ok, error) {
    if (page) send({ op: 'render', page, version, block, ok, error });
  }
  // 图的大小：宽了缩小（最多缩到 72%，再宽就横着滚动），小图最多放大到 110%；
  // 太高的图尽量压到内容区的六成（边念边指时图和分步卡片能同屏），但最多只缩到 85%，字得看得清
  function fitSvg(box) {
    const svg = box.querySelector('svg');
    const vb = svg?.viewBox?.baseVal;
    if (!vb?.width) return;
    let k = Math.min(1.1, Math.max((box.clientWidth - 14) / vb.width, 0.72));
    const maxH = Math.max(240, doc.clientHeight * 0.6);
    if (vb.height * k > maxH) k = Math.min(k, Math.max(0.85, maxH / vb.height));
    svg.style.maxWidth = 'none';
    svg.setAttribute('width', Math.round(vb.width * k));
    svg.setAttribute('height', Math.round(vb.height * k));
  }
  let fitT = null;
  addEventListener('resize', () => {
    clearTimeout(fitT);
    fitT = setTimeout(() => doc.querySelectorAll('.fig').forEach(fitSvg), 150);
  });
  // 给图上的节点标上 id：流程图 g.node（id 形如 mm3-flowchart-mic-0），时序图的参与者（rect.actor 的 name）
  function markNodes(box) {
    for (const g of box.querySelectorAll('g.node')) {
      const id = g.dataset.id || (g.id || '').match(/(?:flowchart|state|classId)-(.+)-\d+$/)?.[1];
      if (!id) continue;
      g.classList.add('xnode');
      g.dataset.node = id;
    }
    // 时序图的每一条消息（文字和箭头）：#1、#2……（Note 不算）
    const texts = [...box.querySelectorAll('text.messageText')];
    const lines = [...box.querySelectorAll('.messageLine0, .messageLine1')];
    texts.forEach((t, i) => {
      for (const el of [t, lines[i]]) {
        if (!el) continue;
        el.classList.add('xmsg');
        el.dataset.node = `#${i + 1}`;
      }
    });
    for (const r of box.querySelectorAll('rect.actor[name]')) {
      const g = r.parentElement;
      if (!g || g.classList.contains('xnode')) continue;
      g.classList.add('xnode');
      g.dataset.node = r.getAttribute('name');
    }
  }
  const labelOf = (g) => (g.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) || g.dataset.node;

  // ---------- 一页 ----------
  function blocksOf(page, version) {
    return page?.versions?.[version]?.blocks || [];
  }
  function doneOf(page, version) {
    const v = page?.versions?.[version];
    return v ? !!v.done : !!page?.done;
  }
  function fmtTime(t) {
    const d = new Date(t);
    return `${d.getMonth() + 1}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function header() {
    const p = S.page;
    if (!p) return;
    $('#title').textContent = p.title;
    $('#title').title = p.title;
    document.title = `${p.title} · 系统讲解`;
    $('#time').textContent = p.at ? fmtTime(p.at) : '';
    const crumb = $('#crumb');
    crumb.innerHTML = '';
    if (p.crumb?.length) {
      for (const c of p.crumb) crumb.append(h('a', { text: c.title, onclick: () => send({ op: 'get', page: c.id }) }), ' › ');
      crumb.append(h('b', { text: p.title, style: 'color:var(--cyan);font-weight:400' }));
    }
    $('#pg').textContent = p.no ? `${p.no} / ${S.total || p.total || p.no}` : '– / –';
    $('#prev').disabled = !p.no || p.no <= 1;
    $('#next').disabled = !p.no || p.no >= (S.total || p.total || 0);
    $('#code').textContent = `${p.kind === 'tutor' ? 'TUTOR' : 'EXPLAIN'} · ${pad2(p.no || 0)}/${pad2(S.total || p.total || 0)}`;
    for (const x of $('#depth').children) x.classList.toggle('on', x.dataset.v === S.version);
    $('#depth').classList.toggle('hidden', p.kind === 'tutor');
  }
  function pendingEl() {
    return h('div', { class: 'pending', id: 'pending' }, h('i'), '正在绘制下一块…');
  }
  function endEl() {
    return h('p', { class: 'endnote', id: 'endnote', text: `—— 第 ${S.page?.no || ''} 页完${bridge && S.page?.no > 1 ? ' · ◂ 翻到上一页' : ''} ——` });
  }
  function showPage(page, version) {
    S.page = page;
    S.version = version || page.depth || 'plain';
    S.sims.clear();
    header();
    doc.innerHTML = '';
    const blocks = blocksOf(page, S.version);
    for (const b of blocks) doc.append(renderBlock(b));
    if (!doneOf(page, S.version)) doc.append(pendingEl());
    else if (blocks.length) doc.append(endEl());
    else doc.append(h('div', { class: 'empty', text: '这一页还是空的。' }));
    doc.scrollTop = 0;
    applyNarr();
  }
  function addBlock(m) {
    if (!S.page || m.page !== S.page.id || m.version !== S.version) {
      // 不在眼前的页：图也验一下能不能画，免得大脑一直等
      if (m.block.kind === 'diagram' && MM) MM.parse(m.block.mermaid).then(() => report(m.page, m.version, m.block.id, true), (e) => report(m.page, m.version, m.block.id, false, String(e?.message || e).slice(0, 400)));
      return;
    }
    const v = (S.page.versions[S.version] ||= { blocks: [], done: false });
    const el = renderBlock(m.block);
    const old = doc.querySelector(`[data-block="${m.block.id}"]`);
    if (m.replace && old) {
      el.classList.add('swap');
      old.replaceWith(el);
      v.blocks[v.blocks.findIndex((b) => b.id === m.block.id)] = m.block;
    } else {
      $('.empty', doc)?.remove();
      const pend = $('#pending');
      if (pend) doc.insertBefore(el, pend);
      else doc.append(el);
      v.blocks.push(m.block);
      if (!pend && !doneOf(S.page, S.version)) doc.append(pendingEl());
    }
    applyNarr();
  }

  // ---------- 边念边指 ----------
  function narrIndex(blockId, k) {
    const blocks = blocksOf(S.page, S.version);
    let i = blocks.some((b) => b.kind === 'summary') ? 1 : 0;
    for (const b of blocks) {
      if (b.kind !== 'steps') continue;
      if (b.id === blockId) return i + k;
      i += b.items.length;
    }
    return i;
  }
  function gotoStep(blockId, k) {
    if (!S.page) return;
    send({ op: 'narr', cmd: 'goto', i: narrIndex(blockId, k), page: S.page.id, version: S.version });
  }
  function typeSub(text, full) {
    clearInterval(S.typing);
    const sub = $('#sub');
    if (full) {
      sub.textContent = text;
      return;
    }
    let n = 0;
    const tick = () => {
      n = Math.min(text.length, n + 1);
      sub.textContent = text.slice(0, n);
      if (n < text.length) sub.append(h('span', { class: 'caret' }));
      else clearInterval(S.typing);
    };
    tick();
    S.typing = setInterval(tick, 150);
  }
  function applyNarr() {
    const st = S.narr;
    for (const el of doc.querySelectorAll('.hl')) el.classList.remove('hl');
    const mine = st && S.page && st.page === S.page.id && st.version === S.version;
    $('#play').textContent = mine && st.status === 'playing' ? '⏸' : '▶';
    if (!mine) {
      $('#st').textContent = '';
      if (!st || st.page !== S.page?.id) $('#sub').textContent = S.page ? '按 ▶ 从头讲这一页' : '';
      return;
    }
    $('#st').textContent = st.status === 'done' ? '讲完了' : st.step ? `第 ${st.stepNo} / ${st.steps} 步` : st.title === '结论' ? '结论' : '';
    if (!st.step) return;
    const card = doc.querySelector(`[data-block="${st.step.block}"] .five > div[data-k="${st.step.index}"]`);
    card?.classList.add('hl');
    let lit = null;
    for (const id of st.step.nodes || []) {
      for (const g of doc.querySelectorAll('.xnode, .xmsg')) {
        if (g.dataset.node === id) {
          g.classList.add('hl');
          lit ||= g;
        }
      }
    }
    if (st.status === 'playing') (lit || card)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
  function onNarr(st) {
    const prev = S.narr;
    S.narr = st;
    const mine = S.page && st.page === S.page.id && st.version === S.version;
    if (mine && (st.i !== prev?.i || st.status !== prev?.status || st.page !== prev?.page)) typeSub(st.say || '', st.full || st.status !== 'playing');
    if (mine && st.status === 'done') typeSub('讲解完毕。可以接着问，或者点图上任意一块展开。', true);
    applyNarr();
  }
  const narr = (cmd) => S.page && send({ op: 'narr', cmd, page: S.page.id, version: S.version });
  $('#play').onclick = () => narr('play');
  $('#nprev').onclick = () => narr('prev');
  $('#nnext').onclick = () => narr('next');
  $('#redo').onclick = () => narr('redo');

  // ---------- 顶栏 ----------
  $('#prev').onclick = () => S.page?.no > 1 && send({ op: 'get', no: S.page.no - 1 });
  $('#next').onclick = () => S.page?.no && send({ op: 'get', no: S.page.no + 1 });
  $('#pin').onclick = () => {
    S.pinned = !S.pinned;
    $('#pin').classList.toggle('on', S.pinned);
    $('#pin').textContent = S.pinned ? '已钉住' : '钉住';
    send({ op: 'pin', on: S.pinned });
  };
  $('#browser').onclick = () => S.page && send({ op: 'browser', page: S.page, version: S.version });
  $('#min').onclick = () => send({ op: 'minimize' });
  $('#close').onclick = () => send({ op: 'close' });
  $('#depth').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    if (!v || !S.page || v === S.version) return;
    for (const x of $('#depth').children) x.classList.toggle('on', x === e.target);
    if (!blocksOf(S.page, v).length) {
      S.version = v;
      doc.innerHTML = '';
      doc.append(h('div', { class: 'pending', id: 'pending' }, h('i'), `正在按「${v === 'pro' ? '专业' : '说人话'}」重写这一页…`));
    }
    send({ op: 'depth', page: S.page.id, depth: v });
  });
  $('#ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (!q || !S.page) return;
    $('#q').value = '';
    send({ op: 'ask', page: S.page.id, text: q });
    toast('已发给系统，回答会是新的一页');
  });

  // ---------- 点哪问哪、圈哪问哪 ----------
  const bub = $('#selbub');
  let pick = null; // { kind: 'text' | 'nodes', text, labels }
  function showBub(x, y, p) {
    pick = p;
    bub.classList.remove('hidden');
    const w = bub.offsetWidth;
    bub.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
    bub.style.top = Math.max(8, y - 40) + 'px';
  }
  function hideBub() {
    bub.classList.add('hidden');
    pick = null;
  }
  bub.addEventListener('mousedown', (e) => e.preventDefault());
  bub.addEventListener('click', (e) => {
    const how = e.target.dataset.how;
    if (!how || !pick || !S.page) return;
    const text = pick.kind === 'nodes' ? `图上的「${pick.labels.join('」「')}」` : pick.text;
    send({ op: 'ask_sel', page: S.page.id, text, how });
    toast('已发给系统，回答会是新的一页');
    getSelection()?.removeAllRanges();
    hideBub();
  });
  doc.addEventListener('scroll', hideBub);

  // 框选：在图上按住拖
  let drag = null;
  doc.addEventListener('mousedown', (e) => {
    if (!bridge || e.button !== 0) return;
    if (!bub.contains(e.target)) hideBub();
    const fig = e.target.closest('.fig');
    if (!fig || e.target.closest('.xnode')) return;
    const r = fig.getBoundingClientRect();
    drag = { fig, x0: e.clientX, y0: e.clientY, box: null, r };
    e.preventDefault();
  });
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    const { fig, x0, y0, r } = drag;
    if (!drag.box && Math.hypot(e.clientX - x0, e.clientY - y0) < 8) return;
    if (!drag.box) {
      drag.box = h('div', { class: 'boxsel' });
      fig.append(drag.box);
    }
    const x = Math.min(x0, e.clientX), y = Math.min(y0, e.clientY);
    Object.assign(drag.box.style, { left: x - r.left + fig.scrollLeft + 'px', top: y - r.top + 'px', width: Math.abs(e.clientX - x0) + 'px', height: Math.abs(e.clientY - y0) + 'px' });
  });
  addEventListener('mouseup', (e) => {
    if (drag) {
      const d = drag;
      drag = null;
      if (!d.box) return;
      const sel = d.box.getBoundingClientRect();
      d.box.remove();
      const labels = [...d.fig.querySelectorAll('.xnode, text.xmsg')]
        .filter((g) => {
          const b = g.getBoundingClientRect();
          return b.right > sel.left && b.left < sel.right && b.bottom > sel.top && b.top < sel.bottom;
        })
        .map(labelOf);
      if (labels.length) showBub(sel.left + sel.width / 2, sel.top, { kind: 'nodes', labels: [...new Set(labels)].slice(0, 6) });
      return;
    }
    if (!bridge || bub.contains(e.target)) return;
    setTimeout(() => {
      const s = getSelection();
      const text = s?.toString().replace(/\s+/g, ' ').trim() || '';
      if (text.length < 2 || !s.rangeCount || !doc.contains(s.anchorNode)) return;
      const rr = s.getRangeAt(0).getBoundingClientRect();
      showBub(rr.left + rr.width / 2, rr.top, { kind: 'text', text: text.slice(0, 300) });
    }, 10);
  });
  // 点图上一块：展开成新的一页
  doc.addEventListener('click', (e) => {
    const g = e.target.closest('.xnode') || e.target.closest('text.xmsg');
    if (!g || !bridge || !S.page) return;
    send({ op: 'expand', page: S.page.id, labels: [labelOf(g)] });
    toast(`展开「${labelOf(g)}」→ 正在画新的一页`);
  });

  // 主进程截图自检用：把某一块滚到眼前，报告它在窗口里的位置
  window.XW = {
    rectOf(id) {
      this.unfit();
      const el = doc.querySelector(`[data-block="${CSS.escape(id)}"]`);
      if (!el) return null;
      // 比窗口高的块先整个缩进来，截到的才是完整的一块
      const room = doc.clientHeight - 12;
      if (el.offsetHeight > room) el.style.zoom = String(room / el.offsetHeight);
      el.scrollIntoView({ block: 'start' });
      const r = el.getBoundingClientRect();
      const d = doc.getBoundingClientRect();
      const top = Math.max(r.top, d.top);
      const bottom = Math.min(r.bottom, d.bottom);
      return { x: r.left, y: top, width: r.width, height: Math.max(0, bottom - top) };
    },
    unfit() {
      for (const el of doc.querySelectorAll('.blk[style*="zoom"]')) el.style.zoom = '';
    },
    scrollTop() {
      this.unfit();
      doc.scrollTop = 0;
    },
  };

  // ---------- 收消息 ----------
  if (bridge) {
    bridge.on((m) => {
      switch (m.op) {
        case 'show':
          if (m.assets) S.assets = m.assets;
          S.total = m.total || m.page?.total || 0;
          showPage(m.page, m.version);
          break;
        case 'block':
          addBlock(m);
          break;
        case 'version':
          if (S.page && m.page === S.page.id) {
            S.version = m.version;
            S.page.versions[m.version] = { blocks: [], done: false };
            header();
            doc.innerHTML = '';
            doc.append(pendingEl());
          }
          break;
        case 'done':
          if (S.page && m.page === S.page.id && m.version === S.version) {
            const v = S.page.versions[S.version];
            if (v) v.done = true;
            S.page.done = true;
            $('#pending')?.remove();
            if (!$('#endnote')) doc.append(endEl());
          }
          break;
        case 'narr':
          onNarr(m);
          break;
      }
    });
    send({ op: 'ready' });
  } else if (window.XW_PAGE) {
    document.body.classList.add('standalone');
    S.assets = window.XW_PAGE.assets || '';
    showPage(window.XW_PAGE.page, window.XW_PAGE.version);
    $('#narr').classList.add('hidden');
  }
})();
