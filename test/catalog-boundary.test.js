import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { compactionSession } from "./fixtures/compaction-sample.js";

// 目录测试不需要验证索引落盘；替换该外部边界，避免读写或删除用户文件。
const syncUrl = new URL("../src/sync.js", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url === syncUrl && context.parentURL?.endsWith("/src/index.js")) {
      return { url: "data:text/javascript,export function syncIndex(){globalThis.__smartContextTestSync?.();return {problem:null}}", shortCircuit: true };
    }
    return resolved;
  },
});

const { apply } = await import("../src/index.js");
hooks.deregister();

/** @param {(id: string) => Promise<any>} readSession */
function host(readSession) {
  /** @type {any} */ let provider;
  /** @type {Map<string, Function>} */ const listeners = new Map();
  /** @type {Map<string, any>} */ const registeredTools = new Map();
  const dispose = () => {};
  /** @type {any} */ const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: (/** @type {any} */ tool) => { registeredTools.set(tool.name, tool); return dispose; } },
    sessionQuery: { readSession },
    systemPrompt: { context: (/** @type {any} */ entry) => { provider = entry.text; return dispose; } },
    on: (/** @type {string} */ name, /** @type {Function} */ listener) => { listeners.set(name, listener); return dispose; },
  };
  const stop = apply(ctx, {});
  return {
    stop,
    tools: registeredTools,
    emit: (/** @type {string} */ name, /** @type {...any} */ ...args) => listeners.get(name)?.(...args),
    text: (/** @type {any} */ context) => provider(context),
    async request(/** @type {any} */ context) {
      const assembly = { sections: [], contexts: [{ name: "smart-context", text: provider(context) }], tools: [], variables: {} };
      const listener = listeners.get("system-prompt/assemble");
      const accepted = listener ? await listener(assembly, context, async () => assembly) : assembly;
      // rc.3 会在准备请求时重新求值已注册的 context provider。
      return accepted.contexts.map((/** @type {any} */ entry) => entry.name === "smart-context" ? provider(context) : entry.text).join("\n");
    },
  };
}

test("目录 provider 能处理缺少会话身份并如实报告", () => {
  const h = host(async () => ({ events: [], session: {} }));
  assert.match(h.text({}), /无法识别.*会话/);
  h.stop?.();
});

const brokenCheckpoint = { seq: 1000, time: 1000, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 4 }, sourceEventSeqs: [], data: { role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "SUMMARY" }] } };

/** @param {number[] | undefined} sources */
function brokenPruneSession(sources) {
  return [
    { seq: 1000, time: 1000, type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text: "ORIGINAL_TOOL_TEXT" }] } } },
    { seq: 1001, time: 1001, type: "compaction/prune", data: { shadowedSeqs: [1000] } },
    { seq: 1002, time: 1002, type: "tool/result", surfaceOp: { op: "replace", startSeq: 1000, endSeq: 1000 }, ...(sources === undefined ? {} : { sourceEventSeqs: sources }), data: { message: { role: "tool", content: [{ type: "text", text: "PRUNED_PLACEHOLDER" }] } } },
  ];
}

test("裁剪替换缺少或带空来源时报告来源不可用，不能伪装成没有归档", async () => {
  for (const sources of [undefined, []]) {
    const h = host(async () => ({ events: brokenPruneSession(sources), session: {} }));
    const context = { agent: { id: "A" } };
    assert.match(await h.request(context), /压缩来源.*无法解析/);
    const result = await h.tools.get("memory_search").execute({ query: "ORIGINAL_TOOL_TEXT" }, context);
    assert.equal(result.status, "source-unavailable");
    const opened = await h.tools.get("memory_open").execute({ id: "unknown" }, context);
    assert.equal(opened.status, "source-unavailable");
    h.stop?.();
  }
});

test("后续摘要不能把无来源的裁剪占位符当作完整原文", async () => {
  const later = { ...brokenCheckpoint, seq: 1004, sourceEventSeqs: [1003,1002] };
  const h = host(async () => ({ events: [...brokenPruneSession([]), { seq: 1003, time: 1003, type: "compaction/start", data: {} }, later], session: {} }));
  const context = { agent: { id: "A" } };
  const result = await h.tools.get("memory_search").execute({ query: "PRUNED_PLACEHOLDER" }, context);
  assert.equal(result.status, "source-unavailable");
  assert.deepEqual(result.hits, []);
  h.stop?.();
});

