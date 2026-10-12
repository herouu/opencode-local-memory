/**
 * local-memory —— opencode v2 原生本地记忆插件（单文件 / 零运行时依赖）
 * ============================================================================
 * 宿主：opencode v2（本机 2.0.26）。v2 加载器要求模块 default 导出是对象且含
 *       `id` + `setup`(函数) 或 `id` + `effect`(函数)。见本文件末尾的 default 导出。
 *
 * 依赖策略：不 import 任何 npm 包（含 @opencode/plugin、effect、zod）。
 *          仅使用 Node 内置模块（node:fs / node:os / node:path）写调试日志，
 *          与同机已跑通的 opencode-windows-encoding 插件做法一致。
 *
 * 三个钩子：
 *   session.hook("prompt",  cb) —— 记录用户消息（v1 chat.message 的等价物，非
 *                                  exactly-once，按 messageID 去重）。
 *   tool.hook("execute.after", cb) —— 记录工具调用摘要，跳过噪音工具。
 *   session.hook("context", cb) —— 按关键词相关度把 <memory> 块 push 进
 *                                  event.system。只影响本次模型请求，不写持久历史。
 *                                  **绝不改写 event.messages。**
 *
 * 存储：ctx.storage（插件私有命名空间、durable JSON）。key 前缀见下方常量。
 *       写入为「当日全量 scan 一次都没有」的增量路径：计数用 meta:count，
 *       仅当超过容量阈值时才做一次 limit=TRIM_BATCH 的 scan 删最旧。
 *       读取用自维护的 meta:recent 键列表：它同时是「保留上限」（RECENT_MAX 条，
 *       超出即删最旧，与 MAX_ENTRIES 对齐）与「相关度打分窗口」（回读最近 RECENT_TAKE 条）。
 *       注意：早期版本把 RECENT_MAX 设成 300，等于记忆只保留 300 条 —— 批量导入会静默丢弃
 *       更旧的条目，务必保持 RECENT_MAX == MAX_ENTRIES。
 *
 * 调试：设置 LOCAL_MEMORY_DEBUG=1 后写日志到 %TEMP%\opencode\local-memory.log。
 *       也可以直接建标记文件 %TEMP%\opencode\local-memory.debug（无需重启宿主，
 *       判定延迟上限 5s），删掉即关闭。
 *
 * 一次性导入器（迁移旧库记忆用，见 runImportIfPresent）：
 *   把待导入记录写成 JSONL（每行一个对象：kind/title/text/tags/ts/source/project），
 *   放到 %TEMP%\opencode\local-memory-import.jsonl。插件 setup 完成后会自己异步导入
 *   （不阻塞 setup 返回），完成后把文件重命名为
 *   local-memory-import.jsonl.done-<yyyyMMdd-HHmmss>。
 *   - 幂等：source 经 dedupeKey 生成确定性 key（前缀 mem:import_），重复运行不会重复入库。
 *   - 单次上限 IMPORT_MAX 条（超出只取 ts 最新的那批，更旧的记日志跳过）。
 *   - 导入按 ts 升序写入，使最新的一批留在 meta:recent 窗口内。
 *   - 撤销一次导入：删掉以 mem:import_ 为前缀的 key（或直接 forget 对应 id）。
 *
 * 关闭：删除本文件（见报告里的回滚步骤）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────── 常量 ───────────────────────────────

/** 插件 id（会出现在 `opencode plugin list` 的 ID 列与日志的 loading plugin 行）。 */
const PLUGIN_ID = "local-memory";

/** storage key 前缀。 */
const ENTRY_PREFIX = "mem:";          // mem:<16 位补零 ts>-<seq>-<rand>
const SEEN_PROMPT_PREFIX = "seen:p:"; // seen:p:<sessionID> -> string[]（messageID）
const SEEN_TOOL_PREFIX = "seen:t:";   // seen:t:<sessionID> -> string[]（tool callID）
const META_COUNT = "meta:count";      // number，条目总数计数器（容量治理用）
const META_RECENT = "meta:recent";    // string[]，最近写入的 key（新→旧倒序存放为旧→新）

const MAX_ENTRIES = 2000;   // 总条目上限，超过则删最旧
const TRIM_BATCH = 32;      // 每次触发治理时删多少条最旧
const MAX_TEXT = 4000;      // 单条正文截断上限
const MAX_TOOL_TEXT = 1000; // 单条工具结果截断上限
const MAX_INPUT_HINT = 300; // 工具入参摘要截断上限
const MAX_TITLE = 200;
const SEEN_KEEP = 200;      // 每 session 保留的去重 id 数
const CONTEXT_BUDGET = 6000; // 注入块字符预算（≈1.5k token）
const CONTEXT_HEADROOM = 400; // 头部/脚注预留
const CONTEXT_MAX_ITEMS = 12;
const CACHE_TTL_MS = 45000;  // 语料缓存 TTL（30–60s）
const RECENT_MAX = 2000;     // meta:recent 保留的 key 数（= 保留上限：超出即删最旧条目）
const RECENT_TAKE = 2000;    // 相关度打分窗口：与保留上限一致（全量回读，靠 CACHE_TTL 摊销）
const SCAN_PAGE = 500;       // 重建 recent 时的分页大小
const SCAN_MAX_PAGES = 8;    // 重建 recent 时的分页上限
const MIN_PROMPT_CHARS = 1;  // 去空白后短于此长度的用户消息跳过（中文用户常只回一个字）
const MAX_TOKENS = 24;       // 关键词数量上限
const MIN_TOKEN_LEN = 2;     // ASCII token 最短长度
const HALF_LIFE_DAYS = 14;   // 时间衰减半衰期

