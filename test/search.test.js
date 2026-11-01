/**
 * 关键词搜索的验收测试（V1-03）。
 *
 * 验收标准（Steps.md §5.4）：
 * - 固定题集中至少 16/20 个问题在前 5 条结果中包含预期来源
 * - 另外报告各类别结果，不用一个总分掩盖某一类全部失败
 *
 * @module dsh-smart-context/test/search.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractArchives } from "../src/archive.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_CHARS,
  looksLikePathOrCode,
  parseQuery,
  searchArchives,
} from "../src/search.js";
import { QUERIES, searchCorpusSession } from "./fixtures/search-corpus.js";

const SESSION = "session-search";

/**
 * 提取语料归档（整个测试文件共用一次）。
 * @returns {import("../src/archive-types.js").ArchiveEntry[]}
 */
function corpusEntries() {
  const { entries } = extractArchives({ sessionId: SESSION, events: searchCorpusSession() });
  return entries;
}

test("语料提取出至少一条归档", () => {
  const entries = corpusEntries();
  assert.ok(entries.length >= 1, "语料应产生归档");
  const total = entries.reduce((sum, e) => sum + e.segments.length, 0);
  assert.equal(total, 20, "应有 20 条原文片段");
});

test("空查询返回明确状态", () => {
  const entries = corpusEntries();
  for (const query of ["", "   ", "\t\n"]) {
    const r = searchArchives({ entries, query });
    assert.equal(r.status, "empty-query");
    assert.equal(r.hits.length, 0);
    assert.ok(r.message);
  }
});

test("过长查询被拒绝而不是截断", () => {
  const entries = corpusEntries();
  const query = "x".repeat(MAX_QUERY_CHARS + 1);
  const r = searchArchives({ entries, query });
  assert.equal(r.status, "query-too-long");
  assert.equal(r.hits.length, 0);
});

test("无归档时返回 no-index", () => {
  const r = searchArchives({ entries: [], query: "任何东西" });
  assert.equal(r.status, "no-index");
  assert.ok(r.message);
});

test("零结果时说明不处理同义改写", () => {
  const entries = corpusEntries();
  const r = searchArchives({ entries, query: "一个肯定不存在的词xyzzy" });
  assert.equal(r.status, "no-results");
  assert.match(r.message ?? "", /同义改写/);
});

test("默认返回 5 条，limit 有硬上限", () => {
  const entries = corpusEntries();
  const r = searchArchives({ entries, query: "的" });
  assert.ok(r.hits.length <= DEFAULT_LIMIT, "默认不超过 5 条");

  const big = searchArchives({ entries, query: "的", limit: 999 });
  assert.ok(big.hits.length <= MAX_LIMIT, `不超过硬上限 ${MAX_LIMIT}`);
});

test("翻页游标可用且无重复", () => {
  const entries = corpusEntries();
  const first = searchArchives({ entries, query: "的", limit: 2 });
  assert.equal(first.status, "ok");

  if (first.nextCursor === undefined) return; // 结果太少，跳过

  const second = searchArchives({ entries, query: "的", limit: 2, cursor: first.nextCursor });
  assert.equal(second.status, "ok");

  const firstIds = first.hits.map((h) => h.id);
  const secondIds = second.hits.map((h) => h.id);
  for (const id of secondIds) {
    assert.equal(firstIds.includes(id), false, "翻页不应重复");
  }
});

test("looksLikePathOrCode 识别路径与错误码", () => {
  assert.equal(looksLikePathOrCode("Steps.md"), true);
  assert.equal(looksLikePathOrCode("C:/Users/x"), true);
  assert.equal(looksLikePathOrCode("C:\\Users\\x"), true);
  assert.equal(looksLikePathOrCode("CONTEXT_WINDOW_EXCEEDED"), true);
  assert.equal(looksLikePathOrCode("ctx.sessionQuery"), true);
  assert.equal(looksLikePathOrCode("构建失败"), false);
  assert.equal(looksLikePathOrCode("hello world"), false);
});

test("parseQuery 处理引号精确短语", () => {
  const phrase = parseQuery('"22306 字节"');
  assert.equal(phrase.phrase, "22306 字节");
  assert.deepEqual(phrase.terms, []);

  const terms = parseQuery("foo bar  baz");
  assert.equal(terms.phrase, null);
  assert.deepEqual(terms.terms, ["foo", "bar", "baz"]);
});

test("英文大小写归一", () => {
  const entries = corpusEntries();
  const lower = searchArchives({ entries, query: "err_module_not_found" });
  const upper = searchArchives({ entries, query: "ERR_MODULE_NOT_FOUND" });
  assert.equal(lower.status, "ok");
  assert.equal(upper.status, "ok");
  assert.deepEqual(lower.hits.map((h) => h.id), upper.hits.map((h) => h.id));
});

test("路径/错误码层级排在普通正文之前", () => {
  const entries = corpusEntries();
  // "CONTEXT_WINDOW_EXCEEDED" 应被判为 path-or-code
  const r = searchArchives({ entries, query: "CONTEXT_WINDOW_EXCEEDED" });
  assert.equal(r.status, "ok");
  const top = r.hits.at(0);
  assert.ok(top);
  assert.equal(top.tier, "path-or-code");
});

test("精确短语查询标记为 exact-phrase 层级", () => {
  const entries = corpusEntries();
  const r = searchArchives({ entries, query: '"22306 字节"' });
  assert.equal(r.status, "ok");
  const top = r.hits.at(0);
  assert.ok(top);
  assert.equal(top.tier, "exact-phrase");
});

