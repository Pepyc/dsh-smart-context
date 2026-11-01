/**
 * 归档存储：持久化、增量更新、重建。
 *
 * **本模块不接触宿主 API。** 路径由调用方传入，`fs` 通过参数注入（默认用
 * `node:fs`），因此可以完全离线测试。
 *
 * 设计要点（对应 Steps §5.3）：
 *
 * 1. **索引是派生物，不是真源。** 真源是会话日志。索引损坏可以重建。
 * 2. **不存原文。** 只存元数据 + `contentHash`。原文随时可从日志重读。
 * 3. **可恢复写入。** 先写 `.tmp` 再 rename，避免半条记录让整库打不开。
 * 4. **增量处理。** 用 `lastSeq` 游标，只处理新事件。
 * 5. **按会话隔离。** 目录结构 `<root>/<workspaceKey>/<sessionId>/`。
 * @module dsh-smart-context/store
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { SCHEMA_VERSION, maxEventSeq, integrityOf } from "./archive.js";

/** 索引文件名。 */
export const INDEX_FILENAME = "archive-index.json";

/**
 * 计算原文内容的哈希，用于检测同一来源集合的原文是否被改写。
 *
 * 对文本及来源/执行状态做结构化编码，片段边界与状态变化都进入指纹。
 *
 * @param {import("./archive-types.js").ArchiveSegment[]} segments
 * @returns {string} SHA-256 前 16 位十六进制
 */
export function hashSegments(segments) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(segments.map((s) => [s.seq, s.role, s.text, s.toolName, s.toolCallId, s.sourceKind, s.isError, s.interrupted])));
  return hash.digest("hex").slice(0, 16);
}

/**
 * 把内存态归档条目转换成持久化形态。
 *
 * @param {import("./archive-types.js").ArchiveEntry} entry
 * @returns {import("./store-types.js").StoredEntry}
 */
export function toStoredEntry(entry) {
  /** @type {import("./store-types.js").EntryStatus} */
  const status = integrityOf(entry);

  return {
    schemaVersion: SCHEMA_VERSION,
    id: entry.id,
    sessionId: entry.sessionId,
    sourceSeqs: entry.sourceSeqs,
    kind: entry.kind,
    title: entry.title,
    preview: entry.preview,
    length: entry.length,
    createdAt: entry.createdAt,
    contentHash: hashSegments(entry.segments),
    status,
  };
}

/**
 * 新建一个空索引。
 *
 * @param {string} sessionId
 * @returns {import("./store-types.js").ArchiveIndex}
 */
export function emptyIndex(sessionId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    updatedAt: 0,
    lastSeq: -1,
    entries: [],
  };
}

/**
 * 校验读到的索引结构。
 *
 * 索引是派生物，损坏时应**重建**而不是尝试修复。
 *
 * @param {unknown} value
 * @param {string} sessionId
 * @returns {{ index: import("./store-types.js").ArchiveIndex | null, problem: string | null }}
 */
export function validateIndex(value, sessionId) {
  if (value === null || typeof value !== "object") {
    return { index: null, problem: "索引不是对象" };
  }
  const v = /** @type {Record<string, any>} */ (value);

  if (v.schemaVersion !== SCHEMA_VERSION) {
    return { index: null, problem: `schemaVersion 不匹配：读到 ${String(v.schemaVersion)}，期望 ${SCHEMA_VERSION}` };
  }
  if (v.sessionId !== sessionId) {
    return { index: null, problem: `sessionId 不匹配：读到 ${String(v.sessionId)}，期望 ${sessionId}` };
  }
  if (!Array.isArray(v.entries)) {
    return { index: null, problem: "entries 不是数组" };
  }
  if (typeof v.lastSeq !== "number") {
    return { index: null, problem: "lastSeq 不是数字" };
  }

  /** @type {import("./store-types.js").StoredEntry[]} */
  const entries = [];
  for (const raw of v.entries) {
    if (raw === null || typeof raw !== "object") continue;
    const e = /** @type {Record<string, any>} */ (raw);
    if (typeof e.id !== "string" || !Array.isArray(e.sourceSeqs)) continue;
    entries.push({
      schemaVersion: typeof e.schemaVersion === "number" ? e.schemaVersion : SCHEMA_VERSION,
      id: e.id,
      sessionId: typeof e.sessionId === "string" ? e.sessionId : sessionId,
      sourceSeqs: e.sourceSeqs.filter((/** @type {unknown} */ s) => typeof s === "number"),
      kind: e.kind === "prune" ? "prune" : "summary",
      title: typeof e.title === "string" ? e.title : "",
      preview: typeof e.preview === "string" ? e.preview : "",
      length: typeof e.length === "number" ? e.length : 0,
      createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
      contentHash: typeof e.contentHash === "string" ? e.contentHash : "",
      status: e.status === "partial" || e.status === "broken" ? e.status : "complete",
    });
  }

  return {
    index: {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
      lastSeq: v.lastSeq,
      entries,
    },
    problem: null,
  };
}

