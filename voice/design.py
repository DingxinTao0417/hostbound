"""设计系统音色：先用 Qwen3-TTS「音色设计」按描述生成参考语，再用「克隆」模型固定音色、念示例句。

用法（用 Qwen3-TTS 自己的 Python 环境运行）：
  <Qwen3-TTS 的 python.exe> voice\\design.py [--only A,B]（先设好环境变量 QWEN3_TTS_HOME）

输出在 data/voice/samples：ref-X.wav 参考语，X-1.wav… 示例句，X.pt 固定好的音色，report.json 耗时记录。
"""
import argparse
import dataclasses
import gc
import json
import time

from qwen_env import QWEN, ROOT, MODELS

OUT = ROOT / 'data' / 'voice' / 'samples'

CANDIDATES = [
    {'id': 'A', 'name': '清冷系统女声',
     'instruct': '年轻女性，声音清冷、干净、平稳，像科幻动漫里的系统提示音。语速偏快，吐字非常清晰，语气冷静克制，几乎没有情绪起伏。'},
    {'id': 'B', 'name': '冷甜少女系统',
     'instruct': '少女音，音色清亮、略带甜感，但语气冷淡克制，像动漫里绑定主角的系统精灵。语速中等偏快，吐字清晰，句尾干脆。'},
    {'id': 'C', 'name': '沉稳御姐系统',
     'instruct': '成熟女性，声音偏低、有磁性、沉稳，语气威严冷静，像高级人工智能在向主人汇报。语速中等，吐字清晰，没有多余情绪。'},
    {'id': 'D', 'name': '中性机械系统',
     'instruct': '中性的声音，听不出明显的性别，音色平直、带有机械感，像游戏里的系统广播。语速匀速，每个字都很清楚，完全没有感情。'},
]
REFERENCE = '系统提示：宿主身份验证通过，绑定完成。本系统将全程协助宿主处理电脑上的各项任务，包括打开软件、查找文件和操作网页。'
LINES = [
    '系统已启动。宿主，请下达指令。',
    '检测到高危操作，请宿主授权。',
    '任务完成。已为宿主打开计算器，七加八等于十五。',
    '限时任务：补充水分。剩余时间，二十九分五十九秒。',
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', default='', help='只做这些候选，例如 A,C')
    args = parser.parse_args()
    only = {s.strip().upper() for s in args.only.split(',') if s.strip()}
    cands = [c for c in CANDIDATES if not only or c['id'] in only]

    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    OUT.mkdir(parents=True, exist_ok=True)
    report = {'gpu': torch.cuda.get_device_name(0), 'design': {}, 'clone': {}}

    def load(kind):
        t = time.perf_counter()
        m = Qwen3TTSModel.from_pretrained(str(MODELS / f'Qwen3-TTS-12Hz-1.7B-{kind}'), device_map='cuda:0',
                                          dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True)
        torch.cuda.synchronize()
        print(f'{kind} 加载用了 {time.perf_counter() - t:.1f}s', flush=True)
        return m

    def timed(fn, **kw):
        torch.cuda.synchronize()
        t = time.perf_counter()
        with torch.inference_mode():
            wavs, sr = fn(**kw)
        torch.cuda.synchronize()
        wav = np.asarray(wavs[0], dtype=np.float32)
        if not len(wav) or not np.isfinite(wav).all():
            raise RuntimeError('生成的音频无效')
        return wav, sr, time.perf_counter() - t

    # 第一步：按描述生成参考语
    model = load('VoiceDesign')
    timed(model.generate_voice_design, text='你好。', language='Chinese', instruct=cands[0]['instruct'], max_new_tokens=256)  # 预热
    for c in cands:
        torch.manual_seed(20261014)
        wav, sr, sec = timed(model.generate_voice_design, text=REFERENCE, language='Chinese',
                             instruct=c['instruct'], max_new_tokens=1024)
        sf.write(OUT / f'ref-{c["id"]}.wav', wav, sr, subtype='PCM_16')
        report['design'][c['id']] = {'audio': round(len(wav) / sr, 2), 'gen': round(sec, 2)}
        print(f'{c["id"]} 参考语 {len(wav) / sr:.1f}s 音频，用了 {sec:.1f}s', flush=True)
    del model
    gc.collect()
    torch.cuda.empty_cache()

    # 第二步：用参考语固定音色，念示例句（正式使用时就是这条路）
    model = load('Base')
    torch.cuda.reset_peak_memory_stats()
    for c in cands:
        ref, ref_sr = sf.read(OUT / f'ref-{c["id"]}.wav', dtype='float32')
        prompt = model.create_voice_clone_prompt(ref_audio=(ref, ref_sr), ref_text=REFERENCE)
        torch.save({'items': [dataclasses.asdict(i) for i in prompt], 'name': c['name'], 'instruct': c['instruct'],
                    'ref_text': REFERENCE}, OUT / f'{c["id"]}.pt')
        if c is cands[0]:
            timed(model.generate_voice_clone, text='你好。', language='Chinese', voice_clone_prompt=prompt, max_new_tokens=256)
        rows = []
        for i, line in enumerate(LINES, 1):
            torch.manual_seed(i)
            wav, sr, sec = timed(model.generate_voice_clone, text=line, language='Chinese',
                                 voice_clone_prompt=prompt, max_new_tokens=1024)
            sf.write(OUT / f'{c["id"]}-{i}.wav', wav, sr, subtype='PCM_16')
            rows.append({'text': line, 'audio': round(len(wav) / sr, 2), 'gen': round(sec, 2)})
            print(f'{c["id"]}-{i} {len(wav) / sr:.1f}s 音频，用了 {sec:.1f}s', flush=True)
        report['clone'][c['id']] = rows
    report['clone_peak_vram_gib'] = round(torch.cuda.max_memory_allocated() / 2 ** 30, 2)
    report['candidates'] = cands
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('完成', flush=True)


if __name__ == '__main__':
    from filelock import FileLock, Timeout
    try:
        # 跟 Qwen3-TTS 自带工具共用一把锁：同一时间只加载一个模型
        with FileLock(str(QWEN / 'runtime.lock'), timeout=0):
            main()
    except Timeout:
        raise SystemExit('Qwen3-TTS 正在被别的程序使用，请先关掉它的启动窗口。')
