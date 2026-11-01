/**
 * 归档模块的数据结构。
 *
 * 这里只放**纯数据形状**，不含任何宿主 API——`archive.js` 接受事件数组，
 * 返回归档条目，可以完全离线测试。
 * @module dsh-smart-context/archive-types
 */

/**
 * 宿主会话事件的表面操作。
 *
 * 两种形态（实测，见 compatibility.md §7.3）：
 * - `'append'` —— 字符串，事件直接追加进 surface
 * - `{ op: 'replace', startSeq, endSeq }` —— 对象，替换既有区间
 *
 * @typedef {string | { op: 'replace'; startSeq: number; endSeq: number }} SurfaceOp
 */

/**
 * 一条原始会话事件（只声明本模块用到的字段）。
 *
 * @typedef {object} SessionEvent
 * @property {string} type - 事件类型，如 `'user/message'`、`'compaction/prune'`
 * @property {number} seq - 事件编号，**不保证在 surface 内单调**
 * @property {number} time - Unix 毫秒时间戳
 * @property {unknown} data - 事件负载，形状取决于 `type`
 * @property {SurfaceOp} [surfaceOp] - 表面操作；只有 surface 事件才有
 * @property {number[]} [sourceEventSeqs] - 本事件派生自哪些更早的事件
 */

/**
 * 原文片段的角色。
 * @typedef {'user' | 'assistant' | 'system' | 'developer' | 'tool' | 'other'} SegmentRole
 */

/**
 * 一段可读的原文。
 *
 * @typedef {object} ArchiveSegment
 * @property {number} seq - 来源事件编号
 * @property {SegmentRole} role - 角色
 * @property {string} text - 渲染后的纯文本
 * @property {boolean} [isError] - 原始工具结果的失败状态
 * @property {boolean} [interrupted] - 原始助手回复的中断状态
 * @property {string} [toolName] - 工具名（`tool/call` 或 `tool/result` 时）
 * @property {string} [toolCallId] - 工具调用关联 ID
 * @property {string} [sourceKind] - 消息的 `source.kind`，用于区分真实用户消息
 *   与宿主注入的 `runtime-context` 快照
 */

/**
 * 归档条目：一份「原文在哪里」的稳定引用。
 *
 * @typedef {object} ArchiveEntry
 * @property {string} id - 稳定 ID，由会话身份与来源集合确定
 * @property {string} sessionId - 所属会话
 * @property {number[]} sourceSeqs - 覆盖的全部来源事件编号（来自 `sourceEventSeqs`）
 * @property {'summary' | 'prune'} kind - 摘要压缩还是内容裁剪
 * @property {string} title - 标题，取自摘要首行或首条用户消息
 * @property {string} preview - 预览片段
 * @property {number} length - 原文总字符数
 * @property {number} createdAt - 归档建立时间（Unix 毫秒）
 * @property {ArchiveSegment[]} segments - 按 surface 来源顺序展开的原文片段
 * @property {string[]} [warnings] - 解析过程中发现的问题
 */

/**
 * 归档建立的结果。
 *
 * @typedef {object} ArchiveResult
 * @property {ArchiveEntry[]} entries - 成功建立的归档
 * @property {ArchiveIssue[]} issues - 无法建立归档的来源问题
 * @property {number} unresolvedArchives - 已识别但无法建立条目的压缩来源数量
 */

/**
 * 来源解析失败的原因。
 *
 * @typedef {object} ArchiveIssue
 * @property {'missing-source' | 'empty-source' | 'cyclic-source' | 'not-compaction'} code
 * @property {number} [seq] - 相关事件编号
 * @property {string} message - 人类可读说明
 */

export {};
