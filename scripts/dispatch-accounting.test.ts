/**
 * Did this session delegate anything, and can it say so?
 *
 * The dispatch path worked; the account of it did not. A session could run hundreds of tool calls
 * and dispatch nothing, and the only mechanism that ever noticed was a message injected into the
 * conversation — removed because a custom message reaches the model as a *user turn* and rewrites the
 * work it describes. What replaced it answered, in practice, only "unknown": the dispatch intervals
 * were written only for task-linked runs, so a direct dispatch left no trace, and nine links sat
 * unresolved forever.
 *
 * This file drives the production hooks and pins what the facts must be:
 *
 *   - **every dispatch gets an interval**, task or not;
 *   - **the two kinds of ending are distinguished** — a launch receipt is not an end, a foreground
 *     result is;
 *   - **a refused or failed dispatch gets no interval and is counted as not started**, so a session
 *     that delegates nothing cannot look like one that does;
 *   - **workflow children are counted as children**, not as dispatches;
 *   - **availability comes from `getActiveTools` and says so** — `subagent` is `model-only` exposure
 *     and is invisible to `ALL_TOOLS` and `tool_search` by design, which is how this package
 *     published two wrong "no tool" diagnoses;
 *   - **nothing on these paths is injected into the conversation**.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { createConfigRootResolver } from "../core/config.ts";
import { formatDispatchFacts } from "../core/dispatch-timing.ts";
import { readSessionLinks, dispatchOverlap } from "../core/subagents-workflow.ts";
import { subagentsModule } from "../modules/subagents/index.ts";

const SESSION = "session-accounting";

function tempProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-accounting-")));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, modules: {} }));
  return root;
}

interface Harness {
  root: string;
  emit(name: string, event: Record<string, unknown>): Promise<void>;
  status(): string[];
  messages: string[];
  close(): void;
}

/** Drive the production module: its own activation, its own hooks, the host firing them. */
function harness(options: { activeTools?: string[] } = {}): Harness {
  const root = tempProject();
  const listeners = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const messages: string[] = [];
  const host = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
    sendMessage(message: { content: string }) { messages.push(message.content); },
    ...(options.activeTools === undefined ? {} : { getActiveTools: () => options.activeTools }),
  } as unknown as PiRuntimeHost;
  const runtime = {
    cwd: root, sessionId: SESSION, sessionEpoch: 1, enabled: true, isChild: false,
    loadState: "auto", refresh() {},
    configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
    control: { moduleEnabled: () => true, subagentConcurrency: () => null },
  } as unknown as RuntimeContext;
  subagentsModule.activate?.(host, runtime);
  return {
    root,
    async emit(name, event) {
      for (const handler of listeners.get(name) ?? []) await handler(event, {});
    },
    status: () => subagentsModule.runtimeStatus?.(host) ?? [],
    messages,
    close() {
      subagentsModule.onSessionEnd?.(host, runtime);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The facts line, as `/Coworkflow:status` renders it. */
function factsOf(lines: readonly string[]): string {
  return lines.find((line) => line.includes("工具调用")) ?? "";
}

test("accounting: a dispatch with no task still gets a counted interval", async () => {
  const h = harness();
  try {
    await h.emit("tool_call", { toolName: "read", toolCallId: "c1", input: { path: "x" } });
    await h.emit("tool_call", { toolName: "subagent", toolCallId: "c2", input: { agent: "cw-executor", task: "x" } });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "c2", details: { runId: "run-1" } });

    const link = readSessionLinks(h.root, SESSION).find((entry) => entry.runId === "run-1");
    assert.ok(link, "a dispatch without a task is recorded — this is the case that used to leave no trace");
    assert.equal(link.taskRef, "", "and it belongs to no task");
    assert.ok(link.startedAt, "with a start time");
    assert.equal(link.settledAt, undefined, "an async dispatch's receipt is not an end");

    const facts = factsOf(h.status());
    assert.match(facts, /工具调用 2 次/, facts);
    assert.match(facts, /派单 1 次/, facts);
  } finally {
    h.close();
  }
});

