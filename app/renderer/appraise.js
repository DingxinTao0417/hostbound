// 鉴定术的选择层 + 鉴定卡（每块屏幕一个全屏窗口，主进程是 app/appraise.cjs）。
// 阶段：select 在定格的画面上选（点窗口 / 拖框 / F 全屏）→ scan 只留框住的那块、扫描、卡片边出边显示 → result 出完；
// tags 全屏扫描，每个窗口挂一句；summary 汇总卡。坐标都是这块屏幕里的 DIP。
(() => {
  const B = window.appraiseBridge;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  };
  const frozen = $('#frozen');
  const dim = $('#dim');
  const hole = $('#hole');
  const lab = $('#lab');
  const reg = $('#reg');
  const tool = $('#tool');
  const ask = $('#t-ask');
  const hint = $('#hint');
  const frame = $('#frame');
  const card = $('#card');
  const tagsEl = $('#tags');
  const fullsweep = $('#fullsweep');
  const summary = $('#summary');

  const S = { stage: 'idle', windows: [], scale: 1, hover: null, region: null, drag: null, cardInfo: null, timer: null, hovered: false, hit: false, lastF: 0, fTimer: null };
  const show = (x, on = true) => x.classList.toggle('hidden', !on);
  const place = (x, r) => Object.assign(x.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
  const inside = (p, r) => r && p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;

  function reset() {
    clearTimeout(S.timer);
    clearTimeout(S.fTimer);
    Object.assign(S, { hover: null, region: null, drag: null, cardInfo: null, hovered: false });
    for (const x of [hole, lab, reg, tool, hint, frame, card, fullsweep, summary]) show(x, false);
    show(dim, false);
    tagsEl.innerHTML = '';
    card.innerHTML = '';
    summary.innerHTML = '';
    frozen.style.clipPath = '';
    frozen.classList.remove('on', 'fade');
    document.body.className = '';
    ask.value = '';
    setHit(false);
  }
  function setHit(on) {
    if (S.hit === on) return;
    S.hit = on;
    B.send({ op: 'hit', on });
  }

  // =================== 选择 ===================
  const HINT_SELECT = '<b>【鉴定模式】</b>画面已定格 · 点一个窗口 · 拖一个框 · <span class="key">F</span> 整块屏幕（按两下扫描全屏）· <span class="key">Esc</span> 退出';
  const HINT_REGION = '<b>【鉴定模式】</b>拖好了：回车或双击鉴定 · 拖边角调整 · 右键重选';
  function enterSelect(m) {
    reset();
    S.stage = 'select';
    S.windows = m.windows || [];
    S.scale = m.scale || 1;
    frozen.src = m.image;
    frozen.classList.add('on');
    document.body.className = 'select';
    hint.innerHTML = HINT_SELECT;
    show(hint);
    show(dim);
  }
  // 鼠标下面最上层的窗口；没有就是整块屏幕
  function hitWindow(p) {
    const w = S.windows.find((x) => inside(p, x.rect));
    return w ? { kind: 'window', w, rect: w.rect } : { kind: 'display', rect: { x: 0, y: 0, width: W(), height: H() } };
  }
  function highlight(h) {
    S.hover = h;
    if (!h) return show(hole, false), show(lab, false), show(dim);
    show(dim, false);
    place(hole, h.rect);
    hole.className = h.kind === 'display' ? 'whole' : h.w?.blocked ? 'blocked' : '';
    show(hole);
    const px = (v) => Math.round(v * S.scale);
    lab.textContent =
      h.kind === 'display'
        ? '整块屏幕 · 点一下鉴定'
        : h.w.blocked
          ? `${h.w.title || h.w.exe} · 禁止操作的软件，不能鉴定`
          : `${h.w.title || h.w.exe}　${px(h.rect.width)} × ${px(h.rect.height)}　点一下鉴定整个窗口`;
    lab.style.left = Math.max(4, h.rect.x) + 'px';
    lab.style.top = (h.rect.y > 30 ? h.rect.y - 26 : h.rect.y + 4) + 'px';
    show(lab);
  }
  function drawRegion() {
    const r = S.region;
    place(hole, r);
    hole.className = 'region';
    show(hole);
    show(lab, false);
    place(reg, r);
    reg.querySelector('.size').textContent = `${Math.round(r.width * S.scale)} × ${Math.round(r.height * S.scale)}`;
    show(reg);
  }
  function showTool() {
    const r = S.region;
    show(tool);
    const tw = tool.offsetWidth;
    const th = tool.offsetHeight;
    let y = r.y + r.height + 8;
    if (y + th > H() - 4) y = r.y - th - 8;
    if (y < 4) y = r.y + r.height - th - 8;
    tool.style.left = Math.max(4, Math.min(W() - tw - 4, r.x + r.width - tw)) + 'px';
    tool.style.top = y + 'px';
    hint.innerHTML = HINT_REGION;
  }
  function clearRegion() {
    S.region = null;
    show(reg, false);
    show(tool, false);
    ask.value = '';
    hint.innerHTML = HINT_SELECT;
    highlight(null);
  }
  const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
  // 拖框时按在哪：四个角调整，框里面挪动，别处重新拖
  function grabOf(p) {
    const r = S.region;
    if (!r) return null;
    const near = (x, y) => Math.abs(p.x - x) < 10 && Math.abs(p.y - y) < 10;
    if (near(r.x, r.y)) return 'tl';
    if (near(r.x + r.width, r.y)) return 'tr';
    if (near(r.x, r.y + r.height)) return 'bl';
    if (near(r.x + r.width, r.y + r.height)) return 'br';
    return inside(p, r) ? 'move' : null;
  }
  function confirm() {
    if (S.stage !== 'select' || !S.region) return;
    B.send({ op: 'pick', kind: 'region', rect: S.region, question: ask.value.trim() });
  }

  document.addEventListener('mousedown', (e) => {
    if (S.stage !== 'select' || e.button !== 0 || e.target.closest('#tool')) return;
    const p = { x: e.clientX, y: e.clientY };
    const grab = grabOf(p);
    S.drag = { start: p, grab, orig: S.region && { ...S.region }, moved: false };
  });
  document.addEventListener('mousemove', (e) => {
    const p = { x: e.clientX, y: e.clientY };
    if (S.stage !== 'select') return trackHit(e);
    const d = S.drag;
    if (!d) {
      if (!S.region) highlight(hitWindow(p));
      document.body.style.cursor = S.region ? ({ tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', move: 'move' }[grabOf(p)] || 'crosshair') : 'crosshair';
      return;
    }
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 5) return;
    d.moved = true;
    show(tool, false);
    const o = d.orig;
    if (d.grab === 'move') {
      const dx = Math.max(-o.x, Math.min(W() - o.x - o.width, p.x - d.start.x));
      const dy = Math.max(-o.y, Math.min(H() - o.y - o.height, p.y - d.start.y));
      S.region = { ...o, x: o.x + dx, y: o.y + dy };
    } else if (d.grab) {
      const fixed = { x: d.grab.includes('l') ? o.x + o.width : o.x, y: d.grab.includes('t') ? o.y + o.height : o.y };
      S.region = norm(fixed, p);
    } else {
      S.region = norm(d.start, p);
    }
    drawRegion();
  });
  document.addEventListener('mouseup', (e) => {
    if (S.stage !== 'select' || e.button !== 0) return;
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (d.moved) {
      if (S.region && S.region.width >= 8 && S.region.height >= 8) return showTool();
      return clearRegion();
    }
    // 没拖：点了一下。还没框的时候 = 鉴定鼠标下的窗口（或整块屏幕）
    if (S.region) return;
    const h = hitWindow({ x: e.clientX, y: e.clientY });
    if (h.kind === 'window' && h.w.blocked) return;
    B.send(h.kind === 'window' ? { op: 'pick', kind: 'window', windowId: h.w.id } : { op: 'pick', kind: 'display' });
  });
  document.addEventListener('dblclick', (e) => {
    if (S.stage === 'select' && S.region && inside({ x: e.clientX, y: e.clientY }, S.region)) confirm();
  });
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (S.stage !== 'select') return;
    if (S.region) clearRegion();
    else B.send({ op: 'cancel' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (S.stage === 'select' && S.region && document.activeElement === ask) return ask.blur();
      return B.send({ op: S.stage === 'select' ? 'cancel' : 'close' });
    }
    if (S.stage !== 'select') return;
    if (e.key === 'Enter') return confirm();
    if (document.activeElement === ask) return;
    if (e.key === 'f' || e.key === 'F') {
      // 按一下 = 整块屏幕；600 毫秒内再按一下 = 扫描全屏
      if (Date.now() - S.lastF < 600) {
        clearTimeout(S.fTimer);
        S.lastF = 0;
        return B.send({ op: 'key', key: 'scan' });
      }
      S.lastF = Date.now();
      clearTimeout(S.fTimer);
      S.fTimer = setTimeout(() => B.send({ op: 'key', key: 'display' }), 600);
    }
  });
  $('#t-go').onclick = confirm;
  $('#t-redo').onclick = clearRegion;
  $('#t-x').onclick = () => B.send({ op: 'cancel' });

  // =================== 扫描 + 鉴定卡 ===================
  const RAR = { 普通: 'common', 精良: 'good', 稀有: 'rare', 史诗: 'epic', 传说: 'legend' };
  function enterScan(m) {
    clearTimeout(S.timer);
    S.stage = 'scan';
    S.cardInfo = { id: m.id, rect: m.rect, label: m.label || '', baseActions: m.actions || [], card: { name: '', rarity: '', tag: '', fields: [], verdict: '', advice: '', actions: [] } };
    document.body.className = 'scan';
    for (const x of [dim, hole, lab, reg, tool, hint]) show(x, false);
    // 只留框住的那一块定格画面
    const r = m.rect;
    frozen.style.clipPath = `inset(${r.y}px ${W() - r.x - r.width}px ${H() - r.y - r.height}px ${r.x}px)`;
    frozen.classList.add('on');
    frozen.classList.remove('fade');
    place(frame, r);
    frame.className = 'scanning';
    show(frame);
    card.className = 'jd';
    card.innerHTML = '';
    card.append(el('div', 'tt', '【鉴定中】'), el('div', 'nm wait', '扫描中'), el('div', 'kv'), el('div', 'evs'), el('div', 'ops'));
    card.querySelector('.tt').append(el('small', '', 'APPRAISE'));
    show(card);
    placeCard();
  }
  function placeCard() {
    const r = S.cardInfo.rect;
    const cw = card.offsetWidth || 300;
    const ch = card.offsetHeight || 160;
    let x = r.x + r.width + 14;
    let y = r.y;
    if (x + cw > W() - 8) x = r.x - cw - 14;
    if (x < 8) {
      // 左右都放不下：放下面或上面
      x = Math.max(8, Math.min(W() - cw - 8, r.x));
      y = r.y + r.height + 14;
      if (y + ch > H() - 8) y = r.y - ch - 14;
      if (y < 8) y = Math.max(8, r.y + r.height - ch - 8);
    }
    y = Math.max(8, Math.min(H() - ch - 8, y));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }
  function addPart(p) {
    const c = S.cardInfo?.card;
    if (!c) return;
    const nm = card.querySelector('.nm');
    switch (p.part) {
      case 'name':
        c.name = p.value;
        card.querySelector('.tt').firstChild.textContent = '【鉴定结果】';
        nm.className = 'nm';
        nm.textContent = '';
        typeInto(nm, p.value);
        break;
      case 'rarity':
      case 'tag': {
        const v = p.part === 'rarity' ? (c.rarity = Object.keys(RAR).find((k) => p.value.includes(k)) || p.value) : (c.tag = p.value);
        nm.querySelector('.rar')?.remove();
        nm.append(el('span', 'rar ' + (p.part === 'rarity' ? RAR[v] || 'rare' : /报错|错误|警告/.test(v) ? 'fix' : 'tag'), v));
        if (p.part === 'rarity') card.classList.add('r-' + (RAR[v] || 'rare'));
        break;
      }
      case 'field':
        c.fields.push([p.key, p.value]);
        card.querySelector('.kv').append(el('span', 'k', p.key), el('span', 'v', p.value));
        break;
      case 'verdict':
      case 'advice': {
        c[p.part] = p.value;
        const row = el('div', 'ev');
        row.append(el('b', '', p.part === 'verdict' ? '评价' : '建议'), document.createTextNode(p.value));
        card.querySelector('.evs').append(row);
        break;
      }
      case 'actions':
        c.actions = p.value ? String(p.value) : '';
        break;
    }
    placeCard();
  }
  function typeInto(node, text) {
    let i = 0;
    const t = setInterval(() => {
      node.firstChild?.nodeType === 3 ? (node.firstChild.textContent = text.slice(0, ++i)) : node.prepend(document.createTextNode(text.slice(0, ++i)));
      if (i >= text.length) clearInterval(t);
    }, 35);
  }
  function finish(m) {
    const info = S.cardInfo;
    S.stage = 'result';
    frame.className = 'done';
    // 扫完：定格的那块淡掉，露出现在的画面
    setTimeout(() => frozen.classList.add('fade'), 700);
    if (!m.ok) {
      card.className = 'jd err';
      card.innerHTML = '';
      card.append(el('div', 'tt', '【鉴定失败】'), el('div', 'msg', m.error || '没鉴定出来'), ops([['✕', () => B.send({ op: 'close' })]]));
      if (!info) {
        S.cardInfo = { rect: { x: W() / 2 - 150, y: H() / 2 - 60, width: 0, height: 0 } };
        show(card);
      }
      placeCard();
      return armTimer(8000);
    }
    const c = m.card;
    info.card = c;
    // 流里漏掉的补上（比如最后一行没换行）
    const nm = card.querySelector('.nm');
    if (!nm.textContent.trim() || nm.classList.contains('wait')) {
      nm.className = 'nm';
      nm.textContent = c.name;
    }
    card.querySelector('.tt').firstChild.textContent = '【鉴定结果】';
    if (c.rarity && !nm.querySelector('.rar')) addPart({ part: 'rarity', value: c.rarity });
    if (c.tag && !nm.querySelector('.rar')) addPart({ part: 'tag', value: c.tag });
    const kv = card.querySelector('.kv');
    if (kv.children.length / 2 < c.fields.length) {
      kv.innerHTML = '';
      for (const [k, v] of c.fields) kv.append(el('span', 'k', k), el('span', 'v', v));
    }
    const evs = card.querySelector('.evs');
    if (!evs.children.length && (c.verdict || c.advice)) {
      for (const [k, v] of [['评价', c.verdict], ['建议', c.advice]]) {
        if (!v) continue;
        const row = el('div', 'ev');
        row.append(el('b', '', k), document.createTextNode(v));
        evs.append(row);
      }
    }
    const list = [['追问', () => B.send({ op: 'action', id: info.id, action: 'followup' }), 'go']];
    if (c.actions?.includes('fix')) list.push(['帮我处理', () => B.send({ op: 'action', id: info.id, action: 'fix' }), 'go']);
    if (c.actions?.includes('annotate') || (info.baseActions.includes('annotate') && /界面|软件/.test(c.tag || ''))) list.push(['在软件上标出来', () => B.send({ op: 'action', id: info.id, action: 'annotate' })]);
    list.push(['复制', (b) => (B.send({ op: 'copy', text: copyText(c) }), (b.textContent = '已复制'))]);
    list.push(['✕', () => B.send({ op: 'close' })]);
    card.querySelector('.ops').replaceWith(ops(list));
    placeCard();
    armTimer(30_000);
  }
  function ops(list) {
    const box = el('div', 'ops');
    for (const [label, fn, cls] of list) {
      const b = el('button', cls || '', label);
      b.onclick = () => fn(b);
      box.append(b);
    }
    return box;
  }
  const copyText = (c) =>
    [`【鉴定结果】${c.name}${c.rarity ? `（${c.rarity}）` : c.tag ? `（${c.tag}）` : ''}`, ...c.fields.map(([k, v]) => `${k}：${v}`), c.verdict && `评价：${c.verdict}`, c.advice && `建议：${c.advice}`].filter(Boolean).join('\n');
  // 卡片停 30 秒；鼠标移上去就一直停
  function armTimer(ms) {
    clearTimeout(S.timer);
    S.timer = setTimeout(() => {
      if (S.hovered) return armTimer(3000);
      B.send({ op: 'close' });
    }, ms);
  }
  // 选完以后窗口是点不到的：鼠标移到卡片、标签上时才接住点击
  function trackHit(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const on = !!t?.closest('#card:not(.hidden), #summary:not(.hidden), .tag2.click');
    setHit(on);
    S.hovered = !!t?.closest('#card, #summary');
  }

  // =================== 全屏扫描 ===================
  function enterTags(m) {
    reset();
    S.stage = 'tags';
    S.cardInfo = null;
    document.body.className = 'tags';
    show(fullsweep);
    fullsweep.classList.remove('go');
    void fullsweep.offsetWidth;
    fullsweep.classList.add('go');
    for (const w of m.windows || []) {
      const t = el('div', 'tag2 ' + (w.kind || 'click'));
      t.dataset.id = w.id;
      t.append(el('b', '', w.name), el('span', 'l', w.label || '扫描中…'));
      t.style.left = Math.max(4, Math.min(W() - 260, w.rect.x + 8)) + 'px';
      t.style.top = Math.max(4, w.rect.y + 30) + 'px';
      t.style.animationDelay = Math.min(1.6, (w.rect.y / H()) * 1.6).toFixed(2) + 's';
      if (!w.kind) t.onclick = () => B.send({ op: 'tag', windowId: w.id });
      tagsEl.append(t);
    }
    armTimer(60_000);
  }
  function setTag(m) {
    const t = tagsEl.querySelector(`.tag2[data-id="${m.windowId}"] .l`);
    if (t) t.textContent = m.label;
  }
  function showSummary(m) {
    summary.innerHTML = '';
    summary.className = 'jd';
    const tt = el('div', 'tt', '【全屏扫描】');
    tt.append(el('small', '', 'SCAN'));
    summary.append(tt, el('div', 'nm', `检测到 ${m.count} 个窗口`));
    const kv = el('div', 'kv');
    if (m.names?.length) kv.append(el('span', 'k', '窗口'), el('span', 'v', m.names.join('、')));
    if (m.masked?.length) kv.append(el('span', 'k', '涂黑'), el('span', 'v', m.masked.join('、')));
    summary.append(kv);
    if (m.verdict) {
      const row = el('div', 'ev');
      row.append(el('b', '', '评价'), document.createTextNode(m.verdict));
      summary.append(row);
    }
    summary.append(el('div', 'hint2', '点窗口上的标签，鉴定那个窗口'), ops([['✕', () => B.send({ op: 'close' })]]));
    show(summary);
    // 放在挡住标签最少的地方：下中、右下、左下、右上、左上
    const sw = summary.offsetWidth;
    const sh = summary.offsetHeight;
    const spots = [
      [W() / 2 - sw / 2, H() - sh - 60],
      [W() - sw - 24, H() - sh - 60],
      [24, H() - sh - 60],
      [W() - sw - 24, 24],
      [24, 24],
    ];
    const tags = [...tagsEl.querySelectorAll('.tag2')].map((t) => t.getBoundingClientRect());
    const cover = ([x, y]) => tags.reduce((n, r) => n + Math.max(0, Math.min(x + sw, r.right) - Math.max(x, r.left)) * Math.max(0, Math.min(y + sh, r.bottom) - Math.max(y, r.top)), 0);
    const [x, y] = spots.reduce((best, p) => (cover(p) < cover(best) ? p : best), spots[0]);
    summary.style.left = Math.round(Math.max(8, x)) + 'px';
    summary.style.top = Math.round(Math.max(8, y)) + 'px';
    armTimer(30_000);
  }

  B.on((m) => {
    switch (m.stage) {
      case 'select':
        return enterSelect(m);
      case 'image':
        frozen.src = m.image;
        return;
      case 'scan':
        return enterScan(m);
      case 'part':
        return addPart(m);
      case 'result':
        return finish(m);
      case 'tags':
        return enterTags(m);
      case 'tag':
        return setTag(m);
      case 'summary':
        return showSummary(m);
      case 'idle':
        S.stage = 'idle';
        return reset();
    }
  });
  window.addEventListener('blur', () => {
    // 选择时被别的窗口抢了焦点（比如宿主按了 Win 键）：不退出，等宿主回来
  });
})();
