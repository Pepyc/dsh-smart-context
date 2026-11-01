/**
 * `memory_search` 与 `memory_open` 的工具定义。
 *
 * **约束来自宿主**：
 *
 * - `output: { schema, render }` **必填**，缺 `render` 抛 `TypeError`
 * - `parameters` 是**原始 JSON Schema**，`register` 直接校验
 * - schema 只支持 `type/oneOf/properties/required/additionalProperties/items/enum/const`
 *   + `description/title/default/examples`。**没有 `format`、`pattern`、`minimum`**
 * - `name` 不能是 `run_code`
 * - `object` 节点必须显式写 `additionalProperties`
 *
 * **不 import `defineTool`**：那是宿主内部 authoring 包装，peer 依赖在插件作用域
 * 未必解析得到。直接构造符合 `ToolDefinition` 的对象更稳。
 * @module dsh-smart-context/tools
 */

import { extractArchives } from "./archive.js";
import { SourceUnavailableError } from "./host-adapter.js";
import { MAX_OUTPUT_CHARS, outputCost, budgetError } from "./output-budget.js";
import { waitFor } from "./cancellation.js";

/** @typedef {import('./archive-types.js').ArchiveEntry[] | { entries: import('./archive-types.js').ArchiveEntry[], unresolvedArchives: number }} LoadedArchives */

/** @param {import('./types.js').ToolDefinition} definition @param {import('./types.js').ToolObserver} [observe] */
function withProvenance(definition, observe) {
  const execute = definition.execute;
  return { ...definition, async execute(/** @type {unknown} */ args, /** @type {import('./types.js').ToolRunContext} */ exec) {
    exec.signal?.throwIfAborted();
    const value = /** @type {Record<string, any>} */ (await waitFor(execute(args, exec), exec.signal));
    exec.signal?.throwIfAborted();
    // **不向模型输出 memoryOrigin。** 那是插件内部的来源标记，属于实现细节：
    // 它会占每次响应的预算、污染模型的视野，还要求模型在 PTC 里"保留该字段"。
    // 归档侧改用宿主日志里的调用身份（tool/call 的 name + callId）判定来源，
    // 那是比正文标记更可靠的主证据，见 provenance.js 的 collectProvenance。
    const result = outputCost(value) <= MAX_OUTPUT_CHARS ? value : budgetError(value);
    try { observe?.(args, exec, result); } catch { /* 诊断不能影响工具结果。 */ }
    return result;
  } };
}
import { openPage } from "./pagination.js";
import { DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_CHARS, searchArchives } from "./search.js";

/** 工具名。**避开 `mnemon_*` 与 `remember`**，语义边界写进 description。 */
export const SEARCH_TOOL = "memory_search";
export const OPEN_TOOL = "memory_open";

/**
 * 只序列化已预算的响应。异常超预算时返回完整结构错误，不截正文或游标。
 *
 * @param {unknown} value
 * @returns {import("./types.js").ContentBlock[]}
 */
function textBlocks(value) {
  const safe = outputCost(value) <= MAX_OUTPUT_CHARS ? value : budgetError(value);
  return [{ type: "text", text: JSON.stringify(safe) }];
}

/**
 * `memory_search` 的输出 schema。
 *
 * 只用宿主支持的子集关键字。
 */
