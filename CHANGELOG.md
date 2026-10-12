# Changelog

本项目的所有重要变更都记录在此文件。

本文件格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

> 本文件由 [semantic-release](https://github.com/semantic-release/semantic-release) 依据
> [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 自动追加，
> **请勿手工编辑**（唯一例外是下方这一段历史种子）。升版规则见 [VERSIONING.md](VERSIONING.md)。

## [Unreleased]

## [0.1.0] - 2026-10-13

### Added

- 首个公开版本：opencode **V2 原生**本地记忆插件（单文件 `local-memory.ts`、**零 npm 依赖**、无构建步骤）。
- **三个钩子 + 一个工具**的机制组合：
  - `session.hook("prompt")` —— 记录用户消息（V1 `chat.message` 的等价物）；
  - `tool.hook("execute.after")` —— 记录工具调用摘要，跳过 `read`/`grep`/`glob`/`ls`/`execute` 等噪音工具；
  - `session.hook("context")` —— 把 `<memory>` 块 push 进 `event.system`，只影响本次模型请求，不改持久历史；
  - `memory` 工具 —— action 支持 `search` / `add` / `list` / `forget` / `stats`。
- **确定性 storage key**（`mem:u:<sessionID>:<textHash>`、`mem:t:<sessionID>:<callID>`、
  `mem:import_<source>`）：从 key 层面根治宿主**双实例加载**导致的读-改-写去重失效。
- **纯关键词检索与打分**：tags ×4 / title ×3 / body ×1 命中分 + `kind` 基础加权 + 14 天半衰期时间衰减；
  CJK 按单字切、ASCII 按词边界，无向量检索、不加载嵌入模型。
- **上下文注入预算**：top 12 条、`CONTEXT_BUDGET = 6000` 字符（≈1.5k token），超预算整块丢弃，不撑爆上下文。
- **容量治理**：`MAX_ENTRIES = RECENT_MAX = 2000`，超限惰性批删 32 条最旧；语料缓存 TTL 45s
  （实测 1270 条冷启约 200ms、缓存命中约 20ms）。
- **用户消息双路径捕获**：不触发 `session.prompt` 的前端由 `context` 钩子从 `event.messages`
  兜底捕获最近 2 条用户文本，两条路径共用同一确定性 key，因此不会重复入库。
- **宿主注入文本过滤**：过滤 `Instructions from: …`、`<system-reminder>`、`<available_skills>`、`# Code Mode`。
- **一次性导入器**：读取 `%TEMP%\opencode\local-memory-import.jsonl`（JSONL，单次上限 1500 条，
  按 `ts` 升序写入，`source` 幂等去重），完成后重命名为 `.done-<yyyyMMdd-HHmmss>`；详见 [`docs/import.md`](docs/import.md)。
- **两种免重启调试开关**：标记文件 `%TEMP%\opencode\local-memory.debug`（5s 内生效）与环境变量
  `LOCAL_MEMORY_DEBUG=1`；另有 `LOCAL_MEMORY_SKIP_TOOLS` 追加跳过名单。
- **离线测试 harness**（`tests/harness.mjs`，mock ctx 驱动、不联网）：11 组共 54 项断言，
  `bun tests/harness.mjs` 或 `node tests/harness.mjs` 皆可运行。
- **文档**：`README.md`（含 7 条已知坑）、[`docs/internals.md`](docs/internals.md)、[`docs/import.md`](docs/import.md)。

### Notes

- 已记录并写进 README 的 7 条已知坑：V1 插件在 V2 静默失效且无兼容层；`RECENT_MAX` 兼作保留上限与打分窗口
  （设小会静默丢历史）；双实例加载导致读-改-写去重失效；config 的 `instructions` 数组在 V2 不解析
  `files`/`glob`/`URL`；部分前端不触发 `session.prompt`；宿主注入文本会被当成 user 消息；类型包应选
  `@opencode/plugin@2.0.x` 而非 `@opencode-ai/plugin`（后者 latest 仍是 1.19）。
- 发行方式：**文件投放 + GitHub**（把 `local-memory.ts` 放进 `~/.config/opencode/plugin/`）。
  npm 发布通道已预留但**默认关闭**（`package.json` 的 `private: true`），启用方式见 [VERSIONING.md](VERSIONING.md)。

[Unreleased]: https://github.com/herouu/opencode-local-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/herouu/opencode-local-memory/releases/tag/v0.1.0
