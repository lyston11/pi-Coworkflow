/**
 * Interrupting a run: `stop`, `steer`, `interrupt` through the public RPC, and the
 * commands that expose them.
 *
 * What this file exists to prove, because each of these fails silently:
 *
 *   - **a missing capability sends nothing.** A build without `stop` must be
 *     reported as such, not called and hoped for, and not called at all.
 *   - **accepted is not terminated.** A successful `stop` reply is an acceptance
 *     receipt (`state: "stopping"`); the report must say so, re-read the public
 *     status once, and print the two facts separately. Nothing here may print
 *     "已停止" for an accepted request.
 *   - **a failed stop is not a dead run.** No `ambiguous` alias, no retry, and the
 *     owner's own error text is preserved.
 *   - **a malformed reply is a protocol error.** An empty object is not a success.
 *   - **steer carries instructions as data**, byte for byte.
 *   - **lanes only stops its own task's runs**, and refuses a foreign id without
 *     emitting anything.
 *
 * Everything drives the production client, the production command handlers and
 * the production bridge over a fake event bus. Nothing spawns a child.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { createConfigRootResolver } from "../core/config.ts";
import { contextKeyFor, SESSIONS_DIR } from "../core/trellis.ts";
import { SubagentsClient, attachSubagents } from "../core/subagents-client.ts";
import { recordLaunchLink } from "../core/subagents-workflow.ts";
import { laneWorktreeModule, parseLanesArgs } from "../modules/lane-worktree/index.ts";
import { subagentsModule, parseControlArgs } from "../modules/subagents/index.ts";

// ── A fake pi.events bus ─────────────────────────────────────────────

interface FakeBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
  requests: Record<string, unknown>[];
  respond(next: (request: Record<string, unknown>) => unknown | undefined): void;
  listenerCount(): number;
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
      queueMicrotask(() => {
        for (const handler of listeners.get(replyChannel) ?? []) handler(answer);
      });
    },
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(channel);
      };
    },
    respond(next) {
      responder = next;
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

const reply = (request: Record<string, unknown>, data: unknown): Record<string, unknown> =>
  ({ version: 1, requestId: request.requestId, success: true, data });

const failure = (request: Record<string, unknown>, code: string, message: string): Record<string, unknown> =>
  ({ version: 1, requestId: request.requestId, success: false, error: { code, message } });

/** A ping that advertises every control method this file exercises. */
const PING_CONTROL = {
  version: 1,
  methods: ["ping", "status", "spawn", "steer", "interrupt", "stop", "cost"],
  capabilities: {
    status: true,
    asyncSpawn: true,
    asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
    stop: true,
    steer: true,
    interrupt: true,
  },
  events: { asyncComplete: "subagent:async-complete" },
  session: { sessionId: "session-control" },
};

/** The bounded `asyncSnapshot` projection `observeActivity` reads. */
function snapshot(runs: { id: string; state: string }[]) {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1,
    caps: { maxRuns: 100, maxChildrenPerNode: 50, maxDepth: 4, maxStringLength: 1000, maxSerializedBytes: 100000 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: runs.map((run) => ({ kind: "subagent", label: "child", ...run })),
  };
}

// ── core/subagents-client.ts: the three control wrappers ─────────────

test("control client: a method the owner does not advertise is refused, and nothing is emitted", async () => {
  const bus = fakeBus();
  bus.respond((request) => request.method === "ping"
    // A build that predates the control seam: ping, status, spawn only.
    ? reply(request, { version: 1, methods: ["ping", "status", "spawn"], capabilities: { status: true, asyncSpawn: true }, events: {}, session: {} })
    : undefined);
  const client = new SubagentsClient({ events: bus });
  try {
    for (const [method, call] of [
      ["stop", () => client.stop({ id: "run-1" })],
      ["steer", () => client.steer({ id: "run-1", message: "go on" })],
      ["interrupt", () => client.interrupt({ id: "run-1" })],
    ] as const) {
      const result = await call();
      assert.equal(result.ok, false, `${method} must not be attempted`);
      if (result.ok) return;
      assert.equal(result.reason, "unavailable");
      assert.match(result.message, new RegExp(`没有通告 RPC ${method} 方法`), "the refusal names the method");
      assert.match(result.message, /ping、status、spawn/, "and what the owner does advertise");
      assert.equal(bus.requests.filter((request) => request.method === method).length, 0, `no ${method} request was sent`);
    }
  } finally {
    client.dispose();
  }
});

