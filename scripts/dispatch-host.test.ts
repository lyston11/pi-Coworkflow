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

function harness(options: { spawn?: "confirmed" | "ambiguous"; runs?: Run[] } = {}): Harness {
  const root = tempProject();
  const runs: Run[] = (options.runs ?? []).map((run) => ({ ...run }));
  const requests: Record<string, unknown>[] = [];
  let spawnCount = 0;
  const confirmed = options.spawn !== "ambiguous";
  let serial = 0;

  const listeners = new Map<string, Set<(data: unknown) => void>>();
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
      queueMicrotask(() => {
        for (const handler of listeners.get(`subagents:rpc:v1:reply:${String(request.requestId)}`) ?? []) {
          handler(answer);
        }
      });
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
      return reply({
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
      });
    }
    if (request.method === "spawn") {
      spawnCount += 1;
      const params = request.params as Record<string, unknown>;
      if (!confirmed) return reply({ text: "spawned", details: { asyncDir: "/tmp/ambiguous" } });
      serial += 1;
      const runId = `run-spawn-${serial}`;
      runs.push({ runId, agent: String(params.agent), state: "running" });
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
