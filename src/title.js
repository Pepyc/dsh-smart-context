/**
 * 从片段内容里提取有信息量的标题。
 *
 * **为什么单独成模块**：标题逻辑与归档解析解耦，便于独立测试与回滚。
 *
 * ## 要解决的问题（实测 2026-10-30）
 *
 * 真实会话 13 条归档里，12 条 prune 归档的标题是这些：
 *
 * ```text
 * "1: #include \"sim/match_clock.hpp\""   ← 代码行号
 * "{"                                    ← 一个左大括号
 * "TOTAL 275"                            ← 统计尾行
 * "M-?M-CM-?M-CM-?..."                   ← 乱码
 * "1: // ==============================" ← 分隔线
 * ```
 *
 * 这些**不是「选错片段」，是「唯一片段本身没信息」**。无论怎么挑，`"{"` 都当不了标题。
 *
 * ## 两层处理
 *
 * **第一层：跳过无信息片段**——纯分隔线、太短、纯标点、乱码、系统注入。
 * **第二层：按内容形态提取**——文件读取取文件名、JSON 取键名、git status 取摘要。
 *
 * ## 确定性
 *
 * 标题会进目录，而**目录必须逐字节确定**（宿主靠文本比较决定是否重发）。
 * 所以这里**不依赖时间、不依赖外部状态**，同样输入永远同样输出。
 * @module dsh-smart-context/title
 */

import { safeEnd } from "./unicode.js";

/** 标题最大字符数。 */
export const MAX_TITLE_CHARS = 60;

/**
 * 太短的片段没有信息量（`{`、`}`、`[]`、`ok` 等）。
 *
 * **中英文阈值必须不同**：7 个中文字符是有意义的句子（「我先读一下文档」），
 * 但 7 个 ASCII 字符可能只是 `TOTAL 2` 或 `M x.txt`。所以先判断是否含中文。
 */
const MIN_USEFUL_ASCII = 8;
const MIN_USEFUL_CJK = 4;

/**
 * 判断一段文本是否**没有**作为标题的价值。
 *
 * @param {string} text
 * @returns {boolean} `true` 表示应跳过
 */