/** 默认跳过的工具（大输出 / 无信息量 / 自身）。可用 LOCAL_MEMORY_SKIP_TOOLS 追加。 */
const DEFAULT_SKIP_TOOLS = [
  "read",
  "glob",
  "grep",
  "ls",
  "list",
  "todowrite",
  "todoread",
  "ast_grep_search",
  // 自身工具：注册名是 "memory"（见 MEMORY_TOOL_INFO.name），
  // 与 PLUGIN_ID("local-memory") 不同，两个都要列，否则会把自身调用也写进记忆。
  "memory",
  PLUGIN_ID,
  // Code Mode 的执行外壳：整段代码都会进 input，噪音极大
  "execute",
];

/**
 * 只记摘要的工具：成功时只留入参摘要，不留结果正文 —— 否则整屏输出会灌满记忆。
 * 失败时例外：报错往往最值得记，保留截断后的错误文本。
 */
const SUMMARY_ONLY_TOOLS = [
  "shell",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "webfetch",
  "websearch",
  "task",
  "subagent",
  "skill",
];
const SUMMARY_MAX = 200;    // 摘要正文长度
const ERROR_KEEP_MAX = 800; // 失败时的错误正文长度

const DEBUG_ENV = process.env.LOCAL_MEMORY_DEBUG === "1";
const LOG_PATH = join(tmpdir(), "opencode", "local-memory.log");
/** 标记文件：存在即开调试。改这个文件后无需重启宿主/重设环境变量。 */
const DEBUG_FLAG = join(tmpdir(), "opencode", "local-memory.debug");

// ─────────── 一次性导入器（JSONL → 记忆库）常量 ───────────
/** 待导入文件；导入完成后会被重命名为 <本路径>.done-<时间戳>。 */
const IMPORT_PATH = join(tmpdir(), "opencode", "local-memory-import.jsonl");
/** 导入过程中的中间态文件名（原子 rename 抢占，防两个插件实例同时导入）。 */
const IMPORT_PROCESSING = IMPORT_PATH + ".processing";
/** 单次导入上限；超出则只取 ts 最新的这么多条。 */
const IMPORT_MAX = 1500;
/** 每写入多少条让出一次事件循环，避免长任务卡住宿主。 */
const IMPORT_YIELD_EVERY = 50;
/** 允许的条目类型，非法值回落 note。 */
const IMPORT_KINDS = new Set(["note", "user", "tool"]);

let debugCache = { at: 0, on: DEBUG_ENV };
/**
 * 调试开关 = LOCAL_MEMORY_DEBUG=1 或 标记文件存在。
 * 标记文件每 5s 最多探测一次，避免每次日志调用都打盘。
 */
function debugEnabled() {
  if (DEBUG_ENV) return true;
  const now = Date.now();
  if (now - debugCache.at < 5000) return debugCache.on;
  let on = false;
  try {
    on = existsSync(DEBUG_FLAG);
  } catch {
    on = false;
  }
  debugCache = { at: now, on };
  return on;
}
let logDirReady = false;

