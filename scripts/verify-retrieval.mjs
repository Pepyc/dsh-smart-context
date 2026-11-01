/**
 * verify-retrieval.mjs —— 端到端检索验证（离线）
 *
 * 用途：给定一个真实会话日志和若干关键词，验证「搜索 → 打开 → 翻页」
 * 整条链路能正确还原原文。同时用独立路径核对来源文本，不依赖归档解析器
 * 生成预期值。
 *
 * 用法：
 *   node scripts/verify-retrieval.mjs <会话日志路径> <关键词>
 *   node scripts/verify-retrieval.mjs --synthetic        # 用内置合成样本
 *
 * 安全说明：
 *   - 只读会话日志，不修改。
 *   - 不发送任何模型请求（输出里会标 modelRequestObserved=false）。
 *   - 默认不打印原文，只打印校验结果与统计。
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { extractArchives } from "../src/archive.js";
import { createOpenTool, createSearchTool } from "../src/tools.js";
import { fingerprint } from "../src/identity.js";
import { safeErrorCode } from "../src/logging.js";
import { verifySourceText } from "../src/source-verification.js";
import { compactionSession } from "../test/fixtures/compaction-sample.js";

try {
  const file = process.argv[2];
  let events = compactionSession();
  if (file && file !== "--synthetic") {
    const bytes = readFileSync(file);
    const raw = /\.zst(?:d)?$/i.test(file) ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
    events = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  const entries = extractArchives({ sessionId: "offline-validation", events }).entries;
  const loadEntries = async () => entries;
  const search = createSearchTool({ loadEntries });
  const open = createOpenTool({ loadEntries });
  const exec = { agent: { id: "offline-validation" } };
  const query = process.argv[3] ?? "P0-01";
  const found = await search.execute({ query }, exec);
  const visibleSearch = JSON.parse(search.output.render({}, found)[0].text);
  if (fingerprint(found) !== fingerprint(visibleSearch)) throw new Error("search projection mismatch");
  const hit = visibleSearch.hits[0];
  if (!hit) throw new Error("no matching archive");
  let cursor; let chars = 0; let pages = 0; let reconstructed = "";
  do {
    const page = await open.execute({ id: hit.id, cursor }, exec);
    // 必须检查 open 的本页，不检查 search 的返回来替代。
    const visible = JSON.parse(open.output.render({}, page)[0].text);
    if (fingerprint(page) !== fingerprint(visible) || visible.status !== "ok") throw new Error("open projection mismatch");
    chars += visible.range.returnedChars;
    reconstructed += visible.parts.map((part) => part.text).join("");
    cursor = visible.nextCursor;
    if (++pages > 10000) throw new Error("pagination did not terminate");
  } while (cursor);
  const original = entries.find((e) => e.id === hit.id);
  if (chars !== original.length || fingerprint(reconstructed) !== fingerprint(original.segments.map((part) => part.text).join(""))) throw new Error("pagination content mismatch");
  const sourceChecks = verifySourceText({ entry: original, events });
  console.log(JSON.stringify({ boundary: "offline-render-validation", archives: entries.length,
    searchStatus: visibleSearch.status, hits: visibleSearch.hits.length, pages, returnedChars: chars,
    searchRenderMatches: true, openRenderMatches: true, ...sourceChecks,
    sourceCoverage: "opened-archive-text-only-non-PTC-segments", integrity: hit.integrity, modelRequestObserved: false }));
} catch (error) {
  console.error(JSON.stringify({ error: safeErrorCode(error), boundary: "offline-render-validation" }));
  process.exitCode = 1;
}