test("结果包含 id / 标题 / 片段 / 来源 / 长度", () => {
  const entries = corpusEntries();
  const r = searchArchives({ entries, query: "CMAKE_CXX_COMPILER" });
  assert.equal(r.status, "ok");
  const hit = r.hits.at(0);
  assert.ok(hit);
  assert.equal(typeof hit.id, "string");
  assert.equal(typeof hit.title, "string");
  assert.ok(Array.isArray(hit.snippets));
  assert.ok(Array.isArray(hit.sourceSeqs));
  assert.equal(typeof hit.length, "number");
  assert.ok(hit.snippets.length > 0, "应有命中片段");
  const firstSnippet = hit.snippets.at(0);
  assert.ok(firstSnippet);
  assert.match(firstSnippet.text, /CMAKE_CXX_COMPILER/);
});

test("能力边界：同义改写找不到（明确记录，不是 bug）", () => {
  const entries = corpusEntries();

  // 原文写的是「不存原文」「内容哈希」，用「节省空间」去搜必然落空。
  // 这不是缺陷，是关键词搜索的定义域。Steps §5.4 要求记录这个局限。
  const synonym = searchArchives({ entries, query: "节省空间" });
  assert.equal(synonym.status, "no-results", "同义改写应搜不到——这是已知边界");

  // 字面命中则必须找得到
  const literal = searchArchives({ entries, query: "内容哈希" });
  assert.equal(literal.status, "ok");
});

test("能力边界：多词查询是 AND 语义", () => {
  const entries = corpusEntries();

  // "requires an output" 三词同时出现在同一条原文里 → 命中
  const all = searchArchives({ entries, query: "requires an output" });
  assert.equal(all.status, "ok");
  assert.equal(all.relaxed, undefined, "全词命中时不应标注放宽");
});

test("OR 降级：AND 零结果时逐个词重试，并明确标注不是精确匹配", () => {
  const entries = corpusEntries();

  const partial = searchArchives({ entries, query: "requires an output xyzzy" });
  assert.equal(partial.status, "ok", "降级后应返回结果");
  assert.equal(partial.relaxed, true, "必须标注这是放宽匹配");
  assert.match(partial.message ?? "", /放宽|不是精确匹配/, "必须说明不是精确匹配");
});

test("OR 降级：所有词都无命中时仍返回 no-results", () => {
  const entries = corpusEntries();
  const none = searchArchives({ entries, query: "xyzzy plugh frobozz" });
  assert.equal(none.status, "no-results");
  assert.equal(none.relaxed, undefined);
});

test("OR 降级：单字查询不触发（没有可拆的词）", () => {
  const entries = corpusEntries();
  const single = searchArchives({ entries, query: "xyzzy" });
  assert.equal(single.status, "no-results");
  assert.equal(single.relaxed, undefined);
});

test("能力边界：子串匹配，不做词边界判断", () => {
  const entries = corpusEntries();

  // "require" 是 "requires" 的子串 → 命中。
  // 这是**有意为之**：中文没有空格分词，统一的子串匹配更简单可解释。
  // 代价是英文会出现 "require" 命中 "requires" 这类情况，不是缺陷。
  const stem = searchArchives({ entries, query: "require" });
  assert.equal(stem.status, "ok", "子串匹配，require 命中 requires");
});

// ---------------------------------------------------------------------------
// 题集验收：20 条，按类别分组报告
// ---------------------------------------------------------------------------

test("固定题集：各类别分别统计，不用总分掩盖单类失败", () => {
  const entries = corpusEntries();

  /** @type {Map<string, { total: number, pass: number, fails: string[] }>} */
  const byCategory = new Map();

  for (const sample of QUERIES) {
    const bucket = byCategory.get(sample.category) ?? { total: 0, pass: 0, fails: [] };
    bucket.total += 1;

    const r = searchArchives({ entries, query: sample.query, limit: DEFAULT_LIMIT });
    let ok = false;

    if (r.status === "ok") {
      // 命中结果里，任意一条的原文（或片段）包含 expected 即算通过
      for (const hit of r.hits) {
        const inSnippet = hit.snippets.some((s) => s.text.includes(sample.expected));
        if (inSnippet) { ok = true; break; }
        const entry = entries.find((e) => e.id === hit.id);
        if (entry !== undefined && entry.segments.some((seg) => seg.text.includes(sample.expected))) {
          ok = true;
          break;
        }
      }
    }

    if (ok) bucket.pass += 1;
    else bucket.fails.push(sample.query);

    byCategory.set(sample.category, bucket);
  }

  // 输出分类报告（失败时也可见，便于定位是哪一类崩了）
  const report = [...byCategory.entries()]
    .map(([cat, b]) => `${cat}: ${b.pass}/${b.total}${b.fails.length > 0 ? ` 失败=[${b.fails.join(", ")}]` : ""}`)
    .join(" | ");
  console.log("分类报告:", report);

  const totalPass = [...byCategory.values()].reduce((s, b) => s + b.pass, 0);
  const totalAll = [...byCategory.values()].reduce((s, b) => s + b.total, 0);

  assert.ok(totalAll >= 20, `题集应有至少 20 条，当前 ${totalAll}`);
  assert.ok(
    totalPass >= 16,
    `验收要求至少 16/20 命中，当前 ${totalPass}/${totalAll}。分类：${report}`,
  );

  // 每一类都不能全军覆没
  for (const [cat, b] of byCategory) {
    assert.ok(b.pass > 0, `类别「${cat}」全部失败，需单独修复`);
  }
});
