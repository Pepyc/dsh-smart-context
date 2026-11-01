import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry, extractArchives } from "../src/archive.js";
import { openPage } from "../src/pagination.js";
import { searchArchives } from "../src/search.js";
import { renderCatalog } from "../src/directory.js";
import { missingSourceSession, compactionSession } from "./fixtures/compaction-sample.js";
import { syncIndex } from "../src/sync.js";
import { host } from "./helpers/host.js";

test("BUG-05 来源全缺保留损坏条目，可打开获得 source-missing", () => {
  const { entries } = extractArchives({ sessionId: "audit", events: missingSourceSession() });
  assert.equal(entries.length, 1);
  assert.equal(openPage({ entry: entries[0], id: entries[0]?.id ?? "" }).status, "source-missing");
  assert.match(renderCatalog({ entries }), /不完整|缺失/);
});

test("BUG-05 部分缺失传递到打开、搜索与零命中结果", () => {
  const event = compactionSession()[0]; assert.ok(event);
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1,999], bySeq: new Map([[1,event]]) });
  assert.ok(entry);
  const page = openPage({ entry, id: entry.id });
  assert.equal(/** @type {any} */ (page).integrity, "partial");
  assert.match(page.message ?? "", /缺失/);
  const hit = searchArchives({ entries: [entry], query: "Steps" }).hits[0];
  assert.equal(/** @type {any} */ (hit).integrity, "partial");
  assert.equal(/** @type {any} */ (searchArchives({ entries: [entry], query: "not-present" })).incompleteArchives, 1);
});

test("BUG-05 索引跟随完整性变化并清除已不存在的条目", (t) => {
  host(t, async () => ({}));
  const dir = `${process.env.DSH_HOME}/audit`;
  const full = compactionSession();
  syncIndex({ dir, sessionId: "audit", events: full });
  const missing = full.filter((e) => e.seq !== 1);
  const partial = syncIndex({ dir, sessionId: "audit", events: missing });
  assert.equal(partial.index.entries.find((e) => e.kind === "summary")?.status, "partial");
  const shrunk = syncIndex({ dir, sessionId: "audit", events: full.filter((e) => e.seq <= 9), force: true });
  assert.equal(shrunk.index.lastSeq, 9);
  const empty = syncIndex({ dir, sessionId: "audit", events: [] });
  assert.equal(empty.index.entries.length, 0);
});
