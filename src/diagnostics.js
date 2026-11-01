import { fingerprint, valueFingerprint } from "./identity.js";
import { looksLikeRetrievalResponse, MEMORY_TOOLS } from "./provenance.js";

/** @param {any} content */
function textOf(content) {
  return Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
}

/** 从原生 JSON 或 PTC logs/result 中收集完整返回值的指纹。
 * @param {string} text */
function payloadHashes(text) {
  const hashes = new Set();
  let remainingParseChars = 1_000_000;
  /** 只接受独占完整行或完整连续多行的 JSON；限制工作量，避免诊断拖住请求。
   * @param {string} input @param {number} depth */
  const visitLines = (input, depth) => {
    const lines = input.split(/\r?\n/);
    for (let i = 0; i < lines.length && remainingParseChars > 0; i++) {
      let candidate = lines[i] ?? "";
      const first = candidate.trimStart()[0];
      if (first !== "{" && first !== "[" && first !== '"') continue;
      for (let j = i; j < lines.length && j < i + 512; j++) {
        if (j > i) candidate += `\n${lines[j] ?? ""}`;
        if (candidate.length > 32768 || candidate.length > remainingParseChars) break;
        remainingParseChars -= candidate.length;
        try { visit(JSON.parse(candidate), depth + 1); i = j; break; }
        catch { if (first === '"') break; }
      }
    }
  };
  /** @param {any} value @param {number} depth */
  const visit = (value, depth) => {
    if (depth > 8) return;
    if (typeof value === "string") {
      try { visit(JSON.parse(value), depth + 1); }
      catch { if (value.includes("\n")) visitLines(value, depth); }
    } else if (value !== null && typeof value === "object") {
      if (looksLikeRetrievalResponse(value)) hashes.add(valueFingerprint(value));
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  };
  visit(text, 0);
  return hashes;
}

/** 默认关闭的结构诊断。只记录固定字段、计数与指纹，不记录原文或配置。
 * @param {(line: string) => void} log */
export function createDiagnostics(log) {
  /** @type {Map<string, any>} */ const recent = new Map();
  /** @type {Map<string, string[]>} */ const previous = new Map();
  let sequence = 0;
  /** @param {object} value */
  const emit = (value) => { try { log(`[smart-context:audit] ${JSON.stringify(value)}`); } catch { /* 诊断不改变主流程。 */ } };
  return {
    /** @param {unknown} args @param {import('./types.js').ToolRunContext} exec @param {any} value */
    tool(args, exec, value) {
      const tool = Array.isArray(value.parts) ? "memory_open" : "memory_search";
      const id = exec.callId ?? `unattributed-${++sequence}`;
      const root = exec.rootCallId ?? id;
      const scope = fingerprint(exec.agent?.id ?? "");
      const key = `${scope}|${id}`;
      const record = { tool, id, root, scope, responseHash: fingerprint(value), responseValueHash: valueFingerprint(value), renderHash: fingerprint(JSON.stringify(value)),
        responseChars: JSON.stringify(value).length, status: typeof value.status === "string" ? value.status : "unknown" };
      recent.set(key, record);
      while (recent.size > 32) recent.delete(recent.keys().next().value ?? "");
      emit({ stage: "tool-return", tool, call: fingerprint(id), root: fingerprint(root), scope,
        responseHash: record.responseHash, responseValueHash: record.responseValueHash, renderHash: record.renderHash, responseChars: record.responseChars,
        status: record.status, hits: Array.isArray(value.hits) ? value.hits.length : undefined,
        returnedChars: value.range?.returnedChars, hasNextCursor: typeof value.nextCursor === "string" });
    },
    /** @param {any} exec @param {any} result */
    final(exec, result) {
      if (!MEMORY_TOOLS.has(exec?.name) && exec?.name !== "run_code") return;
      const scope = fingerprint(exec.agent?.id ?? "");
      const matches = [...recent.values()].filter((r) => r.scope === scope &&
        (r.id === exec.callId || r.root === exec.callId));
      if (matches.length === 0) return;
      const content = textOf(result?.content);
      for (const record of matches) record.finalHash = fingerprint(content);
      emit({ stage: "tool-final", scope, call: fingerprint(exec.callId ?? ""),
        contentHash: fingerprint(content), contentChars: content.length, isError: result?.isError === true,
        canonicalMatches: matches.some((r) => payloadHashes(content).has(r.responseValueHash)) });
    },
    /** @param {any} options */
    request(options) {
      const messages = Array.isArray(options?.messages) ? options.messages : [];
      const attributed = typeof options?.sessionId === "string" && options.sessionId !== "";
      const scope = fingerprint(options?.sessionId ?? "");
      const purpose = options?.purpose === undefined ? "unspecified"
        : options.purpose === "compaction" || options.purpose === "session-title" ? options.purpose : "other";
      const routeAttributed = typeof options?.provider === "string" && options.provider !== "" &&
        typeof options?.model === "string" && options.model !== "";
      const routeHash = routeAttributed ? fingerprint([options.provider, options.model]) : null;
      /** @type {Map<string, { hash: string, payloads: Set<any> }>} */ const results = new Map();
      const pending = new Set(); let unpairedResults = 0;
      /** @type {string[]} */ const hashes = [];
      for (const message of messages) {
        const text = textOf(message.content);
        hashes.push(fingerprint([message.role, message.id, message.toolCallId, message.content]));
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const block of message.content) if (block?.type === "tool-call") pending.add(block.id);
        }
        if (message.role === "tool") {
          if (!pending.delete(message.toolCallId)) unpairedResults++;
          results.set(message.toolCallId, { hash: fingerprint(text), payloads: payloadHashes(text) });
        }
      }
      const retrievals = attributed ? [...recent.values()].filter((r) => r.scope === scope).map((r) => {
        const actual = results.get(r.id) ?? results.get(r.root);
        return { tool: r.tool, call: fingerprint(r.id), root: fingerprint(r.root),
          responseHash: r.responseHash, responseValueHash: r.responseValueHash, finalContentHash: r.finalHash,
          visibility: actual === undefined ? "missing-message" : actual.payloads.has(r.responseValueHash) ? "complete" : "changed-or-partial" };
      }) : [];
      const toolsHash = fingerprint(options?.tools ?? []);
      const contextHash = fingerprint([options?.system, options?.toolHistory, options?.reasoningEffort, options?.temperature, options?.maxTokens, options?.stop]);
      const comparisonKey = attributed && routeAttributed && purpose !== "other" ? `${scope}|${purpose}|${routeHash}|${toolsHash}|${contextHash}` : null;
      const old = comparisonKey === null ? [] : previous.get(comparisonKey) ?? [];
      /** @type {number | null} */ let commonPrefixMessages = comparisonKey === null ? null : 0;
      if (commonPrefixMessages !== null) {
        while (commonPrefixMessages < old.length && hashes[commonPrefixMessages] === old[commonPrefixMessages]) commonPrefixMessages++;
      }
      if (comparisonKey !== null) previous.set(comparisonKey, hashes);
      while (previous.size > 32) previous.delete(previous.keys().next().value ?? "");
      emit({ stage: "model-request", boundary: "llm/stream", scope, attributed, purpose, routeAttributed, routeHash, messages: messages.length,
        requestHash: fingerprint([purpose, routeHash, toolsHash, contextHash, hashes]), toolsHash, contextHash, commonPrefixMessages,
        unpairedResults, pendingCalls: pending.size, retrievals });
    },
    /** @param {string} sessionId @param {any} usage */
    usage(sessionId, usage) {
      const values = Object.fromEntries(["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens"].map((key) => {
        const value = usage?.[key];
        return [key, typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null];
      }));
      emit({ stage: "usage", scope: fingerprint(sessionId), ...values });
    },
    clear() { recent.clear(); previous.clear(); },
  };
}
