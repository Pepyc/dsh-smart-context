/**
 * 分页的验收测试（V1-04）。
 *
 * 验收标准（Steps.md §5.5）：
 * - 连续翻页无遗漏、无重复
 * - 大条目遵守输出上限
 * - 非法参数不会让当前对话崩溃
 *
 * @module dsh-smart-context/test/pagination.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractArchives } from "../src/archive.js";
import {
  MAX_PAGE_CHARS,
  MAX_PAGE_TOKENS,
  PRUNE_MARKER,
  decodeCursor,
  encodeCursor,
  estimateTokens,
  openPage,
  wasPrunedByHost,
} from "../src/pagination.js";
import { compactionSession } from "./fixtures/compaction-sample.js";

const SESSION = "session-page";

/**
 * 取语料里第一条归档。
 * @returns {import("../src/archive-types.js").ArchiveEntry}
 */
function firstEntry() {
  const { entries } = extractArchives({ sessionId: SESSION, events: compactionSession() });
  const entry = entries.at(0);
  assert.ok(entry, "语料应有归档");
  return entry;
}

/**
 * 构造一个指定长度原文的条目。
 * @param {number[]} lengths - 每个片段的字符数
 * @returns {import("../src/archive-types.js").ArchiveEntry}
 */
function makeEntry(lengths) {
  /** @type {import("../src/archive-types.js").ArchiveSegment[]} */
  const segments = lengths.map((len, i) => ({
    seq: i + 1,
    role: /** @type {const} */ ("tool"),
    text: String.fromCharCode(97 + (i % 26)).repeat(len),
  }));
  return {
    id: "summary-test",
    sessionId: SESSION,
    sourceSeqs: lengths.map((_, i) => i + 1),
    kind: "summary",
    title: "测试条目",
    preview: "",
    length: segments.reduce((s, x) => s + x.text.length, 0),
    createdAt: 1,
    segments,
  };
}

test("单页遵守字符上限", () => {
  const entry = makeEntry([20000]);
  const page = openPage({ entry, id: entry.id });
  assert.equal(page.status, "ok");
  const chars = page.parts.reduce((s, p) => s + p.text.length, 0);
  assert.ok(chars <= MAX_PAGE_CHARS, `本页 ${chars} 字符，不应超过 ${MAX_PAGE_CHARS}`);
});

test("单页遵守 token 软上限", () => {
  const entry = makeEntry([20000]);
  const page = openPage({ entry, id: entry.id, maxTokens: 500 });
  assert.equal(page.status, "ok");
  const chars = page.parts.reduce((s, p) => s + p.text.length, 0);
  assert.ok(chars <= 500 * 2, `maxTokens=500 应限制在 ${500 * 2} 字符内，实际 ${chars}`);
});

test("maxTokens 被钳到硬上限", () => {
  const entry = makeEntry([200000]);
  const page = openPage({ entry, id: entry.id, maxTokens: 999999 });
  assert.equal(page.status, "ok");
  const chars = page.parts.reduce((s, p) => s + p.text.length, 0);
  assert.ok(chars <= MAX_PAGE_CHARS);
  assert.ok((page.estimatedTokens ?? 0) <= MAX_PAGE_TOKENS + 1);
});

