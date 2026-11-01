/** 当前会话归档插件。只读宿主事件，目录经尾部 context 通道追加。 */
import { extractArchives } from "./archive.js";
import { renderCatalog } from "./directory.js";
import { CATALOG_HINT, shouldShowHint } from "./hint.js";
import { presentationMode, readSessionEvents, resolveDataRoot, workspaceKey } from "./host-adapter.js";
import { sessionDir } from "./store.js";
import { syncIndex } from "./sync.js";
import { createOpenTool, createSearchTool } from "./tools.js";
import { safeErrorCode } from "./logging.js";
import { createDiagnostics } from "./diagnostics.js";
import { waitFor } from "./cancellation.js";

export const PLUGIN_NAME = "dsh-smart-context";
export const inject = ["tools", "sessionQuery", "systemPrompt"];
const CATALOG_CACHE_MS = 30_000;

/** @typedef {{ entries: import('./archive-types.js').ArchiveEntry[], unresolvedArchives: number, catalog: string, catalogStatus: 'loading' | 'ready' | 'failed', refreshedAt: number, dirty: boolean, pending: Promise<void> | null }} State */

/**
 * 取目录文本。
 *
 * 仅访问当前会话的状态；身份未知、未加载、读取失败和没有可用目录
 * 分别如实提示，不能回退到其他会话的缓存。
 *
 * @param {Map<string, State>} sessions
 * @param {string} id
 * @returns {string}
 */
function catalogFor(sessions, id) {
  if (id === "") return "归档目录不可用：无法识别当前会话。";
  const state = sessions.get(id);
  if (state === undefined || state.catalogStatus === "loading") return "当前会话归档目录尚未加载。";
  if (state.catalogStatus === "failed") return "归档目录不可用：当前会话记录读取或处理失败。";
  return state.catalog || "当前会话未找到可用的归档目录。";
}

/** @param {any} context @returns {string} */
function sessionIdentity(context) {
  const id = context?.agent?.id ?? context?.session?.id ?? context?.sessionId;
  return typeof id === "string" ? id : "";
}

