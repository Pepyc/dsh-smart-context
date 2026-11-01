import test from "node:test";
import assert from "node:assert/strict";
import { extractArchives } from "../src/archive.js";
import { searchArchives } from "../src/search.js";

const own = { status: "no-results", hits: [], total: 0 };
const simple = 'const v = await tools.memory_search({query:"UNIQUE_NEEDLE"}); console.log(JSON.stringify(v));';
/** @param {string} code @param {string} output @param {boolean} [mixed] @param {boolean} [withDispatch] @param {string} [name] @param {unknown} [response] @returns {import('../src/archive-types.js').SessionEvent[]} */
function session(code, output, mixed = false, withDispatch = true, name = "memory_search", response = own) {
  const events = [
    { seq: 1, time: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool-call", id: "root", name: "run_code", arguments: { code } }] } } },
    ...(withDispatch ? [{ seq: 2, time: 2, type: "tool/ptc-dispatch", data: { parentCallId: "root", rootCallId: "root", subCallId: "child", name, arguments: {}, isError: false, content: [{ type: "text", text: JSON.stringify(response) }] } }] : []),
    ...(mixed ? [{ seq: 3, time: 3, type: "tool/ptc-dispatch", data: { parentCallId: "root", rootCallId: "root", subCallId: "business", name: "read_file", arguments: {}, isError: false, content: [{ type: "text", text: "BUSINESS" }] } }] : []),
    { seq: 4, time: 4, type: "tool/result", data: { message: { role: "tool", toolCallId: "root", content: [{ type: "text", text: output }] } } },
    { seq: 5, time: 5, type: "compaction/start", data: {} },
    { seq: 6, time: 6, type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 4 }, sourceEventSeqs: [5,1,4], data: { role: "user", source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "SUMMARY" }] } },
  ];
  return /** @type {import('../src/archive-types.js').SessionEvent[]} */ (events);
}

test("BUG-26 可信的纯检索程序不会产生只含调用代码的伪归档", () => {
  for (const output of [JSON.stringify(own), JSON.stringify({ logs: [JSON.stringify(own)] })]) {
    const { entries } = extractArchives({ sessionId: "audit", events: session(simple, output) });
    assert.deepEqual(entries, []);
    assert.equal(searchArchives({ entries, query: "UNIQUE_NEEDLE" }).status, "no-index");
  }
});

test("BUG-26 直接打印或返回单次检索结果的程序也不会产生伪归档", () => {
  const programs = [
    'console.log(JSON.stringify(await tools.memory_search({query:"UNIQUE_NEEDLE"})));',
    'return await tools.memory_search({query:"UNIQUE_NEEDLE"});',
  ];
  for (const code of programs) {
    const { entries } = extractArchives({ sessionId: "audit", events: session(code, JSON.stringify(own)) });
    assert.deepEqual(entries, []);
  }
});

test("纯搜索程序使用 snippets 时不会把检索内容再次归档", () => {
  const code = 'const v = await tools.memory_search({query:"UNIQUE_NEEDLE",snippets:5}); console.log(JSON.stringify(v));';
  assert.deepEqual(extractArchives({ sessionId: "audit", events: session(code, JSON.stringify(own)) }).entries, []);
});

test("纯打开程序使用 seq 时不会把检索内容再次归档", () => {
  const opened = { status: "ok", id: "archive", parts: [{ seq: 7, role: "tool", text: "RETRIEVED_ONLY", offset: 0 }] };
  const events = session('return await tools.memory_open({id:"archive",seq:7});', JSON.stringify(opened), false, true, "memory_open", opened);
  assert.deepEqual(extractArchives({ sessionId: "audit", events }).entries, []);
});

test("带 snippets 的混合业务程序仍保留原文", () => {
  const code = 'const v = await tools.memory_search({query:"UNIQUE_NEEDLE",snippets:5}); const invoice = 100; console.log(JSON.stringify(v));';
  const entry = extractArchives({ sessionId: "audit", events: session(code, JSON.stringify(own)) }).entries[0];
  assert.ok(entry);
  assert.ok(entry.segments.some((segment) => segment.text.includes("invoice = 100")));
});

test("BUG-26 混合业务程序、不明来源或其他输出必须保留调用代码", () => {
  const cases = [
    session(simple, JSON.stringify(own), true),
    session(simple, JSON.stringify(own), false, false),
    session(simple, JSON.stringify(own) + "\nBUSINESS"),
    session('const v = await tools.memory_search({query:"UNIQUE_NEEDLE"}); const invoice = 100; console.log(JSON.stringify(v));', JSON.stringify(own)),
    session('const v = await tools.memory_search({query:doBusiness()}); console.log(JSON.stringify(v));', JSON.stringify(own)),
  ];
  for (const events of cases) {
    const entry = extractArchives({ sessionId: "audit", events }).entries[0]; assert.ok(entry);
    assert.ok(entry.segments.some((s) => s.text.includes("UNIQUE_NEEDLE") || s.text.includes("doBusiness")));
  }
});

test("BUG-26 同条助手消息的其他原文不随纯检索调用一起删除", () => {
  const events = session(simple, JSON.stringify(own));
  const assistant = /** @type {any} */ (events[0]);
  assistant.data.message.content.unshift({ type: "text", text: "ORIGINAL_ASSISTANT_NOTE" });
  const entry = extractArchives({ sessionId: "audit", events }).entries[0]; assert.ok(entry);
  assert.deepEqual(entry.segments.map((s) => s.text), ["ORIGINAL_ASSISTANT_NOTE"]);
});
