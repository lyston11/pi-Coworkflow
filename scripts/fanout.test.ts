/**
 * `coworkflow.fanout`: independent children, started together, and the overlap
 * measurement that makes serial dispatch visible.
 *
 * The defect this file exists for is invisible by nature: a script that awaits
 * `runs.run` in a loop looks exactly like one that uses `Promise.all` until you
 * time it. So the interesting assertion is not the returned value — it is that the
 * *third* child was started before the *first* child finished. That is measured
 * against pi-subagents' own script sandbox (`runWorkflowScript`), not against a
 * local re-implementation of it, because the sandbox is what will run this script
 * for real.
 *
 * The second half covers the measurement itself: two intervals that cross are
 * parallel, a complete interval that crosses nothing is serial, and a missing
 * timestamp is *unknown* — never serial, because counting "I could not tell" as
 * serial would make the number a lie.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  FANOUT_NAME,
  RUN_BUDGET_MS,
  RUN_CHECKPOINT_MS,
  checkpointFor,
  WORKFLOW_NAME,
  dispatchOverlap,
  readSessionLinks,
  recordLaunchLink,
  recordRunSettled,
  registerImplementReviewWorkflow,
  resolveFanout,
} from "../core/subagents-workflow.ts";
import { formatOverlapLine, summarizeOverlap } from "../core/dispatch-timing.ts";
import { BUILTIN_KINDS, agentNameFor, disabledKindMessage, unregisteredKindMessage } from "../modules/agent-kinds/defaults.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-fanout-"));
  mkdirSync(join(root, ".trellis", ".runtime"), { recursive: true });
  return root;
}

/** The installed owner's script sandbox, or null when pi-subagents is not installed. */
async function scriptRunner(): Promise<((options: Record<string, unknown>) => Promise<any>) | null> {
  const dir = join(process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents");
  const entry = join(dir, "src", "workflows", "scripted-workflow.js");
  try {
    readFileSync(join(dir, "package.json"));
  } catch {
    return null;
  }
  const module = (await import(new URL(`file://${entry}`).href)) as { runWorkflowScript: (options: Record<string, unknown>) => Promise<any> };
  return module.runWorkflowScript;
}

const runner = await scriptRunner();
const runnerSkip = runner === null ? "pi-subagents is not installed in this environment" : false;

const TWD = "/tmp/fanout-worktree";

/** Every kind this package ships, dispatchable: the policy a listed project resolves to. */
function allKindsDispatchable() {
  return { kinds: BUILTIN_KINDS.map((entry) => ({ kind: entry.kind, agent: agentNameFor(entry.kind), dispatchable: true })) };
}

function expand(tasks: unknown, extra: Record<string, unknown> = {}, policy: unknown = allKindsDispatchable()): string | { error: string } {
  const expanded = resolveFanout({ tasks, ...extra }, { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" }, policy as any);
  return "script" in expanded ? expanded.script : expanded;
}

function scriptOf(tasks: unknown, extra: Record<string, unknown> = {}, policy: unknown = allKindsDispatchable()): string {
  const expanded = expand(tasks, extra, policy);
  assert.equal(typeof expanded, "string", typeof expanded === "string" ? "" : expanded.error);
  return expanded as string;
}

// ── Validation ───────────────────────────────────────────────────────

test("fanout: args are validated as strictly as the implement/review resource", () => {
  // Count is bounded on both ends: zero tasks is not a fanout, and a large one is
  // not independent work the parent can audit.
  for (const tasks of [[], undefined, null, "nope", {}, [...Array(9)].map((_, index) => ({ kind: "executor", task: `t${index}` }))]) {
    const expanded = expand(tasks);
    assert.equal(typeof expanded, "object", `must reject ${JSON.stringify(tasks)?.slice(0, 40)}`);
  }
  // One task is fine: a fanout of one is a named script, not an error.
  assert.equal(typeof expand([{ kind: "executor", task: "do it" }]), "string");

  const rejections: [unknown, RegExp][] = [
    [[{ kind: "", task: "x" }], /tasks\[0\]\.kind/],
    [[{ kind: "   ", task: "x" }], /tasks\[0\]\.kind/],
    [[{ kind: "executor", task: "" }], /tasks\[0\]\.task/],
    [[{ kind: "executor", task: "   " }], /tasks\[0\]\.task/],
    [[{ kind: "executor", task: 7 }], /tasks\[0\]\.task/],
    [[{ kind: "exec utor", task: "x" }], /tasks\[0\]\.kind/],
    [[{ kind: "executor", task: "x", agent: "worker" }], /tasks\[0\] contains unsupported fields: agent/],
    [[{ task: "x" }], /tasks\[0\]\.kind/],
    [["executor"], /tasks\[0\] must be a \{ kind, task \} object/],
    [[{ kind: "executor", task: "x" }, null], /tasks\[1\] must be a \{ kind, task \} object/],
    [[{ kind: "executor", task: "x".repeat(8001) }], /tasks\[0\]\.task/],
  ];
  for (const [tasks, expected] of rejections) {
    const expanded = expand(tasks);
    assert.equal(typeof expanded, "object", JSON.stringify(tasks).slice(0, 60));
    if (typeof expanded === "object") assert.match(expanded.error, expected);
  }

  // Unknown top-level fields are rejected, including the ones a caller might hope
  // would override the host's own verification.
  for (const [args, expected] of [
    [{ tasks: [{ kind: "executor", task: "x" }], worktree: "/elsewhere" }, /unsupported fields: worktree/],
    [{ tasks: [{ kind: "executor", task: "x" }], script: "return 1" }, /unsupported fields: script/],
    [{ tasks: [{ kind: "executor", task: "x" }], focus: "" }, /args\.focus/],
    [{ tasks: [{ kind: "executor", task: "x" }], focus: "y".repeat(2001) }, /args\.focus/],
    [{}, /args\.tasks/],
  ] as [Record<string, unknown>, RegExp][]) {
    const expanded = resolveFanout(args, { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" });
    assert.ok("error" in expanded, JSON.stringify(args).slice(0, 60));
    if ("error" in expanded) assert.match(expanded.error, expected);
  }
});

test("fanout: a kind this package does not ship is rejected, naming the kinds that exist", () => {
  for (const kind of ["tidy", "trellis-implement", "cw-executor", "reviewer"]) {
    const expanded = expand([{ kind, task: "x" }]);
    assert.equal(typeof expanded, "object", kind);
    if (typeof expanded === "object") {
      assert.match(expanded.error, /is not a kind this package ships/);
      // Actionable: the error lists what the caller *may* name.
      for (const shipped of BUILTIN_KINDS) assert.ok(expanded.error.includes(shipped.kind), `${kind} -> ${expanded.error}`);
    }
  }
});

test("fanout: a disabled kind is refused per task in the gate's own words, and siblings still run", { skip: runnerSkip }, async () => {
  // The project's policy, as the host resolves it: `executor` on, `auditor` off.
  const policy = {
    kinds: BUILTIN_KINDS.map((entry) => ({
      kind: entry.kind, agent: agentNameFor(entry.kind),
      dispatchable: entry.kind === "executor",
      ...(entry.kind === "executor" ? {} : { refusal: disabledKindMessage(entry.kind, agentNameFor(entry.kind), ["cw-executor"]) }),
    })),
  };
  const script = scriptOf([{ kind: "executor", task: "a" }, { kind: "auditor", task: "b" }], {}, policy);
  const started: string[] = [];
  const result = await runner!({
    script,
    args: {},
    launch: async (key: string) => {
      started.push(key);
      return { key, ok: true, output: "done", runId: `run-${key}`, artifactPaths: [],
        structuredOutput: { status: "completed", summary: "done", handoff: "h" } };
    },
    status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
  });

  assert.deepEqual(started, ["task-1"], "a disabled kind is never started");
  const value = result.value as Record<string, any>;
  assert.equal(value.status, "partial");
  const refused = value.results[1];
  assert.equal(refused.ok, false);
  assert.equal(refused.kind, "auditor");
  assert.equal(refused.agent, "cw-auditor");
  assert.equal(refused.status, "failed");
  // The same vocabulary the `tool_call` gate uses, not a second one.
  assert.match(String(refused.error), /关闭了 kind auditor（cw-auditor）/);
  assert.match(String(refused.error), /当前可用的 kind：cw-executor/);
  // The enabled sibling is unaffected.
  assert.equal(value.results[0].ok, true);
});

test("fanout: an unreadable kind policy refuses the task instead of assuming it is fine", { skip: runnerSkip }, async () => {
  const policy = {
    unavailable: "本会话的「子 agent 类型」（agent-kinds）模块已关闭，无法确认任何 kind 是否可以派单",
    kinds: BUILTIN_KINDS.map((entry) => ({ kind: entry.kind, agent: agentNameFor(entry.kind), dispatchable: false,
      refusal: unregisteredKindMessage(entry.kind, agentNameFor(entry.kind), "kind 模块已关闭") })),
  };
  const script = scriptOf([{ kind: "executor", task: "a" }], {}, policy);
  let started = 0;
  let thrown: unknown;
  try {
    await runner!({
      script, args: {},
      launch: async (key: string) => { started += 1; return { key, ok: true, output: "done", artifactPaths: [] }; },
      status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
    });
  } catch (error) { thrown = error; }
  assert.equal(started, 0, "nothing launched on an unknown policy");
  assert.ok(thrown instanceof Error);
  assert.match((thrown as Error).message, /all 1 task\(s\) failed/);
  assert.match((thrown as Error).message, /kind 模块已关闭/);
});

test("fanout: keys come from position, so two identical tasks are two children", () => {
  const script = scriptOf([{ kind: "executor", task: "same" }, { kind: "executor", task: "same" }]);
  assert.match(script, /"key":"task-1"/);
  assert.match(script, /"key":"task-2"/);
  // The task text is interpolated as JSON data, never as code.
  assert.doesNotMatch(script, /^\s*task:\s*same/m);
});

// ── Concurrency ──────────────────────────────────────────────────────

test("fanout: three tasks start together — the third starts before the first finishes", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ kind: "executor", task: "a" }, { kind: "executor", task: "b" }, { kind: "auditor", task: "c" }]);
  const starts: { key: string; at: number }[] = [];
  const firstResolvedAt: number[] = [];
  const params: Record<string, Record<string, unknown>> = {};
  const result = await runner!({
    script,
    args: {},
    launch: async (key: string, call: Record<string, unknown>) => {
      starts.push({ key, at: Date.now() });
      params[key] = call;
      // Every child takes the same wall-clock time, so a serial runner would need
      // three times as long as a parallel one.
      await delay(80);
      firstResolvedAt.push(Date.now());
      return { key, ok: true, output: `did ${key}`, runId: `run-${key}`, outputReference: `/tmp/${key}.md`,
        artifactPaths: [], structuredOutput: { status: "completed", summary: `done ${key}`, handoff: `handoff ${key}` } };
    },
    status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
  });

  assert.deepEqual(starts.map((entry) => entry.key), ["task-1", "task-2", "task-3"], "every child was started");
  const span = starts[2]!.at - starts[0]!.at;
  assert.ok(span < 60, `starts are concurrent, not serial (span ${span}ms)`);
  const firstEnd = Math.min(...firstResolvedAt);
  assert.ok(starts[2]!.at < firstEnd, "the last child started before any child finished: nothing queued behind an await");

  // Each child got its own fresh, non-worktree, schema'd contract.
  for (const key of ["task-1", "task-2", "task-3"]) {
    const call = params[key]!;
    assert.equal(call.context, "fresh");
    assert.equal(call.worktree, false);
    assert.equal(call.cwd, undefined, "the host places the launch; the script must not hard-code a tree");
    assert.equal((call.acceptance as Record<string, unknown>).level, "checked");
    assert.equal((call.outputSchema as Record<string, unknown>).type, "object");
    assert.equal(call.async, undefined);
  }
  // The kind, not an arbitrary agent name, is what the caller names; the resolver
  // turns it into the agent the owner registered (`agentNameFor`, one mapping).
  assert.equal(params["task-1"]!.agent, "cw-executor");
  assert.equal(params["task-3"]!.agent, "cw-auditor");

  const value = result.value as Record<string, any>;
  assert.equal(value.status, "completed");
  assert.equal(value.acceptance, "parent-owned", "a green fanout is not an accepted change");
  assert.match(String(value.note), /不代表验收通过/);
  assert.equal(value.concurrency, "parallel");
  assert.deepEqual(value.results.map((entry: any) => entry.key), ["task-1", "task-2", "task-3"]);
  assert.deepEqual(value.results.map((entry: any) => entry.kind), ["executor", "executor", "auditor"]);
  assert.deepEqual(value.results.map((entry: any) => entry.agent), ["cw-executor", "cw-executor", "cw-auditor"]);
  assert.deepEqual(value.results.map((entry: any) => entry.ok), [true, true, true]);
  assert.equal(value.results[0].handoff, "handoff task-1");
});

test("fanout: a failing child does not cancel its siblings and is reported as that task's failure", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ kind: "executor", task: "a" }, { kind: "executor", task: "b" }, { kind: "executor", task: "c" }]);
  const starts: number[] = [];
  const finishes: number[] = [];
  const result = await runner!({
    script,
    args: {},
    launch: async (key: string) => {
      starts.push(Date.now());
      await delay(40);
      finishes.push(Date.now());
      if (key === "task-2") return { key, ok: false, output: "half", error: "child exploded", runId: "run-2", artifactPaths: [] };
      return { key, ok: true, output: `did ${key}`, runId: `run-${key}`, artifactPaths: [],
        structuredOutput: { status: "completed", summary: `done ${key}`, handoff: `h-${key}` } };
    },
    status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
  });

  assert.equal(starts.length, 3, "all three children started");
  assert.ok(starts[2]! < Math.min(...finishes), "one child failing cannot make the others wait for it");
  const value = result.value as Record<string, any>;
  assert.equal(value.status, "partial", "a partial fanout is an outcome, not a workflow error");
  assert.equal(value.completed, 2);
  assert.equal(value.failed, 1);
  const [first, second, third] = value.results;
  assert.equal(first.ok, true);
  assert.equal(first.summary, "done task-1");
  assert.equal(second.ok, false);
  assert.equal(second.status, "failed");
  assert.match(String(second.error), /child exploded/);
  assert.equal(second.key, "task-2", "the failure is attributed to its own task");
  assert.equal(second.agent, "cw-executor");
  assert.equal(second.kind, "executor");
  assert.equal(second.runId, null, "a rejected child has no identity the sandbox can read: absent, not borrowed from a sibling");
  assert.equal(third.ok, true, "a sibling keeps working after another child failed");
  assert.equal(third.runId, "run-task-3", "the sibling keeps its own run identity");
});