/**
 * 解析一个会话的索引目录。
 *
 * @param {string} root - 插件数据根（由调用方通过 `dshHomePath` 解析，不要硬编码）
 * @param {string} workspaceKey - 工作目录标识
 * @param {string} sessionId - 会话 ID
 * @returns {string}
 */
export function sessionDir(root, workspaceKey, sessionId) {
  for (const value of [workspaceKey, sessionId]) {
    // 两个标识必须各为一个普通目录名，不能通过分隔符、盘符或
    // Windows 设备名/尾随点空格改变索引实际位置。
    if (typeof value !== "string" || value === "" || value === "." || value === ".." ||
        /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) {
      throw new TypeError("Invalid index path component");
    }
  }
  return join(root, workspaceKey, sessionId);
}

/**
 * 读取索引。文件不存在返回空索引；损坏返回 `problem` 让调用方决定重建。
 *
 * @param {object} input
 * @param {string} input.dir - 会话索引目录
 * @returns {{ index: import("./store-types.js").ArchiveIndex, problem: string | null, existed: boolean }}
 */
export function readIndex({ dir }) {
  const file = join(dir, INDEX_FILENAME);
  const sessionId = dir.split(/[\\/]/).at(-1) ?? "";

  if (!existsSync(file)) {
    return { index: emptyIndex(sessionId), problem: null, existed: false };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      index: emptyIndex(sessionId),
      problem: `索引 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      existed: true,
    };
  }

  const { index, problem } = validateIndex(raw, sessionId);
  if (index === null) {
    return { index: emptyIndex(sessionId), problem, existed: true };
  }
  return { index, problem: null, existed: true };
}

/**
 * 写入索引。**可恢复写入**：先写临时文件再 rename。
 *
 * 半条记录不会让整库打不开——要么旧版本完整，要么新版本完整。
 *
 * @param {object} input
 * @param {string} input.dir - 会话索引目录
 * @param {import("./store-types.js").ArchiveIndex} input.index
 * @returns {{ written: boolean, problem: string | null }}
 */
export function writeIndex({ dir, index }) {
  const file = join(dir, INDEX_FILENAME);
  const tmp = `${file}.tmp`;
  const payload = { ...index, updatedAt: Date.now() };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, file);
    return { written: true, problem: null };
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误。
    }
    return {
      written: false,
      problem: `写入失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 把新提取的归档合并进索引。
 *
 * 合并规则：
 * - 按 `id` 去重——同一来源集合重复压缩不新增条目
 * - **`contentHash` 变化时更新**：原文被改写（少见，但可能）
 * - 保留旧条目的 `createdAt`（首次归档时间），不因重建而漂移
 *
 * @param {object} input
 * @param {import("./store-types.js").ArchiveIndex} input.index - 现有索引
 * @param {import("./archive-types.js").ArchiveEntry[]} input.entries - 新提取的归档
 * @param {number} input.processedThroughSeq - 本次处理到的最大 seq
 * @returns {{ index: import("./store-types.js").ArchiveIndex, added: number, updated: number }}
 */
export function mergeEntries({ index, entries, processedThroughSeq }) {
  /** @type {Map<string, import("./store-types.js").StoredEntry>} */
  const byId = new Map();
  for (const stored of index.entries) byId.set(stored.id, stored);

  let added = 0;
  let updated = 0;

  for (const entry of entries) {
    const next = toStoredEntry(entry);
    const existing = byId.get(next.id);

    if (existing === undefined) {
      byId.set(next.id, next);
      added += 1;
      continue;
    }

    // 保留首次归档时间，只更新内容相关字段。
    const merged = {
      ...next,
      createdAt: existing.createdAt,
    };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      byId.set(next.id, merged);
      updated += 1;
    }
    // 内容未变：保持原样，不计 added 也不计 updated。
  }

  const merged = [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );

  return {
    index: {
      ...index,
      lastSeq: Math.max(index.lastSeq, processedThroughSeq),
      entries: merged,
    },
    added,
    updated,
  };
}

/**
 * 从完整事件数组重建索引。
 *
 * 用于索引损坏或缺失时。**不做增量优化**——重建就是全量重算。
 *
 * @param {object} input
 * @param {string} input.dir - 会话索引目录
 * @param {string} input.sessionId
 * @param {import("./archive-types.js").SessionEvent[]} input.events
 * @param {(args: { sessionId: string, events: import("./archive-types.js").SessionEvent[], createdAt?: number }) => import("./archive-types.js").ArchiveResult} input.extract
 * @returns {{ index: import("./store-types.js").ArchiveIndex, added: number, problem: string | null }}
 */
export function rebuildIndex({ dir, sessionId, events, extract }) {
  const { entries } = extract({ sessionId, events });
  const base = emptyIndex(sessionId);
  const maxSeq = maxEventSeq(events);
  const { index, added } = mergeEntries({ index: base, entries, processedThroughSeq: maxSeq });
  const { problem } = writeIndex({ dir, index });
  return { index, added, problem };
}

export { SCHEMA_VERSION };
