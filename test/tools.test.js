/**
 * 工具定义的验收测试（V1-05）。
 * @module dsh-smart-context/test/tools.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractArchives } from "../src/archive.js";
import { createOpenTool, createSearchTool, OPEN_TOOL, SEARCH_TOOL } from "../src/tools.js";
import { compactionSession } from "./fixtures/compaction-sample.js";

const SESSION = "session-tools";
const exec = { agent: { id: SESSION } };

/**
 * 用真实提取的归档造一个 loadEntries。
 * @returns {Promise<import("../src/archive-types.js").ArchiveEntry[]>}
 */
async function loadEntries() {
  const { entries } = extractArchives({ sessionId: SESSION, events: compactionSession() });
  return entries;
}

/** 宿主支持的 schema 子集关键字。 */
const ALLOWED_KEYS = new Set([
  "type", "oneOf", "properties", "required", "additionalProperties", "items",
  "enum", "const", "description", "title", "default", "examples",
]);

/**
 * 递归检查 schema 节点。
 * @param {unknown} node
 * @param {string} path
 */
function assertSchemaSubset(node, path) {
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    assert.ok(ALLOWED_KEYS.has(key), `${path}.${key} 不在宿主支持的子集内`);
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [propName, propNode] of Object.entries(value)) {
        assertSchemaSubset(propNode, `${path}.properties.${propName}`);
      }
    } else if (key === "items") {
      assertSchemaSubset(value, `${path}.items`);
    } else if (key === "oneOf" && Array.isArray(value)) {
      value.forEach((v, i) => assertSchemaSubset(v, `${path}.oneOf[${i}]`));
    }
  }
}

/**
 * 递归检查 object 节点都有 additionalProperties。
 * @param {any} node
 * @param {string} path
 */
function assertObjectClosed(node, path) {
  if (node === null || typeof node !== "object") return;
  if (node.type === "object") {
    assert.equal(typeof node.additionalProperties, "boolean", `${path} 缺少 additionalProperties`);
  }
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) assertObjectClosed(v, `${path}.${k}`);
  }
  if (node.items) assertObjectClosed(node.items, `${path}.items`);
}

test("工具名不与既有插件冲突", () => {
  assert.equal(SEARCH_TOOL, "memory_search");
  assert.equal(OPEN_TOOL, "memory_open");
  assert.notEqual(SEARCH_TOOL, "run_code");
  assert.notEqual(OPEN_TOOL, "run_code");
});

test("两个工具都声明了 output.schema 与 render", () => {
  for (const tool of [createSearchTool({ loadEntries }), createOpenTool({ loadEntries })]) {
    assert.equal(typeof tool.output.schema, "object");
    assert.equal(typeof tool.output.render, "function", "缺 render 会在 register 时抛 TypeError");
  }
});

test("schema 只用宿主支持的子集关键字", () => {
  for (const tool of [createSearchTool({ loadEntries }), createOpenTool({ loadEntries })]) {
    assertSchemaSubset(tool.parameters, `${tool.name}.parameters`);
    assertSchemaSubset(tool.output.schema, `${tool.name}.output.schema`);
  }
});

test("object 节点都显式声明 additionalProperties", () => {
  for (const tool of [createSearchTool({ loadEntries }), createOpenTool({ loadEntries })]) {
    assertObjectClosed(tool.parameters, `${tool.name}.parameters`);
    assertObjectClosed(tool.output.schema, `${tool.name}.output.schema`);
  }
});

test("memory_search 端到端：找到归档", async () => {
  const tool = createSearchTool({ loadEntries });
  const r = /** @type {any} */ (await tool.execute({ query: "P0-01" }, exec));
  assert.equal(r.status, "ok");
  assert.ok(r.hits.length > 0);
  assert.ok(r.hits[0].id);
});

test("memory_open 端到端：打开并翻页", async () => {
  const search = createSearchTool({ loadEntries });
  const open = createOpenTool({ loadEntries });
  const found = /** @type {any} */ (await search.execute({ query: "P0-01" }, exec));
  const page = /** @type {any} */ (await open.execute({ id: found.hits[0].id }, exec));
  assert.equal(page.status, "ok");
  assert.ok(page.parts.length > 0);
  assert.ok(page.range.totalChars > 0);
});

test("render 输出不超过 pruner 阈值（回归）", async () => {
  const search = createSearchTool({ loadEntries });
  const open = createOpenTool({ loadEntries });
  const found = /** @type {any} */ (await search.execute({ query: "P0-01" }, exec));
  const page = await open.execute({ id: found.hits[0].id }, exec);
  const blocks = open.output.render({}, page);
  assert.equal(blocks.length, 1);
  const first = blocks.at(0);
  assert.ok(first !== undefined);
  const text = /** @type {any} */ (first).text;
  assert.ok(text.length <= 6000, `render 输出 ${text.length} 字符，可能被宿主裁剪`);
});

test("render 输出是紧凑 JSON，不带缩进", async () => {
  const search = createSearchTool({ loadEntries });
  const r = await search.execute({ query: "P0-01" }, exec);
  const blocks = search.output.render({}, r);
  const first = blocks.at(0);
  assert.ok(first !== undefined);
  const text = /** @type {any} */ (first).text;
  assert.equal(text.includes("\n  "), false, "缩进会让体积膨胀三倍");
});

test("memory_open 对无效 ID 返回 entry-not-found", async () => {
  const tool = createOpenTool({ loadEntries });
  const r = /** @type {any} */ (await tool.execute({ id: "summary-nope" }, exec));
  assert.equal(r.status, "entry-not-found");
});
