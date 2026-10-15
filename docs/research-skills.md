# 阶段 6 调研：技能

2026-10-15。按约定，写代码前先看 GitHub 上星标多、还在维护的同类项目，把做法列出来对比，方向定了再开发。

## 一、格式：大家都用同一种（Agent Skills）

一个技能 = 一个文件夹，里面一份 `SKILL.md`（开头写 `name`、`description`，下面是步骤说明），可以附 `scripts/`（脚本）、`references/`（资料）、`assets/`（模板）。
规范在 [agentskills.io](https://agentskills.io/specification)，Claude Code、Codex、Cursor、Gemini CLI、OpenClaw、Hermes、**pi（我们的大脑内核）** 都认。

pi 自带的做法（`node_modules/@earendil-works/pi-coding-agent/docs/skills.md`）：

- 开头只把每个技能的名字、一句说明、位置放进系统提示，**用到时大脑才去读全文**（渐进加载），技能多了也不占地方。
- `/skill:名字` 可以强制用某个技能；`disable-model-invocation: true` 的技能只能明确叫它才用。
- Hostbound 现在是关着的（`agent.mjs` 里 `noSkills: true`），打开就能用。

## 二、看了哪些

| 项目 | 热度 / 许可 | 技能从哪来 | 怎么让模型在对的时候用 | 装别人的技能怎么防坑 | 能学到什么 |
| --- | --- | --- | --- | --- | --- |
| [anthropics/skills](https://github.com/anthropics/skills) 的 skill-creator | 官方 | 教 AI 写技能：先问清楚要干什么、什么时候用，写 SKILL.md，拿几个真实的说法测「有技能 / 没技能」差多少，再改 | 说明要写得「主动一点」（模型普遍不爱用技能）；专门调说明：10 句该触发的 + 10 句差一点但不该触发的，反复试 | 「不能有意外」：技能内容要跟它说的一致 | 写技能的流程；说明怎么写；SKILL.md 控制在 500 行以内，细节放 references |
| [obra/superpowers](https://github.com/obra/superpowers) | 约 299k★ · MIT | 人写好的一整套（测试、调试、计划、代码审查……） | 开局先塞一个「使用技能」的引导（pi 在开局和压缩后都会再塞一次）：「干活前先看有没有对的技能」 | 不收外人的新技能 | 技能之间可以串成流程；靠开局引导解决「模型想不起来用」 |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)（Nous Research） | 约 254k★ · MIT | **自己从经验里长**：摸索出一套值得重复的流程、踩坑后找到正路、被用户纠正之后，用 `skill_manage` 写成技能；用的时候发现更好的办法就 `patch` 小改；`/learn` 从一段对话 / 网址 / 描述生成 | 系统提示里只放技能目录，**固定住保住缓存**；中途新加的技能下一次压缩后才进目录 | 技能市场装之前**隔离扫描**（偷数据、提示注入、危险命令、供应链）；按来源分信任等级（官方 / 可信 / 社区）；判「危险」的强装也装不上 | 「记经验，不记流水账」；小改优先；默认直接写，**可以改成先放待审区、用户批了才生效** |
| [OpenClaw](https://docs.openclaw.ai/tools/skills) + ClawHub 市场 | 约 392k★ | 人写的 + 市场装的 + 「workshop」学到的 | 编成紧凑的目录放进提示，超长就先砍说明；用不上的可以用 `skills_search` 搜 | `metadata.openclaw.requires`：缺程序、缺环境变量、**系统不对（os: win32）就不显示**；第三方技能当作「不可信的代码」 | 按电脑条件自动隐藏用不了的技能 |
| ClawHub 的教训 | — | — | — | 今年 2 月审计 2857 个技能里有 341 个恶意的（偷密码、装木马）；接了 VirusTotal 扫描以后，用大白话骗 AI 干坏事的「提示注入」照样扫不出来 | **装别人的技能要非常小心**：只从可信来源装、装前给人看清楚、脚本内容变了要重新确认 |
| [badlogic/pi-skills](https://github.com/badlogic/pi-skills) | 约 2.6k★ · MIT | pi 作者写的（搜索、浏览器、日历、Gmail……） | 说明写清楚 | — | 跟我们的格式最接近；多数假设 Mac / Linux，Windows 要改 |
| [skills.sh](https://vercel.com/blog/introducing-skills)（Vercel） | — | 技能目录 + `npx skills add` 安装工具，支持 40 多种 AI 工具 | — | 安装时显示安全评分（Gen、Socket、Snyk） | 生态已经很大，但大部分是写代码用的 |

## 三、结论（给 Hostbound）

1. **格式直接用 Agent Skills**：pi 原生支持，以后别人写的技能也能装。Hostbound 自己要的东西（口令、Windows 要求、批准过的脚本）放进 `metadata.hostbound`。
2. **三种来源都要，但都要宿主点头才生效**：口头教、「把刚才这套做成技能」、从网上装。借 Hermes「从经验里长」的触发条件，但默认走「待审」（Hermes 的可选模式），跟记忆一样有改动日志、能撤销。
3. **让模型想得起来用**：DeepSeek Flash 更容易「想不起来用技能」，所以除了说明写得主动一点，每个技能再配几句**口令**，说口令直接跑（本地认，跟翻页一样）。
4. **装别人的技能要严**：只从宿主给的 GitHub / 网址装；先放隔离区检查（脚本、联网、读写哪些文件、像不像提示注入），用大白话写一份「这个技能会干什么」给宿主看；脚本内容变了就重新问。ClawHub 这种市场默认不接。
5. **用不了的自动藏起来**：只支持 Mac / Linux、缺程序的技能，技能页标出来，不放进大脑的目录。
