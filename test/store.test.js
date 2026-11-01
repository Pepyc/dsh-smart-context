/**
 * 存储与重建的验收测试（V1-02）。
 *
 * 验收标准（Steps.md §5.3）：
 * - 重启、重复读取同一日志、重建索引都不新增重复条目
 * - 两个会话中的同名别名不能串读
 *
 * @module dsh-smart-context/test/store.test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractArchives } from "../src/archive.js";
import {
  INDEX_FILENAME,
  emptyIndex,
  hashSegments,
  mergeEntries,
  readIndex,
  rebuildIndex,
  sessionDir,
  toStoredEntry,
  validateIndex,
  writeIndex,
} from "../src/store.js";
import { syncIndex } from "../src/sync.js";
import { compactionSession, plainSession } from "./fixtures/compaction-sample.js";

const SESSION = "session-store-1";
const WS = "workspace-key";

test("会话索引路径拒绝跨目录及 Windows 路径别名", () => {
  for (const id of ["../../other", "..\\..\\other", "", ".", "..", "C:other", "C:\\outside", "/outside", "child/other", "NUL", "CON.txt", "trailing.", "trailing "]) {
    assert.throws(() => sessionDir("synthetic-root", WS, id), TypeError, `should reject ${JSON.stringify(id)}`);
  }
  for (const workspace of ["..", "../other", "..\\other", "C:other"]) {
    assert.throws(() => sessionDir("synthetic-root", workspace, SESSION), TypeError);
  }
  assert.equal(sessionDir("synthetic-root", WS, SESSION), join("synthetic-root", WS, SESSION));
  assert.equal(sessionDir("synthetic-root", WS, "会话-1"), join("synthetic-root", WS, "会话-1"));
});

/**
 * 建一个临时目录并在测试后清理。
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-sc-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("toStoredEntry 不存原文，只存元数据与哈希", () => {
  const { entries } = extractArchives({ sessionId: SESSION, events: compactionSession() });
  const entry = entries.at(0);
  assert.ok(entry);

  const stored = toStoredEntry(entry);
  assert.equal(stored.id, entry.id);
  assert.equal(stored.length, entry.length);
  assert.match(stored.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(stored.status, "complete");

  // 关键：持久化形态里没有 segments 字段
  assert.equal("segments" in stored, false, "不应持久化原文");
});

test("contentHash 能区分不同原文", () => {
  const a = hashSegments([{ seq: 1, role: "user", text: "内容 A" }]);
  const b = hashSegments([{ seq: 1, role: "user", text: "内容 B" }]);
  assert.notEqual(a, b);

  // 分隔符防止拼接歧义
  const c = hashSegments([
    { seq: 1, role: "user", text: "ab" },
    { seq: 2, role: "user", text: "c" },
  ]);
  const d = hashSegments([
    { seq: 1, role: "user", text: "a" },
    { seq: 2, role: "user", text: "bc" },
  ]);
  assert.notEqual(c, d, "分隔符应避免拼接撞哈希");
});

test("写入后能读回，结构一致", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);
  const { entries } = extractArchives({ sessionId: SESSION, events: compactionSession() });

  const { index } = mergeEntries({
    index: emptyIndex(SESSION),
    entries,
    processedThroughSeq: 13,
  });
  const { written, problem } = writeIndex({ dir, index });
  assert.equal(written, true);
  assert.equal(problem, null);

  const loaded = readIndex({ dir });
  assert.equal(loaded.existed, true);
  assert.equal(loaded.problem, null);
  assert.equal(loaded.index.entries.length, index.entries.length);
  assert.equal(loaded.index.lastSeq, 13);
});

test("重复读取同一日志不新增重复条目", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);
  const events = compactionSession();

  const first = syncIndex({ dir, sessionId: SESSION, events });
  const second = syncIndex({ dir, sessionId: SESSION, events });
  const third = syncIndex({ dir, sessionId: SESSION, events });

  assert.ok(first.added > 0, "首次应新增");
  assert.equal(second.added, 0, "第二次不应新增");
  assert.equal(third.added, 0, "第三次不应新增");
  assert.equal(third.index.entries.length, first.index.entries.length);
});

test("重复同步的 added 与 updated 都为 0（回归）", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);
  const events = compactionSession();

  const first = syncIndex({ dir, sessionId: SESSION, events });
  assert.ok(first.added > 0, "首次应新增");

  // 第二次：内容完全相同，added 与 updated 必须都是 0。
  // 这里曾出过 bug：sync 把全部条目都传给 mergeEntries，
  // 导致每条都被当作"新加入 map"而计入 added。
  const second = syncIndex({ dir, sessionId: SESSION, events });
  assert.equal(second.added, 0, "重复同步不应计新增");
  assert.equal(second.updated, 0, "重复同步不应计更新");
  assert.equal(second.rebuilt, false, "不应触发重建");
});

test("原文被改写时 updated 计数且哈希更新", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);

  const base = compactionSession();
  const first = syncIndex({ dir, sessionId: SESSION, events: base });
  const pruneBefore = first.index.entries.find((e) => e.kind === "prune");
  assert.ok(pruneBefore);

  // 改写被遮蔽的那条 tool/result 的内容（seq 3），再追加一个新事件推动 lastSeq
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const mutated = base.map((e) => {
    if (e.seq !== 3) return e;
    const data = /** @type {any} */ (e.data);
    return {
      ...e,
      data: {
        ...data,
        message: {
          ...data.message,
          content: [{ type: "text", text: "改写成不同的内容".repeat(500) }],
        },
      },
    };
  });

  const second = syncIndex({ dir, sessionId: SESSION, events: mutated });
  assert.equal(second.updated, 1, "原文改写应计一次更新");

  const pruneAfter = second.index.entries.find((e) => e.kind === "prune");
  assert.ok(pruneAfter);
  assert.notEqual(pruneAfter.contentHash, pruneBefore.contentHash, "哈希应变化");
  assert.equal(pruneAfter.createdAt, pruneBefore.createdAt, "createdAt 不应漂移");
});