test("accounting: an async dispatch settles at its completion, a foreground one at its result", async () => {
  const h = harness();
  try {
    // Async: open at the receipt, closed by the completion notice.
    await h.emit("tool_call", { toolName: "subagent", toolCallId: "a1", input: { agent: "cw-executor", task: "x" } });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "a1", details: { runId: "run-async" } });
    assert.equal(readSessionLinks(h.root, SESSION).find((e) => e.runId === "run-async")?.settledAt, undefined);
    await h.emit("message_end", { message: { customType: "subagent-notify", details: { runs: [{ runId: "run-async", status: "completed" }] } } });
    assert.ok(
      readSessionLinks(h.root, SESSION).find((e) => e.runId === "run-async")?.settledAt,
      "the completion closes the interval",
    );

    // Foreground: the result IS the end.
    await h.emit("tool_call", { toolName: "subagent", toolCallId: "a2", input: { agent: "cw-executor", task: "x", async: false } });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "a2", details: { runId: "run-fg" } });
    assert.ok(
      readSessionLinks(h.root, SESSION).find((e) => e.runId === "run-fg")?.settledAt,
      "a foreground result closes it immediately",
    );

    // And the measurement can finally classify something: two dispatches, no longer all "unknown".
    const overlap = dispatchOverlap(h.root, SESSION);
    assert.equal(overlap.unresolved, 0, "nothing is stuck in unknown any more");
    assert.equal(overlap.total, 2);
  } finally {
    h.close();
  }
});

test("accounting: a refused dispatch gets no interval and is counted as not started", async () => {
  const h = harness();
  try {
    await h.emit("tool_call", { toolName: "subagent", toolCallId: "r1", input: { agent: "cw-auditor", task: "x" } });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "r1", isError: true });

    assert.equal(
      readSessionLinks(h.root, SESSION).length,
      0,
      "a dispatch that never ran has no place on a timeline",
    );
    const facts = factsOf(h.status());
    assert.match(facts, /派单 0 次/, facts);
    assert.match(facts, /1 次没有启动/, facts);
  } finally {
    h.close();
  }
});

test("accounting: a workflow is one dispatch and N children, not N dispatches", async () => {
  const h = harness();
  try {
    await h.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "f1",
      input: { workflow: "coworkflow.fanout", args: { tasks: [{ kind: "executor", task: "a" }, { kind: "executor", task: "b" }, { kind: "auditor", task: "c" }] } },
    });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "f1", details: { runId: "wf-1" } });
    const facts = factsOf(h.status());
    assert.match(facts, /派单 1 次/, facts);
    assert.match(facts, /共启动 3 个子 agent/, facts);

    // implement-review is two sequential steps.
    await h.emit("tool_call", { toolName: "subagent", toolCallId: "f2", input: { workflow: "coworkflow.implement-review" } });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "f2", details: { runId: "wf-2" } });
    assert.match(factsOf(h.status()), /共启动 5 个子 agent/);
  } finally {
    h.close();
  }
});

test("accounting: availability comes from getActiveTools, and says so in all three states", () => {
  // Present: says where it read it.
  assert.match(
    formatDispatchFacts({ toolCalls: 1, dispatches: 0, children: 0, notStarted: 0, toolAvailable: true }),
    /派单工具可用（读自 getActiveTools）/,
  );
  // Absent: the same source, and no advice dressed as a diagnosis.
  assert.match(
    formatDispatchFacts({ toolCalls: 1, dispatches: 0, children: 0, notStarted: 0, toolAvailable: false }),
    /不在本会话的工具列表里（读自 getActiveTools）/,
  );
  // Unknowable: must not become "absent". This is the exact claim that was published twice by
  // leaning on ALL_TOOLS / tool_search, which cannot see model-only exposure.
  const unknown = formatDispatchFacts({ toolCalls: 1, dispatches: 0, children: 0, notStarted: 0, toolAvailable: null });
  assert.match(unknown, /无法确定/);
  assert.match(unknown, /ALL_TOOLS/);
  assert.doesNotMatch(unknown, /不在本会话的工具列表里/, "cannot-tell must never be reported as absent");

  // Nothing dispatched: say that plainly rather than showing a bare zero.
  const none = formatDispatchFacts({ toolCalls: 350, dispatches: 0, children: 0, notStarted: 0, toolAvailable: true });
  assert.match(none, /工具调用 350 次/);
  assert.match(none, /派单 0 次/);
  assert.match(none, /全部由主会话自己做完/);
});

test("accounting: none of these paths injects a message into the conversation", async () => {
  const h = harness();
  try {
    await h.emit("tool_call", { toolName: "subagent", toolCallId: "m1", input: { agent: "cw-executor", task: "x" } });
    await h.emit("tool_result", { toolName: "subagent", toolCallId: "m1", details: { runId: "run-m" } });
    await h.emit("message_end", { message: { customType: "subagent-notify", details: { runs: [{ runId: "run-m", status: "completed" }] } } });
    h.status();
    assert.deepEqual(h.messages, [], "a fact goes to a status line, never to a user turn");
  } finally {
    h.close();
  }
});
