/**
 * `coworkflow.dispatch` as the *host* wires it, not the queue alone.
 *
 * The queue unit tests inject `DispatchDeps`, which is the right way to pin the
 * scheduling rules but says nothing about the two paths that actually run:
 * `dispatchModule.activate` + the registered tool, and the two completion observers
 * over a public RPC contract. Every defect this file guards against lived exactly
 * there, invisible to the injected-adapter tests:
 *
 *   - **`paused` / `stopped` are ends, not successes.** Both arrive as a
 *     `subagent-notify` status and as an `subagent:async-complete` state; neither may
 *     release a `needs`, and neither may be counted as `completed`.
 *   - **A cycle is refused when it is handed over**, atomically, instead of waiting
 *     for a prerequisite that waits for it.
 *   - **A foreign completion wakes the queue.** A run this channel never started still
 *     frees real capacity, so queued work gets one fresh admission — while the foreign
 *     run itself is never read as success.
 *   - **A closed gate stops automatic starts.** Module switched off, or session
 *     replaced, between submission and completion: the queued unit must not launch.
 *   - **The launch path is the shared capacity bridge.** A project-wide total is
 *     enforced on dispatch launches too (an RPC spawn never reaches this package's
 *     `tool_call` hook), and an ambiguous spawn keeps its reservation, is not retried,
 *     and is never reported as definitely not started.
 *
 * The public contract is faked at the RPC boundary — `ping`, `status` and `spawn` over
 * a real event bus — and kind registration goes through the *installed* owner's own
 * listener, so the admission path under test is production code throughout. Nothing
 * here spawns a process or touches a project outside a temp directory.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConfigRootResolver } from "../core/config.ts";
import { exportEntry } from "../core/subagents-workflow.ts";
import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { agentKindsModule } from "../modules/agent-kinds/index.ts";
import { dispatchModule } from "../modules/dispatch/index.ts";

// ── the installed owner, for the real registration contract ───────────

const ownerPath = exportEntry("./agents", mkdtempSync(join(tmpdir(), "coworkflow-dispatch-host-probe-")));
const installed = typeof ownerPath === "string";
const skip = installed
  ? false
  : `pi-subagents with a public ./agents export is not installed here (${(ownerPath as { error: string }).error})`;

interface OwnerAgents {
  RUNTIME_AGENT_REGISTER_EVENT: string;
  registerAgent(input: { pi: unknown; name: string; definition: object }): { dispose(): void };
}
const owner = installed ? ((await import(`file://${ownerPath as string}`)) as OwnerAgents) : null;
const ownerRoot = installed ? /^(.*?)\/(?:bundle|src\/api)\/agents\.js$/.exec(ownerPath as string)?.[1] ?? null : null;
const eventsPath = ownerRoot === null ? null : join(ownerRoot, "src", "agents", "runtime-agent-events.js");
/** The owner's own registration listener, exactly the one its extension installs. */
const ownerInstaller: ((pi: unknown) => () => void) | null =
  eventsPath !== null && existsSync(eventsPath)
    ? ((await import(`file://${eventsPath}`)) as { registerRuntimeAgentEventListener(pi: unknown): () => void })
        .registerRuntimeAgentEventListener
    : null;

// ── a fake host: a real event bus, a public RPC owner, registered kinds ──

interface Run {
  runId: string;
  agent: string;
  state: string;
}