test("fanout: a child that reports no usable verdict is a failed task, not a silent pass", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ kind: "executor", task: "a" }, { kind: "executor", task: "b" }]);
  const result = await runner!({
    script,
    args: {},
    launch: async (key: string) => (key === "task-1"
      ? { key, ok: true, output: "I think it worked", runId: "run-1", artifactPaths: [] }
      : { key, ok: true, output: "done", runId: "run-2", artifactPaths: [], structuredOutput: { status: "completed", summary: "done", handoff: "h" } }),
    status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
  });
  const value = result.value as Record<string, any>;
  assert.equal(value.status, "partial");
  assert.equal(value.results[0].ok, false, "no structured verdict: no completed task");
  assert.equal(value.results[1].ok, true);
});

test("fanout: all children failing is fail-closed", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ kind: "executor", task: "a" }, { kind: "executor", task: "b" }]);
  let thrown: unknown;
  try {
    await runner!({
      script,
      args: {},
      launch: async (key: string) => ({ key, ok: false, output: "", error: `${key} exploded`, artifactPaths: [] }),
      status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "nothing succeeded, so the workflow fails");
  assert.match((thrown as Error).message, /all 2 task\(s\) failed/);
  assert.match((thrown as Error).message, /task-1: Run 'task-1' failed: task-1 exploded/);
});

