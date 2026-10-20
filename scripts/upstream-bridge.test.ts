/**
 * Contract tests for the public pi-subagents bridge (Stage B).
 *
 * Two things are tested here, and they are deliberately different in kind:
 *
 *   1. **The client**, against a fake event bus. What can break silently is the
 *      protocol bookkeeping — reply correlation, listener cleanup on every exit
 *      path, a timeout that must not become a retry, a missing capability that
 *      must not become a zero.
 *   2. **The registered workflow resource**, resolved and *executed* through the
 *      installed pi-subagents package with fake child results. The failure that
 *      matters most is a workflow that returns green while the review said no, so
 *      the negative and malformed verdict paths are the point of the exercise.
 *
 * Executing the expanded script never launches a child: the sandbox here is a
 * local `runs` stub. Nothing in this file spawns a subagent, touches a real
 * project, or writes outside a temp directory.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

function tempProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-bridge-")));
  mkdirSync(join(root, ".trellis", "tasks", "10-20-demo"), { recursive: true });
  return root;
}

/** Real temporary Git membership without commits in any user's checkout. */
function taskWorktree(root: string): string {
  const git = (args: string[], input?: string) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" },
  }).trim();
  git(["init", "-b", "main"]);
  const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
  const commit = git(["commit-tree", tree, "-m", "fixture"]);
  git(["update-ref", "refs/heads/main", commit]);
  const worktree = join(root, "custom-tree");
  git(["worktree", "add", "-b", "feat/10-20-demo", worktree]);
  return worktree;
}

function snapshot(runs: Record<string, unknown>[] = [], omitted: Record<string, unknown> = {}) {
  return { kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1,
    caps: { maxRuns: 100, maxChildrenPerNode: 50, maxDepth: 4, maxStringLength: 1000, maxSerializedBytes: 100000 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false, ...omitted },
    runs: runs.map((run) => ({ kind: "subagent", label: "child", ...run })) };
}

function fleet(used: number) {
  return { version: 1, entries: [], totalActive: 0, omitted: 0, topLevelAsyncCapacity: { used, limit: 10 } };
}

// ── A fake pi.events bus ──────────────────────────────────────────────

interface FakeBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
  /** Channels that currently have listeners, so a leak is observable. */
  listenerCount(): number;
  /** Reply to the next request with a fixed responder. */
  respond(responder: (request: Record<string, unknown>) => unknown | undefined): void;
  /** Every request the client emitted, oldest first. */
  requests: Record<string, unknown>[];
}

function fakeBus(): FakeBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const requests: Record<string, unknown>[] = [];
  let responder: ((request: Record<string, unknown>) => unknown | undefined) | null = null;

  const bus: FakeBus = {
    requests,
    emit(channel, data) {
      if (channel !== "subagents:rpc:v1:request") {
        for (const handler of listeners.get(channel) ?? []) handler(data);
        return;
      }
      const request = data as Record<string, unknown>;
      requests.push(request);
      const reply = responder?.(request);
      if (reply === undefined) return;
      const replyChannel = `subagents:rpc:v1:reply:${String(request.requestId)}`;
      // Reply asynchronously, the way a real bridge does.
      queueMicrotask(() => {
        for (const handler of listeners.get(replyChannel) ?? []) handler(reply);
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
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    respond(next) {
      responder = next;
    },
  };
  return bus;
}

function reply(request: Record<string, unknown>, data: unknown): Record<string, unknown> {
  return { version: 1, requestId: request.requestId, success: true, data };
}

function failure(request: Record<string, unknown>, code: string, message: string): Record<string, unknown> {
  return { version: 1, requestId: request.requestId, success: false, error: { code, message } };
}

const PING_OK = {
  version: 1,
  methods: ["ping", "status", "manage", "spawn", "steer", "interrupt", "stop", "resume", "cost"],
  capabilities: {
    status: true,
    asyncSpawn: true,
    statusProjection: { version: 1, untargeted: "in-memory-when-ready", targeted: "executor" },
    cost: { version: 1 },
    fleetStatus: { version: 1 },
    asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
  },
  events: { asyncComplete: "subagent:async-complete" },
  session: { sessionId: "session-1" },
};

// ── core/subagents-client.ts: protocol bookkeeping ───────────────────

test("bridge: a reply is matched to its own request and the listener is removed", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_OK);
    if (request.method === "status") return reply(request, { text: "ok", asyncSnapshot: snapshot() });
    return undefined;
  });

  const client = new SubagentsClient({ events: bus });
  try {
    const ping = await client.ping();
    assert.equal(ping.ok, true, "ping succeeds");
    const status = await client.status({});
    assert.equal(status.ok, true);
    assert.equal(bus.requests.length, 2, "one request per call; ping is cached afterwards");
    assert.equal(bus.listenerCount(), 0, "no reply listener survives a settled request");

    // A second ping uses the cache instead of a third request.
    await client.ping();
    assert.equal(bus.requests.length, 2);
  } finally {
    client.dispose();
  }
});

test("bridge: a reply for a different request id is ignored, not mistaken for ours", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") {
      // First a foreign envelope, then the real one. The foreign one must not settle it.
      queueMicrotask(() => {
        const foreign = { version: 1, requestId: "someone-else", success: true, data: { bogus: true } };
        bus.emit(`subagents:rpc:v1:reply:${String(request.requestId)}`, foreign);
      });
      return reply(request, PING_OK);
    }
    return undefined;
  });

  const client = new SubagentsClient({ events: bus });
  try {
    const ping = await client.ping();
    assert.equal(ping.ok, true);
    assert.equal(ping.ok && ping.data.version, 1, "the real reply, not the foreign one");
  } finally {
    client.dispose();
  }
});

test("bridge: a spawn timeout surfaces the alias and never re-sends", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  // Never answer the spawn: this is the ambiguous case.
  bus.respond((request) => request.method === "ping" ? reply(request, PING_OK) : undefined);

  const client = new SubagentsClient({ events: bus, spawnTimeoutMs: 30 });
  try {
    const [result] = await Promise.all([client.spawn({ workflow: "coworkflow.implement-review" }), delay(40)]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "timeout");
    assert.match(result.message, /不要重发/, "the message tells the caller not to retry");
    const spawns = bus.requests.filter((request) => request.method === "spawn");
    assert.equal(spawns.length, 1, "exactly one spawn was emitted, ever");
    assert.equal(bus.listenerCount(), 0, "the timeout path removes its listener too");

    const requestId = String(spawns[0]?.requestId);
    assert.equal(
      result.ambiguous?.alias,
      `rpc-spawn-${requestId}`,
      "the documented recovery alias names the request that may have started a run",
    );
  } finally {
    client.dispose();
  }
});

