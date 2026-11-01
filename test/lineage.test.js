import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry, extractArchives } from "../src/archive.js";

/** @param {number} seq @param {string} text @param {string} [role] @returns {any} */
const message = (seq, text, role = "user") => ({ seq, time: seq, type: role === "tool" ? "tool/result" : `${role}/message`, data: { message: { role, content: [{ type: "text", text }], source: { kind: role === "tool" ? "tool" : "user", callId: "call-1" } } }, surfaceOp: "append" });
/** @param {number} seq @param {number[]} sources @param {string} [role] @returns {any} */
const replacement = (seq, sources, role = "user") => {
  const event = { ...message(seq, "DERIVED", role), sourceEventSeqs: sources, surfaceOp: { op: "replace", startSeq: 1, endSeq: 5 } };
  if (role === "user") event.data.message.source.kind = "compact-checkpoint";
  return event;
};

test("BUG-06 多轮摘要展开到最早原文并保留 surface 来源次序", () => {
  const events = [message(1, "FIRST"), message(3, "ORIGINAL_TOOL", "tool"), message(5, "NEXT"),
    { seq: 8, time: 8, type: "compaction/prune", data: { shadowedSeqs: [3] } }, replacement(9, [3], "tool"),
    { seq: 10, time: 10, type: "compaction/start", data: {} }, replacement(11, [10,1,9,5]),
    message(15, "LATEST"), { seq: 18, time: 18, type: "compaction/start", data: {} }, replacement(20, [18,11,15,3])];
  const latest = extractArchives({ sessionId: "audit", events }).entries.find((e) => e.sourceSeqs.includes(18));
  assert.ok(latest);
  assert.deepEqual(latest.segments.map((s) => s.seq), [1,3,5,15]);
  assert.deepEqual(latest.segments.map((s) => s.text), ["FIRST","ORIGINAL_TOOL","NEXT","LATEST"]);
  assert.equal(latest.createdAt, 20);
});

test("BUG-06 间接循环不会被当作可读摘要", () => {
  const { entry, issues } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [3],
    bySeq: new Map([[3,replacement(3,[4])],[4,replacement(4,[3])]]) });
  assert.ok(issues.some((i) => i.code === "cyclic-source"));
  assert.equal(entry?.segments.length ?? 0, 0);
});

test("BUG-06 工具调用的关联 ID 和参数能从归档回取", () => {
  const call = message(1, "", "assistant");
  call.data.message.content = [{ type: "tool-call", id: "call-1", name: "run_code", arguments: { code: "UNIQUE_ARGUMENT" } }];
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1,2], bySeq: new Map([[1,call],[2,message(2,"RESULT","tool")]]) });
  assert.ok(entry);
  assert.match(entry.segments[0]?.text ?? "", /call-1.*UNIQUE_ARGUMENT/s);
  assert.equal(entry.segments[1]?.toolName, "run_code");
});
