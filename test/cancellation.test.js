import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";
import { createSearchTool } from "../src/tools.js";
import { compactionSession } from "./fixtures/compaction-sample.js";
import { host, tick } from "./helpers/host.js";

test("BUG-19 在途调用取消立即结束等待，其他调用继续共享读取", async (t) => {
  /** @type {(v:any)=>void} */ let release = () => {};
  let reads = 0;
  const h = host(t, () => { reads++; return new Promise((resolve) => { release = resolve; }); });
  const dispose = apply(h.ctx, { diagnostics: true }); t.after(() => dispose?.());
  const controller = new AbortController();
  const first = h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "audit" }, signal: controller.signal });
  let outcome = "pending";
  const watched = first.then(() => { outcome = "resolved"; }, (/** @type {any} */ e) => { outcome = e.name; });
  const second = h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "audit" } });
  controller.abort(); await tick();
  assert.equal(outcome, "AbortError");
  assert.equal(reads, 1);
  assert.equal(h.logs.some((line) => line.includes('"stage":"tool-return"')), false);
  release({ events: compactionSession(), session: {} });
  await watched; assert.equal((await second).status, "ok");
});

test("BUG-19 组装取消与卸载都不必等待宿主读取完成", async (t) => {
  const h = host(t, () => new Promise(() => {}));
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  const controller = new AbortController(); let nextCalls = 0;
  const assembling = h.events.get("system-prompt/assemble")?.({ contexts: [{ name: "smart-context", text: "" }] }, { agent: { id: "audit" }, signal: controller.signal }, () => { nextCalls++; });
  let outcome = "pending";
  const watched = assembling.then(() => { outcome = "resolved"; }, (/** @type {any} */ e) => { outcome = e.name; });
  controller.abort(); await tick();
  assert.equal(outcome, "AbortError"); assert.equal(nextCalls, 0); await watched;
  const opening = h.tools.get("memory_open").execute({ id: "unknown" }, { agent: { id: "audit" } });
  let unloaded = "pending";
  const closed = opening.then(() => { unloaded = "resolved"; }, (/** @type {any} */ e) => { unloaded = e.name; });
  dispose?.(); await tick(); assert.equal(unloaded, "AbortError"); await closed;
  assert.equal(h.text("audit"), "");
});

test("BUG-19 自定义来源取消后迟到的拒绝被消费且不记录成功", async () => {
  /** @type {(v:any)=>void} */ let rejectSource = () => {};
  let observed = 0;
  const tool = createSearchTool({ loadEntries: () => new Promise((_resolve, reject) => { rejectSource = reject; }), observe: () => { observed++; } });
  const controller = new AbortController();
  const pending = tool.execute({ query: "missing" }, { agent: { id: "audit" }, signal: controller.signal });
  let outcome = "pending";
  const watched = pending.then(() => { outcome = "resolved"; }, (/** @type {any} */ e) => { outcome = e.name; });
  controller.abort(); await tick(); assert.equal(outcome, "AbortError");
  rejectSource(new Error("synthetic late failure")); await tick(); await watched; assert.equal(observed, 0);
});
