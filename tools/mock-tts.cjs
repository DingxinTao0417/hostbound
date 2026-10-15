// 假的声音服务，接口跟 voice/server.py 一样，测试用：每个字 0.1 秒的正弦波，分三块慢慢吐出来（模拟边生成边返回）。
// 用法：node tools/mock-tts.cjs [端口，默认 5197]
const http = require('node:http');

const PORT = Number(process.argv[2] || 5197);
const SR = 24000;
const requests = [];
let cancelled = new Set();

function tone(seconds) {
  const n = Math.round(seconds * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / SR) * 8000), i * 2);
  return buf;
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const q = body ? JSON.parse(body) : {};
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ready: true, engine: 'mock', voice: '测试音', sampleRate: SR }));
      }
      if (req.url === '/cancel') {
        cancelled.add(q.id);
        res.writeHead(200);
        return res.end('{}');
      }
      if (req.url !== '/tts') return res.writeHead(404).end();
      requests.push(q.text);
      process.stderr.write(`[mock-tts] #${requests.length} ${q.text}\n`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(SR) });
      const pcm = tone(Math.max(0.3, [...q.text].length * 0.1));
      const step = Math.ceil(pcm.length / 3 / 2) * 2;
      // 故意让一块在奇数字节处断开，检查客户端能拼回完整的采样
      for (let i = 0; i < pcm.length; i += step) {
        if (cancelled.has(q.id)) break;
        const part = pcm.subarray(i, i + step);
        res.write(part.subarray(0, part.length - 1));
        res.write(part.subarray(part.length - 1));
        await new Promise((r) => setTimeout(r, 60));
      }
      res.end();
    });
  })
  .listen(PORT, '127.0.0.1', () => process.stderr.write(`[mock-tts] listening on ${PORT}\n`));