test("control client: a successful stop is an acceptance receipt, never a terminated run", async () => {
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_CONTROL);
    if (request.method === "stop") {
      return reply(request, {
        runId: "run-1",
        asyncDir: "/tmp/run-1",
        previousState: "running",
        state: "stopping",
        message: "Stop requested for async run run-1.",
      });
    }
    return undefined;
  });
  const client = new SubagentsClient({ events: bus });
  try {
    const result = await client.stop({ id: "run-1" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.accepted, true);
    assert.equal(result.data.state, "stopping", "the owner's acknowledgement, not a terminal state");
    assert.equal(result.data.previousState, "running");
    assert.equal(result.data.runId, "run-1");
    // A failed stop implies nothing about the run; a successful one must not
    // manufacture an ambiguity alias either.
    const sent = bus.requests.filter((request) => request.method === "stop");
    assert.equal(sent.length, 1, "exactly one stop request, ever");
    assert.deepEqual(sent[0]?.params, { id: "run-1" }, "the target is the caller's id, passed as data");
  } finally {
    client.dispose();
  }
});

test("control client: a refused stop keeps the owner's own reason and is not reported as a timeout", async () => {
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_CONTROL);
    if (request.method === "stop") {
      return failure(request, "invalid_state", "Async run run-1 is complete; stop only supports running or queued async runs, or a paused whole run.");
    }
    return undefined;
  });
  const client = new SubagentsClient({ events: bus });
  try {
    const result = await client.stop({ id: "run-1" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "refused");
    assert.equal(result.code, "invalid_state");
    assert.match(result.message, /stop only supports running or queued async runs/, "the owner's sentence survives");
    assert.equal(result.ambiguous, undefined, "a refused stop does not claim the run died or that a retry is needed");
  } finally {
    client.dispose();
  }
});

test("control client: a malformed reply is a protocol error, not a success", async () => {
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_CONTROL);
    // Readable JSON, but not an acknowledgement: no `state`, no `text`, nothing.
    if (request.method === "stop") return reply(request, {});
    if (request.method === "steer") return reply(request, {});
    if (request.method === "interrupt") return reply(request, {});
    return undefined;
  });
  const client = new SubagentsClient({ events: bus });
  try {
    const stop = await client.stop({ id: "run-1" });
    assert.equal(stop.ok, false);
    if (!stop.ok) {
      assert.equal(stop.reason, "protocol");
      assert.match(stop.message, /不带 state 字段/);
    }
    const steer = await client.steer({ id: "run-1", message: "go on" });
    assert.equal(steer.ok, false);
    if (!steer.ok) assert.equal(steer.reason, "protocol");
    const interrupt = await client.interrupt({ id: "run-1" });
    assert.equal(interrupt.ok, false);
    if (!interrupt.ok) assert.equal(interrupt.reason, "protocol");
  } finally {
    client.dispose();
  }
});

test("control client: steer passes the instructions through unchanged, as data", async () => {
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_CONTROL);
    if (request.method === "steer") {
      return reply(request, {
        text: "Steering queued for async run run-1 (request req-1).",
        details: { mode: "management", results: [], steering: { requestId: "req-1", state: "scheduled", deliveryStatus: "queued", sourceRunId: "run-1", targets: [] } },
      });
    }
    return undefined;
  });
  const client = new SubagentsClient({ events: bus });
  // Shell metacharacters, newlines and quotes: none of them may be touched, and
  // none of them may be interpreted.
  const instructions = "别动 $(rm -rf /) 和 `whoami`\n第二行: 'quoted' \"double\" ; echo hi";
  try {
    const result = await client.steer({ id: "run-1", message: instructions });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.accepted, true);
    assert.equal(result.data.deliveryStatus, "queued", "queued delivery is a successful acknowledgement, reported as such");
    const sent = bus.requests.filter((request) => request.method === "steer");
    assert.equal(sent.length, 1);
    assert.equal((sent[0]?.params as Record<string, unknown>).message, instructions, "byte-for-byte, no escaping or interpolation");
  } finally {
    client.dispose();
  }
});

