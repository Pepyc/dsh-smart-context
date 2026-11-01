/**
 * 分页的类型。
 * @module dsh-smart-context/pagination-types
 */

/**
 * 一页里的一段内容。
 *
 * @typedef {object} PagePart
 * @property {number} seq - 来源事件编号
 * @property {import("./archive-types.js").SegmentRole} role - 角色
 * @property {string} text - 这一页里该片段的文本
 * @property {boolean} [isError] - 原始工具结果的失败状态
 * @property {boolean} [interrupted] - 原始助手回复的中断状态
 * @property {string} [toolName] - 工具名
 * @property {string} [toolCallId] - 工具调用关联 ID
 * @property {number} offset - 该片段在整段原文中的起始字符偏移
 * @property {boolean} [partial] - 该片段是否被截断（本页只含一部分）
 */

/**
 * 游标：指向原文中的一个位置。
 *
 * 对外是不可拆解的版本化游标；片段位置必须同时匹配归档 ID 和内容版本。
 *
 * @typedef {object} PageCursor
 * @property {number} segmentIndex - 从哪个片段开始（segments 数组下标）
 * @property {number} charOffset - 在该片段内的字符偏移
 * @property {string} [entryId]
 * @property {string} [version]
 */

/**
 * 分页响应状态。
 *
 * - `ok`：正常返回一页
 * - `entry-not-found`：ID 不在当前会话的归档里
 * - `cross-session`：ID 属于别的会话
 * - `bad-cursor`：游标格式错误或越界
 * - `source-missing`：来源事件缺失，原文不可恢复
 * - `empty-entry`：条目没有可读文本
 *
 * @typedef {'ok' | 'entry-not-found' | 'cross-session' | 'bad-cursor' | 'source-missing' | 'empty-entry' | 'budget-too-small'} PageStatus
 */

/**
 * 一页原文。
 *
 * @typedef {object} PageResult
 * @property {PageStatus} status
 * @property {'complete' | 'partial' | 'broken'} [integrity]
 * @property {string[]} [warnings]
 * @property {string} id - 归档 ID
 * @property {string} [title]
 * @property {PagePart[]} parts - 本页内容（按原文顺序）
 * @property {string} [nextCursor] - 下一页游标；已到末尾时省略
 * @property {{ returnedChars: number, totalChars: number, fromChar: number, toChar: number }} [range] - 已返回范围
 * @property {number} [estimatedTokens] - 估算 token（`chars / 2`，**不是精确值**）
 * @property {boolean} [truncatedByHost] - 原文含宿主裁剪标记，**本页不完整**
 * @property {string} [message] - 人类可读说明
 */

export {};