function ensureLogDir() {
  if (logDirReady) return true;
  try {
    mkdirSync(join(tmpdir(), "opencode"), { recursive: true });
    logDirReady = true;
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────── 调试日志 ───────────────────────────────

function safeJson(value, limit = 600) {
  try {
    const seen = new WeakSet();
    const s = JSON.stringify(value, (_k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      if (typeof v === "function") return "[function]";
      return v;
    });
    if (typeof s !== "string") return String(value);
    return s.length > limit ? s.slice(0, limit) + "…" : s;
  } catch (err) {
    try {
      return String(value);
    } catch {
      return "[unstringifiable]";
    }
  }
}

function flog(...parts) {
  if (!debugEnabled()) return;
  try {
    if (!ensureLogDir()) return;
    const body = parts
      .map((p) => (typeof p === "string" ? p : safeJson(p)))
      .join(" ");
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [${PLUGIN_ID}] ${body}\n`, "utf8");
  } catch {
    // 调试日志失败绝不影响宿主
  }
}

// ─────────────────────────────── 小工具 ───────────────────────────────

function clamp(value, limit) {
  let s;
  if (typeof value === "string") s = value;
  else if (value === undefined || value === null) s = "";
  else s = safeJson(value, limit + 200);
  if (s.length > limit) return s.slice(0, limit) + "…[已截断]";
  return s;
}

function firstLine(text, limit = MAX_TITLE) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return clamp(line || "(无标题)", limit);
}

function compactLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

// ─────────────────────────────── storage 包装（永不抛错） ───────────────────────────────

function hasStore(ctx) {
  return !!(
    ctx &&
    ctx.storage &&
    typeof ctx.storage.get === "function" &&
    typeof ctx.storage.set === "function"
  );
}

async function sGet(ctx, key) {
  try {
    return await ctx.storage.get(key);
  } catch (err) {
    flog("storage.get 失败", key, String(err));
    return undefined;
  }
}

async function sSet(ctx, key, value) {
  try {
    await ctx.storage.set(key, value);
    return true;
  } catch (err) {
    flog("storage.set 失败", key, String(err));
    return false;
  }
}

async function sRemove(ctx, key) {
  try {
    if (typeof ctx.storage.remove === "function") await ctx.storage.remove(key);
  } catch (err) {
    flog("storage.remove 失败", key, String(err));
  }
}

/** 返回整个 StorageScanResult；失败时返回 { entries: [] }。 */
async function sScan(ctx, options) {
  try {
    if (typeof ctx.storage.scan !== "function") return { entries: [] };
    const result = await ctx.storage.scan(options);
    if (result && Array.isArray(result.entries)) return result;
    return { entries: [] };
  } catch (err) {
    flog("storage.scan 失败", options && options.prefix, String(err));
    return { entries: [] };
  }
}

// ─────────────────────────────── key / 条目 ───────────────────────────────

let seq = 0;

function makeKey() {
  seq = (seq + 1) % 1000;
  // ts 固定 16 位 → key 的字典序 == 时间序（同毫秒内靠 seq 稳定）
  const ts = String(Date.now()).padStart(16, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ENTRY_PREFIX}${ts}-${String(seq).padStart(3, "0")}-${rand}`;
}

/** 把任意去重标识清成安全、短小的 key 片段（保留 [a-z0-9._-]）。 */
function sanitizeKey(input) {
  const s = String(input || "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return s.length > 80 ? s.slice(-80) : s;
}

function projectIDOf(ctx) {
  try {
    const loc = ctx && ctx.location;
    if (loc && loc.project && typeof loc.project.id === "string") return loc.project.id;
    if (loc && typeof loc.directory === "string") return "dir:" + loc.directory;
  } catch {
    // ignore
  }
  return "unknown";
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && typeof value.n === "number") return value.n;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

// ─────────────────────────────── 语料缓存 ───────────────────────────────

/** { ts, sessionID, records } —— 缓存的是「已回读的条目数组」，不是渲染结果。 */
let corpus = { ts: 0, sessionID: "", records: [] };
/** 最近一次 prompt 文本（按 session），用于 context 钩子拿不到用户消息时兜底。 */
const lastPrompt = new Map();

function invalidateCorpus() {
  corpus.ts = 0;
  corpus.records = [];
}

function readRecentKeys(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k) => typeof k === "string" && k.startsWith(ENTRY_PREFIX));
}

/** 一次性重建 meta:recent（仅在 key 列表缺失/为空时走这条慢路径）。 */
async function rebuildRecent(ctx) {
  const keys = [];
  let after;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const options = { prefix: ENTRY_PREFIX, limit: SCAN_PAGE };
    if (after) options.after = after;
    const result = await sScan(ctx, options);
    if (!result.entries.length) break;
    for (const entry of result.entries) {
      if (entry && typeof entry.key === "string") keys.push(entry.key);
    }
    if (!result.next) break;
    after = result.next;
  }
  const tail = keys.slice(Math.max(0, keys.length - RECENT_MAX));
  if (tail.length) await sSet(ctx, META_RECENT, tail);
  flog("rebuildRecent 完成", { scanned: keys.length, kept: tail.length });
  return tail;
}

async function loadRecentRecords(ctx, sessionID) {
  const now = Date.now();
  if (
    corpus.ts > 0 &&
    now - corpus.ts < CACHE_TTL_MS &&
    corpus.sessionID === sessionID &&
    corpus.records.length > 0
  ) {
    return corpus.records;
  }

  let keys = readRecentKeys(await sGet(ctx, META_RECENT));
  if (!keys.length) keys = await rebuildRecent(ctx);
  if (!keys.length) {
    corpus = { ts: now, sessionID, records: [] };
    return [];
  }

  const take = keys.slice(Math.max(0, keys.length - RECENT_TAKE));
  const results = await Promise.all(take.map((k) => sGet(ctx, k)));
  const records = [];
  for (let i = 0; i < take.length; i++) {
    const rec = results[i];
    if (rec && typeof rec === "object" && typeof rec.id === "string") records.push(rec);
  }
  // 新→旧
  records.reverse();
  corpus = { ts: now, sessionID, records };
  flog("语料刷新", { keys: keys.length, fetched: take.length, valid: records.length });
  return records;
}

/** 追加 key 到 meta:recent，并顺手做容量治理（超限时删最旧）。 */
async function pushRecent(ctx, key) {
  let keys = readRecentKeys(await sGet(ctx, META_RECENT));
  // 同一个 key 重写时不要留两份
  if (keys.indexOf(key) >= 0) keys = keys.filter((k) => k !== key);
  keys.push(key);

  let overflow = keys.length - RECENT_MAX;
  let count = asNumber(await sGet(ctx, META_COUNT)) + 1;

  if (overflow > 0 || count > MAX_ENTRIES) {
    const batch = Math.max(overflow, count > MAX_ENTRIES ? TRIM_BATCH : 0);
    const oldest = keys.slice(0, Math.max(0, Math.min(batch, keys.length - 1)));
    for (const old of oldest) {
      await sRemove(ctx, old);
      count -= 1;
    }
    keys.splice(0, oldest.length);
    overflow = 0;
    if (oldest.length) flog("容量治理：删除最旧", { deleted: oldest.length, count });
  }

  await sSet(ctx, META_RECENT, keys);
  await sSet(ctx, META_COUNT, Math.max(0, count));
}

/** 写一条记忆。返回写入的记录（失败返回 undefined）。 */
async function addEntry(ctx, partial) {
  if (!hasStore(ctx)) {
    flog("addEntry 跳过：无 ctx.storage");
    return undefined;
  }
  // 确定性 key：同一 (会话, 消息/调用 id) 只允许一条。
  // 宿主会把同一插件文件加载两次（两个实例并发跑钩子），单靠 seen 列表的
  // 读-改-写挡不住并发重复，这里从 key 层面根治。
  const id = partial.dedupeKey ? `mem:${sanitizeKey(partial.dedupeKey)}` : makeKey();
  if (partial.dedupeKey) {
    const existing = await sGet(ctx, id);
    if (existing) {
      flog("addEntry 命中确定性 key，跳过", { id });
      return undefined;
    }
  }
  const record = {
    v: 1,
    id,
    // 可选 partial.ts：仅供导入器把原始时间戳带进记录（向后兼容，缺省即 now）。
    ts: typeof partial.ts === "number" && Number.isFinite(partial.ts) ? partial.ts : Date.now(),
    sessionID: typeof partial.sessionID === "string" ? partial.sessionID : "",
    projectID: partial.projectID || projectIDOf(ctx),
    kind: partial.kind || "note",
    title: clamp(partial.title || "(无标题)", MAX_TITLE),
    text: clamp(partial.text || "", MAX_TEXT),
    tags: Array.isArray(partial.tags)
      ? partial.tags.filter((t) => typeof t === "string" && t.length > 0).slice(0, 12)
      : [],
  };
  const ok = await sSet(ctx, id, record);
  if (!ok) return undefined;
  await pushRecent(ctx, id);
  invalidateCorpus();
  flog("已写入记忆", { id, kind: record.kind, title: record.title });
  return record;
}

// ─────────── 一次性导入器（JSONL → 记忆库） ───────────

/** 把日期格式化成 yyyyMMdd-HHmmss（用于 .done 后缀）。 */
function importStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 解析 JSONL 文件为待导入条目数组。坏行只记日志、跳过，返回有效项。
 * @param {string} raw 原始文件内容
 */
function parseImportLines(raw) {
  const out = [];
  const lines = String(raw || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch (err) {
      flog("导入：跳过无法解析的行", { line: i + 1, err: String(err) });
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const source = typeof obj.source === "string" ? obj.source.trim() : "";
    if (!source) {
      flog("导入：跳过缺 source 的行（无法幂等）", { line: i + 1 });
      continue;
    }
    out.push({
      kind: IMPORT_KINDS.has(obj.kind) ? obj.kind : "note",
      title: typeof obj.title === "string" ? obj.title : "",
      text: typeof obj.text === "string" ? obj.text : "",
      tags: Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === "string") : [],
      ts: typeof obj.ts === "number" && Number.isFinite(obj.ts) ? obj.ts : 0,
      source,
      project: typeof obj.project === "string" ? obj.project : "",
    });
  }
  return out;
}

/**
 * 检查并执行一次性导入。全程 try/catch，绝不抛给宿主。
 * 幂等：靠 dedupeKey（mem:import_ + source）；重复运行同一文件不产生重复条目。
 */
async function runImportIfPresent(ctx) {
  try {
    if (!hasStore(ctx)) return;
    if (!existsSync(IMPORT_PATH)) return;

    // 原子抢占：rename 成功者才处理，避免两个插件实例并发导入。
    try {
      renameSync(IMPORT_PATH, IMPORT_PROCESSING);
    } catch (err) {
      // 文件不存在或已被另一实例取走
      flog("导入：抢占用例失败（可能已被处理）", String(err));
      return;
    }

    let raw = "";
    try {
      raw = readFileSync(IMPORT_PROCESSING, "utf8");
    } catch (err) {
      flog("导入：读取文件失败", String(err));
      return;
    }

    const parsed = parseImportLines(raw);
    const total = parsed.length;
    if (!total) {
      flog("导入：无有效记录", { total: 0 });
      try {
        renameSync(IMPORT_PROCESSING, `${IMPORT_PATH}.done-${importStamp()}`);
      } catch (err) {
        flog("导入：重命名失败", String(err));
      }
      return;
    }

    // ts 升序 → 最新的留在 meta:recent 窗口内；超出上限只保留最新的一批。
    parsed.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let candidates = parsed;
    let skippedOld = 0;
    if (parsed.length > IMPORT_MAX) {
      skippedOld = parsed.length - IMPORT_MAX;
      candidates = parsed.slice(parsed.length - IMPORT_MAX);
      flog("导入：超过上限，跳过更旧的", { skippedOld, max: IMPORT_MAX });
    }

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      try {
        const record = await addEntry(ctx, {
          sessionID: "",
          kind: item.kind,
          title: item.title || firstLine(item.text),
          text: item.text,
          tags: item.tags,
          projectID: item.project || undefined,
          dedupeKey: "import:" + sanitizeKey(item.source),
          ts: item.ts > 0 ? item.ts : undefined,
        });
        if (record) imported++;
        else skipped++; // 确定性 key 已存在 → 幂等跳过
      } catch (err) {
        failed++;
        flog("导入：单条写入异常（已吞掉）", { source: item.source, err: String(err) });
      }
      if ((i + 1) % IMPORT_YIELD_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    flog("导入完成", { total, imported, skipped, failed, skippedOld });

    try {
      renameSync(IMPORT_PROCESSING, `${IMPORT_PATH}.done-${importStamp()}`);
      flog("导入：文件已重命名", `${IMPORT_PATH}.done-${importStamp()}`);
    } catch (err) {
      flog("导入：重命名失败", String(err));
    }
  } catch (err) {
    flog("导入异常（已吞掉）", String(err));
  }
}

/** 去重：命中返回 true；未命中则登记并返回 false。 */
/**
 * 进程内前置挡板：同一实例里并发触发（同一 messageID / callID / 同一段用户文本）
 * 时，存储去重是「读-改-写」，两个并发调用会同时看到"未见过"从而双双入库。
 * 这个 Map 在 await 之前就落记，挡住这种竞态；跨实例的重复仍靠 storage 兜底。
 */
const marksInFlight = new Map();
const MARK_TTL_MS = 10 * 60 * 1000;

function markSeenInProcess(key, value, now) {
  const mark = `${key}::${value}`;
  const prev = marksInFlight.get(mark);
  if (prev !== undefined && now - prev < MARK_TTL_MS) return true;
  marksInFlight.set(mark, now);
  if (marksInFlight.size > 800) {
    for (const [k, t] of marksInFlight) {
      if (now - t > MARK_TTL_MS) marksInFlight.delete(k);
    }
  }
  return false;
}

async function seenRecently(ctx, key, value) {
  if (!value) return false;
  const now = Date.now();
  if (markSeenInProcess(key, value, now)) return true;
  if (!hasStore(ctx)) return false;
  const list = readSeen(await sGet(ctx, key));
  if (list.indexOf(value) >= 0) return true;
  list.push(value);
  const trimmed = list.length > SEEN_KEEP ? list.slice(list.length - SEEN_KEEP) : list;
  await sSet(ctx, key, trimmed);
  return false;
}

function readSeen(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => typeof x === "string");
}

// ─────────────────────────────── 分词 / 打分 ───────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "are", "was", "not", "but",
  "can", "all", "get", "has", "had", "how", "its", "our", "out", "use", "who",
  "why", "let", "put", "try", "one", "two", "new", "old", "see", "say", "way",
  "may", "any", "now", "yes", "its", "into", "from", "about", "would", "could",
  "should", "there", "their", "them", "then", "than", "when", "what", "which",
  "你的", "我们", "这个", "那个", "什么", "怎么", "可以", "一下", "就是", "不是",
  "还有", "然后", "如果", "因为", "所以", "但是", "以及", "需要", "一个", "已经",
]);

