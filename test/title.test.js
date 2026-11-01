/**
 * 标题提取的验收测试。
 *
 * 依据：2026-10-30 真实会话审计。13 条归档里 12 条 prune 的标题是
 * `"{"`、`"TOTAL 275"`、`"M-?M-CM-?"`、分隔线这类无信息内容。
 *
 * @module dsh-smart-context/test/title.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TITLE_CHARS,
  deriveTitle,
  extractByShape,
  isUselessTitle,
} from "../src/title.js";

/** @param {string} text @param {'tool'|'user'|'assistant'} [role] @param {string} [sourceKind] */
function seg(text, role = "tool", sourceKind) {
  return { seq: 1, role, text, ...(sourceKind === undefined ? {} : { sourceKind }) };
}

test("无用标题被识别：太短、纯括号、分隔线、乱码、系统注入", () => {
  for (const bad of ["{", "}", "[]", "TOTAL", "ok", "====", "--------", "####",
    "M-?M-CM-?M-CM-?", "<system-reminder>\nA skill is..."]) {
    assert.equal(isUselessTitle(bad), true, `应判为无用：${JSON.stringify(bad)}`);
  }
});

test("有用标题不被误杀", () => {
  for (const good of ["请阅读readme", "=== biobuzz_2026/field.json ===", "#include \"sim/match_clock.hpp\"",
    "这是用户说的一句完整的话", "const result = await tools.read({})"]) {
    assert.equal(isUselessTitle(good), false, `不应判为无用：${JSON.stringify(good)}`);
  }
});

test("形态 1：=== 路径 === 取路径", () => {
  assert.equal(extractByShape("=== biobuzz_2026/field.json ( 253 lines ) ===\n{\n  \"a\": 1"), "biobuzz_2026/field.json");
  assert.equal(extractByShape("===== Planing/important/HANDOFF.md (36 lines) =====\n# AI 交接"), "important/HANDOFF.md");
});

test("形态 2：行号 + #include 取文件名", () => {
  assert.equal(extractByShape('1: #include "sim/match_clock.hpp"\n2:'), "sim/match_clock.hpp");
  assert.equal(extractByShape("1: #pragma once\n2:"), "#pragma once");
});

test("形态 2：分隔线注释返回 null，交给兜底", () => {
  assert.equal(extractByShape("1: // ======================================================"), null);
});

test("形态 3：git status 取摘要", () => {
  const text = "M .gitignore\nM Planing/important/CHANGELOG.md\nM Planing/important/HANDOFF.md";
  const r = extractByShape(text);
  assert.ok(r !== null);
  assert.match(r, /git status（3 个文件/);
});

test("形态 4：JSON 取顶层键名", () => {
  const r = extractByShape('{"schema_version":1,"name":"BIOBUZZ","field":{}}');
  assert.equal(r, "JSON: schema_version, name, field");
  assert.equal(extractByShape("[1,2,3]"), "JSON 数组（3 项）");
});

test("形态 4：被裁断的 JSON 不报错，落到兜底", () => {
  const r = extractByShape('{"schema_version":1,"na');
  assert.equal(r, null);
});

test("deriveTitle 优先真实用户消息，跳过 runtime-context", () => {
  const segments = [
    seg("<system-reminder>宿主注入的内容</system-reminder>", "user", "runtime-context"),
    seg("帮我看看这个报错", "user", "user"),
  ];
  assert.equal(deriveTitle(segments), "帮我看看这个报错");
});

test("deriveTitle 兜底：全部片段都无用时不假装有标题", () => {
  const segments = [seg("{"), seg("}"), seg("[]")];
  assert.equal(deriveTitle(segments), "(无可读标题)");
});

test("deriveTitle 跳过无用片段，选第一个有信息量的行", () => {
  const segments = [seg("{\n\"a\": 1\n}")];
  const r = deriveTitle(segments);
  assert.notEqual(r, "{");
});

test("标题长度受限且不拆 emoji", () => {
  const long = "这是一段很长的中文标题".repeat(10);
  const r = deriveTitle([seg(long, "user", "user")]);
  assert.ok(r.length <= MAX_TITLE_CHARS + 1, `实际 ${r.length}`);
  assert.equal(/[\uD800-\uDBFF]$/.test(r.slice(0, -1)), false, "不应以孤立高代理结尾");
});

