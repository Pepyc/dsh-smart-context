/**
 * 检索题集：20 条「问题 → 预期来源」样本。
 *
 * 覆盖四类：中文自然语言、代码符号、文件路径、错误码。
 *
 * 每条样本的 `expected` 是一个能在目标归档原文里找到的子串，
 * 用于验证「搜索结果里确实包含预期原文」，而不是只验证 ID 对。
 *
 * @module dsh-smart-context/test/fixtures/search-corpus
 */

/** @typedef {import("../../src/archive-types.js").SessionEvent} SessionEvent */

/**
 * 构造一条消息事件。
 * @param {'user' | 'assistant'} role
 * @param {string} text
 * @param {number} seq
 * @returns {SessionEvent}
 */
function msg(role, text, seq) {
  return {
    type: role === "user" ? "user/message" : "assistant/message",
    seq,
    time: 1700000000000 + seq * 1000,
    data: {
      message: {
        id: `m${seq}`,
        role,
        content: [{ type: "text", text }],
        source: role === "user" ? { kind: "user" } : { kind: "model", provider: "p", model: "m" },
      },
    },
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
    data: {
      message: {
        id: `m${seq}`,
        role: "tool",
        content: [{ type: "text", text }],
        source: { kind: "tool", callId },
        toolCallId: callId,
      },
    },
    surfaceOp: "append",
    sourceEventSeqs: [seq - 1],
  };
}

/**
 * 构造一条替换事件。
 * @param {number} seq
 * @param {number[]} sourceEventSeqs
 * @param {string} text
 * @returns {SessionEvent}
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
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 40 },
    sourceEventSeqs,
  };
}

/** 语料：一批内容各异的工具结果与消息，随后被一次摘要压缩遮蔽。 */
const BODY = [
  // 1. 中文自然语言：构建失败
  "构建失败：cmake --preset debug 报 CMAKE_CXX_COMPILER not set，原因是本机没有安装 NMake。",
  // 2. 中文自然语言：性能
  "实测万能头比 iostream 慢约 3 倍，1135ms 对 355ms。这个差距在编译时间上很明显。",
  // 3. 中文自然语言：决策
  "决定不引入分词库，中文用连续子串匹配即可，避免增加依赖和维护成本。",
  // 4. 文件路径
  "读取 E:/Codex/dsh-smart-context/Planing/important/Steps.md 的第 0 节提交规范。",
  // 5. 文件路径（反斜杠）
  "配置文件位于 C:\\Users\\example\\.dsh\\profiles\\desktop\\cordis.patch.yml，包含 HMR 设置。",
  // 6. 报错码
  "宿主返回 CONTEXT_WINDOW_EXCEEDED，说明请求超过了模型上下文窗口。",
  // 7. 报错码（小写混排）
  "TypeError: tool \"x\" must declare output { schema, render }，注册时立即抛出。",
  // 8. 代码符号
  "函数 extractArchives({ sessionId, events }) 返回 { entries, issues } 两个字段。",
  // 9. 代码符号
  "ctx.sessionQuery.readSession(sessionId) 返回完整 raw event log。",
  // 10. 代码符号
  "MAX_QUERY_CHARS 常量定义为 512，超过直接拒绝而不是截断。",
  // 11. 数字与单位
  "索引文件大小 22306 字节，包含 6 条归档元数据，不含原文。",
  // 12. 中文：被推翻的结论
  "之前认为 hmr.root 为空就完全没有热重载，实测发现 watchConfig 是独立路径，配置变化仍然即时生效。",
  // 13. 中文：待办
  "下一步需要确认 deepseek-v4.1-flash 的真实 contextWindow 大小。",
  // 14. 混合：路径 + 中文
  "Planing/important/HANDOFF.md 里记录了当前阻塞项和下一步工作。",
  // 15. 混合：工具名
  "memory_search 和 memory_open 两个工具名在当前 77 个工具里没有被占用。",
  // 16. 中文：数据
  "实测 10889 个事件的会话，首次同步耗时 16ms，重复同步 6ms。",
  // 17. 错误信息片段
  "ERR_MODULE_NOT_FOUND: Cannot find module 'E:\\Codex\\v1\\src\\archive.js'。",
  // 18. 中文：设计取舍
  "选择不存原文，只存元数据和内容哈希，因为原文随时可以从会话日志重新读取。",
  // 19. 英文术语
  "The ToolDefinition interface requires an output field with schema and render.",
  // 20. 中文：具体数值
  "压缩区 100K token，非压缩区触发线 200K token，名义配比 1:2。",
];

/**
 * 构造语料会话：20 条工具结果，最后被一次摘要压缩全部遮蔽。
 * @returns {SessionEvent[]}
 */
export function searchCorpusSession() {
  /** @type {SessionEvent[]} */
  const events = [];
  let seq = 1;

  for (const [index, text] of BODY.entries()) {
    events.push(toolResult(seq, `call-${index}`, text));
    seq += 1;
  }

  const lastSeq = seq;
  events.push({
    type: "compaction/start",
    seq: lastSeq,
    time: 1700000000000 + lastSeq * 1000,
    data: { compactionId: "c-search", turn: 1 },
  });
  seq += 1;

  const sourceSeqs = events.filter((e) => e.type === "tool/result").map((e) => e.seq);
  events.push(replacement(seq, [lastSeq, ...sourceSeqs], "摘要：这一轮做了很多事"));

  return events;
}

/**
 * 20 条检索样本。
 *
 * `expected` 是必须在命中结果里出现（或能取回）的子串。
 * `category` 用于分组报告——**不用一个总分掩盖某一类全部失败**。
 *
 * @type {Array<{ query: string, expected: string, category: '中文' | '代码符号' | '路径' | '错误码' | '精确短语' }>}
 */
export const QUERIES = [
  // --- 中文自然语言 ---
  { query: "构建失败", expected: "CMAKE_CXX_COMPILER not set", category: "中文" },
  { query: "万能头", expected: "1135ms", category: "中文" },
  { query: "分词库", expected: "连续子串匹配", category: "中文" },
  { query: "热重载", expected: "watchConfig", category: "中文" },
  { query: "contextWindow", expected: "deepseek-v4.1-flash", category: "中文" },
  { query: "不存原文", expected: "内容哈希", category: "中文" },
  { query: "压缩区", expected: "100K token", category: "中文" },

  // --- 代码符号 ---
  { query: "extractArchives", expected: "sessionId", category: "代码符号" },
  { query: "readSession", expected: "raw event log", category: "代码符号" },
  { query: "MAX_QUERY_CHARS", expected: "512", category: "代码符号" },
  { query: "memory_search", expected: "memory_open", category: "代码符号" },
  { query: "ToolDefinition", expected: "schema and render", category: "代码符号" },

  // --- 路径 ---
  { query: "Steps.md", expected: "提交规范", category: "路径" },
  { query: "cordis.patch.yml", expected: "HMR", category: "路径" },
  { query: "HANDOFF.md", expected: "阻塞项", category: "路径" },
  { query: "dsh-smart-context/Planing", expected: "Steps.md", category: "路径" },

  // --- 错误码 ---
  { query: "CONTEXT_WINDOW_EXCEEDED", expected: "上下文窗口", category: "错误码" },
  { query: "ERR_MODULE_NOT_FOUND", expected: "archive.js", category: "错误码" },
  { query: "TypeError", expected: "must declare output", category: "错误码" },

  // --- 精确短语 ---
  { query: '"22306 字节"', expected: "22306", category: "精确短语" },
];
