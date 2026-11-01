/**
 * 归档提取的验收测试（V1-01）。
 *
 * 验收标准（Steps.md §5.2）：
 * - 未压缩会话得到空归档
 * - 一次压缩能还原来源
 * - 重复压缩不重复算入同一来源
 * - 来源缺失返回明确错误
 *
 * @module dsh-smart-context/test/archive.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { extractArchives, renderEvent, makeId, SCHEMA_VERSION } from "../src/archive.js";
import {
  plainSession,
  compactionSession,
  missingSourceSession,
  repeatedCompactionSession,
  systemRewriteSession,
} from "./fixtures/compaction-sample.js";

const SESSION = "session-test-1";

/**
 * 构造一条替换事件（测试内联用）。
 * @param {number} seq
 * @param {number[]} sourceEventSeqs
 * @param {string} text
 * @returns {import("../src/archive-types.js").SessionEvent}
 */
function replacement(seq, sourceEventSeqs, text) {
  return {
    type: "user/message",
    seq,
    time: 1700000000000 + seq * 1000,
    data: {
      message: {
        id: `m${seq}`,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
      },
    },
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 },
    sourceEventSeqs,
  };
}

test("未压缩会话得到空归档", () => {
  const { entries, issues } = extractArchives({
    sessionId: SESSION,
    events: plainSession(),
  });
  assert.deepEqual(entries, []);
  assert.deepEqual(issues, []);
});

test("一次摘要压缩能还原来源原文", () => {
  const { entries, issues } = extractArchives({
    sessionId: SESSION,
    events: compactionSession(),
  });

  const summary = entries.find((e) => e.kind === "summary");
  assert.ok(summary, "应有一条摘要归档");

  // 来源应覆盖 8 条：事务 2 条 + 原始消息 6 条
  assert.deepEqual(summary.sourceSeqs, [1, 2, 4, 5, 6, 7, 10, 11]);

  // 原文应能取回
  const texts = summary.segments.map((s) => s.text).join("\n");
  assert.match(texts, /请读取 Steps\.md/);
  assert.match(texts, /P0-01 要记录宿主版本/);
  assert.match(texts, /P0-02 采用 ESM/);

  assert.deepEqual(issues, []);
});

test("一次内容裁剪能还原被裁掉的工具结果", () => {
  const { entries } = extractArchives({
    sessionId: SESSION,
    events: compactionSession(),
  });

  const prune = entries.find((e) => e.kind === "prune");
  assert.ok(prune, "应有一条 prune 归档");
  assert.deepEqual(prune.sourceSeqs, [3]);

  // 原文是 20000 字符，裁剪后 5120——归档应拿到**原始**的 20000
  assert.equal(prune.length, 20000);
});

test("重复压缩同一批来源不重复计数", () => {
  const { entries } = extractArchives({
    sessionId: SESSION,
    events: repeatedCompactionSession(),
  });

  // 两次压缩的原始来源都是 [1,2]，但事务事件不同（8 与 18）。
  // 归档 ID 由完整 sourceSeqs 决定，所以是两条不同的归档——
  // 但都指向同一批原文，这正是要记录的事实。
  assert.equal(entries.length, 2, "两次压缩各建一条归档");

  // 关键在于：同一份原文不应被重复算入两次「不同」的归档而混淆。
  // 用相同 sourceSeqs 再压一次，应被去重。
  const repeated = extractArchives({
    sessionId: SESSION,
    events: [
      ...repeatedCompactionSession(),
      replacement(30, [8, 1, 2], "摘要 a 再来一次"),
    ],
  });
  // 第 3 条与第 1 条 sourceSeqs 完全相同 → 去重
  assert.equal(repeated.entries.length, 2, "完全相同的来源集合被去重");
});

test("标题跳过 runtime-context 快照，优先真实用户消息", () => {
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1700000001000,
      data: {
        message: {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "<environment_context>宿主注入的沙箱信息</environment_context>" }],
          source: { kind: "runtime-context" },
        },
      },
      surfaceOp: "append",
    },
    {
      type: "user/message",
      seq: 2,
      time: 1700000002000,
      data: {
        message: {
          id: "m2",
          role: "user",
          content: [{ type: "text", text: "帮我修一下这个 bug" }],
          source: { kind: "user" },
        },
      },
      surfaceOp: "append",
    },
    {
      type: "compaction/start",
      seq: 3,
      time: 1700000003000,
      data: { compactionId: "c-title", turn: 1 },
    },
    replacement(4, [3, 1, 2], "摘要"),
  ];

  const { entries } = extractArchives({ sessionId: SESSION, events });
  const entry = entries.at(0);
  assert.ok(entry);
  assert.equal(entry.title, "帮我修一下这个 bug", "应跳过 runtime-context 取真实用户消息");
});

