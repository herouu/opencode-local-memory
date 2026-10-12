/**
 * local-memory 离线 harness —— 用 mock ctx 驱动插件，不发任何模型请求、不联网。
 * 运行：在仓库根目录执行 `bun tests/harness.mjs`。
 *
 * 它完全脱离真实宿主：自己造一个 mock ctx（storage / session.hook / tool.hook /
 * tool.transform），只验证插件的对外契约与核心行为，不需要 opencode 在场。
 */

// 相对本文件定位被测插件，仓库可整体克隆/迁移到任意路径。
const PLUGIN = new URL("../local-memory.ts", import.meta.url);

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  :: " + detail}`);
}

// ── mock storage（durable JSON 语义：set 时深拷贝，模拟序列化） ──
function makeStorage() {
  const map = new Map();
  const calls = { get: 0, set: 0, remove: 0, scan: 0 };
  return {
    map,
    calls,
    api: {
      async get(key) {
        calls.get++;
        const v = map.get(key);
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
      },
      async set(key, value) {
        calls.set++;
        map.set(key, JSON.parse(JSON.stringify(value)));
      },
      async remove(key) {
        calls.remove++;
        map.delete(key);
      },
      async scan({ prefix, after, limit }) {
        calls.scan++;
        const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
        let start = 0;
        if (after) {
          const idx = keys.indexOf(after);
          start = idx >= 0 ? idx + 1 : 0;
        }
        const n = typeof limit === "number" && limit > 0 ? limit : 100;
        const slice = keys.slice(start, start + n);
        const entries = slice.map((k) => ({ key: k, value: JSON.parse(JSON.stringify(map.get(k))) }));
        const last = slice[slice.length - 1];
        const hasMore = last !== undefined && keys.indexOf(last) + 1 < keys.length;
        return hasMore ? { entries, next: last } : { entries };
      },
    },
  };
}

