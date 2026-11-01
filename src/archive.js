/**
 * 归档：从会话事件中识别被遮蔽的原文，建立稳定引用。
 *
 * **本模块不接触宿主 API。** 输入是纯事件数组，输出是纯数据，
 * 因此可以完全离线测试（见 `test/archive.test.js`）。
 *
 * 核心事实（实测得出）：
 *
 * | 事件 | 谁持有来源信息 |
 * |---|---|
 * | `compaction/prune` | `shadowedSeqs`（恒 1 个）、`shadowedRange`、`shadowedTokenCount` |
 * | `compaction/summary` | **只有** `compactionId` + `summary`，无来源字段 |
 * | 替换事件 | `surfaceOp{op:'replace'}` + `sourceEventSeqs`（完整列表） |
 *
 * 所以归档**以 `sourceEventSeqs` 为准**，`shadowedSeqs` 只用于交叉校验。
 * @module dsh-smart-context/archive
 */

/** 归档格式版本。结构变化时递增。 */
import { MEMORY_TOOLS, collectProvenance, purePtcCalls } from "./provenance.js";
import { createHash } from "node:crypto";
import { eventMessage } from "./event-message.js";
import { integrityWarnings } from "./integrity.js";
import { deriveTitle as deriveTitleFromSegments, titleFromCallArguments } from "./title.js";
import { safeEnd } from "./unicode.js";
import { withoutOwnCatalog } from "./runtime-context.js";
export { integrityOf } from "./integrity.js";

export const SCHEMA_VERSION = 2;

/** 会进入 surface 的事件类型。其余事件不产生模型可见内容。 */
const SURFACE_EVENT_TYPES = new Set([
  "user/message",
  "assistant/message",
  "system/message",
  "developer/message",
  "tool/result",
]);

/**
 * 取一批事件里最大的 `seq`，**忽略非数字 seq**。
 *
 * 真实会话日志的最后一行是 `{"type":"session",...}` 这样的元数据，
 * 它**没有 `seq` 字段**。直接 `Math.max(max, e.seq)` 会得到 `NaN`，
 * 进而污染索引游标、让每次读取都被判定为损坏。
 *
 * @param {import("./archive-types.js").SessionEvent[]} events
 * @returns {number} 最大 seq；没有数字 seq 时返回 -1
 */
