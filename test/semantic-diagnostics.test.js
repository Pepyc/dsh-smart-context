import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnostics } from "../src/diagnostics.js";

/** @param {any} value @returns {any} */
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k, reordered(v)]));
  return value;
}

test("BUG-21 JSON 键重排仍算完整，字节前缀诊断仍能识别变化", () => {
  /** @type {any[]} */ const logs = [];
  const audit = createDiagnostics((line) => logs.push(JSON.parse(line.slice(22))));
  const value = { status: "ok", hits: [{ id: "a", snippets: [{ text: "FIRST", seq: 1 }] }, { id: "b", snippets: [{ text: "SECOND", seq: 2 }] }] };
  const exec = { agent: { id: "audit" }, callId: "nested", rootCallId: "root", name: "memory_search" };
  audit.tool({}, exec, value);
  /** @param {any} payload */
  function request(payload) {
    const content = [{ type: "text", text: JSON.stringify({ logs: [JSON.stringify(payload)] }) }];
    audit.final({ ...exec, name: "run_code", callId: "root" }, { content, isError: false });
    audit.request({ sessionId: "audit", provider: "synthetic", model: "synthetic", messages: [
      { role: "assistant", content: [{ type: "tool-call", id: "root", name: "run_code" }] },
      { role: "tool", toolCallId: "root", content },
    ] });
    return logs.at(-1);
  }
  const before = request(value);
  const after = request(reordered(value));
  assert.equal(after.retrievals[0].visibility, "complete");
  assert.equal(logs.filter((r) => r.stage === "tool-final").at(-1)?.canonicalMatches, true);
  assert.notEqual(before.requestHash, after.requestHash);
  assert.equal(after.commonPrefixMessages, 1);
  for (const changed of [
    { ...value, hits: [...value.hits].reverse() },
    { ...value, hits: [{ id: "a", snippets: [{ text: "CHANGED", seq: 1 }] }, value.hits[1]] },
    { ...value, hits: value.hits.slice(0,1) },
    { hits: value.hits },
  ]) assert.equal(request(changed).retrievals[0].visibility, "changed-or-partial");
});
