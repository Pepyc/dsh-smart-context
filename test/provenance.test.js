import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { createSearchTool } from "../src/tools.js";
import { looksLikeRetrievalResponse } from "../src/provenance.js";

/** @param {unknown} value @returns {import('../src/archive-types.js').SessionEvent} */
function dispatch(value) {
  return { seq: 90, time: 1, type: "tool/ptc-dispatch", data: { parentCallId: "root", rootCallId: "root", subCallId: "root:ptc:1", name: "memory_search", arguments: {}, isError: false, content: [{ type: "text", text: JSON.stringify(value) }] } };
}

test("BUG-08 检索结果**不带** memoryOrigin 标记（实现细节不暴露给模型）", async () => {
  const tool = createSearchTool({ loadEntries: async () => [] });
  const result = /** @type {any} */ (await tool.execute({ query: "missing" }, { agent: { id: "audit" } }));
  // 回归：曾把 memoryOrigin 写进模型可见的输出与 schema。
  // 那是插件内部标记，会占预算、污染视野、还要求模型在 PTC 里"保留该字段"。
  assert.equal("memoryOrigin" in result, false, "模型可见的输出不应含 memoryOrigin");
  // 但形状仍可被内部识别
  assert.equal(looksLikeRetrievalResponse(result), true, "应能按形状识别为检索响应");
});

test("BUG-08 可证明的纯检索 PTC 文本包装不再作为原文", async () => {
  const tool = createSearchTool({ loadEntries: async () => [] });
  const result = /** @type {any} */ (await tool.execute({ query: "missing" }, { agent: { id: "audit" } }));
  const call = { seq: 89, time: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool-call", id: "root", name: "run_code", arguments: { code: 'return await tools.memory_search({query:"missing"});' } }] } } };
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[89, call], [90, dispatch(result)], [1, {
    seq: 1, time: 1, type: "tool/result", data: { name: "run_code", message: { role: "tool", toolCallId: "root", content: [{ type: "text", text: JSON.stringify(result) }] } },
  }]]) });
  assert.equal(entry, null);
});

test("BUG-08 排除原生检索结果与目录，保留来源不明的工具输出", () => {
  /** @type {any[]} */ const events = [
    dispatch({ status: "ok", hits: [], total: 0 }),
    { seq: 1, type: "tool/result", data: { name: "memory_open", message: { content: [{ type: "text", text: "RETRIEVED_ONLY" }] } } },
    { seq: 2, type: "user/message", data: { message: { role: "user", source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "smart-context", text: "CATALOG_ONLY" }] }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCATALOG_ONLY" }] } } },
    { seq: 3, type: "tool/result", data: { name: "run_code", message: { toolCallId: "root", content: [
      { type: "text", text: '{"status":"ok","hits":[],"total":0}' },
      { type: "text", text: "UNRELATED_OUTPUT" },
    ] } } },
  ];
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1,2,3], bySeq: new Map(events.map((e) => [e.seq,e])) });
  assert.ok(entry);
  assert.deepEqual(entry.segments.map((s) => s.text), ['{"status":"ok","hits":[],"total":0}UNRELATED_OUTPUT']);
});

test("混合 PTC logs/result 包装逐字保留，避免损坏业务输出", () => {
  const own = { status: "ok", parts: [{ text: "DUPLICATED_ORIGINAL" }] };
  const text = JSON.stringify({ logs: [JSON.stringify(own), "UNRELATED_OUTPUT"], result: own });
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[90, dispatch(own)], [1, {
    seq: 1, time: 1, type: "tool/result", data: { name: "run_code", message: { toolCallId: "root", content: [{ type: "text", text }] } },
  }]]) });
  assert.ok(entry);
  assert.equal(entry.segments[0]?.text, text);
});
