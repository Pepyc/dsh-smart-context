import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { searchArchives } from "../src/search.js";
import { openPage } from "../src/pagination.js";

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** @param {string} text */
function entryFor(text) {
  const event = { seq: 1, time: 1, type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } };
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[1,event]]) }); assert.ok(entry); return entry;
}

test("BUG-29 摘录截断不能产生孤立代理字符，命中仍可打开", () => {
  const original = "needle" + "a".repeat(79) + "😀" + "z".repeat(100);
  const entry = entryFor(original); const hit = searchArchives({ entries: [entry], query: "needle" }).hits[0]; assert.ok(hit);
  const snippet = hit.snippets[0]?.text ?? "";
  assert.doesNotMatch(snippet, loneSurrogate);
  assert.equal(snippet, "needle" + "a".repeat(79) + "…");
  assert.equal(openPage({ entry, id: entry.id, cursor: hit.openCursor }).parts[0]?.text, original);
});

test("BUG-29 标题和预览在边界避开拆分 emoji，完整边界仍保留", () => {
  const titleSource = "a".repeat(59) + "😀" + "b".repeat(100); const titled = entryFor(titleSource);
  assert.doesNotMatch(titled.title, loneSurrogate);
  assert.equal(titled.title, "a".repeat(59) + "…");
  const previewSource = "x".repeat(119) + "😀" + "END"; const preview = entryFor(previewSource);
  assert.doesNotMatch(preview.preview, loneSurrogate);
  assert.equal(preview.preview, "x".repeat(119));
  assert.equal(preview.segments[0]?.text, previewSource);
  const exact = entryFor("a".repeat(58) + "😀" + "z");
  assert.equal(exact.title, "a".repeat(58) + "😀…");
});
