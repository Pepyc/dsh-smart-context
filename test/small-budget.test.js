import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { openPage } from "../src/pagination.js";
import { createOpenTool } from "../src/tools.js";

const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[1, { seq: 1, time: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "😀abc".repeat(80) }] } } }]]) });
assert.ok(entry);

test("BUG-18 极小正文预算逐页完整回取，不被最小字符数或内部重分页覆盖", async () => {
  const open = createOpenTool({ loadEntries: async () => [entry] });
  let cursor; let actual = ""; let pages = 0;
  do {
    const page = /** @type {any} */ (await open.execute({ id: entry.id, cursor, maxTokens: 1 }, { agent: { id: "audit" } }));
    assert.equal(page.status, "ok");
    assert.ok(page.estimatedTokens <= 1);
    assert.ok(page.range.returnedChars > 0 && page.range.returnedChars <= 2);
    actual += page.parts.map((/** @type {any} */ p) => p.text).join("");
    cursor = page.nextCursor; assert.ok(++pages < 500);
  } while (cursor);
  assert.equal(actual, entry.segments.map((s) => s.text).join(""));
  assert.ok((openPage({ entry, id: entry.id, maxTokens: 1, maxChars: 500 }).estimatedTokens ?? Infinity) <= 1);
});

test("BUG-18 无效预算与不足一个码点的预算显式拒绝且不推进游标", () => {
  for (const maxTokens of [0, -1, NaN, Infinity, 0.5]) {
    const page = openPage({ entry, id: entry.id, maxTokens });
    assert.equal(page.status, "budget-too-small"); assert.equal(page.nextCursor, undefined); assert.deepEqual(page.parts, []);
  }
  const page = openPage({ entry, id: entry.id, maxChars: 1 });
  assert.equal(page.status, "budget-too-small"); assert.equal(page.nextCursor, undefined);
});
