// 极简的 MCP stdio 客户端：系统用它驱动 Cua Driver 和 Open Computer Use（对比测试也用它）
import { spawn } from 'node:child_process';

export class McpClient {
  constructor(command, args = []) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.seq = 0;
    this.waiting = new Map();
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id != null && this.waiting.has(m.id)) {
            this.waiting.get(m.id)(m);
            this.waiting.delete(m.id);
          }
        } catch {}
      }
    });
  }

  request(method, params, timeoutMs = 60_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hostbound-compare', version: '1' } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return this;
  }

  // 调一个工具，返回 { text, images, isError, ms, raw }
  async call(name, args = {}, timeoutMs = 60_000) {
    const t = Date.now();
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = r.content || [];
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      images: content.filter((c) => c.type === 'image'),
      isError: !!r.isError,
      structured: r.structuredContent,
      ms: Date.now() - t,
      raw: r,
    };
  }

  close() {
    try {
      this.proc.kill();
    } catch {}
  }
}