interface Harness {
  root: string;
  /** The registered tool, as the host received it. */
  call(params: Record<string, unknown>): Promise<{ isError?: true; details?: any; text: string }>;
  /** One completion notice, the way the owner delivers it into the conversation. */
  notify(runs: { runId: string; status: string }[]): Promise<void>;
  /** One `subagent:async-complete` event. */
  asyncComplete(payload: Record<string, unknown>): Promise<void>;
  /** A run ends: the owner's capacity reflects it before anything is observed. */
  finish(runId: string): void;
  status(): string[];
  /** Every RPC the client emitted, one per request. */
  requests: Record<string, unknown>[];
  spawns(): number;
  setModule(id: string, on: boolean): void;
  setEpoch(epoch: number): void;
  setLimits(limits: { kinds?: Record<string, number>; total?: number | null }): void;
  /** Hold every `status` reply until released, so a test can change state mid-read. */
  deferStatus(): void;
  /** How many `status` requests are waiting on that hold. */
  deferredStatusReads(): number;
  /** Answer the oldest held `status` request against the state as it is now. */
  releaseStatus(): void;
  /** Stop holding `status` replies; anything still held stays held. */
  resumeStatus(): void;
  /** Make a spawned run visible to the owner's projections (default: immediately visible). */
  reveal(runId: string): void;
  close(): void;
}

function tempProject(config: Record<string, unknown> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-dispatch-host-")));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({
      version: 1,
      autoEnable: true,
      modules: { "agent-kinds": true, capacity: true, dispatch: true },
      agentKinds: { executor: { maxConcurrent: 2 } },
      ...config,
    }),
  );
  return root;
}

