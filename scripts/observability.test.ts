/**
 * What a parent can see before it decides to interrupt a run.
 *
 * A stop is only as good as the decision behind it, and the decision is only as
 * good as the facts. This file drives the production decoding and rendering paths
 * and pins the facts that must NOT be invented:
 *
 *   - **the fleet window decodes what the DTO documents**, and a malformed row is
 *     a protocol failure for the whole payload — never a half-trusted row. Unknown
 *     extra fields are tolerated, because a newer owner adding one is not an error.
 *   - **a fleet key is never a run id.** The DTO's keys are opaque display keys;
 *     nothing here joins one to a run, and a test says so by construction.
 *   - **an incomplete window is labelled incomplete.** `omitted > 0`, a row without
 *     usage, or a byte-limit cut makes the sum a lower bound, and the rendering says
 *     exactly that instead of printing a partial sum as the total.
 *   - **elapsed time comes from `startedAt` and a caller's clock**, so rendering
 *     stays cache-only and a test can pin `now`.
 *   - **a goal is shown only from our own dispatch record.** The link is written by
 *     the production `tool_call`/`tool_result` path, and the lane line attributes it
 *     to "本包派单记录" rather than to the runner.
 *   - **every missing field degrades to 未知/absent**, not to `0s`, `?` or a guess.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { createConfigRootResolver } from "../core/config.ts";
import { contextKeyFor, SESSIONS_DIR } from "../core/trellis.ts";
import {
  decodeFleetAgentCounts,
  decodeFleetWindow,
  elapsedLabel,
  formatRunSummary,
  SubagentsClient,
  type NativeActivity,
} from "../core/subagents-client.ts";
import { readRunLink } from "../core/subagents-workflow.ts";
import { existingSubagentsBridge } from "../core/subagents-client.ts";
import { laneWorktreeModule } from "../modules/lane-worktree/index.ts";

const taskRef = ".trellis/tasks/demo";
const NOW = 1_700_000_000_000;

/** One fleet row as the installed owner builds it (its own field names). */
const row = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  agent: "cw-executor",
  startedAt: NOW - 60_000,
  tokens: { input: 100, output: 20, total: 120 },
  ...overrides,
});

const fleet = (entries: unknown[], overrides: Record<string, unknown> = {}) => ({
  fleet: { version: 1, entries, totalActive: entries.length, omitted: 0,
    topLevelAsyncCapacity: { used: entries.length, limit: 10 }, ...overrides },
});

// ── 1. the fleet window decoder ────────────────────────────────────────

test("fleet: the documented fields decode, and unknown extra fields are ignored", () => {
  const window = decodeFleetWindow(fleet([row("fleet-1", {
    role: "implement", model: "p/m", effort: "high", goal: "实现 kinds",
    // An owner from a newer release adding a field must not break this decoder.
    somethingNew: { nested: true },
  })]));
  assert.ok(window !== null);
  const entry = window.entries[0]!;
  assert.equal(entry.key, "fleet-1");
  assert.equal(entry.agent, "cw-executor");
  assert.equal(entry.role, "implement");
  assert.equal(entry.model, "p/m");
  assert.equal(entry.effort, "high");
  assert.equal(entry.goal, "实现 kinds");
  assert.equal(entry.startedAt, NOW - 60_000);
  assert.deepEqual(entry.tokens, { input: 100, output: 20, total: 120 });
  assert.deepEqual(window.gaps, [], "a complete window has no gaps");
  assert.deepEqual(window.tokens, { input: 100, output: 20, total: 120 });
});

test("fleet: a malformed row is a protocol failure for the payload, not a partial row", () => {
  for (const [reason, entries] of [
    ["key is not text", [row("fleet-1"), { ...row("fleet-2"), key: 2 }]],
    ["agent missing", [row("fleet-1"), { key: "fleet-2", startedAt: NOW }]],
    ["startedAt missing", [row("fleet-1"), { key: "fleet-2", agent: "cw-executor" }]],
    ["startedAt not an integer", [row("fleet-1"), row("fleet-2", { startedAt: -1 })]],
    ["a metadata field is not text", [row("fleet-1", { goal: 7 })]],
    ["tokens are unreadable", [row("fleet-1", { tokens: { input: 1 } })]],
    ["an entry is not an object", [row("fleet-1"), "fleet-2"]],
  ] as [string, unknown[]][]) {
    assert.equal(decodeFleetWindow(fleet(entries)), null, reason);
  }
  // The envelope itself, too: a version bump or a missing counter is not readable.
  assert.equal(decodeFleetWindow({ fleet: { version: 2, entries: [], totalActive: 0, omitted: 0 } }), null);
  assert.equal(decodeFleetWindow({ fleet: { version: 1, entries: [] } }), null);
  assert.equal(decodeFleetWindow({}), null);
  assert.equal(decodeFleetWindow(null), null);
});

