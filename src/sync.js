/**
 * 增量同步：把会话事件的变化反映到索引。
 *
 * 核心约束（Steps §5.3）：**只在新事件到达时增量处理**，
 * 不在每个模型步骤重扫全部历史。
 *
 * 但增量处理有个陷阱：替换事件的 `sourceEventSeqs` 会指向**很早以前**的事件。
 * 如果只看 `lastSeq` 之后的事件，就会漏掉这些来源。
 *
 * 所以策略是：
 * 1. 用 `lastSeq` 筛出**新出现的替换事件**；
 * 2. 这些替换事件的来源从**完整事件表**里取；
 * 3. 只对「新增或被改写」的条目做落盘。
 *
 * @module dsh-smart-context/sync
 */

import { extractArchives, maxEventSeq } from "./archive.js";
import { mergeEntries, readIndex, writeIndex } from "./store.js";

/**
 * 把一批会话事件同步进索引。
 *
 * @param {object} input
 * @param {string} input.dir - 会话索引目录
 * @param {string} input.sessionId
 * @param {import("./archive-types.js").SessionEvent[]} input.events - **完整**事件数组
 *   （来源解析需要历史事件，不能只传增量）
 * @param {boolean} [input.force] - 强制全量重建（索引损坏时）
 * @returns {{
 *   index: import("./store-types.js").ArchiveIndex,
 *   added: number,
 *   updated: number,
 *   rebuilt: boolean,
 *   problem: string | null,
 * }}
 */
export function syncIndex({ dir, sessionId, events, force = false }) {
  const loaded = readIndex({ dir });

  // 索引损坏或强制重建 → 全量重算。
  if (force || loaded.problem !== null) {
    const { entries } = extractArchives({ sessionId, events });
    const maxSeq = maxEventSeq(events);
    const merged = mergeEntries({
      index: { ...loaded.index, entries: [], lastSeq: -1 },
      entries,
      processedThroughSeq: maxSeq,
    });
    const { problem } = writeIndex({ dir, index: merged.index });
    return {
      index: merged.index,
      added: merged.added,
      updated: 0,
      rebuilt: true,
      problem: problem ?? loaded.problem,
    };
  }

  const index = loaded.index;
  const maxSeq = maxEventSeq(events);
  const hasNewEvents = maxSeq > index.lastSeq;

  // 没有新事件时**仍要检查原文是否被改写**。
  //
  // 曾经的错误：`if (maxSeq <= lastSeq) return` 直接返回，导致
  // 「来源事件的内容变了、但没有新增事件」这种改写永远检测不到。
  //
  // 完整重扫的代价是 O(事件数)，实测 10838 事件约 10ms，可以接受。
  // 如果将来会话长到几十万事件，再引入「按来源 seq 定向校验」优化。
  const all = extractArchives({ sessionId, events });
  const ids = new Set(all.entries.map((e) => e.id));
  const retained = index.entries.filter((e) => ids.has(e.id));
  const merged = mergeEntries({ index: { ...index, entries: retained, lastSeq: -1 }, entries: all.entries, processedThroughSeq: maxSeq });

  // 没有新事件，也没有任何条目变化 → 什么都不做。
  if (!hasNewEvents && maxSeq === index.lastSeq && retained.length === index.entries.length && merged.added === 0 && merged.updated === 0) {
    return { index, added: 0, updated: 0, rebuilt: false, problem: null };
  }

  const { problem } = writeIndex({ dir, index: merged.index });

  return {
    index: merged.index,
    added: merged.added,
    updated: merged.updated,
    rebuilt: false,
    problem,
  };
}

export { extractArchives };
