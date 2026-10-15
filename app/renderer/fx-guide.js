// 效果层：就地讲解、手把手教学（fx kind = 'guide'）。跟 fx.js 画在同一个透明窗口里，用它的 add / place / esc / bump。
// 主进程已经把坐标换成这块屏幕上的 DIP。phase：
// - frame：那个软件窗口的范围（压暗只压这个窗口，不压整块屏幕）
// - mark：编号小圆点（就地讲解）；focus：当前这一个（框、标签、字幕，就地讲解时系统光标飞过去）
// - hint：点错了的提示；ripple：点对了冒一圈光；clear：收起
(() => {
  const bridge = window.fxBridge || { onFx: () => {} };
  const G = new Map(); // key → { frame, hole, tgt, cap, marks: Map, cur, frameRect, rect }

  function state(key) {
    let g = G.get(key);
    if (!g) {
      g = { marks: new Map() };
      G.set(key, g);
    }
    return g;
  }

  function frameEl(g) {
    if (!g.frame) {
      g.frame = add('gframe');
      g.hole = document.createElement('div');
      g.hole.className = 'ghole';
      g.frame.appendChild(g.hole);
    }
    return g.frame;
  }

  function holeTo(g) {
    if (!g.frameRect || !g.rect || !g.hole) return;
    const pad = 6;
    Object.assign(g.hole.style, {
      left: g.rect.x - g.frameRect.x - pad + 'px',
      top: g.rect.y - g.frameRect.y - pad + 'px',
      width: g.rect.width + pad * 2 + 'px',
      height: g.rect.height + pad * 2 + 'px',
    });
  }

  function onFrame(m, g) {
    if (!m.rect) return;
    g.frameRect = m.rect;
    place(frameEl(g), m.rect);
    holeTo(g);
  }

  function onMark(m, g) {
    if (!m.rect) return;
    let d = g.marks.get(m.n);
    if (!d) {
      d = add('gmark');
      d.textContent = m.n;
      g.marks.set(m.n, d);
    }
    d.className = `gmark ${m.state || ''}`;
    Object.assign(d.style, { left: m.rect.x + 'px', top: m.rect.y + 'px' });
  }

  function onFocus(m, g) {
    if (!m.rect) return;
    g.rect = m.rect;
    frameEl(g);
    holeTo(g);
    if (!g.tgt) g.tgt = add('gtgt', '<i class="k tl"></i><i class="k tr"></i><i class="k bl"></i><i class="k br"></i><span class="tagx"><span class="d"></span><span class="t"></span><small></small></span>');
    const tutor = m.mode === 'tutor';
    g.tgt.className = `gtgt${m.est ? ' est' : ''}${tutor ? ' pulse' : ''}${m.rect.y < 40 ? ' below' : ''}`;
    place(g.tgt, m.rect, 4);
    g.tgt.querySelector('.t').textContent = m.label || '';
    g.tgt.querySelector('small').textContent = tutor ? m.sub || '' : '';
    // 字幕：放在目标上面，放不下就放下面
    if (!g.cap) g.cap = add('gcap', '<div class="lb"><span class="a"></span><span class="ps"></span></div><div class="tx"></div>');
    g.cap.className = `gcap${tutor ? ' tutor' : ''}`;
    g.cap.querySelector('.a').textContent = tutor ? `第 ${m.sub || ''} 步 · 该你来点` : `${m.sub || ''} · ${m.name || m.label || ''}`;
    g.cap.querySelector('.ps').textContent = m.paused ? '已暂停 · 说「继续」接着讲' : m.est ? '位置是看截图估的' : '';
    g.cap.querySelector('.tx').textContent = m.text || '';
    const w = 320;
    const h = g.cap.offsetHeight || 80;
    const x = clampX(m.rect.x + m.rect.width / 2 - w / 2, w);
    const above = m.rect.y - h - 44;
    const y = above > 8 ? above : clampY(m.rect.y + m.rect.height + 14, h);
    Object.assign(g.cap.style, { left: x + 'px', top: y + 'px', opacity: 1 });
    // 就地讲解：系统光标飞到这个按钮上
    if (!tutor) {
      if (!g.cur) {
        g.cur = add('scur', '<span class="lbl"></span>');
        const from = m.home || { x: m.rect.x + m.rect.width / 2, y: m.rect.y - 140 };
        g.cur.classList.add('snap');
        g.cur.style.transform = `translate(${from.x}px, ${from.y}px)`;
        void g.cur.offsetWidth;
        g.cur.classList.remove('snap');
        g.cur.classList.add('on');
      }
      g.cur.querySelector('.lbl').textContent = m.name || m.label || '';
      requestAnimationFrame(() => (g.cur.style.transform = `translate(${m.rect.x + m.rect.width * 0.72}px, ${m.rect.y + m.rect.height * 0.62}px)`));
    }
  }

  function onHint(m, g) {
    if (!m.rect) return;
    const d = add('ghint');
    d.textContent = m.text || '不是这里';
    // 放在目标下面（上面是指引字幕）；下面放不下才放上面
    const below = m.rect.y + m.rect.height + 14;
    const y = below + 40 < innerHeight ? below : m.rect.y - 120;
    Object.assign(d.style, { left: clampX(m.rect.x - 10, 260) + 'px', top: clampY(y, 34) + 'px' });
    requestAnimationFrame(() => d.classList.add('on'));
    setTimeout(() => d.classList.remove('on'), 1700);
    setTimeout(() => d.remove(), 2000);
  }

  function onRipple(m) {
    if (m.rect) ripple({ x: m.rect.x, y: m.rect.y });
  }

  function clear(key) {
    const g = G.get(key);
    if (!g) return;
    for (const el of [g.frame, g.tgt, g.cap, g.cur, ...g.marks.values()]) el?.remove();
    G.delete(key);
  }

  bridge.onFx((m) => {
    if (m.kind !== 'guide') return;
    try {
      const key = m.key || 'guide';
      if (m.phase === 'clear') return clear(key);
      const g = state(key);
      ({ frame: onFrame, mark: onMark, focus: onFocus, hint: onHint, ripple: onRipple })[m.phase]?.(m, g);
      bump(1500);
    } catch (e) {
      console.error(e);
    }
  });
  // 标注开着的时候效果层别藏起来
  setInterval(() => G.size && bump(1500), 1000);
})();