test("fleet: omitted rows, rows without usage and a byte-limit cut all make the sum a lower bound", () => {
  const omitted = decodeFleetWindow(fleet([row("fleet-1")], { totalActive: 4, omitted: 3 }));
  assert.ok(omitted !== null);
  assert.deepEqual(omitted.tokens, { input: 100, output: 20, total: 120 }, "the sum covers the window only");
  assert.match(omitted.gaps.join("；"), /窗口外还有 3 个活跃 run/);

  const withoutUsage = decodeFleetWindow(fleet([row("fleet-1"), row("fleet-2", { tokens: undefined })]));
  assert.ok(withoutUsage !== null);
  assert.match(withoutUsage.gaps.join("；"), /1 行没有携带用量/);

  const cut = decodeFleetWindow({ ...fleet([row("fleet-1")]),
    asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1,
      caps: { maxRuns: 10, maxChildrenPerNode: 2, maxDepth: 2, maxStringLength: 100, maxSerializedBytes: 100 },
      omitted: { runs: 0, children: 0, byteLimitExceeded: true }, runs: [] } });
  assert.ok(cut !== null);
  assert.match(cut.gaps.join("；"), /字节上限/);

  // No row carried usage at all: "unknown", not a confident 0.
  const none = decodeFleetWindow(fleet([row("fleet-1", { tokens: undefined })]));
  assert.ok(none !== null);
  assert.equal(none.tokens, null);

  // A window that describes nothing, with a count that agrees, is a real zero.
  const empty = decodeFleetWindow(fleet([]));
  assert.ok(empty !== null);
  assert.deepEqual(empty.tokens, { input: 0, output: 0, total: 0 });
  assert.deepEqual(empty.gaps, []);
});

test("fleet: per-agent counts delegate to the same decoder, so the gate and the display cannot disagree", () => {
  const counts = decodeFleetAgentCounts(fleet([row("fleet-1"), row("fleet-2", { agent: "cw-auditor" }), row("fleet-3")]));
  assert.ok(counts !== null);
  assert.equal(counts.counts.get("cw-executor"), 2);
  assert.equal(counts.counts.get("cw-auditor"), 1);
  assert.equal(counts.totalActive, 3);
  assert.equal(decodeFleetAgentCounts(fleet([{ key: 1 }])), null, "the same strictness applies to counting");
});

test("fleet: a display key is never treated as a run id — no run id appears in a fleet row", () => {
  // The DTO deliberately exposes no run/async/tool id. If one ever appeared as a
  // recognised field this test would still pass, which is the point: the decoder
  // never reads one, so nothing downstream can attribute work with it.
  const window = decodeFleetWindow(fleet([row("fleet-1", { runId: "run-should-not-be-read", asyncId: "async-x" })]));
  assert.ok(window !== null);
  assert.deepEqual(Object.keys(window.entries[0]!).sort(),
    ["agent", "key", "startedAt", "tokens"]);
  // And the opaque key is kept opaque: it is not normalised into anything.
  assert.equal(window.entries[0]!.key, "fleet-1");
});

// ── 2. elapsed time ────────────────────────────────────────────────────

test("elapsed: derived from startedAt and a caller's clock, never from a timer or a guess", () => {
  assert.equal(elapsedLabel(NOW - 12_000, NOW), "已运行 12s");
  assert.equal(elapsedLabel(NOW - 12 * 60_000, NOW), "已运行 12m");
  assert.equal(elapsedLabel(NOW - 90 * 60_000, NOW), "已运行 1h 30m");
  assert.equal(elapsedLabel(NOW - 2 * 3600_000, NOW), "已运行 2h");
  // Unknown and unusable clocks stay unknown: `0s` would claim a run just started.
  assert.equal(elapsedLabel(undefined, NOW), undefined);
  assert.equal(elapsedLabel(NOW + 60_000, NOW), undefined, "a start in the future is not 0s of progress");
  // Pure: the same input renders the same string, so a render cannot drift.
  assert.equal(elapsedLabel(NOW - 60_000, NOW), elapsedLabel(NOW - 60_000, NOW));
});

// ── 3. the bounded per-run summary ─────────────────────────────────────

