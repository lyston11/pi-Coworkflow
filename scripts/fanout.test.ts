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
  WORKFLOW_NAME,
  dispatchOverlap,
  readSessionLinks,
  recordLaunchLink,
  recordRunSettled,
  registerImplementReviewWorkflow,
  resolveFanout,
} from "../core/subagents-workflow.ts";
import { formatOverlapLine, summarizeOverlap } from "../core/dispatch-timing.ts";

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

function expand(tasks: unknown, extra: Record<string, unknown> = {}): string | { error: string } {
  const expanded = resolveFanout({ tasks, ...extra }, { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" });
  return "script" in expanded ? expanded.script : expanded;
}

function scriptOf(tasks: unknown, extra: Record<string, unknown> = {}): string {
  const expanded = expand(tasks, extra);
  assert.equal(typeof expanded, "string", typeof expanded === "string" ? "" : expanded.error);
  return expanded as string;
}

// ── Validation ───────────────────────────────────────────────────────

test("fanout: args are validated as strictly as the implement/review resource", () => {
  // Count is bounded on both ends: zero tasks is not a fanout, and a large one is
  // not independent work the parent can audit.
  for (const tasks of [[], undefined, null, "nope", {}, [...Array(9)].map((_, index) => ({ agent: "worker", task: `t${index}` }))]) {
    const expanded = expand(tasks);
    assert.equal(typeof expanded, "object", `must reject ${JSON.stringify(tasks)?.slice(0, 40)}`);
  }
  // One task is fine: a fanout of one is a named script, not an error.
  assert.equal(typeof expand([{ agent: "worker", task: "do it" }]), "string");

  const rejections: [unknown, RegExp][] = [
    [[{ agent: "", task: "x" }], /tasks\[0\]\.agent/],
    [[{ agent: "   ", task: "x" }], /tasks\[0\]\.agent/],
    [[{ agent: "worker", task: "" }], /tasks\[0\]\.task/],
    [[{ agent: "worker", task: "   " }], /tasks\[0\]\.task/],
    [[{ agent: "worker", task: 7 }], /tasks\[0\]\.task/],
    [[{ agent: "work er", task: "x" }], /tasks\[0\]\.agent/],
    [[{ agent: "worker", task: "x", model: "m" }], /tasks\[0\] contains unsupported fields: model/],
    [[{ task: "x" }], /tasks\[0\]\.agent/],
    [["worker"], /tasks\[0\] must be a \{ agent, task \} object/],
    [[{ agent: "worker", task: "x" }, null], /tasks\[1\] must be a \{ agent, task \} object/],
    [[{ agent: "worker", task: "x".repeat(8001) }], /tasks\[0\]\.task/],
  ];
  for (const [tasks, expected] of rejections) {
    const expanded = expand(tasks);
    assert.equal(typeof expanded, "object", JSON.stringify(tasks).slice(0, 60));
    if (typeof expanded === "object") assert.match(expanded.error, expected);
  }

  // Unknown top-level fields are rejected, including the ones a caller might hope
  // would override the host's own verification.
  for (const [args, expected] of [
    [{ tasks: [{ agent: "worker", task: "x" }], worktree: "/elsewhere" }, /unsupported fields: worktree/],
    [{ tasks: [{ agent: "worker", task: "x" }], script: "return 1" }, /unsupported fields: script/],
    [{ tasks: [{ agent: "worker", task: "x" }], focus: "" }, /args\.focus/],
    [{ tasks: [{ agent: "worker", task: "x" }], focus: "y".repeat(2001) }, /args\.focus/],
    [{}, /args\.tasks/],
  ] as [Record<string, unknown>, RegExp][]) {
    const expanded = resolveFanout(args, { taskRef: ".trellis/tasks/10-20-demo", worktree: TWD, mainCheckout: "/tmp/main" });
    assert.ok("error" in expanded, JSON.stringify(args).slice(0, 60));
    if ("error" in expanded) assert.match(expanded.error, expected);
  }
});

test("fanout: keys come from position, so two identical tasks are two children", () => {
  const script = scriptOf([{ agent: "worker", task: "same" }, { agent: "worker", task: "same" }]);
  assert.match(script, /"key":"task-1"/);
  assert.match(script, /"key":"task-2"/);
  // The task text is interpolated as JSON data, never as code.
  assert.doesNotMatch(script, /^\s*task:\s*same/m);
});

// ── Concurrency ──────────────────────────────────────────────────────

test("fanout: three tasks start together — the third starts before the first finishes", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }, { agent: "coworkflow-auditor", task: "c" }]);
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
    assert.equal(call.cwd, TWD, "children run in the host-verified worktree");
    assert.equal((call.acceptance as Record<string, unknown>).level, "checked");
    assert.equal((call.outputSchema as Record<string, unknown>).type, "object");
    assert.equal(call.async, undefined);
  }
  assert.equal(params["task-3"]!.agent, "coworkflow-auditor");

  const value = result.value as Record<string, any>;
  assert.equal(value.status, "completed");
  assert.equal(value.acceptance, "parent-owned", "a green fanout is not an accepted change");
  assert.match(String(value.note), /不代表验收通过/);
  assert.equal(value.concurrency, "parallel");
  assert.deepEqual(value.results.map((entry: any) => entry.key), ["task-1", "task-2", "task-3"]);
  assert.deepEqual(value.results.map((entry: any) => entry.ok), [true, true, true]);
  assert.equal(value.results[0].handoff, "handoff task-1");
});

test("fanout: a failing child does not cancel its siblings and is reported as that task's failure", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }, { agent: "worker", task: "c" }]);
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
  assert.equal(second.agent, "worker");
  assert.equal(second.runId, null, "a rejected child has no identity the sandbox can read: absent, not borrowed from a sibling");
  assert.equal(third.ok, true, "a sibling keeps working after another child failed");
  assert.equal(third.runId, "run-task-3", "the sibling keeps its own run identity");
});

test("fanout: a child that reports no usable verdict is a failed task, not a silent pass", { skip: runnerSkip }, async () => {
  const script = scriptOf([{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }]);
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
  const script = scriptOf([{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }]);
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
  const script = scriptOf([{ agent: "worker", task: "a" }]);
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
    const fanout = resources.resolveWorkflowResource(FANOUT_NAME, { tasks: [{ agent: "worker", task: "x" }] }, sessionId);
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
  assert.equal(resources.resolveWorkflowResource(FANOUT_NAME, { tasks: [{ agent: "worker", task: "x" }] }, sessionId).ok, false);
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

    assert.equal(await call({ workflow: FANOUT_NAME, args: { tasks: [{ agent: "worker", task: "x" }] } }), null,
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
