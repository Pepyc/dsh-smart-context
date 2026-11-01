/**
 * 宿主适配层：把所有 DSH 相关的东西集中在这里。
 *
 * **为什么单独一层**：宿主版本一变，接口就可能变。核心逻辑
 * （archive / store / sync / search / pagination）都不接触 `ctx`，
 * 所以只需改这一个文件就能跟上宿主变化。
 *
 * 四组能力：
 * 1. 会话读取 —— `ctx.sessionQuery.readSession`
 * 2. 呈现模式 —— `ctx.tools` 的 mode
 * 3. 裁剪检测 —— 已在 `pagination.js`，此处只做转发
 * 4. 数据根路径 —— `dsh-home-paths`，不硬编码
 * @module dsh-smart-context/host-adapter
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { safeErrorCode } from "./logging.js";

export class SourceUnavailableError extends Error {
  constructor() { super("会话原始事件暂不可读取，请检查源日志后重试。"); this.name = "SourceUnavailableError"; }
}

/**
 * 读取一个会话的完整原始事件。
 *
 * 用 `ctx.sessionQuery.readSession`，**不用已 deprecated 的
 * `session.eventAt()` / `snapshotEvents()` / `ownEvents()`**。
 *
 * @param {import("./types.js").PluginContext} ctx
 * @param {string} sessionId
 * @returns {Promise<{ events: import("./archive-types.js").SessionEvent[], header: unknown }>}
 */
export async function readSessionEvents(ctx, sessionId) {
  const query = ctx.sessionQuery;
  if (query === undefined || typeof query.readSession !== "function") {
    ctx.logger.warn("[dsh-smart-context] ctx.sessionQuery 不可用，无法读取会话");
    throw new SourceUnavailableError();
  }
  try {
    const snapshot = await query.readSession(sessionId);
    return { events: snapshot.events, header: snapshot.session };
  } catch (error) {
    ctx.logger.warn(`[dsh-smart-context] 读取会话失败：${safeErrorCode(error)}`);
    throw new SourceUnavailableError();
  }
}

/**
 * 解析插件数据根目录。
 *
 * 优先用宿主提供的 `dsh-home-paths`；拿不到时回落到 `~/.dsh`。
 * **绝不硬编码绝对路径**——那是别人机器上的路径。
 *
 * @returns {string}
 */
export function resolveDataRoot() {
  const home = process.env.DSH_HOME;
  const base = typeof home === "string" && home.trim() !== "" ? home : join(homedir(), ".dsh");
  return join(base, "smart-context");
}

/**
 * 从工作目录生成稳定的目录名。
 *
 * 与 DSH 自己的 `--E-Codex-foo--` 风格一致：非字母数字替换成 `-`。
 *
 * @param {string | undefined} cwd
 * @returns {string}
 */
export function workspaceKey(cwd) {
  if (typeof cwd !== "string" || cwd === "") return "unknown-workspace";
  return `--${cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}--`;
}

/**
 * 判断当前作用域的工具呈现模式。
 *
 * PTC 模式下模型只能直接调 `run_code`；native 模式下可以直调。
 * 本项目不主动切换模式，只用于日志与诊断。
 *
 * @param {import("./types.js").PluginContext} ctx
 * @returns {'ptc' | 'native' | 'unknown'}
 */
export function presentationMode(ctx) {
  const tools = ctx.tools;
  if (tools === undefined) return "unknown";
  const mode = /** @type {any} */ (tools).defaultMode ?? /** @type {any} */ (tools).mode;
  return mode === "ptc" || mode === "native" ? mode : "unknown";
}

/**
 * 把 `ContentBlock[]` 折成纯文本，供工具 render 使用。
 *
 * @param {import("./archive-types.js").ArchiveSegment[]} segments
 * @returns {string}
 */
export function segmentsToText(segments) {
  return segments.map((s) => s.text).join("\n\n");
}
