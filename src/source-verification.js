import { collectProvenance } from "./provenance.js";

/** 从原始字段独立推导应保留的文字，不使用归档阶段的过滤函数。
 * @param {any} message @returns {{text: string, projected: boolean} | null} */
function sourceText(message) {
  if (!Array.isArray(message?.content) || !message.content.every((/** @type {any} */ block) => block?.type === "text" && typeof block.text === "string")) return null;
  const text = message.content.map((/** @type {any} */ block) => block.text).join("");
  const source = message.source;
  const sections = source?.sections;
  if (source?.kind === "runtime-context" && source.form === "snapshot" && Array.isArray(sections) &&
      sections.every((section) => section !== null && typeof section === "object" && typeof section.name === "string" && typeof section.text === "string" && section.text !== "")) {
    const prefix = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n";
    const retained = sections.filter((section) => section.name !== "smart-context");
    if (retained.length !== sections.length && text === prefix + sections.map((section) => section.text).join("\n\n")) {
      return { text: retained.length ? prefix + retained.map((section) => section.text).join("\n\n") : "", projected: true };
    }
  }
  return { text, projected: false };
}

/** 独立对照日志原始 text 字段，不调用归档 renderer。只声明实际覆盖的范围。
 * @param {{entry:import('./archive-types.js').ArchiveEntry,events:import('./archive-types.js').SessionEvent[]}} input */
export function verifySourceText({ entry, events }) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const { toolNames } = collectProvenance(events);
  let verbatimSegmentsVerified = 0; let projectedSegmentsVerified = 0; let projectedSegmentsSkipped = 0; let nonTextSegmentsSkipped = 0;
  // 独立读取原始字段，避免归档解析器和预期值共享同一个错误。
  for (const seq of entry.sourceSeqs) {
    const event = bySeq.get(seq);
    const data = /** @type {any} */ (event?.data);
    if (event?.type !== "user/message" || (typeof event.surfaceOp === "object" && event.surfaceOp?.op === "replace")) continue;
    const user = data?.role === "user" && Array.isArray(data.content) ? data : data?.message;
    if ((user?.source?.kind === "user" || user?.source?.kind === "runtime-context") && Array.isArray(user.content) &&
        (sourceText(user)?.text !== "") && user.content.some((/** @type {any} */ b) => b?.type === "text" && typeof b.text === "string" && b.text !== "") &&
        !entry.segments.some((s) => s.seq === seq)) throw new Error("source-text-missing");
  }
  for (const segment of entry.segments) {
    const event = bySeq.get(segment.seq);
    const data = /** @type {any} */ (event?.data);
    const message = event?.type === "user/message" && data?.role === "user" && Array.isArray(data.content) ? data : data?.message;
    if (!Array.isArray(message?.content)) throw new Error("source-text-missing");
    const name = toolNames.get(message.toolCallId ?? message.source?.callId) ?? data?.name ?? message.source?.name;
    if (name === "run_code") { projectedSegmentsSkipped++; continue; }
    const expected = sourceText(message);
    if (expected === null) { nonTextSegmentsSkipped++; continue; }
    if (expected.text !== segment.text) throw new Error("source-text-mismatch");
    if (expected.projected) projectedSegmentsVerified++;
    else verbatimSegmentsVerified++;
  }
  return { verbatimSegmentsVerified, projectedSegmentsVerified, projectedSegmentsSkipped, nonTextSegmentsSkipped };
}