test("普通工具替换不能被之后才出现的裁剪记录误判为来源失败", async () => {
  const [original, prune, replacement] = brokenPruneSession([]);
  const h = host(async () => ({ events: [original, { ...replacement, seq: 1001 }, { ...prune, seq: 1002 }], session: {} }));
  const result = await h.tools.get("memory_search").execute({ query: "missing" }, { agent: { id: "A" } });
  assert.equal(result.status, "no-index");
  h.stop?.();
});

test("无法解析的压缩来源不能伪装成没有归档", async () => {
  const h = host(async () => ({ events: [brokenCheckpoint], session: {} }));
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /压缩来源.*无法解析/);
  const result = await h.tools.get("memory_search").execute({ query: "missing" }, context);
  assert.equal(result.status, "source-unavailable");
  assert.match(result.message, /来源.*无法解析/);
  h.stop?.();
});

test("自引用的压缩来源同样被报告为无法解析", async () => {
  const cyclic = { ...brokenCheckpoint, sourceEventSeqs: [1000] };
  const h = host(async () => ({ events: [cyclic], session: {} }));
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /压缩来源.*无法解析/);
  const result = await h.tools.get("memory_search").execute({ query: "missing" }, context);
  assert.equal(result.status, "source-unavailable");
  h.stop?.();
});

test("后续压缩引用空来源 checkpoint 时，不能把旧摘要冒充历史原文", async () => {
  const later = { ...brokenCheckpoint, seq: 1001, sourceEventSeqs: [1000] };
  const h = host(async () => ({ events: [brokenCheckpoint, later], session: {} }));
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /压缩来源.*无法解析/);
  const result = await h.tools.get("memory_search").execute({ query: "SUMMARY" }, context);
  assert.equal(result.status, "source-unavailable");
  assert.deepEqual(result.hits, []);
  h.stop?.();
});

test("部分压缩来源无法解析时，仍可检索和打开其他归档并提示不完整", async () => {
  const h = host(async () => ({ events: [...compactionSession(), brokenCheckpoint], session: {} }));
  const context = { agent: { id: "A" } };
  const catalog = await h.request(context);
  assert.match(catalog, /压缩来源.*无法解析/);
  assert.match(catalog, /summary-|prune-/);
  const found = await h.tools.get("memory_search").execute({ query: "Steps.md" }, context);
  assert.equal(found.status, "ok");
  assert.ok(found.incompleteArchives >= 1);
  const opened = await h.tools.get("memory_open").execute({ id: found.hits[0].id }, context);
  assert.equal(opened.status, "ok");
  const absent = await h.tools.get("memory_search").execute({ query: "NONEXISTENT_TEST_WORD" }, context);
  assert.equal(absent.status, "no-results");
  assert.ok(absent.incompleteArchives >= 1);
  const unresolved = await h.tools.get("memory_open").execute({ id: "missing-id" }, context);
  assert.equal(unresolved.status, "source-unavailable");
  h.stop?.();
});

test("非压缩替换的空来源不误报归档失败", async () => {
  const unrelated = { ...brokenCheckpoint, type: "system/message", data: { role: "system", content: [] } };
  const h = host(async () => ({ events: [unrelated], session: {} }));
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /未找到.*归档目录/);
  const result = await h.tools.get("memory_search").execute({ query: "missing" }, context);
  assert.equal(result.status, "no-index");
  h.stop?.();
});

test("压缩来源无法解析时不覆盖派生索引，来源恢复后重新同步", async (t) => {
  let broken = true; let writes = 0;
  const global = /** @type {any} */ (globalThis);
  global.__smartContextTestSync = () => { writes++; };
  const h = host(async () => ({ events: broken ? [...compactionSession(), brokenCheckpoint] : compactionSession(), session: {} }));
  t.after(() => { h.stop?.(); global.__smartContextTestSync = undefined; });
  const context = { agent: { id: "A" } };
  await h.request(context);
  assert.equal(writes, 0);
  await h.tools.get("memory_search").execute({ query: "Steps.md" }, context);
  assert.equal(writes, 0);
  broken = false;
  h.emit("session/event", { id: "A" }, { type: "compaction/start" });
  await h.request(context);
  assert.equal(writes, 1);
});

