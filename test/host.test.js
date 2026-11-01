import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";
import { compactionSession } from "./fixtures/compaction-sample.js";
import { host, tick } from "./helpers/host.js";

test("BUG-03 首次组装等待归档就绪并更新本次目录", async (t) => {
  /** @type {(value: any) => void} */ let release = () => {};
  const h = host(t, () => new Promise((r) => { release = r; }));
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  let done = false;
  const assembly = h.assemble("audit").then((a) => { done = true; return a; });
  await tick(); assert.equal(done, false);
  release({ events: compactionSession(), session: { cwd: "audit" } });
  const result = await assembly;
  assert.ok(result.contexts.some((/** @type {any} */ c) => c.text.includes("prune-")));
});

test("BUG-03 刷新期间的新事件会补读，工具不会并发覆盖", async (t) => {
  /** @type {Array<(value: any) => void>} */ const pending = [];
  const h = host(t, () => new Promise((r) => pending.push(r)));
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  const initial = h.events.get("agent/created")?.({ agent: { id: "audit" } });
  h.events.get("session/event")?.({ id: "audit" }, { type: "compaction/end" });
  const query = h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "audit" } });
  assert.equal(pending.length, 1);
  pending[0]?.({ events: [], session: { cwd: "audit" } });
  await tick(); assert.equal(pending.length, 2);
  pending[1]?.({ events: compactionSession(), session: { cwd: "audit" } });
  await initial; assert.equal((await query).status, "ok");
  assert.ok(h.text("audit").includes("prune-"));
});

test("BUG-03 卸载后的读取不能重新发布目录或返回归档", async (t) => {
  /** @type {(value: any) => void} */ let release = () => {};
  const h = host(t, () => new Promise((r) => { release = r; }));
  const dispose = apply(h.ctx, {});
  const query = h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "audit" } });
  dispose?.(); release({ events: compactionSession(), session: { cwd: "audit" } });
  await assert.rejects(query, { name: "AbortError" });
  assert.equal(h.text("audit"), "");
});

test("BUG-04 冷启动读取失败返回 source-unavailable 而非无归档", async (t) => {
  const h = host(t, async () => { throw new Error("source missing"); });
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  const result = await h.tools.get("memory_search").execute({ query: "P0-01" }, { agent: { id: "audit" } });
  assert.equal(result.status, "source-unavailable");
});

test("BUG-04 读取失败不返回旧内容且目录不继续宣称可读", async (t) => {
  let broken = false;
  const h = host(t, async () => {
    if (broken) throw new Error("source unavailable");
    return { events: compactionSession(), session: { cwd: "audit" } };
  });
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  const tool = h.tools.get("memory_search"); const exec = { agent: { id: "audit" } };
  const good = await tool.execute({ query: "P0-01" }, exec);
  broken = true;
  assert.equal((await tool.execute({ query: "P0-01" }, exec)).status, "source-unavailable");
  assert.equal((await h.tools.get("memory_open").execute({ id: good.hits[0].id }, exec)).status, "source-unavailable");
  assert.match(h.text("audit"), /目录.*不可用.*读取或处理失败/);
});
