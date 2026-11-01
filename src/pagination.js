/**
 * 分页打开归档原文。
 *
 * **本模块不接触宿主 API**，输入是 `ArchiveEntry`，输出是纯数据。
 *
 * 三条硬约束（见 Steps §5.5 与 compatibility.md §7.6）：
 *
 * 1. **字符数上限 6000**：宿主 `tool-result-pruner` 在 8192 字符裁中间，
 *    留 27% 余量给 JSON 包装。这是硬约束，不是优化。
 * 2. **先按消息边界切，再按字符偏移**：避免模型看到半句话。
 * 3. **检测宿主裁剪标记**：来源事件本身可能已被 pruner 裁过，
 *    此时全文不可恢复，必须报 `truncatedByHost` 而不是假装完整。
 * @module dsh-smart-context/pagination
 */

import { integrityOf } from "./archive.js";
import { entryVersion, packCursor, unpackCursor } from "./identity.js";
import { integrityWarnings, wasPrunedByHost } from "./integrity.js";
export { PRUNE_MARKER, wasPrunedByHost } from "./integrity.js";

/** 单页字符上限（硬约束）。 */
export const MAX_PAGE_CHARS = 6000;

/** 单页 token 软目标（估算）。 */
export const TARGET_PAGE_TOKENS = 2000;

/** 单页 token 硬上限（估算）。 */
export const MAX_PAGE_TOKENS = 4000;

/** 每 token 约多少字符。中文约 2，英文约 4；取保守值 2。 */
const CHARS_PER_TOKEN = 2;

/**
 * 把字符数换算成估算 token。
 *
 * **这是估算，不是精确计量。** 返回值一律标注 `estimatedTokens`，
 * 不包装成精确 token。
 *
 * @param {number} chars
 * @returns {number}
 */
export function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 编码游标。
 *
 * @param {import("./pagination-types.js").PageCursor} cursor
 * @returns {string}
 */
export function encodeCursor(cursor) {
  if (cursor.entryId !== undefined && cursor.version !== undefined) return packCursor("o1", cursor);
  return `${cursor.segmentIndex}:${cursor.charOffset}`;
}

/**
 * 解析游标。
 *
 * @param {string} raw
 * @returns {import("./pagination-types.js").PageCursor | null} 格式非法返回 `null`
 */
export function decodeCursor(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.startsWith("o1.")) {
    const value = unpackCursor("o1", raw);
    if (value === null || typeof value !== "object" || typeof value.entryId !== "string" ||
        typeof value.version !== "string" || !Number.isSafeInteger(value.segmentIndex) || value.segmentIndex < 0 ||
        !Number.isSafeInteger(value.charOffset) || value.charOffset < 0) return null;
    return value;
  }
  const m = /^(\d+):(\d+)$/.exec(raw);
  if (m === null) return null;
  const segmentIndex = Number(m[1]);
  const charOffset = Number(m[2]);
  if (!Number.isSafeInteger(segmentIndex) || !Number.isSafeInteger(charOffset)) return null;
  if (segmentIndex < 0 || charOffset < 0) return null;
  return { segmentIndex, charOffset };
}

/**
 * 计算每个片段在整段原文中的起始偏移。
 *
 * @param {import("./archive-types.js").ArchiveSegment[]} segments
 * @returns {{ starts: number[], total: number }}
 */
function segmentOffsets(segments) {
  /** @type {number[]} */
  const starts = [];
  let total = 0;
  for (const segment of segments) {
    starts.push(total);
    total += segment.text.length;
  }
  return { starts, total };
}

/**
 * 从指定位置开始取一页。
 *
 * **切分策略**：
 * 1. 从 `start` 开始，依次装入完整的片段；
 * 2. 装不下整个片段时，如果这个片段还能装下至少一半，就切一部分（标记 `partial`）；
 * 3. 否则在这一页结束，游标指向该片段起点。
 *
 * 这样保证：小片段永远完整，大片段才被切。
 *
 * @param {object} input
 * @param {import("./archive-types.js").ArchiveSegment[]} input.segments
 * @param {import("./pagination-types.js").PageCursor} input.start
 * @param {number} input.maxChars
 * @returns {{ parts: import("./pagination-types.js").PagePart[], next: import("./pagination-types.js").PageCursor | null, fromChar: number, toChar: number }}
 */