test("summary: per-run state/agent/elapsed are attributable, and tokens carry the window's gaps", () => {
  const activity: NativeActivity = { kind: "known", active: 1, omitted: 0, runs: [
    { id: "run-aaaaaaaa", state: "running", agent: "cw-executor", startedAt: NOW - 12 * 60_000, model: "p/m" },
  ] };
  const complete = formatRunSummary(activity, { kind: "known", ...decodeFleetWindow(fleet([row("fleet-1")]))! }, NOW);
  assert.match(complete.join("\n"), /cw-executor \[running\] · 已运行 12m · p\/m/);
  assert.match(complete.join("\n"), /fleet 窗口完整/);

  const partial = formatRunSummary(activity,
    { kind: "known", ...decodeFleetWindow(fleet([row("fleet-1")], { totalActive: 3, omitted: 2 }))! }, NOW);
  const text = partial.join("\n");
  assert.match(text, /不完整/, text);
  assert.match(text, /下界/, "a partial sum is a lower bound, not the total");
  assert.doesNotMatch(text, /窗口完整/, "and it must not be labelled complete");
});

test("summary: every unknown stays unknown — an unreadable fleet, an absent start time, no runs", () => {
  const unknownActivity = formatRunSummary({ kind: "unknown", reason: "pi-subagents 没有通告 status 能力" },
    { kind: "unknown", reason: "pi-subagents 没有通告 fleetStatus 能力" }, NOW);
  assert.match(unknownActivity.join("\n"), /子 run 明细: 未知（pi-subagents 没有通告 status 能力）/);
  assert.match(unknownActivity.join("\n"), /子 run tokens: 未知（pi-subagents 没有通告 fleetStatus 能力）/);

  const noStart = formatRunSummary({ kind: "known", active: 1, omitted: 0,
    runs: [{ id: "run-bbbbbbbb", state: "running" }] }, { kind: "known", ...decodeFleetWindow(fleet([]))! }, NOW);
  assert.match(noStart.join("\n"), /已运行 未知/);
  assert.doesNotMatch(noStart.join("\n"), /已运行 0s/);

  const nothing = formatRunSummary({ kind: "known", active: 0, omitted: 0, runs: [] },
    { kind: "known", ...decodeFleetWindow(fleet([]))! }, NOW);
  assert.match(nothing.join("\n"), /没有正在运行的子 run/);
  assert.match(nothing.join("\n"), /in 0 \/ out 0/);
});

test("summary: the run list is bounded, so a wide fanout cannot flood the panel", () => {
  const runs = Array.from({ length: 20 }, (_, index) => ({ id: `run-${index}`, state: "running", startedAt: NOW }));
  const lines = formatRunSummary({ kind: "known", active: 20, omitted: 0, runs },
    { kind: "known", ...decodeFleetWindow(fleet([]))! }, NOW);
  assert.equal(lines.filter((line) => line.startsWith("  · ")).length, 8);
  assert.match(lines.join("\n"), /其余 12 个未列出/);
});

// ── 4. the client path, over a fake bus ────────────────────────────────

interface FakeBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
  respond(next: (request: Record<string, unknown>) => unknown | undefined): void;
  requests: Record<string, unknown>[];
}

function fakeBus(): FakeBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const requests: Record<string, unknown>[] = [];
  let responder: ((request: Record<string, unknown>) => unknown | undefined) | null = null;
  return {
    requests,
    emit(channel, data) {
      if (channel !== "subagents:rpc:v1:request") {
        for (const handler of listeners.get(channel) ?? []) handler(data);
        return;
      }
      const request = data as Record<string, unknown>;
      requests.push(request);
      const answer = responder?.(request);
      if (answer === undefined) return;
      const replyChannel = `subagents:rpc:v1:reply:${String(request.requestId)}`;
      queueMicrotask(() => { for (const handler of listeners.get(replyChannel) ?? []) handler(answer); });
    },
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => { set.delete(handler); if (set.size === 0) listeners.delete(channel); };
    },
    respond(next) { responder = next; },
  };
}

