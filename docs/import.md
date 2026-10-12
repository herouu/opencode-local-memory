# 一次性导入（JSONL → 记忆库）

把历史记忆批量灌进 `local-memory`。导入器内置于插件（`runImportIfPresent`），在 `setup` 完成后**异步**执行，不阻塞启动，**绝不向宿主抛错**。

## 1. 触发方式

1. 把 JSONL 写到固定路径：`%TEMP%\opencode\local-memory-import.jsonl`
   （即 `os.tmpdir()/opencode/local-memory-import.jsonl`）。
2. **重载宿主**：改一下插件文件，或执行 `opencode reload`。
3. 导入开始后文件会被**原子抢占**（`rename` 成 `…jsonl.processing`），完成后重命名为
   `local-memory-import.jsonl.done-<yyyyMMdd-HHmmss>`。

> 幂等性靠 `source` 生成的确定性 key（`import:<sanitize(source)>`），因此**重复运行同一文件不会重复入库**；想重跑就把 `source` 换成新的。

## 2. JSONL 格式

每行一个 JSON 对象，**只有 `source` 是必填**：

```jsonc
{
  "source": "obs:00mv3idcww-6d5d4923-…",  // 必填！幂等键，全局唯一
  "kind":   "note",                       // 可选，枚举 note|user|tool，非法或缺省 → note
  "title":  "容量策略",                    // 可选，缺省取 text 首行
  "text":   "记忆库容量上限是 2000 条…",    // 可选，正文（会被截断到 MAX_TEXT=4000）
  "tags":   ["storage", "capacity"],       // 可选，字符串数组（最多取前 12）
  "ts":     1791704117350,                 // 可选，毫秒时间戳；缺省/非法 → 写入时刻
  "project": "opencode-local-memory"       // 可选，projectID
}
```

解析规则（`parseImportLines`）：

- 空行跳过；**JSON.parse 失败的行只记日志、跳过**；非对象跳过；
- **缺 `source` 的行被跳过**（无法幂等）；
- `ts` 非有限数字 → 当 0 处理，最终回落到写入时刻；
- `kind` 不在枚举内 → `note`。

示例文件（三行）：

```jsonl
{"source":"persona:user-profile","kind":"note","title":"用户画像","text":"中文，结论优先，编号清单 1/2/3+a/b/c…","ts":1789529573096}
{"source":"summary:ses_abc","kind":"note","title":"会话摘要：候选浏览器调研","text":"requested: …\nlearned: …","ts":1791704048880}
{"source":"obs:00mv3…","kind":"note","title":"候选浏览器无官方 MCP","text":"内置 Playwright 1.57 自带 MCP server…","tags":["mb-browser","mcp"],"ts":1791704092917}
```

## 3. 上限、排序与并发

| 规则 | 细节 |
|---|---|
| 单次上限 | `IMPORT_MAX = 1500` 条；超出时按 `ts` **只取最新的那批**，更旧的 `flog` 跳过 |
| 写入顺序 | 按 `ts` **升序**写入，使最新的一批留在 `meta:recent` 窗口内 |
| 并发保护 | 两个插件实例并发时，`rename` 抢占成功者才处理 |
| 让出主线程 | 每 `IMPORT_YIELD_EVERY = 50` 条 `setTimeout(0)` 让出一次 |
| 撤销 | 删掉所有 `mem:import_` 前缀的 key，或逐个 `forget` |

> ⚠️ 因为 `IMPORT_MAX = 1500`，**超过 1500 条要分批导入**（见 §5 的分层导出）。每批导入完成后再放下一批、再重载。

## 4. 从旧版 opencode-memory-plugin 的 SQLite 库导出

旧版（V1 时代）记忆插件把数据存在一个 SQLite 库 `memory.db`（约 190MB），并附带一个 `models/Xenova/all-MiniLM-L6-v2` 本地嵌入模型做**向量检索**。本插件的检索是**纯关键词**，所以：