test("没有用户消息时标题退到助手消息", () => {
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const events = [
    {
      type: "assistant/message",
      seq: 1,
      time: 1700000001000,
      data: {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "我先读一下文档" }],
          source: { kind: "model", provider: "p", model: "m" },
        },
      },
      surfaceOp: "append",
    },
    {
      type: "compaction/start",
      seq: 2,
      time: 1700000002000,
      data: { compactionId: "c-2", turn: 1 },
    },
    replacement(3, [2, 1], "摘要"),
  ];

  const { entries } = extractArchives({ sessionId: SESSION, events });
  const entry = entries.at(0);
  assert.ok(entry);
  assert.equal(entry.title, "我先读一下文档");
});

test("系统提示重写不归档", () => {
  const { entries } = extractArchives({
    sessionId: SESSION,
    events: systemRewriteSession(),
  });
  assert.equal(entries.length, 0, "系统提示重写不是压缩，不应产生归档");
});

test("来源缺失返回明确错误，不伪造归档", () => {
  const { entries, issues } = extractArchives({
    sessionId: SESSION,
    events: missingSourceSession(),
  });

  assert.equal(entries.length, 1, "来源全缺保留损坏引用，不伪造正文");
  assert.equal(entries[0]?.segments.length, 0);
  const missing = issues.find((i) => i.code === "missing-source");
  assert.ok(missing, "应报告 missing-source");
  assert.match(missing.message, /999/);
});

test("部分来源缺失时保留归档但标注 warning", () => {
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1700000001000,
      data: {
        message: { id: "m1", role: "user", content: [{ type: "text", text: "存在的消息" }], source: { kind: "user" } },
      },
      surfaceOp: "append",
    },
    {
      type: "compaction/start",
      seq: 4,
      time: 1700000004000,
      data: { compactionId: "c-partial", turn: 1 },
    },
    {
      type: "user/message",
      seq: 5,
      time: 1700000005000,
      data: {
        message: { id: "m5", role: "user", content: [{ type: "text", text: "摘要" }], source: { kind: "user" } },
      },
      surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [4, 1, 888],
    },
  ];

  const { entries, issues } = extractArchives({ sessionId: SESSION, events });
  assert.equal(entries.length, 1);
  const entry = entries.at(0);
  assert.ok(entry, "应保留一条归档");
  assert.ok(entry.warnings?.some((w) => /888/.test(w)), "应带 warning");
  assert.ok(issues.some((i) => i.code === "missing-source"));
});

test("自我引用的来源被拒绝", () => {
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const events = [
    {
      type: "user/message",
      seq: 7,
      time: 1700000007000,
      data: {
        message: { id: "m7", role: "user", content: [{ type: "text", text: "自引用" }], source: { kind: "user" } },
      },
      surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [7],
    },
  ];
  const { entries, issues } = extractArchives({ sessionId: SESSION, events });
  assert.equal(entries.length, 0);
  assert.ok(issues.some((i) => i.code === "cyclic-source"));
});

test("ID 稳定：同一输入重复计算结果相同", () => {
  const a = extractArchives({ sessionId: SESSION, events: compactionSession(), createdAt: 1 });
  const b = extractArchives({ sessionId: SESSION, events: compactionSession(), createdAt: 1 });
  assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
});

test("ID 区分会话：同名别名不串读", () => {
  const id1 = makeId("session-a", "summary", [1, 2]);
  const id2 = makeId("session-b", "summary", [1, 2]);
  assert.notEqual(id1, id2);
});

test("ID 与来源顺序无关", () => {
  assert.equal(makeId("s", "summary", [3, 1, 2]), makeId("s", "summary", [1, 2, 3]));
});

test("renderEvent 只取 text 块，不把 reasoning 当原文", () => {
  const seg = renderEvent({
    type: "assistant/message",
    seq: 1,
    time: 0,
    data: {
      message: {
        id: "m",
        role: "assistant",
        content: [
          { type: "reasoning", text: "内部推理不该出现" },
          { type: "text", text: "可见回答" },
        ],
        source: { kind: "model", provider: "p", model: "m" },
      },
    },
  });
  assert.ok(seg);
  assert.equal(seg.text, "可见回答");
  assert.doesNotMatch(seg.text, /内部推理/);
});

test("SCHEMA_VERSION 已导出", () => {
  assert.equal(typeof SCHEMA_VERSION, "number");
});
