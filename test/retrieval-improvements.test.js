/**
 * 三项检索改进的验收测试（2026-10-30）。
 *
 * 背景：实测某归档 138 万字符，`list_plugins` 命中 43 处，
 * 但只返回 3 个片段，答案在第 4 个之后的命中点——模型够不到。
 *
 * @module dsh-smart-context/test/retrieval-improvements.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { openPage } from "../src/pagination.js";
import { searchArchives, MAX_SNIPPETS } from "../src/search.js";
import { createOpenTool } from "../src/tools.js";

/**
 * 造一条多片段归档。
 * @param {Array<{ seq: number, text: string }>} segments
 * @returns {import("../src/archive-types.js").ArchiveEntry}
 */
function entryOf(segments) {
  return {
    id: "prune-aaaa1111",
    sessionId: "s",
    sourceSeqs: segments.map((s) => s.seq),
    kind: "prune",
    title: "测试归档",
    preview: "",
    length: segments.reduce((n, s) => n + s.text.length, 0),
    createdAt: 1,
    segments: segments.map((s) => ({ seq: s.seq, role: "tool", text: s.text })),
  };
}

// ---------------------------------------------------------------------------
// 一、memory_open 按 seq 跳点
// ---------------------------------------------------------------------------

test("openPage：seq 直接跳到对应片段，不用从头翻", () => {
  const entry = entryOf([
    { seq: 10, text: "A".repeat(5000) },
    { seq: 20, text: "B".repeat(5000) },
    { seq: 30, text: "TARGET".repeat(100) },
  ]);
  const page = openPage({ entry, id: entry.id, seq: 30 });
  assert.equal(page.status, "ok");
  assert.equal(page.parts[0]?.seq, 30);
  assert.match(page.parts[0]?.text ?? "", /TARGET/);
  assert.equal(page.range?.fromChar, 10000, "应从第三个片段的起点开始");
});

test("openPage：seq 不存在时报错并列出可用 seq", () => {
  const entry = entryOf([{ seq: 10, text: "x" }, { seq: 20, text: "y" }]);
  const page = openPage({ entry, id: entry.id, seq: 999 });
  assert.equal(page.status, "bad-cursor");
  assert.match(page.message ?? "", /999/);
  assert.match(page.message ?? "", /10.*20/, "应列出可用 seq");
});

test("openPage：seq 优先于 cursor", () => {
  const entry = entryOf([{ seq: 10, text: "A".repeat(100) }, { seq: 20, text: "B".repeat(100) }]);
  const page = openPage({ entry, id: entry.id, seq: 20, cursor: "0:0" });
  assert.equal(page.status, "ok");
  assert.equal(page.parts[0]?.seq, 20, "seq 应压过 cursor");
});

test("memory_open 拒绝无效 seq，不能静默退回归档开头", async () => {
  const entry = entryOf([{ seq: 0, text: "FIRST" }, { seq: 20, text: "SECOND" }]);
  const tool = createOpenTool({ loadEntries: async () => [entry] });
  for (const seq of [-1, 1.5, 9007199254740992, "20", null]) {
    const page = /** @type {any} */ (await tool.execute({ id: entry.id, seq }, { agent: { id: "s" } }));
    assert.equal(page.status, "bad-cursor", `不应忽略 seq=${String(seq)}`);
    assert.deepEqual(page.parts, []);
  }
  const valid = /** @type {any} */ (await tool.execute({ id: entry.id, seq: 0 }, { agent: { id: "s" } }));
  assert.equal(valid.status, "ok");
  assert.equal(valid.parts[0]?.seq, 0);
});

// ---------------------------------------------------------------------------
// 二、命中片段数量与排序
// ---------------------------------------------------------------------------

test("默认返回 5 个片段（原来是 3 个）", () => {
  const segments = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, text: `keyword 出现在第 ${i + 1} 段` }));
  const entry = entryOf(segments);
  const r = searchArchives({ entries: [entry], query: "keyword" });
  assert.equal(r.status, "ok");
  assert.equal(r.hits[0]?.snippets.length, 5);
});