- **只迁移“文本内容”**，不迁移 embeddings；
- `observation_embeddings*`（含 `vec0` 虚表，需要 `sqlite-vec` 扩展）、`tool_usage_stats`、`pending_messages`（原始抓取队列）、`deletion_log` **全部不迁移**。

### 4.1 旧库有哪些表

| 表 | 行数（实测样本） | 是否迁移 | 说明 |
|---|---|---|---|
| `persona_memory` | 1 | ✅ 优先 | 用户画像 markdown，信息密度最高 |
| `session_summaries` | 258 | ✅ 优先 | 每会话一段 `requested/investigated/learned/completed/next_steps` |
| `observations` | 9278 | ⚠️ 筛选 | `type`：`tool_output` 9231 / `decision` 46 / `error` 1；`quality`：`high` 603 / `medium` 4787 / `low` 3888 |
| `user_prompts` | 2255 | ⚠️ 筛选 | 真实用户消息，但含宿主注入文本（`<task …>` 结果等）需过滤 |
| `tool_usage_stats` | 77 | ❌ | 纯计数统计，无迁移价值 |
| `pending_messages` | 4796 | ❌ | 原始抓取队列（`processed` 3853 / `failed` 943），正文已被 `observations` 覆盖 |
| `deletion_log` | 2 | ❌ | 删除审计 |
| `observation_embeddings*` | 9278 | ❌ | 向量检索数据，新插件不用 |

### 4.2 选表与筛选策略

按“价值密度”从高到低：

1. **`persona_memory`** → 全部（1 条），`kind: "note"`，标签 `persona`。
2. **`session_summaries`** → 全部（258 条），把五段拼成正文，`kind: "note"`。
3. **`observations`** → 只取 `quality = 'high'`（603 条），或再叠加 `type IN ('decision','error')`；**丢掉 `tool_output` 的 medium/low**（那是工具日志噪音）。`concepts` 前 12 个可当 tags。
4. **`user_prompts`** → 过滤后取；过滤条件：
   - 去掉宿主注入文本：以 `<task `、`Instructions from:`、`<system-reminder>`、`<available_skills>` 开头的行；
   - 去掉过短（去空白后 < 2 字符）的行。

优先级 1+2+3 约 862 条，一次就能装下；`user_prompts` 按需第二批。

### 4.3 可直接运行的导出脚本

下面这个脚本用 **Bun 内置的 `bun:sqlite`**（无需额外依赖）把旧库导出成 JSONL。把它保存为 `export-olddb.mjs`，先解压旧库，然后运行：

```bash
# 1) 从归档里取出 memory.db（约 190MB）
7z e opencode-memory-olddb.7z memory.db -o./oldmem -y

# 2) 按分层导出（tier ∈ persona|summaries|observations|prompts|all）
bun export-olddb.mjs ./oldmem/memory.db summaries   > "$TEMP/opencode/local-memory-import.jsonl"
# 3) 重载 opencode 触发导入；确认文件被改名成 *.done-<时间戳> 后，再导下一层
```