function isWordChar(code) {
  if (code >= 48 && code <= 57) return true; // 0-9
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 97 && code <= 122) return true; // a-z
  if (code === 95 || code === 45) return true; // _ -
  if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK 统一汉字
  if (code >= 0x3040 && code <= 0x30ff) return true; // 日文假名
  if (code >= 0xac00 && code <= 0xd7af) return true; // 谚文
  return false;
}

function isCJK(code) {
  return code >= 0x4e00 && code <= 0x9fff;
}

/** 零依赖关键词抽取：ASCII/CJK 词 + CJK 二元组。 */
function tokenize(text) {
  const runs = [];
  let run = "";
  const raw = String(text || "");
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (isWordChar(code)) run += ch;
    else if (run) {
      runs.push(run);
      run = "";
    }
  }
  if (run) runs.push(run);

  const seen = new Set();
  const out = [];
  const push = (t, minLen = MIN_TOKEN_LEN) => {
    if (!t || t.length < minLen) return;
    if (STOPWORDS.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  // CJK：单字也收（用户可能只回一个字，如"动"/"改"），双字以上再补二元组。
  for (const r of runs) {
    if (!isCJK(r.codePointAt(0))) continue;
    if (r.length === 1) {
      push(r, 1);
      continue;
    }
    for (let i = 0; i + 2 <= r.length && i < 12; i++) push(r.slice(i, i + 2), 1);
  }
  for (const r of runs) push(r.toLowerCase());

  return out.slice(0, MAX_TOKENS);
}

function scoreEntry(record, tokens, now) {
  if (!record || typeof record !== "object") return 0;
  const tags = (Array.isArray(record.tags) ? record.tags.join(" ") : "").toLowerCase();
  const title = String(record.title || "").toLowerCase();
  const body = String(record.text || "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (tags && tags.indexOf(token) >= 0) score += 4;
    if (title && title.indexOf(token) >= 0) score += 3;
    if (body && body.indexOf(token) >= 0) score += 1;
  }
  if (score <= 0) return 0;
  // 用户消息/手写笔记的长期价值高于工具日志，给基础权重加成，
  // 避免 150 条窗口被 shell / edit 噪音挤满。
  if (record.kind === "user") score += 3;
  else if (record.kind === "note") score += 2;
  const ts = typeof record.ts === "number" ? record.ts : now;
  const ageDays = Math.max(0, (now - ts) / 86400000);
  return score / (1 + ageDays / HALF_LIFE_DAYS);
}

/** 从消息数组里取最后一条 user 消息的纯文本。 */
/** 从任意 message 对象里取出可读文本（兼容 string / parts 数组 / 嵌套 payload）。 */
function textOfMessage(message) {
  if (!message || typeof message !== "object") return "";
  const holders = [message, message.payload, message.message];
  for (const holder of holders) {
    if (!holder || typeof holder !== "object") continue;
    for (const key of ["content", "parts", "text"]) {
      const value = holder[key];
      if (typeof value === "string" && value.trim()) return value;
      if (Array.isArray(value)) {
        const parts = [];
        for (const part of value) {
          if (typeof part === "string") parts.push(part);
          else if (part && typeof part.text === "string") parts.push(part.text);
        }
        if (parts.length) return parts.join("\n");
      }
      if (
        value &&
        typeof value === "object" &&
        typeof value.text === "string" &&
        value.text.trim()
      ) {
        return value.text;
      }
    }
  }
  return "";
}

function roleOfMessage(message) {
  if (!message || typeof message !== "object") return "";
  return String(message.role ?? message.type ?? message.payload?.role ?? "");
}

/**
 * 取最后一条用户消息的文本。
 * 返回 { text, how }：how 供调试定位宿主真实的 message 形状 —— v2 文档未写明
 * SessionContext.messages 的具体结构，实测未必是朴素的 { role, content }。
 */
function trailingUserText(messages) {
  if (!Array.isArray(messages) || !messages.length) return { text: "", how: "no-messages" };
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (roleOfMessage(message) !== "user") continue;
    const text = textOfMessage(message);
    if (text.trim()) return { text, how: `user@${i}` };
    return { text: "", how: `user@${i}-empty` };
  }
  return { text: "", how: `no-user-role(len=${messages.length})` };
}

