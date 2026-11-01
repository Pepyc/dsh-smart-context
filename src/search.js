/**
 * 关键词搜索：在归档原文里找位置。
 *
 * **本模块不接触宿主 API**，输入是 `ArchiveEntry[]`，输出是纯数据。
 *
 * 能力边界（Steps §5.4 明确要求记录）：
 *
 * | 支持 | 不支持 |
 * |---|---|
 * | 中文连续子串匹配 | **同义改写**（"省钱" 找不到 "降低成本"） |
 * | 英文大小写归一 | 词形还原（"running" 找不到 "run"） |
 * | 文件路径 | 拼写纠错 |
 * | 报错码 | 语义相似 |
 * | 精确短语（引号） | 正则 |
 *
 * **这不是语义搜索。** 排序层级之间可比，层内只按命中次数排，
 * 不编造"相关度分数"——那会让使用者误以为是语义相似度。
 * @module dsh-smart-context/search
 */

import { integrityOf } from "./archive.js";
import { integrityWarnings } from "./integrity.js";
import { entryVersion, fingerprint, packCursor, unpackCursor } from "./identity.js";
import { encodeCursor } from "./pagination.js";
import { outputCost } from "./output-budget.js";
import { safeEnd } from "./unicode.js";

/** 单次返回的默认条数。 */
export const DEFAULT_LIMIT = 5;

/** 单次返回的硬上限。超过按上限截断。 */
export const MAX_LIMIT = 20;

/** 查询长度上限（字符）。超过直接拒绝，不截断。 */
export const MAX_QUERY_CHARS = 512;

/**
 * 每条结果默认带几个片段。
 *
 * 实测（2026-10-30）：某归档 138 万字符、`list_plugins` 命中 **43 处**，
 * 但只返回 3 个片段——答案在第 4 个之后的命中点，模型够不到。
 * 默认 5、上限 15：再多对模型没帮助，而且响应体积顶不住。
 */
const DEFAULT_SNIPPETS = 5;

/** 片段数上限。 */
export const MAX_SNIPPETS = 15;

/** 片段截断长度（命中位置前后各留多少字符）。 */
const SNIPPET_RADIUS = 80;

/**
 * 命中点排序：**先看词是否聚在一起，再看出现几次**。
 *
 * 为什么不是单纯按次数：某段 200 字符里出现 5 次，可能只是重复的工具说明；
 * 另一段 2000 字符里出现 8 次，才可能是实际调用记录。所以：
 *
 * 1. 不同查询词都出现（多词同段，几乎必然是目标）
 * 2. 词间距离越近越优
 * 3. 含数字/路径/标识符（数字类答案的典型特征）
 * 4. 命中次数
 *
 * @param {{ seq: number, text: string, offset: number }} snippet
 * @param {string[]} needles
 * @returns {number} 越小越靠前
 */
function snippetRank(snippet, needles) {
  const lower = snippet.text.toLowerCase();
  const hits = needles.filter((n) => lower.includes(n.toLowerCase()));
  // 1. 覆盖的词越多越优（反转：未覆盖数作为主键）
  const missing = needles.length - hits.length;
  // 2. 词间距离：第一个命中位置到最后一个的跨度，越窄越优
  const positions = hits
    .map((n) => lower.indexOf(n.toLowerCase()))
    .filter((p) => p >= 0)
    .sort((a, b) => a - b);
  const span = positions.length > 1 ? (positions.at(-1) ?? 0) - (positions[0] ?? 0) : 0;
  // 3. 含数字/路径/标识符
  const hasValue = /\d|[\\/]|[A-Za-z_]{3,}\(/.test(snippet.text) ? 0 : 1;
  // 4. 命中次数（同一片段内）
  let count = 0;
  for (const n of needles) {
    let from = 0;
    const needle = n.toLowerCase();
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      count += 1;
      from = at + needle.length;
    }
  }
  return missing * 1_000_000 + span * 1_000 + hasValue * 100 - Math.min(count, 99);
}

