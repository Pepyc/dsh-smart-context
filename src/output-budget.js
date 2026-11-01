export const MAX_OUTPUT_CHARS = 6000;

/**
 * 估算一次工具响应的实际字符开销。
 *
 * 只计算**模型会看到的那份**：本工具包装，以及常见 PTC
 * `console.log(JSON.stringify(value))` 的一层转义。不再计入已移除的
 * `memoryOrigin` 标记。
 *
 * @param {unknown} value
 */
export function outputCost(value) {
  const text = JSON.stringify(value);
  return Math.max(text.length, JSON.stringify({ logs: [text] }).length, JSON.stringify({ result: JSON.parse(text) }).length);
}

/** @param {any} value */
export function budgetError(value) {
  return { status: "budget-too-small",
    ...(Array.isArray(value?.parts) ? { id: typeof value.id === "string" && value.id.length <= 128 ? value.id : "", parts: [] }
      : { hits: [], total: typeof value?.total === "number" ? value.total : 0 }),
    message: "元数据无法在响应预算内完整返回。请缩小查询或检查异常来源；没有截断正文或推进游标。" };
}
