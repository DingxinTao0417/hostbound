"""Hostbound 声音服务（显卡）：faster-qwen3-tts（CUDA Graphs）+ 选定的系统音色，只在本机提供 HTTP 接口。

  GET  /health                        → {"ready": true, "engine": "qwen", "voice": "...", "sampleRate": 24000}
  POST /tts    {"text": "...", "id"}  → 边生成边返回 16 位单声道 PCM（分块传输），响应头 X-Sample-Rate
  POST /cancel {"id"}                 → 打断正在生成的那一句（不带 id 就打断当前这句）

用法：voice\\.venv\\Scripts\\python.exe voice\\server.py [--port 5181] [--parent-pid PID] [--bench]
跟 Qwen3-TTS 自带工具共用一把锁（同一时间只加载一个模型，免得显存不够）；拿不到锁就退出，返回码 4。
带 --parent-pid 时，那个进程（大脑）一退出，服务就跟着退出，免得留下孤儿进程占着显存。
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from qwen_env import QWEN, ROOT, MODELS

# 系统音色：自己设计过的在 data/voice/system，没有就用仓库自带的 voice/default
VOICE_DIR = next((d for d in (ROOT / 'data' / 'voice' / 'system', ROOT / 'voice' / 'default') if (d / 'voice.json').exists()), ROOT / 'voice' / 'default')
SAMPLE_RATE = 24000
EXIT_OOM, EXIT_BUSY, EXIT_NO_VOICE, EXIT_NO_MODEL = 3, 4, 5, 6

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8')


def log(*args):
    print(time.strftime('%H:%M:%S'), *args, flush=True)


class Engine:
    def __init__(self, model_dir, voice_dir, chunk_size):
        import numpy as np
        import torch
        from faster_qwen3_tts import FasterQwen3TTS
        self.np = np
        meta = json.loads((voice_dir / 'voice.json').read_text('utf-8'))
        self.voice = meta.get('name', '')
        self.ref = str(voice_dir / meta['ref'])
        self.ref_text = meta['refText']
        self.chunk_size = chunk_size
        started = time.perf_counter()
        self.model = FasterQwen3TTS.from_pretrained(str(model_dir), device='cuda', dtype=torch.bfloat16,
                                                    attn_implementation='sdpa', local_files_only=True)
        log(f'模型加载 {time.perf_counter() - started:.1f}s，{torch.cuda.get_device_name(0)}')
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.current = None

    def cancel(self, req_id=None):
        if req_id is None or req_id == self.current:
            self.cancelled.set()

    def stream(self, text, req_id=None):
        """逐块产出 int16 PCM；被 cancel 时提前结束。同一时间只生成一句。"""
        with self.lock:
            self.current = req_id
            self.cancelled.clear()
            gen = self.model.generate_voice_clone_streaming(
                text=text, language='Chinese', ref_audio=self.ref, ref_text=self.ref_text,
                chunk_size=self.chunk_size, max_new_tokens=720)
            try:
                for audio, sr, _timing in gen:
                    if sr != SAMPLE_RATE:
                        raise RuntimeError(f'意外的采样率 {sr}')
                    if self.cancelled.is_set():
                        break
                    yield (self.np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
            finally:
                gen.close()
                self.current = None


engine = None
ready = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'{}') if n else {}

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ready': ready, 'engine': 'qwen', 'voice': engine.voice if engine else '',
                                    'sampleRate': SAMPLE_RATE})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        req = self._body()
        if self.path == '/cancel':
            if engine:
                engine.cancel(req.get('id'))
            return self._json(200, {'ok': True})
        if self.path != '/tts':
            return self._json(404, {'error': 'not found'})
        if not ready:
            return self._json(503, {'error': 'warming up'})
        text = (req.get('text') or '').strip()
        if not text:
            return self._json(400, {'error': 'empty text'})
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('X-Sample-Rate', str(SAMPLE_RATE))
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        started = time.perf_counter()
        first = None
        size = 0
        gen = engine.stream(text, req.get('id'))
        try:
            for pcm in gen:
                if first is None:
                    first = time.perf_counter() - started
                size += len(pcm)
                self.wfile.write(b'%X\r\n%s\r\n' % (len(pcm), pcm))
                self.wfile.flush()
            self.wfile.write(b'0\r\n\r\n')
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            gen.close()
        audio = size / 2 / SAMPLE_RATE
        spent = time.perf_counter() - started
        log(f'tts {len(text)} 字：首块 {first or 0:.2f}s，音频 {audio:.1f}s，用时 {spent:.1f}s'
            f'（{audio / spent if spent else 0:.2f} 倍实时）')


def watch_parent(pid):
    """等父进程（大脑）退出，然后自己也退出。
    不用“读标准输入读到结尾”的办法：Windows 上一个线程阻塞读管道时，别的线程起子进程会卡死（加载模型时就会起）。"""
    if os.name == 'nt':
        import ctypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.OpenProcess.restype = ctypes.c_void_p
        handle = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if handle:
            k32.WaitForSingleObject(ctypes.c_void_p(handle), 0xFFFFFFFF)
    else:
        while os.getppid() == pid:
            time.sleep(2)
    os._exit(0)


def bench():
    """跑一遍示例句，打印出声延迟和速度，音频存到 data/voice/bench。"""
    import numpy as np
    import soundfile as sf
    out = ROOT / 'data' / 'voice' / 'bench'
    out.mkdir(parents=True, exist_ok=True)
    lines = ['系统已启动。宿主，请下达指令。', '检测到高危操作，请宿主授权。',
             '任务完成。已为宿主打开计算器，七加八等于十五。', '限时任务：补充水分。剩余时间，二十九分五十九秒。']
    for i, text in enumerate(lines, 1):
        started = time.perf_counter()
        first = None
        chunks = []
        for pcm in engine.stream(text):
            first = first or time.perf_counter() - started
            chunks.append(np.frombuffer(pcm, dtype='<i2'))
        wav = np.concatenate(chunks)
        spent = time.perf_counter() - started
        sf.write(out / f'{i}.wav', wav, SAMPLE_RATE, subtype='PCM_16')
        log(f'{i}: 首块 {first:.2f}s，音频 {len(wav) / SAMPLE_RATE:.1f}s，用时 {spent:.1f}s'
            f'（{len(wav) / SAMPLE_RATE / spent:.2f} 倍实时）')


def main():
    global engine, ready
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5181)
    parser.add_argument('--model', default='Qwen3-TTS-12Hz-1.7B-Base')
    parser.add_argument('--chunk', type=int, default=8, help='每块多少个编码步（12 步约 1 秒）')
    parser.add_argument('--parent-pid', type=int, default=0)
    parser.add_argument('--bench', action='store_true')
    args = parser.parse_args()

    if not (VOICE_DIR / 'voice.json').exists():
        log('还没有选定系统音色（data/voice/system 或 voice/default 里的 voice.json）')
        os._exit(EXIT_NO_VOICE)
    if not (MODELS / args.model).exists():
        log(f'没找到 Qwen3-TTS 模型：{MODELS / args.model}（装法见 README「显卡版系统声音」）')
        os._exit(EXIT_NO_MODEL)
    QWEN.mkdir(parents=True, exist_ok=True)

    from filelock import FileLock, Timeout
    lock = FileLock(str(QWEN / 'runtime.lock'))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        log('Qwen3-TTS 正被别的程序占用')
        os._exit(EXIT_BUSY)

    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()
    if not args.bench:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        log(f'监听 127.0.0.1:{args.port}')

    import torch
    try:
        engine = Engine(MODELS / args.model, VOICE_DIR, args.chunk)
        started = time.perf_counter()
        engine.model.warmup()
        for _ in engine.stream('系统预热完成。'):
            pass
        log(f'预热 {time.perf_counter() - started:.1f}s，显存 {torch.cuda.max_memory_allocated() / 2 ** 30:.2f} GiB')
    except torch.cuda.OutOfMemoryError:
        log('显存不足')
        os._exit(EXIT_OOM)
    ready = True
    log('ready')
    if args.bench:
        bench()
        os._exit(0)
    threading.Event().wait()


if __name__ == '__main__':
    main()
