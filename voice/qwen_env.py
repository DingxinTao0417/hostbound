"""Qwen3-TTS 的运行环境：离线加载、用它的缓存目录和便携 sox/ffmpeg。design.py 和 server.py 共用。
Qwen3-TTS 装在哪由环境变量 QWEN3_TTS_HOME 指定（配置里的 speech.gpu.qwenHome 会传过来），不指定就是 voice/qwen3-tts；
模型放在它下面的 models 里（也可以用 QWEN3_TTS_MODELS 单独指定）。"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QWEN = Path(os.environ.get('QWEN3_TTS_HOME') or ROOT / 'voice' / 'qwen3-tts')
MODELS = Path(os.environ.get('QWEN3_TTS_MODELS', str(QWEN / 'models')))

for _name, _rel in {'HF_HOME': 'cache/huggingface', 'TORCH_HOME': 'cache/torch',
                    'XDG_CACHE_HOME': 'cache', 'NUMBA_CACHE_DIR': 'cache/numba'}.items():
    os.environ.setdefault(_name, str(QWEN / _rel))
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
_tools = [QWEN / 'tools' / 'sox-14.4.2', *(QWEN / 'tools').glob('ffmpeg-*/bin')]
os.environ['PATH'] = os.pathsep.join(map(str, _tools)) + os.pathsep + os.environ['PATH']
