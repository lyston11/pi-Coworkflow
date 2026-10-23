/**
 * The queued dispatch channel: hand over every work unit at once.
 *
 * The behaviour that has to be true, and is driven here with an injected adapter
 * instead of real children (nothing in this file spawns a process):
 *
 *   - a ceiling of 2 with 4 units submitted leaves 2 running and 2 waiting, and
 *     **one completion starts the third by itself** — no timer, no polling, no
 *     second call from the model;
 *   - `needs` keeps a unit waiting (`reason: "dependency"`) until every
 *     prerequisite is `completed`, and a failed prerequisite fails its dependents
 *     instead of leaving them in a queue that can never run;
 *   - a refusal that waiting cannot fix (`disabled`, `unregistered`,
 *     `unknown-count`, `session-gone`) is a **failure**, not a place in line;
 *   - a session replacement invalidates what the previous session had queued and
 *     **reports** it, rather than showing an empty queue as if nothing was lost;
 *   - the queue's admission is `admitOne()`'s — the same refusal code a direct
 *     dispatch gets for the same kind in the same state.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { createConfigRootResolver } from "../core/config.ts";
import { admitOne, agentKindsState } from "../modules/agent-kinds/index.ts";
import {
  admitDispatch,
  createDispatchQueue,
  dispatchModule,
  renderDispatchResult,
  type DispatchDeps,
  type LaunchRequest,
} from "../modules/dispatch/index.ts";
import type { AdmitResult } from "../modules/agent-kinds/index.ts";

function tempProject(config: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-dispatch-")));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, ...config }));
  return root;
}

/**
 * The owner, faked down to the two facts the queue needs: how many of a kind are
 * running, and what a launch returns. A real fleet read would make these tests
 * depend on an installed pi-subagents and on wall-clock visibility, which is
 * exactly what the channel must not depend on.
 */
function fakeOwner(limits: Record<string, number>) {
  const running = new Map<string, number>();
  const launches: LaunchRequest[] = [];
  const runIdFor = new Map<string, string>();
  const deps: DispatchDeps = {
    async admit(kind: string): Promise<AdmitResult> {
      const limit = limits[kind] ?? 5;
      const occupancy = running.get(kind) ?? 0;
      if (occupancy + 1 > limit) {
        return { ok: false, failure: { code: "over-ceiling", limit, occupancy, requested: 1 } };
      }
      return {
        ok: true,
        kind,
        policy: { kind, agent: `cw-${kind}`, label: kind, enabled: true, maxConcurrent: limit, source: "shipped" } as never,
        config: null,
      };
    },
    async launch(request: LaunchRequest) {
      launches.push(request);
      running.set(request.kind, (running.get(request.kind) ?? 0) + 1);
      const runId = `run-${request.key}`;
      runIdFor.set(request.key, runId);
      return { ok: true as const, runId };
    },
  };
  return {
    deps,
    launches,
    /** What the owner does when a run ends: the slot frees, and the completion is observed. */
    finish(kind: string): void {
      running.set(kind, Math.max(0, (running.get(kind) ?? 1) - 1));
    },
    runId(key: string): string {
      return runIdFor.get(key) ?? "";
    },
  };
}

const units = (...keys: string[]) =>
  keys.map((key) => ({ key, kind: "executor", task: `do ${key}` }));

test("queue: a ceiling of 2 with 4 units starts 2, and one completion starts the 3rd", async () => {
  const owner = fakeOwner({ executor: 2 });
  const queue = createDispatchQueue(owner.deps, 1);

  const first = await queue.submit({ tasks: units("a", "b", "c", "d") });
  assert.deepEqual(first.started.map((entry) => entry.key), ["a", "b"]);
  assert.deepEqual(first.queued.map((entry) => [entry.key, entry.reason]), [["c", "ceiling"], ["d", "ceiling"]]);
  assert.deepEqual(first.failed, []);

  // One run ends. Nobody asks the queue to continue: the completion itself does.
  owner.finish("executor");
  const second = await queue.settle(owner.runId("a"), "completed");
  assert.deepEqual(second.started.map((entry) => entry.key), ["c"], "the third starts on its own");
  assert.deepEqual(second.queued.map((entry) => entry.key), ["d"], "the fourth still waits");

  const line = queue.statusLines()[0] ?? "";
  assert.match(line, /dispatch: 2 运行 \/ 1 排队（ceiling 1）/, line);
});

