/**
 * 人工构造的压缩事件样本。
 *
 * **不是真实会话。** 所有内容都是编造的，用于验证解析逻辑。
 * 结构参照实测的真实事件形状：
 *
 * - 一次摘要压缩：`compaction/start` → `compaction/summary` → `compaction/end`
 *   加一条 `user/message` 替换事件，带完整 `sourceEventSeqs`
 * - 一次内容裁剪：`compaction/prune` + `tool/result` 替换事件，来源只有 1 条
 *
 * @module dsh-smart-context/test/fixtures/compaction-sample
 */

/** @typedef {import("../../src/archive-types.js").SessionEvent} SessionEvent */
/** @typedef {{ op: 'replace', startSeq: number, endSeq: number }} ReplaceOp */

/**
 * 构造一条消息事件。
 * @param {'user' | 'assistant'} role
 * @param {string} text
 * @param {number} seq
 * @returns {SessionEvent}
 */
function msg(role, text, seq) {
  const message = { id: `m${seq}`, role, content: [{ type: "text", text }],
    source: role === "user" ? { kind: "user" } : { kind: "model", provider: "p", model: "m" } };
  return {
    type: role === "user" ? "user/message" : "assistant/message",
    seq,
    time: 1700000000000 + seq * 1000,
    data: role === "user" ? message : { message },
    surfaceOp: "append",
  };
}

/**
 * 构造一条工具结果事件。
 * @param {number} seq
 * @param {string} callId
 * @param {string} text
 * @returns {SessionEvent}
 */
function toolResult(seq, callId, text) {
  return {
    type: "tool/result",
    seq,
    time: 1700000000000 + seq * 1000,
    data: { message: {
      id: `m${seq}`, role: "tool", content: [{ type: "text", text }],
      source: { kind: "tool", callId }, toolCallId: callId,
    } },
    surfaceOp: "append",
    sourceEventSeqs: [seq - 1],
  };
}

/**
 * 构造一条替换事件。
 * @param {number} seq
 * @param {ReplaceOp} surfaceOp
 * @param {number[]} sourceEventSeqs
 * @param {string} text
 * @returns {SessionEvent}
 */
function replacement(seq, surfaceOp, sourceEventSeqs, text) {
  return {
    type: "user/message",
    seq,
    time: 1700000000000 + seq * 1000,
    data: { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source: { kind: "compact-checkpoint" } },
    surfaceOp,
    sourceEventSeqs,
  };
}

/**
 * 未压缩的会话：没有任何 compaction 事件，归档应为空。
 * @returns {SessionEvent[]}
 */
export function plainSession() {
  return [msg("user", "你好，帮我看看这个项目", 1), msg("assistant", "好的，我先读一下文档。", 2)];
}

/**
 * 含一次摘要压缩 + 一次内容裁剪的会话。
 * @returns {SessionEvent[]}
 */
export function compactionSession() {
  /** @type {SessionEvent[]} */
  const events = [
    msg("user", "第一步：请读取 Steps.md 并告诉我第一步该做什么", 1),
    msg("assistant", "Steps.md 第 0 步要求先 git init。", 2),
    toolResult(3, "call-1", "x".repeat(20000)),
    msg("user", "继续下一步", 4),
    msg("assistant", "P0-01 要记录宿主版本。", 5),
    msg("user", "再继续", 6),
    msg("assistant", "P0-02 采用 ESM。", 7),
  ];

  // 内容裁剪：prune 事件 + 替换事件
  events.push({
    type: "compaction/prune",
    seq: 8,
    time: 1700000008000,
    data: {
      shadowedRange: { start: 3, end: 3 },
      shadowedSeqs: [3],
      shadowedTokenCount: 5000,
    },
  });
  events.push({
    type: "tool/result",
    seq: 9,
    time: 1700000009000,
    data: {
      message: {
        id: "m9",
        role: "tool",
        content: [{ type: "text", text: "x".repeat(5120) }],
        source: { kind: "tool", callId: "call-1" },
        toolCallId: "call-1",
      },
    },
    surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
    sourceEventSeqs: [3],
  });

  // 摘要压缩：start → summary → end + 替换
  events.push({
    type: "compaction/start",
    seq: 10,
    time: 1700000010000,
    data: { compactionId: "c-1", turn: 2 },
  });
  events.push({
    type: "compaction/summary",
    seq: 11,
    time: 1700000011000,
    data: {
      compactionId: "c-1",
      summary: [{ type: "text", text: "## 已完成\n- git init\n- P0-01 版本基线" }],
    },
  });
  events.push({
    type: "compaction/end",
    seq: 12,
    time: 1700000012000,
    data: { compactionId: "c-1", turn: 2 },
  });
  events.push(
    replacement(13, { op: "replace", startSeq: 1, endSeq: 7 },
      [10, 11, 1, 2, 4, 5, 6, 7], "## 已完成\n- git init\n- P0-01 版本基线"),
  );

  return events;
}

/**
 * 来源缺失的会话：替换事件引用了不存在的事件。
 * 带 `compaction/start` 使其被识别为摘要压缩。
 * @returns {SessionEvent[]}
 */
export function missingSourceSession() {
  return [
    msg("user", "只有一条消息", 1),
    {
      type: "compaction/start",
      seq: 4,
      time: 1700000004000,
      data: { compactionId: "c-missing", turn: 1 },
    },
    replacement(5, { op: "replace", startSeq: 1, endSeq: 1 }, [4, 999], "摘要"),
  ];
}

/**
 * 重复压缩的会话：两次压缩引用同一批来源。
 * 每次压缩都带自己的 `compaction/start`。
 * @returns {SessionEvent[]}
 */
export function repeatedCompactionSession() {
  return [
    msg("user", "被压缩的内容", 1),
    msg("assistant", "回复内容", 2),
    {
      type: "compaction/start",
      seq: 8,
      time: 1700000008000,
      data: { compactionId: "c-a", turn: 1 },
    },
    replacement(10, { op: "replace", startSeq: 1, endSeq: 2 }, [8, 1, 2], "摘要 a"),
    {
      type: "compaction/start",
      seq: 18,
      time: 1700000018000,
      data: { compactionId: "c-b", turn: 2 },
    },
    replacement(20, { op: "replace", startSeq: 1, endSeq: 2 }, [18, 1, 2], "摘要 b"),
  ];
}

/**
 * 系统提示重写：不是压缩，不应归档。
 * @returns {SessionEvent[]}
 */
export function systemRewriteSession() {
  return [
    msg("user", "普通消息", 1),
    {
      type: "system/message",
      seq: 2,
      time: 1700000002000,
      data: {
        message: {
          id: "m2",
          role: "system",
          content: [{ type: "text", text: "新的系统提示" }],
          source: { kind: "system-prompt" },
        },
      },
      surfaceOp: "append",
    },
    {
      type: "system/message",
      seq: 3,
      time: 1700000003000,
      data: {
        message: {
          id: "m3",
          role: "system",
          content: [{ type: "text", text: "工具集变了，重写系统提示" }],
          source: { kind: "system-prompt" },
        },
      },
      surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
      sourceEventSeqs: [2],
    },
  ];
}
