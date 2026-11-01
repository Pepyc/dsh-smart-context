import test from "node:test";
import assert from "node:assert/strict";
import { extractArchives, makeId, SCHEMA_VERSION } from "../src/archive.js";
import { validateIndex } from "../src/store.js";
import { createOpenTool } from "../src/tools.js";

/** @type {[[number,number,number],[number,number,number]]} */
const sources = [[43325,1433250,1433251], [53078,1530780,1530781]];
test("BUG-15 已知 FNV 碰撞不丢第二份归档，重复来源仍去重", () => {
  /** @type {import('../src/archive-types.js').SessionEvent[]} */ const events = [];
  for (const [i, seqs] of sources.entries()) {
    for (const seq of seqs) events.push({ seq, time: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: `ORIGINAL_${i}_${seq}` }] } } });
    events.push({ seq: 2000000+i, time: 2, type: "user/message", surfaceOp: { op: "replace", startSeq: seqs[0], endSeq: seqs[2] }, sourceEventSeqs: seqs, data: { message: { source: { kind: "compact-checkpoint" } } } });
  }
  const repeated = events[3]; assert.ok(repeated);
  events.push({ ...repeated, seq: 3000000 });
  const result = extractArchives({ sessionId: "audit", events });
  assert.equal(result.entries.length, 2);
  assert.equal(result.issues.length, 0);
  assert.notEqual(makeId("audit", "summary", sources[0]), makeId("audit", "summary", sources[1]));
  assert.deepEqual(extractArchives({ sessionId: "audit", events: structuredClone(events) }).entries, result.entries);
});

test("BUG-15 旧 ID 明确失效，不猜测碰撞原文；旧索引须重建", async () => {
  assert.notEqual(SCHEMA_VERSION, 1);
  assert.equal(validateIndex({ schemaVersion: 1, sessionId: "audit", entries: [], lastSeq: -1 }, "audit").index, null);
  const tool = createOpenTool({ loadEntries: async () => [] });
  const result = /** @type {any} */ (await tool.execute({ id: "summary-631bec7c" }, { agent: { id: "audit" } }));
  assert.equal(result.status, "stale-id");
  assert.deepEqual(result.parts, []);
});
