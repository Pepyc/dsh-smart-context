import test from "node:test";
import assert from "node:assert/strict";
import { extractArchives, integrityOf } from "../src/archive.js";
import { createOpenTool, createSearchTool } from "../src/tools.js";
import { verifySourceText } from "../src/source-verification.js";

const prefix = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n";

/** @param {string} text @param {Record<string, unknown>} source @param {boolean} [withUser]
 * @returns {import('../src/archive-types.js').SessionEvent[]} */
function session(text, source, withUser = true) {
  return [
    { seq: 1, time: 1, type: "user/message", surfaceOp: "append", data: { role: "user", source, content: [{ type: "text", text }] } },
    ...(withUser ? [{ seq: 2, time: 2, type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Continue the build" }] } }] : []),
    { seq: 3, time: 3, type: "compaction/start", data: {} },
    { seq: 4, time: 4, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: withUser ? 2 : 1 }, sourceEventSeqs: withUser ? [3,1,2] : [3,1], data: { role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "SUMMARY" }] } },
  ];
}

test("运行上下文没有分段来源时逐字保留，工作路径仍可检索和打开", async () => {
  const text = "\nWORKSPACE_ROOT=/previous-project\nOTHER_PLUGIN_FACT=original-decision\n";
  const events = session(text, { kind: "runtime-context" });
  const { entries } = extractArchives({ sessionId: "audit", events });
  assert.equal(entries[0]?.title, "Continue the build");
  const search = createSearchTool({ loadEntries: async () => entries });
  const found = /** @type {any} */ (await search.execute({ query: "WORKSPACE_ROOT" }, { agent: { id: "audit" } }));
  assert.equal(found.status, "ok");
  const open = createOpenTool({ loadEntries: async () => entries });
  const page = /** @type {any} */ (await open.execute({ id: found.hits[0].id, cursor: found.hits[0].openCursor }, { agent: { id: "audit" } }));
  assert.equal(page.status, "ok");
  assert.equal(page.parts.find((/** @type {any} */ part) => part.seq === 1)?.text, text);
});

test("有完整分段来源的混合快照只排除本插件目录，保留其他插件文本", () => {
  const sections = [
    { name: "sandbox", text: "WORKSPACE_ROOT=/previous-project\n" },
    { name: "smart-context", text: "CATALOG_ONLY" },
    { name: "other-plugin", text: "\nOTHER_PLUGIN_FACT=original-decision" },
  ];
  const events = session(prefix + sections.map((s) => s.text).join("\n\n"), { kind: "runtime-context", form: "snapshot", sections });
  const { entries } = extractArchives({ sessionId: "audit", events });
  const entry = entries[0]; assert.ok(entry);
  assert.equal(entry.segments.find((s) => s.seq === 1)?.text, prefix + "WORKSPACE_ROOT=/previous-project\n\n\n\nOTHER_PLUGIN_FACT=original-decision");
  assert.equal(entry.segments.some((s) => s.text.includes("CATALOG_ONLY")), false);
  assert.equal(integrityOf(entry), "complete");
  assert.equal(verifySourceText({ entry, events }).projectedSegmentsVerified, 1);
  const missing = { ...entry, segments: entry.segments.filter((s) => s.seq !== 1) };
  assert.throws(() => verifySourceText({ entry: missing, events }), /source-text-missing/);
});

test("纯本插件目录快照不会再次产生归档", () => {
  const sections = [{ name: "smart-context", text: "CATALOG_ONLY" }];
  const events = session(prefix + "CATALOG_ONLY", { kind: "runtime-context", form: "snapshot", sections }, false);
  assert.deepEqual(extractArchives({ sessionId: "audit", events }).entries, []);
});

test("分段元数据与正文不一致时保留整个快照，不能按元数据误删原文", () => {
  const text = prefix + "UNATTRIBUTED_BUSINESS_TEXT";
  for (const source of [
    { kind: "runtime-context", form: "snapshot", sections: [{ name: "smart-context", text: "CATALOG_ONLY" }] },
    { kind: "runtime-context", form: "snapshot", sections: [{ name: "smart-context", text: "CATALOG_ONLY" }, null] },
  ]) {
    const { entries } = extractArchives({ sessionId: "audit", events: session(text, source) });
    assert.equal(entries[0]?.segments.find((s) => s.seq === 1)?.text, text);
  }
});
