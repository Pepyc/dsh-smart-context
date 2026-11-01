import { valueFingerprint } from "./identity.js";

/**
 * 检索工具的返回形状。**仅用于内部识别，绝不写入模型可见的输出。**
 *
 * 历史：曾用正文标记 `memoryOrigin: "dsh-smart-context/retrieval-v1"`。
 * 那会把插件实现细节暴露给模型（占预算、污染视野、还要模型在 PTC 里
 * "保留该字段"）。现改为按**结构化形状 + 调用身份**双重判定：
 *
 * - 主证据：宿主日志里 `tool/call` 的 `name` 与 `callId`（见 `collectProvenance`）
 * - 辅助：返回值的字段形状（`status` + `hits`/`parts`）
 *
 * 形状识别只在**已知是 memory_* 子调用**的前提下使用，不单独作为证据。
 */
export const MEMORY_TOOLS = new Set(["memory_search", "memory_open"]);

/** 判断一个已解析的 JSON 值是否**形如**检索响应。仅作辅助，不作独立证据。
 * @param {unknown} value @returns {boolean} */
export function looksLikeRetrievalResponse(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  // memory_search：{status, hits[], total}
  // memory_open：  {status, id, parts[]}
  //
  // **只按结构特征判定，不要求 status 存在**：
  // 诊断场景会拿到被删改过的残缺副本（如只剩 `{hits}`），
  // 那种副本仍需被识别为「检索响应的变体」，否则会被误报成
  // changed-or-partial（BUG-21 的回归）。
  //
  // 这个函数**不单独作为删除证据**——删除必须先经调用身份确认
  // （见 collectProvenance），且要指纹完全匹配。
  const hasSearchShape = Array.isArray(v.hits);
  const hasOpenShape = Array.isArray(v.parts);
  return hasSearchShape || hasOpenShape;
}

/** @typedef {{ other: boolean, outputs: Set<string>, calls: Map<string,{name:string,success:boolean}>, ambiguous: boolean }} PtcRecord */

/** 宿主日志中的调用身份与 PTC 父子关系是来源证据，正文标记本身不是。
 * @param {Iterable<import('./archive-types.js').SessionEvent>} events */
export function collectProvenance(events) {
  /** @type {Map<string, string>} */ const toolNames = new Map();
  /** @type {Map<string, PtcRecord>} */ const ptc = new Map();
  for (const event of events) {
    const data = /** @type {any} */ (event.data);
    if (event.type === "tool/call" && typeof data?.callId === "string" && typeof data?.name === "string") toolNames.set(data.callId, data.name);
    if (event.type === "assistant/message" && Array.isArray(data?.message?.content)) {
      for (const block of data.message.content) if (block?.type === "tool-call" && typeof block.id === "string" && typeof block.name === "string") toolNames.set(block.id, block.name);
    }
    if (event.type !== "tool/ptc-dispatch" && event.type !== "tool/ptc-dispatch-start") continue;
    for (const parent of new Set([data?.parentCallId, data?.rootCallId])) {
      if (typeof parent !== "string") continue;
      let record = ptc.get(parent);
      if (!record) { record = { other: false, outputs: new Set(), calls: new Map(), ambiguous: false }; ptc.set(parent, record); }
      if (typeof data?.subCallId !== "string" || typeof data?.name !== "string") record.ambiguous = true;
      else {
        const previous = record.calls.get(data.subCallId);
        if (previous && previous.name !== data.name) record.ambiguous = true;
        record.calls.set(data.subCallId, { name: data.name, success: event.type === "tool/ptc-dispatch" ? data.isError === false : previous?.success ?? false });
      }
      if (!MEMORY_TOOLS.has(data?.name)) { record.other = true; continue; }
      if (event.type !== "tool/ptc-dispatch" || data?.isError !== false || !Array.isArray(data?.content)) continue;
      for (const block of data.content) {
        if (block?.type !== "text" || typeof block.text !== "string") continue;
        try {
          const value = JSON.parse(block.text);
          // 调用身份已确认是 memory_*（第 30 行的 continue 保证），
          // 这里再用形状做一次校验，防止子调用记录与实际内容错配。
          // 用**语义指纹**（对象键排序）而不是字节指纹：
          // PTC 包装里重新序列化会改变键顺序，字节指纹会失配。
          if (looksLikeRetrievalResponse(value)) record.outputs.add(valueFingerprint(value));
        } catch { /* 被裁剪或无法校验的副本不作为删除依据。 */ }
      }
    }
  }
  return { toolNames, ptc };
}

// 只识别受限的单次调用与直接打印形式，无法静态证明的程序原样保留。
const PROGRAM = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.(memory_search|memory_open)\s*\(\s*(\{[\s\S]*\})\s*\)\s*;\s*console\.log\s*\(\s*JSON\.stringify\s*\(\s*\1\s*\)\s*\)\s*;?\s*$/;
const DIRECT_PROGRAM = /^\s*console\.log\s*\(\s*JSON\.stringify\s*\(\s*await\s+tools\.(memory_search|memory_open)\s*\(\s*(\{[\s\S]*\})\s*\)\s*\)\s*\)\s*;?\s*$/;
const RETURN_PROGRAM = /^\s*return\s+await\s+tools\.(memory_search|memory_open)\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/;
const STRING = String.raw`(?:"(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|'(?:[^'\\\r\n]|\\(?:['\\/bfnrt]|u[0-9a-fA-F]{4}))*')`;
const PAIR = String.raw`(?:query|id|cursor|limit|maxTokens|snippets|seq|"(?:query|id|cursor|limit|maxTokens|snippets|seq)"|'(?:query|id|cursor|limit|maxTokens|snippets|seq)')\s*:\s*(?:${STRING}|\d+)`;
const LITERAL_ARGS = new RegExp(String.raw`^\{\s*(?:${PAIR}\s*(?:,\s*${PAIR}\s*)*,?)?\}$`);