const PING = {
  version: 1, methods: ["ping", "status"],
  capabilities: { status: true, fleetStatus: { version: 1 },
    asyncStatusSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot" } },
  events: {}, session: { sessionId: "session-observability" },
};

function respondWith(bus: FakeBus, status: unknown): void {
  bus.respond((request) => {
    if (request.method === "ping") return { version: 1, requestId: request.requestId, success: true, data: PING };
    if (request.method === "status") return { version: 1, requestId: request.requestId, success: true, data: status };
    return undefined;
  });
}

test("client: the fleet window is read through the public RPC, and a malformed reply is unknown", async () => {
  const bus = fakeBus();
  respondWith(bus, fleet([row("fleet-1", { goal: "实现 kinds" })]));
  const client = new SubagentsClient({ events: bus as never });
  try {
    const window = await client.fleetWindow();
    assert.equal(window.kind, "known");
    assert.ok(window.kind === "known" && window.entries[0]!.goal === "实现 kinds");

    respondWith(bus, { fleet: { version: 1, entries: [{ key: 1 }], totalActive: 1, omitted: 0 } });
    const malformed = await new SubagentsClient({ events: bus as never }).fleetWindow();
    assert.equal(malformed.kind, "unknown", "an unreadable window is unknown, never an empty one");
  } finally { client.dispose(); }
});

test("client: an owner without fleetStatus reports the missing capability instead of an empty window", async () => {
  const bus = fakeBus();
  bus.respond((request) => request.method === "ping" ? {
    version: 1, requestId: request.requestId, success: true,
    data: { ...PING, capabilities: { status: true } },
  } : undefined);
  const client = new SubagentsClient({ events: bus as never });
  try {
    const window = await client.fleetWindow();
    assert.equal(window.kind, "unknown");
    assert.ok(window.kind === "unknown" && /fleetStatus/.test(window.reason));
  } finally { client.dispose(); }
});

// ── 5. the panel facts path ───────────────────────────────────────────

test("facts: the panel shows the same bounded per-run summary, and an incomplete window stays incomplete", async () => {
  const root = tempProject();
  const originalCwd = process.cwd();
  const env = { PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, TRELLIS_SUBAGENT_CHILD: process.env.TRELLIS_SUBAGENT_CHILD };
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const bus = fakeBus();
  try {
    writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, autoEnable: true,
      modules: { trellis: false, worktree: false, agents: false, subagents: false, "subagent-context": false,
        "lane-worktree": false, capacity: false, panel: true } }));
    process.chdir(root);
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.TRELLIS_SUBAGENT_CHILD;
    const host = {
      events: bus as never,
      on(name: string, fn: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
      registerCommand() {},
      sendMessage() {},
    } as unknown as PiRuntimeHost;
    respondWith(bus, {
      ...fleet([row("fleet-1", { agent: "cw-executor" })], { totalActive: 3, omitted: 2 }),
      asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1,
        caps: { maxRuns: 10, maxChildrenPerNode: 2, maxDepth: 2, maxStringLength: 100, maxSerializedBytes: 100 },
        omitted: { runs: 0, children: 0, byteLimitExceeded: false },
        runs: [{ id: "run-real-id", kind: "subagent", state: "running", label: "child", agent: "cw-executor",
          model: "p/m", startedAt: Date.now() - 12 * 60_000 }] },
    });
    const { default: coworkflow, controlSurface } = await import("../extensions/coworkflow.ts");
    coworkflow(host);
    const ctx = { cwd: root, mode: "tui", ui: { custom() {} } };
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    const bridge = existingSubagentsBridge(host);
    assert.ok(bridge, "a loaded session has a bridge for the panel to read");
    await bridge.observe();
    await bridge.fleet();
    const facts = controlSurface().facts().join("\n");
    assert.match(facts, /子 run 明细: 1 个/, facts);
    assert.match(facts, /cw-executor \[running\] · 已运行 12m · p\/m/, facts);
    assert.match(facts, /子 run tokens: 不完整/, facts);
    assert.match(facts, /下界/, "a two-run gap is a lower bound, not the total");
    assert.doesNotMatch(facts, /fleet 窗口完整/);
    // Rendering repeatedly stays cache-only: the same facts, no extra RPC.
    const before = bus.requests.length;
    controlSurface().facts();
    assert.equal(bus.requests.length, before, "render performs no RPC");
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. the lane line, through the production handlers ──────────────────

function tempProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-observe-")));
  mkdirSync(join(root, taskRef), { recursive: true });
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, modules: {} }));
  mkdirSync(join(root, SESSIONS_DIR), { recursive: true });
  writeFileSync(join(root, SESSIONS_DIR, `${contextKeyFor("session-observe")}.json`),
    JSON.stringify({ current_task: taskRef }));
  return root;
}

function runtimeFor(root: string): { runtime: RuntimeContext } {
  const runtime = {
    cwd: root, sessionId: "session-observe", sessionEpoch: 1, enabled: true, isChild: false,
    loadState: "auto", refresh() {},
    configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
    control: { moduleEnabled: (id: string) => id === "lane-worktree" || id === "capacity",
      subagentConcurrency: () => null },
  } as unknown as RuntimeContext;
  return { runtime };
}

