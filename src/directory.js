/**
 * 归档目录：告诉模型「本会话有哪些归档可查」。
 *
 * **目录 ≠ 命中结果**，两者用途不同：
 *
 * | | 目录 | 命中结果 |
 * |---|---|---|
 * | 谁产生 | 插件主动注入 | `memory_search` 返回 |
 * | 范围 | **全部**归档 | **只有匹配的** |
 * | 位置 | 对话尾部一条消息 | 工具返回 |
 * | 预算 | ≤ 800 token | ≤ 5 条 |
 *
 * **本模块只做纯文本渲染**，不接触宿主，不读会话。调用方负责提供条目。
 * @module dsh-smart-context/directory
 */

import { integrityOf } from "./integrity.js";

/** 目录字符预算。800 token ≈ 1600 字符（中文约 2 字符/token）。 */
export const MAX_CATALOG_CHARS = 1600;

/** 最多列多少条。超过只显示前面这些，并说明「其余可搜索」。 */
const MAX_LISTED = 12;

/**
 * 把字符数换算成估算 token。
 * @param {number} chars
 * @returns {number}
 */
function estTokens(chars) {
  return Math.ceil(chars / 2);
}

/**
 * 把长度格式化成紧凑提示。
 * @param {number} chars
 * @returns {string}
 */
function formatLength(chars) {
  if (chars >= 1000) return `${Math.round(chars / 1000)}K`;
  return String(chars);
}

/**
 * 渲染目录文本。
 *
 * **必须确定性**：同样的条目集合必须产出**逐字节相同**的字符串。
 * 否则宿主的变化检测失效，每轮都会重发目录，前缀缓存全废。
 *
 * 所以：
 * - 不出现时间戳、不出现「刚刚更新」之类的话
 * - 条目顺序固定（按 id 排序，不用 createdAt——那个会随重建漂移）
 * - 长度取整到 K，避免字符数微变导致文本变化
 *
 * @param {object} input
 * @param {import("./archive-types.js").ArchiveEntry[]} input.entries - 当前会话的归档
 * @param {number} [input.unresolvedArchives] - 无法解析的压缩来源数量
 * @returns {string} 目录文本；**无归档时返回空字符串**（宿主不注入空 context）
 */
export function renderCatalog({ entries, unresolvedArchives = 0 }) {
  const warning = unresolvedArchives > 0 ? `有 ${unresolvedArchives} 个压缩来源无法解析，归档可能不完整。` : "";
  if (entries.length === 0) return warning;

  // 固定顺序：按 id 字典序。不用 createdAt（重建会漂移），不用 length（会变）。
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const listed = sorted.slice(0, MAX_LISTED);
  const rest = sorted.length - listed.length;

  const lines = [];
  if (warning) lines.push(warning);
  lines.push(`本会话有 ${entries.length} 份已归档的历史内容（宿主压缩后原文被遮蔽，可检索取回）：`);
  for (const entry of listed) {
    const kind = entry.kind === "prune" ? "裁剪" : "摘要";
    const warning = integrityOf(entry) !== "complete" ? " [来源不完整]" : "";
    lines.push(`- ${entry.id}  [${kind}]${warning}  ${formatLength(entry.length)} 字符  ${entry.title}`);
  }
  if (rest > 0) {
    lines.push(`…另有 ${rest} 份未列出，用 memory_search 查找。`);
  }
  lines.push("");
  lines.push("用法：memory_search 按关键词找位置（返回 id 与片段）；memory_open 用 id 分页取回原文。");

  let text = lines.join("\n");

  // 超预算时截断：优先保留头部（数量 + 前几条），并明确告知被截断。
  if (text.length > MAX_CATALOG_CHARS) {
    const tail = "\n…目录已截断，用 memory_search 查找完整内容。";
    const keep = MAX_CATALOG_CHARS - tail.length;
    // 按行截断，避免切碎某一行。
    const cut = text.slice(0, keep);
    const lastNewline = cut.lastIndexOf("\n");
    text = (lastNewline > 0 ? cut.slice(0, lastNewline) : cut) + tail;
  }

  return text;
}

/**
 * 估算目录占用的 token。
 * @param {string} text
 * @returns {number}
 */
export function catalogTokens(text) {
  return estTokens(text.length);
}

/**
 * 判断两份目录是否等价（用于跳过无谓的重发）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameCatalog(a, b) {
  return a === b;
}
