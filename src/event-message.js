/** user/message 的当前契约直接承载消息；兼容既有包装日志。
 * 其他消息事件仍使用各自的 message 字段，不把任意 data 猜成消息。
 * @param {import('./archive-types.js').SessionEvent} event @returns {Record<string,any>|undefined} */
export function eventMessage(event) {
  const data = /** @type {any} */ (event.data);
  if (event.type === "user/message" && data?.role === "user" && Array.isArray(data.content)) return data;
  return data?.message !== null && typeof data?.message === "object" && !Array.isArray(data.message) ? data.message : undefined;
}