function harness(options: { spawn?: "confirmed" | "ambiguous"; runs?: Run[]; hideSpawned?: boolean } = {}): Harness {
  const root = tempProject();
  const runs: Run[] = (options.runs ?? []).map((run) => ({ ...run }));
  /** Runs the owner started but does not show in its projections yet (a real lag window). */
  const hidden: Run[] = [];
  const requests: Record<string, unknown>[] = [];
  let spawnCount = 0;
  const confirmed = options.spawn !== "ambiguous";
  const hideSpawned = options.hideSpawned === true;
  let serial = 0;
  let statusDeferred = false;
  const heldStatus: Record<string, unknown>[] = [];

  const listeners = new Map<string, Set<(data: unknown) => void>>();

  function deliverReply(request: Record<string, unknown>, answer: Record<string, unknown>): void {
    queueMicrotask(() => {
      for (const handler of listeners.get(`subagents:rpc:v1:reply:${String(request.requestId)}`) ?? []) {
        handler(answer);
      }
    });
  }

  const bus = {
    emit(channel: string, data: unknown) {
      if (channel !== "subagents:rpc:v1:request") {
        for (const handler of listeners.get(channel) ?? []) handler(data);
        return;
      }
      const request = data as Record<string, unknown>;
      requests.push(request);
      const answer = respond(request);
      if (answer === undefined) return;
      deliverReply(request, answer);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
      };
    },
  };

  function statusReply(request: Record<string, unknown>): Record<string, unknown> {
    return {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {
        text: "ok",
        fleet: {
          version: 1,
          entries: runs.map((run, index) => ({ key: `fleet-${index + 1}`, agent: run.agent, startedAt: index })),
          totalActive: runs.length,
          omitted: 0,
          topLevelAsyncCapacity: { used: runs.length, limit: 10 },
        },
        asyncSnapshot: {
          kind: "pi-subagents.async-status-snapshot",
          version: 1,
          generatedAt: 1,
          caps: { maxRuns: 100, maxChildrenPerNode: 50, maxDepth: 4, maxStringLength: 1000, maxSerializedBytes: 100000 },
          omitted: { runs: 0, children: 0, byteLimitExceeded: false },
          runs: runs.map((run) => ({ kind: "subagent", id: run.runId, label: "child", state: run.state, agent: run.agent })),
        },
      },
    };
  }

  function respond(request: Record<string, unknown>): Record<string, unknown> | undefined {
    const reply = (data: unknown) => ({ version: 1, requestId: request.requestId, success: true, data });
    if (request.method === "ping") {
      return reply({
        version: 1,
        methods: ["ping", "status", "spawn"],
        capabilities: {
          status: true,
          asyncSpawn: true,
          fleetStatus: { version: 1 },
          asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
        },
        events: { asyncComplete: "subagent:async-complete" },
        session: { sessionId: "session-dispatch-host" },
      });
    }
    if (request.method === "status") {
      // A held reply is answered later by `releaseStatus`, against the state at that
      // moment — never by calling back into `respond`, which would hold it again.
      if (statusDeferred) {
        heldStatus.push(request);
        return undefined;
      }
      return statusReply(request);
    }
    if (request.method === "spawn") {
      spawnCount += 1;
      const params = request.params as Record<string, unknown>;
      if (!confirmed) return reply({ text: "spawned", details: { asyncDir: "/tmp/ambiguous" } });
      serial += 1;
      const runId = `run-spawn-${serial}`;
      const run: Run = { runId, agent: String(params.agent), state: "running" };
      (hideSpawned ? hidden : runs).push(run);
      return reply({ text: "spawned", details: { runId } });
    }
    return undefined;
  }

  // Registration goes through the installed owner's own listener on this fake `pi`,
  // exactly as the real extension gets it — nothing here stubs the agent registry.
  const pi = { events: bus, on() {}, registerTool() {} };
  const stopOwner = ownerInstaller === null ? null : ownerInstaller(pi);

  const hooks = new Map<string, Set<(event: any, ctx: any) => any>>();
  const tools: { name: string; execute: (id: unknown, params: any) => Promise<any> }[] = [];
  const host = {
    events: bus,
    on(name: string, handler: (event: any, ctx: any) => any) {
      const set = hooks.get(name) ?? new Set();
      set.add(handler);
      hooks.set(name, set);
      return () => set.delete(handler);
    },
    registerTool(definition: { name: string; execute: (id: unknown, params: any) => Promise<any> }) {
      tools.push(definition);
    },
    sendMessage() {},
  } as unknown as PiRuntimeHost;

  const modules = new Set(["agent-kinds", "capacity", "dispatch"]);
  let total: number | null = null;
  const session = { epoch: 1 };
  const runtime = {
    isChild: false,
    enabled: true,
    cwd: root,
    sessionId: "session-dispatch-host",
    parentSessionId: null,
    get sessionEpoch() {
      return session.epoch;
    },
    loadState: "auto",
    configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
    refresh() {},
    control: {
      moduleEnabled: (id: string) => modules.has(id),
      subagentConcurrency: () => total,
    },
  } as unknown as RuntimeContext;

  agentKindsModule.activate!(host, runtime);
  dispatchModule.activate!(host, runtime);

  return {
    root,
    requests,
    async call(params) {
      const tool = tools.find((entry) => entry.name === "coworkflow.dispatch");
      assert.ok(tool, "coworkflow.dispatch is registered on the host");
      const result = await tool.execute("call-1", params);
      const text = (result.content ?? []).map((part: any) => String(part.text ?? "")).join("\n");
      return { ...(result.isError ? { isError: true as const } : {}), details: result.details, text };
    },
    async notify(notices) {
      for (const handler of hooks.get("message_end") ?? []) {
        await handler(
          { message: { customType: "subagent-notify", details: { runs: notices } } },
          {},
        );
      }
      // Settlement is driven by the event, not by the handler's return: give the
      // queue's serialized chain one turn to finish, the way the host would.
      await new Promise((resolve) => setImmediate(resolve));
    },
    async asyncComplete(payload) {
      bus.emit("subagent:async-complete", payload);
      await new Promise((resolve) => setImmediate(resolve));
    },
    finish(runId) {
      const index = runs.findIndex((run) => run.runId === runId);
      if (index !== -1) runs.splice(index, 1);
      const late = hidden.findIndex((run) => run.runId === runId);
      if (late !== -1) hidden.splice(late, 1);
    },
    reveal(runId) {
      const index = hidden.findIndex((run) => run.runId === runId);
      if (index !== -1) runs.push(...hidden.splice(index, 1));
    },
    deferStatus() {
      statusDeferred = true;
    },
    deferredStatusReads: () => heldStatus.length,
    releaseStatus() {
      const request = heldStatus.shift();
      if (request === undefined) return;
      deliverReply(request, statusReply(request));
    },
    resumeStatus() {
      statusDeferred = false;
    },
    status: () => dispatchModule.runtimeStatus!(host) ?? [],
    spawns: () => spawnCount,
    setModule(id, on) {
      if (on) modules.add(id);
      else modules.delete(id);
    },
    setEpoch(epoch) {
      session.epoch = epoch;
    },
    setLimits(limits) {
      if (limits.total !== undefined) total = limits.total;
      if (limits.kinds !== undefined) {
        writeFileSync(
          join(root, ".pi", "Coworkflow.json"),
          JSON.stringify({
            version: 1,
            autoEnable: true,
            modules: { "agent-kinds": true, capacity: true, dispatch: true },
            agentKinds: Object.fromEntries(Object.entries(limits.kinds).map(([kind, maxConcurrent]) => [kind, { maxConcurrent }])),
          }),
        );
      }
    },
    close() {
      dispatchModule.onSessionEnd!(host, runtime);
      stopOwner?.();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Count of spawn requests the client has emitted — the retry check. */
const spawnRequests = (requests: Record<string, unknown>[]): number =>
  requests.filter((request) => request.method === "spawn").length;

/** Let the host's own promise chains run until `condition` holds. */
async function until(condition: () => boolean, tries = 50): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("the host never reached the awaited read this test defers");
}

// ── B1: paused / stopped / unknown are never completion ──────────────

for (const status of ["paused", "stopped"]) {
  test(`host: a ${status} notify releases nothing`, { skip }, async () => {
    const h = harness();
    try {
      // One slot, so the dependent is observably not started by capacity alone.
      h.setLimits({ kinds: { executor: 1 } });
      const first = await h.call({
        tasks: [
          { key: "build", kind: "executor", task: "build it" },
          { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
        ],
      });
      assert.equal(first.details.started.length, 1, first.text);
      assert.equal(first.details.queued[0]?.key, "audit");

      const runId = first.details.started[0].runId as string;
      h.finish(runId);
      await h.notify([{ runId, status }]);

      assert.equal(h.spawns(), 1, `a ${status} run must not start the dependent`);
      const lines = h.status().join("\n");
      assert.match(lines, /被停止或暂停/, lines);
      assert.match(lines, /0 运行/, "the run is not still counted as running");
      assert.doesNotMatch(lines, /已启动|completed/, lines);
    } finally {
      h.close();
    }
  });
}

test("host: an async-complete payload without a state releases nothing", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    // Not `state: "complete"`: a payload that says nothing is not evidence.
    await h.asyncComplete({ runId, success: undefined });
    assert.equal(h.spawns(), 1, "an unknown notice must not be read as success");
  } finally {
    h.close();
  }
});

