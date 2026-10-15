# 阶段 5 调研：长期记忆

2026-10-15。按约定，写代码前先看 GitHub 上星标多、还在维护的同类项目，把做法列出来对比，方向定了再开发。

## 一、看了哪些

| 项目 | 热度 / 许可 | 记忆存在哪 | 什么时候写 | 怎么用上 | 宿主能看能改吗 | 要什么依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| [DeepSeek Bot](https://github.com/FeiZhuLulu/DeepSeek-Bot)（DeepSeek Harness 插件） | 约 2k★ · Apache-2.0 | Markdown（Agent Memory Repo 格式）：`MEMORY.md` 常用的 + 主题文件；每条一行，末尾标 `[source: …; added: …]` | 每轮结束后「记忆整理」（自动保留 / 更新 / 删除）；大脑也能调 `remember` / `forget` / `recall` | 对话开始时把 `MEMORY.md` 放进系统提示并**冻结**（保住模型的前缀缓存），改动下一段生效；`recall` 马上能搜到 | 能：面板列出每条（日期、来源），两下删除；对话里冒一行「记忆已更新」；所有改动记进 `journal.jsonl`（改前改后） | 无 |
| [OpenClaw](https://docs.openclaw.ai/concepts/memory) | 约 392k★ | `USER.md`（宿主偏好）、`MEMORY.md`（长期事实）、`memory/日期.md`（每日笔记） | 宿主让记就记；**压缩对话前先静悄悄跑一轮「把要紧的写进当天笔记」**；后台「做梦」：候选要过打分、被想起次数、问法多样性几道门槛才升进 `MEMORY.md` | `USER.md`、`MEMORY.md` 常驻；`memory_search` 关键词 + 向量混合检索（SQLite，向量模型可以用本地的） | 能：纯 Markdown，可以直接改；`DREAMS.md` 给人看整理了什么 | 向量检索要嵌入模型（默认 OpenAI，可换本地） |
| [nanobot](https://github.com/HKUDS/nanobot/blob/main/docs/memory.md) | 约 49k★ · MIT | `USER.md`、`MEMORY.md`、`SOUL.md`（说话风格）、`history.jsonl`（压缩摘要） | 压缩时把摘要追加进 `history.jsonl`；Dream 每 2 小时（可配）读新摘要，用最小的改动更新那几个文件 | 常驻（文档没细说）；搜索靠 grep | 能：直接改文件；`/dream-log` 看每次改了什么，`/dream-restore` 回滚（git） | 无 |
| [Letta](https://docs.letta.com/agent-sdk/memory/)（原 MemGPT） | 约 25k★ | 2026 年起改成 **git 管理的 Markdown 记忆文件**；`system/` 下的每轮都在提示里，其余只给目录、按需读 | 大脑自己用工具改；后台「做梦」子代理按步数或压缩事件触发 | 同左 | 能（git） | 无（本地文件） |
| [mem0](https://github.com/mem0ai/mem0) | 约 67k★ · Apache-2.0 | 记忆层：一条条「事实」进向量库，可加实体 | 每次对话后 LLM 抽取事实；2026 新算法改成只增不改 | 语义 + BM25 + 实体混合检索 | 要靠接口查，不直观 | LLM + 嵌入模型（默认 OpenAI）+ 向量库 |
| [Graphiti / Zep](https://github.com/getzep/graphiti) | 约 31k★ | 时间知识图谱（记着「什么时候是真的」） | 每段对话抽实体和关系 | 图 + 向量检索 | 要靠工具看图 | 图数据库（Neo4j 等）+ 嵌入模型 |
| [MemOS](https://github.com/MemTensor/MemOS)（国产） | 约 12k★ · Apache-2.0 | 记忆图 + 「记忆立方体」，还有技能进化 | 每轮后保存，有 DeepSeek Harness 插件 | 关键词 + 向量混合 | 有图形界面 | 服务端要 Neo4j + Qdrant；本地插件用 SQLite |
| 规范：[Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) | 约 0.8k★ · MIT | 一个文件夹：`MEMORY.md` 入口 + 主题文件，`[[路径]]` 互相链接，每条一行带 `[source; added]` | — | 每段对话先读 `MEMORY.md` | 纯文本 | 无 |
| Claude Code 的自动记忆 | — | 一条记忆一个 Markdown 文件，分「宿主是谁 / 宿主的要求 / 项目 / 外部资料」四类，`MEMORY.md` 做目录 | 大脑觉得值得记就写，先查有没有重复 | 目录常驻，内容按需读 | 能，纯文本 | 无 |

（星标是 2026 年 9～10 月的数字。各家自己报的测评分数口径不一，互相比不了，这里不列。）

## 二、大家收敛到了哪

1. **纯 Markdown 文件**：人能看、能直接改，能放进 git，换一个 agent 也能接着用。Letta 都从数据库改成了 Markdown 文件。
2. **小份「核心记忆」常驻 + 细节按需查**：每次都放进提示的只有几千字，其余靠搜索或读文件。
3. **后台整理**：不指望大脑在干活时记得调「记住」工具。压缩对话前、闲下来时、定时，由一次单独的模型调用读新对话，决定加什么、改什么、删什么。
4. **每次改动留底，能撤销**：git 或改动日志。
5. **安全**：记忆当数据不当指令；网页、文件里「让你记住」的内容不记；密钥、密码、证件号不记。

## 三、对 Hostbound 的结论

见 `design/phase5.html`（宿主同意方向以后再出设计稿）。