test("bridge: a refused reply keeps pi-subagents' own error code", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  bus.respond((request) =>
    request.method === "ping" ? failure(request, "no_active_session", "No active extension context for subagent RPC.") : undefined,
  );

  const client = new SubagentsClient({ events: bus });
  try {
    const result = await client.ping();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "refused");
    assert.equal(result.code, "no_active_session");
  } finally {
    client.dispose();
  }
});

test("bridge: an unsupported capability floor is reported, not guessed around", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  bus.respond((request) =>
    request.method === "ping"
      ? reply(request, {
          version: 1,
          methods: ["ping", "status", "select"],
          capabilities: { status: true },
          events: {},
          session: {},
        })
      : undefined,
  );

  const client = new SubagentsClient({ events: bus });
  try {
    const check = await client.requireCapabilities();
    assert.equal(check.ok, false);
    if (check.ok) return;
    assert.match(check.message, /spawn 方法/);
    assert.match(check.message, /asyncSpawn/);
    assert.match(check.message, /升级 pi-subagents/, "the diagnostic is actionable");
  } finally {
    client.dispose();
  }
});

test("bridge: a host without pi.events refuses instead of reading private state", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const client = new SubagentsClient({ events: undefined });
  const activity = await client.observeActivity();
  assert.equal(activity.kind, "unknown");
  const cost = await client.cost();
  assert.equal(cost.kind, "unknown");
  client.dispose();
});

test("bridge: unknown status and unknown cost are not zero", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method !== "ping") {
      // `status` answers, but this build projects no asyncSnapshot.
      if (request.method === "status") return reply(request, { text: "ok" });
      return undefined;
    }
    // A build that advertises neither statusProjection nor cost.
    return reply(request, { version: 1, methods: ["ping", "status", "spawn"], capabilities: { asyncSpawn: true }, events: {}, session: {} });
  });

  const client = new SubagentsClient({ events: bus });
  try {
    const cost = await client.cost();
    assert.equal(cost.kind, "unknown", "a missing cost capability is unknown, not 0");
    if (cost.kind === "unknown") assert.match(cost.reason, /没有通告 cost 能力/);

    const activity = await client.observeActivity();
    assert.equal(activity.kind, "unknown", "an absent asyncSnapshot is unknown, not 'nothing running'");
  } finally {
    client.dispose();
  }
});

test("bridge: native cost keeps its unresolved-children uncertainty", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const usage = (input: number, output: number) => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.5,
    turns: 3,
  });
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_OK);
    if (request.method === "cost") {
      return reply(request, {
        version: 1,
        parent: usage(100, 20),
        children: [{ label: "trellis-implement", agent: "trellis-implement", runId: "run-1", usage: usage(50, 10), sessionFile: "/s/child.jsonl" }],
        childTotal: usage(50, 10),
        total: { ...usage(150, 30), cost: 1, turns: 6 },
        unresolvedAsyncChildren: 2,
      });
    }
    return undefined;
  });

  const client = new SubagentsClient({ events: bus });
  try {
    const cost = await client.cost();
    assert.equal(cost.kind, "known");
    if (cost.kind !== "known") return;
    assert.equal(cost.total.turns, 6);
    assert.equal(cost.unresolvedAsyncChildren, 2);
    assert.equal(cost.incomplete, true, "a lower bound is marked as such");
    assert.equal(cost.children[0]?.sessionFile, "/s/child.jsonl", "the only safe source for child history");
  } finally {
    client.dispose();
  }
});

test("bridge: dispose rejects in-flight requests and drops every listener", async () => {
  const { SubagentsClient } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const bus = fakeBus();
  bus.respond(() => undefined);

  const client = new SubagentsClient({ events: bus, requestTimeoutMs: 5000 });
  const pending = client.ping();
  assert.equal(bus.listenerCount(), 1, "one listener while the request is in flight");
  client.dispose();
  const settled = await pending;
  assert.equal(settled.ok, false);
  if (!settled.ok) assert.equal(settled.reason, "closed");
  assert.equal(bus.listenerCount(), 0, "session end removes the listener, it does not wait for the timeout");
  // Idempotent.
  client.dispose();
});

// ── Project admission ────────────────────────────────────────────────

test("admission: a counting failure is a refusal, not a silent pass", async () => {
  const { decideAdmission } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const refused = decideAdmission({ limit: 2, activity: { kind: "unknown", reason: "status 不可用" }, pending: 0 });
  assert.equal(refused.admit, false);
  if (refused.admit) return;
  assert.match(refused.reason, /状态接口现在说不出活跃 run 数/);
  assert.match(refused.reason, /清空「本项目并发上限」/, "the refusal names a way out");

  const noLimit = decideAdmission({ limit: null, activity: { kind: "unknown", reason: "x" }, pending: 0 });
  assert.equal(noLimit.admit, true, "no project limit means no project gate");
});

test("admission: the ceiling counts native runs plus this process's pending launches", async () => {
  const { decideAdmission } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const activity = {
    kind: "known" as const,
    active: 1,
    runs: [{ id: "run-1", state: "running", agent: "trellis-implement" }],
    omitted: 0,
  };
  assert.equal(decideAdmission({ limit: 2, activity, pending: 0 }).admit, true, "1 of 2");
  assert.equal(decideAdmission({ limit: 2, activity, pending: 1 }).admit, false, "1 native + 1 pending = the limit");
  const blocked = decideAdmission({ limit: 2, activity, pending: 1 });
  assert.match(blocked.admit ? "" : blocked.reason, /trellis-implement\(run-1, running\)/, "the refusal names the runs");
});

test("bridge: a reservation is released once the run is visible natively", async () => {
  const { attachSubagents } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const host = {};
  const bus = fakeBus();
  let active = 0;
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_OK);
    if (request.method === "status") {
      return reply(request, {
        text: "ok",
        asyncSnapshot: snapshot(Array.from({ length: active }, (_, index) => ({ id: `run-${index}`, state: "running" }))),
      });
    }
    return undefined;
  });

  const bridge = attachSubagents(host, { epoch: 0, events: bus });
  try {
    assert.equal((await bridge.admit("launch-1", 1)).admit, true, "the first launch fits");
    assert.equal(bridge.pending(), 1, "it holds a reservation until its run exists");
    assert.equal((await bridge.admit("launch-2", 1)).admit, false, "a second launch in the same turn is refused");

    // The run becomes visible; the reservation must stop counting.
    active = 1;
    bridge.bind("launch-1", "run-0");
    assert.equal((await bridge.admit("launch-2", 1)).admit, false, "one native run already uses the single slot");
    bridge.release("launch-1");
    active = 0;
    assert.equal((await bridge.admit("launch-3", 1)).admit, true, "a finished run frees the slot");
  } finally {
    bridge.dispose();
  }
});