test("host: an async-complete state:complete does start the dependent", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    await h.asyncComplete({ runId, state: "complete", success: true });
    assert.equal(h.spawns(), 2, "a positively completed prerequisite starts its dependent");
    assert.match(h.status().join("\n"), /1 运行/, "the dependent is now the running unit");
  } finally {
    h.close();
  }
});

test("host: a completed notify starts the dependent and marks it completed", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    h.finish(first.details.started[0].runId);
    await h.notify([{ runId: first.details.started[0].runId, status: "completed" }]);
    assert.equal(h.spawns(), 2);
  } finally {
    h.close();
  }
});

// ── B3: cycles are refused atomically ────────────────────────────────

test("host: a two-node cycle is refused when it is submitted, naming the cycle", { skip }, async () => {
  const h = harness();
  try {
    const result = await h.call({
      tasks: [
        { key: "a", kind: "executor", task: "do a", needs: ["b"] },
        { key: "b", kind: "executor", task: "do b", needs: ["a"] },
      ],
    });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /依赖成环/, result.text);
    assert.match(result.text, /a → b → a|b → a → b/, result.text);
    assert.equal(h.spawns(), 0, "nothing from a refused submission is adopted");
    assert.match(h.status().join("\n"), /0 运行 \/ 0 排队/, "the batch was not left half-queued");
  } finally {
    h.close();
  }
});

