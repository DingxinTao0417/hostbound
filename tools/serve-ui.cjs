// 在普通浏览器里预览界面用的静态服务器：node tools/serve-ui.cjs → http://localhost:5178（设计稿在 /design/ 下）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'app', 'renderer');
const designDir = path.join(__dirname, '..', 'design');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const design = url.startsWith('/design/');
    const base = design ? designDir : dir;
    const p = path.join(base, (design ? url.slice('/design'.length) : url).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(base) || !fs.existsSync(p)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  })
  .listen(5178, () => console.log('http://localhost:5178'));