function slicePage({ segments, start, maxChars }) {
  const { starts } = segmentOffsets(segments);
  /** @type {import("./pagination-types.js").PagePart[]} */
  const parts = [];
  let used = 0;
  let fromChar = (starts[start.segmentIndex] ?? 0) + start.charOffset;
  let toChar = fromChar;

  let index = start.segmentIndex;
  let offsetInSegment = start.charOffset;

  while (index < segments.length) {
    const segment = segments[index];
    if (segment === undefined) break;
    const remaining = segment.text.length - offsetInSegment;
    const available = maxChars - used;

    if (remaining <= available) {
      // 整个片段装得下
      const text = offsetInSegment === 0 ? segment.text : segment.text.slice(offsetInSegment);
      parts.push({
        seq: segment.seq,
        role: segment.role,
        text,
        offset: (starts[index] ?? 0) + offsetInSegment,
        ...(segment.toolName === undefined ? {} : { toolName: segment.toolName }),
        ...(segment.toolCallId === undefined ? {} : { toolCallId: segment.toolCallId }),
        ...(segment.isError === undefined ? {} : { isError: segment.isError }),
        ...(segment.interrupted === undefined ? {} : { interrupted: segment.interrupted }),
        ...(offsetInSegment === 0 ? {} : { partial: true }),
      });
      used += text.length;
      toChar = (starts[index] ?? 0) + segment.text.length;
      index += 1;
      offsetInSegment = 0;
      continue;
    }

    // 装不下整个片段：只要还有可用空间，就装入能装的部分。
    //
    // 曾经的条件是「可用空间 ≥ max(200, 剩余的一半)」，结果单个超长片段
    // （如 20000 字符的 tool/result）在首页就 break，返回空页。
    // 正确做法是：**能用多少用多少**，把 partial 标记清楚即可。
    if (available > 0) {
      let take = available;
      const last = segment.text.charCodeAt(offsetInSegment + take - 1);
      const next = segment.text.charCodeAt(offsetInSegment + take);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) take -= 1;
      if (take <= 0) break;
      const text = segment.text.slice(offsetInSegment, offsetInSegment + take);
      parts.push({
        seq: segment.seq,
        role: segment.role,
        text,
        offset: (starts[index] ?? 0) + offsetInSegment,
        ...(segment.toolName === undefined ? {} : { toolName: segment.toolName }),
        ...(segment.toolCallId === undefined ? {} : { toolCallId: segment.toolCallId }),
        ...(segment.isError === undefined ? {} : { isError: segment.isError }),
        ...(segment.interrupted === undefined ? {} : { interrupted: segment.interrupted }),
        partial: true,
      });
      used += text.length;
      toChar = (starts[index] ?? 0) + offsetInSegment + text.length;
      // **不要 index += 1**：本片段还没读完，游标必须停在这个片段内部。
      // 曾经误加，导致下一页从下一个片段开始，把本片段剩余部分整段丢掉。
      offsetInSegment += text.length;
    }
    break;
  }

  /** @type {import("./pagination-types.js").PageCursor | null} */
  const next = index < segments.length ? { segmentIndex: index, charOffset: offsetInSegment } : null;
  return { parts, next, fromChar, toChar };
}

/**
 * 打开归档的一页。
 *
 * @param {object} input
 * @param {import("./archive-types.js").ArchiveEntry | undefined} input.entry - 已解析的归档条目
 * @param {string} input.id - 请求的归档 ID（用于错误信息与跨会话校验）
 * @param {string} [input.cursor] - 游标；省略表示从头开始
 * @param {number} [input.seq] - 直接跳到该事件 seq 所在的片段（优先于 cursor）
 * @param {number} [input.maxTokens] - 请求的 token 上限（会被钳到硬上限）
 * @param {number} [input.maxChars] - 额外字符上限（工具按完整响应预算重分页时使用）
 * @returns {import("./pagination-types.js").PageResult}
 */
