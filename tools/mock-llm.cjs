// 测试用的假模型（OpenAI 兼容接口，流式）。按对话里已有几次工具结果，依次：
// 1) 先说一句话 + 调 powershell 查日期  2) 调一个会被拦下确认的删除命令  3) 根据结果收尾
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 5199);
const requests = [];

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let i = 0;
  const base = { id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-1' };
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [chunks[i++]] })}\n\n`);
      setTimeout(tick, 30);
    } else {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  tick();
}

function textChunks(text) {
  const out = [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }];
  for (let i = 0; i < text.length; i += 4) out.push({ index: 0, delta: { content: text.slice(i, i + 4) }, finish_reason: null });
  return out;
}

function toolCall(id, command) {
  return [
    { index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'powershell', arguments: '' } }] }, finish_reason: null },
    { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command }) } }] }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'tool_calls' },
  ];
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) return res.writeHead(404).end();
      const json = JSON.parse(body);
      requests.push(json);
      const sys = json.messages.find((m) => m.role === 'system' || m.role === 'developer');
      const sysText = typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content || '');
      // “是不是对系统说的”判断：带“天气”的当成闲聊，其余都算
      if (/只输出一个词/.test(sysText)) {
        const heard = JSON.stringify(json.messages.at(-1).content);
        const verdict = /天气/.test(heard) ? 'no' : 'yes';
        process.stderr.write(`[mock] classify → ${verdict}\n`);
        return sse(res, [...textChunks(verdict), { index: 0, delta: {}, finish_reason: 'stop' }]);
      }
      // 只数最后一条用户消息之后的工具结果：每句新指令都从头走一遍流程
      const lastUser = json.messages.map((m) => m.role).lastIndexOf('user');
      const toolMsgs = json.messages.slice(lastUser + 1).filter((m) => m.role === 'tool');
      process.stderr.write(`[mock] request #${requests.length}: ${toolMsgs.length} tool results, tools=${(json.tools || []).map((t) => t.function.name).join(',')}, persona=${/宿主系统/.test(sysText)}\n`);
      if (toolMsgs.length === 0) {
        sse(res, [...textChunks('收到，先查询日期。'), ...toolCall('call_1', "Get-Date -Format 'yyyy-MM-dd'")]);
      } else if (toolMsgs.length === 1) {
        sse(res, toolCall('call_2', "Remove-Item 'C:\\hostbound-mock-does-not-exist.txt'"));
      } else {
        const last = String(toolMsgs[toolMsgs.length - 1].content);
        const blocked = /拒绝/.test(last);
        sse(res, [...textChunks(blocked ? '宿主没让删，本系统不删。日期已查到。' : '【完成】日期已查到。'), { index: 0, delta: {}, finish_reason: 'stop' }]);
      }
    });
  })
  .listen(PORT, () => process.stderr.write(`[mock] listening on ${PORT}\n`));
