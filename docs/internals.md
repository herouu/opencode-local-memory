# 内部设计（internals）

本文记录 `local-memory.ts` 的存储设计、钩子载荷、容量/打分算法与已知坑。所有载荷字段均以 V2 宿主实际传入为准（已由宿主二进制核实）。

## 1. 存储设计

存储后端是 **`ctx.storage`** —— 宿主提供的插件私有命名空间，语义等价于一个 **durable JSON map**：`get(key)` / `set(key, value)` / `remove(key)` / `scan({prefix, after, limit})`，值会被序列化（写入后不可依赖对象引用）。

### 1.1 key 前缀一览

| key / 前缀 | 值类型 | 含义 |
|---|---|---|
| `mem:` | object | 一条记忆条目。完整 key 形态：`mem:<16 位补零 ts>-<3 位 seq>-<rand>` |
| `mem:u_…` | object | 由用户消息产生的条目（确定性 key：`mem:u:<sessionID>:<textHash>`） |
| `mem:t_…` | object | 由工具调用产生的条目（确定性 key：`mem:t:<sessionID>:<callID>`） |
| `mem:import_…` | object | 由一次性导入产生的条目（确定性 key：`mem:import:<source>`） |
| `seen:p:<sessionID>` | `string[]` | 该会话已处理的 `messageID`（去重，最多留 `SEEN_KEEP=200`） |
| `seen:t:<sessionID>` | `string[]` | 该会话已处理的 tool `callID`（去重，最多留 200） |
| `meta:count` | `number` | 条目总数计数器（容量治理用，避免每次全量 scan） |
| `meta:recent` | `string[]` | 最近写入的 `mem:` key，**旧→新**排列；同时是保留窗口与打分窗口 |

> `sanitizeKey(input)` 会把非 `[A-Za-z0-9._-]` 字符替换成 `_`，并只保留末 80 字符，因此确定性 key 不会因为 `sessionID`/`source` 里的特殊字符而失控。

### 1.2 条目 schema

```jsonc
{
  "v": 1,                         // schema 版本
  "id": "mem:0001791…-001-abc123",// 自身 key（与 storage key 相同）
  "ts": 1791704117350,            // 毫秒时间戳（导入时可带入原始 ts）
  "sessionID": "ses_…",           // 来源会话（导入条目为空串）
  "projectID": "proj_…",          // 来源项目（取不到则 "unknown"）
  "kind": "user" | "tool" | "note",
  "title": "…",                   // ≤ MAX_TITLE=200
  "text": "…",                    // ≤ MAX_TEXT=4000
  "tags": ["…"]                   // ≤ 12 个
}
```

约束：`title` 截断到 200；`text` 截断到 4000；工具条目正文另受 `MAX_TOOL_TEXT=1000`（成功）/ `ERROR_KEEP_MAX=800`（失败）限制；`tags` 最多 12 个，空串被过滤。

## 2. 钩子与载荷

插件注册 **3 个钩子 + 1 个工具**，全部包在 try/catch 里，**绝不向宿主抛错、绝不阻塞请求**。

### 2.1 `session.hook("prompt", cb)`

记录用户消息。

```ts
// cb(event) 的载荷（V2 宿主实测）
{
  sessionID: string,
  messageID: string,
  prompt: { text: string },
  delivery: string
}
```

行为：`compactLength(text) < MIN_PROMPT_CHARS(=1)` 跳过；按 `messageID` 去重（`seen:p:<sessionID>`）；写入用确定性 key `u:<sessionID>:<textHash>`，**非 exactly-once**，并发/重试由去重与确定性 key 共同兜底。

> 注意：**并非所有前端都会触发本钩子**（Code Mode 宿主实测 0 次）。因此用户消息还有第二条捕获路径，见 §2.3。

### 2.2 `tool.hook("execute.after", cb)`

记录工具调用摘要。

```ts
// cb(event) 的载荷（V2 宿主实测）
{
  tool: string,
  sessionID: string,
  agent: string,
  messageID: string,
  id: string,          // tool callID
  input: object,
  status: "completed" | "error" | …,
  result?: object,     // 成功时
  error?: object       // 失败时
}
```

行为：

- `DEFAULT_SKIP_TOOLS` 命中的工具直接跳过（`read`/`glob`/`grep`/`ls`/`list`/`todowrite`/`todoread`/`ast_grep_search`/`memory`/`local-memory`/`execute`），可用 `LOCAL_MEMORY_SKIP_TOOLS` 追加。
- 按 `id`（callID）去重（`seen:t:<sessionID>`）。
- `SUMMARY_ONLY_TOOLS`（`shell`/`edit`/`write`/`patch`/`apply_patch`/`webfetch`/`websearch`/`task`/`subagent`/`skill`）**成功时只留入参摘要**（`SUMMARY_MAX=200`），避免整屏输出灌满记忆；**失败时例外**，保留截断后的错误文本（`ERROR_KEEP_MAX=800`）。
- 标题形如 `"<tool> · <status>"`，tags 为 `[tool, status]`。

