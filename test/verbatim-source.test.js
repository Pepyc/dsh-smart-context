import test from "node:test";
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { createOpenTool } from "../src/tools.js";
import { verifySourceText } from "../src/source-verification.js";

test("BUG-17 原始空白、多文本块与纯空白消息经过 renderer 分页后逐字一致", async () => {
  for (const blocks of [["\n    print(\"indented\")\n\n"], ["  first", "second\n"], [" \n\t  "]]) {
    const original = blocks.join("");
    const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map([[1, { seq: 1, time: 1, type: "user/message", data: { message: { role: "user", content: blocks.map((text) => ({ type: "text", text })) } } }]]) });
    assert.ok(entry);
    const open = createOpenTool({ loadEntries: async () => [entry] });
    let cursor; let actual = "";
    do {
      const page = /** @type {any} */ (await open.execute({ id: entry.id, maxTokens: 100, cursor }, { agent: { id: "audit" } }));
      const visible = JSON.parse(/** @type {any} */ (open.output.render({}, page)[0])?.text ?? "");
      actual += visible.parts.map((/** @type {any} */ p) => p.text).join("");
      cursor = visible.nextCursor;
    } while (cursor);
    assert.equal(actual, original);
  }
});

test("BUG-17 独立源核对拒绝已被归档阶段改写的正文", () => {
  const events = [{ seq: 1, time: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "\n    original\n" }] } } }];
  const { entry } = buildEntry({ sessionId: "audit", kind: "summary", sourceSeqs: [1], bySeq: new Map(events.map((e) => [e.seq, e])) }); assert.ok(entry);
  assert.equal(verifySourceText({ entry, events }).verbatimSegmentsVerified, 1);
  const changed = structuredClone(entry); assert.ok(changed.segments[0]); changed.segments[0].text = "original";
  assert.throws(() => verifySourceText({ entry: changed, events }), /source-text-mismatch/);
});