export function maxEventSeq(events) {
  let max = -1;
  for (const event of events) {
    const seq = event.seq;
    if (typeof seq === "number" && Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

/**
 * 判断一条事件的 surfaceOp 是否为替换。
 * @param {import("./archive-types.js").SessionEvent} event
 * @returns {event is import("./archive-types.js").SessionEvent & { surfaceOp: { op: 'replace'; startSeq: number; endSeq: number } }}
 */
function isReplacement(event) {
  const op = event.surfaceOp;
  return typeof op === "object" && op !== null && op.op === "replace";
}

/**
 * 从消息内容块里抽取纯文本。
 *
 * 保留文本及工具调用的名称、ID、参数；图片/文件只保留引用说明，推理不归档。
 *
 * @param {unknown} content - `message.content` 数组
 * @param {ReadonlySet<string>} [excludedPtcCalls] - 已证明只运输检索结果的调用
 * @returns {string}
 */
function renderContent(content, excludedPtcCalls) {
  if (!Array.isArray(content)) return "";
  /** @type {string[]} */
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = /** @type {Record<string, unknown>} */ (block);
    switch (b.type) {
      case "text":
        if (typeof b.text === "string") parts.push(b.text);
        break;
      case "reasoning":
        // 推理内容不是原文，不归档为可读文本。
        break;
      case "image":
        parts.push("[图片]");
        break;
      case "file":
        parts.push(`[文件 ${typeof b.attachment === "object" && b.attachment !== null ? String(/** @type {any} */ (b.attachment).name ?? "") : ""}]`);
        break;
      case "tool-call":
        if (MEMORY_TOOLS.has(String(b.name)) || (b.name === "run_code" && typeof b.id === "string" && excludedPtcCalls?.has(b.id))) break;
        parts.push(`[调用工具 ${String(b.name ?? "")} id=${String(b.id ?? "")} 参数=${JSON.stringify(b.arguments ?? null)}]`);
        break;
      default:
        break;
    }
  }
  return parts.join("");
}

/**
 * 把一条事件渲染成可读片段。
 *
 * @param {import("./archive-types.js").SessionEvent} event
 * @param {{ toolName?: string, excludedPtcCalls?: ReadonlySet<string> }} [provenance]
 * @returns {import("./archive-types.js").ArchiveSegment | null}
 */
export function renderEvent(event, provenance) {
  const data = /** @type {Record<string, any>} */ (event.data ?? {});
  const message = eventMessage(event);
  const toolName = provenance?.toolName ?? data.name ?? message?.source?.name;
  if (event.type === "tool/result" && MEMORY_TOOLS.has(String(toolName ?? ""))) return null;
  const callId = message?.toolCallId ?? message?.source?.callId;
  if (event.type === "tool/result" && typeof callId === "string" && provenance?.excludedPtcCalls?.has(callId)) return null;

  if (event.type === "user/message" || event.type === "system/message" ||
      event.type === "developer/message" || event.type === "assistant/message") {
    if (message === null || typeof message !== "object") return null;
    const rendered = renderContent(message.content, provenance?.excludedPtcCalls);
    const text = Array.isArray(message.content) && message.content.every((/** @type {any} */ block) => block?.type === "text" && typeof block.text === "string")
      ? withoutOwnCatalog(rendered, message.source) : rendered;
    if (text === "") return null;
    const role = /** @type {import("./archive-types.js").SegmentRole} */ (message.role ?? "other");
    const source = message.source;
    const sourceKind = typeof source === "object" && source !== null
      ? String(/** @type {any} */ (source).kind ?? "")
      : undefined;
    return {
      seq: event.seq,
      role,
      text,
      ...(event.type === "assistant/message" && typeof data.interrupted === "boolean" ? { interrupted: data.interrupted } : {}),
      ...(sourceKind === undefined || sourceKind === "" ? {} : { sourceKind }),
    };
  }

  if (event.type === "tool/result") {
    if (message === null || typeof message !== "object") return null;
    const text = renderContent(message.content);
    if (text === "") return null;
    const source = message.source;
    return {
      seq: event.seq,
      role: "tool",
      text,
      ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : typeof source === "object" && source !== null ? String(source.callId ?? "") : undefined,
      toolName: typeof toolName === "string" ? toolName : undefined,
    };
  }

  return null;
}

/**
 * 从一批来源事件建立归档条目。
 *
 * @param {object} input
 * @param {string} input.sessionId - 会话身份
 * @param {number[]} input.sourceSeqs - 覆盖的来源事件编号（来自 `sourceEventSeqs`）
 * @param {'summary' | 'prune'} input.kind - 归档类型
 * @param {Map<number, import("./archive-types.js").SessionEvent>} input.bySeq - 按 seq 索引的事件表
 * @param {number} [input.createdAt] - 归档建立时间，默认当前
 * @returns {{ entry: import("./archive-types.js").ArchiveEntry | null, issues: import("./archive-types.js").ArchiveIssue[] }}
 */
export function buildEntry({ sessionId, sourceSeqs, kind, bySeq, createdAt = Date.now() }) {
  /** @type {import("./archive-types.js").ArchiveIssue[]} */
  const issues = [];

  if (!Array.isArray(sourceSeqs) || sourceSeqs.length === 0) {
    issues.push({ code: "empty-source", message: "来源列表为空，无法建立归档" });
    return { entry: null, issues };
  }

  /** @type {number[]} */
  const missing = [];
  /** @type {import("./archive-types.js").ArchiveSegment[]} */
  const segments = [];

  const { toolNames, ptc } = collectProvenance(bySeq.values());
  const excludedPtcCalls = purePtcCalls(bySeq.values(), ptc);
  const prunedSeqs = collectPrunedSeqs(bySeq.values());
  /** @type {Set<number>} */ const path = new Set();
  /** @type {Set<number>} */ const emitted = new Set();
  /** @type {Set<number>} */ const expanded = new Set();
  const stack = [...sourceSeqs].reverse().map((seq) => ({ seq, exit: false }));
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { seq } = frame;
    if (frame.exit) { path.delete(seq); expanded.add(seq); continue; }
    if (path.has(seq)) {
      issues.push({ code: "cyclic-source", seq, message: `来源引用循环：${seq}` });
      continue;
    }
    if (emitted.has(seq) || expanded.has(seq)) continue;
    const event = bySeq.get(seq);
    if (event === undefined) {
      missing.push(seq);
      continue;
    }
    if (isReplacement(event) && (eventMessage(event)?.source?.kind === "compact-checkpoint" || isPruneTarget(event, prunedSeqs)) &&
        (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0)) {
      issues.push({ code: "empty-source", seq, message: `压缩来源缺失：${seq}` });
      continue;
    }
    if (isReplacement(event) && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length > 0 &&
        classifyReplacement(event, event.sourceEventSeqs, bySeq, prunedSeqs) !== null) {
      path.add(seq);
      stack.push({ seq, exit: true });
      for (const child of [...event.sourceEventSeqs].reverse()) stack.push({ seq: child, exit: false });
      continue;
    }
    emitted.add(seq);
    const data = /** @type {any} */ (event.data);
    const message = eventMessage(event);
    const callId = message?.toolCallId ?? message?.source?.callId;
    const toolName = toolNames.get(callId) ?? data?.name;
    const segment = renderEvent(event, { toolName, excludedPtcCalls });
    if (segment !== null) {
      if (segment.role === "tool" && segment.toolName === undefined && segment.toolCallId) segment.toolName = toolNames.get(segment.toolCallId);
      segments.push(segment);
    }
  }

  if (missing.length > 0) {
    issues.push({
      code: "missing-source",
      message: `来源事件缺失：${missing.length} 条（${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}）`,
    });
  }

  if (segments.length === 0) {
    issues.push({ code: "empty-source", message: "来源事件里没有可读文本" });
    if (missing.length === 0 && !issues.some((i) => i.code === "cyclic-source")) return { entry: null, issues };
  }

  // 来源列表保留 surface 顺序；替换节点在原位置展开，绝不按数字 seq 重排。

  const length = segments.reduce((sum, s) => sum + s.text.length, 0);

  // 标题三层递进：
  //   第一、二层（deriveTitle 内部）：跳过噪音 + 按内容形态提取
  //   第三层（此处）：内容本身没信息时，用 tool/call 的调用参数补充
  //
  // 第三层只在前面都失败时启用（deriveTitle 返回占位符），
  // 这样已有可读标题的归档不会被调用参数覆盖。
  let title = deriveTitle(segments);
  if (title === "(无可读标题)" || title === "(空)") {
    const fromCall = titleFromCallArguments(toolNames, bySeq, segments);
    if (fromCall !== null) title = fromCall;
  }
  const preview = segments[0] === undefined ? "" : segments[0].text.slice(0, safeEnd(segments[0].text, 120));
  const warnings = integrityWarnings({ segments, warnings: issues.map((i) => i.message) });

  return {
    entry: {
      id: makeId(sessionId, kind, sourceSeqs),
      sessionId,
      sourceSeqs: [...sourceSeqs].sort((a, b) => a - b),
      kind,
      title,
      preview,
      length,
      createdAt,
      segments,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    issues,
  };
}

/**
 * 标题：优先用**真实用户**消息的首行，其次第一条非工具片段，最后兜底。
 *
 * **不用模型**，不生成「看起来完整」的伪标题。
 *
 * 实测（2026-10-27）发现的两个陷阱：
 * 1. 摘要压缩的来源里，`user/message` 中混有 `runtime-context` 快照
 *    （`source.kind === 'runtime-context'`），它们是宿主注入的上下文，
 *    不是用户说的话——拿它们当标题会得到无关文本。
 * 2. 工具结果是 `role: 'tool'`，也不适合当标题。
 *
 * @param {import("./archive-types.js").ArchiveSegment[]} segments
 * @returns {string}
 */
function deriveTitle(segments) {
  return deriveTitleFromSegments(segments);
}

/**
 * 判断片段是否来自宿主注入的运行时上下文快照。
 *
 * @param {import("./archive-types.js").ArchiveSegment} segment
 * @returns {boolean}
 */
function isRuntimeContext(segment) {
  return segment.sourceKind === "runtime-context";
}

/**
 * 稳定 ID：会话身份 + 类型 + 排序后的来源集合。
 *
 * 同一会话重建、重启后重读同一日志，得到的 ID 必须一致。
 * 不用 `s1`/`s2` 这类序号——它们只是展示别名，跨会话会撞。
 *
 * @param {string} sessionId
 * @param {string} kind
 * @param {number[]} sourceSeqs
 * @returns {string}
 */
export function makeId(sessionId, kind, sourceSeqs) {
  const sorted = [...sourceSeqs].sort((a, b) => a - b);
  const material = JSON.stringify([sessionId, kind, sorted]);
  return `${kind}-v2-${createHash("sha256").update(material).digest("hex")}`;
}

/**
 * 判定一次替换是否由压缩造成，以及属于哪一类。
 *
 * @param {import("./archive-types.js").SessionEvent} event - 替换事件
 * @param {number[]} sourceSeqs - 它的来源列表
 * @param {Map<number, import("./archive-types.js").SessionEvent>} bySeq - 事件索引
 * @param {Map<number, number>} prunedSeqs - 来源 seq → 首次点名它的裁剪事件 seq
 * @returns {'summary' | 'prune' | null} 类型，或 `null` 表示与压缩无关
 */
function classifyReplacement(event, sourceSeqs, bySeq, prunedSeqs) {
  // prune：来源被 compaction/prune 点名。
  if (event.type === "tool/result" && sourceSeqs.some((seq) => prunedSeqs.has(seq))) return "prune";

  // summary：来源里带压缩事务事件。
  for (const seq of sourceSeqs) {
    const source = bySeq.get(seq);
    if (source === undefined) continue;
    if (source.type === "compaction/start" || source.type === "compaction/summary") return "summary";
  }
  if (eventMessage(event)?.source?.kind === "compact-checkpoint") return "summary";

  // 其余替换（系统提示重写等）不是内容丢失，不归档。
  return null;
}

/** @param {Iterable<import('./archive-types.js').SessionEvent>} events */
function collectPrunedSeqs(events) {
  /** @type {Map<number, number>} */ const seqs = new Map();
  for (const event of events) {
    const data = /** @type {any} */ (event.data);
    if (event.type === "compaction/prune" && Array.isArray(data?.shadowedSeqs)) {
      for (const seq of data.shadowedSeqs) seqs.set(seq, Math.min(seqs.get(seq) ?? Infinity, event.seq));
    }
  }
  return seqs;
}

/** 在来源字段损坏时，只把此前裁剪记录明确点名的单节点替换视为已知裁剪。
 * 不用后来的裁剪记录推断更早的普通替换，也不猜测缺失来源。
 * @param {import('./archive-types.js').SessionEvent} event @param {Map<number, number>} prunedSeqs */
function isPruneTarget(event, prunedSeqs) {
  if (event.type !== "tool/result" || !isReplacement(event) || event.surfaceOp.startSeq !== event.surfaceOp.endSeq) return false;
  return (prunedSeqs.get(event.surfaceOp.startSeq) ?? Infinity) < event.seq;
}

/**
 * 从会话事件中提取全部归档。
 *
 * **只归档压缩造成的遮蔽**，不归档其他 surface 变化。
 *
 * 实测（2026-10-27，真实会话 10545 事件）发现的替换事件分布：
 *
 * | 替换事件类型 | 条数 | 来源长度 | 是不是压缩 |
 * |---|---|---|---|
 * | `system/message` | 7 | 1 | **不是**——系统提示随工具集变化重写 |
 * | `tool/result` | 5 | 1 | 是（prune） |
 * | `user/message` | 1 | 1391 | 是（summary） |
 *
 * 所以**不能只按事件类型分类**。判定规则：
 *
 * 1. **prune**：存在 `compaction/prune` 事件，其 `shadowedSeqs` 指向该来源。
 * 2. **summary**：替换事件的来源里包含 `compaction/start` 或 `compaction/summary`。
 * 3. 其余替换（如 `system/message` 重写）**跳过**——它们不是内容丢失。
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {import("./archive-types.js").SessionEvent[]} input.events
 * @param {number} [input.createdAt]
 * @returns {import("./archive-types.js").ArchiveResult}
 */
export function extractArchives({ sessionId, events, createdAt }) {
  /** @type {import("./archive-types.js").ArchiveEntry[]} */
  const entries = [];
  /** @type {import("./archive-types.js").ArchiveIssue[]} */
  const issues = [];
  let unresolvedArchives = 0;

  /** @type {Map<number, import("./archive-types.js").SessionEvent>} */
  const bySeq = new Map();
  for (const event of events) bySeq.set(event.seq, event);

  /** @type {Set<string>} */
  const seenSources = new Set();

  // 收集 prune 事件遮蔽过的 seq，用于判定某次替换是否属于内容裁剪。
  const prunedSeqs = collectPrunedSeqs(events);

  for (const event of events) {
    if (!isReplacement(event)) continue;

    const sourceSeqs = event.sourceEventSeqs;
    if (!Array.isArray(sourceSeqs) || sourceSeqs.length === 0) {
      if (eventMessage(event)?.source?.kind === "compact-checkpoint" || isPruneTarget(event, prunedSeqs)) unresolvedArchives++;
      issues.push({
        code: "empty-source",
        seq: event.seq,
        message: `seq ${event.seq} 的替换事件没有 sourceEventSeqs`,
      });
      continue;
    }

    // 自我引用检查：来源里不应包含事件自己。
    if (sourceSeqs.includes(event.seq)) {
      if (classifyReplacement(event, sourceSeqs, bySeq, prunedSeqs) !== null) unresolvedArchives++;
      issues.push({
        code: "cyclic-source",
        seq: event.seq,
        message: `seq ${event.seq} 的 sourceEventSeqs 包含自身`,
      });
      continue;
    }

    const kind = classifyReplacement(event, sourceSeqs, bySeq, prunedSeqs);
    if (kind === null) continue; // 非压缩造成的替换（如系统提示重写），不归档

    const { entry, issues: entryIssues } = buildEntry({
      sessionId,
      sourceSeqs,
      kind,
      bySeq,
      createdAt: createdAt ?? (Number.isFinite(event.time) ? event.time : 0),
    });
    issues.push(...entryIssues);
    if (entry === null) continue;

    // 去重：重复压缩同一批来源时不重复计数。
    const sourceIdentity = JSON.stringify([kind, entry.sourceSeqs]);
    if (seenSources.has(sourceIdentity)) continue;
    seenSources.add(sourceIdentity);
    entries.push(entry);
  }

  entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { entries, issues, unresolvedArchives };
}

export { SURFACE_EVENT_TYPES, isReplacement };