/** 收集最近的若干条用户消息文本（新→旧），用于 query 与兜底捕获。 */
function collectUserTexts(messages, limit = 5) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const message = messages[i];
    if (roleOfMessage(message) !== "user") continue;
    const text = textOfMessage(message).trim();
    if (!text) continue;
    if (looksLikeInjection(text)) continue; // 宿主机注入的说明块，不是用户说的话
    out.push(text);
  }
  return out;
}

/**
 * 判断一段 user-role 文本是否是宿主机注入的说明块（AGENTS.md 前导、system-reminder、
 * 可用 skills 清单…）。这类文本若当成"用户消息"参与关键词与记忆，会污染检索。
 */
function looksLikeInjection(text) {
  const head = String(text || "").slice(0, 300);
  return (
    /^Instructions from:/i.test(head) ||
    /<system-reminder>/i.test(head) ||
    /<available_skills>/i.test(head) ||
    /^#\s*Code Mode/i.test(head)
  );
}

/** 便宜的 djb2 字符串 hash（仅用于去重标记，不做安全用途）。 */
function shortHash(input) {
  let h = 5381;
  const s = String(input || "");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.codePointAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * 兜底捕获用户消息：本前端不触发 session.prompt 钩子（实测 0 次），
 * 因此在本钩子里把最近的用户文本落库，按 sessionID + 文本 hash 去重。
 */
async function captureUserMessages(ctx, sessionID, texts) {
  try {
    if (!texts.length || !hasStore(ctx)) return;
    for (const text of texts.slice(0, 2)) {
      if (compactLength(text) < MIN_PROMPT_CHARS) continue;
      const mark = `${sessionID}:${shortHash(text)}`;
      if (await seenRecently(ctx, SEEN_PROMPT_PREFIX + sessionID, mark)) continue;
      await addEntry(ctx, {
        sessionID,
        kind: "user",
        dedupeKey: `u:${sessionID}:${shortHash(text)}`,
        title: firstLine(text),
        text,
        tags: tokenize(text).slice(0, 8),
      });
    }
  } catch (err) {
    flog("captureUserMessages 异常（已吞掉）", String(err));
  }
}

function renderBlock(records, total, now) {
  const lines = [];
  let used = 0;
  const room = CONTEXT_BUDGET - CONTEXT_HEADROOM;
  for (const record of records) {
    const day = new Date(typeof record.ts === "number" ? record.ts : now)
      .toISOString()
      .slice(0, 10);
    const title = clamp(record.title || "(无标题)", MAX_TITLE).replace(/\s+/g, " ");
    const head = `- [${day}] (${record.kind || "note"}) ${title}`;
    let body = String(record.text || "").replace(/\s+/g, " ").trim();
    if (body.length > 500) body = body.slice(0, 500) + "…";
    const block = body ? `${head}\n  ${body}` : head;
    if (used + block.length + 2 > room) break;
    used += block.length + 2;
    lines.push(block);
  }
  if (!lines.length) return "";
  const header =
    `<memory source="${PLUGIN_ID}" shown="${lines.length}" matched="${records.length}" total="${total}">\n` +
    `以下是本机持久记忆（跨会话）中检索到、可能与当前任务相关的历史片段，按相关度排序。\n` +
    `它们可能过时或不准确，请结合当前工作目录的实际代码自行判断，不要盲信。\n`;
  const footer =
    `\n需要更精确的记忆时，可调用 memory 工具（action: search | add | list | forget | stats）。\n` +
    `</memory>`;
  return header + lines.join("\n") + footer;
}

// ─────────────────────────────── 钩子实现 ───────────────────────────────

async function onPrompt(ctx, event) {
  try {
    if (!event) return;
    const sessionID = String(event.sessionID || "");
    const messageID = String(event.messageID || "");
    const text = event.prompt && typeof event.prompt.text === "string" ? event.prompt.text : "";

    if (sessionID) lastPrompt.set(sessionID, text);

    if (compactLength(text) < MIN_PROMPT_CHARS) {
      flog("prompt 跳过（过短）", { sessionID, len: compactLength(text) });
      return;
    }

    // 非 exactly-once：并发/重试会重复触发，按 messageID 去重
    if (messageID && (await seenRecently(ctx, SEEN_PROMPT_PREFIX + sessionID, messageID))) {
      flog("prompt 去重命中", { sessionID, messageID });
      return;
    }

    await addEntry(ctx, {
      sessionID,
      kind: "user",
      // 与 context 钩子的兜底捕获使用同一个确定性 key：
      // 两条路径谁先写谁生效，另一条会被 key 检查挡住，不会出现同一条两遍。
      dedupeKey: `u:${sessionID}:${shortHash(text)}`,
      title: firstLine(text),
      text,
      tags: tokenize(text).slice(0, 8),
    });
  } catch (err) {
    flog("prompt 钩子异常（已吞掉）", String(err));
  }
}

function buildSkipSet() {
  const set = new Set(DEFAULT_SKIP_TOOLS);
  const extra = process.env.LOCAL_MEMORY_SKIP_TOOLS;
  if (typeof extra === "string" && extra.trim()) {
    for (const item of extra.split(",")) {
      const name = item.trim();
      if (name) set.add(name);
    }
  }
  return set;
}

function resultText(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    if (typeof result.content === "string") return result.content;
    if (Array.isArray(result.content)) {
      const parts = [];
      for (const part of result.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
        else if (part.type === "file") parts.push(`[file ${part.name || part.uri || ""}]`);
      }
      if (parts.length) return parts.join("\n");
    }
    if (result.output !== undefined) return safeJson(result.output, MAX_TOOL_TEXT + 200);
  }
  return safeJson(result, MAX_TOOL_TEXT + 200);
}