test("fanout: no workflow path writes a message into the conversation", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ kind: "executor", task: "a" }]);
  // The workflow sandbox only exposes `runs`, `emit`, `console` and `state`; a
  // message into the conversation is not among them, and the script must not reach
  // for one. A custom message arrives as a user turn and rewrites the work it
  // describes, which is exactly why the old reminder was removed.
  assert.doesNotMatch(script, /sendMessage|sendUserMessage/);
  assert.doesNotMatch(script, /(^|[^\w.])emit\(/m);
  assert.doesNotMatch(script, /console\.(log|warn|error|info)/);

  const result = await runner!({
    script,
    args: {},
    launch: async (key: string) => ({ key, ok: true, output: "done", runId: "run-1", artifactPaths: [],
      structuredOutput: { status: "completed", summary: "done", handoff: "h" } }),
    status: async (key: string) => ({ key, ok: false, output: "", error: "not used", artifactPaths: [] }),
  });
  assert.deepEqual(result.emits, [], "the workflow emitted nothing");
  assert.deepEqual(result.console, [], "the workflow logged nothing");
});

// ── Overlap measurement ──────────────────────────────────────────────

test("overlap: crossing intervals are parallel, a complete non-crossing interval is serial", () => {
  const concurrent = summarizeOverlap([
    { id: "a", startedAt: 0, settledAt: 1000 },
    { id: "b", startedAt: 100, settledAt: 900 },
  ], 2000);
  assert.deepEqual(concurrent, { parallel: 2, serial: 0, unresolved: 0, total: 2 });

  const sequential = summarizeOverlap([
    { id: "a", startedAt: 0, settledAt: 1000 },
    { id: "b", startedAt: 1000, settledAt: 2000 },
  ], 3000);
  assert.deepEqual(sequential, { parallel: 0, serial: 2, unresolved: 0, total: 2 });

  // Two of three overlap; the third starts after both finished.
  const mixed = summarizeOverlap([
    { id: "a", startedAt: 0, settledAt: 500 },
    { id: "b", startedAt: 100, settledAt: 400 },
    { id: "c", startedAt: 600, settledAt: 700 },
  ], 1000);
  assert.deepEqual(mixed, { parallel: 2, serial: 1, unresolved: 0, total: 3 });
});

