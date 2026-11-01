import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";

/** 外部宿主边界替身；真实解析、搜索、分页和磁盘索引均不替换。
 * @param {import('node:test').TestContext} t
 * @param {(id: string) => Promise<any>} read
 */
export function host(t, read) {
  const root = mkdtempSync(join(tmpdir(), "dsh-gpt-test-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {Map<string, Function>} */ const events = new Map();
  /** @type {string[]} */ const logs = [];
  /** @type {any} */ let prompt;
  /** @type {any} */ const ctx = {
    logger: { info: (/** @type {string} */ m) => logs.push(m), warn: (/** @type {string} */ m) => logs.push(m), error: (/** @type {string} */ m) => logs.push(m) },
    tools: { register: (/** @type {any} */ d) => { tools.set(d.name, d); return () => tools.delete(d.name); } },
    sessionQuery: { readSession: read },
    systemPrompt: { context: (/** @type {any} */ c) => { prompt = c; return () => { prompt = undefined; }; } },
    on: (/** @type {string} */ name, /** @type {Function} */ fn) => { events.set(name, fn); return () => events.delete(name); },
  };
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("dsh-gpt-test-")) throw new Error("unsafe test cleanup");
    rmSync(target, { recursive: true, force: true });
  });
  return { ctx, tools, events, logs, text: (/** @type {string} */ id) => prompt?.text({ agent: { id } }) ?? "",
    async assemble(/** @type {string} */ id) {
      const context = { agent: { id } };
      const assembly = { sections: [], contexts: prompt ? [{ name: prompt.name, text: prompt.text(context) }] : [], tools: [], variables: {} };
      const listener = events.get("system-prompt/assemble");
      return listener ? listener(assembly, context, async () => assembly) : assembly;
    },
  };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
