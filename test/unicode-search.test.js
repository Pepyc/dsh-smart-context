import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { searchArchives } from "../src/search.js";
import { openPage } from "../src/pagination.js";

test("BUG-16 Unicode 归一化不改变原文命中坐标和打开游标", () => {
  for (const prefix of ["İ".repeat(100), "😀İ".repeat(60), "ΟΣ İ".repeat(35)]) {
    const text = prefix + "TARGET_CODE";
    const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[1, { seq: 1, time: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text }] } } }]]) });
    assert.ok(entry);
    for (const query of ["target_code", '"TARGET_CODE"']) {
      /** @type {import('../src/search-types.js').SearchHit | undefined} */
      const hit = searchArchives({ entries: [entry], query }).hits[0]; assert.ok(hit);
      assert.equal(hit.snippets[0]?.offset, prefix.length);
      assert.match(hit.snippets[0]?.text ?? "", /TARGET_CODE/);
      const page = openPage({ entry, id: entry.id, cursor: hit.openCursor });
      assert.equal(page.status, "ok");
      assert.doesNotMatch(page.parts[0]?.text ?? "", /^[\uDC00-\uDFFF]/);
      assert.match(page.parts.map((p) => p.text).join(""), /TARGET_CODE/);
    }
    assert.equal(entry.segments[0]?.text, text);
  }
});