function errorText(error) {
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const message = typeof error.message === "string" ? error.message : "";
    const metadata = error.metadata !== undefined ? safeJson(error.metadata, 300) : "";
    const detail = error.error !== undefined ? safeJson(error.error, 300) : "";
    return [message, detail, metadata].filter((s) => s && s.length > 0).join(" | ") || safeJson(error, 400);
  }
  return safeJson(error, 400);
}

function onToolAfter(ctx, event, skipSet) {
  return (async () => {
    try {
      if (!event) return;
      const tool = String(event.tool || "");
      if (!tool) return;
      if (skipSet.has(tool)) {
        flog("execute.after 跳过噪音工具", tool);
        return;
      }
      const sessionID = String(event.sessionID || "");
      const callID = String(event.id || "");
      if (callID && (await seenRecently(ctx, SEEN_TOOL_PREFIX + sessionID, callID))) {
        flog("execute.after 去重命中", { tool, callID });
        return;
      }

      const status = event.status === "completed" ? "completed" : "error";
      const payload =
        status === "completed" ? resultText(event.result) : errorText(event.error);
      if (compactLength(payload) < 2) {
        flog("execute.after 跳过（结果为空）", tool);
        return;
      }

      const inputHint = clamp(safeJson(event.input, MAX_INPUT_HINT + 200), MAX_INPUT_HINT);
      const summaryOnly = status === "completed" && SUMMARY_ONLY_TOOLS.indexOf(tool) >= 0;
      const text = summaryOnly
        ? `调用: ${clamp(inputHint, SUMMARY_MAX)}`
        : `调用: ${inputHint}\n结果: ${clamp(
            payload,
            status === "error" ? ERROR_KEEP_MAX : MAX_TOOL_TEXT,
          )}`;
      await addEntry(ctx, {
        sessionID,
        kind: "tool",
        dedupeKey: callID ? `t:${sessionID}:${callID}` : "",
        title: `${tool} · ${status}`,
        text,
        tags: [tool, status],
      });
      if (summaryOnly) flog("execute.after 只存摘要", tool);
    } catch (err) {
      flog("execute.after 钩子异常（已吞掉）", String(err));
    }
  })();
}