test("overlap: missing timestamps are unknown, never counted as serial", () => {
  const unknown = summarizeOverlap([
    { id: "a" },
    { id: "b", startedAt: 0 },
    { id: "c", settledAt: 100 },
  ], 500);
  assert.equal(unknown.serial, 0, "an interval that was never observed is not evidence of serial work");
  assert.equal(unknown.unresolved, 3);

  // A run that is still open ends at `now`: enough to prove overlap, not enough to
  // prove serial.
  const running = summarizeOverlap([{ id: "a", startedAt: 0 }], 500);
  assert.deepEqual(running, { parallel: 0, serial: 0, unresolved: 1, total: 1 });
  const runningAlone = summarizeOverlap([{ id: "a", startedAt: 0 }, { id: "b", startedAt: 1000 }], 5000);
  assert.deepEqual(runningAlone, { parallel: 2, serial: 0, unresolved: 0, total: 2 });

  // A clock that went backwards yields no interval at all.
  const backwards = summarizeOverlap([{ id: "a", startedAt: 1000, settledAt: 10 }], 2000);
  assert.deepEqual(backwards, { parallel: 0, serial: 0, unresolved: 1, total: 1 });
});

test("overlap: the status line names the counts, and says nothing was measured when nothing was", () => {
  assert.match(formatOverlapLine({ parallel: 3, serial: 5, unresolved: 0, total: 8 }), /3 次并行、5 次串行（本次会话）/);
  assert.match(formatOverlapLine({ parallel: 1, serial: 0, unresolved: 2, total: 3 }), /2 次仍在运行或时间未知（不计入串行）/);
  assert.match(formatOverlapLine({ parallel: 0, serial: 0, unresolved: 0, total: 0 }), /还没有派单记录/);
});