/**
 * 层级排序权重。数值越小越靠前。
 * @type {Record<import("./search-types.js").HitTier, number>}
 */
const TIER_ORDER = {
  "exact-phrase": 0,
  "path-or-code": 1,
  title: 2,
  body: 3,
};

/**
 * 判断查询是否形如路径、标识符或报错码。
 *
 * 判据：包含路径/标识符分隔符，或整体是全大写字母数字码。
 * 这是**启发式**，不是语法分析——目的只是给出一个可解释的优先级。
 *
 * @param {string} query
 * @returns {boolean}
 */
export function looksLikePathOrCode(query) {
  if (/[/\\_.:-]/.test(query)) return true;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(query)) return true;
  return false;
}

/**
 * 解析查询：处理引号包裹的精确短语。
 *
 * @param {string} raw
 * @returns {{ terms: string[], phrase: string | null }}
 */
export function parseQuery(raw) {
  const trimmed = raw.trim();
  const quoted = /^["'`](.+?)["'`]$/s.exec(trimmed);
  if (quoted !== null && quoted[1] !== undefined) {
    return { terms: [], phrase: quoted[1] };
  }
  // 按空白切词，保留原顺序，去重。
  const terms = [...new Set(trimmed.split(/\s+/).filter((t) => t !== ""))];
  return { terms, phrase: null };
}

/**
 * 在文本里数命中次数（大小写归一）。
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, from);
    if (at === -1) break;
    count += 1;
    from = at + lowerNeedle.length;
  }
  return count;
}

/**
 * 截取命中位置附近的文本。
 *
 * @param {string} text
 * @param {{start: number, end: number}} match - 原文中的命中范围
 * @returns {string}
 */
function excerpt(text, match) {
  const start = safeStart(text, match.start - SNIPPET_RADIUS);
  const end = safeEnd(text, match.end + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/** @param {string} text @param {number} at */
function safeStart(text, at) {
  at = Math.max(0, at);
  if (at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[at] ?? "")) at -= 1;
  return at;
}

/** 逐个返回命中在原文中的 UTF-16 范围。
 * 整串转换保留 Greek final sigma 等上下文规则；逐码点只计算长度映射。
 * 原文坐标只向前扫描一次，即使同一片段出现很多命中也不会重复扫描前缀。
 * @param {string} text @param {string} needle @returns {Generator<{start:number,end:number}>} */
function* originalMatches(text, needle) {
  const normalized = needle.toLowerCase();
  if (normalized === "") return;
  const foldedText = text.toLowerCase();
  let at = foldedText.indexOf(normalized);
  if (at < 0) return;

  const points = text[Symbol.iterator]();
  let originalStart = 0; let originalEnd = 0; let foldedEnd = 0;
  const advance = () => {
    const next = points.next();
    if (next.done) return false;
    originalStart = originalEnd;
    originalEnd += next.value.length;
    foldedEnd += next.value.toLowerCase().length;
    return true;
  };

  while (at >= 0) {
    while (foldedEnd <= at) if (!advance()) return;
    const start = originalStart;
    const end = at + normalized.length;
    while (foldedEnd < end) if (!advance()) return;
    yield { start, end: originalEnd };
    at = foldedText.indexOf(normalized, end);
  }
}

/**
 * 在一个归档条目内搜索。
 *
 * @param {import("./archive-types.js").ArchiveEntry} entry
 * @param {{ terms: string[], phrase: string | null }} query
 * @param {number} [snippetLimit] - 返回几个片段（默认 5，上限 15）
 * @returns {{ matched: boolean, tier: import("./search-types.js").HitTier, matchCount: number, snippets: import("./search-types.js").SearchSnippet[] }}
 */
function searchEntry(entry, query, snippetLimit = DEFAULT_SNIPPETS) {
  let matchCount = 0;
  let titleHit = false;
  let bodyHit = false;

  const needles = query.phrase !== null ? [query.phrase] : query.terms;
  /** @type {Array<{snip: import('./search-types.js').SearchSnippet, rank: number}>} */
  const ranked = [];
  /** @type {Map<string, number>} */
  const ranks = new Map();
  /** 保留当前最佳的 N 个，避免大量命中时为所有片段分配内存。
   * @param {import('./search-types.js').SearchSnippet} snip */
  function addSnippet(snip) {
    if (ranked.some((item) => item.snip.seq === snip.seq && item.snip.offset === snip.offset)) return;
    let rank = ranks.get(snip.text);
    if (rank === undefined) {
      rank = snippetRank(snip, needles);
      if (ranks.size >= 256) ranks.clear();
      ranks.set(snip.text, rank);
    }
    const before = ranked.findIndex((item) => rank < item.rank || (rank === item.rank && snip.seq < item.snip.seq));
    if (before < 0 && ranked.length >= snippetLimit) return;
    ranked.splice(before < 0 ? ranked.length : before, 0, { snip, rank });
    if (ranked.length > snippetLimit) ranked.pop();
  }

  // **AND 语义**：多词查询要求每个词都出现，而不是任意一个出现。
  //
  // 用 OR 会让无关结果大量涌入——实测「require an output」会因为
  // "output" 单独命中而匹配到不相关的归档。AND 更符合"找位置"的用途：
  // 用户输入多个词是想缩小范围，不是想扩大。
  //
  // 精确短语（引号）只有一个 needle，AND 退化为单条件，不受影响。
  // 考虑每一个命中点，持续按 snippetRank 保留最佳的 N 个；
  // 后面的命中也能进入结果，无需保留所有候选片段。
  const perNeedle = needles.map((needle) => {
    const titleCount = countOccurrences(entry.title, needle);
    let bodyCount = 0;

    for (const segment of entry.segments) {
      for (const match of originalMatches(segment.text, needle)) {
        bodyCount += 1;
        addSnippet({
          seq: segment.seq,
          text: excerpt(segment.text, match),
          offset: match.start,
          ...(segment.isError === undefined ? {} : { isError: segment.isError }),
          ...(segment.interrupted === undefined ? {} : { interrupted: segment.interrupted }),
        });
      }
    }

    return { titleCount, bodyCount };
  });

  // 任一词完全没出现 → 整条不匹配。
  if (perNeedle.some((p) => p.titleCount === 0 && p.bodyCount === 0)) {
    return { matched: false, tier: "body", matchCount: 0, snippets: [] };
  }

  for (const p of perNeedle) {
    if (p.titleCount > 0) titleHit = true;
    if (p.bodyCount > 0) bodyHit = true;
    matchCount += p.titleCount + p.bodyCount;
  }

  const snippets = ranked.map((item) => item.snip);

  /** @type {import("./search-types.js").HitTier} */
  let tier;
  if (query.phrase !== null) tier = "exact-phrase";
  else if (needles.length === 1 && needles[0] !== undefined && looksLikePathOrCode(needles[0])) tier = "path-or-code";
  else if (titleHit) tier = "title";
  else tier = "body";

  return { matched: true, tier, matchCount, snippets };
}

/**
 * 在归档集合中搜索。
 *
 * @param {object} input
 * @param {import("./archive-types.js").ArchiveEntry[]} input.entries - 当前会话的归档
 * @param {string} input.query - 原始查询串
 * @param {number} [input.limit] - 返回条数，默认 5，硬上限 20
 * @param {string} [input.cursor] - 翻页游标（上一页最后一个 id）
 * @param {number} [input.maxOutputChars] - 完整响应预算（含包装），宿主工具传入
 * @param {number} [input.unresolvedArchives] - 无法解析的压缩来源数量
 * @param {number} [input.snippets] - 每条结果带几个片段，默认 5，上限 15
 * @returns {import("./search-types.js").SearchResponse}
 */
export function searchArchives({ entries, query, limit = DEFAULT_LIMIT, cursor, maxOutputChars = Infinity, unresolvedArchives = 0, snippets: snippetCount }) {
  const trimmed = typeof query === "string" ? query.trim() : "";
  // 每条结果带几个片段：默认 5，钳到 [1, 15]。
  const snippetLimit = Number.isSafeInteger(snippetCount) && /** @type {number} */ (snippetCount) > 0
    ? Math.min(/** @type {number} */ (snippetCount), MAX_SNIPPETS)
    : DEFAULT_SNIPPETS;

  if (trimmed === "") {
    return { status: "empty-query", hits: [], total: 0, message: "查询为空" };
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    return {
      status: "query-too-long",
      hits: [],
      total: 0,
      message: `查询过长：${trimmed.length} 字符，上限 ${MAX_QUERY_CHARS}`,
    };
  }
  if (entries.length === 0) {
    if (unresolvedArchives > 0) return { status: "source-unavailable", hits: [], total: 0, incompleteArchives: unresolvedArchives, message: "压缩来源无法解析，无法确认当前会话是否有可检索的归档。" };
    if (typeof cursor === "string" && cursor !== "") return { status: "bad-cursor", hits: [], total: 0, message: "搜索游标已失效或属于其他查询，请不带游标重新搜索。" };
    return {
      status: "no-index",
      hits: [],
      total: 0,
      message: "当前会话还没有归档。归档在宿主压缩历史后才会产生。",
    };
  }

  const parsed = parseQuery(trimmed);
  const incompleteArchives = entries.filter((e) => integrityOf(e) !== "complete").length + unresolvedArchives;
  if (parsed.terms.length === 0 && parsed.phrase === null) {
    return { status: "empty-query", hits: [], total: 0, message: "查询为空" };
  }

  /**
   * 用一组 needle 搜全部归档，返回命中列表。
   * @param {{ terms: string[], phrase: string | null }} query
   * @returns {{ hits: import("./search-types.js").SearchHit[], versions: Map<string, string> }}
   */
  function runQuery(query) {
  /** @type {import("./search-types.js").SearchHit[]} */
  const matched = [];
  /** @type {Map<string, string>} */ const versions = new Map();
  for (const entry of entries) {
    const result = searchEntry(entry, query, snippetLimit);
    if (!result.matched) continue;
    const currentVersion = entryVersion(entry);
    versions.set(entry.id, currentVersion);
    const snippets = result.snippets.map((snippet) => ({ ...snippet,
      cursor: encodeCursor({ entryId: entry.id, version: currentVersion,
        segmentIndex: entry.segments.findIndex((s) => s.seq === snippet.seq), charOffset: safeStart(entry.segments.find((s) => s.seq === snippet.seq)?.text ?? "", snippet.offset - SNIPPET_RADIUS) }),
    }));
    const openCursor = snippets[0]?.cursor ?? (entry.segments.length ? encodeCursor({ entryId: entry.id,
      version: currentVersion, segmentIndex: 0, charOffset: 0 }) : undefined);
    matched.push({
      id: entry.id,
      title: entry.title,
      tier: result.tier,
      matchCount: result.matchCount,
      snippets,
      ...(openCursor === undefined ? {} : { openCursor }),
      length: entry.length,
      sourceSeqs: Number.isFinite(maxOutputChars) ? entry.sourceSeqs.slice(0, 32) : entry.sourceSeqs,
      ...(Number.isFinite(maxOutputChars) && entry.sourceSeqs.length > 32 ? { sourceSeqsOmitted: entry.sourceSeqs.length - 32 } : {}),
      kind: entry.kind,
      integrity: integrityOf(entry),
      ...(integrityWarnings(entry).length ? { warnings: integrityWarnings(entry) } : {}),
    });
  }
  return { hits: matched, versions };
  }

  const initial = runQuery(parsed);
  let matched = initial.hits;
  const versions = initial.versions;
  /** @type {string | null} */ let relaxed = null;

  // **OR 降级**：多词 AND 零结果时，逐个词单独搜。
  //
  // 实测（2026-10-30）：查询「list_plugins 总条目」返回 0，因为 AND 要求
  // 两词都出现，而原文只有 `list_plugins`、没有「总条目」这个连续词。
  // 拆成单词重试就能命中——模型的关键词常来自推测，不一定是原文用词。
  //
  // **不做全 OR**：那会让弱词把噪音全带进来。只逐个单词试，且明确标注。
  if (matched.length === 0 && parsed.phrase === null && parsed.terms.length > 1) {
    /** @type {Map<string, import("./search-types.js").SearchHit>} */
    const merged = new Map();
    const tried = [];
    for (const term of parsed.terms) {
      tried.push(term);
      const one = runQuery({ terms: [term], phrase: null });
      for (const hit of one.hits) {
        if (!merged.has(hit.id)) merged.set(hit.id, hit);
        versions.set(hit.id, one.versions.get(hit.id) ?? versions.get(hit.id) ?? "");
      }
    }
    if (merged.size > 0) {
      matched = [...merged.values()];
      relaxed = `原查询「${trimmed}」无结果，已放宽为分别匹配：${tried.join(" / ")}。**这不是精确匹配**，请自行核对命中内容是否相关。`;
    }
  }

  if (matched.length === 0) {
    if (typeof cursor === "string" && cursor !== "") return { status: "bad-cursor", hits: [], total: 0, message: "搜索游标已失效或属于其他查询，请不带游标重新搜索。" };
    return {
      status: "no-results",
      hits: [],
      total: 0,
      message: `没有归档包含「${trimmed}」。本搜索是关键词匹配，不处理同义改写。`,
      ...(incompleteArchives ? { incompleteArchives, message: "部分归档或压缩来源不完整；可读文本无命中不能证明历史中不存在该内容。" } : {}),
    };
  }

  // 排序：层级优先，层内按命中次数降序，再按长度升序（短的原更容易读）。
  matched.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
    return a.length - b.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  // 翻页：游标是上一页最后一条的 id，从它之后开始。
  let startIndex = 0;
  const version = fingerprint(matched.map((h) => [h.id, versions.get(h.id)]));
  const queryKey = fingerprint(trimmed);
  if (typeof cursor === "string" && cursor !== "") {
    const decoded = unpackCursor("s1", cursor);
    const at = decoded === null ? -1 : matched.findIndex((h) => h.id === decoded.id);
    if (decoded?.version !== version || decoded?.query !== queryKey || at < 0) {
      return { status: "bad-cursor", hits: [], total: matched.length, message: "搜索游标已失效或属于其他查询，请不带游标重新搜索。" };
    }
    startIndex = at + 1;
  }

  const pageSize = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT) : DEFAULT_LIMIT;
  const page = matched.slice(startIndex, startIndex + pageSize);
  const response = () => ({
    status: /** @type {const} */ ("ok"),
    hits: page,
    total: matched.length,
    ...(incompleteArchives ? { incompleteArchives } : {}),
    ...(relaxed !== null ? { relaxed: true, message: relaxed } : {}),
    ...(unresolvedArchives && relaxed === null ? { message: "部分压缩来源无法解析，搜索结果可能不完整。" } : {}),
    ...(startIndex + page.length < matched.length && page.at(-1) !== undefined ? { nextCursor: packCursor("s1", { id: page.at(-1)?.id, version, query: queryKey }) } : {}),
  });
  while (page.length > 1 && outputCost(response()) > maxOutputChars) page.pop();
  const first = page[0];
  if (first !== undefined) {
    while (first.snippets.length > 1 && outputCost(response()) > maxOutputChars) {
      first.snippets.pop(); first.snippetsOmitted = (first.snippetsOmitted ?? 0) + 1;
    }
  }
  if (outputCost(response()) > maxOutputChars) return { status: "budget-too-small", hits: [], total: matched.length, message: "单条命中元数据超出响应预算，请缩小查询。" };
  return response();
}
