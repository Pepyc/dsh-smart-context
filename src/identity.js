import { createHash } from "node:crypto";

/** @param {unknown} value */
export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** JSON 值的语义指纹：对象键排序，数组顺序和字符串逐字保留。
 * 仅用于返回值完整性比较，不能代替请求/缓存的字节指纹。
 * @param {unknown} value */
export function valueFingerprint(value) {
  const canonical = JSON.stringify(value, (_key, item) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** @param {import('./archive-types.js').ArchiveEntry} entry */
export function entryVersion(entry) {
  return fingerprint([entry.sessionId, entry.sourceSeqs, entry.title, entry.segments, entry.warnings ?? []]);
}

/** @param {string} prefix @param {unknown} value */
export function packCursor(prefix, value) {
  return `${prefix}.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

/** @param {string} prefix @param {string} raw @returns {any | null} */
export function unpackCursor(prefix, raw) {
  if (raw.length > 4096 || !raw.startsWith(`${prefix}.`) || !/^[A-Za-z0-9_-]+$/.test(raw.slice(prefix.length + 1))) return null;
  try { return JSON.parse(Buffer.from(raw.slice(prefix.length + 1), "base64url").toString("utf8")); }
  catch { return null; }
}
