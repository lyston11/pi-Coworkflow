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

test("queue: closing the gate preserves failure and uncertain-launch reports", async () => {
  const owner = fakeOwner({ executor: 4 });
  let open = true;
  const queue = createDispatchQueue({
    ...owner.deps,
    gate: () => open ? null : "disabled",
    launch: async (request) => request.key === "uncertain"
      ? { ok: false, reason: "receipt lost", disposition: "unobserved" }
      : owner.deps.launch(request),
  }, 1);
  await queue.submit({ tasks: [
    ...units("a", "uncertain"),
    { key: "dependent", kind: "executor", task: "review a", needs: ["a"] },
  ] });
  open = false;
  const result = await queue.settle(owner.runId("a"), "failed");
  assert.deepEqual(result.failed.map(entry => entry.key), ["a", "dependent"]);
  assert.deepEqual(result.unobserved, [{ key: "uncertain", kind: "executor", detail: "receipt lost" }]);
  assert.deepEqual(result.failed, queue.snapshot().failed);
  assert.deepEqual(result.unobserved, queue.snapshot().unobserved);
  assert.equal(owner.launches.length, 1, "closed gate does not start the dependent");
});

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

test("queue: a launch-failure cascade is reported as failed, never as still queued", async () => {
  // The shape a real smoke produced: every launch is refused outright, and `d` needs
  // `a`. The cascade fails `d` after this pass already decided it was "waiting for a
  // prerequisite", so the response used to contradict the snapshot it came from.
  const refused: DispatchDeps = {
    async admit(kind: string): Promise<AdmitResult> {
      return {
        ok: true,
        kind,
        policy: { kind, agent: `cw-${kind}`, label: kind, enabled: true, maxConcurrent: 5, source: "shipped" } as never,
        config: null,
      };
    },
    async launch() {
      return { ok: false as const, reason: "pi-subagents 拒绝了这个 spawn：缺少 provider 配置" };
    },
  };
  const queue = createDispatchQueue(refused, 1);
  const result = await queue.submit({
    tasks: [
      { key: "a", kind: "executor", task: "do a" },
      { key: "b", kind: "executor", task: "do b" },
      { key: "c", kind: "executor", task: "do c" },
      { key: "d", kind: "executor", task: "do d", needs: ["a"] },
    ],
  });

  assert.deepEqual(result.started, []);
  assert.deepEqual(result.queued, [], "the cascade failed d, so nothing is still waiting");
  assert.deepEqual(
    result.failed.map((entry) => [entry.key, entry.reason]),
    [
      ["a", "pi-subagents 拒绝了这个 spawn：缺少 provider 配置"],
      ["b", "pi-subagents 拒绝了这个 spawn：缺少 provider 配置"],
      ["c", "pi-subagents 拒绝了这个 spawn：缺少 provider 配置"],
      ["d", "dependency"],
    ],
  );
  // The response is the snapshot, not a mid-loop guess.
  const snapshot = queue.snapshot();
  assert.deepEqual(result.queued, snapshot.queued);
  assert.deepEqual(result.failed, snapshot.failed);
  assert.deepEqual(result.unobserved, snapshot.unobserved);
  const body = renderDispatchResult(result);
  assert.match(body, /0 已启动 \/ 0 排队 \/ 0 启动未确认 \/ 4 失败/, body);
  assert.match(body, /x d（kind executor）失败：dependency/, body);
  assert.doesNotMatch(body, /… d/, "a cascade failure must not also be listed as waiting");
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
  assert.deepEqual(invalidated, { running: 2, queued: 2, unobserved: 0 });
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
  assert.match(body, /1 已启动 \/ 1 排队 \/ 0 启动未确认 \/ 0 失败/);
  assert.match(body, /\+ a（kind executor）runId run-a/);
  assert.match(body, /… b（kind executor）排队：名额已满/);
});