test("host: a self-cycle is refused the same way", { skip }, async () => {
  const h = harness();
  try {
    const result = await h.call({
      tasks: [{ key: "s", kind: "executor", task: "do s", needs: ["s"] }],
    });
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /依赖成环/, result.text);
    assert.equal(h.spawns(), 0);
  } finally {
    h.close();
  }
});

test("host: a chain still starts in order after the cycle check", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "a", kind: "executor", task: "do a" },
        { key: "b", kind: "executor", task: "do b", needs: ["a"] },
        { key: "c", kind: "executor", task: "do c", needs: ["b"] },
      ],
    });
    assert.deepEqual(first.details.started.map((entry: any) => entry.key), ["a"]);
    assert.deepEqual(first.details.queued.map((entry: any) => entry.key), ["b", "c"]);
  } finally {
    h.close();
  }
});

// ── foreign completion wakes queued work ─────────────────────────────

test("host: a foreign run's completion admits queued work without claiming success", { skip }, async () => {
  const h = harness({ runs: [{ runId: "run-foreign", agent: "cw-executor", state: "running" }] });
  try {
    // The kind's ceiling is 2 and one slot is already taken by a run this channel
    // never started, so the second unit cannot be admitted yet.
    const first = await h.call({
      tasks: [
        { key: "a", kind: "executor", task: "do a" },
        { key: "b", kind: "executor", task: "do b" },
      ],
    });
    assert.deepEqual(first.details.started.map((entry: any) => entry.key), ["a"], first.text);
    assert.deepEqual(first.details.queued.map((entry: any) => [entry.key, entry.reason]), [["b", "ceiling"]]);

    h.finish("run-foreign");
    await h.asyncComplete({ runId: "run-foreign", state: "complete", success: true });

    assert.equal(h.spawns(), 2, "the foreign completion woke the queue");
    const lines = h.status().join("\n");
    assert.match(lines, /2 运行 \/ 0 排队/, lines);
    assert.doesNotMatch(lines, /0 运行 \/ 1 排队/, "the queued unit really started");
  } finally {
    h.close();
  }
});

test("host: a duplicate completion notice settles nothing twice", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    await h.asyncComplete({ runId, state: "complete", success: true });
    const after = h.spawns();
    await h.asyncComplete({ runId, state: "complete", success: true });
    await h.notify([{ runId, status: "completed" }]);
    assert.equal(h.spawns(), after, "a repeated completion launches nothing new");
  } finally {
    h.close();
  }
});

// ── gates: module switch and session replacement ─────────────────────

test("host: with dispatch switched off, a completion starts nothing", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    h.setModule("dispatch", false);
    await h.asyncComplete({ runId, state: "complete", success: true });
    await h.notify([{ runId, status: "completed" }]);
    assert.equal(h.spawns(), 1, "an automatic start must respect the module switch");
  } finally {
    h.close();
  }
});

test("host: an old-epoch completion invalidates but never launches into the new session", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    h.setEpoch(2);
    await h.asyncComplete({ runId, state: "complete", success: true });
    assert.equal(h.spawns(), 1, "the new session must not inherit the old queue's launch");
    const lines = h.status().join("\n");
    assert.match(lines, /0 运行 \/ 0 排队/, lines);
    assert.match(lines, /会话换代作废了上一代队列/, "what the replacement discarded is reported");
  } finally {
    h.close();
  }
});