test("bridge: a synchronous gate refuses before an observation exists", async () => {
  const { attachSubagents } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const host = {};
  const bus = fakeBus();
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_OK);
    if (request.method === "status") return reply(request, { text: "ok", asyncSnapshot: snapshot() });
    return undefined;
  });

  const bridge = attachSubagents(host, { epoch: 0, events: bus });
  try {
    const early = bridge.admitSync("launch-1", 3);
    assert.equal(early.admit, false, "an unobserved limit is not assumed satisfied");
    if (!early.admit) assert.match(early.reason, /还没有读到 pi-subagents 的公开运行状态/);

    await bridge.observe();
    assert.equal(bridge.admitSync("launch-2", 3).admit, true, "the gate works as soon as one observation exists");
  } finally {
    bridge.dispose();
  }
});

test("bridge: a new session epoch replaces the client instead of reusing it", async () => {
  const { attachSubagents } = (await import(here("../core/subagents-client.ts"))) as typeof import(
    "../core/subagents-client.ts"
  );
  const host = {};
  const first = fakeBus();
  first.respond((request) => (request.method === "ping" ? reply(request, PING_OK) : undefined));
  const second = fakeBus();
  second.respond((request) => (request.method === "ping" ? reply(request, PING_OK) : undefined));

  const before = attachSubagents(host, { epoch: 0, events: first });
  const after = attachSubagents(host, { epoch: 1, events: second });
  try {
    assert.notEqual(before, after, "a replaced session gets a new bridge");
    assert.equal(before.client.available, false, "the old client is closed");
  } finally {
    after.dispose();
  }
});

// ── extensions/coworkflow.ts: the command refuses before any spawn ───

interface RunHarness {
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  bus: FakeBus;
  /** The host object the extension was loaded with, for the exported await points. */
  host: Record<string, unknown>;
  /** Everything this package asked the host to render, passive or not. */
  messages: string[];
  emit(event: string, payload?: Record<string, unknown>): unknown[];
  close(): void;
}

/** Load the real extension against a temp project with a fake event bus. */
async function loadRunHarness(root: string, options: { autoEnable: boolean }): Promise<RunHarness> {
  const modules: Record<string, boolean> = {};
  for (const id of ["trellis", "worktree", "agents", "subagents", "subagent-context", "lane-worktree", "capacity", "panel"]) {
    modules[id] = true;
  }
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({ version: 1, autoEnable: options.autoEnable, modules }, null, 2),
  );

  const saved = { cwd: process.cwd(), child: process.env.PI_SUBAGENT_CHILD, id: process.env.PI_SESSION_ID };
  process.chdir(root);
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SESSION_ID;

  const bus = fakeBus();
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const messages: string[] = [];
  const host = {
    events: bus,
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
      };
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, spec);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
    sendUserMessage() {},
    getSessionName: () => undefined,
  };

  const { default: extension } = (await import(here("../extensions/coworkflow.ts"))) as {
    default: (h: unknown) => void;
  };
  extension(host);

  const ctx = {
    cwd: root,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "session-bridge-test",
      getSessionFile: () => "/sessions/--x--/2026-01-01T00-00-00-000Z_session-bridge-test.jsonl",
    },
    ui: { notify: () => {} },
  };

  return {
    bus,
    commands,
    host,
    messages,
    emit(event, payload = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(handler({ type: event, ...payload }, ctx));
      return results;
    },
    close() {
      process.chdir(saved.cwd);
      if (saved.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = saved.child;
      if (saved.id === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = saved.id;
    },
  };
}

const ctxForRun = (root: string) => ({
  cwd: root,
  mode: "tui",
  sessionManager: { getSessionId: () => "session-bridge-test" },
  ui: { notify: () => {} },
});

test("command: /Coworkflow:run refuses an unusable bridge without emitting a spawn", async () => {
  const root = tempProject();
  const harness = await loadRunHarness(root, { autoEnable: true });
  try {
    const command = harness.commands.get("Coworkflow:run");
    assert.ok(command, "the command exists while the layer is loaded");

    // No pi-subagents behind the bus: the ping is refused, so the command must
    // refuse and, above all, must not emit a spawn it cannot follow up on.
    harness.bus.respond((request) =>
      request.method === "ping"
        ? failure(request, "no_active_session", "No active extension context for subagent RPC.")
        : undefined,
    );
    await command.handler("", ctxForRun(root));
    const spawns = harness.bus.requests.filter((request) => request.method === "spawn");
    assert.equal(spawns.length, 0, "nothing was dispatched without a usable bridge");
  } finally {
    harness.emit("session_shutdown", { reason: "quit" });
    harness.close();
  }
});

test("command: /Coworkflow:run refuses a task that has no isolated worktree", async () => {
  const root = tempProject();
  const harness = await loadRunHarness(root, { autoEnable: true });
  try {
    harness.bus.respond((request) => {
      if (request.method === "ping") return reply(request, PING_OK);
      if (request.method === "status") return reply(request, { text: "ok", asyncSnapshot: snapshot() });
      return undefined;
    });

    const command = harness.commands.get("Coworkflow:run");
    assert.ok(command);
    await command.handler("", ctxForRun(root));

    const spawns = harness.bus.requests.filter((request) => request.method === "spawn");
    assert.equal(spawns.length, 0, "a task with no worktree is refused before spawn");
  } finally {
    harness.emit("session_shutdown", { reason: "quit" });
    harness.close();
  }
});

test("command: /Coworkflow:run launches the registered workflow against the task worktree", async () => {
  const root = tempProject();
  const taskDir = join(root, ".trellis", "tasks", "10-20-demo");
  const worktree = taskWorktree(root);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({ id: "demo", title: "Demo task", worktree_path: worktree, branch: "feat/10-20-demo" }),
  );
  // `activeTaskDir` reads Trellis's own session pointer, so write the one this
  // session id maps to.
  const { contextKeyFor } = (await import(here("../core/trellis.ts"))) as typeof import("../core/trellis.ts");
  const pointerDir = join(root, ".trellis", ".runtime", "sessions");
  mkdirSync(pointerDir, { recursive: true });
  writeFileSync(
    join(pointerDir, `${contextKeyFor("session-bridge-test")}.json`),
    JSON.stringify({ current_task: ".trellis/tasks/10-20-demo" }),
  );

  const resources = await import(new URL("file://" + join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/pi-subagents/src/workflows/workflow-resources.js")).href);
  const harness = await loadRunHarness(root, { autoEnable: true });
  try {
    harness.bus.respond((request) => {
      if (request.method === "ping") return reply(request, PING_OK);
      if (request.method === "status") return reply(request, { text: "ok", asyncSnapshot: snapshot() });
      if (request.method === "spawn") {
        const params = request.params as Record<string, any>;
        const resolved = resources.resolveWorkflowResource(params.workflow, params.args, "session-bridge-test");
        assert.equal(resolved.ok, true, resolved.error);
        assert.ok(resolved.resource.script.includes(JSON.stringify(worktree)), "production registration uses the verified plan");
        assert.equal(resources.resolveWorkflowResource(params.workflow, { ...params.args, worktree: root, mainCheckout: "/fake" }, "session-bridge-test").ok, false);
        return reply(request, {
          text: "launched",
          details: { mode: "workflow", results: [], runId: "run-bridge-1", asyncId: "run-bridge-1", asyncDir: "/tmp/run-bridge-1", missionId: "mission-bridge-1" },
        });
      }
      return undefined;
    });

    const command = harness.commands.get("Coworkflow:run");
    assert.ok(command);
    await command.handler("重点看 event hook", ctxForRun(root));

    const spawns = harness.bus.requests.filter((request) => request.method === "spawn");
    assert.equal(spawns.length, 1, "exactly one native spawn");
    const params = (spawns[0]?.params ?? {}) as Record<string, any>;
    assert.equal(params.workflow, "coworkflow.implement-review", "the registered resource, not a raw script");
    assert.equal(params.cwd, worktree, "the launch cwd is the task worktree");
    assert.equal(params.args.taskRef, ".trellis/tasks/10-20-demo");
    assert.equal(params.args.worktree, undefined, "paths are bound by the host, never accepted from args");
    assert.equal(params.args.focus, "重点看 event hook");
    assert.match(String(params.options?.mission?.title), /实现与复核/, "an explicit mission, not an anonymous run");
    assert.equal(params.async, undefined, "async is the documented default; nothing overrides it");
    assert.equal(params.options?.goal, undefined, "goal mode stays off");

    // The receipt is what earns a task → run link.
    const { readTaskLinks } = (await import(here("../core/subagents-workflow.ts"))) as typeof import(
      "../core/subagents-workflow.ts"
    );
    const links = readTaskLinks(root, ".trellis/tasks/10-20-demo");
    assert.equal(links.length, 1);
    assert.equal(links[0]?.runId, "run-bridge-1");
    assert.equal(links[0]?.missionId, "mission-bridge-1");
    assert.equal(links[0]?.worktree, worktree);

    // A direct model invocation rechecks filesystem/task state before native resolution.
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ worktree_path: root, branch: "feat/10-20-demo" }));
    const gates = await Promise.all(harness.emit("tool_call", {
      toolName: "subagent", toolCallId: "stale-direct", input: { workflow: "coworkflow.implement-review", args: { taskRef: ".trellis/tasks/10-20-demo" } },
    }));
    assert.ok(gates.some((result: any) => result?.block === true));
    const stale = resources.resolveWorkflowResource("coworkflow.implement-review", { taskRef: ".trellis/tasks/10-20-demo" }, "session-bridge-test");
    assert.equal(stale.ok, false, "stale task binding is cleared before a direct launch");
  } finally {
    harness.emit("session_shutdown", { reason: "quit" });
    harness.close();
  }
});