const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["ok", "empty-query", "query-too-long", "no-index", "no-results", "bad-cursor", "source-unavailable", "budget-too-small"],
      description: "搜索状态。只有 ok 表示有命中。",
    },
    hits: {
      type: "array",
      description: "命中的归档，已按层级与命中次数排序。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "归档 ID，可直接传给 memory_open。" },
          openCursor: { type: "string", description: "传给 memory_open 的 cursor，直接打开首个命中附近。" },
          title: { type: "string" },
          tier: {
            type: "string",
            enum: ["exact-phrase", "path-or-code", "title", "body"],
            description: "命中层级。层间可比，层内只按命中次数排。",
          },
          matchCount: { type: "integer" },
          length: { type: "integer", description: "原文总字符数（不是 token）。" },
          kind: { type: "string", enum: ["summary", "prune"] },
          integrity: { type: "string", enum: ["complete", "partial", "broken"] },
          warnings: { type: "array", items: { type: "string" } },
          snippets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                seq: { type: "integer" },
                text: { type: "string" },
                offset: { type: "integer" },
                cursor: { type: "string", description: "打开此命中附近的位置。" },
                isError: { type: "boolean", description: "原始工具结果是否失败。" },
                interrupted: { type: "boolean", description: "原始助手回复是否中断。" },
              },
              required: ["seq", "text", "offset"],
            },
          },
          sourceSeqs: { type: "array", items: { type: "integer" } },
          sourceSeqsOmitted: { type: "integer", description: "来源序号预览中省略的数量；命中片段保留精确 seq。" },
          snippetsOmitted: { type: "integer" },
        },
        required: ["id", "title", "tier", "matchCount", "length", "kind", "snippets", "sourceSeqs"],
      },
    },
    total: { type: "integer", description: "匹配的归档总数，可能大于 hits.length。" },
    incompleteArchives: { type: "integer" },
    relaxed: { type: "boolean", description: "true 表示原查询无结果、已放宽为逐词分别匹配。结果不是精确匹配，需自行核对。" },
    nextCursor: { type: "string", description: "翻页游标：把它作为 cursor 再调一次。" },
    message: { type: "string" },
  },
  required: ["status", "hits", "total"],
};

/**
 * `memory_open` 的输出 schema。
 */
const OPEN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {

    status: {
      type: "string",
      enum: ["ok", "entry-not-found", "stale-id", "cross-session", "bad-cursor", "source-missing", "empty-entry", "source-unavailable", "budget-too-small"],
    },
    id: { type: "string" },
    title: { type: "string" },
    integrity: { type: "string", enum: ["complete", "partial", "broken"] },
    warnings: { type: "array", items: { type: "string" } },
    parts: {
      type: "array",
      description: "本页内容，按原文顺序。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          seq: { type: "integer", description: "来源事件编号。" },
          role: { type: "string", enum: ["user", "assistant", "system", "developer", "tool", "other"] },
          text: { type: "string" },
          offset: { type: "integer", description: "该片段在整段原文中的起始字符偏移。" },
          partial: { type: "boolean", description: "true 表示该片段被截断，本页只含一部分。" },
          toolName: { type: "string" },
          toolCallId: { type: "string" },
          isError: { type: "boolean", description: "原始工具结果是否失败；不是本次 memory_open 的执行状态。" },
          interrupted: { type: "boolean", description: "原始助手回复是否中断。" },
        },
        required: ["seq", "role", "text", "offset"],
      },
    },
    nextCursor: { type: "string", description: "下一页游标；省略表示已到末尾。" },
    range: {
      type: "object",
      additionalProperties: false,
      properties: {
        returnedChars: { type: "integer" },
        totalChars: { type: "integer" },
        fromChar: { type: "integer" },
        toChar: { type: "integer" },
      },
      required: ["returnedChars", "totalChars", "fromChar", "toChar"],
    },
    estimatedTokens: { type: "integer", description: "估算 token（chars/2），不是精确值。" },
    truncatedByHost: {
      type: "boolean",
      description: "true 表示来源已被宿主 pruner 裁过，中间段原文不可恢复。",
    },
    message: { type: "string" },
  },
  required: ["status", "id", "parts"],
};

/**
 * 构造 `memory_search` 的工具定义。
 *
 * @param {object} deps
 * @param {import('./types.js').ToolObserver} [deps.observe]
 * @param {(args: { sessionId: string, signal?: AbortSignal }) => Promise<LoadedArchives>} deps.loadEntries
 *   - 取当前会话的归档（由 index.js 注入，内部走 syncIndex + extractArchives）
 * @returns {import("./types.js").ToolDefinition}
 */
