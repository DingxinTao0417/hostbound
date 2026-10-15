// 效果层：主进程把效果事件发过来（坐标已经换成这块屏幕上的 DIP），这里画出来。
// 没东西可画时告诉主进程，主进程把这个窗口藏起来（全屏透明窗口一直开着可能影响游戏）。
const root = document.body;
const bridge = window.fxBridge || { onFx: (cb) => (window.__fx = cb), idle: () => {} };

const scans = new Map(); // key → { el, since, timer }
let cursor = null;
let cursorPos = null;
let cursorShown = false;
let busyUntil = 0;
let takeoverActive = false;

const add = (cls, html = '') => {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  root.appendChild(d);
  return d;
};
const place = (d, r, pad = 0) =>
  Object.assign(d.style, { left: r.x - pad + 'px', top: r.y - pad + 'px', width: r.width + 2 * pad + 'px', height: r.height + 2 * pad + 'px' });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clampX = (x, w) => Math.max(8, Math.min(innerWidth - w - 8, x));
const clampY = (y, h) => Math.max(8, Math.min(innerHeight - h - 8, y));

// ---- 没东西可画就让主进程藏起窗口 ----
let idleTimer = null;
function bump(ms) {
  busyUntil = Math.max(busyUntil, performance.now() + ms);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(checkIdle, ms + 300);
}
function checkIdle() {
  if (performance.now() < busyUntil || scans.size || takeoverActive || cursorShown) return bump(800);
  bridge.idle();
}

// ---- 扫描框 ----
function scanEl(key) {
  let s = scans.get(key);
  if (!s) {
    const el = add('scan', '<i class="k tl"></i><i class="k tr"></i><i class="k bl"></i><i class="k br"></i><div class="sweep"></div><div class="tagx"><span class="d"></span><span class="t"></span><small></small></div>');
    s = { el, since: 0, timer: null };
    scans.set(key, s);
  }
  return s;
}
function removeScan(key) {
  const s = scans.get(key);
  if (!s) return;
  clearTimeout(s.timer);
  s.el.classList.remove('on');
  setTimeout(() => s.el.remove(), 300);
  scans.delete(key);
}
function onScan(m) {
  const key = m.key || 'app';
  if (m.phase === 'off') {
    for (const k of m.all ? [...scans.keys()] : [key]) removeScan(k);
    return bump(400);
  }
  if (!m.rect) return;
  const s = scanEl(key);
  place(s.el, m.rect, 6);
  const tagIn = m.rect.y - 6 < 32 ? ' tag-in' : '';
  const apply = () => {
    s.el.className = `scan on ${m.phase}${tagIn}`;
    s.el.querySelector('.t').textContent = m.label || '';
    s.el.querySelector('small').textContent = m.sub || '';
  };
  clearTimeout(s.timer);
  if (m.phase === 'scanning') {
    s.since = performance.now();
    apply();
  } else {
    // 刚开始扫的话，让光带至少扫一会儿再锁定
    const wait = Math.max(0, (m.delay || 0) - (performance.now() - (s.since || 0)));
    if (!s.since) {
      // 没看到“扫描中”就直接锁定：先补一段扫描
      s.since = performance.now();
      s.el.className = `scan on scanning${tagIn}`;
      s.el.querySelector('.t').textContent = (m.label || '').replace('已锁定', '扫描中');
      s.timer = setTimeout(apply, m.delay || 700);
    } else if (wait) s.timer = setTimeout(apply, wait);
    else apply();
  }
  bump(1500);
}

// ---- 系统光标、点击 ----
function ensureCursor() {
  if (!cursor) {
    cursor = add('scur', '<span class="lbl"></span>');
  }
  return cursor;
}
function moveCursor(p, animate = true) {
  const c = ensureCursor();
  c.classList.toggle('snap', !animate);
  c.style.transform = `translate(${p.x}px, ${p.y}px)`;
  cursorPos = p;
}
function ripple(p) {
  const r = add('rip');
  Object.assign(r.style, { left: p.x + 'px', top: p.y + 'px' });
  setTimeout(() => r.remove(), 900);
}
function onClick(m) {
  const c = ensureCursor();
  const to = m.point;
  if (!to) return;
  c.querySelector('.lbl').textContent = m.label || '点击';
  if (!cursorShown) {
    // 第一次出现：从核心出发（核心不在这块屏幕上就从目标上方落下来）
    moveCursor(m.home || { x: to.x, y: to.y - 140 }, false);
    void c.offsetWidth;
    c.classList.add('on');
    cursorShown = true;
  }
  const fly = m.instant ? 0 : 500;
  requestAnimationFrame(() => moveCursor(to, !m.instant));
  setTimeout(() => {
    if (m.rect && m.rect.width > 4 && m.rect.height > 4) {
      const t = add('target on');
      place(t, m.rect, 2);
      setTimeout(() => t.classList.remove('on'), 500);
      setTimeout(() => t.remove(), 800);
    }
    ripple(to);
  }, fly);
  bump(fly + 1200);
}
function onHome(m) {
  if (!cursor || !cursorShown) return;
  if (m.home) moveCursor(m.home);
  setTimeout(() => {
    cursor?.classList.remove('on');
    cursorShown = false;
    cursorPos = null;
  }, m.home ? 520 : 0);
  bump(900);
}