test("lifecycle: the workflow resource is released when the session ends", async () => {
  const { registerImplementReviewWorkflow } = (await import(here("../core/subagents-workflow.ts"))) as typeof import(
    "../core/subagents-workflow.ts"
  );
  // Register and release exactly as the module's lifecycle does, then prove the
  // same session id can register again: a leaked registration would throw
  // "already registered" and take /Coworkflow:run down on the next session.
  const sessionId = "session-lifecycle-probe";
  const first = await registerImplementReviewWorkflow(sessionId);
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  if (!first.ok) return;
  first.registration.dispose();

  const second = await registerImplementReviewWorkflow(sessionId);
  assert.equal(second.ok, true, second.ok ? "" : second.message);
  if (second.ok) second.registration.dispose();
});


const VALID_ARGS = { taskRef: ".trellis/tasks/10-20-demo" };
const VERIFIED_CONTEXT = { ...VALID_ARGS, worktree: "/tmp/custom-tree", mainCheckout: "/tmp/main" };

test("workflow: resolve requires host context, rejects overrides, and pins the worktree", async () => {
  const { resolveImplementReview } = await import("../core/subagents-workflow.ts");
  assert.ok("error" in resolveImplementReview(VALID_ARGS), "public args cannot prepare their own authority");
  const ok = resolveImplementReview(VALID_ARGS, VERIFIED_CONTEXT);
  assert.ok("script" in ok);
  assert.match(ok.script, /runs\.run\("implement"/);
  assert.match(ok.script, /runs\.run\("review"/);
  assert.equal((ok.script.match(/worktree: false/g) ?? []).length, 2);
  assert.doesNotMatch(ok.script, /runs\.host/);
  for (const args of [
    { ...VALID_ARGS, worktree: "/main", mainCheckout: "/fake" },
    { ...VALID_ARGS, script: "return 1" }, {},
    { taskRef: ".trellis/tasks/." }, { taskRef: ".trellis/tasks/.." },
    { taskRef: ".trellis/tasks/other" },
    { ...VALID_ARGS, reviewAgent: "trellis-implement" },
    { ...VALID_ARGS, reviewAgent: "trellis check; rm -rf /" },
    { ...VALID_ARGS, focus: 3 },
  ]) assert.ok("error" in resolveImplementReview(args, VERIFIED_CONTEXT), JSON.stringify(args));
  assert.equal(ok instanceof Promise, false);
});

// ── Executing the expansion against fake child results ───────────────

type ChildResult = Record<string, unknown>;

interface Sandbox {
  keys: string[];
  run(key: string, params: Record<string, unknown>): Promise<ChildResult>;
}

/** Run the expanded script the way the workflow sandbox would: `runs.run` only. */
async function executeScript(
  script: string,
  results: Record<string, ChildResult | ((params: Record<string, unknown>) => ChildResult | Promise<ChildResult>)>,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const sandbox: Sandbox = {
    keys: [],
    async run(key, params) {
      sandbox.keys.push(key);
      const entry = results[key];
      if (entry === undefined) throw new Error(`unexpected child '${key}'`);
      const value = typeof entry === "function" ? await entry(params) : entry;
      return value;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (...call: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction("runs", script);
  try {
    return { ok: true, value: await fn(sandbox) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function expandedScript(): Promise<string> {
  const { resolveImplementReview } = (await import(here("../core/subagents-workflow.ts"))) as typeof import(
    "../core/subagents-workflow.ts"
  );
  const expanded = resolveImplementReview(VALID_ARGS, VERIFIED_CONTEXT);
  assert.ok("script" in expanded);
  return expanded.script;
}

function implementChild(overrides: ChildResult = {}): ChildResult {
  return {
    runId: "run-impl",
    ok: true,
    output: "implemented the thing",
    outputReference: "/tmp/impl.md",
    artifactPaths: ["/tmp/impl.md"],
    structuredOutput: { status: "completed", summary: "did it", changedFiles: ["a.ts"], residualRisks: ["none"] },
    ...overrides,
  };
}

function reviewChild(verdict: string, overrides: ChildResult = {}): ChildResult {
  return {
    runId: "run-review",
    ok: true,
    output: "reviewed",
    outputReference: "/tmp/review.md",
    artifactPaths: ["/tmp/review.md"],
    structuredOutput: { verdict, summary: `verdict ${verdict}`, findings: verdict === "pass" ? [] : ["blocking issue"] },
    ...overrides,
  };
}

test("workflow: a passing review returns the native identities for the parent to audit", async () => {
  const script = await expandedScript();
  const result = await executeScript(script, { implement: implementChild(), review: reviewChild("pass") });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  if (!result.ok) return;
  const value = result.value as Record<string, any>;
  assert.equal(value.status, "review-passed");
  assert.equal(value.acceptance, "parent-owned", "a green workflow is not an accepted change");
  assert.equal(value.implement.runId, "run-impl");
  assert.equal(value.review.runId, "run-review");
  assert.equal(value.review.verdict, "pass");
  assert.equal(value.worktree, VERIFIED_CONTEXT.worktree);
  assert.match(String(value.note), /不代表验收通过/);
});

test("workflow: a negative review fails the workflow instead of returning green", async () => {
  const script = await expandedScript();
  for (const verdict of ["changes_requested", "blocked"]) {
    const result = await executeScript(script, { implement: implementChild(), review: reviewChild(verdict) });
    assert.equal(result.ok, false, `${verdict} must not be a successful workflow`);
    if (result.ok) continue;
    assert.match(result.message, new RegExp(`verdict '${verdict}'`));
    assert.match(result.message, /not accepted/);
  }
});

test("workflow: a malformed or failed review verdict fails closed", async () => {
  const script = await expandedScript();

  const missingVerdict = await executeScript(script, {
    implement: implementChild(),
    review: reviewChild("pass", { structuredOutput: { summary: "no verdict" } }),
  });
  assert.equal(missingVerdict.ok, false, "a missing verdict is not a pass");
  if (!missingVerdict.ok) assert.match(missingVerdict.message, /verdict 'null'/);

  const noStructured = await executeScript(script, {
    implement: implementChild(),
    review: reviewChild("pass", { structuredOutput: null }),
  });
  assert.equal(noStructured.ok, false);

  const failedChild = await executeScript(script, {
    implement: implementChild(),
    review: reviewChild("pass", { ok: false, error: "child crashed" }),
  });
  assert.equal(failedChild.ok, false);
  if (!failedChild.ok) assert.match(failedChild.message, /review step did not complete \(child crashed\)/);
});

test("workflow: a non-completed implement verdict stops before review launches", async () => {
  const script = await expandedScript();
  const result = await executeScript(script, {
    implement: implementChild({ structuredOutput: { status: "blocked", summary: "cannot proceed" } }),
    review: reviewChild("pass"),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /'blocked', not 'completed'/);
});

test("workflow: the two steps use stable keys in a fixed order", async () => {
  const script = await expandedScript();
  const keys: string[] = [];
  const result = await executeScript(script, {
    implement: (params) => {
      keys.push("implement");
      assert.equal(params.cwd, VERIFIED_CONTEXT.worktree);
      assert.equal(params.agent, "trellis-implement");
      assert.equal(params.context, "fresh");
      assert.equal(params.worktree, false);
      assert.equal(params.async, undefined);
      assert.equal((params.acceptance as Record<string, unknown>).report, "on");
      assert.match(String(params.task), /Active task: \.trellis\/tasks\/10-20-demo/);
      return implementChild();
    },
    review: (params) => {
      keys.push("review");
      assert.equal(params.agent, "trellis-check");
      assert.equal(params.context, "fresh");
      assert.equal(params.worktree, false);
      assert.equal(params.async, undefined);
      assert.equal((params.acceptance as Record<string, unknown>).report, "on");
      assert.match(String(params.task), /run-impl/, "the reviewer is told which implementation it audits");
      assert.match(String(params.task), /\/tmp\/impl\.md/, "and where that implementation's artifact is");
      return reviewChild("pass");
    },
  });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.deepEqual(keys, ["implement", "review"]);
});

// ── Registration against the installed package ───────────────────────

function packageVersion(): string | null {
  const dir = join(process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents");
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

const installed = packageVersion();
const smokeSkip = installed === null ? "pi-subagents is not installed in this environment" : false;

test("smoke: the resource registers with the installed package, resolves it, and disposes", { skip: smokeSkip }, async () => {
  const { registerImplementReviewWorkflow, WORKFLOW_NAME } = (await import(
    here("../core/subagents-workflow.ts")
  )) as typeof import("../core/subagents-workflow.ts");

  // A throwaway session id: registration is process-local and scoped to it, and
  // nothing here launches a child.
  const sessionId = `coworkflow-smoke-${process.pid}`;
  const outcome = await registerImplementReviewWorkflow(sessionId, { context: () => VERIFIED_CONTEXT });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
  if (!outcome.ok) return;

  try {
    // Resolve through pi-subagents' own lookup, which is what a spawn does.
    const resources = (await import(
      new URL(
        "file://" + join(process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents", "src", "workflows", "workflow-resources.js"),
      ).href
    )) as {
      resolveWorkflowResource(
        name: unknown,
        args?: unknown,
        sessionId?: string,
      ): { ok: true; resource: { script: string; provenance: Record<string, unknown> } } | { ok: false; error: string };
    };

    const resolved = resources.resolveWorkflowResource(WORKFLOW_NAME, VALID_ARGS, sessionId);
    assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
    if (resolved.ok) {
      assert.match(resolved.resource.script, /runs\.run\("implement"/);
      assert.equal((resolved.resource.provenance as { name?: string }).name, WORKFLOW_NAME, "provenance names the resource");
      assert.equal((resolved.resource.provenance as { version?: number }).version, 1);
    }

    // Another session must not see this session's registration.
    const foreign = resources.resolveWorkflowResource(WORKFLOW_NAME, VALID_ARGS, "someone-else");
    assert.equal(foreign.ok, false, "registration is session-scoped, not process-global");

    // Invalid args are rejected by the owner before any child could start.
    const invalid = resources.resolveWorkflowResource(WORKFLOW_NAME, { taskRef: "nope" }, sessionId);
    assert.equal(invalid.ok, false);
  } finally {
    outcome.registration.dispose();
  }

  // After disposal the name is gone, so a replacement registration would succeed.
  const again = await registerImplementReviewWorkflow(sessionId);
  assert.equal(again.ok, true, again.ok ? "" : again.message);
  if (again.ok) again.registration.dispose();
});

test("smoke: the child-extension requirement registers and disposes", { skip: smokeSkip }, async () => {
  const { registerChildExtensionRequirement } = (await import("../core/subagents-workflow.ts")) as typeof import(
    "../core/subagents-workflow.ts"
  );
  const entry = here("../extensions/coworkflow.ts");
  assert.equal(existsSync(entry), true, "the extension entry itself is the path we register");

  const sessionId = `coworkflow-child-smoke-${process.pid}`;
  const outcome = await registerChildExtensionRequirement(sessionId, entry);
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
  if (!outcome.ok) return;
  try {
    const required = (await import(
      new URL(
        "file://" + join(process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents", "src", "shared", "required-child-extensions.js"),
      ).href
    )) as { resolveRequiredChildExtensions(sessionId?: string): readonly { id: string; path: string; requireForAllRunners?: true }[] };

    const snapshot = required.resolveRequiredChildExtensions(sessionId);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.id, "pi-coworkflow");
    assert.equal(snapshot[0]?.requireForAllRunners, true, "a runner that cannot load it must refuse, not drop it");
  } finally {
    outcome.registration.dispose();
  }
});

// ── Task identity and the run plan ───────────────────────────────────

test("run plan: a task without a worktree is refused, not run in the main checkout", async () => {
  const { planRun } = (await import(here("../modules/subagents/index.ts"))) as typeof import(
    "../modules/subagents/index.ts"
  );
  const root = tempProject();
  const taskDir = join(root, ".trellis", "tasks", "10-20-demo");

  const noTask = planRun(root, null, null);
  assert.equal(noTask.ok, false);
  if (!noTask.ok) assert.match(noTask.message, /没有活跃的 Trellis 任务/);

  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "demo", title: "Demo" }));
  const noWorktree = planRun(root, null, taskDir);
  assert.equal(noWorktree.ok, false);
  if (!noWorktree.ok) assert.match(noWorktree.message, /还没有隔离 worktree/);

  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "demo", worktree_path: join(root, "missing") }));
  const gone = planRun(root, null, taskDir);
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.match(gone.message, /不存在或不是目录/);

  const worktree = taskWorktree(root);
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "demo", title: "Demo task", worktree_path: worktree, branch: "feat/10-20-demo" }));
  const ready = planRun(root, null, taskDir);
  assert.equal(ready.ok, true, ready.ok ? "" : ready.message);
  if (ready.ok) {
    assert.equal(ready.taskRef, ".trellis/tasks/10-20-demo");
    assert.equal(ready.worktree, worktree);
    assert.equal(ready.title, "Demo task");

    // And the plan's own output must satisfy the resolver the workflow will run.
    const { resolveImplementReview } = (await import("../core/subagents-workflow.ts")) as typeof import(
      "../core/subagents-workflow.ts"
    );
    const expanded = resolveImplementReview({ taskRef: ready.taskRef }, ready);
    assert.equal("script" in expanded, true, "the command's real plan expands without hand-adjusted args");
  }
});

test("run plan: a task whose 'worktree' is the main checkout is refused", async () => {
  const { planRun } = (await import(here("../modules/subagents/index.ts"))) as typeof import(
    "../modules/subagents/index.ts"
  );
  const root = tempProject();
  const taskDir = join(root, ".trellis", "tasks", "10-20-demo");
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "demo", worktree_path: root }));
  const plan = planRun(root, null, taskDir);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.message, /拒绝在主 checkout 里跑实现/);
});

