/**
 * verify-edge-cases.mjs —— 分页与检索的边界组合验证
 *
 * 用途：用合成数据跑 24 组边界场景（Unicode 代理对、转义字符、超长文本、
 * 极小预算等），逐页回取并校验拼接结果与原文一致。
 *
 * 用法：
 *   node scripts/verify-edge-cases.mjs
 *
 * 特点：
 *   - 完全合成，不读取真实会话，不调用模型。
 *   - 适合改完分页或编码逻辑后跑一遍，确认没有回归。
 *   - 通过时输出「N 组 / M 页 通过」。
 */
import assert from "node:assert/strict";
import { buildEntry } from "../src/archive.js";
import { createOpenTool } from "../src/tools.js";
import { searchArchives } from "../src/search.js";
import { outputCost } from "../src/output-budget.js";
import { safeErrorCode } from "../src/logging.js";

try {
  let pages = 0;
  for (let i = 0; i < 24; i++) {
    const prefix = "\n    " + "\u0130\ud83d\ude00\\\"\n".repeat(25 + i);
    const raw = prefix + "TARGET_CODE\n\n" + "\t tail \\ \u0000 \ud83d\ude01".repeat(i + 1) + "\n  ";
    const event = { seq: 1, time: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: raw }] } } };
    const { entry } = buildEntry({ sessionId: "synthetic", kind: "summary", sourceSeqs: [1], bySeq: new Map([[1, event]]) });
    assert.ok(entry);
    const tool = createOpenTool({ loadEntries: async () => [entry] });
    const hit = searchArchives({ entries: [entry], query: "TARGET_CODE" }).hits[0];
    assert.equal(hit.snippets[0].offset, prefix.length);
    const direct = await tool.execute({ id: entry.id, cursor: hit.openCursor }, { agent: { id: "synthetic" } });
    assert.equal(direct.status, "ok");
    assert.ok(direct.parts.map((p) => p.text).join("").includes("TARGET_CODE"));
    let cursor; let actual = ""; let count = 0;
    const budget = [1, 3, 17, 100, 4000][i % 5];
    do {
      const value = await tool.execute({ id: entry.id, cursor, maxTokens: budget }, { agent: { id: "synthetic" } });
      const visible = JSON.parse(tool.output.render({}, value)[0].text);
      assert.deepEqual(visible, value); assert.equal(visible.status, "ok");
      assert.ok(outputCost(value) <= 6000); assert.ok(visible.estimatedTokens <= budget);
      for (const part of visible.parts) { assert.equal(part.text.isWellFormed(), true); actual += part.text; }
      cursor = visible.nextCursor; pages++; assert.ok(++count < 2000);
    } while (cursor);
    assert.equal(actual, raw);
  }
  console.log(JSON.stringify({ cases: 24, pages, sourceExact: true, unicodeOffsets: true, renderMatches: true,
    budgetsRespected: true, modelRequestObserved: false }));
} catch (error) {
  console.error(JSON.stringify({ error: safeErrorCode(error), boundary: "offline-edge-validation" }));
  process.exitCode = 1;
}