test("snippets 参数可调，上限 15", () => {
  const segments = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, text: `keyword 第 ${i + 1} 段` }));
  const entry = entryOf(segments);
  const many = searchArchives({ entries: [entry], query: "keyword", snippets: 15 });
  assert.equal(many.hits[0]?.snippets.length, 15);
  const over = searchArchives({ entries: [entry], query: "keyword", snippets: 999 });
  assert.equal(over.hits[0]?.snippets.length, MAX_SNIPPETS, "超过上限应钳到 15");
});

test("同一片段的多次命中各自返回原文坐标和可打开的游标", () => {
  const prefix = "İ😀".repeat(40);
  const gap = " ".repeat(200);
  const text = `${prefix}needle first${gap}NEEDLE second${gap}needle third`;
  const entry = entryOf([{ seq: 1, text }]);
  const hit = searchArchives({ entries: [entry], query: "needle", snippets: 5 }).hits[0];
  assert.ok(hit);
  assert.equal(hit.matchCount, 3);
  assert.equal(hit.snippets.length, 3);
  /** @type {Array<[string, number]>} */
  const expected = [["needle first", prefix.length], ["NEEDLE second", prefix.length + 12 + gap.length], ["needle third", prefix.length + 25 + 2 * gap.length]];
  for (const [marker, offset] of expected) {
    /** @type {import('../src/search-types.js').SearchSnippet | undefined} */
    const snippet = hit.snippets.find((s) => s.offset === offset);
    assert.ok(snippet, `缺少 ${marker} 的命中坐标`);
    assert.match(snippet.text, new RegExp(marker));
    const page = openPage({ entry, id: entry.id, cursor: snippet.cursor, maxChars: 180 });
    assert.equal(page.status, "ok");
    assert.ok(page.parts.map((part) => part.text).join("").includes(marker));
  }
});

test("同一片段后面的高价值命中能排到前面", () => {
  const text = `keyword first${" ".repeat(200)}keyword result=231`;
  const entry = entryOf([{ seq: 1, text }]);
  const hit = searchArchives({ entries: [entry], query: "keyword", snippets: 1 }).hits[0];
  assert.ok(hit);
  assert.equal(hit.matchCount, 2);
  assert.equal(hit.snippets[0]?.offset, 213);
  assert.match(hit.snippets[0]?.text ?? "", /result=231/);
});

test("多词命中点优先：同段含全部查询词的片段排前面", () => {
  const entry = entryOf([
    { seq: 1, text: "alpha 单独出现，后面没有别的词，" + "填充".repeat(30) },
    { seq: 2, text: "这里 alpha 和 beta 紧挨着出现" },
    { seq: 3, text: "beta 单独出现" },
  ]);
  const r = searchArchives({ entries: [entry], query: "alpha beta", snippets: 3 });
  assert.equal(r.status, "ok");
  const first = r.hits[0]?.snippets[0];
  assert.equal(first?.seq, 2, "两词同段的片段应排第一");
});

test("含数字的命中点优先于纯文字", () => {
  const entry = entryOf([
    { seq: 1, text: "value 出现在这里但没有数字" },
    { seq: 2, text: "value 是 231 条" },
  ]);
  const r = searchArchives({ entries: [entry], query: "value", snippets: 2 });
  assert.equal(r.hits[0]?.snippets[0]?.seq, 2, "含数字的应排前面");
});

test("片段去重：同一 seq 同一 offset 只出现一次", () => {
  const entry = entryOf([{ seq: 1, text: "dup dup dup" }]);
  const r = searchArchives({ entries: [entry], query: "dup", snippets: 5 });
  const seen = new Set();
  for (const s of r.hits[0]?.snippets ?? []) {
    const key = `${s.seq}:${s.offset}`;
    assert.equal(seen.has(key), false, `重复片段：${key}`);
    seen.add(key);
  }
});
