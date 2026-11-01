import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.js";
import { host } from "./helpers/host.js";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("BUG-12 上游异常中的认证信息不进入日志或工具响应", async (t) => {
  const credential = "SYNTHETIC_CREDENTIAL_FOR_LOG_TEST";
  const h = host(t, async () => { throw new Error(`Authorization: Bearer ${credential}`); });
  const dispose = apply(h.ctx, {}); t.after(() => dispose?.());
  const value = await h.tools.get("memory_search").execute({ query: "error" }, { agent: { id: "audit" } });
  assert.equal(JSON.stringify([value,h.logs]).includes(credential), false);
});

test("BUG-12 会话探针只输出结构摘要，不输出配置凭据", (t) => {
  host(t, async () => ({}));
  const credential = "SYNTHETIC_CREDENTIAL_FOR_PROBE_TEST";
  const file = join(process.env.DSH_HOME ?? "", "input.jsonl");
  writeFileSync(file, JSON.stringify({ seq: 1, type: "request/header", data: { header: { tools: [], config: { apiKey: credential, headers: { Authorization: credential } } } } }) + "\n");
  const processResult = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/inspect-session.mjs", import.meta.url)), file], { encoding: "utf8" });
  assert.equal(processResult.status, 0, "会话探针应成功返回结构化摘要");
  const output = processResult.stdout;
  const summary = JSON.parse(output);
  assert.equal(summary.events, 1);
  assert.equal(summary.requests, 1);
  assert.equal(summary.usage.cacheReadTokens, null, "没有缓存用量字段时应记录未知");
  assert.equal(output.includes(credential), false);
  assert.equal(output.includes("Authorization"), false);
});