test("control client: an accepted interrupt reports the owner's acknowledgement", async () => {
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_CONTROL);
    if (request.method === "interrupt") return reply(request, { text: "Interrupt requested for async run run-1.", details: { mode: "management", results: [] } });
    return undefined;
  });
  const client = new SubagentsClient({ events: bus });
  try {
    const result = await client.interrupt({ id: "run-1" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.accepted, true);
    assert.match(result.data.text, /Interrupt requested/);
  } finally {
    client.dispose();
  }
});

// ── The commands, against the same fake bus ──────────────────────────

interface Harness {
  root: string;
  host: PiRuntimeHost;
  runtime: RuntimeContext;
  bus: FakeBus;
  messages: string[];
  switches: Set<string>;
  run(command: string, args: string): Promise<void>;
  /** Runs the follow-up status read against `live`. */
  live(runs: { id: string; state: string }[]): void;
  /** Advertise a subset of methods, to drive the missing-capability path. */
  advertise(methods: string[]): void;
  close(): void;
}

const SESSION = "session-control-test";

function harness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-control-")));
  const taskRef = ".trellis/tasks/demo";
  mkdirSync(join(root, taskRef), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({ version: 1, modules: { "lane-worktree": true, subagents: true } }));
  mkdirSync(join(root, SESSIONS_DIR), { recursive: true });
  writeFileSync(join(root, SESSIONS_DIR, `${contextKeyFor(SESSION)}.json`), JSON.stringify({ current_task: taskRef }));

  const bus = fakeBus();
  const messages: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  let liveRuns: { id: string; state: string }[] = [];
  let methods = [...PING_CONTROL.methods];

  bus.respond((request) => {
    if (request.method === "ping") {
      return reply(request, { ...PING_CONTROL, methods,
        capabilities: { ...PING_CONTROL.capabilities, stop: methods.includes("stop"), steer: methods.includes("steer"), interrupt: methods.includes("interrupt") } });
    }
    if (request.method === "status") return reply(request, { text: "ok", asyncSnapshot: snapshot(liveRuns) });
    if (request.method === "stop") {
      return reply(request, { runId: (request.params as any)?.id, previousState: "running", state: "stopping", message: "Stop requested." });
    }
    if (request.method === "steer") {
      return reply(request, { text: "Steering queued.", details: { mode: "management", results: [], steering: { requestId: "req-1", state: "scheduled", deliveryStatus: "queued" } } });
    }
    return undefined;
  });

  const host = {
    events: bus,
    on: () => () => {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, spec);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
  } as unknown as PiRuntimeHost;

  const switches = new Set(["lane-worktree", "subagents"]);
  const runtime = {
    cwd: root,
    sessionId: SESSION,
    sessionEpoch: 1,
    enabled: true,
    isChild: false,
    refresh() {},
    configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
    control: { moduleEnabled: (id: string) => switches.has(id), subagentConcurrency: () => null },
  } as unknown as RuntimeContext;

  laneWorktreeModule.activate!(host, runtime);
  laneWorktreeModule.onSessionActivate!(host, runtime);
  subagentsModule.onSessionActivate!(host, runtime);

  return {
    root,
    host,
    runtime,
    bus,
    messages,
    switches,
    async run(command, args) {
      const entry = commands.get(command);
      assert.ok(entry, `${command} is registered`);
      await entry.handler(args, { cwd: root, mode: "tui", sessionManager: { getSessionId: () => SESSION } });
    },
    live(runs) {
      liveRuns = runs;
    },
    advertise(next) {
      methods = next;
    },
    close() {
      laneWorktreeModule.onSessionEnd!(host, runtime);
      subagentsModule.onSessionEnd!(host, runtime);
      attachSubagents(host, { epoch: runtime.sessionEpoch, events: bus }).dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const last = (messages: string[]): string => messages.at(-1) ?? "";

test("lanes stop: accepted is reported as accepted, and the follow-up status read is shown separately", async () => {
  const h = harness();
  try {
    recordLaunchLink(h.root, { runId: "run-1", taskRef: ".trellis/tasks/demo", sessionId: SESSION });
    // The run is still running after the stop was accepted: the report must say
    // both, in that order, and must not claim the run ended.
    h.live([{ id: "run-1", state: "running" }]);
    await h.run("Coworkflow:lanes", "stop run-1");
    const output = last(h.messages);
    assert.match(output, /已接受停止 run run-1 的请求/, output);
    assert.match(output, /state: stopping/);
    assert.match(output, /不是「run 已经结束」/, "the acknowledgement is labelled as an acceptance, not a termination");
    assert.match(output, /停止后的公开状态: running（还在运行）/, "the follow-up public read is reported");
    assert.match(output, /停止尚未生效/, "and what it means for the stop");
    assert.doesNotMatch(output, /已停止/, "an accepted request is never reported as a finished one");
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 1);
  } finally {
    h.close();
  }
});

test("lanes stop: a run the task never recorded is refused, and no stop request is emitted", async () => {
  const h = harness();
  try {
    recordLaunchLink(h.root, { runId: "run-mine", taskRef: ".trellis/tasks/demo", sessionId: SESSION });
    await h.run("Coworkflow:lanes", "stop run-foreign");
    const output = last(h.messages);
    assert.match(output, /不是任务 .trellis\/tasks\/demo 记录过的 run/);
    assert.match(output, /不接受任意 id/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 0, "nothing was sent for an arbitrary id");

    // A run recorded under a *different* task is foreign too.
    recordLaunchLink(h.root, { runId: "run-other-task", taskRef: ".trellis/tasks/other", sessionId: SESSION });
    await h.run("Coworkflow:lanes", "stop run-other-task");
    assert.match(last(h.messages), /记录在任务 .trellis\/tasks\/other 下/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 0);
  } finally {
    h.close();
  }
});

test("lanes stop: an empty run id and a switched-off module are refused before anything is sent", async () => {
  const h = harness();
  try {
    await h.run("Coworkflow:lanes", "stop");
    assert.match(last(h.messages), /用法：\/Coworkflow:lanes stop <runId>/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 0);

    recordLaunchLink(h.root, { runId: "run-1", taskRef: ".trellis/tasks/demo", sessionId: SESSION });
    h.switches.delete("lane-worktree");
    await h.run("Coworkflow:lanes", "stop run-1");
    assert.match(last(h.messages), /已关闭/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 0, "a closed module does not police");
  } finally {
    h.close();
  }
});

test("lanes stop: an owner without the stop method says exactly that", async () => {
  const h = harness();
  try {
    recordLaunchLink(h.root, { runId: "run-1", taskRef: ".trellis/tasks/demo", sessionId: SESSION });
    h.advertise(["ping", "status", "spawn"]);
    await h.run("Coworkflow:lanes", "stop run-1");
    const output = last(h.messages);
    assert.match(output, /没有通告 RPC stop 方法/, output);
    assert.doesNotMatch(output, /已接受/, "nothing was accepted, so nothing says it was");
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 0);
  } finally {
    h.close();
  }
});