test("links: only a correlated receipt is recorded, and the main checkout keeps one map", async () => {
  const { recordLaunchLink, readTaskLinks } = (await import("../core/subagents-workflow.ts")) as typeof import(
    "../core/subagents-workflow.ts"
  );
  const root = tempProject();
  recordLaunchLink(root, {
    runId: "run-1",
    missionId: "mission-1",
    taskRef: ".trellis/tasks/10-20-demo",
    worktree: "/tmp/wt-10-20-demo",
    workflow: "coworkflow.implement-review",
  });
  recordLaunchLink(root, {
    runId: "run-2",
    taskRef: ".trellis/tasks/10-20-demo",
    worktree: "/tmp/wt-10-20-demo",
    workflow: "coworkflow.implement-review",
  });
  // Re-recording one run must not duplicate it.
  recordLaunchLink(root, {
    runId: "run-1",
    missionId: "mission-1",
    taskRef: ".trellis/tasks/10-20-demo",
    worktree: "/tmp/wt-10-20-demo",
    workflow: "coworkflow.implement-review",
  });

  const links = readTaskLinks(root, ".trellis/tasks/10-20-demo");
  assert.deepEqual(links.map((entry) => entry.runId), ["run-2", "run-1"]);
  assert.equal(links[1]?.missionId, "mission-1");
  assert.deepEqual(readTaskLinks(root, ".trellis/tasks/other"), [], "links are per task, not global");
});

