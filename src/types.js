/**
 * 宿主接口的最小类型占位。
 *
 * 这里**不复制** `@deepseek-ai/dsh-*` 的完整声明——宿主版本变化时副本会过期，
 * 而且 peer 依赖在开发期可能解析不到。只声明本项目实际用到的表面，
 * 由 `host-adapter.js` 集中承担适配职责。
 *
 * 完整契约见宿主 @deepseek-ai/dsh-* 的类型声明。
 * @module dsh-smart-context/types
 */

/**
 * 宿主注入的日志接口。
 * @typedef {object} Logger
 * @property {(message: string) => void} info
 * @property {(message: string) => void} warn
 * @property {(message: string) => void} error
 */

/**
 * 消息内容块（只声明本项目会读写的两种）。
 * @typedef {{ type: 'text', text: string }} TextBlock
 * @typedef {TextBlock | { type: string }} ContentBlock
 */

/**
 * 工具执行上下文。
 * @typedef {object} ToolRunContext
 * @property {AbortSignal} [signal]
 * @property {{ id: string }} [agent] - 当前会话身份（`exec.agent.id` 是 SessionId）
 * @property {string} [callId]
 * @property {string} [rootCallId]
 * @property {string} [name]
 */

/** @typedef {(args: unknown, exec: ToolRunContext, value: unknown) => void} ToolObserver */

/**
 * 工具定义。字段与约束见 compatibility.md §3。
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters - 原始 JSON Schema
 * @property {{ schema: Record<string, unknown>, render: (args: unknown, value: unknown) => ContentBlock[] }} output
 * @property {(args: unknown, exec: ToolRunContext) => Promise<unknown>} execute
 */

/**
 * 会话查询服务（`ctx.sessionQuery`）。
 * @typedef {object} SessionQueryService
 * @property {(sessionId: string) => Promise<{ session: unknown, inheritedEventCount: number, events: import('./archive-types.js').SessionEvent[] }>} readSession
 */

/**
 * 工具注册服务（`ctx.tools`）。
 * @typedef {object} ToolsService
 * @property {(definition: ToolDefinition) => () => void} register
 */

/**
 * 系统提示服务（`ctx.systemPrompt`）。
 *
 * `context()` 把内容作为**一条消息追加到对话末尾**，系统提示本身不变——
 * 这是缓存友好的尾部快照通道。见 compatibility.md §7.8。
 *
 * @typedef {object} SystemPromptService
 * @property {(context: { name: string, order: number, text: (context?: { agent?: { id: string }, session?: { id: string }, sessionId?: string }) => string, interpolate?: boolean }) => () => void} context
 * @property {(section: { name: string, order: number, text: (context?: { agent?: { id: string }, session?: { id: string }, sessionId?: string }) => string, interpolate?: boolean, complete?: boolean }) => () => void} section
 *
 * `section` 把内容并入**系统提示**（请求最前面），`context` 追加到
 * **对话尾部的 runtime-context 消息**。两者签名几乎一样，区别只在落点。
 *
 * `section` 多一个 `complete` 字段（独占整个系统提示），本项目不用——
 * 宿主限制「同时最多一个 complete section」，用了会抛错。
 *
 * 实测依据：`dsh-ops` 用 `ctx.systemPrompt.section({ name, order, interpolate, text })`
 * 注入工具策略段（order 3250/3252），见其 `lib/index.js` 与 `lib/ptc/index.js`。
 */

/**
 * 插件上下文（只声明本项目用到的部分）。
 * @typedef {object} PluginContext
 * @property {Logger} logger
 * @property {ToolsService} [tools]
 * @property {SessionQueryService} [sessionQuery]
 * @property {SystemPromptService} [systemPrompt]
 * @property {(event: string, listener: (...args: any[]) => void) => () => void} [on]
 */

export {};