test("连续翻页无遗漏、无重复", () => {
  // 多片段，每个 3000 字符 → 需要多页
  const entry = makeEntry([3000, 3000, 3000, 3000, 3000]);
  /** @type {string[]} */
  const collected = [];
  let cursor;
  let guard = 0;

  for (;;) {
    const page = openPage({ entry, id: entry.id, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.status, "ok");
    for (const p of page.parts) collected.push(p.text);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
    guard += 1;
    assert.ok(guard < 50, "翻页次数异常");
  }

  const joined = collected.join("");
  const original = entry.segments.map((s) => s.text).join("");
  assert.equal(joined.length, original.length, "翻页后总长度应与原文一致");
  assert.equal(joined, original, "翻页后内容应与原文完全一致（无遗漏无重复）");
});

test("小片段优先整段装入，不切碎", () => {
  const entry = makeEntry([100, 100, 100]);
  const page = openPage({ entry, id: entry.id });
  assert.equal(page.status, "ok");
  assert.equal(page.parts.length, 3, "三个小片段应在一页内全部返回");
  for (const p of page.parts) {
    assert.equal(p.partial, undefined, "小片段不应标记 partial");
  }
  assert.equal(page.nextCursor, undefined, "应已到末尾");
});

test("超大单片段被切分并标记 partial", () => {
  const entry = makeEntry([50000]);
  const page = openPage({ entry, id: entry.id });
  assert.equal(page.status, "ok");
  const p = page.parts.at(0);
  assert.ok(p);
  assert.equal(p.partial, true, "被切的片段应标记 partial");
  assert.ok(page.nextCursor !== undefined, "应有下一页");
});

test("range 报告已返回范围", () => {
  const entry = makeEntry([3000, 3000]);
  const page = openPage({ entry, id: entry.id });
  assert.equal(page.status, "ok");
  assert.ok(page.range);
  assert.equal(page.range.totalChars, 6000);
  assert.ok(page.range.returnedChars > 0);
  assert.ok(page.range.toChar > page.range.fromChar);
});

test("estimatedTokens 是估算，与字符数一致", () => {
  assert.equal(estimateTokens(2000), 1000);
  assert.equal(estimateTokens(1), 1);
  const entry = makeEntry([3000]);
  const page = openPage({ entry, id: entry.id });
  const chars = page.parts.reduce((s, p) => s + p.text.length, 0);
  assert.equal(page.estimatedTokens, Math.ceil(chars / 2));
});

test("无效 ID 返回 entry-not-found，不崩溃", () => {
  const page = openPage({ entry: undefined, id: "summary-nope" });
  assert.equal(page.status, "entry-not-found");
  assert.equal(page.parts.length, 0);
  assert.match(page.message ?? "", /memory_search/);
});

test("跨会话 ID 返回 cross-session", () => {
  const entry = makeEntry([100]);
  const page = openPage({ entry, id: "summary-other" });
  assert.equal(page.status, "cross-session");
  assert.equal(page.parts.length, 0);
});

test("非法游标返回 bad-cursor，不崩溃", () => {
  const entry = makeEntry([3000]);
  for (const bad of ["abc", "1:2:3", "-1:0", "1.5:0", ""]) {
    const page = openPage({ entry, id: entry.id, cursor: bad });
    // 空字符串按「从头开始」处理
    if (bad === "") {
      assert.equal(page.status, "ok");
    } else {
      assert.equal(page.status, "bad-cursor", `游标「${bad}」应被拒绝`);
    }
  }
});

test("游标越界返回 bad-cursor", () => {
  const entry = makeEntry([100, 100]);
  const tooFar = openPage({ entry, id: entry.id, cursor: "99:0" });
  assert.equal(tooFar.status, "bad-cursor");
  const offsetTooFar = openPage({ entry, id: entry.id, cursor: "0:9999" });
  assert.equal(offsetTooFar.status, "bad-cursor");
});

test("空条目返回 empty-entry", () => {
  const entry = makeEntry([]);
  const page = openPage({ entry, id: entry.id });
  assert.equal(page.status, "empty-entry");
});

test("游标编解码往返一致", () => {
  for (const c of [{ segmentIndex: 0, charOffset: 0 }, { segmentIndex: 12, charOffset: 3456 }]) {
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
  }
  assert.equal(decodeCursor("nope"), null);
  assert.equal(decodeCursor(""), null);
});

test("wasPrunedByHost 识别宿主裁剪标记", () => {
  assert.equal(wasPrunedByHost("完整内容"), false);
  assert.equal(wasPrunedByHost(`头部${PRUNE_MARKER}尾部`), true);
  assert.equal(wasPrunedByHost("a [... tool result middle pruned ...] b"), true);
});

test("来源被宿主裁剪时返回 truncatedByHost 并说明", () => {
  /** @type {import("../src/archive-types.js").ArchiveEntry} */
  const entry = {
    id: "summary-pruned",
    sessionId: SESSION,
    sourceSeqs: [1],
    kind: "prune",
    title: "被裁过的条目",
    preview: "",
    length: 100,
    createdAt: 1,
    segments: [
      {
        seq: 1,
        role: "tool",
        text: `头${PRUNE_MARKER}尾`,
      },
    ],
  };
  const page = openPage({ entry, id: entry.id });
  assert.equal(page.status, "ok");
  assert.equal(page.truncatedByHost, true, "应标记 truncatedByHost");
  assert.match(page.message ?? "", /不可恢复/);
});

test("真实归档能分页读完", () => {
  const entry = firstEntry();
  /** @type {string[]} */
  const collected = [];
  let cursor;
  let guard = 0;
  for (;;) {
    const page = openPage({ entry, id: entry.id, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.status, "ok");
    for (const p of page.parts) collected.push(p.text);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
    guard += 1;
    assert.ok(guard < 100, "翻页次数异常");
  }
  const joined = collected.join("");
  const original = entry.segments.map((s) => s.text).join("");
  assert.equal(joined, original, "真实归档翻页后应与原文一致");
});