/** @param {string} code @returns {string | undefined} */
function directMemoryProgram(code) {
  const match = PROGRAM.exec(code);
  if (match && match[3] !== undefined && LITERAL_ARGS.test(match[3])) return match[2];
  const direct = DIRECT_PROGRAM.exec(code) ?? RETURN_PROGRAM.exec(code);
  return direct && direct[2] !== undefined && LITERAL_ARGS.test(direct[2]) ? direct[1] : undefined;
}

/** 仅当程序、成功子调用及外层结果三者都可证明纯检索时，排除其调用块。
 * @param {Iterable<import('./archive-types.js').SessionEvent>} events
 * @param {Map<string,PtcRecord>} ptc @returns {Set<string>} */
export function purePtcCalls(events, ptc) {
  /** @type {Map<string,string>} */ const programs = new Map();
  /** @type {Map<string,any[]>} */ const results = new Map();
  for (const event of events) {
    const data = /** @type {any} */ (event.data);
    if (event.type === "assistant/message" && Array.isArray(data?.message?.content)) {
      for (const block of data.message.content) {
        if (block?.type === "tool-call" && block.name === "run_code" && typeof block.id === "string" && typeof block.arguments?.code === "string") {
          const name = directMemoryProgram(block.arguments.code);
          if (name) programs.set(block.id, name);
        }
      }
    }
    if (event.type === "tool/result") {
      const message = data?.message;
      const id = message?.toolCallId ?? message?.source?.callId;
      if (typeof id === "string") { const list = results.get(id) ?? []; list.push(message); results.set(id, list); }
    }
  }
  const pure = new Set();
  for (const [id, name] of programs) {
    const record = ptc.get(id); const observed = results.get(id);
    if (!record || record.other || record.ambiguous || record.calls.size !== 1 || record.outputs.size === 0 || observed?.length !== 1) continue;
    const call = [...record.calls.values()][0]; const message = observed[0];
    if (call?.name !== name || !call.success || message?.isError === true || !Array.isArray(message?.content) || message.content.length === 0) continue;
    if (message.content.every((/** @type {any} */ block) => block?.type === "text" && typeof block.text === "string") &&
        message.content.map((/** @type {any} */ block) => withoutGeneratedText(block.text, record.outputs)).join("") === "") pure.add(id);
  }
  return pure;
}

/** 只清除整体可判为可信 PTC 检索结果的文本；混合文本逐字保留。
 * @param {string} text @param {ReadonlySet<string>} [trusted] @returns {string} */
export function withoutGeneratedText(text, trusted = new Set()) {
  if (trusted.size === 0) return text;
  /** @param {string} input @param {number} depth @returns {{ text: string, removed: boolean }} */
  function project(input, depth) {
    if (depth > 32) return { text: input, removed: false };
    let removed = false;
    /** @param {any} value @param {number} level @returns {any} */
    function clean(value, level) {
      if (level > 32) return value;
      if (typeof value === "string" && value.trimStart().startsWith("{")) {
        const nested = project(value, level + 1); removed ||= nested.removed;
        return nested.removed && nested.text === "" ? undefined : nested.text;
      }
      if (value === null || typeof value !== "object") return value;
      // 指纹匹配即可删除：trusted 里只包含**经调用身份确认**的检索响应。
      if (trusted.has(valueFingerprint(value))) { removed = true; return undefined; }
      if (Array.isArray(value)) return value.map((v) => clean(v, level + 1)).filter((v) => v !== undefined);
      return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, clean(v, level + 1)]).filter(([,v]) => v !== undefined));
    }
    try {
      const original = JSON.parse(input);
      const result = clean(original, depth);
      const emptyTransport = removed && original !== null && !Array.isArray(original) && typeof original === "object" &&
        Object.keys(original).length > 0 && Object.keys(original).every((key) => key === "logs" || key === "result") &&
        result !== undefined && result.result === undefined &&
        (result.logs === undefined || (Array.isArray(result.logs) && result.logs.length === 0));
      // JSON.parse 会改变大整数与格式；只在整个块可以清除时返回空，
      // 否则必须返回原始字节，不能将部分清除后的值重新序列化。
      return { text: removed && (result === undefined || emptyTransport) ? "" : input, removed };
    } catch {
      const lines = input.split("\n").map((line) => {
        try {
          const value = JSON.parse(line);
          if (trusted.has(valueFingerprint(value))) { removed = true; return ""; }
        } catch { /* 保留无法归属的原文。 */ }
        return line;
      });
      const remaining = lines.join("\n");
      return { text: removed && remaining === "" ? "" : input, removed };
    }
  }
  return project(text, 0).text;
}