test("host: a notice with no state does not release the capacity of a run it cannot prove ended", { skip }, async () => {
  // This owner starts runs but does not show them in its projections yet, which is the
  // real window in which the launch reservation is the *only* record of the slot.
  const h = harness({ hideSpawned: true });
  try {
    h.setLimits({ kinds: { executor: 5 }, total: 1 });
    const first = await h.call({ tasks: [{ key: "a", kind: "executor", task: "do a" }] });
    assert.equal(first.details.started.length, 1, first.text);
    const runId = first.details.started[0].runId as string;

    // `success: undefined` and no state: no evidence that anything ended.
    await h.asyncComplete({ runId, success: undefined });

    const second = await h.call({ tasks: [{ key: "b", kind: "executor", task: "do b" }] });
    assert.deepEqual(
      second.details.started,
      [],
      "an unknown notice must not hand a still-running process's project slot to the next unit",
    );
    assert.deepEqual(second.details.queued.map((entry: any) => [entry.key, entry.reason]), [["b", "ceiling"]]);
    assert.equal(h.spawns(), 1, "no second spawn on invented capacity");
  } finally {
    h.close();
  }
});

test("host: a completion that arrives while dispatch is off is recorded, not discarded", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    h.setModule("dispatch", false);
    await h.asyncComplete({ runId, state: "complete", success: true });

    // The closed switch stops the *start*, which is its job.
    assert.equal(h.spawns(), 1, "a closed module really does stop the automatic start");
    // And the end itself was recorded: had it been dropped, `build` would still count as
    // running forever and its completion would be gone for good.
    const closed = h.status().join("\n");
    assert.match(closed, /0 运行 \/ 1 排队/, closed);
    assert.doesNotMatch(closed, /1 运行/, closed);

    h.setModule("dispatch", true);
    // Re-enabling needs no replay and no polling: the next observation of the queue —
    // here the parent's next submission — sees the prerequisite already completed.
    const second = await h.call({
      tasks: [{ key: "audit-tail", kind: "executor", task: "tail", needs: ["audit"] }],
    });
    assert.equal(h.spawns(), 2, "audit starts from the completion recorded while dispatch was off");
    assert.match(second.text, /1 已启动 \/ 1 排队/, second.text);
  } finally {
    h.close();
  }
});

test("host: a module switch during the awaited project-capacity read stops the launch", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 5 }, total: 1 });
    h.deferStatus();
    const call = h.call({ tasks: [{ key: "a", kind: "executor", task: "do a" }] });

    // First held read: the kind's live count. Then the launch's own project-total read.
    await until(() => h.deferredStatusReads() === 1);
    h.releaseStatus();
    await until(() => h.deferredStatusReads() === 1);

    // The switch closes *between* the queue's last gate and the spawn.
    h.setModule("dispatch", false);
    h.releaseStatus();
    h.resumeStatus();
    const result = await call;

    assert.equal(h.spawns(), 0, "a switch closed during the capacity read still stops the launch");
    assert.deepEqual(result.details.started, []);
    assert.deepEqual(result.details.failed, [], "a closed switch is not this unit's failure");
    assert.deepEqual(result.details.queued.map((entry: any) => [entry.key, entry.reason]), [["a", "gated"]]);

    // The withdrawn launch released its reservation: the project's single slot is
    // provably free again (nothing was emitted), so the next unit starts.
    h.setModule("dispatch", true);
    const second = await h.call({ tasks: [{ key: "b", kind: "executor", task: "do b" }] });
    assert.equal(second.details.started.length, 1, second.text);
    assert.equal(h.spawns(), 1);
  } finally {
    h.close();
  }
});

test("host: a session replacement counts an unconfirmed launch instead of erasing it", { skip }, async () => {
  const h = harness({ spawn: "ambiguous" });
  try {
    h.setLimits({ kinds: { executor: 1 } });
    await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    h.setEpoch(2);
    const lines = h.status().join("\n");
    assert.match(lines, /会话换代作废了上一代队列（0 运行 \/ 1 排队 \/ 1 启动未确认）/, lines);
    assert.match(lines, /那些 run 仍属于旧会话/, lines);
  } finally {
    h.close();
  }
});

// ── the shared project-capacity bridge ───────────────────────────────