// B2: public DTO fidelity and asynchronous failure boundaries.
test("protocol: malformed ping/capabilities and incomplete cost never become known zero", async () => {
  const { decodePing, hasCapability, decodeCost } = await import("../core/subagents-client.ts");
  for (const value of [{}, { ...PING_OK, version: 2 }, { ...PING_OK, methods: [1] }, { ...PING_OK, capabilities: null }]) {
    assert.equal(decodePing(value), null);
  }
  for (const value of [undefined, null, 0, false, true, {}, { version: 0 }, { version: 2 }]) {
    assert.equal(hasCapability({ ...PING_OK, capabilities: { cost: value } }, "cost"), false);
  }
  for (const value of [null, 0, "true", {}, { version: 1 }]) {
    assert.equal(hasCapability({ ...PING_OK, capabilities: { asyncSpawn: value } }, "asyncSpawn"), false);
  }
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1, cost: 0.1 };
  const cost = { version: 1, parent: usage, children: [{ label: "child", agent: "worker", usage }],
    childTotal: usage, total: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, turns: 2, cost: 0.2 }, unresolvedAsyncChildren: 0 };
  assert.equal(decodeCost(cost)?.kind, "known");
  for (const invalid of [
    { ...cost, version: 2 }, { ...cost, unresolvedAsyncChildren: undefined },
    { ...cost, unresolvedAsyncChildren: -1 }, { ...cost, unresolvedAsyncChildren: 0.5 },
    { ...cost, children: undefined }, { ...cost, children: [] }, { ...cost, children: [null] },
    { ...cost, parent: { input: 0, output: 0 } }, { ...cost, parent: { ...usage, cost: -1 } },
    { ...cost, parent: { ...usage, turns: 1.5 } }, { ...cost, total: { ...usage, cost: NaN } },
  ]) assert.equal(decodeCost(invalid), null, JSON.stringify(invalid));
});

