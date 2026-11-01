import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";
import { compactionSession } from "./fixtures/compaction-sample.js";
import { host } from "./helpers/host.js";

/** @param {string[]} logs */
const records = (logs) => logs.filter((line) => line.startsWith("[smart-context:audit] ")).map((line) => JSON.parse(line.slice(22)));

test("BUG-11 原生请求核对检索正文，并保持消息顺序和配对", async (t) => {
  const h = host(t, async () => ({ events: compactionSession(), session: { cwd: "audit" } }));
  const dispose = apply(h.ctx, { diagnostics: true }); t.after(() => dispose?.());
  const exec = { agent: { id: "audit" }, callId: "search-1", rootCallId: "search-1", name: "memory_search" };
  const tool = h.tools.get("memory_search");
  const value = await tool.execute({ query: "P0-01" }, exec);
  const content = tool.output.render({}, value);
  h.events.get("tools/result")?.(exec, { value, content, isError: false });
  const options = { sessionId: "audit", messages: [
    { role: "assistant", content: [{ type: "tool-call", id: "search-1", name: "memory_search", arguments: { query: "P0-01" } }] },
    { role: "tool", toolCallId: "search-1", content },
  ], config: { apiKey: "SYNTHETIC_REQUEST_CREDENTIAL" } };
  const before = JSON.stringify(options);
  Object.freeze(options); Object.freeze(options.messages);
  let calls = 0;
  const stream = (async function* () { yield { type: "done" }; })();
  const hook = h.events.get("llm/stream"); assert.equal(typeof hook, "function");
  assert.equal(hook?.(options, () => { calls++; return stream; }), stream);
  assert.equal(calls, 1); assert.equal(JSON.stringify(options), before);
  const request = records(h.logs).find((r) => r.stage === "model-request");
  assert.equal(request?.retrievals[0].visibility, "complete");
  assert.equal(request?.unpairedResults, 0);
  assert.equal(JSON.stringify(h.logs).includes("SYNTHETIC_REQUEST_CREDENTIAL"), false);
});

test("BUG-11 PTC 已找到但没输出时不能记为已发送", async (t) => {
  const h = host(t, async () => ({ events: compactionSession(), session: { cwd: "audit" } }));
  const dispose = apply(h.ctx, { diagnostics: true }); t.after(() => dispose?.());
  const value = await h.tools.get("memory_search").execute({ query: "P0-01" },
    { agent: { id: "audit" }, callId: "nested", rootCallId: "ptc", name: "memory_search" });
  const hook = h.events.get("llm/stream"); assert.equal(typeof hook, "function");
  const request = (/** @type {any[]} */ content) => ({ sessionId: "audit", messages: [{ role: "tool", toolCallId: "ptc", content }] });
  hook?.(request([{ type: "text", text: '{"logs":[]}' }]), () => []);
  hook?.(request([{ type: "text", text: JSON.stringify({ logs: [JSON.stringify(value)] }) }]), () => []);
  hook?.({ sessionId: "audit", messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(value) }] }] }, () => []);
  hook?.({ ...request([{ type: "text", text: JSON.stringify(value) }]), sessionId: "other" }, () => []);
  const requests = records(h.logs).filter((r) => r.stage === "model-request");
  assert.equal(requests[0]?.retrievals[0].visibility, "changed-or-partial");
  assert.equal(requests[1]?.retrievals[0].visibility, "complete");
  assert.equal(requests[2]?.retrievals[0].visibility, "missing-message");
  assert.equal(requests[3]?.retrievals.length, 0);
});

test("BUG-11 默认关闭请求诊断，不增加请求监听和原文日志", (t) => {
  const h = host(t, async () => ({ events: [], session: {} }));
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  assert.equal(h.events.has("llm/stream"), false);
  assert.equal(records(h.logs).length, 0);
});

test("BUG-11 已取消调用不读取来源，也不记录成功返回", async (t) => {
  let reads = 0;
  const h = host(t, async () => { reads++; return { events: compactionSession(), session: {} }; });
  const dispose = apply(h.ctx, { diagnostics: true }); t.after(() => dispose?.());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "audit" }, signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 0);
  assert.equal(records(h.logs).length, 0);
});