export function isUselessTitle(text) {
  const t = text.trim();
  const hasCjk = /[\u4e00-\u9fa5]/.test(t);
  const minChars = hasCjk ? MIN_USEFUL_CJK : MIN_USEFUL_ASCII;
  if (t.length < minChars) return true;

  // 纯分隔线：`====`、`----`、`####`、`****`、`____`
  //
  // 要剥掉两层前缀：行号 `1: ` 和注释符号 `// ` / `# ` / `* `。
  // 实测真实数据里大量 `1: // =====...` 是代码文件的分隔注释，
  // 只剥行号会漏掉它们。
  const core = t
    .replace(/^[\d\s:.]+/, "")      // 行号 `1: `
    .replace(/^(?:\/\/|\/\*|#\s|--|\*\s)\s*/, "") // 注释符（`#` 需后跟空格）
    .replace(/\*\/$/, "");           // 块注释结尾
  if (core.length > 0 && /^[=\-#*_~+]{4,}$/.test(core)) return true;

  // 纯标点 / 纯括号
  if (/^[\s{}\[\](),;:.!?'"`<>|\\/]+$/.test(t)) return true;

  // 含 Unicode 替换字符或明显的编码损坏（`M-?M-C`）
  if (/\uFFFD/.test(t)) return true;
  if (/^(M-\?|M-C[A-Z]?|[?\u00C0-\u00FF]{4,})/.test(t) && !/[\u4e00-\u9fa5]/.test(t)) return true;

  // 系统注入的上下文，不是用户说的话
  if (/^<(system-reminder|environment_context|user_info|runtime-context)\b/i.test(t)) return true;

  return false;
}

/**
 * 按内容形态提取标题。
 *
 * 每种形态只取**最能说明这是什么**的部分，不是简单截取前 N 字符。
 *
 * @param {string} text
 * @returns {string | null} 提取失败返回 `null`，交给上层兜底
 */
export function extractByShape(text) {
  const t = text.trim();

  // 形态 1：带 `=== 路径 ===` 或 `===== 路径 (N lines) =====` 的头
  const banner = /^=+\s*(.+?)\s*(?:\(\s*\d+\s*lines?\s*\))?\s*=+$/m.exec(t);
  if (banner?.[1]) {
    const p = banner[1].trim();
    if (p !== "" && !isUselessTitle(p)) return shortenPath(p);
  }

  // 形态 2：文件读取的行号格式 `1: 内容` / `123: 内容`
  //
  // **逐行扫描，跳过无用行**：代码文件开头常是分隔线注释
  // （`1: // =====`），第 2 行才是真正的文件说明。只取第一行会落空。
  const numberedLines = t.split("\n").filter((l) => /^\s*\d+:\s*\S/.test(l));
  for (const line of numberedLines) {
    const content = line.replace(/^\s*\d+:\s*/, "").trim();
    // `#include "path"` → 取路径最后两段
    const inc = /#include\s*[<"]([^>"]+)[>"]/.exec(content);
    if (inc?.[1]) return shortenPath(inc[1]);
    // 分隔线注释，跳过继续找
    if (/^(?:\/\/|\/\*|#\s|--|\*\s)\s*[=\-*#_~+]{4,}/.test(content)) continue;
    // 剥掉注释符号再判断
    //
    // **`#` 只在后跟空格时才算注释**：`#pragma once` 是 C 预处理指令。
    const stripped = content.replace(/^(?:\/\/|\/\*|#\s|--|\*\s)\s*/, "").trim();
    if (stripped !== "" && !isUselessTitle(stripped)) return stripped;
  }

  // 形态 3：git status 风格（`M path` / `?? path` / `A path`）
  const gitLines = t.split("\n").filter((l) => /^\s*(?:[MADRCU?!]{1,2})\s+\S/.test(l));
  if (gitLines.length >= 2) {
    const files = gitLines.length;
    const first = /^\s*[MADRCU?!]{1,2}\s+(\S+)/.exec(gitLines[0] ?? "");
    return first?.[1] ? `git status（${files} 个文件，如 ${first[1]}）` : `git status（${files} 个文件）`;
  }

  // 形态 4：JSON —— 取顶层键名
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const value = JSON.parse(t);
      if (Array.isArray(value)) return `JSON 数组（${value.length} 项）`;
      if (value !== null && typeof value === "object") {
        const keys = Object.keys(value).slice(0, 3);
        if (keys.length > 0) {
          const more = Object.keys(value).length > 3 ? " …" : "";
          return `JSON: ${keys.join(", ")}${more}`;
        }
      }
    } catch {
      // 不是完整 JSON（被裁过），落到兜底
    }
  }

  // 形态 5：代码 —— 取首个有意义的标识符
  const codeLike = /^(?:#include|#pragma|#define|function |const |let |var |class |import |export |package )/m.test(t);
  if (codeLike) {
    const firstMeaningful = t.split("\n").find((l) => {
      const s = l.replace(/^\d+:\s*/, "").trim();
      return s !== "" && !isUselessTitle(s) && !/^\/\//.test(s);
    });
    if (firstMeaningful !== undefined) {
      const s = firstMeaningful.replace(/^\d+:\s*/, "").trim();
      if (!isUselessTitle(s)) return s;
    }
  }

  return null;
}

/**
 * 路径缩短：保留最后两段，避免标题过长。
 *
 * `C:/a/b/c/field.json` → `c/field.json`
 *
 * @param {string} p
 * @returns {string}
 */
function shortenPath(p) {
  const parts = p.split(/[/\\]/).filter((s) => s !== "");
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}

/**
 * 生成标题。
 *
 * 流程：**跳过无用片段 → 按形态提取 → 兜底取首行**。
 *
 * @param {import("./archive-types.js").ArchiveSegment[]} segments
 * @returns {string}
 */
export function deriveTitle(segments) {
  /** @type {import("./archive-types.js").ArchiveSegment | undefined} */
  let source;

  // 优先级：真实用户消息 > 助手消息 > 任意非工具 > 兜底
  source = segments.find((s) => s.role === "user" && s.sourceKind !== "runtime-context");
  if (source === undefined) source = segments.find((s) => s.role === "assistant");
  if (source === undefined) source = segments.find((s) => s.role !== "tool");
  if (source === undefined) source = segments.at(0);
  if (source === undefined) return "(空)";

  // 第二层：按形态提取
  const extracted = extractByShape(source.text);
  if (extracted !== null && !isUselessTitle(extracted)) return clamp(extracted);

  // 兜底：首个有信息量的行
  const line = source.text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !isUselessTitle(l));

  if (line !== undefined) return clamp(line);

  // 真的什么都没有：明确说明，不假装有标题
  return "(无可读标题)";
}

/**
 * 截断到标题上限，且不拆开 emoji。
 * @param {string} text
 * @returns {string}
 */
function clamp(text) {
  const t = text.trim();
  if (t.length <= MAX_TITLE_CHARS) return t;
  return `${t.slice(0, safeEnd(t, MAX_TITLE_CHARS))}…`;
}

/**
 * 从 `tool/call` 的调用参数里提取标题补充。
 *
 * **第三层：prune 归档的孤立片段确实没信息，但它来自哪次调用是有记录的。**
 *
 * ```text
 * tool/call: { name: "read", arguments: '{"path":".../field.json"}' }
 *    ↓ toolCallId 关联
 * tool/result: { name: "read", content: "{" }   ← 孤立看毫无意义
 * ```
 *
 * 用调用参数补充后：`read: field.json` 比 `{` 好得多。
 *
 * **只读宿主记录的调用元数据，不读正文**，所以不受内容形态影响。
 *
 * @param {Map<string, string>} toolNames - callId → 工具名
 * @param {Map<number, import("./archive-types.js").SessionEvent>} bySeq
 * @param {import("./archive-types.js").ArchiveSegment[]} segments
 * @returns {string | null} 提取失败返回 `null`
 */
export function titleFromCallArguments(toolNames, bySeq, segments) {
  const toolSeg = segments.find((s) => s.role === "tool" && typeof s.toolCallId === "string");
  if (toolSeg?.toolCallId === undefined) return null;

  for (const event of bySeq.values()) {
    if (event.type !== "tool/call") continue;
    const data = /** @type {any} */ (event.data);
    if (data?.callId !== toolSeg.toolCallId) continue;

    const name = toolNames.get(toolSeg.toolCallId) ?? data?.name;
    if (typeof name !== "string" || name === "") return null;

    let args = data?.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = undefined; }
    }
    if (args === null || typeof args !== "object") return clamp(name);

    // 挑最有辨识度的参数：路径类优先
    const a = /** @type {Record<string, unknown>} */ (args);
    for (const key of ["path", "file_path", "filePath", "pattern", "glob", "command", "query", "url"]) {
      const v = a[key];
      if (typeof v !== "string" || v.trim() === "") continue;
      const short = shortenForTitle(v);
      if (short !== "") return clamp(`${name}: ${short}`);
    }
    return clamp(name);
  }
  return null;
}

/**
 * 把参数值压成短标题片段。
 *
 * `E:/project/docs/guides/Steps.md` → `guides/Steps.md`
 *
 * @param {string} value
 * @returns {string}
 */
function shortenForTitle(value) {
  let v = value.trim().replace(/\s+/g, " ");
  if (/[\\/]/.test(v) && v.length > 30) {
    const parts = v.split(/[\\/]/).filter((s) => s !== "");
    if (parts.length > 2) v = parts.slice(-2).join("/");
  }
  return v.length > 40 ? `${v.slice(0, safeEnd(v, 40))}…` : v;
}