test("host: the project-wide total blocks a launch that the kind ceiling would allow", { skip }, async () => {
  const h = harness();
  try {
    h.setLimits({ kinds: { executor: 5 }, total: 1 });
    const first = await h.call({
      tasks: [
        { key: "a", kind: "executor", task: "do a" },
        { key: "b", kind: "executor", task: "do b" },
      ],
    });
    assert.deepEqual(first.details.started.map((entry: any) => entry.key), ["a"], first.text);
    assert.deepEqual(
      first.details.queued.map((entry: any) => [entry.key, entry.reason]),
      [["b", "ceiling"]],
      "no capacity now is a place in line, not a failure",
    );
    assert.deepEqual(first.details.failed, []);

    // The first run ends; the total frees and the queued unit may start.
    const runId = first.details.started[0].runId as string;
    h.finish(runId);
    await h.asyncComplete({ runId, state: "complete", success: true });
    assert.equal(h.spawns(), 2, "the freed project slot was really re-admitted");
  } finally {
    h.close();
  }
});

test("host: an ambiguous spawn is reported as unconfirmed, never retried, never a success", { skip }, async () => {
  const h = harness({ spawn: "ambiguous" });
  try {
    h.setLimits({ kinds: { executor: 1 } });
    const first = await h.call({
      tasks: [
        { key: "build", kind: "executor", task: "build it" },
        { key: "audit", kind: "executor", task: "audit it", needs: ["build"] },
      ],
    });
    assert.deepEqual(first.details.started, [], "an unconfirmed launch is not reported as started");
    assert.deepEqual(first.details.failed, [], "and it is not reported as a failed launch either");
    // Not only in the status lines: the tool response itself must show the unit that
    // may already be running, with its reservation still held and no retry offered.
    assert.deepEqual(
      first.details.unobserved.map((entry: any) => entry.key),
      ["build"],
      "an unconfirmed launch is neither started, queued nor failed — it has its own entry",
    );
    assert.match(first.text, /1 启动未确认/, first.text);
    assert.match(first.text, /\? build（kind executor）启动未确认/, first.text);
    assert.match(first.text, /不会重发/, first.text);
    assert.equal(spawnRequests(h.requests), 1, "spawn is not idempotent: exactly one emission");
    assert.equal(h.spawns(), 1);

    const lines = h.status().join("\n");
    assert.match(lines, /\? dispatch: build/, lines);
    assert.match(lines, /启动未确认/, lines);

    // The dependent stays waiting: an unconfirmed prerequisite is not completed.
    assert.match(lines, /0 运行 \/ 1 排队/, lines);
    await h.asyncComplete({ runId: "run-root", state: "complete", success: true });
    assert.equal(spawnRequests(h.requests), 1, "a completion must not turn into a retry");
  } finally {
    h.close();
  }
});

test("host: an unconfirmed launch is not counted as free kind capacity", { skip }, async () => {
  const h = harness({ spawn: "ambiguous" });
  try {
    h.setLimits({ kinds: { executor: 1 } });
    await h.call({ tasks: [{ key: "a", kind: "executor", task: "do a" }] });
    const second = await h.call({ tasks: [{ key: "b", kind: "executor", task: "do b" }] });
    assert.deepEqual(second.details.started, [], second.text);
    assert.deepEqual(second.details.queued.map((entry: any) => entry.reason), ["ceiling"]);
  } finally {
    h.close();
  }
});

// ── registration hygiene ─────────────────────────────────────────────

test("host: syncAgentKinds registers the kind the dispatch tool launches", { skip }, async () => {
  const h = harness();
  try {
    const first = await h.call({ tasks: [{ key: "a", kind: "executor", task: "do a" }] });
    assert.equal(first.isError, undefined, first.text);
    // The launched agent is the one the kind policy resolves to, never re-derived.
    assert.equal((first.details.started[0] as any).kind, "executor");
    assert.match(first.details.started[0].runId, /^run-spawn-/, "the launch went through the public RPC");
  } finally {
    h.close();
  }
});
