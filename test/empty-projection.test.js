import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";

const own = { status: "ok", parts: [{ text: "DUPLICATE" }] };
/** @param {unknown} value */
function archive(value) {
  const events = [
    { seq: 0, time: 0, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool-call", id: "root", name: "run_code", arguments: { code: 'return await tools.memory_open({id:"x"});' } }] } } },
    { seq: 1, time: 1, type: "tool/ptc-dispatch", data: { rootCallId: "root", parentCallId: "root", subCallId: "root:ptc:1", name: "memory_open", isError: false, arguments: {}, content: [{ type: "text", text: JSON.stringify(own) }] } },
    { seq: 2, time: 2, type: "tool/result", data: { name: "run_code", message: { role: "tool", toolCallId: "root", content: [{ type: "text", text: JSON.stringify(value) }] } } },
  ];
  return buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [2], bySeq: new Map(events.map((e) => [e.seq,e])) });
}

test("BUG-20 可信检索清除后空 PTC logs/result 包装不成为归档", () => {
  for (const value of [{ logs: [JSON.stringify(own)] }, { result: own }, { logs: [JSON.stringify(own)], result: own }, own]) {
    const result = archive(value);
    assert.equal(result.entry, null);
    assert.ok(result.issues.every((issue) => issue.code === "empty-source"));
  }
});

test("BUG-20 混合传输包装保留原本空值、业务字段及无关输出", () => {
  for (const value of [{ logs: [] }, { result: null }, { logs: [JSON.stringify(own)], business: [] }, { logs: [JSON.stringify(own), ""] }]) {
    const result = archive(value); assert.ok(result.entry);
    assert.equal(result.entry.segments[0]?.text, JSON.stringify(value));
  }
});