export function openPage({ entry, id, cursor, seq, maxTokens, maxChars }) {
  if (entry === undefined) {
    return {
      status: "entry-not-found",
      id,
      parts: [],
      message: `当前会话没有 id 为「${id}」的归档。先用 memory_search 找可用的 id。`,
    };
  }

  if (entry.id !== id) {
    return {
      status: "cross-session",
      id,
      parts: [],
      message: `id「${id}」不属于当前会话（实际归属 ${entry.sessionId}）。归档按会话隔离，不能跨会话读取。`,
    };
  }

  if (entry.warnings?.length && entry.segments.length === 0) {
    return { status: "source-missing", id, title: entry.title, parts: [],
      integrity: "broken", warnings: entry.warnings, message: `来源事件缺失：${entry.warnings.join("; ")}` };
  }
  if (entry.segments.length === 0) {
    return {
      status: "empty-entry",
      id,
      title: entry.title,
      parts: [],
      message: "该归档没有可读文本（来源可能全部缺失）。",
    };
  }

  // 解析游标
  /** @type {import("./pagination-types.js").PageCursor} */
  let start = { segmentIndex: 0, charOffset: 0 };

  // **按 seq 直接跳点。**
  //
  // 为什么需要：搜索结果只展示有限个片段，大归档（实测 138 万字符）
  // 要翻几百页才能到达未展示的命中点。`seq` 是片段里已经给出的精确锚点，
  // 用它跳转比让模型线性翻页高效几个数量级。
  //
  // 与 `cursor` 互斥：同时给出时 `seq` 优先，并忽略 `cursor`（避免歧义）。
  if (seq !== undefined) {
    const index = entry.segments.findIndex((segment) => segment.seq === seq);
    if (index < 0) {
      const available = entry.segments.map((segment) => segment.seq);
      const preview = available.slice(0, 20).join(", ");
      const more = available.length > 20 ? ` …（共 ${available.length} 段）` : "";
      return {
        status: "bad-cursor",
        id,
        title: entry.title,
        parts: [],
        message: `该归档没有 seq=${seq} 的片段。可用的 seq：${preview}${more}。先用 memory_search 找到命中的 seq。`,
      };
    }
    start = { segmentIndex: index, charOffset: 0 };
  } else if (cursor !== undefined && cursor !== "") {
    const decoded = decodeCursor(cursor);
    if (decoded === null || decoded.entryId !== entry.id || decoded.version !== entryVersion(entry)) {
      return {
        status: "bad-cursor",
        id,
        title: entry.title,
        parts: [],
        message: "游标非法、属于其他归档或原文版本已变化。请重新搜索或从头打开，不要重用旧游标。",
      };
    }
    if (decoded.segmentIndex >= entry.segments.length) {
      return {
        status: "bad-cursor",
        id,
        title: entry.title,
        parts: [],
        message: `游标越界：片段索引 ${decoded.segmentIndex} 超出范围（共 ${entry.segments.length} 段）。`,
      };
    }
    const seg = entry.segments[decoded.segmentIndex];
    if (seg !== undefined && decoded.charOffset > seg.text.length) {
      return {
        status: "bad-cursor",
        id,
        title: entry.title,
        parts: [],
        message: `游标越界：字符偏移 ${decoded.charOffset} 超出该片段长度 ${seg.text.length}。`,
      };
    }
    start = decoded;
  }

  // 所有预算共同生效；无效请求不能退回更大的默认预算。
  if ((maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) ||
      (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || maxChars <= 0))) {
    return { status: "budget-too-small", id, parts: [], message: "预算必须为正整数，请增加预算后重试同一位置。" };
  }
  let limit = Math.min(maxChars ?? MAX_PAGE_CHARS, MAX_PAGE_CHARS);
  if (maxTokens !== undefined) {
    const tokenCapped = Math.min(maxTokens, MAX_PAGE_TOKENS) * CHARS_PER_TOKEN;
    limit = Math.min(limit, tokenCapped);
  }

  const { parts, next, fromChar, toChar } = slicePage({ segments: entry.segments, start, maxChars: limit });

  if (parts.length === 0) {
    if ((entry.segments[start.segmentIndex]?.text.length ?? 0) > start.charOffset) {
      return { status: "budget-too-small", id, parts: [], message: "预算不足以容纳当前位置的完整字符，请增加预算后重试同一位置。" };
    }
    return {
      status: "empty-entry",
      id,
      title: entry.title,
      parts: [],
      message: "本页为空（游标可能已到末尾）。",
    };
  }

  const returnedChars = parts.reduce((sum, p) => sum + p.text.length, 0);

  // 宿主裁剪检测：来源事件本身可能已被 pruner 裁过。
  const truncatedByHost = entry.segments.some((s) => wasPrunedByHost(s.text));
  const warnings = integrityWarnings(entry);

  return {
    status: "ok",
    id,
    title: entry.title,
    parts,
    integrity: integrityOf(entry),
    ...(warnings.length ? { warnings, message: `来源不完整：${warnings.join("; ")}` } : {}),
    ...(next === null ? {} : { nextCursor: encodeCursor({ ...next, entryId: entry.id, version: entryVersion(entry) }) }),
    range: { returnedChars, totalChars: entry.length, fromChar, toChar },
    estimatedTokens: estimateTokens(returnedChars),
    ...(truncatedByHost
      ? {
          truncatedByHost: true,
          message:
            "本页含宿主裁剪标记（[... tool result middle pruned ...]）：来源事件已被 tool-result-pruner 裁过，中间段原文不可恢复。不要把这些内容当作完整原文。",
        }
      : {}),
  };
}
