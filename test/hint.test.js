/**
 * 系统提示常驻提示的验收测试。
 *
 * 核心约束：**内容必须逐字节确定**。系统提示在请求最前面，
 * 改一个字节就是全量前缀缓存失效。
 *
 * @module dsh-smart-context/test/hint.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CATALOG_HINT, shouldShowHint } from "../src/hint.js";

test("提示非空且包含工具名", () => {
  assert.ok(CATALOG_HINT.length > 0);
  assert.match(CATALOG_HINT, /memory_search/);
  assert.match(CATALOG_HINT, /memory_open/);
});

test("提示指向 runtime context 末尾，用具体锚点而非模糊描述", () => {
  assert.match(CATALOG_HINT, /runtime context/i);
  assert.match(CATALOG_HINT, /末尾/);
  assert.match(CATALOG_HINT, /本会话有 N 份已归档的历史内容/);
});

test("提示说明搜索范围是全部归档，不只是列出的", () => {
  assert.match(CATALOG_HINT, /全部/);
});

test("提示说明字面匹配的边界", () => {
  assert.match(CATALOG_HINT, /字面匹配/);
  assert.match(CATALOG_HINT, /同义改写/);
  assert.match(CATALOG_HINT, /词干还原/);
});

test("提示完全静态：不含时间、数量、ID、会话信息", () => {
  assert.doesNotMatch(CATALOG_HINT, /\d{4}-\d{2}-\d{2}/, "不应含日期");
  assert.doesNotMatch(CATALOG_HINT, /\d{2}:\d{2}/, "不应含时间");
  assert.doesNotMatch(CATALOG_HINT, /prune-|summary-/, "不应含归档 ID");
  assert.doesNotMatch(CATALOG_HINT, /本会话有 \d+ 份/, "不应含具体数量");
});

test("多次读取返回同一字符串（引用稳定）", () => {
  const a = CATALOG_HINT;
  const b = CATALOG_HINT;
  assert.equal(a, b);
  assert.equal(a.length, b.length);
});

test("常驻：shouldShowHint 始终为 true", () => {
  assert.equal(shouldShowHint(), true);
});

test("长度在合理范围（几百字符，不是几千）", () => {
  assert.ok(CATALOG_HINT.length >= 100, `过短：${CATALOG_HINT.length}`);
  assert.ok(CATALOG_HINT.length <= 800, `过长：${CATALOG_HINT.length}`);
});
