/**
 * What a parent can honestly say about a running child.
 *
 * The docs used to say "you cannot know what a child is doing", because `pi.events`
 * does not cross processes. That is true of the event bus and stays true here: there
 * is no live stream. What exists is narrower and real — the public `cost` reply
 * attributes a `sessionFile` to a child, this package already reads those files, and
 * the last records in one say what the child had written when it was last flushed.
 *
 * So the thing under test is a **tail read**, and every test here is about keeping
 * it a tail read rather than letting it drift into a claim of live narration:
 *
 *   - a well-formed log yields the last tool invocation, tool name plus a short hint;
 *   - a half-written final line is dropped and the previous record is used, because a
 *     child appends while we read;
 *   - a huge file is opened at an offset: the test asserts the offset and the byte
 *     count, not merely the parsed result;
 *   - a missing or unreadable file is `{ kind: "unknown", reason }` and throws nothing;
 *   - a hint is a path or a command, truncated — never a file body or a whole prompt;
 *   - no timer or interval is registered anywhere on this path;
 *   - attribution is `child.runId` from the cost reply, so a fleet key never becomes
 *     a run id and a child without a run id contributes nothing.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { createConfigRootResolver } from "../core/config.ts";
import {
  childTailActions,
  disposeChildTails,
  formatChildAction,
  MAX_HINT_CHARS,
  MAX_TAIL_BYTES,
  readChildTail,
  refreshChildTails,
} from "../core/child-tail.ts";
import {
  decodeFleetWindow,
  existingSubagentsBridge,
  formatRunSummary,
  type NativeActivity,
} from "../core/subagents-client.ts";
import { disposeUsage, refreshUsage, usageSnapshot } from "../core/usage.ts";

const NOW = 1_700_000_000_000;
const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

const toolCall = (name: string, args: Record<string, unknown>) => ({
  type: "message",
  id: `id-${name}`,
  timestamp: new Date(NOW).toISOString(),
  message: { role: "assistant", provider: "p", model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }] },
});
const assistantText = (text: string) => ({
  type: "message",
  id: "id-text",
  timestamp: new Date(NOW).toISOString(),
  message: { role: "assistant", provider: "p", model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    content: [{ type: "text", text }] },
});
const jsonl = (rows: unknown[]): string => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

function workspace(): { root: string; close(): void } {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-tail-"));
  mkdirSync(join(root, ".trellis"), { recursive: true });
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

// ── 1. the reader ──────────────────────────────────────────────────────

test("tail: the last tool invocation wins, with a short path hint", async () => {
  const w = workspace();
  try {
    const file = join(w.root, "child.jsonl");
    writeFileSync(file, jsonl([
      assistantText("先看看目录"),
      toolCall("bash", { command: "ls -la /tmp" }),
      toolCall("read", { file_path: "/Users/lyston/project/core/usage.ts", limit: 40 }),
      assistantText("读完了，接下来改配置"),
    ]));
    const tail = await readChildTail(file);
    assert.equal(tail.kind, "known");
    if (tail.kind !== "known") return;
    // A tool call is the more specific answer, even though prose came after it.
    assert.deepEqual(tail.action, { kind: "tool", tool: "read", hint: "/Users/lyston/project/core/usage.ts" });
    assert.equal(tail.turns, 4);
    assert.equal(formatChildAction(tail.action!), "read /Users/lyston/project/core/usage.ts");
  } finally { w.close(); }
});

test("tail: the last assistant text is the fallback, and an empty tail is an explicit absence", async () => {
  const w = workspace();
  try {
    const prose = join(w.root, "prose.jsonl");
    writeFileSync(prose, jsonl([toolCall("bash", { command: "ls" }), assistantText("现在写一下报告")]));
    const tail = await readChildTail(prose);
    assert.equal(tail.kind, "known");
    if (tail.kind !== "known") return;
    // Preference order is tool-first: the prose fallback only applies when no tool
    // call is in the tail at all.
    assert.deepEqual(tail.action, { kind: "tool", tool: "bash", hint: "ls" });

    const onlyProse = join(w.root, "only-prose.jsonl");
    writeFileSync(onlyProse, jsonl([assistantText("等待上游回复")]));
    const proseTail = await readChildTail(onlyProse);
    assert.equal(proseTail.kind, "known");
    if (proseTail.kind !== "known") return;
    assert.deepEqual(proseTail.action, { kind: "text", text: "等待上游回复" });
    assert.equal(formatChildAction(proseTail.action!), "输出「等待上游回复」");

    const empty = join(w.root, "empty.jsonl");
    writeFileSync(empty, "");
    const emptyTail = await readChildTail(empty);
    assert.equal(emptyTail.kind, "known");
    if (emptyTail.kind !== "known") return;
    // Not an empty string: an empty action would read as "idle".
    assert.equal(emptyTail.action, null);
    assert.equal(emptyTail.turns, 0);
    assert.match(emptyTail.note!, /没有可解析的记录/);
  } finally { w.close(); }
});

test("tail: a half-written final line is dropped and the previous record is used", async () => {
  const w = workspace();
  try {
    const file = join(w.root, "appending.jsonl");
    writeFileSync(file, `${jsonl([toolCall("bash", { command: "npm test" })])}{"type":"message","message":{"ro`);
    const tail = await readChildTail(file);
    assert.equal(tail.kind, "known");
    if (tail.kind !== "known") return;
    assert.deepEqual(tail.action, { kind: "tool", tool: "bash", hint: "npm test" });
    assert.equal(tail.turns, 1, "the partial record is not a parsed turn");
    assert.equal(tail.dropped, 1, "and it is counted as dropped, not silently ignored");
  } finally { w.close(); }
});

test("tail: a huge log is read from an offset, never from the start", async () => {
  const w = workspace();
  try {
    const file = join(w.root, "big.jsonl");
    // ~256 KiB of history whose head says something a full read would find first.
    const filler = JSON.stringify(toolCall("read", { file_path: "/early/record" }));
    const head = `${Array.from({ length: 3000 }, () => filler).join("\n")}\n`;
    writeFileSync(file, head + jsonl([toolCall("edit", { file_path: "/late/record.ts" })]));
    const size = readFileSync(file).byteLength;
    assert.ok(size > MAX_TAIL_BYTES * 2, "the fixture must exceed one tail");

    const tail = await readChildTail(file);
    assert.equal(tail.kind, "known");
    if (tail.kind !== "known") return;
    assert.equal(tail.offset, size - MAX_TAIL_BYTES, "reads the last 64 KiB, not the whole file");
    assert.equal(tail.bytes, MAX_TAIL_BYTES);
    assert.deepEqual(tail.action, { kind: "tool", tool: "edit", hint: "/late/record.ts" },
      "the late record is found, and the early one is outside the read");
    assert.ok(tail.dropped >= 1, "the head line the offset cut through is accounted for");

    const small = await readChildTail(file, 4096);
    if (small.kind !== "known") return assert.fail("a smaller budget still reads");
    assert.equal(small.offset, size - 4096);
    assert.equal(small.bytes, 4096);
  } finally { w.close(); }
});

test("tail: a missing, non-file or unreadable path is an explicit unknown and never throws", async () => {
  const w = workspace();
  try {
    for (const [label, path] of [
      ["missing", join(w.root, "does-not-exist.jsonl")],
      ["a directory", w.root],
      ["a relative path", "child.jsonl"],
      ["not a string", 42],
    ] as [string, unknown][]) {
      const tail = await readChildTail(path);
      assert.equal(tail.kind, "unknown", label);
      if (tail.kind !== "unknown") continue;
      assert.ok(tail.reason.length > 0, label);
    }
    const dir = await readChildTail(w.root);
    assert.match(dir.kind === "unknown" ? dir.reason : "", /不是普通文件/);
  } finally { w.close(); }
});

test("tail: a hint is a path or command, truncated — never a file body or a prompt", async () => {
  const w = workspace();
  try {
    const body = `const x = 1;\n${"  body line\n".repeat(500)}`;
    const file = join(w.root, "body.jsonl");
    writeFileSync(file, jsonl([
      toolCall("write", { file_path: "/tmp/out.ts", content: body }),
      toolCall("edit", { file_path: "/tmp/out.ts", old_string: body, new_string: `${body}tail` }),
    ]));
    const tail = await readChildTail(file);
    assert.equal(tail.kind, "known");
    if (tail.kind !== "known") return;
    // The last entry is the `edit`: its path is shown, its old/new strings are not.
    assert.deepEqual(tail.action, { kind: "tool", tool: "edit", hint: "/tmp/out.ts" });
    assert.ok(!formatChildAction(tail.action!).includes("body line"), "no file content in the label");

    const long = join(w.root, "long.jsonl");
    writeFileSync(long, jsonl([toolCall("bash", { command: `echo ${"x".repeat(400)}` })]));
    const longTail = await readChildTail(long);
    if (longTail.kind !== "known") return assert.fail("long hint reads");
    assert.equal(longTail.action?.kind, "tool");
    const hint = (longTail.action as { hint?: string }).hint!;
    assert.equal(hint.length, MAX_HINT_CHARS + 1, "truncated to the budget plus the ellipsis");
    assert.ok(hint.endsWith("…"));

    // A prompt is not a hint: `subagent`'s task carries the whole dispatch text.
    const prompt = join(w.root, "prompt.jsonl");
    writeFileSync(prompt, jsonl([toolCall("subagent", { agent: "cw-executor", task: "实现一个很长的任务描述" })]));
    const promptTail = await readChildTail(prompt);
    if (promptTail.kind !== "known") return assert.fail("prompt log reads");
    assert.deepEqual(promptTail.action, { kind: "tool", tool: "subagent" }, "no argument shown");
  } finally { w.close(); }
});

test("tail: control characters are flattened, so one action stays one line", async () => {
  const w = workspace();
  try {
    const file = join(w.root, "noisy.jsonl");
    writeFileSync(file, jsonl([toolCall("bash", { command: "printf 'a\\nb\\nc'\nsecond line\there" })]));
    const tail = await readChildTail(file);
    if (tail.kind !== "known") return assert.fail("noisy log reads");
    const label = formatChildAction(tail.action!);
    assert.ok(!label.includes("\n") && !label.includes("\t"), label);
  } finally { w.close(); }
});

// ── 2. attribution and caching ─────────────────────────────────────────

test("attribution: the action is keyed by the cost reply's runId, never by a fleet key", async () => {
  const w = workspace();
  try {
    const file = join(w.root, "child.jsonl");
    writeFileSync(file, jsonl([toolCall("bash", { command: "npx tsc --noEmit" })]));
    const host = {};
    const runtime = { isChild: false, enabled: true, sessionEpoch: 1, sessionId: "s1" } as RuntimeContext;
    await refreshChildTails(host, runtime, {
      kind: "known",
      parent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      childTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      children: [
        { label: "a", agent: "cw-executor", runId: "run-real", sessionFile: file,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
        // A session file with no run id cannot be attributed, so it contributes nothing.
        { label: "b", agent: "cw-executor", sessionFile: file,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
        // A run id with no usable sessionFile likewise yields no action.
        { label: "c", agent: "cw-executor", runId: "run-no-file", sessionFile: "relative.jsonl",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } },
      ],
      unresolvedAsyncChildren: 0,
      incomplete: false,
    });
    const actions = childTailActions(host, runtime);
    assert.deepEqual([...actions.keys()], ["run-real"]);
    assert.equal(actions.get("run-real"), "bash npx tsc --noEmit");

    // A fleet row's key is an opaque display key; it must never resolve to an action.
    const activity: NativeActivity = { kind: "known", active: 1, omitted: 0,
      runs: [{ id: "run-real", state: "running", agent: "cw-executor", startedAt: NOW - 60_000 }] };
    const fleet = decodeFleetWindow({ fleet: { version: 1, totalActive: 1, omitted: 0,
      topLevelAsyncCapacity: { used: 1, limit: 4 },
      entries: [{ key: "fleet-key-1", agent: "cw-executor", startedAt: NOW - 60_000 }] } })!;
    const lines = formatRunSummary(activity, { kind: "known", ...fleet }, NOW, actions);
    const text = lines.join("\n");
    assert.match(text, /run run-real/);
    assert.match(text, /正在 bash npx tsc --noEmit（读自子会话日志尾部）/, text);
    assert.doesNotMatch(text, /fleet-key-1/, "a fleet key is not an id");
    // And the display key carries no action of its own.
    assert.equal(actions.get("fleet-key-1"), undefined);

    // A run that leaves the reply loses its entry: a stale action would describe
    // work that ended.
    await refreshChildTails(host, runtime, { kind: "unknown", reason: "无 cost 能力" });
    assert.equal(childTailActions(host, runtime).size, 0);
    disposeChildTails(host);
  } finally { w.close(); }
});

test("attribution: a run with no tail says nothing instead of printing an empty action", () => {
  const activity: NativeActivity = { kind: "known", active: 1, omitted: 0,
    runs: [{ id: "run-quiet", state: "running", agent: "cw-executor", startedAt: NOW - 60_000 }] };
  const fleet = decodeFleetWindow({ fleet: { version: 1, totalActive: 0, omitted: 0,
    topLevelAsyncCapacity: { used: 0, limit: null }, entries: [] } })!;
  const lines = formatRunSummary(activity, { kind: "known", ...fleet }, NOW, new Map());
  assert.doesNotMatch(lines.join("\n"), /正在 /, lines.join("\n"));
});

// ── 3. boundaries and timers ───────────────────────────────────────────

test("boundaries: the tail path schedules nothing", async () => {
  const source = readFileSync(here("../core/child-tail.ts"), "utf8");
  assert.doesNotMatch(source, /setInterval|setTimeout/, "the tail reader must not schedule anything");

  const w = workspace();
  try {
    const file = join(w.root, "child.jsonl");
    writeFileSync(file, jsonl([toolCall("bash", { command: "npm run typecheck" })]));
    const host = {};
    const runtime = { isChild: false, enabled: true, sessionEpoch: 1, sessionId: "s1" } as RuntimeContext;

    // Any scheduling on this path would show up here. The RPC client's per-request
    // deadline is separate bookkeeping and is not part of a tail read.
    const timers: string[] = [];
    const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval,
      setImmediate: globalThis.setImmediate };
    (globalThis as any).setTimeout = (...args: unknown[]) => { timers.push("setTimeout"); return (real.setTimeout as any)(...args); };
    (globalThis as any).setInterval = (...args: unknown[]) => { timers.push("setInterval"); return (real.setInterval as any)(...args); };
    (globalThis as any).setImmediate = (...args: unknown[]) => { timers.push("setImmediate"); return (real.setImmediate as any)(...args); };
    try {
      await readChildTail(file);
      await refreshChildTails(host, runtime, {
        kind: "known",
        parent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        childTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        children: [{ label: "c", agent: "cw-executor", runId: "run-1", sessionFile: file,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }],
        unresolvedAsyncChildren: 0, incomplete: false,
      });
    } finally {
      (globalThis as any).setTimeout = real.setTimeout;
      (globalThis as any).setInterval = real.setInterval;
      (globalThis as any).setImmediate = real.setImmediate;
    }
    assert.deepEqual(timers, [], "reading a tail schedules nothing");
    assert.equal(childTailActions(host, runtime).get("run-1"), "bash npm run typecheck");
    disposeChildTails(host);
  } finally { w.close(); }
});

test("boundaries: the existing usage refresh is what populates the cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-tail-boundary-"));
  mkdirSync(join(root, ".trellis"), { recursive: true });
  const childFile = join(root, "child.jsonl");
  writeFileSync(childFile, jsonl([toolCall("grep", { pattern: "kind" })]));

  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emit = (name: string, value: unknown): void => {
    for (const fn of listeners.get(name) ?? []) fn(value);
  };
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  const costPayload = {
    version: 1, parent: totals,
    children: [{ label: "child-0", agent: "cw-executor", runId: "run-1", sessionFile: childFile, usage: totals }],
    childTotal: totals, total: totals, unresolvedAsyncChildren: 0,
  };
  const events = {
    on(name: string, fn: (data: unknown) => void) {
      const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set);
      return () => { set.delete(fn); if (!set.size) listeners.delete(name); };
    },
    emit(name: string, value: unknown) {
      if (name !== "subagents:rpc:v1:request") return emit(name, value);
      const request = value as Record<string, any>;
      const data = request.method === "ping"
        ? { version: 1, methods: ["status", "cost"], capabilities: { cost: { version: 1 }, fleetStatus: { version: 1 } }, events: {}, session: { sessionId: "s1" } }
        : request.method === "status"
          ? { fleet: { version: 1, totalActive: 0, omitted: 0, entries: [], topLevelAsyncCapacity: { used: 0, limit: null } } }
          : costPayload;
      queueMicrotask(() => emit(`subagents:rpc:v1:reply:${request.requestId}`,
        { version: 1, requestId: request.requestId, success: true, data }));
    },
  };
  const host: PiRuntimeHost = { events };
  const runtime = { cwd: root, enabled: true, isChild: false, sessionEpoch: 1, sessionId: "s1", parentSessionId: null,
    loadState: "auto", configRoots: createConfigRootResolver(),
    control: { moduleEnabled: () => true, initialized: () => true, switches: () => ({}), moduleIds: () => [],
      configRoot: () => root, configRootNote: () => null, autoEnable: () => true, prefix: () => "wt-",
      facts: () => [], setSwitch: () => "", setAutoEnable: () => "", setPrefix: () => "",
      subagentConcurrency: () => null, setSubagentConcurrency: () => "", loadState: () => "auto",
      agentKinds: () => [], setAgentKind: () => "", agentKindStatus: () => [], settleAgentKinds: () => Promise.resolve(), settleSubagents: () => Promise.resolve(), runBudgetMinutes: () => null, setRunBudgetMinutes: () => "", defineKind: () => "", removeKind: () => "",
      init: () => "" }, refresh() {} } as unknown as RuntimeContext;
  try {
    await refreshUsage(host, runtime, { sessionManager: { getSessionId: () => "s1", getEntries: () => [] } });
    assert.equal(usageSnapshot(host, runtime).cost.kind, "known");
    assert.equal(childTailActions(host, runtime).get("run-1"), "grep kind",
      "the production refresh populated the cache");
    // Rendering is a lookup: the session ending clears it rather than leaving one
    // session's actions visible in the next.
    disposeUsage(host);
    assert.equal(childTailActions(host, runtime).size, 0);
  } finally {
    existingSubagentsBridge(host)?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