// ── launches whose outcome is unknown belong in the result, not only the status ──

/** A launch whose request was emitted and whose outcome nobody can prove. */
const unconfirmedLaunch = (): DispatchDeps => ({
  async admit(kind: string): Promise<AdmitResult> {
    return {
      ok: true,
      kind,
      policy: { kind, agent: `cw-${kind}`, label: kind, enabled: true, maxConcurrent: 5, source: "shipped" } as never,
      config: null,
    };
  },
  async launch() {
    return { ok: false as const, reason: "spawn 超时，可能已经在跑", disposition: "unobserved" as const };
  },
});

test("queue: an unconfirmed launch is reported in the result itself, not only in status lines", async () => {
  const queue = createDispatchQueue(unconfirmedLaunch(), 1);
  const result = await queue.submit({ tasks: units("a") });
  // The defect this pins: the unit used to appear in no list at all, so the result
  // read `0 已启动 / 0 排队 / 0 失败` for work that may well be running.
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.failed, [], "an unconfirmed launch is not a proven failure");
  assert.deepEqual(result.unobserved.map((entry) => entry.key), ["a"]);
  const body = renderDispatchResult(result);
  assert.match(body, /0 已启动 \/ 0 排队 \/ 1 启动未确认 \/ 0 失败/, body);
  assert.match(body, /\? a（kind executor）启动未确认/, body);
  assert.match(body, /不会重发/, body);
  assert.deepEqual(queue.snapshot().unobserved.map((entry) => entry.key), ["a"]);
});

test("queue: a session replacement counts unconfirmed launches instead of erasing them", async () => {
  const queue = createDispatchQueue(unconfirmedLaunch(), 1);
  await queue.submit({ tasks: units("a", "b") });
  const invalidated = queue.bindSession(2);
  assert.deepEqual(invalidated, { running: 0, queued: 0, unobserved: 2 });
  const lines = queue.statusLines().join("\n");
  assert.match(lines, /2 启动未确认/, lines);
  assert.doesNotMatch(lines, /dispatch: 0 运行 \/ 0 排队（/, "the replacement is not reported as a clean empty queue");
});

// ── the operation's epoch, not the queue's, decides whether it may start ──

/** A queue whose admission is held open so a session replacement can land inside it. */
function deferredAdmit(limits: Record<string, number> = { executor: 5 }) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launches: LaunchRequest[] = [];
  const deps: DispatchDeps = {
    async admit(kind: string): Promise<AdmitResult> {
      await held;
      const limit = limits[kind] ?? 5;
      return {
        ok: true,
        kind,
        policy: { kind, agent: `cw-${kind}`, label: kind, enabled: true, maxConcurrent: limit, source: "shipped" } as never,
        config: null,
      };
    },
    async launch(request: LaunchRequest) {
      launches.push(request);
      return { ok: true as const, runId: `run-${request.key}` };
    },
  };
  return { deps, launches, release: () => release() };
}

const settleTick = () => new Promise((resolve) => setImmediate(resolve));

test("queue: a replacement during an awaited admission drops that submission instead of launching", async () => {
  const held = deferredAdmit();
  const queue = createDispatchQueue(held.deps, 1);
  const submission = queue.submit({ tasks: units("a") });
  await settleTick();
  queue.bindSession(2);
  held.release();
  await assert.rejects(submission, /会话已更换/, "the old submission must not be adopted by the new session");
  assert.deepEqual(held.launches, [], "nothing launches into the session that replaced it");
  assert.equal(queue.epoch, 2);
  assert.deepEqual(queue.snapshot().queued, []);
});

