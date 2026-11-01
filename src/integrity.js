export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const PRUNED_WARNING = "来源含宿主裁剪标记，不能保证中间段原文完整。";

/** @param {string} text */
export function wasPrunedByHost(text) { return text.includes(PRUNE_MARKER.trim()); }

/** @param {Pick<import('./archive-types.js').ArchiveEntry,'segments'|'warnings'>} entry */
export function integrityWarnings(entry) {
  const warnings = new Set(entry.warnings ?? []);
  if (entry.segments.some((s) => wasPrunedByHost(s.text))) warnings.add(PRUNED_WARNING);
  return [...warnings];
}

/** @param {Pick<import('./archive-types.js').ArchiveEntry,'segments'|'warnings'>} entry
 * @returns {'complete'|'partial'|'broken'} */
export function integrityOf(entry) {
  return entry.segments.length === 0 ? "broken" : integrityWarnings(entry).length ? "partial" : "complete";
}
