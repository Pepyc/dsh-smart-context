/**
 * 目录渲染的验收测试（V1-06）。
 *
 * 验收标准（Steps.md §5.7）：
 * - 目录包含数量、条目、ID、主题、长度、用法
 * - 预算不超过约 800 token
 * - 无归档时不注入空目录
 * - 内容确定：同样条目产出逐字节相同的文本（否则缓存失效）
 *
 * @module dsh-smart-context/test/directory.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CATALOG_CHARS,
  catalogTokens,
  renderCatalog,
  sameCatalog,
} from "../src/directory.js";

/**
 * 造一个条目。
 * @param {string} id
 * @param {number} length
 * @param {string} title
 * @param {'summary' | 'prune'} [kind]
 * @returns {import("../src/archive-types.js").ArchiveEntry}
 */
function entry(id, length, title, kind = "prune") {
  return {
    id,
    sessionId: "s",
    sourceSeqs: [1],
    kind,
    title,
    preview: "",
    length,
    createdAt: 1700000000000,
    segments: [],
  };
}

test("无归档时返回空字符串（宿主不注入空 context）", () => {
  assert.equal(renderCatalog({ entries: [] }), "");
});

test("目录包含数量、ID、类型、长度、标题、用法", () => {
  const text = renderCatalog({
    entries: [entry("prune-aaa", 8357, "field.json"), entry("summary-bbb", 585831, "早期摘要", "summary")],
  });
  assert.match(text, /本会话有 2 份/);
  assert.match(text, /prune-aaa/);
  assert.match(text, /summary-bbb/);
  assert.match(text, /8K/);
  assert.match(text, /586K/);
  assert.match(text, /field\.json/);
  assert.match(text, /裁剪/);
  assert.match(text, /摘要/);
  assert.match(text, /memory_search/);
  assert.match(text, /memory_open/);
});

test("同样的条目产出逐字节相同的文本（缓存关键）", () => {
  const entries = [entry("prune-b", 100, "B"), entry("prune-a", 200, "A")];
  const first = renderCatalog({ entries });
  const second = renderCatalog({ entries: [...entries].reverse() });
  assert.equal(first, second, "顺序不同也应产出相同文本");
  assert.ok(sameCatalog(first, second));
});

test("目录不含时间戳或会变化的内容", () => {
  const text = renderCatalog({ entries: [entry("prune-a", 100, "A")] });
  // 不能出现年份/时间/「刚刚」之类
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(text, /刚刚|更新于|生成于/);
});

test("条目按 id 排序，不依赖传入顺序", () => {
  const text = renderCatalog({
    entries: [entry("prune-zzz", 100, "Z"), entry("prune-aaa", 100, "A")],
  });
  const aPos = text.indexOf("prune-aaa");
  const zPos = text.indexOf("prune-zzz");
  assert.ok(aPos < zPos, "aaa 应排在 zzz 之前");
});

test("预算不超过 800 token（1600 字符）", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    entry(`prune-${String(i).padStart(3, "0")}`, 1000 * (i + 1), `标题 ${i}`),
  );
  const text = renderCatalog({ entries: many });
  assert.ok(text.length <= MAX_CATALOG_CHARS, `目录 ${text.length} 字符，超出预算`);
  assert.ok(catalogTokens(text) <= 800, `目录 ${catalogTokens(text)} token，超出预算`);
  assert.match(text, /未列出|已截断/, "应说明有未列出的条目");
});

test("超过 12 条时只列前 12 条并说明其余可搜索", () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    entry(`prune-${String(i).padStart(3, "0")}`, 100, `T${i}`),
  );
  const text = renderCatalog({ entries: many });
  assert.match(text, /另有 8 份未列出/);
});

test("少量条目时全部列出", () => {
  const text = renderCatalog({ entries: [entry("prune-a", 100, "A")] });
  assert.doesNotMatch(text, /未列出/);
  assert.match(text, /本会话有 1 份/);
});

test("catalogTokens 按 chars/2 估算", () => {
  assert.equal(catalogTokens("abcd"), 2);
  assert.equal(catalogTokens("abcde"), 3);
});