export function createSearchTool({ loadEntries, observe }) {
  return withProvenance({
    name: SEARCH_TOOL,
    description: [
      "在当前会话**已被宿主压缩遮蔽**的历史原文里按关键词找位置。",
      "",
      "用途：找回对话早期出现过、但现在已从上下文里消失的细节——报错码、文件路径、某个被推翻的结论、某个具体数值。",
      "**不是**长期记忆：不记用户偏好或项目事实（那用 mnemon_* 或 remember）。只查本次会话的历史原文。",
      "",
      "匹配规则：中文连续子串；英文大小写不敏感；多个词是 AND（每个词都要出现）；引号包裹表示精确短语。",
      "**不处理同义改写、不做词干还原、不支持正则。**零结果时请换一个更接近原文的词重试。",
      "",
      "返回的是位置信息（id + 片段），不是全文。要读命中原文，调用 memory_open({id, cursor: openCursor})。",
      "PTC 调用后用 console.log(JSON.stringify(result)) 输出完整响应，每次程序输出一份检索响应。",
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: `关键词。多个词用空格分隔（AND 语义）。引号包裹表示精确短语。上限 ${MAX_QUERY_CHARS} 字符。`,
        },
        limit: {
          type: "integer",
          description: `返回条数，默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}。`,
        },
        snippets: {
          type: "integer",
          description: "每条结果带几个命中片段，默认 5，上限 15。命中点会按「查询词是否聚在一起」排序，不是先到先得。",
        },
        cursor: {
          type: "string",
          description: "翻页游标：用上一次返回的 nextCursor。",
        },
      },
      required: ["query"],
    },
    output: {
      schema: SEARCH_OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlocks(value);
      },
    },
    /**
     * @param {unknown} args
     * @param {import("./types.js").ToolRunContext} exec
     */
    async execute(args, exec) {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      const sessionId = String(exec.agent?.id ?? "");
      if (sessionId === "") {
        return { status: "no-index", hits: [], total: 0, message: "无法确定当前会话身份。" };
      }
      let loaded;
      try { loaded = await loadEntries({ sessionId, signal: exec.signal }); }
      catch (error) {
        if (!(error instanceof SourceUnavailableError)) throw error;
        return { status: "source-unavailable", hits: [], total: 0, message: error.message };
      }
      const { entries, unresolvedArchives } = Array.isArray(loaded) ? { entries: loaded, unresolvedArchives: 0 } : loaded;
      return searchArchives({
        entries,
        unresolvedArchives,
        maxOutputChars: MAX_OUTPUT_CHARS,
        query: typeof a.query === "string" ? a.query : "",
        ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
        ...(typeof a.cursor === "string" ? { cursor: a.cursor } : {}),
        ...(Number.isSafeInteger(a.snippets) ? { snippets: /** @type {number} */ (a.snippets) } : {}),
      });
    },
  }, observe);
}

/**
 * 构造 `memory_open` 的工具定义。
 *
 * @param {object} deps
 * @param {import('./types.js').ToolObserver} [deps.observe]
 * @param {(args: { sessionId: string, signal?: AbortSignal }) => Promise<LoadedArchives>} deps.loadEntries
 * @returns {import("./types.js").ToolDefinition}
 */