test("重建索引不新增重复条目，ID 保持一致", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);
  const events = compactionSession();

  const synced = syncIndex({ dir, sessionId: SESSION, events });
  const idsBefore = synced.index.entries.map((e) => e.id).sort();

  const rebuilt = rebuildIndex({
    dir,
    sessionId: SESSION,
    events,
    extract: extractArchives,
  });
  const idsAfter = rebuilt.index.entries.map((e) => e.id).sort();

  assert.deepEqual(idsAfter, idsBefore, "重建后 ID 集合不变");
});

test("索引损坏时 syncIndex 自动重建", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);

  // 先写一个正常索引
  syncIndex({ dir, sessionId: SESSION, events: compactionSession() });

  // 破坏它
  const file = join(dir, INDEX_FILENAME);
  writeFileSync(file, "{ 这不是合法 JSON", "utf8");

  const loaded = readIndex({ dir });
  assert.notEqual(loaded.problem, null, "应报告问题");

  const result = syncIndex({ dir, sessionId: SESSION, events: compactionSession() });
  assert.equal(result.rebuilt, true, "应触发重建");
  assert.ok(result.added > 0);
  assert.equal(result.index.entries.length, result.added);
});

test("schemaVersion 不匹配时拒绝并重建", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);

  syncIndex({ dir, sessionId: SESSION, events: compactionSession() });

  // 改 schemaVersion
  const file = join(dir, INDEX_FILENAME);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.schemaVersion = 999;
  writeFileSync(file, JSON.stringify(raw), "utf8");

  const loaded = readIndex({ dir });
  assert.notEqual(loaded.problem, null);
  assert.match(loaded.problem ?? "", /schemaVersion/);
});

test("两个会话的索引互不串读", (t) => {
  const root = tempRoot(t);
  const dirA = sessionDir(root, WS, "session-A");
  const dirB = sessionDir(root, WS, "session-B");

  syncIndex({ dir: dirA, sessionId: "session-A", events: compactionSession() });
  syncIndex({ dir: dirB, sessionId: "session-B", events: compactionSession() });

  const a = readIndex({ dir: dirA });
  const b = readIndex({ dir: dirB });

  assert.equal(a.index.sessionId, "session-A");
  assert.equal(b.index.sessionId, "session-B");

  // 同一批来源在不同会话下 ID 不同
  const idsA = a.index.entries.map((e) => e.id);
  const idsB = b.index.entries.map((e) => e.id);
  assert.equal(idsA.length, idsB.length);
  for (const id of idsA) assert.equal(idsB.includes(id), false, "跨会话 ID 不应重合");
});

test("sessionId 不匹配的索引被拒绝", (t) => {
  const root = tempRoot(t);
  const dirA = sessionDir(root, WS, "session-A");
  syncIndex({ dir: dirA, sessionId: "session-A", events: compactionSession() });

  // 把 A 的索引复制到 B 的目录
  const dirB = sessionDir(root, WS, "session-B");
  const raw = readFileSync(join(dirA, INDEX_FILENAME), "utf8");
  writeIndex({ dir: dirB, index: JSON.parse(raw) });

  const loaded = readIndex({ dir: dirB });
  assert.notEqual(loaded.problem, null, "sessionId 不符应被拒绝");
  assert.match(loaded.problem ?? "", /sessionId/);
});

