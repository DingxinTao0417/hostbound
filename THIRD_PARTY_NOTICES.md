# 第三方组件和模型

Hostbound 本身用 [MIT](LICENSE) 许可。下面这些是它用到的别人的东西，各自按自己的许可。

## 仓库里自带的

| 组件 | 位置 | 许可 |
| --- | --- | --- |
| [Mermaid](https://github.com/mermaid-js/mermaid) 12.1.0 | `app/renderer/explainer/vendor/mermaid.min.js` | MIT（许可原文在同一文件夹的 `mermaid.LICENSE`） |
| 系统音色 | `voice/default/` | 用 [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)（Apache-2.0）的「音色设计」生成的原创声音，跟本项目一起按 MIT 发布 |

## `npm install` 装的

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [pi](https://pi.dev)（`@earendil-works/pi-coding-agent`） | 大脑内核 | MIT |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（`sherpa-onnx-node`） | 唤醒词、语音识别、CPU 发声 | Apache-2.0 |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | 操作网页 | Apache-2.0 |
| [Open Computer Use](https://github.com/ifuryst/open-codex-computer-use)（`open-computer-use`） | 操作软件界面（备用引擎） | MIT |
| [Electron](https://www.electronjs.org) | 桌面窗口 | MIT |
| koffi、uiohook-napi、croner、pinyin-pro、typebox | 调 Windows、全局按键、定时、拼音、工具参数 | MIT |
| node-cpal、yaml | 麦克风、读写 SKILL.md | ISC |

完整清单和版本以 `package-lock.json` 为准。

## `npm run setup` 下载的模型

都从 [k2-fsa/sherpa-onnx 的发布页](https://github.com/k2-fsa/sherpa-onnx/releases) 下载，不在仓库里。许可以各自的原项目为准：

| 模型 | 用途 | 原项目 |
| --- | --- | --- |
| sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01 | 唤醒词 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（WenetSpeech 训练） |
| sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09 | 语音识别 | [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) |
| silero_vad.onnx | 断句 | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) |
| sherpa-onnx-zipvoice-distill-int8-zh-en-emilia | CPU 发声 | [k2-fsa/ZipVoice](https://github.com/k2-fsa/ZipVoice) |
| vocos_24khz.onnx | CPU 发声的声码器 | [gemelo-ai/vocos](https://github.com/gemelo-ai/vocos) |

## 要自己装的（可选）

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [Cua Driver](https://github.com/trycua/cua) | 操作软件界面（主引擎） | MIT |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) + 模型 Qwen3-TTS-12Hz-1.7B-Base | 显卡发声 | Apache-2.0 |
| [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) | 显卡发声加速 | MIT |

Cua 的感知扩展（`cua-perception`，里面的 OmniParser 是 AGPL-3.0）没有用，也不要打包进来。