async function onContext(ctx, event) {
  try {
    if (!event || !Array.isArray(event.system)) return;
    if (!hasStore(ctx)) return;

    const sessionID = String(event.sessionID || "");
    const msgs = Array.isArray(event.messages) ? event.messages : [];
    const userTexts = collectUserTexts(msgs, 5);

    // 兜底捕获：本前端（Code Mode 宿主）不触发 session.prompt 钩子（实测 0 次），
    // 用户消息改由本钩子落库，按文本 hash + sessionID 去重。
    await captureUserMessages(ctx, sessionID, userTexts);

    let query = "";
    for (const text of userTexts) {
      if (tokenize(text).length) {
        query = text;
        break;
      }
    }
    if (!query) query = userTexts[0] || lastPrompt.get(sessionID) || "";
    const tokens = tokenize(query);
    if (!tokens.length) {
      const last = msgs.length ? msgs[msgs.length - 1] : null;
      flog("context 跳过（无关键词）", {
        userTexts: userTexts.length,
        count: msgs.length,
        sample: userTexts[0] ? userTexts[0].slice(0, 80) : "",
        lastKeys: last && typeof last === "object" ? Object.keys(last).slice(0, 12) : String(last),
      });
      return;
    }
    flog("context 查询关键词", { tokens: tokens.length, sample: query.slice(0, 60) });

    const records = await loadRecentRecords(ctx, sessionID);
    if (!records.length) {
      flog("context 跳过（无记忆条目）");
      return;
    }

    const now = Date.now();
    const scored = [];
    for (const record of records) {
      const score = scoreEntry(record, tokens, now);
      if (score > 0) scored.push({ record, score });
    }
    if (!scored.length) {
      flog("context 跳过（无相关条目）", { tokens: tokens.length, records: records.length });
      return;
    }
    scored.sort((a, b) => b.score - a.score);

    const total = asNumber(await sGet(ctx, META_COUNT));
    const block = renderBlock(
      scored.slice(0, CONTEXT_MAX_ITEMS).map((x) => x.record),
      total,
      now,
    );
    if (!block) return;
    if (block.length > CONTEXT_BUDGET) {
      flog("注入块超预算，丢弃", block.length);
      return;
    }

    // 语义：只 push system，绝不改写 event.messages
    event.system.push({ type: "text", text: block });
    flog("context 已注入", { chars: block.length, items: Math.min(scored.length, CONTEXT_MAX_ITEMS) });
  } catch (err) {
    // scan/读取失败一律静默降级，绝不抛给宿主、绝不阻塞请求
    flog("context 钩子异常（已吞掉）", String(err));
  }
}

// ─────────────────────────────── memory 工具 ───────────────────────────────

/**
 * 注：@opencode/schema@2.0.26 的 Tool.ValueSchema =
 *   Schema.Codec | StandardSchemaV1 | JsonSchema.JsonSchema
 * 即接受普通 JSON Schema 对象。本文件因此直接用普通 JSON Schema，不 import zod/effect。
 * 返回值为 Tool.Result = { output?, content?, metadata? }。
 */
const MEMORY_TOOL_INFO = {
  name: "memory",
  description:
    "读写本机持久记忆（跨会话）。action=search 按关键词检索；add 手动写入一条；" +
    "list 列出最近条目；forget 删除指定 id；stats 查看统计。",
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["search", "add", "list", "forget", "stats"],
        description: "要执行的操作",
      },
      query: { type: "string", description: "search 用的关键词/问题" },
      text: { type: "string", description: "add 写入的正文" },
      title: { type: "string", description: "add 的标题（可选，默认取正文首行）" },
      tags: { type: "array", items: { type: "string" }, description: "add 的标签（可选）" },
      kind: {
        type: "string",
        enum: ["note", "user", "tool"],
        description: "add 的条目类型（默认 note）",
      },
      id: { type: "string", description: "forget 要删除的条目 id（mem: 开头的 key）" },
      limit: { type: "number", description: "list/search 返回条数上限（默认 20，最大 100）" },
    },
    required: ["action"],
  },
  execute: async (input) => {
    try {
      return { content: await runMemoryTool(input) };
    } catch (err) {
      return { content: "memory 工具执行失败: " + String(err) };
    }
  },
};

let toolCtx = null;