// ---- 输入字幕、键帽 ----
function onType(m) {
  if (!m.rect) return;
  const text = String(m.text || '');
  const shown = text.length > 40 ? text.slice(0, 40) + '…' : text;
  const t = add('typing', `<span class="lb">输入</span><span class="tx">${esc(shown)}</span><span class="caret"></span>`);
  const small = m.rect.height < 90;
  const x = small ? m.rect.x : m.rect.x + 16;
  const y = small ? m.rect.y + m.rect.height + 8 : m.rect.y + m.rect.height - 52;
  Object.assign(t.style, { left: clampX(x, 300) + 'px', top: clampY(y, 34) + 'px' });
  requestAnimationFrame(() => t.classList.add('on'));
  const life = Math.min(4000, 1600 + text.length * 40);
  setTimeout(() => t.classList.remove('on'), life);
  setTimeout(() => t.remove(), life + 300);
  bump(life + 400);
}
function onKeys(m) {
  if (!m.rect) return;
  const parts = String(m.keys || '').split('+').map((s) => s.trim()).filter(Boolean);
  const nice = (k) => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1));
  const k = add('keycaps', parts.map((p) => `<span class="key">${esc(nice(p))}</span>`).join('<span class="pl">+</span>'));
  Object.assign(k.style, { left: m.rect.x + m.rect.width / 2 + 'px', top: clampY(m.rect.y + m.rect.height - 70, 40) + 'px' });
  requestAnimationFrame(() => k.classList.add('on'));
  setTimeout(() => k.classList.remove('on'), 1400);
  setTimeout(() => k.remove(), 1700);
  bump(1900);
}

// ---- 通知 ----
function onNotice(m) {
  if (m.mode === 'full') {
    const n = add(
      'notice',
      `<div class="streak"></div><div class="box tone-${m.tone === 'err' ? 'err' : m.tone === 'gold' ? 'gold' : 'ok'}"><div class="fr"><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>
        <div class="plate"><span class="wing l"></span><span class="p">${esc(m.title)}</span><span class="wing r"></span></div>
        <div class="body"><div class="res">${esc(m.text)}</div>${m.meta ? `<div class="meta">${esc(m.meta)}</div>` : ''}<div class="life"><i></i></div></div></div></div>`,
    );
    // 到点提醒多停一会儿
    const hold = m.tone === 'gold' ? 6000 : 3300;
    requestAnimationFrame(() => n.classList.add('on'));
    setTimeout(() => n.classList.remove('on'), hold);
    setTimeout(() => n.remove(), hold + 400);
    return bump(hold + 600);
  }
  const t = add(`toast ${m.tone === 'err' ? 'err' : m.tone === 'info' ? 'info' : m.tone === 'gold' ? 'gold' : ''}`, `<b>${esc(m.title)}</b>${esc(m.text)}<div class="life"><i></i></div>`);
  // 「后台打开了某某」这类提示放在核心旁边；完成 / 失败放右上角
  if (m.tone === 'info' && m.home) Object.assign(t.style, { left: clampX(m.home.x - 370, 340) + 'px', top: clampY(m.home.y - 70, 60) + 'px' });
  else Object.assign(t.style, { right: '24px', top: '24px' });
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => t.classList.remove('on'), 4200);
  setTimeout(() => t.remove(), 4600);
  bump(4800);
}

// ---- 扫描屏幕 / 窗口 ----
function onScreenScan(m) {
  if (m.scope === 'window' && m.rect) {
    onScan({ key: 'look', rect: m.rect, phase: 'scanning', label: `扫描窗口 · ${m.label || ''}`, sub: '截图' });
    setTimeout(() => removeScan('look'), 1500);
    return bump(1900);
  }
  const s = add('sscan', '<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i><div class="band"></div><div class="banner">扫描屏幕<small>读取整个屏幕…</small></div>');
  requestAnimationFrame(() => s.classList.add('on'));
  setTimeout(() => s.classList.remove('on'), 1500);
  setTimeout(() => s.remove(), 1800);
  bump(2000);
}
function onFlash(m) {
  const f = add('flash');
  place(f, m.rect || { x: 0, y: 0, width: innerWidth, height: innerHeight });
  requestAnimationFrame(() => f.classList.add('go'));
  setTimeout(() => f.remove(), 700);
  bump(800);
}

// ---- 接管前台 ----
let edge = null;
let tbanner = null;
function onTakeover(m) {
  edge ||= add('edge');
  tbanner ||= add('tbanner');
  if (m.phase === 'countdown') {
    const r = m.rect || { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const c = add('count3');
    place(c, r);
    ['3', '2', '1'].forEach((n, i) =>
      setTimeout(() => {
        c.textContent = n;
        c.classList.add('on');
        setTimeout(() => c.classList.remove('on'), 800);
      }, i * 1000),
    );
    setTimeout(() => c.remove(), 3100);
    takeoverActive = true;
    return bump(3300);
  }
  if (m.phase === 'active') {
    takeoverActive = true;
    edge.classList.add('on');
    tbanner.className = 'tbanner on';
    tbanner.innerHTML = `<b>系统接管中</b><span>剩余 ${m.left} 秒</span><span class="muted">动鼠标或按</span><span class="key">Esc</span><span class="muted">立即收回</span>`;
    return bump(1500);
  }
  // 结束：宿主收回 / 时间到
  takeoverActive = false;
  edge.classList.remove('on');
  tbanner.className = 'tbanner on back';
  tbanner.innerHTML = m.phase === 'aborted' ? '<b>宿主收回了控制权</b><span>系统已停手</span>' : '<b>已归还控制权</b><span>系统在后台继续</span>';
  setTimeout(() => tbanner && (tbanner.className = 'tbanner'), 1800);
  bump(2300);
}

const HANDLERS = { scan: onScan, click: onClick, home: onHome, type: onType, keys: onKeys, notice: onNotice, screenscan: onScreenScan, flash: onFlash, takeover: onTakeover };
bridge.onFx((m) => {
  try {
    HANDLERS[m.kind]?.(m);
  } catch (e) {
    console.error(e);
  }
});
