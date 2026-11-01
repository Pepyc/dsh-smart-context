import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";

/** @param {string} text @param {string} name @param {number} [seq] @returns {any} */
const result = (text, name, seq = 1) => ({ seq, time: seq, type: "tool/result", surfaceOp: "append",
  data: { name, message: { role: "tool", toolCallId: "root", source: { kind: "tool", callId: "root" }, content: [{ type: "text", text }] } } });
/** @param {string} name @param {unknown} value @param {number} seq @returns {any} */
const dispatch = (name, value, seq) => ({ seq, time: seq, type: "tool/ptc-dispatch", data: {
  parentCallId: "root", rootCallId: "root", subCallId: `root:ptc:${seq}`, name, arguments: {},
  isError: false, content: [{ type: "text", text: JSON.stringify(value) }],
} });
/** @param {any[]} events */
const archive = (events) => buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map(events.map((e) => [e.seq,e])) }).entry;

test("BUG-14 普通文件 JSON 含同名标记仍逐字保留", () => {
  const text = JSON.stringify({ payload: "USER_BUSINESS_RECORD" }, null, 2);
  assert.equal(archive([result(text, "read_file")])?.segments[0]?.text, text);
});

test("BUG-14 PTC 没有可信子调用来源时保留标记 JSON", () => {
  const text = JSON.stringify({ logs: [JSON.stringify({ payload: "USER_FILE" })] });
  assert.equal(archive([result(text, "run_code")])?.segments[0]?.text, text);
});

test("BUG-14 混合 PTC 子调用不误删业务返回的相同 JSON", () => {
  const value = { payload: "SAME_BUSINESS_AND_RETRIEVAL" };
  const text = JSON.stringify({ logs: [JSON.stringify(value)] });
  const events = [result(text, "run_code"), dispatch("memory_open", value, 2), dispatch("read_file", value, 3)];
  assert.equal(archive(events)?.segments[0]?.text, text);
});

test("BUG-14 混合结果逐字保留，重建后行为一致", () => {
  const own = { status: "ok", parts: [{ text: "RETRIEVED" }] };
  const other = { payload: "UNMATCHED_BUSINESS" };
  const text = JSON.stringify({ logs: [JSON.stringify(own), JSON.stringify(other)] });
  const events = [result(text, "run_code"), dispatch("memory_open", own, 2)];
  const first = archive(events); const rebuilt = archive(structuredClone(events));
  assert.ok(first); assert.equal(first.segments[0]?.text, text);
  assert.deepEqual(first.segments, rebuilt?.segments);
});