test("activity: top-level capacity survives a bounded snapshot and never counts fleet children", async () => {
  const { SubagentsClient } = await import("../core/subagents-client.ts");
  const bus = fakeBus();
  let data: Record<string, unknown> = { fleet: { ...fleet(7), totalActive: 90, omitted: 88 },
    asyncSnapshot: snapshot([{ id: "workflow", kind: "workflow", state: "running" }], { runs: 6 }) };
  bus.respond((request) => reply(request, request.method === "ping" ? PING_OK : data));
  const client = new SubagentsClient({ events: bus });
  try {
    const counted = await client.observeActivity();
    assert.equal(counted.kind === "known" && counted.active, 7);
    assert.equal(counted.kind === "known" && counted.runs[0]?.id, "workflow");
    data = { asyncSnapshot: snapshot([{ id: "terminal", state: "complete" }, { id: "active", state: "queued" }, { id: "paused", state: "paused" }]) };
    assert.equal((await client.observeActivity()).kind, "known");
    const fallback = await client.observeActivity();
    assert.equal(fallback.kind === "known" && fallback.active, 1);
    const invalidSnapshots = [
      { runs: [] }, { ...snapshot(), kind: "other" }, { ...snapshot(), version: 2 },
      { ...snapshot(), omitted: {} }, { ...snapshot(), runs: [null] },
      snapshot([], { runs: 1 }), snapshot([], { children: 1 }), snapshot([], { byteLimitExceeded: true }),
      snapshot([{ id: "x", state: "pending" }]), snapshot([{ id: "x", state: "running", kind: "step" }]),
      snapshot([{ id: "x", state: "running" }, { id: "x", state: "running" }]),
    ];
    for (const value of invalidSnapshots) {
      data = { asyncSnapshot: value, fleet: { ...fleet(0), topLevelAsyncCapacity: { used: -1, limit: 10 } } };
      assert.equal((await client.observeActivity()).kind, "unknown", JSON.stringify(value));
    }
    data = { fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 } };
    assert.equal((await client.observeActivity()).kind, "unknown", "fleet totalActive is never a substitute");
  } finally { client.dispose(); }
});

test("RPC: listener registration failures settle, and closed ping/observations cannot revive caches", async () => {
  const { SubagentsClient, attachSubagents } = await import("../core/subagents-client.ts");
  const throwing = new SubagentsClient({ events: { on() { throw new Error("on failed"); }, emit() { assert.fail("must not emit"); } } });
  const failed = await throwing.ping();
  assert.equal(failed.ok, false);
  throwing.dispose();
  const bus = fakeBus();
  let client: InstanceType<typeof SubagentsClient>;
  bus.respond((request) => {
    queueMicrotask(() => client.dispose());
    return reply(request, PING_OK);
  });
  client = new SubagentsClient({ events: bus });
  assert.equal((await client.ping()).ok, false);
  assert.equal((await client.ping()).ok, false);
  assert.equal(bus.listenerCount(), 0);

  const host = {};
  const bus2 = fakeBus();
  const bridge = attachSubagents(host, { epoch: 1, events: bus2 });
  bus2.respond((request) => {
    if (request.method === "ping") return reply(request, PING_OK);
    bridge.dispose();
    return reply(request, { asyncSnapshot: snapshot() });
  });
  assert.equal((await bridge.observe()).kind, "unknown");
  assert.equal(bridge.admitSync("late", null).admit, false);
  assert.equal((await bridge.admit("late", null)).admit, false);
  assert.equal(bridge.pending(), 0);
  assert.equal(bus2.listenerCount(), 0);
});

test("RPC: malformed, thrown emit, and closed spawns keep the original recovery alias", async () => {
  const { SubagentsClient } = await import("../core/subagents-client.ts");
  for (const mode of ["receipt", "envelope", "throw", "closed"] as const) {
    const bus = fakeBus();
    const client = new SubagentsClient({ events: bus });
    bus.respond((request) => {
      if (request.method === "ping") return reply(request, PING_OK);
      if (mode === "throw") throw new Error("an owner may already have received the event");
      if (mode === "closed") { client.dispose(); return undefined; }
      if (mode === "envelope") return { version: 1, requestId: request.requestId, success: false, error: {} };
      return reply(request, { text: "accepted", details: {} });
    });
    try {
      const result = await client.spawn({ agent: "worker" });
      assert.equal(result.ok, false);
      const spawns = bus.requests.filter((request) => request.method === "spawn");
      assert.equal(spawns.length, 1);
      if (!result.ok) assert.equal(result.ambiguous?.alias, `rpc-spawn-${spawns[0]?.requestId}`, mode);
      assert.equal(bus.listenerCount(), 0);
    } finally { client.dispose(); }
  }
});

