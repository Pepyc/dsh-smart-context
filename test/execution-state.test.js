import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { createOpenTool, createSearchTool } from "../src/tools.js";
import { hashSegments } from "../src/store.js";
import { openPage } from "../src/pagination.js";

/** @param {boolean} isError */
function archive(isError) {
  const events = [
    { seq: 1, time: 1, type: "tool/result", data: { name: "command", message: { role: "tool", toolCallId: "call", isError, content: [{ type: "text", text: "OUTCOME_NEEDLE".repeat(30) }] } } },
    { seq: 2, time: 2, type: "assistant/message", data: { interrupted: true, message: { role: "assistant", content: [{ type: "text", text: "INTERRUPTED_NEEDLE".repeat(20) }] } } },
  ];
  const entry = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1,2], bySeq: new Map(events.map((e) => [e.seq,e])) }).entry; assert.ok(entry); return entry;
}

test("BUG-24 失败与中断状态经过所有分页及 renderer 保留，搜索片段也带状态", async () => {
  const entry = archive(true); const deps = { loadEntries: async () => [entry] }; const exec = { agent: { id: "audit" } };
  const tool = createOpenTool(deps); let cursor; let count = 0;
  do {
    const value = await tool.execute({ id: entry.id, cursor, maxTokens: 20 }, exec);
    const page = JSON.parse(/** @type {any} */ (tool.output.render({}, value)[0]).text);
    for (const part of page.parts) {
      if (part.seq === 1) { assert.equal(part.isError, true); assert.equal(part.toolCallId, "call"); }
      if (part.seq === 2) assert.equal(part.interrupted, true);
    }
    cursor = page.nextCursor; assert.ok(++count < 100);
  } while (cursor);
  const found = /** @type {any} */ (await createSearchTool(deps).execute({ query: "OUTCOME_NEEDLE" }, exec));
  assert.equal(found.hits[0].snippets[0].isError, true);
  const interrupted = /** @type {any} */ (await createSearchTool(deps).execute({ query: "INTERRUPTED_NEEDLE" }, exec));
  assert.equal(interrupted.hits[0].snippets[0].interrupted, true);
});

test("BUG-24 仅执行结果变化也更新内容指纹并使旧游标失效", () => {
  const failed = archive(true); const success = archive(false);
  assert.equal(openPage({ entry: success, id: success.id }).parts[0]?.isError, false);
  assert.notEqual(hashSegments(failed.segments), hashSegments(success.segments));
  const cursor = openPage({ entry: failed, id: failed.id, maxTokens: 1 }).nextCursor; assert.ok(cursor);
  assert.equal(openPage({ entry: success, id: success.id, cursor }).status, "bad-cursor");
});