/** @param {import('./types.js').PluginContext} ctx @param {unknown} _config */
export function apply(ctx, _config) {
  const tools = ctx.tools;
  if (tools === undefined) {
    ctx.logger.warn(`[${PLUGIN_NAME}] ctx.tools 不可用，工具未注册（功能不可用）`);
    return;
  }
  /** @type {Map<string, State>} */ const sessions = new Map();
  const config = /** @type {{ diagnostics?: boolean } | null} */ (_config);
  const diagnostics = config?.diagnostics === true ? createDiagnostics((line) => ctx.logger.info(line)) : undefined;
  /** @type {Array<() => void>} */ const disposers = [];
  let active = true;
  const lifetime = new AbortController();
  const cleanup = () => {
    active = false;
    lifetime.abort();
    for (const dispose of disposers.splice(0).reverse()) {
      try { dispose(); } catch { /* 继续清理剩余资源。 */ }
    }
    sessions.clear();
    diagnostics?.clear();
  };
  /** @param {string} id */
  function stateOf(id) {
    let state = sessions.get(id);
    if (state === undefined) {
      state = { entries: [], unresolvedArchives: 0, catalog: "", catalogStatus: "loading", refreshedAt: 0, dirty: false, pending: null };
      sessions.set(id, state);
    }
    return state;
  }
  /** @param {string} id @param {boolean} [dirty] @param {AbortSignal} [signal] @param {boolean} [allowCached] */
  async function refresh(id, dirty = false, signal, allowCached = false) {
    lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    const state = stateOf(id);
    if (dirty) {
      state.dirty = true;
      state.catalogStatus = "loading";
    }
    const age = Date.now() - state.refreshedAt;
    if (allowCached && !dirty && !state.dirty && state.pending === null && state.catalogStatus === "ready" && age >= 0 && age < CATALOG_CACHE_MS) return state.entries;
    if (state.pending === null) {
      state.catalogStatus = "loading";
      state.pending = (async () => {
        try {
          do {
            state.dirty = false;
            const snapshot = await readSessionEvents(ctx, id);
            if (!active) return;
            if (state.dirty) continue;
            const { entries, unresolvedArchives } = extractArchives({ sessionId: id, events: snapshot.events });
            state.entries = entries;
            state.unresolvedArchives = unresolvedArchives;
            state.catalog = renderCatalog({ entries, unresolvedArchives });
            state.catalogStatus = "ready";
            state.refreshedAt = Date.now();
            if (unresolvedArchives === 0) {
              try {
                const header = /** @type {{ cwd?: string }} */ (snapshot.header ?? {});
                const dir = sessionDir(resolveDataRoot(), workspaceKey(header.cwd), id);
                const result = syncIndex({ dir, sessionId: id, events: snapshot.events });
                if (result.problem !== null) ctx.logger.warn(`[${PLUGIN_NAME}] 索引同步问题：INDEX_IO`);
              } catch (error) {
                ctx.logger.warn(`[${PLUGIN_NAME}] 索引同步失败：${safeErrorCode(error)}`);
              }
            }
          } while (active && state.dirty);
        } catch (error) {
          state.catalog = "";
          state.catalogStatus = "failed";
          throw error;
        }
      })().finally(() => { state.pending = null; });
    }
    await waitFor(state.pending, signal, lifetime.signal);
    // 事件可能在读取循环退出后、pending 的 finally 清理前到达。
    // 此时它只能标记 dirty 并等待旧 Promise；清理后必须再补读。
    if (active && state.dirty) return refresh(id, false, signal, allowCached);
    return active ? state.entries : [];
  }
  /** @param {string} id */
  async function observedRefresh(id) {
    try { await refresh(id, true); }
    catch (error) { if (!lifetime.signal.aborted) ctx.logger.warn(`[${PLUGIN_NAME}] 刷新失败：${safeErrorCode(error)}`); }
  }
  const mode = presentationMode(ctx);
  try {
    const load = async (/** @type {{ sessionId: string, signal?: AbortSignal }} */ args) => {
      const entries = await refresh(args.sessionId, false, args.signal);
      return { entries, unresolvedArchives: stateOf(args.sessionId).unresolvedArchives };
    };
    disposers.push(tools.register(createSearchTool({ loadEntries: load, observe: diagnostics?.tool })));
    disposers.push(tools.register(createOpenTool({ loadEntries: load, observe: diagnostics?.tool })));
  } catch (error) {
    cleanup();
    const message = error instanceof Error ? error.message : String(error);
    if (/already|exist|duplicate/i.test(message)) ctx.logger.info(`[${PLUGIN_NAME}] 工具冲突，回滚并跳过`);
    else ctx.logger.error(`[${PLUGIN_NAME}] 注册工具失败：${safeErrorCode(error)}`);
    return;
  }
  try {
    const prompt = ctx.systemPrompt;
    if (prompt !== undefined) {
      // ① 系统提示里的常驻提示：让模型知道「可以查」。
      //    内容完全静态，不随会话变化——系统提示改一个字节就是全量
      //    前缀缓存失效，动态信息全部留给下面的 runtime-context 目录。
      //
      // **section 可能不存在**：老版本宿主只提供 context。缺了就跳过，
      // 不能让它影响工具注册和目录注入——提示是增强，不是必需。
      if (shouldShowHint() && typeof prompt.section === "function") {
        try {
          disposers.push(prompt.section({
            name: "smart-context-hint",
            order: 3300,
            interpolate: false,
            text: () => CATALOG_HINT,
          }));
        } catch (error) {
          ctx.logger.warn(`[${PLUGIN_NAME}] 系统提示段注册失败：${safeErrorCode(error)}`);
        }
      } else if (typeof prompt.section !== "function") {
        ctx.logger.warn(`[${PLUGIN_NAME}] ctx.systemPrompt.section 不可用，提示段未注入`);
      }
      // ② runtime context 里的动态目录：告诉模型「有哪些」。
      disposers.push(prompt.context({
        name: "smart-context", order: 900, interpolate: false,
        // rc.3 的 agent 组装上下文包含 agent；缺少身份时明确提示。
        // 宿主在准备请求时可能再次求值，必须始终读取当前会话的最新状态。
        text: (context) => catalogFor(sessions, sessionIdentity(context)),
      }));
    } else ctx.logger.warn(`[${PLUGIN_NAME}] ctx.systemPrompt 不可用，目录未注入`);
    if (ctx.on !== undefined) {
      disposers.push(ctx.on("agent/created", async (payload) => {
        const id = sessionIdentity(payload);
        if (id !== "") await observedRefresh(id);
      }));
      disposers.push(ctx.on("session/event", (session, event) => {
        const id = typeof session?.id === "string" ? session.id : "";
        if (diagnostics && event?.type === "assistant/message" && event?.data?.usage) {
          try { diagnostics.usage(id, event.data.usage); } catch { /* 只读诊断。 */ }
        }
        // **只有能改变归档集合的事件才触发全量重读。**
        //
        // 归档的唯一来源是「带 surfaceOp 对象的替换事件」（见 archive.js 的
        // classifyReplacement）；compaction/* 是事务标记。其余事件——包括
        // assistant/message、tool/result、user/message 的 append —— 都不产生
        // 归档，为它们重读整份会话是纯浪费。
        //
        // 实测（2026-10-30，6785 事件会话）：旧过滤条件触发 1554 次刷新，
        // 真正必要的是 32 次——多做了 48 倍无用功，每次约 185ms CPU。
        const isReplace = event?.surfaceOp !== null && typeof event?.surfaceOp === "object";
        const isCompaction = String(event?.type ?? "").startsWith("compaction/");
        if (id !== "" && (isReplace || isCompaction)) {
          void observedRefresh(id);
        }
      }));
      if (diagnostics) {
        disposers.push(ctx.on("tools/result", (exec, result) => {
          try { diagnostics.final(exec, result); } catch { /* 只读诊断。 */ }
        }));
        disposers.push(ctx.on("llm/stream", (options, next) => {
          try { diagnostics.request(options); } catch { ctx.logger.warn(`[${PLUGIN_NAME}] 请求诊断失败：AUDIT_UNAVAILABLE`); }
          return next();
        }));
      }
      // Providers 已求值；只替换自身已注册的 context，保留抑制设置及其他顺序。
      disposers.push(ctx.on("system-prompt/assemble", async (assembly, context, next) => {
        const id = sessionIdentity(context);
        context?.signal?.throwIfAborted();
        lifetime.signal.throwIfAborted();
        if (id !== "") {
          try { await refresh(id, false, context?.signal, true); }
          catch (error) {
            if (context?.signal?.aborted || lifetime.signal.aborted) throw error;
            ctx.logger.warn(`[${PLUGIN_NAME}] 刷新失败：${safeErrorCode(error)}`);
          }
        }
        context?.signal?.throwIfAborted();
        lifetime.signal.throwIfAborted();
        if (active && Array.isArray(assembly?.contexts)) {
          const own = assembly.contexts.find((/** @type {any} */ c) => c.name === "smart-context");
          if (own !== undefined) own.text = catalogFor(sessions, id);
        }
        return next();
      }));
    }
  } catch (error) {
    cleanup();
    ctx.logger.error(`[${PLUGIN_NAME}] 目录或监听注册失败：${safeErrorCode(error)}`);
    return;
  }
  ctx.logger.info(`[${PLUGIN_NAME}] 已注册 memory_search / memory_open + 目录（呈现模式：${mode}）`);
  return cleanup;
}