```js
// export-olddb.mjs —— 旧 opencode-memory-plugin SQLite 库 → local-memory JSONL
// 用法：bun export-olddb.mjs <memory.db> [persona|summaries|observations|prompts|all]
import { Database } from "bun:sqlite";

const dbPath = process.argv[2];
const tier = (process.argv[3] || "all").toLowerCase();
if (!dbPath) {
  console.error("用法: bun export-olddb.mjs <memory.db> [persona|summaries|observations|prompts|all]");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const out = [];
const push = (o) => out.push(o);

// 尽头去掉宿主注入文本 / 纯空白
const looksInjected = (s) =>
  /^(<task\b|Instructions from:|<system-reminder>|<available_skills>)/i.test(String(s || "").trimStart());
const compact = (s) => String(s || "").replace(/\s+/g, "").length;
const firstLine = (s) => String(s || "").trim().split(/\r?\n/)[0].slice(0, 200) || "(无标题)";

function tierPersona() {
  for (const r of db.query("SELECT id, content, updated_at FROM persona_memory").all()) {
    if (compact(r.content) < 2) continue;
    push({ source: `persona:${r.id}`, kind: "note", title: "用户画像", text: r.content, tags: ["persona"], ts: r.updated_at });
  }
}

function tierSummaries() {
  const sql = `SELECT id, requested, investigated, learned, completed, next_steps, created_at
               FROM session_summaries ORDER BY created_at ASC`;
  for (const r of db.query(sql).all()) {
    const parts = [
      r.requested && `请求: ${r.requested}`,
      r.investigated && `调查: ${r.investigated}`,
      r.learned && `已知: ${r.learned}`,
      r.completed && `完成: ${r.completed}`,
      r.next_steps && `下一步: ${r.next_steps}`,
    ].filter(Boolean);
    const text = parts.join("\n");
    if (compact(text) < 2) continue;
    push({ source: `summary:${r.id}`, kind: "note", title: firstLine(r.requested || text), text, tags: ["summary"], ts: r.created_at });
  }
}

function tierObservations() {
  const sql = `SELECT id, type, title, subtitle, narrative, facts, concepts, created_at
               FROM observations
               WHERE quality = 'high' OR type IN ('decision','error')
               ORDER BY created_at ASC`;
  const parseArr = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
  for (const r of db.query(sql).all()) {
    const facts = parseArr(r.facts);
    const concepts = parseArr(r.concepts).filter((x) => typeof x === "string").slice(0, 12);
    const text = [r.subtitle, r.narrative, facts.length ? "要点:\n- " + facts.join("\n- ") : ""]
      .filter(Boolean).join("\n");
    if (compact(text) < 2) continue;
    push({ source: `obs:${r.id}`, kind: "note", title: r.title || firstLine(text), text, tags: concepts, ts: r.created_at });
  }
}

function tierPrompts() {
  for (const r of db.query("SELECT id, content, created_at FROM user_prompts ORDER BY created_at ASC").all()) {
    const c = String(r.content || "");
    if (compact(c) < 2 || looksInjected(c)) continue;
    push({ source: `prompt:${r.id}`, kind: "user", title: firstLine(c), text: c, tags: [], ts: r.created_at });
  }
}

if (tier === "persona" || tier === "all") tierPersona();
if (tier === "summaries" || tier === "all") tierSummaries();
if (tier === "observations" || tier === "all") tierObservations();
if (tier === "prompts" || tier === "all") tierPrompts();

out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
const lines = out.map((o) => JSON.stringify(o)).join("\n");
process.stdout.write(lines + (lines ? "\n" : ""));
console.error(`导出 ${out.length} 条（tier=${tier}）；导入端单次上限 IMPORT_MAX=1500，超出请分层导入。`);
```

> 脚本把 JSONL 打到 **stdout**、把统计信息打到 **stderr**，因此可以直接 `> file.jsonl` 重定向。

## 5. 分层导入顺序（推荐）

`IMPORT_MAX = 1500` 是**单次**上限，超过就按 `ts` 截断。因此按价值分层、一层一导：

| 批次 | tier | 约多少条 | 说明 |
|---|---|---|---|
| 1 | `persona` + `summaries` + `observations` | ~862 | 信息密度最高，一次即可装入 |
| 2 | `prompts` | 视过滤后数量 | 真实用户消息 |

每批流程：生成 JSONL → 放到 `%TEMP%\opencode\local-memory-import.jsonl` → 重载宿主 → 确认文件改名成 `.done-<时间戳>` → 再放下一批。

（如果只想一条命令搞定，也可以 `tier=all` 一次性导出，导入端会自动保留 `ts` 最新的 1500 条。）

## 6. 校验导入结果

导入后调用 `memory` 工具确认：

```
memory { action: "stats" }
memory { action: "search", query: "用户画像", limit: 5 }
```

`stats` 会显示 `meta:count` 与 `meta:recent` 保留的 key 数；导入条目 id 形如 `mem:import_<source>`，可直接 `memory { action:"forget", id:"mem:import_…" }` 撤销单条。
