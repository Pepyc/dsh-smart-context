import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry, integrityOf } from "../src/archive.js";

/** @param {string} text */
function archive(text) {
  const retrieval = '{"status":"ok","hits":[],"total":0}';
  const events = [
    { seq: 1, time: 1, type: "tool/ptc-dispatch", data: { rootCallId: "root", parentCallId: "root", subCallId: "child", name: "memory_search", isError: false, content: [{ type: "text", text: retrieval }] } },
    { seq: 2, time: 2, type: "tool/result", data: { name: "run_code", message: { role: "tool", toolCallId: "root", content: [{ type: "text", text }] } } },
  ];
  return buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [2], bySeq: new Map(events.map((event) => [event.seq, event])) }).entry;
}

test("混合 JSON 归档逐字保留超出 JavaScript 安全整数范围的业务数据", () => {
  const text = '{"logs":["{\\"status\\":\\"ok\\",\\"hits\\":[],\\"total\\":0}"],"result":{"balance":9007199254740993}}';
  const entry = archive(text);
  assert.ok(entry);
  assert.equal(entry.segments[0]?.text, text);
  assert.equal(integrityOf(entry), "complete");
});

test("混合 JSON 归档保留业务值的原始格式与转义", () => {
  const text = '{ "logs": ["{\\"status\\":\\"ok\\",\\"hits\\":[],\\"total\\":0}"], "result": { "value": 1e+08, "word": "\\u0041" } }';
  assert.equal(archive(text)?.segments[0]?.text, text);
});