function summarize(record, index) {
  const day = new Date(typeof record.ts === "number" ? record.ts : Date.now())
    .toISOString()
    .slice(0, 10);
  const text = String(record.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  return `${index + 1}. [${day}] (${record.kind}) ${record.title}\n   id=${record.id}\n   ${text}`;
}

async function runMemoryTool(input) {
  const ctx = toolCtx;
  const action = input && typeof input.action === "string" ? input.action : "";
  const limitRaw = input && typeof input.limit === "number" ? input.limit : 20;
  const limit = Math.max(1, Math.min(100, Math.floor(limitRaw) || 20));

  if (!ctx || !hasStore(ctx)) return "记忆存储当前不可用（ctx.storage 缺失）。";

  if (action === "add") {
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim()) return "add 失败：text 为空。";
    const record = await addEntry(ctx, {
      sessionID: "",
      kind: input.kind === "user" || input.kind === "tool" ? input.kind : "note",
      title: typeof input.title === "string" && input.title.trim() ? input.title : firstLine(text),
      text,
      tags: Array.isArray(input.tags)
        ? input.tags.filter((t) => typeof t === "string")
        : tokenize(text).slice(0, 8),
    });
    if (!record) return "add 失败：存储写入未成功。";
    return `已写入记忆 ${record.id}\n标题: ${record.title}`;
  }

  if (action === "search") {
    const query = typeof input.query === "string" ? input.query : "";
    const tokens = tokenize(query);
    if (!tokens.length) return "search 失败：query 里没有可用的关键词。";
    const records = await loadRecentRecords(ctx, "");
    const now = Date.now();
    const scored = [];
    for (const record of records) {
      const score = scoreEntry(record, tokens, now);
      if (score > 0) scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return `没有找到与「${query}」相关的记忆（已扫描 ${records.length} 条最近条目）。`;
    const picked = scored.slice(0, limit).map((x) => x.record);
    return `命中 ${scored.length} 条，返回前 ${picked.length} 条：\n\n` + picked.map(summarize).join("\n");
  }

  if (action === "list") {
    const records = await loadRecentRecords(ctx, "");
    if (!records.length) return "记忆库为空。";
    const picked = records.slice(0, limit);
    const total = asNumber(await sGet(ctx, META_COUNT));
    return `共 ${total} 条（计数），本次列出最近 ${picked.length} 条：\n\n` + picked.map(summarize).join("\n");
  }

  if (action === "forget") {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id) return "forget 失败：需要提供 id。";
    if (!id.startsWith(ENTRY_PREFIX)) return `forget 失败：id 必须以 ${ENTRY_PREFIX} 开头（防误删）。`;
    const existing = await sGet(ctx, id);
    if (existing === undefined) return `forget 失败：找不到条目 ${id}。`;
    await sRemove(ctx, id);
    const keys = readRecentKeys(await sGet(ctx, META_RECENT));
    const next = keys.filter((k) => k !== id);
    if (next.length !== keys.length) await sSet(ctx, META_RECENT, next);
    const count = Math.max(0, asNumber(await sGet(ctx, META_COUNT)) - 1);
    await sSet(ctx, META_COUNT, count);
    invalidateCorpus();
    return `已删除 ${id}。当前计数 ${count}。`;
  }

  if (action === "stats") {
    const count = asNumber(await sGet(ctx, META_COUNT));
    const keys = readRecentKeys(await sGet(ctx, META_RECENT));
    const records = await loadRecentRecords(ctx, "");
    const kinds = {};
    for (const r of records) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    return [
      `计数 meta:count = ${count}`,
      `meta:recent 保留 key 数 = ${keys.length}`,
      `已回读（最近 ${RECENT_TAKE} 条窗口内）有效条目 = ${records.length}`,
      `最近窗口内 kind 分布 = ${safeJson(kinds)}`,
      `前缀 = ${ENTRY_PREFIX}，上限 = ${MAX_ENTRIES}，调试日志 = ${debugEnabled() ? LOG_PATH : "关闭"}`,
    ].join("\n");
  }

  return `未知 action: ${action || "(空)"}。可用：search | add | list | forget | stats`;

}

// ─────────────────────────────── setup ───────────────────────────────

async function setup(ctx) {
  const disposers = [];
  flog("=== LOADED ===", { id: PLUGIN_ID, storage: hasStore(ctx) });
  if (!ctx) {
    flog("setup 收到空 ctx，直接返回");
    return () => {};
  }

  // 1) 用户消息落库
  try {
    const reg = await ctx.session?.hook?.("prompt", (event) => onPrompt(ctx, event));
    if (reg && typeof reg.dispose === "function") disposers.push(() => reg.dispose());
    flog("session.prompt 钩子已注册");
  } catch (err) {
    flog("session.prompt 钩子注册失败", String(err));
  }

  // 2) 工具调用摘要落库
  try {
    const skipSet = buildSkipSet();
    const reg = await ctx.tool?.hook?.("execute.after", (event) =>
      onToolAfter(ctx, event, skipSet),
    );
    if (reg && typeof reg.dispose === "function") disposers.push(() => reg.dispose());
    flog("tool.execute.after 钩子已注册", { skip: Array.from(skipSet).length });
  } catch (err) {
    flog("tool.execute.after 钩子注册失败", String(err));
  }

  // 3) 上下文注入
  try {
    const reg = await ctx.session?.hook?.("context", (event) => onContext(ctx, event));
    if (reg && typeof reg.dispose === "function") disposers.push(() => reg.dispose());
    flog("session.context 钩子已注册");
  } catch (err) {
    flog("session.context 钩子注册失败", String(err));
  }

  // 4) memory 工具
  try {
    if (ctx.tool && typeof ctx.tool.transform === "function") {
      toolCtx = ctx;
      const reg = await ctx.tool.transform((editor) => {
        editor.add(MEMORY_TOOL_INFO);
      });
      if (reg && typeof reg.dispose === "function") disposers.push(() => reg.dispose());
      flog("memory 工具已注册");
    } else {
      flog("tool.transform 不可用，跳过 memory 工具注册");
    }
  } catch (err) {
    toolCtx = null;
    flog("memory 工具注册失败（已忽略）", String(err));
  }

  // 5) 一次性导入器：异步跑，绝不阻塞 setup 返回、绝不抛给宿主
  try {
    Promise.resolve(runImportIfPresent(ctx)).catch((err) =>
      flog("导入器启动异常（已吞掉）", String(err)),
    );
  } catch (err) {
    flog("导入器启动失败（已吞掉）", String(err));
  }

  return () => {
    flog("=== UNLOAD ===");
    corpus = { ts: 0, sessionID: "", records: [] };
    lastPrompt.clear();
    for (const dispose of disposers) {
      try {
        Promise.resolve(dispose()).catch(() => {});
      } catch {
        // ignore
      }
    }
  };
}

export default {
  id: PLUGIN_ID,
  setup,
};