test("admission: concurrent launches reserve atomically; ambiguous evidence never expires into a free slot", async () => {
  const { attachSubagents } = await import("../core/subagents-client.ts");
  const bus = fakeBus();
  let recovered = false;
  bus.respond((request) => {
    if (request.method === "ping") return reply(request, PING_OK);
    const params = request.params as Record<string, unknown>;
    if (params?.id) return recovered ? reply(request, { details: { runId: "recovered" } }) : failure(request, "not_found", "evidence expired");
    return reply(request, { fleet: fleet(0), asyncSnapshot: snapshot(recovered ? [{ id: "recovered", state: "complete" }] : []) });
  });
  const bridge = attachSubagents({}, { epoch: 0, events: bus });
  try {
    const decisions = await Promise.all([bridge.admit("a", 1), bridge.admit("b", 1)]);
    assert.equal(decisions.filter((decision) => decision.admit).length, 1);
    bridge.hold("a", "rpc-spawn-lost");
    const now = Date.now;
    Date.now = () => now() + 600_000;
    try {
      assert.equal((await bridge.admit("c", 1)).admit, false);
      assert.equal(bridge.pending(), 1, "missing evidence, even after ten minutes, does not prove no execution");
    } finally { Date.now = now; }
    recovered = true;
    await bridge.observe();
    assert.equal(bridge.pending(), 0, "a correlated terminal snapshot releases the reservation");
    assert.equal((await bridge.admit("c", 1)).admit, true);
  } finally { bridge.dispose(); }
});

test("workflow: missing summaries, malformed evidence and pass plus blockers fail closed", async () => {
  const script = await expandedScript();
  for (const structuredOutput of [
    { status: "completed" }, { status: "completed", summary: " ", changedFiles: [], residualRisks: [] },
    { status: "completed", summary: "done", changedFiles: [1], residualRisks: [] },
  ]) {
    let reviewed = false;
    const result = await executeScript(script, { implement: implementChild({ structuredOutput }), review: () => { reviewed = true; return reviewChild("pass"); } });
    assert.equal(result.ok, false);
    assert.equal(reviewed, false);
  }
  for (const structuredOutput of [
    { verdict: "pass" }, { verdict: "pass", summary: " ", findings: [] },
    { verdict: "pass", summary: "reviewed", findings: ["blocker: data loss"] },
    { verdict: "pass", summary: "reviewed", findings: null },
  ]) assert.equal((await executeScript(script, { implement: implementChild(), review: reviewChild("pass", { structuredOutput }) })).ok, false);
});

test("plan: canonical git membership and task branch reject path spoofing without a naming convention", async () => {
  const { planRun } = await import("../modules/subagents/index.ts");
  const root = tempProject();
  const worktree = taskWorktree(root);
  const task = join(root, ".trellis/tasks/10-20-demo");
  const write = (path: string, branch = "feat/10-20-demo") => writeFileSync(join(task, "task.json"), JSON.stringify({ worktree_path: path, branch }));
  write(worktree);
  assert.equal(planRun(root, null, task).ok, true, "custom-tree does not need a task-name suffix");
  assert.equal(planRun(root, ".trellis/tasks/.", task).ok, false);
  assert.equal(planRun(root, ".trellis/tasks/..", task).ok, false);
  const mainAlias = join(root, "main-alias");
  symlinkSync(root, mainAlias, "dir");
  write(mainAlias);
  assert.equal(planRun(root, null, task).ok, false);
  const plain = join(root, "plain");
  mkdirSync(plain);
  write(plain);
  assert.equal(planRun(root, null, task).ok, false);
  const foreign = tempProject();
  write(taskWorktree(foreign));
  assert.equal(planRun(root, null, task).ok, false);
  write(worktree, "feat/wrong-task");
  assert.equal(planRun(root, null, task).ok, false);
});

test("exports: project and Pi-local installs resolve string/import/default exports before global fallback", async () => {
  const { exportEntry } = await import("../core/subagents-workflow.ts");
  for (const prefix of ["node_modules", ".pi/npm/node_modules"]) {
    const root = tempProject();
    const pkg = join(root, prefix, "pi-subagents");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "public.js"), "export const marker = true;");
    for (const entry of ["./public.js", { types: "./unused.d.ts", import: "./public.js" }, { default: "./public.js" }, { node: { import: "./public.js" } }]) {
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./workflow-resources": entry } }));
      assert.equal(exportEntry("./workflow-resources", root), join(pkg, "public.js"));
    }
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ exports: { "./workflow-resources": "../escape.js" } }));
    assert.equal(typeof exportEntry("./workflow-resources", root), "object", "incompatible local owner cannot silently fall back to another copy");
  }
});

test("registration: failed mandatory child guidance never exposes a usable workflow", async () => {
  const root = tempProject();
  const pkg = join(root, "node_modules/pi-subagents");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: {
    "./workflow-resources": "./workflow.js", "./required-child-extensions": "./children.js",
  } }));
  writeFileSync(join(pkg, "workflow.js"), "export function registerWorkflowResource() { throw new Error('WORKFLOW_SHOULD_NOT_REGISTER'); }");
  writeFileSync(join(pkg, "children.js"), "export function registerRequiredChildExtensions() { throw new Error('MANDATORY_GUIDANCE_FAILED'); }");
  const harness = await loadRunHarness(root, { autoEnable: true });
  try {
    harness.bus.respond((request) => reply(request, request.method === "ping" ? PING_OK : { asyncSnapshot: snapshot() }));
    harness.emit("session_start");
    const { subagentsRuntimeSettled, subagentsModule } = await import("../modules/subagents/index.ts");
    await subagentsRuntimeSettled(harness.host);
    const status = subagentsModule.runtimeStatus!(harness.host)!.join("\n");
    assert.match(status, /MANDATORY_GUIDANCE_FAILED/);
    assert.doesNotMatch(status, /WORKFLOW_SHOULD_NOT_REGISTER/);
    assert.match(status, /工作流资源 .* 未注册/);
    const results = await Promise.all(harness.emit("tool_call", {
      toolName: "subagent", input: { workflow: "coworkflow.implement-review", args: VALID_ARGS },
    }));
    assert.ok(results.some((result: any) => result?.block === true));
    assert.equal(harness.messages.length, 0, "registration failures remain passive stored status");
    assert.equal(harness.bus.requests.filter((request) => request.method === "spawn").length, 0);
  } finally { harness.emit("session_shutdown"); harness.close(); }
});
