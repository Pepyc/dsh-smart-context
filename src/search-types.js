
/**
 * 搜索的类型。
 * @module dsh-smart-context/search-types
 */

/**
 * 命中层级。**层级之间有序**，用于排序；层内不再编造"相关度分数"。
 *
 * - `exact-phrase`：查询以引号包裹，要求精确子串匹配
 * - `path-or-code`：查询形如文件路径、报错码、标识符（含 `/`、`\\`、`_`、`-`、`.` 或全大写码）
 * - `title`：命中归档标题
 * - `body`：命中原文正文
 *
 * @typedef {'exact-phrase' | 'path-or-code' | 'title' | 'body'} HitTier
 */

/**
 * 一条命中片段。
 *
 * @typedef {object} SearchSnippet
 * @property {boolean} [isError] - 原始工具结果的失败状态
 * @property {boolean} [interrupted] - 原始助手回复的中断状态
 * @property {number} seq - 片段来源事件编号
 * @property {string} text - 命中位置附近的文本（已截断）
 * @property {number} offset - 在原文中的字符偏移
 * @property {string} [cursor] - 直接打开此命中附近的版本化游标
 */

/**
 * 一条搜索结果。
 *
 * @typedef {object} SearchHit
 * @property {string} id - 归档 ID，可直接传给 `memory_open`
 * @property {string} [openCursor] - 直接打开首个命中附近的位置
 * @property {'complete' | 'partial' | 'broken'} [integrity]
 * @property {string[]} [warnings]
 * @property {number} [sourceSeqsOmitted]
 * @property {number} [snippetsOmitted]
 * @property {string} title - 归档标题
 * @property {HitTier} tier - 命中层级（排序依据）
 * @property {number} matchCount - 该归档内的命中次数
 * @property {SearchSnippet[]} snippets - 最多 3 条命中片段
 * @property {number} length - 原文总字符数
 * @property {number[]} sourceSeqs - 来源事件编号
 * @property {'summary' | 'prune'} kind - 归档类型
 */

/**
 * 搜索响应。
 *
 * @typedef {object} SearchResponse
 * @property {'ok' | 'empty-query' | 'query-too-long' | 'no-index' | 'no-results' | 'bad-cursor' | 'source-unavailable' | 'budget-too-small'} status - 状态
 * @property {SearchHit[]} hits - 命中结果（已按层级与命中次数排序）
 * @property {number} total - 匹配的归档总数（可能大于 `hits.length`）
 * @property {number} [incompleteArchives]
 * @property {boolean} [relaxed] - 原查询无结果、已放宽为逐词分别匹配。结果不是精确匹配
 * @property {string} [nextCursor] - 翻页游标，无更多结果时省略
 * @property {string} [message] - 人类可读说明
 */

export {};