export function createOpenTool({ loadEntries, observe }) {
  return withProvenance({
    name: OPEN_TOOL,
    description: [
      "分页打开一条归档的**原文**。先用 memory_search 拿到 id。",
      "",
      "完整响应及常见 PTC 包装受 6000 字符预算限制，正文长度随转义和元数据自动减少。",
      "返回带 nextCursor 时表示还有下一页，把它作为 cursor 再调一次。",
      "**大归档不要线性翻页**：用 seq 直接跳到命中的片段（seq 来自 memory_search 的片段列表）。",
      "PTC 调用后用 console.log(JSON.stringify(result)) 输出完整响应。",
      "",
      "如果返回 truncatedByHost: true，说明这条原文在宿主侧**早已被裁剪过**，中间段永久丢失——不要把它当作完整原文引用。",
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "归档 ID，来自 memory_search 的返回。",
        },
        seq: {
          type: "integer",
          description: "非负安全整数。直接跳到该事件 seq 所在的片段，从片段开头读。**优先于 cursor**。seq 来自 memory_search 返回的片段。大归档里未展示的命中点用它跳转，不要线性翻页。",
        },
        cursor: {
          type: "string",
          description: "原样传入上次返回的 nextCursor。绑定归档与内容版本，不能自行构造。省略表示从头开始。",
        },
        maxTokens: {
          type: "integer",
          description: "正文 token 上限（按字符数/2 估算，不含 JSON 元数据），须为正整数，上限 4000。完整响应另受字符预算约束。",
        },
      },
      required: ["id"],
    },
    output: {
      schema: OPEN_OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlocks(value);
      },
    },
    /**
     * @param {unknown} args
     * @param {import("./types.js").ToolRunContext} exec
     */
    async execute(args, exec) {
      const a = /** @type {Record<string, unknown>} */ (args ?? {});
      const sessionId = String(exec.agent?.id ?? "");
      const id = typeof a.id === "string" ? a.id : "";
      if (sessionId === "" || id === "") {
        return {
          status: "entry-not-found",
          id,
          parts: [],
          message: "缺少会话身份或归档 ID。",
        };
      }
      if (a.seq !== undefined && (!Number.isSafeInteger(a.seq) || /** @type {number} */ (a.seq) < 0)) {
        return { status: "bad-cursor", id, parts: [], message: "seq 必须为非负安全整数，请使用 memory_search 返回的来源序号。" };
      }
      let loaded;
      try { loaded = await loadEntries({ sessionId, signal: exec.signal }); }
      catch (error) {
        if (!(error instanceof SourceUnavailableError)) throw error;
        return { status: "source-unavailable", id, parts: [], message: error.message };
      }
      const { entries, unresolvedArchives } = Array.isArray(loaded) ? { entries: loaded, unresolvedArchives: 0 } : loaded;
      const entry = entries.find((e) => e.id === id);
      if (!entry && unresolvedArchives > 0) return { status: "source-unavailable", id, parts: [], message: "部分压缩来源无法解析，无法确认该归档是否存在。" };
      if (!entry && /^(summary|prune)-[a-f0-9]{8}$/.test(id)) {
        return { status: "stale-id", id, parts: [], message: "旧版归档 ID 已失效，请重新 memory_search 获取当前 ID 和游标。" };
      }
      const input = {
        entry,
        id,
        ...(typeof a.cursor === "string" ? { cursor: a.cursor } : {}),
        ...(Number.isSafeInteger(a.seq) && /** @type {number} */ (a.seq) >= 0 ? { seq: /** @type {number} */ (a.seq) } : {}),
        ...(typeof a.maxTokens === "number" ? { maxTokens: a.maxTokens } : {}),
      };
      let page = openPage(input);
      if (page.status !== "ok" || outputCost(page) <= MAX_OUTPUT_CHARS) return page;
      let low = 1;
      let high = page.range?.returnedChars ?? 0;
      /** @type {import('./pagination-types.js').PageResult | null} */ let best = null;
      while (low <= high) {
        const maxChars = Math.floor((low + high) / 2);
        page = openPage({ ...input, maxChars });
        if (page.status === "ok" && (page.range?.returnedChars ?? 0) > 0 && outputCost(page) <= MAX_OUTPUT_CHARS) {
          best = page; low = maxChars + 1;
        } else high = maxChars - 1;
      }
      return best ?? budgetError({ parts: [], id });
    },
  }, observe);
}