test("queue: an old submission queued behind a deferred admission is dropped too", async () => {
  const held = deferredAdmit();
  const queue = createDispatchQueue(held.deps, 1);
  // Both calls are made in epoch 1; the second is still waiting in the serial chain
  // when the session is replaced, which is exactly the window that used to relaunch.
  const first = queue.submit({ tasks: units("a") });
  const second = queue.submit({ tasks: units("b") });
  await settleTick();
  queue.bindSession(2);
  held.release();
  await assert.rejects(first, /会话已更换/);
  await assert.rejects(second, /会话已更换/);
  assert.deepEqual(held.launches, [], "an old queued submit cannot start in the new epoch");
});

test("queue: a replacement during an awaited settlement starts nothing either", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deferNext = false;
  const launches: LaunchRequest[] = [];
  const deps: DispatchDeps = {
    async admit(kind: string): Promise<AdmitResult> {
      if (deferNext) await held;
      return {
        ok: true,
        kind,
        policy: { kind, agent: `cw-${kind}`, label: kind, enabled: true, maxConcurrent: 5, source: "shipped" } as never,
        config: null,
      };
    },
    async launch(request: LaunchRequest) {
      launches.push(request);
      return { ok: true as const, runId: `run-${request.key}` };
    },
  };
  const queue = createDispatchQueue(deps, 1);
  await queue.submit({
    tasks: [
      { key: "a", kind: "executor", task: "do a" },
      { key: "b", kind: "executor", task: "do b", needs: ["a"] },
    ],
  });
  assert.deepEqual(launches.map((entry) => entry.key), ["a"]);

  // The completion frees the slot, so its pass awaits the admission of `b`.
  deferNext = true;
  const settlement = queue.settle("run-a", "completed");
  await settleTick();
  queue.bindSession(2);
  release();
  const settled = await settlement;
  assert.deepEqual(launches.map((entry) => entry.key), ["a"], "a stale completion starts nothing in the next epoch");
  assert.equal(settled.stale, true, "the caller can tell the operation was dropped");
});