test("queue: needs keeps a unit waiting until every prerequisite is completed", async () => {
  const owner = fakeOwner({ executor: 2 });
  const queue = createDispatchQueue(owner.deps, 1);

  const first = await queue.submit({
    tasks: [
      { key: "build", kind: "executor", task: "build it" },
      { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
    ],
  });
  assert.deepEqual(first.started.map((entry) => entry.key), ["build"]);
  assert.deepEqual(first.queued.map((entry) => [entry.key, entry.reason]), [["audit", "dependency"]]);

  owner.finish("executor");
  const second = await queue.settle(owner.runId("build"), "completed");
  assert.deepEqual(second.started.map((entry) => entry.key), ["audit"], "a satisfied need starts it");
});

test("queue: a failed prerequisite fails its dependents instead of queueing them forever", async () => {
  const owner = fakeOwner({ executor: 2 });
  const queue = createDispatchQueue(owner.deps, 1);

  await queue.submit({
    tasks: [
      { key: "build", kind: "executor", task: "build it" },
      { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      { key: "ship", kind: "executor", task: "ship it", needs: ["audit"] },
    ],
  });
  owner.finish("executor");
  const result = await queue.settle(owner.runId("build"), "failed");
  assert.deepEqual(result.failed.map((entry) => [entry.key, entry.reason]), [
    ["build", "run 失败"],
    ["audit", "dependency"],
    ["ship", "dependency"],
  ]);
  assert.deepEqual(result.started, []);
});

test("queue: a refusal that waiting cannot fix is a failure, not a place in line", async () => {
  const owner = fakeOwner({ executor: 2 });
  const queue = createDispatchQueue(owner.deps, 1);
  const refused: DispatchDeps = {
    admit: async (kind) =>
      kind === "auditor"
        ? { ok: false, failure: { code: "disabled", available: ["cw-executor"] } }
        : owner.deps.admit(kind),
    launch: owner.deps.launch,
  };
  const queueWith = createDispatchQueue(refused, 1);

  const result = await queueWith.submit({
    tasks: [
      { key: "a", kind: "executor", task: "run" },
      { key: "b", kind: "auditor", task: "review" },
    ],
  });
  assert.deepEqual(result.started.map((entry) => entry.key), ["a"]);
  assert.deepEqual(result.queued, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.key, "b");
  assert.match(String(result.failed[0]?.reason), /已关闭/);
  void queue;
});

test("queue: a session replacement invalidates the queue and reports what it discarded", async () => {
  const owner = fakeOwner({ executor: 2 });
  const queue = createDispatchQueue(owner.deps, 1);
  await queue.submit({ tasks: units("a", "b", "c", "d") });

  const invalidated = queue.bindSession(2);
  assert.deepEqual(invalidated, { running: 2, queued: 2 });
  assert.deepEqual(queue.snapshot().running, [], "the old session's runs are not this session's queue");
  const lines = queue.statusLines();
  assert.ok(lines.some((line) => line.includes("会话换代作废了上一代队列")), lines.join("\n"));
  assert.match(lines[0] ?? "", /dispatch: 0 运行 \/ 0 排队/, "the current session really is empty");
  // Nothing in flight in the new session, so nothing is left to report.
  assert.equal(queue.bindSession(3), null);
});

test("admission: the queue asks admitOne, so both give the same refusal for the same kind", async () => {
  const root = tempProject({ agentKinds: { executor: { enabled: false } } });
  const resolver = createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) });
  const runtime = {
    isChild: false,
    enabled: true,
    cwd: root,
    sessionId: "session-dispatch",
    parentSessionId: null,
    sessionEpoch: 1,
    loadState: "auto",
    configRoots: resolver,
    refresh() {},
    control: { moduleEnabled: () => true, subagentConcurrency: () => null },
  } as unknown as RuntimeContext;
  const host = { events: { emit() {}, on: () => () => {} } } as unknown as PiRuntimeHost;
  try {
    // The state the queue would use, obtained the way the queue obtains it.
    const direct = await admitOne(host, agentKindsState(host), runtime, { kind: "executor", count: 1 });
    const state = { runtime, queue: null, listeners: [], toolRegistered: false };
    const viaChannel = await admitDispatch(host, state, runtime, "executor");
    assert.equal(direct.ok, false);
    assert.equal(viaChannel.ok, false);
    assert.equal(
      (direct as { failure: { code: string } }).failure.code,
      (viaChannel as { failure: { code: string } }).failure.code,
      "one admission authority: the channel cannot refuse for a different reason",
    );
    assert.equal((viaChannel as { failure: { code: string } }).failure.code, "disabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report: what started, what waits and why is readable without the tool result object", async () => {
  const owner = fakeOwner({ executor: 1 });
  const queue = createDispatchQueue(owner.deps, 1);
  const result = await queue.submit({ tasks: units("a", "b") });
  const body = renderDispatchResult(result);
  assert.match(body, /1 已启动 \/ 1 排队 \/ 0 失败/);
  assert.match(body, /\+ a（kind executor）runId run-a/);
  assert.match(body, /… b（kind executor）排队：名额已满/);
});

test("tool: activation registers coworkflow.dispatch once and releases its observers on session end", () => {
  const root = tempProject({});
  const resolver = createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) });
  const runtime = {
    isChild: false,
    enabled: true,
    cwd: root,
    sessionId: "session-tool",
    parentSessionId: null,
    sessionEpoch: 1,
    loadState: "auto",
    configRoots: resolver,
    refresh() {},
    control: { moduleEnabled: () => true, subagentConcurrency: () => null },
  } as unknown as RuntimeContext;
  const tools: { name: string; parameters: Record<string, unknown> }[] = [];
  const listeners: (() => void)[] = [];
  const host = {
    events: {
      emit() {},
      on() {
        const off = () => {
          const index = listeners.indexOf(off);
          if (index !== -1) listeners.splice(index, 1);
        };
        listeners.push(off);
        return off;
      },
    },
    on() {
      const off = () => {
        const index = listeners.indexOf(off);
        if (index !== -1) listeners.splice(index, 1);
      };
      listeners.push(off);
      return off;
    },
    registerTool(definition: { name: string; parameters: Record<string, unknown> }) {
      tools.push(definition);
    },
  } as unknown as PiRuntimeHost;
  try {
    dispatchModule.activate!(host, runtime);
    dispatchModule.activate!(host, runtime);
    assert.deepEqual(tools.map((tool) => tool.name), ["coworkflow.dispatch"], "one registration per session");
    assert.ok(JSON.stringify(tools[0]?.parameters).includes('"needs"'), "needs is part of the tool schema");
    dispatchModule.onSessionEnd!(host, runtime);
    assert.deepEqual(listeners, [], "nothing is left observing the next session");
    assert.ok((dispatchModule.runtimeStatus!(host) ?? []).length > 0, "status still answers after a session end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