test("lanes: the goal is our own dispatch record, stored by the production handlers", async () => {
  const root = tempProject();
  const listeners = new Map<string, ((event: any, ctx: any) => any)[]>();
  const messages: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  const host = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: any) => any }) { commands.set(name, spec); },
    sendMessage(message: { content: string }) { messages.push(message.content); },
  } as unknown as Parameters<NonNullable<typeof laneWorktreeModule.activate>>[0];
  const state = runtimeFor(root);
  try {
    laneWorktreeModule.activate!(host, state.runtime);
    laneWorktreeModule.onSessionActivate!(host, state.runtime);
    const emit = async (name: string, event: any): Promise<void> => {
      for (const handler of listeners.get(name) ?? []) await handler(event, {});
    };
    const task = [
      "Active task: .trellis/tasks/demo",
      "",
      "Implement the observability gap in the client decoder and report back.",
    ].join("\n");
    await emit("tool_call", { toolName: "subagent", toolCallId: "goal-call", input: { agent: "cw-executor", task } });
    await emit("tool_result", { toolName: "subagent", toolCallId: "goal-call", details: { runId: "run-goal" } });

    const link = readRunLink(root, "run-goal");
    assert.equal(link?.agent, "cw-executor", "the agent is what we sent, recorded at tool_call time");
    assert.match(link?.goal ?? "", /Implement the observability gap/);
    assert.doesNotMatch(link?.goal ?? "", /Active task:/, "routing metadata is not the goal");

    await commands.get("Coworkflow:lanes")!.handler("", { cwd: root, mode: "tui" });
    const report = messages.at(-1) ?? "";
    assert.match(report, /run run-goal[^\n]*cw-executor（本包派单记录）/, report);
    assert.match(report, /目标（本包派单记录）: Implement the observability gap/, report);
    assert.doesNotMatch(report, /fleet/, "lanes does not print the unattributable fleet window");
  } finally {
    laneWorktreeModule.onSessionEnd!(host, state.runtime);
    rmSync(root, { recursive: true, force: true });
  }
});

test("lanes: a long goal is truncated with a visible ellipsis, and a missing one is simply absent", async () => {
  const root = tempProject();
  const listeners = new Map<string, ((event: any, ctx: any) => any)[]>();
  const messages: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  const host = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: any) => any }) { commands.set(name, spec); },
    sendMessage(message: { content: string }) { messages.push(message.content); },
  } as unknown as Parameters<NonNullable<typeof laneWorktreeModule.activate>>[0];
  const state = runtimeFor(root);
  try {
    laneWorktreeModule.activate!(host, state.runtime);
    laneWorktreeModule.onSessionActivate!(host, state.runtime);
    const emit = async (name: string, event: any): Promise<void> => {
      for (const handler of listeners.get(name) ?? []) await handler(event, {});
    };
    const long = `Active task: ${taskRef}\n\n${"x".repeat(400)}`;
    await emit("tool_call", { toolName: "subagent", toolCallId: "long", input: { agent: "cw-executor", task: long } });
    await emit("tool_result", { toolName: "subagent", toolCallId: "long", details: { runId: "run-long" } });
    // A dispatch with nothing but the routing line has no goal to record.
    await emit("tool_call", { toolName: "subagent", toolCallId: "bare", input: { task: `Active task: ${taskRef}` } });
    await emit("tool_result", { toolName: "subagent", toolCallId: "bare", details: { runId: "run-bare" } });

    assert.match(readRunLink(root, "run-long")?.goal ?? "", /…$/, "a cut goal ends in a visible ellipsis");
    assert.ok((readRunLink(root, "run-long")?.goal ?? "").length <= 120);
    assert.equal(readRunLink(root, "run-bare")?.goal, undefined, "no task text means no goal, not an empty one");
    assert.equal(readRunLink(root, "run-bare")?.agent, undefined, "and no agent name is invented");

    await commands.get("Coworkflow:lanes")!.handler("", { cwd: root, mode: "tui" });
    const report = messages.at(-1) ?? "";
    assert.doesNotMatch(report, /run run-bare[^\n]*（本包派单记录）/, "an unknown agent is absent, not '?'");
    assert.doesNotMatch(report, /run run-bare[^\n]*目标（本包派单记录）/, "and no goal line is printed for it");
    assert.match(report, /run run-bare[^\n]*\[未知\]/, "the state is still reported as unknown, explicitly");
  } finally {
    laneWorktreeModule.onSessionEnd!(host, state.runtime);
    rmSync(root, { recursive: true, force: true });
  }
});
