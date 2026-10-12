# opencode-local-memory

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/herouu/opencode-local-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/herouu/opencode-local-memory/actions/workflows/ci.yml)

**opencode v2 原生本地记忆插件**：自动把跨会话的用户消息、工具调用摘要存进本机持久存储，并在每次模型请求前按关键词相关度注入一块 `<memory>` 上下文。单文件、**零 npm 依赖**、无需构建。

> An **opencode v2 native local-memory plugin**: it persists user messages and tool-call summaries across sessions into a plugin-private durable store, then injects a relevance-ranked `<memory>` block into each model request. Single file, **zero npm dependencies**, no build step.

## 目录

- [背景：为什么需要它](#背景为什么需要它)
- [它做什么](#它做什么)
- [安装](#安装)
- [零依赖](#零依赖)
- [检索与打分](#检索与打分)
- [容量与性能](#容量与性能)
- [去重：为什么需要确定性 key](#去重为什么需要确定性-key)
- [前端差异：用户消息的双路径捕获](#前端差异用户消息的双路径捕获)
- [注入块要过滤宿主文本](#注入块要过滤宿主文本)
- [调试](#调试)
- [一次性导入（迁移旧记忆）](#一次性导入迁移旧记忆)
- [已知坑](#已知坑)
- [已知局限](#已知局限)
- [测试](#测试)
- [版本与发布](#版本与发布)
- [许可](#许可)

## 背景：为什么需要它

opencode **V2 的插件加载器要求模块 default 导出是对象**，形如 `{ id, setup }` 或 `{ id, effect }`。而 **V1 插件（default 是函数）在 V2 里完全不跑，官方没有兼容层** —— 官方 v2 文档 `docs/build/plugins/migrate-v1` 原文：

> "V1 plugin implementations do not run in V2"

因此，很多现成的 V1 记忆插件升级到 V2 后会“静默失效”。本插件是从零按 V2 契约写的：权威类型包是 **`@opencode/plugin@2.0.x`**（注意不是 `@opencode-ai/plugin`，后者 latest 仍停留在 `1.19`，是 V1 时代的包）。

## 它做什么

只注册三个钩子和一个工具：

| 机制 | 说明 |
|---|---|
| `session.hook("prompt")` | 记录用户消息（V1 `chat.message` 的等价物；**非 exactly-once**，按 `messageID` 去重） |
| `tool.hook("execute.after")` | 记录工具调用摘要，跳过噪音工具（`read`/`grep`/`glob`/`ls`/`execute` 等） |
| `session.hook("context")` | 把 `<memory>` 块 **push 进 `event.system`**；只影响本次模型请求，**不改持久历史，绝不改写 `event.messages`** |
| `memory` 工具 | 注册一个 `memory` 工具，action = `search` \| `add` \| `list` \| `forget` \| `stats` |

存储用宿主的 **`ctx.storage`**（插件私有命名空间、durable JSON），不碰任何外部数据库。

## 安装

把 `local-memory.ts` 放进 opencode 的插件目录即可，宿主自动发现：

- 全局：`~/.config/opencode/plugin/local-memory.ts`
- 项目级：`<项目>/.opencode/plugins/local-memory.ts`

**无需**把路径写进 `opencode.json` 的 `plugin` 数组 —— 本地 `plugin/` 目录会被自动加载。

卸载：删除该文件即可。

## 零依赖

源码**不 import 任何 npm 包**（包含 `@opencode/plugin`、`effect`、`zod`），只用 Node 内置模块 `node:fs` / `node:os` / `node:path`（仅用于写调试日志）。

因此：

- **没有安装/构建步骤**；
- **不需要版本对齐**（不存在 peerDependency 冲突）；
- 工具入参的 schema 是纯字面量 JS 对象，不走 zod，也不带 `~standard` 之类的库痕迹。

## 检索与打分

**纯关键词检索，没有向量检索**（不加载任何嵌入模型）。打分规则：

```
score = Σ token 命中分
  命中 tags  × 4
  命中 title × 3
  命中 body  × 1
+ 基础加权：kind == "user" → +3，kind == "note" → +2
再乘时间衰减：score / (1 + ageDays / 14)   // 14 天半衰期
```

Tokenizer 同时支持中文与英文：CJK 汉字/假名/谚文按 **单字** 切也是 token（中文不需要分词器），ASCII 走词边界（`MIN_TOKEN_LEN = 2`），另带停用词表与 `MAX_TOKENS = 24` 上限。

注入时取 top `CONTEXT_MAX_ITEMS = 12` 条，渲染成 `<memory ...>` 块，受 `CONTEXT_BUDGET = 6000` 字符预算约束（≈1.5k token，超出整块丢弃以保证不撑爆上下文）。

## 容量与性能

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_ENTRIES` | `2000` | 总条目上限，超出删最旧 |
| `RECENT_MAX` | `2000` | `meta:recent` 保留的 key 数 = 保留上限 |
| `RECENT_TAKE` | `2000` | 相关度打分的回读窗口（与保留上限一致） |
| `TRIM_BATCH` | `32` | 每次触发治理时批量删多少条最旧 |
| `CACHE_TTL_MS` | `45000` | 语料缓存 TTL（打分窗口靠它摊销） |

打分走**全量回读**：一次读最近 `RECENT_TAKE` 条做打分，结果缓存 45s，所以连续对话只付一次回读成本。实测 **1270 条语料冷启约 200ms、缓存命中约 20ms**。

> ⚠️ **`RECENT_MAX` 的语义坑**：它**同时**是“保留上限”和“打分窗口”。早期版本把它设成 `300`，等价于“记忆只保留 300 条”—— 批量导入时会**静默丢弃更旧的条目**。务必保持 `RECENT_MAX == MAX_ENTRIES`。

## 去重：为什么需要确定性 key

宿主会把**同一个插件文件加载两次**（两个实例并发跑钩子）。这种情况下，读-改-写式的去重（先查再写）挡不住并发：两个实例会同时看到“没见过”而双双入库。

本插件从 **key 层面根治**，为可去重的写入生成**确定性 storage key**：

| 来源 | 前缀 | key 形态 |
|---|---|---|
| 用户消息 | `mem:u_…` | `mem:u:<sessionID>:<textHash>` |
| 工具调用 | `mem:t_…` | `mem:t:<sessionID>:<callID>` |
| 一次性导入 | `mem:import_…` | `mem:import_<sanitize(source)>` |

写之前先 `get` 这个确定性 key，命中即跳过，并发下也不会重复。

## 前端差异：用户消息的双路径捕获

**某些前端不会触发 `session.prompt` 钩子**（实测 Code Mode 宿主 0 次调用；CLI / TUI 会触发）。因此除了 `prompt` 钩子，`context` 钩子还会从 `event.messages` 里**兜底捕获最近 2 条用户文本**并落库。

两条路径**共用同一个确定性 key**（`u:<sessionID>:<textHash>`），所以无论哪条先写，同一条消息都只会出现一次。

## 注入块要过滤宿主文本

`event.messages` 里的 user-role 文本**不都是用户说的话** —— 宿主会把自己的物料塞进来。以下已过滤，避免污染检索：

- `Instructions from: …`（AGENTS.md 等指令）
- `<system-reminder>`
- `<available_skills>`
- `# Code Mode`

## 调试

两种开关，**无需重启宿主**（判定延迟上限 5s，因为标记文件每 5s 复查一次）：

1. **标记文件**：建 `%TEMP%\opencode\local-memory.debug`（空文件即可）即开日志；删除即关。
   - Windows：`%TEMP%\opencode\local-memory.debug`
   - 日志写到 `%TEMP%\opencode\local-memory.log`
2. **环境变量**：`LOCAL_MEMORY_DEBUG=1`（需重启宿主生效）。

追加跳过名单：`LOCAL_MEMORY_SKIP_TOOLS="foo,bar"`（逗号分隔，附加到默认跳过表之上）。

## 一次性导入（迁移旧记忆）

把待导入记录写成 **JSONL**（每行一个对象），放到 `%TEMP%\opencode\local-memory-import.jsonl`，然后**重载宿主**（改一下插件文件，或 `opencode reload`）即自动导入。导入在 `setup` 完成后**异步**执行，不阻塞启动。

- 完成后文件被重命名为 `local-memory-import.jsonl.done-<yyyyMMdd-HHmmss>`。
- **单次上限 `IMPORT_MAX = 1500` 条**（超出只取 `ts` 最新的那批，更旧的记日志跳过）。
- 按 `ts` 升序写入，使最新的一批留在 `meta:recent` 窗口内。
- **幂等**：`source` 经确定性 key（`import:<source>`）去重，重复运行同一文件不会重复入库。
- 撤销一次导入：删掉所有 `mem:import_` 前缀的 key，或逐个 `forget`。

字段格式、从旧 SQLite 库（`observations` / `user_prompts` / `session_summaries` / `persona_memory`）导出的选表与筛选策略、以及一个可直接运行的导出脚本，见 **[`docs/import.md`](docs/import.md)**。

## 已知坑

1. **V1 插件在 V2 不跑**，且无兼容层（见[背景](#背景为什么需要它)）。迁移 V1 插件时，必须把 default 改成 `{ id, setup }`。
2. **`RECENT_MAX` 同时是保留上限与打分窗口**，设小了会静默丢历史（见[容量与性能](#容量与性能)）。
3. **双实例加载**导致读-改-写去重失效；必须用确定性 key（见[去重](#去重为什么需要确定性-key)）。
4. **config 的 `instructions` 数组在 V2 不生效**：官方 v2 `docs/instructions` 明确“接受但**不解析** `files`/`glob`/`URL`”。只有 `AGENTS.md` 会被加载 —— 别再指望用 `instructions` 引额外规则文件。
5. **某些前端不触发 `session.prompt`**：靠 `context` 钩子兜底（见[前端差异](#前端差异用户消息的双路径捕获)）。
6. **宿主注入文本会被当成 user 消息**，必须过滤（见[注入块要过滤宿主文本](#注入块要过滤宿主文本)）。
7. **类型包选错**：用 `@opencode/plugin@2.0.x`，不是 `@opencode-ai/plugin`（后者 latest 是 1.19）。

## 已知局限

- 无向量检索（只做关键词匹配，不加载嵌入模型）；
- 不生成会话摘要、不做自动摘要压缩；
- 记忆上限 2000 条（超出按最旧淘汰）；
- `memory` 工具只做关键词匹配，不做语义理解。

## 测试

仓库自带一个**离线 harness**，用 mock ctx 驱动插件，不发任何模型请求、不联网：

```bash
bun tests/harness.mjs
```

覆盖 11 组共 54 项断言：V2 导出契约、钩子注册、工具注册、写入与去重、工具摘要与噪音跳过、上下文注入与预算、`storage` 读写、`memory` 工具五个 action、容量治理、`storage` 抛错时的健壮性、`cleanup`。

## 版本与发布

**发行方式（当前）**：**文件投放 + GitHub** —— 把 `local-memory.ts` 放进
`~/.config/opencode/plugin/`（或项目级 `.opencode/plugins/`）即可，不做 npm 分发。
npm 发布通道**开关已就绪但默认关闭**（`package.json` 的 `"private": true`，版本号仍会照常更新）；
将来要发 npm 只需把它改成 `false` 并配好 Trusted Publishing(OIDC)，步骤见
[`VERSIONING.md`](VERSIONING.md#7-将来要发-npm-时怎么开)。

**发版是自动的**：本仓库接入 [semantic-release](https://github.com/semantic-release/semantic-release)，
版本号由 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 提交信息推导，
**不人工改版本号**。推到 `main` 即触发，`beta` 分支产出预发布版：

| 提交 | 结果 |
|---|---|
| `fix: …` | PATCH（`0.1.0` → `0.1.1`） |
| `feat: …` | MINOR（`0.1.0` → `0.2.0`） |
| `feat!: …` / `BREAKING CHANGE:` | MAJOR（0.x 期降级为 MINOR） |
| `chore:` / `docs:` / `ci:` / `test:` | 不发版 |

流程细节、分支策略、三条版本轴的区分（插件版本 / 存储 schema 版本 / 目标 opencode 版本）、
以及「不要移动已发布 tag」「不要手改 CHANGELOG」「schema 变更必须写迁移段」等禁令，
见 **[`VERSIONING.md`](VERSIONING.md)**；逐版变更见 **[`CHANGELOG.md`](CHANGELOG.md)**。

## 许可

[MIT](LICENSE) © herouu
