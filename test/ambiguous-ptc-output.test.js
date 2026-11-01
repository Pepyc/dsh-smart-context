import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";

const output = '{"status":"ok","hits":[],"total":0}';
const simple = 'return await tools.memory_search({query:"x"});';

/** @param {string} code @param {string | undefined} subCallId */
function archive(code, subCallId) {
  const events = [
    { seq: 1, time: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool-call", id: "root", name: "run_code", arguments: { code } }] } } },
    { seq: 2, time: 2, type: "tool/ptc-dispatch", data: { parentCallId: "root", rootCallId: "root", ...(subCallId ? { subCallId } : {}), name: "memory_search", isError: false, content: [{ type: "text", text: output }] } },
    { seq: 3, time: 3, type: "tool/result", data: { name: "run_code", message: { role: "tool", toolCallId: "root", content: [{ type: "text", text: output }] } } },
  ];
  return buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1, 3], bySeq: new Map(events.map((event) => [event.seq, event])) }).entry;
}

test("缺少子调用身份时，即使结果形状相同也不能丢弃工具输出", () => {
  const entry = archive(simple, undefined);
  assert.ok(entry);
  assert.ok(entry.segments.some((segment) => segment.role === "tool" && segment.text === output));
});

test("复杂程序可独立生成相同 JSON，必须保留输出", () => {
  const entry = archive('await tools.memory_search({query:"x"}); return {status:"ok",hits:[],total:0};', "child");
  assert.ok(entry);
  assert.ok(entry.segments.some((segment) => segment.role === "tool" && segment.text === output));
});
