
/**
 * 存储层的类型。
 * @module dsh-smart-context/store-types
 */

/**
 * 归档条目的持久化形态。
 *
 * 与内存态的 `ArchiveEntry` 相比：
 * - 增加 `schemaVersion` 与 `contentHash`，用于检测格式漂移与原文改写
 * - `status` 结构化，取代内存态的 `warnings` 数组
 * - **不存 `segments`**：原文是真源，随时可从会话日志重读。
 *   存了会让插件数据目录随会话线性膨胀，而 Steps §5.3 明确要求
 *   「默认不复制整套会话原文」。
 *
 * @typedef {object} StoredEntry
 * @property {number} schemaVersion - 写入时的归档格式版本
 * @property {string} id - 稳定 ID（`makeId` 产出）
 * @property {string} sessionId - 所属会话
 * @property {number[]} sourceSeqs - 覆盖的来源事件编号（已排序）
 * @property {'summary' | 'prune'} kind - 归档类型
 * @property {string} title - 标题
 * @property {string} preview - 预览片段（首 120 字符）
 * @property {number} length - 原文总字符数
 * @property {number} createdAt - 归档建立时间（Unix 毫秒）
 * @property {string} contentHash - 原文内容的 SHA-256 前 16 位十六进制
 * @property {EntryStatus} status - 结构化状态
 */

/**
 * 归档状态。
 *
 * - `complete`：来源全部命中，原文完整
 * - `partial`：部分来源缺失，原文不完整（`missingSeqs` 列出缺失项）
 * - `broken`：来源全缺或无可读文本，无法提供原文
 *
 * @typedef {'complete' | 'partial' | 'broken'} EntryStatus
 */

/**
 * 索引文件的内容。
 *
 * 索引是**可重建派生物**，真源是会话日志。
 *
 * @typedef {object} ArchiveIndex
 * @property {number} schemaVersion
 * @property {string} sessionId
 * @property {number} updatedAt - 最后写入时间
 * @property {number} lastSeq - 已处理到的最大事件 seq（增量游标）
 * @property {StoredEntry[]} entries
 */

export {};