test("tool: activation registers coworkflow_dispatch once and releases its observers on session end", () => {
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
    assert.deepEqual(tools.map((tool) => tool.name), ["coworkflow_dispatch"], "one registration per session");
    assert.ok(JSON.stringify(tools[0]?.parameters).includes('"needs"'), "needs is part of the tool schema");
    // The queue enforces `files`, so the one entry point that can reach it must accept it:
    // a schema without the field made the whole overlap check unreachable from the tool.
    assert.ok(JSON.stringify(tools[0]?.parameters).includes('"files"'), "files is part of the tool schema");
    dispatchModule.onSessionEnd!(host, runtime);
    assert.deepEqual(listeners, [], "nothing is left observing the next session");
    assert.ok((dispatchModule.runtimeStatus!(host) ?? []).length > 0, "status still answers after a session end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── declared write sets: what the queue can enforce, and what it must say out loud ──

const declared = (key: string, files: string[]) => ({ key, kind: "executor", task: `do ${key}`, files });

test("queue: two units declaring one file do not run at the same time", async () => {
  const owner = fakeOwner({ executor: 4 });
  const queue = createDispatchQueue(owner.deps, 1);

  const first = await queue.submit({ tasks: [declared("a", ["src/dispatch/index.ts"]), declared("b", ["src/dispatch/index.ts"])] });
  assert.deepEqual(first.started.map((entry) => entry.key), ["a"]);
  assert.deepEqual(first.queued.map((entry) => [entry.key, entry.reason]), [["b", "overlap"]]);

  // The completion itself releases it — no timer, no second submission.
  owner.finish("executor");
  const second = await queue.settle(owner.runId("a"), "completed");
  assert.deepEqual(second.started.map((entry) => entry.key), ["b"], "the collision waits, then runs alone");
});

test("queue: disjoint declarations still run in parallel, and a declared directory covers its children", async () => {
  const owner = fakeOwner({ executor: 4 });
  const queue = createDispatchQueue(owner.deps, 1);

  const parallel = await queue.submit({ tasks: [declared("a", ["src/dispatch/index.ts"]), declared("b", ["modules/panel/index.ts"])] });
  assert.deepEqual(parallel.started.map((entry) => entry.key), ["a", "b"], "different files are not a collision");

  const nestedQueue = createDispatchQueue(fakeOwner({ executor: 4 }).deps, 1);
  const nested = await nestedQueue.submit({ tasks: [declared("c", ["src/dispatch"]), declared("d", ["src/dispatch/index.ts"])] });
  assert.deepEqual(nested.started.map((entry) => entry.key), ["c"], "a declared directory covers its files");
  assert.deepEqual(nested.queued.map((entry) => [entry.key, entry.reason]), [["d", "overlap"]]);
});

test("queue: a read-only unit declares files: [] and never collides", async () => {
  const owner = fakeOwner({ executor: 4 });
  const queue = createDispatchQueue(owner.deps, 1);

  const result = await queue.submit({ tasks: [declared("writer", ["src/a.ts"]), declared("reader", []), declared("reader2", [])] });
  assert.deepEqual(result.started.map((entry) => entry.key), ["writer", "reader", "reader2"]);
  assert.equal(result.notice, undefined, "a declared write set — including an empty one — needs no warning");
});

test("queue: canonical paths overlap, root covers all, escapes are rejected atomically", async () => {
  for (const alias of ["src/x/../a.ts", "./src//a.ts", "src\\a.ts"]) {
    const owner = fakeOwner({ executor: 4 });
    const q = createDispatchQueue(owner.deps, 1);
    const result = await q.submit({ tasks: [{ key: "a", kind: "executor", task: "a", files: ["src/a.ts"] },
      { key: "b", kind: "executor", task: "b", files: [alias] }] });
    assert.deepEqual(result.started.map(x => x.key), ["a"]);
    assert.equal(result.queued[0]?.reason, "overlap");
    owner.finish("executor");
    assert.deepEqual((await q.settle(owner.runId("a"), "completed")).started.map(x => x.key), ["b"]);
  }
  const root = await createDispatchQueue(fakeOwner({ executor: 4 }).deps, 1).submit({ tasks: [
    { key: "a", kind: "executor", task: "a", files: ["."] }, { key: "b", kind: "executor", task: "b", files: ["src/a.ts"] }] });
  assert.equal(root.queued[0]?.reason, "overlap");
  for (const file of ["../escape", "src/../../escape", "/tmp/file", "C:\\file", "", 42]) {
    const owner = fakeOwner({ executor: 4 });
    const q = createDispatchQueue(owner.deps, 1);
    await assert.rejects(() => q.submit({ tasks: [{ key: "bad", kind: "executor", task: "bad", files: [file] as string[] }] }), /files/);
  }
});

test("queue: one unknown writer warns beside a declared writer but not a reader", async () => {
  for (const files of [["src/a.ts"], []]) {
    const result = await createDispatchQueue(fakeOwner({ executor: 4 }).deps, 1).submit({ tasks: [
      { key: "unknown", kind: "executor", task: "a" }, { key: "known", kind: "executor", task: "b", files }] });
    assert.equal(result.started.length, 2);
    assert.equal(Boolean(result.notice), files.length > 0);
  }
});

test("queue: undeclared units stay parallel, and the report says that is the risk it is", async () => {
  const owner = fakeOwner({ executor: 4 });
  const queue = createDispatchQueue(owner.deps, 1);

  const result = await queue.submit({ tasks: units("a", "b") });
  assert.deepEqual(result.started.map((entry) => entry.key), ["a", "b"], "no declaration is not a refusal");
  assert.match(result.notice ?? "", /a、b 没有声明 files/);
  assert.match(renderDispatchResult(result), /静默覆盖/, "the rendered report carries it too");

  // One undeclared unit alone is not a shared-writer situation.
  const single = await createDispatchQueue(fakeOwner({ executor: 4 }).deps, 1).submit({ tasks: units("solo") });
  assert.equal(single.notice, undefined);
});
