import test from "node:test";
import assert from "node:assert/strict";
import { createOpenTool, createSearchTool } from "../src/tools.js";

const exec = { agent: { id: "audit" } };
/** @param {string} text @param {string} [id] @returns {import('../src/archive-types.js').ArchiveEntry} */
const entry = (text, id = "large") => ({ id, sessionId: "audit", sourceSeqs: Array.from({ length: 2000 }, (_,i) => i), kind: "summary", title: "needle", preview: "", length: text.length, createdAt: 1, segments: [{ seq: 1, role: "tool", text }] });

test("BUG-02 execute、render 和 PTC 包装均保留合法结构，所有正文可翻完", async () => {
  const original = ('a"\\\n😀\u0001').repeat(3000) + "FINAL_SENTINEL";
  const e = entry(original); const tool = createOpenTool({ loadEntries: async () => [e] });
  let cursor; let rebuilt = ""; let count = 0;
  do {
    const value = /** @type {any} */ (await tool.execute({ id: e.id, cursor }, exec));
    const text = /** @type {any} */ (tool.output.render({}, value)[0]).text;
    assert.equal(text.length <= 6000, true);
    assert.equal(JSON.stringify({ logs: [text] }).length <= 6000, true);
    const visible = JSON.parse(text);
    assert.deepEqual(visible, value);
    assert.equal(visible.status, "ok");
    rebuilt += visible.parts.map((/** @type {any} */ p) => p.text).join("");
    cursor = visible.nextCursor;
    assert.ok(++count < 200);
  } while (cursor);
  assert.equal(rebuilt, original);
});

test("BUG-02 大型搜索元数据不会删除后续命中和 nextCursor", async () => {
  const entries = Array.from({ length: 8 }, (_,i) => entry("needle " + "A".repeat(500), `hit-${i}`));
  const tool = createSearchTool({ loadEntries: async () => entries });
  let cursor; const ids = [];
  do {
    const value = /** @type {any} */ (await tool.execute({ query: "needle", limit: 5, cursor }, exec));
    const text = /** @type {any} */ (tool.output.render({}, value)[0]).text;
    const visible = JSON.parse(text);
    assert.deepEqual(visible, value);
    assert.ok(JSON.stringify({ logs: [text] }).length <= 6000);
    for (const hit of visible.hits) { ids.push(hit.id); assert.ok(hit.openCursor); assert.ok(hit.sourceSeqsOmitted > 0); }
    cursor = visible.nextCursor;
    assert.ok(ids.length <= 8);
  } while (cursor);
  assert.deepEqual(ids, ["hit-0","hit-1","hit-2","hit-3","hit-4","hit-5","hit-6","hit-7"]);
});