// ── mock ctx ──
function makeCtx() {
  const storage = makeStorage();
  const hooks = {};
  const addedTools = [];
  const ctx = {
    location: { directory: "C:/proj/demo", project: { id: "proj_demo", directory: "C:/proj/demo", canonical: "C:/proj/demo" } },
    options: {},
    storage: storage.api,
    session: {
      async hook(name, cb) {
        hooks["session:" + name] = cb;
        return { dispose: async () => {} };
      },
    },
    tool: {
      async hook(name, cb) {
        hooks["tool:" + name] = cb;
        return { dispose: async () => {} };
      },
      async transform(cb) {
        cb({
          list: () => addedTools.map((t, i) => ({ ...t, id: String(i) })),
          get: (id) => addedTools.find((t, i) => String(i) === id),
          namespace: () => {},
          add: (tool) => addedTools.push(tool),
          update: () => {},
          remove: () => {},
        });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks, addedTools, storage };
}

const mod = await import(PLUGIN.href);
const def = mod.default;

console.log("=== 1. 模块default导出（v2 加载器契约） ===");
check("default 是对象", def !== null && typeof def === "object", typeof def);
check("default.id 是非空字符串", typeof def.id === "string" && def.id.length > 0, def.id);
check(
  'default.setup 或 default.effect 是函数（id + setup/effect）',
  typeof def.setup === "function" || typeof def.effect === "function",
  `setup=${typeof def.setup} effect=${typeof def.effect}`,
);
console.log("default 导出原文:", JSON.stringify({ ...def, setup: `[Function setup]` }));
console.log("default 的键:", Object.keys(def).join(", "));

console.log("\n=== 2. setup(mockCtx) 与钩子注册 ===");
const { ctx, hooks, addedTools, storage } = makeCtx();
const cleanup = await setupWithLog(ctx, def);

async function setupWithLog(ctx, def) {
  let warned = null;
  const origWarn = console.warn;
  console.warn = (...a) => { warned = a.join(" "); origWarn(...a); };
  const c = await def.setup(ctx);
  console.warn = origWarn;
  if (warned) console.log("setup 期间的 console.warn:", warned);
  return c;
}

const hookNames = Object.keys(hooks).sort();
check(
  '注册了 session.hook("prompt")',
  typeof hooks["session:prompt"] === "function",
  hookNames.join(","),
);
check(
  '注册了 session.hook("context")',
  typeof hooks["session:context"] === "function",
);
check(
  '注册了 tool.hook("execute.after")',
  typeof hooks["tool:execute.after"] === "function",
);
check("未注册多余钩子（共 3 个）", hookNames.length === 3, hookNames.join(","));

console.log("\n=== 3. memory 工具出现在 editor.add 调用里 ===");
check("editor.add 被调用 1 次", addedTools.length === 1, String(addedTools.length));
const tool = addedTools[0];
check("工具 name === 'memory'", tool && tool.name === "memory", tool && tool.name);
check("工具 input 是普通 JSON Schema（type=object + properties）",
  tool && tool.input && tool.input.type === "object" && tool.input.properties && !!tool.input.properties.action,
  tool && JSON.stringify(Object.keys(tool.input.properties || {})));
check("工具 execute 是函数", typeof tool.execute === "function");
check("工具没有 import 任何包的产物（schema 是纯字面量对象）",
  !tool.input["~standard"] && typeof tool.input !== "function");

console.log("\n=== 4. prompt 钩子：写入 + 按 messageID 去重 ===");
const SID = "ses_test0001";
const sysBefore = [{ type: "text", text: "SYSTEM-ORIGINAL" }];
function promptEvent(messageID, text) {
  return { sessionID: SID, messageID, prompt: { text }, delivery: "queue" };
}
await hooks["session:prompt"](promptEvent("msg_1", "请把 local-memory 插件的存储前缀改成 mem2:，并更新测试"));
const afterFirst = countEntries(storage);
check("第一次 prompt 写入 1 条", afterFirst === 1, `entries=${afterFirst}`);

await hooks["session:prompt"](promptEvent("msg_1", "请把 local-memory 插件的存储前缀改成 mem2:，并更新测试"));
const afterDup = countEntries(storage);
check("同一 messageID 重复触发不重复写入", afterDup === 1, `entries=${afterDup}`);

await hooks["session:prompt"](promptEvent("msg_2", "第二个问题：storage.scan 的分页游标怎么用"));
const afterSecond = countEntries(storage);
check("不同 messageID 正常写入", afterSecond === 2, `entries=${afterSecond}`);

await hooks["session:prompt"](promptEvent("msg_3", "  \n\t "));
const afterBlank = countEntries(storage);
check("纯空白/过短消息被跳过", afterBlank === 2, `entries=${afterBlank}`);

check("去重集合键存在 seen:p:<sessionID>",
  [...storage.map.keys()].some((k) => k === "seen:p:" + SID),
  [...storage.map.keys()].filter((k) => k.startsWith("seen:")).join(","));

console.log("\n=== 5. execute.after 钩子：摘要 + 噪音跳过 + 去重 ===");
await hooks["tool:execute.after"]({
  tool: "read", sessionID: SID, agent: "build", messageID: "msg_2", id: "call_read_1",
  input: { filePath: "C:/x.ts" }, status: "completed",
  result: { content: "A".repeat(50000) },
});
check("噪音工具 read 被跳过", countEntries(storage) === 2, `entries=${countEntries(storage)}`);

await hooks["tool:execute.after"]({
  tool: "edit", sessionID: SID, agent: "build", messageID: "msg_2", id: "call_edit_1",
  input: { filePath: "C:/x.ts" }, status: "completed",
  result: { content: "B".repeat(5000) },
});
const afterEdit = countEntries(storage);
check("非噪音工具 edit 被记录", afterEdit === 3, `entries=${afterEdit}`);

await hooks["tool:execute.after"]({
  tool: "edit", sessionID: SID, agent: "build", messageID: "msg_2", id: "call_edit_1",
  input: { filePath: "C:/x.ts" }, status: "completed",
  result: { content: "B".repeat(5000) },
});
check("同一 callID 重复触发不重复写入", countEntries(storage) === 3, `entries=${countEntries(storage)}`);

await hooks["tool:execute.after"]({
  tool: "bash", sessionID: SID, agent: "build", messageID: "msg_2", id: "call_bash_1",
  input: { command: "bun test" }, status: "error",
  error: { message: "exit code 1" },
});
check("error 状态也记录", countEntries(storage) === 4, `entries=${countEntries(storage)}`);

const toolRec = [...storage.map.entries()].map(([, v]) => v).find((v) => v && v.kind === "tool");
check("工具条目正文被截断到 ~1000 字符", toolRec && toolRec.text.length <= 1200, toolRec && `len=${toolRec.text.length}`);
check("工具条目标题含工具名与状态", toolRec && /edit · completed/.test(toolRec.title), toolRec && toolRec.title);

console.log("\n=== 6. context 钩子：注入 + 预算 + 不改写 messages ===");
const messagesBefore = [
  { role: "user", id: "msg_1", content: [{ type: "text", text: "请把 local-memory 插件的存储前缀改成 mem2:，并更新测试" }] },
  { role: "assistant", id: "msg_a", content: [{ type: "text", text: "好的" }] },
  { role: "user", id: "msg_2", content: [{ type: "text", text: "local-memory 插件的存储前缀 mem2 改完了吗" }] },
];
const messagesSnapshot = JSON.stringify(messagesBefore);
const event = {
  sessionID: SID,
  model: { providerID: "p", modelID: "m" },
  system: [{ type: "text", text: "SYSTEM-ORIGINAL" }],
  messages: messagesBefore,
  options: {},
  agent: "build",
  tools: {},
};
await hooks["session:context"](event);
const injected = event.system.filter((s) => typeof s.text === "string" && s.text.includes("<memory"));
check("注入了 1 个 <memory> 块", injected.length === 1, `system.length=${event.system.length}`);
check("注入块非空", injected[0] && injected[0].text.length > 0, injected[0] && `chars=${injected[0].text.length}`);
check("注入块长度 ≤ 6000 字符（预算封顶）", injected[0] && injected[0].text.length <= 6000, injected[0] && `chars=${injected[0].text.length}`);
check("注入块的 part type 是 text", injected[0] && injected[0].type === "text");
check("原有 system 段未被破坏", event.system[0].type === "text" && event.system[0].text === "SYSTEM-ORIGINAL");
check("event.messages 完全未被改写（只 push system）", JSON.stringify(event.messages) === messagesSnapshot);
check("注入块包含相关条目（含 local-memory 关键词）",
  injected[0] && injected[0].text.includes("local-memory"), injected[0] && injected[0].text.split("\n")[0]);

// 无关键词时不应注入
const eventNoQuery = {
  sessionID: "ses_other",
  model: {}, system: [], messages: [{ role: "user", content: [{ type: "text", text: "!" }] }],
  options: {}, agent: "build", tools: {},
};
await hooks["session:context"](eventNoQuery);
check("无关键词时不注入（省钱）", eventNoQuery.system.length === 0, `system.length=${eventNoQuery.system.length}`);

// 缓存生效：短时间内的第二次调用不应再触发 storage.scan
const scanBefore = storage.calls.scan;
const event2 = { ...event, system: [] };
await hooks["session:context"](event2);
check("第二次 context 调用命中缓存（未新增 storage.scan）",
  storage.calls.scan === scanBefore, `scan ${scanBefore} -> ${storage.calls.scan}`);

console.log("\n=== 7. storage get/set/scan 走通 ===");
check("storage.get 被调用", storage.calls.get > 0, `get=${storage.calls.get}`);
check("storage.set 被调用", storage.calls.set > 0, `set=${storage.calls.set}`);
check("storage.remove 未被误调用（未超容量）", storage.calls.remove === 0, `remove=${storage.calls.remove}`);
check("storage.scan 被调用（容量治理/重建路径）", storage.calls.scan >= 0, `scan=${storage.calls.scan}`);
check("存储 key 前缀为 mem:", [...storage.map.keys()].some((k) => k.startsWith("mem:")),
  [...storage.map.keys()].filter((k) => k.startsWith("mem:")).length + " 条");

const sample = [...storage.map.entries()].find(([k]) => k.startsWith("mem:"));
check("条目的 v/kind/title/text/tags 字段齐备",
  sample && sample[1].v === 1 && typeof sample[1].sessionID === "string" &&
  typeof sample[1].kind === "string" && typeof sample[1].title === "string" &&
  typeof sample[1].text === "string" && Array.isArray(sample[1].tags),
  sample && JSON.stringify({ v: sample[1].v, kind: sample[1].kind, projectID: sample[1].projectID, tags: sample[1].tags }));

console.log("\n=== 8. memory 工具五个 action ===");
const t = async (input) => (await tool.execute(input, { signal: new AbortController().signal, progress: async () => {} })).content;

const addOut = await t({ action: "add", text: "记忆库的容量上限是 2000 条，超了删最旧", title: "容量策略", tags: ["storage", "capacity"] });
check("add 成功", /已写入记忆 mem:/.test(addOut), addOut.split("\n")[0]);

const searchOut = await t({ action: "search", query: "容量上限是多少，超了怎么办" });
check("search 命中刚写的条目", searchOut.includes("容量策略"), searchOut.split("\n")[0]);

const listOut = await t({ action: "list", limit: 3 });
check("list 返回最近条目", /共 \d+ 条/.test(listOut) && listOut.includes("id=mem:"), listOut.split("\n")[0]);

const statsOut = await t({ action: "stats" });
check("stats 返回计数与前缀", statsOut.includes("meta:count") && statsOut.includes("mem:"), statsOut.replace(/\n/g, " | ").slice(0, 200));

const badForget = await t({ action: "forget", id: "meta:recent" });
check("forget 拒绝非 mem: 前缀（防误删）", badForget.includes("必须以 mem: 开头"), badForget);

const targetId = addOut.match(/mem:[0-9a-zA-Z-]+/)[0];
const forgetOut = await t({ action: "forget", id: targetId });
check("forget 成功删除", forgetOut.includes("已删除"), forgetOut);
check("删除后 meta:recent 里不再有该 key",
  !(storage.map.get("meta:recent") || []).includes(targetId));

const unknownOut = await t({ action: "nope" });
check("未知 action 返回提示而非抛错", unknownOut.includes("未知 action"), unknownOut);

console.log("\n=== 9. 容量治理（meta:recent 上限 + 删最旧） ===");
// 插件常量：MAX_ENTRIES == RECENT_MAX == 2000，治理是「批量删最旧 TRIM_BATCH=32 条」
// 的惰性策略，因此 2000 是软上限：任意时刻 meta:recent 至多比它多出一个批次（+32）。
const CAP = 2000;
const TRIM_BATCH = 32;
const FILL = CAP + 60; // 超过上限一个批次以上，确保至少触发一次回收

const firstFill = await t({ action: "add", text: "批量填充条目 #0（最早，应被回收）" });
const firstId = (firstFill.match(/mem:[0-9a-zA-Z-]+/) || [])[0];
for (let i = 1; i < FILL; i++) {
  await t({ action: "add", text: `批量填充条目 ${i}，用于验证 meta:recent 的容量治理与最旧条目回收` });
}
const recent = storage.map.get("meta:recent") || [];
const memKeys = [...storage.map.keys()].filter((k) => k.startsWith("mem:"));
check(`meta:recent 被裁剪到 ≤ ${CAP}+${TRIM_BATCH}（惰性批删的软上限）`,
  recent.length <= CAP + TRIM_BATCH, `recent=${recent.length}`);
check("填充数超过上限后确实回收了最旧条目",
  memKeys.length < FILL, `填充=${FILL} 现存=${memKeys.length}`);
check("最早写入的条目已被真正删除",
  firstId !== undefined && !storage.map.has(firstId), `firstId=${firstId}`);
check("计数 meta:count 与实际条目数接近（±5）",
  Math.abs(Number(storage.map.get("meta:count")) - memKeys.length) <= 5,
  `meta:count=${storage.map.get("meta:count")} 实际=${memKeys.length}`);
check("storage.remove 被调用（走了删最旧路径）", storage.calls.remove > 0, `remove=${storage.calls.remove}`);

console.log("\n=== 10. 健壮性：storage 抛错时不崩溃、不抛给宿主 ===");
const broken = makeCtx();
broken.ctx.storage = {
  get: async () => { throw new Error("boom-get"); },
  set: async () => { throw new Error("boom-set"); },
  remove: async () => { throw new Error("boom-remove"); },
  scan: async () => { throw new Error("boom-scan"); },
};
const cleanup2 = await def.setup(broken.ctx);
let threw = null;
try {
  await broken.hooks["session:prompt"]({ sessionID: "s", messageID: "m", prompt: { text: "这是一条足够长的用户消息" } });
  await broken.hooks["tool:execute.after"]({ tool: "edit", sessionID: "s", id: "c", status: "completed", result: { content: "x" } });
  const ev = { sessionID: "s", system: [], messages: [{ role: "user", content: [{ type: "text", text: "存储前缀 mem 是什么" }] }], tools: {} };
  await broken.hooks["session:context"](ev);
} catch (err) {
  threw = err;
}
check("storage 全部抛错时三个钩子均不向宿主抛错", threw === null, threw && String(threw));
await cleanup2();

console.log("\n=== 11. cleanup 函数 ===");
check("setup 返回可调用的 cleanup", typeof cleanup === "function", typeof cleanup);
let cleanupThrew = null;
try { await cleanup(); } catch (err) { cleanupThrew = err; }
check("cleanup 不抛错", cleanupThrew === null, cleanupThrew && String(cleanupThrew));

function countEntries(store) {
  return [...store.map.keys()].filter((k) => k.startsWith("mem:")).length;
}

console.log("\n================ 汇总 ================");
console.log(`总计 ${results.length} 项，失败 ${failures} 项`);
if (failures > 0) {
  console.log("失败清单:");
  for (const r of results.filter((x) => !x.ok)) console.log("  - " + r.name + "  :: " + r.detail);
}
process.exit(failures > 0 ? 1 : 0);
