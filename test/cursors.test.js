import test from "node:test";
import assert from "node:assert/strict";
import { openPage } from "../src/pagination.js";
import { searchArchives } from "../src/search.js";

/** @param {string} id @param {number} seq @returns {import('../src/archive-types.js').ArchiveEntry} */
const entry = (id, seq) => ({ id, sessionId: "audit", sourceSeqs: [seq], kind: "summary", title: "needle", preview: "", length: 9000, createdAt: 1, segments: [{ seq, role: "user", text: "needle" + "A".repeat(8994) }] });

test("BUG-07 打开游标拒绝其他归档和内容版本", () => {
  const a = entry("a", 1); const b = entry("b", 2);
  const cursor = openPage({ entry: a, id: a.id }).nextCursor;
  assert.ok(cursor);
  assert.equal(openPage({ entry: b, id: b.id, cursor }).status, "bad-cursor");
  const changed = { ...a, segments: [{ ...a.segments[0], seq: 9, role: /** @type {const} */ ("user"), text: "B".repeat(9000) }] };
  assert.equal(openPage({ entry: changed, id: a.id, cursor }).status, "bad-cursor");
});

test("BUG-07 搜索游标拒绝失效位置、查询变化及结果版本变化", () => {
  const entries = [entry("a",1),entry("b",2),entry("c",3)];
  assert.equal(searchArchives({ entries, query: "needle", cursor: "obsolete" }).status, "bad-cursor");
  const cursor = searchArchives({ entries, query: "needle", limit: 1 }).nextCursor;
  assert.ok(cursor);
  assert.equal(searchArchives({ entries, query: "A", cursor }).status, "bad-cursor");
  assert.equal(searchArchives({ entries: entries.slice(1), query: "needle", cursor }).status, "bad-cursor");
  assert.equal(searchArchives({ entries, query: "needle", limit: 1, cursor }).hits[0]?.id, "b");
});

test("搜索游标在归档或匹配结果消失后明确失效", () => {
  const entries = [entry("a", 1), entry("b", 2)];
  const cursor = searchArchives({ entries, query: "needle", limit: 1 }).nextCursor;
  assert.ok(cursor);
  assert.equal(searchArchives({ entries: [], query: "needle", cursor }).status, "bad-cursor");
  const changed = { ...entry("a", 1), title: "other", segments: [{ seq: 1, role: /** @type {const} */ ("user"), text: "unrelated" }] };
  assert.equal(searchArchives({ entries: [changed], query: "needle", cursor }).status, "bad-cursor");
  assert.equal(searchArchives({ entries: [], query: "needle" }).status, "no-index");
  assert.equal(searchArchives({ entries: [changed], query: "needle" }).status, "no-results");
});

test("BUG-09 搜索命中能直接打开长归档后部", () => {
  const a = entry("large", 1);
  const segment = a.segments[0]; assert.ok(segment);
  segment.text = "A".repeat(30000) + "TARGET_ERROR_123" + "Z".repeat(1000);
  a.length = segment.text.length;
  const hit = /** @type {any} */ (searchArchives({ entries: [a], query: "TARGET_ERROR_123" }).hits[0]);
  assert.equal(typeof hit.openCursor, "string");
  const page = openPage({ entry: a, id: a.id, cursor: hit.openCursor });
  assert.ok(page.parts.some((p) => p.text.includes("TARGET_ERROR_123")));
  assert.equal(typeof hit.snippets[0].cursor, "string");
});