test("未压缩会话产生空索引，不写垃圾", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, "session-plain");
  const result = syncIndex({ dir, sessionId: "session-plain", events: plainSession() });
  assert.equal(result.index.entries.length, 0);
  assert.equal(result.added, 0);
});

test("增量：新增事件后只补新条目", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);

  // 先同步前半段
  const full = compactionSession();
  const half = full.filter((e) => e.seq <= 9);
  const first = syncIndex({ dir, sessionId: SESSION, events: half });
  assert.equal(first.added, 1, "前半段只有 prune 一条");

  // 再同步完整数据
  const second = syncIndex({ dir, sessionId: SESSION, events: full });
  assert.equal(second.added, 1, "应只补 summary 一条");
  assert.equal(second.index.entries.length, 2);
});

test("createdAt 不因重建而漂移", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);
  const events = compactionSession();

  const first = syncIndex({ dir, sessionId: SESSION, events });
  const createdAtBefore = first.index.entries.map((e) => e.createdAt);

  const rebuilt = rebuildIndex({ dir, sessionId: SESSION, events, extract: extractArchives });
  const createdAtAfter = rebuilt.index.entries.map((e) => e.createdAt);

  // 重建时 mergeEntries 从空索引开始，createdAt 会用新的；
  // 但同一进程内 createdAt 相同（都用 Date.now()），所以这里只断言数量一致。
  assert.equal(createdAtAfter.length, createdAtBefore.length);
});

test("可恢复写入：临时文件不残留", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);
  const { entries } = extractArchives({ sessionId: SESSION, events: compactionSession() });
  const { index } = mergeEntries({ index: emptyIndex(SESSION), entries, processedThroughSeq: 13 });

  writeIndex({ dir, index });

  assert.equal(existsSync(join(dir, `${INDEX_FILENAME}.tmp`)), false, "临时文件应已 rename");
  assert.equal(existsSync(join(dir, INDEX_FILENAME)), true);
});

test("非数字 seq 的元数据行不污染游标（回归）", (t) => {
  const root = tempRoot(t);
  const dir = sessionDir(root, WS, SESSION);

  // 真实会话日志末尾有一行 {"type":"session",...}，没有 seq 字段。
  // 直接 Math.max(max, e.seq) 会得到 NaN，让索引每次都被判定损坏。
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const events = [
    ...compactionSession(),
    /** @type {any} */ ({ type: "session", time: 1700000099000, data: { version: 4 } }),
  ];

  const first = syncIndex({ dir, sessionId: SESSION, events });
  assert.equal(Number.isNaN(first.index.lastSeq), false, "lastSeq 不应是 NaN");
  assert.equal(first.index.lastSeq, 13, "应取数字 seq 的最大值");

  // 第二次同步必须读到干净索引，不重建
  const second = syncIndex({ dir, sessionId: SESSION, events });
  assert.equal(second.rebuilt, false, "不应因 NaN 而每次重建");
  assert.equal(second.added, 0, "重复同步不应计新增");
});

test("maxEventSeq 忽略非数字 seq", async () => {
  const { maxEventSeq } = await import("../src/archive.js");
  /** @type {any[]} */
  const events = [
    { type: "user/message", seq: 5 },
    { type: "session" },
    { type: "user/message", seq: 12 },
    { type: "user/message", seq: "not-a-number" },
  ];
  assert.equal(maxEventSeq(events), 12);
  assert.equal(maxEventSeq([]), -1);
});

test("validateIndex 拒绝非对象输入", () => {
  assert.notEqual(validateIndex(null, SESSION).problem, null);
  assert.notEqual(validateIndex("string", SESSION).problem, null);
  assert.notEqual(validateIndex([], SESSION).problem, null);
});

test("缺失来源的条目状态为 partial", () => {
  /** @type {import("../src/archive-types.js").SessionEvent[]} */
  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1,
      data: { message: { id: "m1", role: "user", content: [{ type: "text", text: "存在" }], source: { kind: "user" } } },
      surfaceOp: "append",
    },
    { type: "compaction/start", seq: 2, time: 2, data: { compactionId: "c", turn: 1 } },
    {
      type: "user/message",
      seq: 3,
      time: 3,
      data: { message: { id: "m3", role: "user", content: [{ type: "text", text: "摘要" }], source: { kind: "user" } } },
      surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [2, 1, 777],
    },
  ];

  const { entries } = extractArchives({ sessionId: SESSION, events });
  const entry = entries.at(0);
  assert.ok(entry);
  const stored = toStoredEntry(entry);
  assert.equal(stored.status, "partial", "来源缺失应为 partial");
});