test("确定性：同样输入两次结果相同", () => {
  const segments = [seg("=== a/b.json ===\n{}")];
  assert.equal(deriveTitle(segments), deriveTitle(segments));
});

// ---------------------------------------------------------------------------
// 第三层：用 tool/call 的调用参数补充标题
// ---------------------------------------------------------------------------

/** @param {number} callSeq @param {string} callId @param {string} name @param {object} args @param {number} resultSeq @param {string} text */
function callPair(callSeq, callId, name, args, resultSeq, text) {
  return [
    { seq: callSeq, time: callSeq, type: "tool/call", data: { callId, name, arguments: JSON.stringify(args) } },
    { seq: resultSeq, time: resultSeq, type: "tool/result", data: {
      name,
      message: { role: "tool", toolCallId: callId, content: [{ type: "text", text }] },
    } },
  ];
}

test("第三层：内容无信息时用调用参数补充标题", async () => {
  const { buildEntry } = await import("../src/archive.js");
  const events = callPair(1, "call-1", "read", { path: "E:/Codex/proj/Planing/important/Steps.md" }, 2, "{");
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const { entry } = buildEntry({ sessionId: "audit", kind: "prune", sourceSeqs: [2], bySeq });
  assert.equal(entry?.title, "read: important/Steps.md");
});

test("第三层：内容有信息时不覆盖", async () => {
  const { buildEntry } = await import("../src/archive.js");
  const events = callPair(1, "call-2", "read", { path: "a/b/c.json" }, 2, "=== biobuzz/field.json ===\n{}");
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const { entry } = buildEntry({ sessionId: "audit", kind: "prune", sourceSeqs: [2], bySeq });
  assert.equal(entry?.title, "biobuzz/field.json", "不应被调用参数覆盖");
});

test("第三层：没有 tool/call 记录时退回占位符", async () => {
  const { buildEntry } = await import("../src/archive.js");
  const events = [{ seq: 2, time: 2, type: "tool/result", data: {
    name: "read",
    message: { role: "tool", toolCallId: "call-3", content: [{ type: "text", text: "{" }] },
  } }];
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const { entry } = buildEntry({ sessionId: "audit", kind: "prune", sourceSeqs: [2], bySeq });
  assert.equal(entry?.title, "(无可读标题)");
});

test("第三层不读正文，只读调用元数据", async () => {
  const { titleFromCallArguments } = await import("../src/title.js");
  const events = callPair(1, "call-4", "grep", { pattern: "TODO", path: "src" }, 2, "{");
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  /** @type {import("../src/archive-types.js").ArchiveSegment[]} */
  const segments = [{ seq: 2, role: "tool", text: "{", toolCallId: "call-4" }];
  const toolNames = new Map([["call-4", "grep"]]);
  assert.equal(titleFromCallArguments(toolNames, bySeq, segments), "grep: src");
});

test("调用参数标题截断不拆开 emoji", async () => {
  const { titleFromCallArguments } = await import("../src/title.js");
  const events = callPair(1, "call-emoji", "grep", { query: "a".repeat(39) + "😀" + "tail" }, 2, "{");
  const title = titleFromCallArguments(new Map([["call-emoji", "grep"]]), new Map(events.map((event) => [event.seq, event])), [{ seq: 2, role: "tool", text: "{", toolCallId: "call-emoji" }]);
  assert.ok(title);
  assert.equal(Buffer.from(title, "utf8").toString("utf8"), title);
  assert.ok(title.length <= MAX_TITLE_CHARS + 1);
});

test("调用参数标题的长路径及长工具名遵守标题预算", async () => {
  const { titleFromCallArguments } = await import("../src/title.js");
  const name = "tool".repeat(30);
  const events = callPair(1, "call-long", name, { path: "a/" + "dir".repeat(30) + "/" + "file".repeat(30) }, 2, "{");
  const title = titleFromCallArguments(new Map([["call-long", name]]), new Map(events.map((event) => [event.seq, event])), [{ seq: 2, role: "tool", text: "{", toolCallId: "call-long" }]);
  assert.ok(title);
  assert.ok(title.length <= MAX_TITLE_CHARS + 1);
  assert.equal(Buffer.from(title, "utf8").toString("utf8"), title);
});

