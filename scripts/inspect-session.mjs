/**
 * inspect-session.mjs —— 会话日志结构速览
 *
 * 用途：读取一个 DSH 会话日志（.jsonl 或 .jsonl.zstd），输出事件计数统计，
 * 用于确认日志格式、排查「为什么这个会话没有归档」。
 *
 * 用法：
 *   node scripts/inspect-session.mjs <会话日志路径>
 *
 * 安全说明：
 *   - 只读。不修改任何文件。
 *   - 不输出原文内容、不输出请求配置、不输出密钥。
 *   - 只打印事件数量、类型分布等计数信息。
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { safeErrorCode } from "../src/logging.js";

try {
  const file = process.argv[2];
  if (!file) throw new Error("missing input");
  const bytes = readFileSync(file);
  const text = /\.zst(?:d)?$/i.test(file) ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
  const events = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const summary = { events: events.length, requests: 0, toolResults: 0, summaries: 0, prunes: 0,
    usageCalls: 0, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
    usageFieldCalls: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  for (const event of events) {
    if (event.type === "request/header") summary.requests++;
    if (event.type === "tool/result") summary.toolResults++;
    if (event.type === "compaction/summary") summary.summaries++;
    if (event.type === "compaction/prune") summary.prunes++;
    if (event.type === "assistant/message" && event.data?.usage) {
      summary.usageCalls++;
      for (const key of Object.keys(summary.usage)) {
        const value = event.data.usage[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          summary.usage[key] = (summary.usage[key] ?? 0) + value;
          summary.usageFieldCalls[key]++;
        }
      }
    }
  }
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(JSON.stringify({ error: safeErrorCode(error) }));
  process.exitCode = 1;
}
