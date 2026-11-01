import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics } from "../src/diagnostics.js";

const value = { status: "ok", hits: [{ id: "A", snippets: [{ text: "ORIGINAL" }] }], total: 1 };

test("BUG-27 混合输出中独立的完整 JSON 在工具最终内容和请求中都可识别", () => {
  /** @type {any[]} */ const logs = [];
  const audit = createDiagnostics((line) => logs.push(JSON.parse(line.slice(22))));
  const exec = { agent: { id: "audit" }, callId: "child", rootCallId: "root", name: "memory_search" };
  audit.tool({}, exec, value);
  for (const text of [
    JSON.stringify(value) + "\nFile sandbox enforcement is partial on this host.",
    "DEBUG\n" + JSON.stringify(value) + "\n" + JSON.stringify({ unrelated: true }),
    "DEBUG\n" + JSON.stringify(value, null, 2) + "\nFINISHED",
  ]) {
    const content = [{ type: "text", text }];
    audit.final({ ...exec, name: "run_code", callId: "root" }, { content });
    audit.request({ sessionId: "audit", messages: [{ role: "tool", toolCallId: "root", content }] });
    assert.equal(logs.at(-2).canonicalMatches, true);
    assert.equal(logs.at(-1).retrievals[0].visibility, "complete");
  }
});

test("BUG-27 不把普通文本中的片段、缺失字段或其他会话视为完整送达", () => {
  /** @type {any[]} */ const logs = [];
  const audit = createDiagnostics((line) => logs.push(JSON.parse(line.slice(22))));
  audit.tool({}, { agent: { id: "audit" }, callId: "child", rootCallId: "root", name: "memory_search" }, value);
  for (const text of ["PREFIX " + JSON.stringify(value) + " SUFFIX", JSON.stringify({ ...value, hits: [] }) + "\nnotice", JSON.stringify(value).slice(0,-1) + "\nnotice"]) {
    audit.request({ sessionId: "audit", messages: [{ role: "tool", toolCallId: "root", content: [{ type: "text", text }] }] });
    assert.equal(logs.at(-1).retrievals[0].visibility, "changed-or-partial");
  }
  audit.request({ sessionId: "other", messages: [{ role: "tool", toolCallId: "root", content: [{ type: "text", text: JSON.stringify(value) }] }] });
  assert.equal(logs.at(-1).retrievals.length, 0);
});
