import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry, extractArchives } from "../src/archive.js";
import { PRUNE_MARKER } from "../src/pagination.js";
import { createOpenTool, createSearchTool } from "../src/tools.js";
import { toStoredEntry } from "../src/store.js";
import { renderCatalog } from "../src/directory.js";
import { compactionSession } from "./fixtures/compaction-sample.js";

test("BUG-25 裁剪来源的目录、存储、搜索与打开一致标明不完整", async () => {
  const source = { seq: 1, time: 1, type: "tool/result", data: { name: "read_file", message: { role: "tool", toolCallId: "call", content: [{ type: "text", text: "VISIBLE_START" + PRUNE_MARKER + "VISIBLE_END" }] } } };
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[1,source]]) }); assert.ok(entry);
  assert.equal(toStoredEntry(entry).status, "partial");
  assert.match(renderCatalog({ entries: [entry] }), /来源不完整/);
  const exec = { agent: { id: "audit" } }; const deps = { loadEntries: async () => [entry] };
  const found = /** @type {any} */ (await createSearchTool(deps).execute({ query: "VISIBLE_START" }, exec));
  assert.equal(found.hits[0].integrity, "partial"); assert.ok(found.hits[0].warnings.length > 0);
  const missing = /** @type {any} */ (await createSearchTool(deps).execute({ query: "LOST_MIDDLE" }, exec));
  assert.equal(missing.incompleteArchives, 1);
  const open = createOpenTool(deps); const value = await open.execute({ id: entry.id }, exec);
  const visible = JSON.parse(/** @type {any} */ (open.output.render({}, value)[0]).text);
  assert.equal(visible.integrity, "partial"); assert.equal(visible.truncatedByHost, true);
});

test("BUG-25 prune 替换已成功回溯到无标记原文时仍为完整", () => {
  const entry = extractArchives({ sessionId: "audit", events: compactionSession() }).entries.find((e) => e.kind === "prune"); assert.ok(entry);
  assert.equal(toStoredEntry(entry).status, "complete"); assert.equal(entry.length, 20000);
});