test("空目录、未知会话和缺少身份不会得到其他会话的目录", async () => {
  const h = host(async (id) => ({ events: id === "A" ? compactionSession() : [], session: {} }));
  const a = await h.request({ agent: { id: "A" } });
  assert.match(a, /summary-|prune-/);
  const unknown = h.text({ agent: { id: "B" } });
  assert.match(unknown, /尚未加载/);
  const b = await h.request({ agent: { id: "B" } });
  assert.match(b, /未找到.*归档目录/);
  const missing = await h.request({});
  assert.match(missing, /无法识别.*会话/);
  for (const text of [unknown, b, missing]) {
    assert.notEqual(text, a);
    assert.doesNotMatch(text, /summary-|prune-/);
  }
  assert.equal(h.text({ agent: { id: "A" } }), a);
  h.stop?.();
});

test("来源读取失败时不声称没有归档，也不返回旧目录", async () => {
  let broken = false;
  const h = host(async () => {
    if (broken) throw new Error("synthetic source failure");
    return { events: compactionSession(), session: {} };
  });
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /summary-|prune-/);
  broken = true;
  h.emit("session/event", { id: "A" }, { type: "compaction/start" });
  const failed = await h.request(context);
  assert.match(failed, /目录.*不可用.*读取或处理失败/);
  assert.doesNotMatch(failed, /summary-|prune-/);
  broken = false;
  assert.match(await h.request(context), /summary-|prune-/);
  h.stop?.();
});

test("在途读取尚未完成时如实报告尚未加载", async () => {
  /** @type {(value: any) => void} */ let release = () => {};
  const h = host(() => new Promise((resolve) => { release = resolve; }));
  const context = { agent: { id: "A" } };
  const pending = h.request(context);
  assert.match(h.text(context), /尚未加载/);
  release({ events: compactionSession(), session: {} });
  assert.match(await pending, /summary-|prune-/);
  h.stop?.();
});

test("请求前重新求值 provider 后仍可看到当前会话已刷新的目录", async () => {
  let read = 0;
  const h = host(async () => ({ events: ++read === 1 ? [] : compactionSession(), session: {} }));
  const agent = { id: "A" };
  const context = { agent, scope: agent };
  assert.match(await h.request(context), /未找到.*归档目录/);
  h.emit("session/event", { id: "A" }, { type: "compaction/start" });
  assert.match(await h.request(context), /summary-|prune-/);
  h.stop?.();
});

test("目录组装复用近期快照，压缩事件会立即刷新", async () => {
  let reads = 0;
  const h = host(async () => ({ events: ++reads === 1 ? [] : compactionSession(), session: {} }));
  const context = { agent: { id: "A" } };
  for (let i = 0; i < 3; i++) assert.match(await h.request(context), /未找到.*归档目录/);
  assert.equal(reads, 1);
  h.emit("session/event", { id: "A" }, { type: "compaction/start" });
  assert.match(await h.request(context), /summary-|prune-/);
  assert.equal(reads, 2);
  h.stop?.();
});

test("刷新结束与在途状态清理之间到达的压缩事件也会补读", async (t) => {
  let reads = 0;
  const h = host(async () => ({ events: ++reads === 1 ? [] : compactionSession(), session: {} }));
  const global = /** @type {any} */ (globalThis);
  t.after(() => { h.stop?.(); global.__smartContextTestSync = undefined; });
  global.__smartContextTestSync = () => {
    if (reads === 1) queueMicrotask(() => h.emit("session/event", { id: "A" }, { type: "compaction/start" }));
  };
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /summary-|prune-/);
  assert.equal(reads, 2);
});

test("目录快照过期后重读，工具调用始终重读", async (t) => {
  let now = 100000; let reads = 0;
  t.mock.method(Date, "now", () => now);
  const h = host(async () => ({ events: ++reads === 1 ? [] : compactionSession(), session: {} }));
  const context = { agent: { id: "A" } };
  assert.match(await h.request(context), /未找到.*归档目录/);
  now += 30001;
  assert.match(await h.request(context), /summary-|prune-/);
  assert.equal(reads, 2);
  await h.tools.get("memory_search").execute({ query: "Steps.md" }, context);
  assert.equal(reads, 3);
  h.stop?.();
});