test("command: /Coworkflow:stop refuses an empty run id and never sends a targetless stop", async () => {
  const h = harness();
  try {
    await h.run("Coworkflow:stop", "   ");
    assert.match(last(h.messages), /缺少 runId/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 0);

    h.live([{ id: "run-1", state: "running" }]);
    await h.run("Coworkflow:stop", "run-1");
    const output = last(h.messages);
    assert.match(output, /已接受停止 run run-1 的请求/);
    assert.match(output, /停止后的公开状态: running（还在运行）/);
    assert.doesNotMatch(output, /已停止/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 1);
  } finally {
    h.close();
  }
});

test("command: /Coworkflow:stop sends instructions first, then stops, and reports each outcome", async () => {
  const h = harness();
  try {
    h.live([{ id: "run-1", state: "running" }]);
    await h.run("Coworkflow:stop", "run-1 wrap up now");
    const output = last(h.messages);
    assert.match(output, /已把指令交给 pi-subagents/, "the steer outcome is reported");
    assert.match(output, /已接受停止 run run-1 的请求/, "and the stop outcome separately");
    const steer = h.bus.requests.find((request) => request.method === "steer");
    assert.equal((steer?.params as Record<string, unknown>).message, "wrap up now", "the instructions are the free text after the id");
    assert.equal(h.bus.requests.filter((request) => request.method === "stop").length, 1);
  } finally {
    h.close();
  }
});

