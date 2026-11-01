import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry, extractArchives } from "../src/archive.js";
import { searchArchives } from "../src/search.js";

/** @param {number} seq @param {string} text @returns {import('../src/archive-types.js').SessionEvent} */
const system = (seq, text) => ({ seq, time: seq, type: "system/message", surfaceOp: "append", data: { message: { role: "system", content: text ? [{ type: "text", text }] : [] } } });

test("BUG-23 清空的后续系统节点被压缩时不复活旧提示", () => {
  /** @type {import('../src/archive-types.js').SessionEvent[]} */
  const events = [system(0,"HEAD"),
    { seq: 1, time: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "ACTUAL_HISTORY" }] } } },
    system(2,"OLD_OBSOLETE_PROMPT"), { ...system(3,""), surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
    { seq: 4, time: 4, type: "compaction/start", data: {} },
    { seq: 5, time: 5, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 3 }, sourceEventSeqs: [4,1,3], data: { role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "SUMMARY" }] } },
  ];
  const entry = extractArchives({ sessionId: "audit", events }).entries[0]; assert.ok(entry);
  assert.deepEqual(entry.segments.map((s) => [s.seq,s.text]), [[1,"ACTUAL_HISTORY"]]);
  assert.equal(searchArchives({ entries: [entry], query: "OLD_OBSOLETE_PROMPT" }).status, "no-results");
});

test("BUG-23 非压缩用户替换保持当前内容与来源序号", () => {
  const first = { seq: 0, time: 0, type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "OLD_SETTING" }] } };
  const next = { ...first, seq: 1, sourceEventSeqs: [0], surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 }, data: { ...first.data, content: [{ type: "text", text: "NEW_SETTING" }] } };
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[0,first],[1,next]]) }); assert.ok(entry);
  assert.deepEqual(entry.segments.map((s) => [s.seq,s.text]), [[1,"NEW_SETTING"]]);
});