test("overlap: the measurement reads the recorded links of one session only", () => {
  const root = tempRoot();
  try {
    const session = "session-overlap-a";
    // A strictly sequential pair, with a second session's crossing run mixed in.
    recordLaunchLink(root, { runId: "run-1", taskRef: ".trellis/tasks/10-20-demo", sessionId: session, startedAt: "2026-01-01T00:00:00.000Z" });
    recordRunSettled(root, "run-1", "2026-01-01T00:01:00.000Z");
    recordLaunchLink(root, { runId: "run-2", taskRef: ".trellis/tasks/10-20-demo", sessionId: session, startedAt: "2026-01-01T00:02:00.000Z" });
    recordRunSettled(root, "run-2", "2026-01-01T00:03:00.000Z");
    recordLaunchLink(root, { runId: "run-other", taskRef: ".trellis/tasks/10-20-demo", sessionId: "someone-else", startedAt: "2026-01-01T00:00:00.000Z" });

    const now = Date.parse("2026-01-01T00:10:00.000Z");
    assert.deepEqual(dispatchOverlap(root, session, now), { parallel: 0, serial: 2, unresolved: 0, total: 2 });
    assert.deepEqual(dispatchOverlap(root, "someone-else", now), { parallel: 0, serial: 0, unresolved: 1, total: 1 });
    assert.equal(readSessionLinks(root, session).length, 2);

    // A launch whose completion was never observed stays unknown.
    recordLaunchLink(root, { runId: "run-3", taskRef: ".trellis/tasks/10-20-demo", sessionId: session, startedAt: "2026-01-01T00:04:00.000Z" });
    assert.deepEqual(dispatchOverlap(root, session, now), { parallel: 0, serial: 2, unresolved: 1, total: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlap: re-adopting a link keeps its launch time and its first settle time", () => {
  const root = tempRoot();
  try {
    recordLaunchLink(root, { runId: "run-1", taskRef: ".trellis/tasks/10-20-demo", sessionId: "s", startedAt: "2026-01-01T00:00:00.000Z" });
    // The lane module re-records a link when a handoff path shows up after the fact.
    recordLaunchLink(root, { runId: "run-1", taskRef: ".trellis/tasks/10-20-demo", sessionId: "s", handoffPath: "/tmp/handoff.json" });
    const [link] = readSessionLinks(root, "s");
    assert.equal(link?.startedAt, "2026-01-01T00:00:00.000Z", "recording an update must not move the launch time");
    assert.equal(link?.handoffPath, "/tmp/handoff.json");

    recordRunSettled(root, "run-1", "2026-01-01T00:01:00.000Z");
    recordRunSettled(root, "run-1", "2026-01-01T09:00:00.000Z");
    assert.equal(readSessionLinks(root, "s")[0]?.settledAt, "2026-01-01T00:01:00.000Z", "the first observed completion is the one that happened");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Registration ─────────────────────────────────────────────────────

test("registration: both workflow names land and dispose together", { skip: runnerSkip }, async () => {
  const installed = join(process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents");
  let resources: any = null;
  try {
    resources = await import(new URL(`file://${join(installed, "src", "workflows", "workflow-resources.js")}`).href);
  } catch {
    return;
  }
  const sessionId = `coworkflow-fanout-${process.pid}`;
  const outcome = await registerImplementReviewWorkflow(sessionId, {
    context: () => ({ taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" }),
  });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
  if (!outcome.ok) return;
  try {
    const fanout = resources.resolveWorkflowResource(FANOUT_NAME, { tasks: [{ kind: "executor", task: "x" }] }, sessionId);
    assert.equal(fanout.ok, true, fanout.ok ? "" : fanout.error);
    assert.equal(fanout.resource.provenance.name, FANOUT_NAME);
    assert.equal(fanout.resource.provenance.version, 1);
    const pair = resources.resolveWorkflowResource(WORKFLOW_NAME, { taskRef: ".trellis/tasks/10-20-demo" }, sessionId);
    assert.equal(pair.ok, true, pair.ok ? "" : pair.error);
    // The owner rejects invalid args before any child could start.
    assert.equal(resources.resolveWorkflowResource(FANOUT_NAME, { tasks: [] }, sessionId).ok, false);
  } finally {
    outcome.registration.dispose();
  }

  // Disposal releases both names, so a replacement session can register again.
  assert.equal(resources.resolveWorkflowResource(FANOUT_NAME, { tasks: [{ kind: "executor", task: "x" }] }, sessionId).ok, false);
  assert.equal(resources.resolveWorkflowResource(WORKFLOW_NAME, { taskRef: ".trellis/tasks/10-20-demo" }, sessionId).ok, false);
  const again = await registerImplementReviewWorkflow(sessionId);
  assert.equal(again.ok, true, again.ok ? "" : again.message);
  if (again.ok) again.registration.dispose();
});

test("registration: an owner without the resource export registers neither name", async () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-fanout-owner-"));
  try {
    const pkg = join(root, "node_modules", "pi-subagents");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: { "./workflow-resources": "./workflow.js" } }));
    writeFileSync(join(pkg, "workflow.js"), "export const notRegistration = true;\n");
    const outcome = await registerImplementReviewWorkflow("session-fanout-degraded", { projectRoot: root });
    assert.equal(outcome.ok, false, "a degraded owner must not look like a registration");
    if (!outcome.ok) assert.match(outcome.message, /registerWorkflowResource/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture: the focused test file itself is wired into `npm test`", () => {
  const manifest = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { scripts: { test: string } };
  assert.match(manifest.scripts.test, /scripts\/fanout\.test\.ts/);
});

test("status: /Coworkflow:status renders the overlap line from recorded links, not from a message", async () => {
  const root = tempRoot();
  try {
    process.env.PI_SESSION_ID = undefined;
    const { subagentsModule } = await import("../modules/subagents/index.ts");
    const { createConfigRootResolver } = await import("../core/config.ts");

    let sent = 0;
    const host = {
      on: () => () => {},
      sendMessage: () => { sent += 1; },
      sendUserMessage: () => { sent += 1; },
    } as any;
    const runtime = {
      isChild: false, enabled: true, cwd: root, sessionId: "session-status-overlap", parentSessionId: null,
      sessionEpoch: 1, loadState: "started", configRoots: createConfigRootResolver(),
      control: { moduleEnabled: () => false, subagentConcurrency: () => null },
      refresh: () => {},
    } as any;
    subagentsModule.activate!(host, runtime);
    await Promise.resolve();

    assert.deepEqual(
      (subagentsModule.runtimeStatus!(host) ?? []).filter((line) => line.includes("派单重叠")),
      ["  = subagents: 派单重叠: 本次会话还没有派单记录"],
      "an empty session says nothing was measured, not that everything was serial",
    );

    recordLaunchLink(root, { runId: "run-a", taskRef: ".trellis/tasks/10-20-demo", sessionId: "session-status-overlap", startedAt: new Date(Date.now() - 60_000).toISOString() });
    recordLaunchLink(root, { runId: "run-b", taskRef: ".trellis/tasks/10-20-demo", sessionId: "session-status-overlap", startedAt: new Date(Date.now() - 50_000).toISOString() });
    recordRunSettled(root, "run-a");
    recordRunSettled(root, "run-b");
    assert.ok(
      (subagentsModule.runtimeStatus!(host) ?? []).some((line) => /派单重叠: 2 次并行/.test(line)),
      "two overlaps read back as parallel",
    );

    recordLaunchLink(root, { runId: "run-c", taskRef: ".trellis/tasks/10-20-demo", sessionId: "session-status-overlap", startedAt: new Date().toISOString() });
    assert.ok(
      (subagentsModule.runtimeStatus!(host) ?? []).some((line) => /1 次仍在运行或时间未知/.test(line)),
      "a still-running dispatch is reported as unknown, never as serial",
    );
    assert.equal(sent, 0, "the status line is stored state: nothing was written into the conversation");
    subagentsModule.onSessionEnd!(host, runtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: a fanout dispatch is admitted without a task, while implement-review still requires the verified worktree", { skip: runnerSkip }, async () => {
  const root = tempRoot();
  try {
    const { subagentsModule } = await import("../modules/subagents/index.ts");
    const { createConfigRootResolver } = await import("../core/config.ts");
    const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
    const host = {
      on: (name: string, handler: (event: any, ctx: any) => any) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return () => handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== handler));
      },
      sendMessage: () => {},
      registerCommand: () => {},
    } as any;
    const runtime = {
      isChild: false, enabled: true, cwd: root, sessionId: `session-gate-${process.pid}`, parentSessionId: null,
      sessionEpoch: 1, loadState: "started", configRoots: createConfigRootResolver(),
      control: { moduleEnabled: () => true, subagentConcurrency: () => null },
      refresh: () => {},
    } as any;

    subagentsModule.activate!(host, runtime);
    subagentsModule.onSessionActivate!(host, runtime);
    const { subagentsRuntimeSettled } = await import("../modules/subagents/index.ts");
    await subagentsRuntimeSettled(host);

    const call = async (input: Record<string, unknown>) => {
      const results: any[] = [];
      for (const handler of handlers.get("tool_call") ?? []) results.push(await handler({ toolName: "subagent", toolCallId: "id", input }, {}));
      return results.find((result) => result?.block === true) ?? null;
    };

    // No task is prepared in this temp project.
    const pair = await call({ workflow: WORKFLOW_NAME, args: { taskRef: ".trellis/tasks/10-20-demo" } });
    assert.ok(pair, "the pair is refused without a verified worktree");
    assert.match(pair.reason, /活跃任务工作树/);

    assert.equal(await call({ workflow: FANOUT_NAME, args: { tasks: [{ kind: "executor", task: "x" }] } }), null,
      "a fanout is general-purpose: no task worktree is required");

    // Every other dispatch is untouched — a raw script, another extension's
    // workflow, or a plain direct call returns before this handler judges anything.
    for (const input of [{ workflow: true }, { workflow: "someone.else" }, { agent: "worker", task: "x" }]) {
      assert.equal(await call(input), null, JSON.stringify(input));
    }
    subagentsModule.onSessionEnd!(host, runtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Parallel writers need one worktree each — that is the whole reason a split like
 * "backend → dashboard" gets serialised: both touch the same tree, so they cannot run at
 * the same time. `worktrees: true` removes that constraint instead of asking the caller to
 * remember a launch flag.
 */
test("fanout: worktrees gives every lane its own tree and drops the shared cwd", async () => {
  const script = (worktrees: boolean): string => {
    const expanded = resolveFanout(
      { tasks: [{ kind: "executor", task: "a" }, { kind: "executor", task: "b" }], ...(worktrees ? { worktrees } : {}) },
      { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" },
      allKindsDispatchable() as any,
    );
    if ("error" in expanded) throw new Error(expanded.error);
    return expanded.script;
  };

  const shared = script(false);
  assert.match(shared, /const WORKTREES = false;/);
  assert.match(shared, /worktree: WORKTREES === true,/);

  const parallel = script(true);
  assert.match(parallel, /const WORKTREES = true;/);
  // Neither case hard-codes a directory: with per-lane worktrees upstream allocates
  // each lane its own, and the shared case inherits the cwd the host placed the
  // launch in (the task bound at dispatch time, not the parent's current pointer).
  assert.doesNotMatch(parallel, /const cwd =/, "a shared cwd is exactly what would serialise them");
  assert.doesNotMatch(shared, /const cwd =/, "the shared tree comes from the placed launch, not the script");

  // The flag is validated like every other argument.
  const bad = resolveFanout(
    { tasks: [{ kind: "executor", task: "a" }], worktrees: "yes" },
    { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" },
    allKindsDispatchable() as any,
  );
  assert.ok("error" in bad && /worktrees must be a boolean/.test(bad.error), JSON.stringify(bad));
});

/**
 * Every child is given a deadline it can see, and warned before it arrives.
 *
 * Upstream's backstop is thirty minutes and the child has no way to know it. Measured on
 * this project, a child asked to confirm eight claims one command at a time spent ~150
 * sequential tool calls — at roughly eight seconds a turn that is the entire budget — and
 * several runs were killed *while writing their handoff*, which makes the work unusable
 * rather than merely unfinished.
 */
test("fanout: children get a stated budget and a pre-deadline checkpoint", async () => {
  const script = expand([
    { kind: "executor", task: "a" },
    { kind: "executor", task: "b" },
  ]);
  if (typeof script !== "string") throw new Error(script.error);

  assert.match(script, new RegExp(`const BUDGET_MS = ${RUN_BUDGET_MS};`), "the deadline is stated, not inherited");
  assert.match(script, new RegExp(`const CHECKPOINT_MS = ${RUN_CHECKPOINT_MS};`), "and it warns before it fires");
  assert.match(script, /timeoutMs: BUDGET_MS/, "and is passed to every child");
  assert.match(script, /checkpointBeforeDeadlineMs: CHECKPOINT_MS/, "with the checkpoint armed");
  assert.ok(
    RUN_CHECKPOINT_MS < RUN_BUDGET_MS,
    "a checkpoint at or after the deadline can never land",
  );
  assert.ok(RUN_BUDGET_MS <= 30 * 60 * 1000, "the budget does not exceed the backstop it replaces");

  // The child has to be told, because launch options are not visible from inside a run.
  assert.match(script, /本次运行上限约 25 分钟/);
  assert.match(script, /正在写交接/);
  assert.match(script, /验证合并成尽量少的一次探针/);
});

/**
 * A project's budget reaches the children, and the checkpoint scales with it.
 *
 * The two numbers describe one policy, so the checkpoint is derived: a project that sets a
 * long budget gets a proportionally earlier warning, and one that sets a short budget still
 * gets a warning it can act on rather than one that cannot land inside a tool call.
 */
test("fanout: the project's budget is what the children are given", async () => {
  const budget = 90 * 60 * 1000;
  const expanded = resolveFanout(
    { tasks: [{ kind: "executor", task: "a" }] },
    { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main", runBudgetMs: budget },
    allKindsDispatchable() as any,
  );
  if ("error" in expanded) throw new Error(expanded.error);

  assert.match(expanded.script, new RegExp(`const BUDGET_MS = ${budget};`));
  assert.match(expanded.script, new RegExp(`const CHECKPOINT_MS = ${checkpointFor(budget)};`));
  assert.match(expanded.script, /本次运行上限约 90 分钟/, "the child is told the project's number");
  assert.ok(checkpointFor(budget) < budget, "the warning still precedes the deadline");
  // Short budgets cannot have a checkpoint that outlives them.
  assert.ok(checkpointFor(60_000) < 60_000);
  assert.ok(checkpointFor(60_000) >= 15_000, "but never so short it cannot land");
});

/**
 * The per-kind ceiling covers the package's own recommended dispatch path.
 *
 * It did not: `maxConcurrent` was enforced for `subagent({ agent: "cw-executor" })` and skipped
 * entirely for `coworkflow.fanout`, so a batch of eight executors against a ceiling of two was
 * planned without a word. A limit that the recommended road bypasses is not a limit.
 */
test("fanout: a batch larger than the kind's ceiling is refused by the resolver", async () => {
  const { resolveFanout, FANOUT_NAME } = await import("../core/subagents-workflow.ts");
  const prepared = { taskRef: ".trellis/tasks/x", worktree: "/tmp/wt", mainCheckout: "/tmp/main" };
  const policy = { kinds: [{ kind: "executor", agent: "cw-executor", dispatchable: true, maxConcurrent: 2 }] };
  const batch = (count: number) => ({
    tasks: Array.from({ length: count }, (_, i) => ({ kind: "executor", task: `task ${i}` })),
  });

  // Over the ceiling: refused, and the message names the numbers so it is actionable.
  const refused = resolveFanout(batch(3), prepared as never, policy as never);
  assert.ok("error" in refused, "3 against a ceiling of 2 must not be planned");
  assert.match(refused.error, /3 × kind executor/);
  assert.match(refused.error, /ceiling for it is 2/);
  assert.match(refused.error, /\/Coworkflow:settings/, "and says where to change it");
  assert.equal(FANOUT_NAME, "coworkflow.fanout");

  // At the ceiling: allowed. A ceiling nobody may reach is not a ceiling.
  const allowed = resolveFanout(batch(2), prepared as never, policy as never);
  assert.ok("script" in allowed, "2 against a ceiling of 2 is exactly the limit");

  // A host that did not state a ceiling is not a licence to ignore one: the check simply has
  // nothing to compare, and the gate's live occupancy check is the layer that still applies.
  const unstated = resolveFanout(batch(8), prepared as never, {
    kinds: [{ kind: "executor", agent: "cw-executor", dispatchable: true }],
  } as never);
  assert.ok("script" in unstated, "no ceiling stated, nothing to enforce here");
});