### 2.3 `session.hook("context", cb)`

注入 `<memory>` 上下文。

```ts
// cb(event) 的载荷（V2 宿主实测）
{
  sessionID: string,
  model: { providerID: string, modelID: string },
  system: Array<{ type: "text", text: string }>,   // ← 只往这里 push
  messages: Array<…>,                                // ← 只读，绝不改写
  options: object,
  agent: string,
  tools: object
}
```

行为（顺序）：

1. `collectUserTexts(event.messages, 5)` 取最近几条 user 文本；
2. **兜底捕获**：把最近 2 条落库（`kind: "user"`，确定性 key `u:<sessionID>:<textHash>`，与 `prompt` 钩子共用同一 key）；
3. 选第一条能 tokenize 的文本作为 query；无 token 则回退到 `lastPrompt`；
4. 全量回读打分（带 45s 缓存），取 top 12，渲染 `<memory>` 块；
5. **只 `event.system.push({ type: "text", text: block })`** —— 不改 `event.messages`、不写持久历史。

无关键词、无记忆、无相关条目、或渲染块超 `CONTEXT_BUDGET` 时，一律不注入（省钱）。

## 3. 容量与打分

### 3.1 常量

| 常量 | 值 | 用途 |
|---|---|---|
| `MAX_ENTRIES` | 2000 | 总条目上限 |
| `RECENT_MAX` | 2000 | `meta:recent` 保留上限（**必须 == MAX_ENTRIES**） |
| `RECENT_TAKE` | 2000 | 打分回读窗口 |
| `TRIM_BATCH` | 32 | 触发治理时一次删多少条最旧 |
| `CACHE_TTL_MS` | 45000 | 语料缓存 TTL |
| `MAX_TEXT` | 4000 | 单条正文上限 |
| `CONTEXT_BUDGET` | 6000 | 注入块字符预算 |
| `CONTEXT_MAX_ITEMS` | 12 | 注入条目数上限 |
| `HALF_LIFE_DAYS` | 14 | 时间衰减半衰期 |

### 3.2 惰性批量淘汰（软上限）

`pushRecent` 在每次写入后检查：

```
overflow = keys.length - RECENT_MAX
count    = meta:count + 1
if (overflow > 0 || count > MAX_ENTRIES):
    batch = max(overflow, count > MAX_ENTRIES ? TRIM_BATCH : 0)
    删除 keys 最旧的 min(batch, keys.length-1) 条
```

含义：**2000 是软上限**。因为它按批次（32 条）删，任一时刻 `meta:recent` 可能比 2000 多出至多一个批次（≤ 2032）。删的是真正最旧的条目（`sRemove`），不只是从窗口里摘除。

### 3.3 打分

```
for 每个 token:
  若 token 出现在 tags   → +4
  若 token 出现在 title  → +3
  若 token 出现在 body   → +1
  （三者独立累加：同一个 token 可同时命中，最多 +8）

基础加权：kind=="user" → +3，kind=="note" → +2（工具条目无加成）
时间衰减：score / (1 + ageDays / 14)
score <= 0 的条目直接丢弃
```

输出按 score 降序，取前 `limit`（`memory` 工具）或前 `CONTEXT_MAX_ITEMS`（注入）。

### 3.4 语料缓存

`loadRecentRecords` 维护一个进程内 `corpus` 缓存（`{ ts, sessionID, records }`）：

- 缓存命中条件：TTL 未过期且 `sessionID` 一致；
- 任何写入（`addEntry`）会 `invalidateCorpus()` 使缓存失效；
- 因此“连续对话只付一次全量回读”。

实测：**1270 条冷启约 200ms，缓存命中约 20ms**。

## 4. 已知坑

1. **双实例加载**：宿主会把同一插件文件加载两次，读-改-写去重挡不住并发 → 用确定性 key（`mem:u_…` / `mem:t_…` / `mem:import_…`）根治。
2. **`RECENT_MAX` 语义重载**：它既是保留上限又是打分窗口。早期设 300 会导致批量导入静默丢弃更旧条目。**保持 `RECENT_MAX == MAX_ENTRIES`。**
3. **`instructions` 数组在 V2 不生效**：官方 v2 `docs/instructions` 声明“接受但不解析 `files`/`glob`/`URL`”，只有 `AGENTS.md` 被加载。
4. **前端差异**：部分前端不触发 `session.prompt`（Code Mode 实测 0 次），依赖 `context` 兜底。
5. **宿主注入文本过滤**：`Instructions from:` / `<system-reminder>` / `<available_skills>` / `# Code Mode` 会被 `looksLikeInjection` 挡掉。
6. **类型包**：`@opencode/plugin@2.0.x`（V2 权威），不是 `@opencode-ai/plugin`（latest 1.19）。
7. **`storage` 随时可能抛错**：所有 `sGet/sSet/sRemove/sScan` 包装成永不抛错；存储不可用时插件静默降级（不记、不注入），不影响宿主。
