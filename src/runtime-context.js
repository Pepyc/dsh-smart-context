/** 宿主把具名 context 合成一条快照。只有来源分段与正文逐字相符时才排除自己的目录。 */
const SNAPSHOT_PREFIX = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n";

/** @param {string} text @param {any} source @returns {string} */
export function withoutOwnCatalog(text, source) {
  if (source?.kind !== "runtime-context" || source.form !== "snapshot" || !Array.isArray(source.sections)) return text;
  const sections = source.sections;
  if (!sections.every((/** @type {any} */ section) => section !== null && typeof section === "object" &&
      typeof section.name === "string" && typeof section.text === "string" && section.text !== "")) return text;
  const retained = sections.filter((/** @type {any} */ section) => section.name !== "smart-context");
  if (retained.length === sections.length || text !== SNAPSHOT_PREFIX + sections.map((/** @type {any} */ section) => section.text).join("\n\n")) return text;
  return retained.length === 0 ? "" : SNAPSHOT_PREFIX + retained.map((/** @type {any} */ section) => section.text).join("\n\n");
}
