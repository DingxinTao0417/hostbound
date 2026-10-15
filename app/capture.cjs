// 看屏幕：先放扫描特效，藏起面板和效果层，截图，裁出要的那一块（窗口或整块屏幕），再恢复并闪一下。
// rect 是屏幕物理像素（Windows 窗口、显示器的范围）。返回 JPEG（base64），长边不超过 1600。
const { desktopCapturer, screen } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureRect({ rect, scope, label, fx, hide = [] }) {
  const dip = screen.screenToDipRect(null, rect);
  const display = screen.getDisplayMatching(dip);
  fx?.route({ kind: 'screenscan', rect, scope, label });
  await wait(1500);
  const restore = () => {
    for (const w of hide) if (w && !w.isDestroyed()) w.setOpacity(1);
    fx?.setOpacity(1);
  };
  for (const w of hide) if (w && !w.isDestroyed()) w.setOpacity(0);
  fx?.setOpacity(0);
  await wait(150);
  try {
    const phys = screen.dipToScreenRect(null, display.bounds);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: phys.width, height: phys.height } });
    restore();
    const src = sources.find((x) => x.display_id === String(display.id)) || sources[0];
    if (!src) throw new Error('没拿到屏幕画面');
    let img = src.thumbnail;
    const size = img.getSize();
    const k = size.width / phys.width;
    const x = Math.max(0, Math.round((rect.x - phys.x) * k));
    const y = Math.max(0, Math.round((rect.y - phys.y) * k));
    const w = Math.min(size.width - x, Math.round(rect.width * k));
    const h = Math.min(size.height - y, Math.round(rect.height * k));
    if (w < 10 || h < 10) throw new Error('截图区域太小');
    img = img.crop({ x, y, width: w, height: h });
    // 太大的图缩到长边 1600，够模型看清，也省流量
    const scale = Math.min(1, 1600 / Math.max(w, h));
    if (scale < 1) img = img.resize({ width: Math.round(w * scale), height: Math.round(h * scale), quality: 'best' });
    const out = img.getSize();
    fx?.route({ kind: 'flash', rect });
    return { data: img.toJPEG(85).toString('base64'), mimeType: 'image/jpeg', width: out.width, height: out.height, image: img };
  } finally {
    restore();
  }
}

module.exports = { captureRect };
