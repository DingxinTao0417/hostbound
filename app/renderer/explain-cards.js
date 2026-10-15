// 面板这边的讲解：对话里的【图解】卡（点「打开」看讲解窗口）、【就地讲解】卡、【教学】卡；
// 还有边念边指的节拍：后台交给嘴念一段讲解旁白，这里看着播放进度，念完了告诉后台，后台再亮下一步。
// 用 app.js 里的 add / addCard / logEl / bridge / wake / scrollLog / voiceState（同一个页面里的全局）。
(() => {
  const el = (tag, cls, text) => {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  };
  const btn = (label, cls, onclick) => {
    const b = el('button', cls, label);
    b.onclick = onclick;
    return b;
  };
  const cardOf = (sel) => logEl.querySelector(sel);
  function upsert(sel, make) {
    const old = cardOf(sel);
    const card = make();
    if (old) old.replaceWith(card);
    else addCard(card);
    return card;
  }

  // ---- 【图解】 ----
  function explainCard(p, live) {
    return upsert(`.xc.explain[data-id="${p.id}"]`, () => {
      const d = el('div', `msg xc explain${p.kind === 'tutor' ? ' ended' : ''}`);
      d.dataset.id = p.id;
      d.dataset.at = Date.now();
      d.append(el('div', 'tt', p.kind === 'tutor' ? '【教学小结】' : p.done ? '【图解】' : '【图解】绘制中'), el('div', 'nm', p.title));
      if (p.summary) d.append(el('div', 'sm', p.summary));
      if (p.meta) d.append(el('div', 'meta', p.meta));
      d.append(el('div', 'live', live || ''));
      const qb = el('div', 'qb');
      qb.append(btn('打开', 'btn', () => bridge.send({ type: 'explain_open', id: p.id })));
      d.append(qb);
      return d;
    });
  }

  // ---- 边念边指：等一段旁白念完 ----
  const narr = new Map(); // key → { segs, until }
  function watchNarr(key, segs) {
    narr.set(key, { segs, until: Date.now() + 180_000 });
    tick();
  }
  let ticking = null;
  function tick() {
    if (ticking) return;
    ticking = setInterval(() => {
      for (const [key, n] of narr) {
        const done = n.segs.every((s) => window.Speech?.progress(key, s) === 1);
        if (done || Date.now() > n.until) {
          narr.delete(key);
          bridge.send({ type: 'explain_spoken', key });
        }
      }
      if (!narr.size) {
        clearInterval(ticking);
        ticking = null;
      }
    }, 150);
  }

  // ---- 【就地讲解】 ----
  function guideCard(st) {
    return upsert('.xc.guide.active', () => {
      const ended = st.status === 'done' || st.status === 'exit';
      const d = el('div', `msg xc guide${ended ? ' ended' : ''}${st.status === 'exit' ? ' quit' : ''}${ended ? '' : ' active'}`);
      d.dataset.at = Date.now();
      d.append(el('div', 'tt', st.status === 'done' ? '【就地讲解】讲完了' : st.status === 'exit' ? '【就地讲解】已退出' : st.status === 'paused' ? '【就地讲解】已暂停' : '【就地讲解】'), el('div', 'nm', st.app));
      const ol = el('ol');
      st.items.forEach((name, k) => {
        const li = el('li', ended ? 'done' : k === st.i ? 'on' : k < st.i ? 'done' : '');
        li.append(el('span', 'n', String(k + 1)), document.createTextNode(name));
        ol.append(li);
      });
      d.append(ol);
      if (!ended) {
        if (st.say) d.append(el('div', 'say', st.say));
        const qb = el('div', 'qb');
        const ctl = (op) => () => bridge.send({ type: 'guide_ctl', op });
        qb.append(btn(st.status === 'playing' ? '暂停' : '继续', 'btn', ctl(st.status === 'playing' ? 'pause' : 'resume')), btn('上一个', 'btn ghost', ctl('prev')), btn('下一个', 'btn ghost', ctl('next')), btn('退出', 'btn ghost', ctl('exit')));
        d.append(qb);
        if (voiceState.ok) d.append(el('div', 'hintv', '也可以说：「停一下」「继续」「下一个」「退出」'));
      } else if (st.say) d.append(el('div', 'meta', st.say));
      return d;
    });
  }

  // ---- 【教学】 ----
  function tutorCard(st) {
    return upsert('.xc.tutor.active', () => {
      const ended = ['done', 'exit'].includes(st.status);
      const d = el('div', `msg xc tutor${ended ? ' ended' : ''}${st.status === 'exit' ? ' quit' : ''}${ended ? '' : ' active'}`);
      d.dataset.at = Date.now();
      d.append(el('div', 'tt', st.status === 'done' ? '【教学完成】' : st.status === 'exit' ? '【教学】已退出' : `【教学】第 ${st.index || 1} / ${st.total || '?'} 步`), el('div', 'nm', st.title));
      const ol = el('ol');
      (st.steps || []).forEach((name, k) => {
        const n = k + 1;
        const cur = !ended && n === st.index;
        const li = el('li', cur ? 'on' : n < st.index || (ended && st.status === 'done') || (st.status === 'step_done' && n === st.index) ? 'done' : '');
        li.append(el('span', 'n', li.className === 'done' ? '✓' : String(n)), document.createTextNode(name));
        ol.append(li);
      });
      d.append(ol);
      if (st.status === 'done') {
        d.append(el('div', 'meta', `宿主自己做完了 ${st.done ?? st.index} 步 · 每一步的截图已存成一页讲解`));
        if (st.page) {
          const qb = el('div', 'qb');
          qb.append(btn('打开小结', 'btn', () => bridge.send({ type: 'explain_open', id: st.page })));
          d.append(qb);
        }
        return d;
      }
      if (ended) return d;
      if (st.say) d.append(el('div', 'say', st.say));
      d.append(el('div', 'warn', st.warn || ''));
      const qb = el('div', 'qb');
      const ctl = (op) => () => bridge.send({ type: 'tutor_ctl', op });
      if (st.asking) qb.append(btn('做好了', 'btn', ctl('done')), btn('还没', 'btn ghost', ctl('notyet')));
      else if (st.status === 'waiting') qb.append(btn('你来做这步', 'btn', ctl('do')), btn('跳过', 'btn ghost', ctl('skip')), btn('再指一遍', 'btn ghost', ctl('again')), btn('退出教学', 'btn ghost', ctl('exit')));
      if (qb.children.length) d.append(qb);
      if (voiceState.ok && st.status === 'waiting') d.append(el('div', 'hintv', st.asking ? '也可以说：「做好了」' : '也可以说：「你来」「跳过」「再指一遍」「做好了」'));
      return d;
    });
  }

  bridge.onBrain((m) => {
    switch (m.type) {
      case 'explain_card':
        explainCard(m.page, m.live);
        break;
      case 'explain_live': {
        const live = cardOf(`.xc.explain[data-id="${m.id}"] .live`);
        if (live) live.textContent = m.live || '';
        break;
      }
      case 'explain_narr':
        watchNarr(m.key, m.segs || []);
        break;
      case 'guide':
        wake('event');
        toChat();
        guideCard(m.state);
        break;
      case 'tutor':
        wake('event');
        toChat();
        tutorCard(m.state);
        if (m.state.status === 'waiting') setPanel('手把手教学', 'TUTOR', 'gold', 'busy');
        scrollLog();
        break;
    }
  });
})();
