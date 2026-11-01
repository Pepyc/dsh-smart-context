/**
 * 插件入口的加载验证。
 *
 * 验证三件事：
 * 1. `apply(ctx)` 在缺 `tools` 时降级为警告，不崩溃；
 * 2. 有 `tools` 时注册两个工具，并返回清理函数；
 * 3. 重复 `apply`（HMR 重载）不抛错。
 *
 * 依据：插件接入宿主的验收要求。
 * @module dsh-smart-context/test/smoke.test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { apply, inject, PLUGIN_NAME } from "../src/index.js";

/**
 * 构造一个记录日志与注册调用的假上下文。
 * @param {{ withTools?: boolean }} [options]
 */
function fakeContext(options = {}) {
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const registered = [];
  /** @type {number} */
  let disposeCount = 0;

  /** @type {import("../src/types.js").PluginContext} */
  const ctx = {
    logger: {
      info: (/** @type {string} */ m) => logs.push(`info:${m}`),
      warn: (/** @type {string} */ m) => logs.push(`warn:${m}`),
      error: (/** @type {string} */ m) => logs.push(`error:${m}`),
    },
  };

  if (options.withTools === true) {
    ctx.tools = {
      register: (/** @type {import("../src/types.js").ToolDefinition} */ definition) => {
        registered.push(definition.name);
        return () => { disposeCount += 1; };
      },
    };
  }

  return { ctx, logs, registered, disposeCount: () => disposeCount };
}

test("PLUGIN_NAME 与 package.json 的 name 一致", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.equal(PLUGIN_NAME, JSON.parse(raw).name);
});

test("inject 声明了 tools 硬依赖", () => {
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes("tools"), "注册工具需要 tools 服务");
});

test("BUG-13 依赖受检宿主允许注册目录并完成加载", () => {
  const { ctx } = fakeContext({ withTools: true });
  let registered = false;
  Object.defineProperty(ctx, "systemPrompt", {
    get() {
      if (!inject.includes("systemPrompt")) throw new Error("systemPrompt without inject");
      return { context: () => { registered = true; return () => {}; } };
    },
  });
  const dispose = apply(ctx, {});
  assert.equal(registered, true);
  assert.equal(typeof dispose, "function");
  dispose?.();
});

test("缺 ctx.tools 时降级为警告，不崩溃", () => {
  const { ctx, logs } = fakeContext();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.ok(logs.some((l) => l.startsWith("warn:")), "应记录警告");
  assert.ok(logs.some((l) => /功能不可用/.test(l)));
});

test("有 ctx.tools 时注册两个工具", () => {
  const { ctx, logs, registered } = fakeContext({ withTools: true });
  const dispose = apply(ctx, {});

  assert.deepEqual(registered, ["memory_search", "memory_open"]);
  assert.equal(typeof dispose, "function", "应返回清理函数");
  assert.ok(logs.some((l) => /已注册 memory_search/.test(l)));
});

test("清理函数会注销工具", () => {
  const { ctx, disposeCount } = fakeContext({ withTools: true });
  const dispose = apply(ctx, {});
  assert.equal(typeof dispose, "function");
  assert.equal(disposeCount(), 0);
  assert.ok(dispose !== undefined);
  dispose();
  assert.equal(disposeCount(), 2, "两个工具都应被注销");
});

test("重复 apply（HMR 重载）不抛错", () => {
  const { ctx } = fakeContext({ withTools: true });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.doesNotThrow(() => apply(ctx, {}));
});

test("注册抛「已存在」时被容忍，不重复注册", () => {
  /** @type {string[]} */
  const logs = [];
  let calls = 0;
  const ctx = {
    logger: {
      info: (/** @type {string} */ m) => logs.push(m),
      warn: (/** @type {string} */ m) => logs.push(m),
      error: (/** @type {string} */ m) => logs.push(m),
    },
    tools: {
      register: () => {
        calls += 1;
        throw new Error('tool "memory_search" already registered');
      },
    },
  };
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.ok(logs.some((l) => /跳过/.test(l)), "应记录跳过");
  assert.equal(calls, 1, "第一次失败后不应继续注册第二个");
});

test("apply 忽略未知 config，不因多余字段崩溃", () => {
  const { ctx } = fakeContext({ withTools: true });
  assert.doesNotThrow(() => apply(ctx, { unknownField: true, nested: { a: 1 } }));
});

test("BUG-01 目录只属于请求会话，未知身份不使用其他缓存", async (t) => {
  const { host } = await import("./helpers/host.js");
  const { compactionSession } = await import("./fixtures/compaction-sample.js");
  const h = host(t, async () => ({ events: compactionSession(), session: { cwd: "audit" } }));
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  await h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "A" } });
  const a = h.text("A");
  assert.ok(a.includes("summary-"));
  assert.match(h.text("B"), /尚未加载/);
  await h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "B" } });
  assert.notEqual(h.text("B"), a);
  assert.equal(h.text("A"), a);
});

test("BUG-10 第二次注册失败会注销第一次工具", () => {
  const { ctx } = fakeContext();
  let calls = 0;
  let disposed = 0;
  ctx.tools = { register: () => {
    if (++calls === 2) throw new Error("second tool registration failed");
    return () => { disposed += 1; };
  } };
  assert.equal(apply(ctx, {}), undefined);
  assert.equal(disposed, 1);
});