test("command: /Coworkflow:steer requires instructions and passes them through unchanged", async () => {
  const h = harness();
  try {
    await h.run("Coworkflow:steer", "run-1");
    assert.match(last(h.messages), /缺少指令/);
    assert.equal(h.bus.requests.filter((request) => request.method === "steer").length, 0);

    const instructions = "先别改 core/config.ts；跑 npx tsc --noEmit 再报告";
    await h.run("Coworkflow:steer", `run-1 ${instructions}`);
    const output = last(h.messages);
    assert.match(output, /已把指令交给 pi-subagents（run run-1，deliveryStatus: queued）/);
    assert.match(output, /指令还在队列里/, "queued delivery is described honestly");
    assert.match(output, /不杀进程/);
    const sent = h.bus.requests.filter((request) => request.method === "steer");
    assert.equal(sent.length, 1);
    assert.equal((sent[0]?.params as Record<string, unknown>).message, instructions, "passed as data, byte for byte");
  } finally {
    h.close();
  }
});

test("command: stop and steer say so when the owner does not advertise them", async () => {
  const h = harness();
  try {
    h.advertise(["ping", "status", "spawn"]);
    await h.run("Coworkflow:stop", "run-1");
    assert.match(last(h.messages), /没有通告 RPC stop 方法/);
    await h.run("Coworkflow:steer", "run-1 go on");
    assert.match(last(h.messages), /没有通告 RPC steer 方法/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop" || request.method === "steer").length, 0);
  } finally {
    h.close();
  }
});

test("command: both control commands are withdrawn with the module", async () => {
  const h = harness();
  try {
    h.switches.delete("subagents");
    await h.run("Coworkflow:stop", "run-1");
    assert.match(last(h.messages), /把 subagents 模块关掉了/);
    await h.run("Coworkflow:steer", "run-1 go on");
    assert.match(last(h.messages), /把 subagents 模块关掉了/);
    assert.equal(h.bus.requests.filter((request) => request.method === "stop" || request.method === "steer").length, 0);
  } finally {
    h.close();
  }
});

// ── The argument decoders ────────────────────────────────────────────

test("argument decoders: the stop form is recognised, and everything else stays a task reference", () => {
  assert.deepEqual(parseLanesArgs(""), { taskRef: "" });
  assert.deepEqual(parseLanesArgs(".trellis/tasks/demo"), { taskRef: ".trellis/tasks/demo" });
  // A task named `stop…` is still a task reference: only a bare `stop` keyword
  // with a run id after it is the control form.
  assert.deepEqual(parseLanesArgs("stopwatch-task"), { taskRef: "stopwatch-task" });
  assert.deepEqual(parseLanesArgs("stop run-1"), { taskRef: "", stop: "run-1" });
  assert.deepEqual(parseLanesArgs("STOP run-1"), { taskRef: "", stop: "run-1" });
  const empty = parseLanesArgs("stop  ");
  assert.ok("error" in empty && /runId 不能为空/.test(empty.error));

  assert.deepEqual(parseControlArgs("run-1", { instructionsRequired: false }), { runId: "run-1", instructions: "" });
  assert.deepEqual(parseControlArgs("run-1 do the thing", { instructionsRequired: false }),
    { runId: "run-1", instructions: "do the thing" });
  const missing = parseControlArgs("", { instructionsRequired: true });
  assert.ok("error" in missing && /缺少 runId/.test(missing.error));
  const noInstructions = parseControlArgs("run-1   ", { instructionsRequired: true });
  assert.ok("error" in noInstructions && /缺少指令/.test(noInstructions.error));
});
