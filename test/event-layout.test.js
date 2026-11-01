import test from "node:test";
import assert from "node:assert/strict";
import { extractArchives } from "../src/archive.js";
import { createOpenTool, createSearchTool } from "../src/tools.js";
import { verifySourceText } from "../src/source-verification.js";

/** @returns {import('../src/archive-types.js').SessionEvent[]} */
function session() {
  return [
    { seq: 0, time: 0, type: "user/message", surfaceOp: "append", data: { id: "u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "\n  ONLY_USER_SECRET_NEEDLE\n" }] } },
    { seq: 1, time: 1, type: "assistant/message", surfaceOp: "append", data: { message: { id: "a", role: "assistant", source: { kind: "model", provider: "synthetic", model: "synthetic" }, content: [{ type: "text", text: "ACKNOWLEDGED" }] } } },
    { seq: 2, time: 2, type: "compaction/start", data: { compactionId: "c", turn: 1 } },
    { seq: 3, time: 3, type: "compaction/summary", data: { compactionId: "c", summary: [] } },
    { seq: 4, time: 4, type: "user/message", surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 }, sourceEventSeqs: [2,3,0,1], data: { id: "summary", role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "SUMMARY" }] } },
  ];
}

test("BUG-22 官方 data 直载用户消息可搜索且经 renderer 逐字回取", async () => {
  const events = session();
  const { entries } = extractArchives({ sessionId: "audit", events });
  const deps = { loadEntries: async () => entries };
  const found = /** @type {any} */ (await createSearchTool(deps).execute({ query: "ONLY_USER_SECRET_NEEDLE" }, { agent: { id: "audit" } }));
  assert.equal(found.status, "ok");
  const tool = createOpenTool(deps);
  const page = await tool.execute({ id: found.hits[0].id }, { agent: { id: "audit" } });
  const visible = JSON.parse(/** @type {any} */ (tool.output.render({}, page)[0]).text);
  assert.deepEqual(visible.parts.map((/** @type {any} */ p) => [p.seq,p.role,p.text]), [[0,"user","\n  ONLY_USER_SECRET_NEEDLE\n"],[1,"assistant","ACKNOWLEDGED"]]);
  const entry = entries[0]; assert.ok(entry);
  assert.equal(verifySourceText({ entry, events }).verbatimSegmentsVerified, 2);
});

test("BUG-22 直接来源中的用户段缺失时独立核验不能通过", () => {
  const events = session(); const entry = extractArchives({ sessionId: "audit", events }).entries[0]; assert.ok(entry);
  const changed = { ...entry, segments: entry.segments.filter((s) => s.seq !== 0) };
  assert.throws(() => verifySourceText({ entry: changed, events }), /source-text-missing/);
});

test("BUG-22 原始 checkpoint 来源标记可识别事务记录缺失的替换", () => {
  const events = session().filter((e) => e.seq !== 2 && e.seq !== 3);
  const checkpoint = events.at(-1); assert.ok(checkpoint); checkpoint.sourceEventSeqs = [0,1];
  assert.equal(extractArchives({ sessionId: "audit", events }).entries.length, 1);
});
