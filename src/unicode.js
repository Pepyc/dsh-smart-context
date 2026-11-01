/** 将 UTF-16 截断终点退到完整码点边界；不改变原始文本。
 * @param {string} text @param {number} offset */
export function safeEnd(text, offset) {
  let end = Math.max(0, Math.min(text.length, offset));
  const left = text.charCodeAt(end - 1); const right = text.charCodeAt(end);
  if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) end--;
  return end;
}
