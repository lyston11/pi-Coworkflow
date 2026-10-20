/**
 * Contract tests for the runtime lifecycle this package owns (Stage B1).
 *
 * The failures covered here are the ones that only appear when a *second* session
 * arrives, or when the host does not behave like the hand-written fakes used
 * elsewhere:
 *
 *   - `pi.on` documents an unsubscribe, but a host in front of us may return
 *     `void`. A listener that cannot be removed must stay inert, and must not be
 *     attached twice, or every run is built twice.
 *   - the workflow resource and the required child extension are registered *per
 *     session id* by pi-subagents, so they have to be withdrawn when this session
 *     stops running Coworkflow and reinstated when it starts again — without a
 *     reload.
 *   - a registration that lands after its session ended must be disposed, not
 *     kept for the next session.
 *   - a registration failure is a *stored* state that `/Coworkflow:status` shows.
 *     It is never a custom message of its own: a status line delivered as a
 *     passive message rewrites the run it was meant to describe.
 *
 * Both host shapes are exercised: one whose `on` returns an unsubscribe and one
 * whose `on` returns nothing. Nothing here launches a child or touches a real
 * project: every root is a temp directory, and the only upstream calls are the
 * resolver lookups.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setSessionFlag } from "../core/trellis.ts";
import { controlSurface } from "../extensions/coworkflow.ts";

const PARENT_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

const ALL_MODULES = [
  "trellis",
  "worktree",
  "agents",
  "subagents",
  "subagent-context",
  "lane-worktree",
  "capacity",
  "panel",
];

function tempProject(options: { autoEnable?: boolean; modules?: Record<string, boolean> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-lifecycle-"));
  mkdirSync(join(root, ".trellis", "tasks", "10-20-demo"), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  const modules: Record<string, boolean> = {};
  for (const id of ALL_MODULES) modules[id] = options.modules?.[id] ?? true;
  writeFileSync(
    join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({ version: 1, autoEnable: options.autoEnable ?? false, modules }, null, 2),
  );
  return root;
}

interface HostShape {
  /** What `on` returns: the documented unsubscribe, or nothing at all. */
  onReturns: "unsubscribe" | "void";
}

interface Harness {
  /** Handlers per event, so a double attach is directly countable. */
  handlerCount(event: string): number;
  handlerCounts(): Record<string, number>;
  commandRegistrations: Map<string, number>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  /** Everything the package asked the host to render. */
  messages: string[];
  emit(event: string, payload?: Record<string, unknown>, ctx?: Record<string, unknown>): unknown[];
  /** Settle the subagents module's registration work for this host. */
  settled(): Promise<void>;
  /** `/Coworkflow:status` output, which is where a stored failure has to show. */
  status(): string;
  close(): void;
}

async function loadExtension(
  root: string,
  shape: HostShape,
  options: { sessionId?: string; child?: boolean } = {},
): Promise<Harness> {
  const saved = {
    cwd: process.cwd(),
    child: process.env.PI_SUBAGENT_CHILD,
    parent: process.env.PI_SUBAGENT_PARENT_SESSION,
    id: process.env.PI_SESSION_ID,
  };
  process.chdir(root);
  if (options.child === true) {
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_PARENT_SESSION = `/sessions/--x--/2026-01-01T00-00-00-000Z_${PARENT_SESSION_ID}.jsonl`;
  } else {
    delete process.env.PI_SUBAGENT_CHILD;
  }
  delete process.env.PI_SESSION_ID;

  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const commandRegistrations = new Map<string, number>();
  const messages: string[] = [];
  const host = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      if (shape.onReturns === "void") return undefined;
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
      };
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
      commandRegistrations.set(name, (commandRegistrations.get(name) ?? 0) + 1);
      commands.set(name, spec);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
    getSessionName: () => undefined,
  };

  const { default: extension } = (await import(here("../extensions/coworkflow.ts"))) as {
    default: (h: unknown) => void;
  };
  const { subagentsRuntimeSettled } = (await import(here("../modules/subagents/index.ts"))) as typeof import(
    "../modules/subagents/index.ts"
  );
  extension(host);

  const sessionCtx = (id: string) => ({
    cwd: root,
    mode: "tui",
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/sessions/--x--/2026-01-01T00-00-00-000Z_${id}.jsonl`,
    },
    ui: { notify: () => {} },
  });

  return {
    handlerCount: (event) => (handlers.get(event) ?? []).length,
    handlerCounts: () => Object.fromEntries([...handlers].map(([event, entries]) => [event, entries.length])),
    commandRegistrations,
    commands,
    messages,
    emit(event, payload = {}, ctx) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(handler({ type: event, ...payload }, ctx ?? sessionCtx(options.sessionId ?? "session-b1")));
      }
      return results;
    },
    settled: () => subagentsRuntimeSettled(host as never),
    status() {
      const command = commands.get("Coworkflow:status");
      assert.ok(command, "status is always registered");
      // The command renders through `sendMessage` like every other report, so the
      // entries it adds are taken back out: `messages` then means "messages that
      // were not the answer to an explicit command".
      const before = messages.length;
      command.handler("", sessionCtx(options.sessionId ?? "session-b1"));
      return messages.splice(before).join("\n");
    },
    close() {
      process.chdir(saved.cwd);
      if (saved.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = saved.child;
      if (saved.parent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
      else process.env.PI_SUBAGENT_PARENT_SESSION = saved.parent;
      if (saved.id === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = saved.id;
    },
  };
}

// ── Upstream lookups: "is the resource registered for this session?" ──

function piSubagentsEntry(rel: string): string | null {
  const dir = join(process.env.HOME ?? "", ".pi", "agent", "npm", "node_modules", "pi-subagents");
  const path = join(dir, rel);
  return existsSync(path) ? path : null;
}

const installed = piSubagentsEntry("src/workflows/workflow-resources.js") !== null;
const skip = installed ? false : "pi-subagents is not installed in this environment";

const ARGS = {
  taskRef: ".trellis/tasks/10-20-demo",
  worktree: "/tmp/wt-10-20-demo",
  mainCheckout: "/tmp/main",
};

async function workflowRegistered(sessionId: string): Promise<boolean> {
  const path = piSubagentsEntry("src/workflows/workflow-resources.js");
  if (path === null) return false;
  const api = (await import(`file://${path}`)) as {
    resolveWorkflowResource(
      name: unknown,
      args?: unknown,
      sessionId?: string,
    ): { ok: boolean; error?: string };
  };
  const result = api.resolveWorkflowResource("coworkflow.implement-review", ARGS, sessionId);
  // Registration is independent of preparation; a fake /tmp task must not execute.
  return result.ok || result.error === "The host has no prepared task/worktree context. Select a valid task and refresh Coworkflow before dispatch.";
}

async function childRequirementCount(sessionId: string): Promise<number> {
  const path = piSubagentsEntry("src/shared/required-child-extensions.js");
  if (path === null) return 0;
  const api = (await import(`file://${path}`)) as {
    resolveRequiredChildExtensions(sessionId?: string): readonly unknown[];
  };
  return api.resolveRequiredChildExtensions(sessionId).length;
}

// ── Lifecycle: on / off / new session, on both host shapes ────────────

for (const onReturns of ["unsubscribe", "void"] as const) {
  for (const initiallyEnabled of [true, false]) {
    test(`lifecycle (${onReturns} on): child refreshes persisted parent flag, initially ${initiallyEnabled}`, async () => {
      const root = tempProject({ autoEnable: !initiallyEnabled });
      assert.equal(setSessionFlag(root, PARENT_SESSION_ID, initiallyEnabled), true);
      const loaded = await loadExtension(root, { onReturns }, { child: true, sessionId: "child-flags" });
      try {
        loaded.emit("session_start", { reason: "startup" });
        const counts = loaded.handlerCounts();
        const run = (enabled: boolean) => {
          const event = {
            messageType: "user",
            prompt: "Read-only generic child task",
            systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
          };
          loaded.emit("before_agent_start", event);
          assert.equal(Boolean(event.systemPromptOptions.sections.pi_coworkflow_child), enabled);
          assert.equal(controlSurface().loadState(), enabled ? "child" : "off");
          assert.deepEqual(loaded.handlerCounts(), counts, "refresh never duplicates listeners");
        };
        run(initiallyEnabled);
        for (const enabled of [!initiallyEnabled, initiallyEnabled, !initiallyEnabled]) {
          assert.equal(setSessionFlag(root, PARENT_SESSION_ID, enabled), true);
          run(enabled);
        }
        assert.deepEqual(loaded.messages, [], "refresh adds no passive messages");
      } finally {
        loaded.emit("session_shutdown", { reason: "quit" });
        loaded.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test(`lifecycle (${onReturns} on): initially off modules gain commands through setSwitch without reload`, async () => {
    const root = tempProject({ autoEnable: true, modules: { subagents: false, "lane-worktree": false } });
    const loaded = await loadExtension(root, { onReturns }, { sessionId: `late-modules-${onReturns}` });
    try {
      loaded.emit("session_start", { reason: "startup" });
      assert.equal(controlSurface().loadState(), "auto");
      assert.equal(loaded.commands.has("Coworkflow:run"), false);
      assert.equal(loaded.commands.has("Coworkflow:lanes"), false);

      const commands = [
        ["subagents", "Coworkflow:run", /subagents 模块关掉了/],
        ["lane-worktree", "Coworkflow:lanes", /lane-worktree 已关闭/],
      ] as const;
      for (const [id, command] of commands) {
        assert.match(controlSurface().setSwitch(id, true), /本会话已生效/);
        await loaded.settled();
        assert.ok(loaded.commands.has(command), `${command} registers in the loaded session`);
        assert.equal(loaded.commandRegistrations.get(command), 1);
      }
      const counts = loaded.handlerCounts();
      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (const [id, command, refusal] of commands) {
          controlSurface().setSwitch(id, false);
          await loaded.settled();
          const before = loaded.messages.length;
          await loaded.commands.get(command)!.handler("", { cwd: root, mode: "tui" });
          assert.match(loaded.messages.splice(before).join("\n"), refusal, "disabled command refuses to act");
          controlSurface().setSwitch(id, true);
          await loaded.settled();
          assert.equal(loaded.commandRegistrations.get(command), 1, "reenabling does not register again");
          assert.deepEqual(loaded.handlerCounts(), counts, "reenabling does not duplicate listeners");
        }
      }
      assert.deepEqual(loaded.messages, [], "switching adds no passive messages");
    } finally {
      loaded.emit("session_shutdown", { reason: "quit" });
      await loaded.settled();
      loaded.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`lifecycle (${onReturns} on): off withdraws the upstream registrations, on reinstates them`, { skip }, async () => {
    const root = tempProject({ autoEnable: true });
    const sessionId = `session-b1-${onReturns}`;
    const loaded = await loadExtension(root, { onReturns }, { sessionId });
    try {
      loaded.emit("session_start", { reason: "startup" });
      await loaded.settled();
      assert.equal(await workflowRegistered(sessionId), true, "the resource is registered for this session");
      assert.equal(await childRequirementCount(sessionId), 1, "and the child requirement is in place");
      assert.equal(
        loaded.messages.length,
        0,
        "registering produces no passive message at all",
      );

      // `/Coworkflow:start off` runs `refresh()` first and then the switch, which
      // is the same path a command from another window takes.
      const start = loaded.commands.get("Coworkflow:start");
      assert.ok(start);
      start.handler("off", {
        cwd: root,
        mode: "tui",
        sessionManager: { getSessionId: () => sessionId },
        ui: {},
      });
      await loaded.settled();
      assert.equal(await workflowRegistered(sessionId), false, "off withdraws the resource this session held");
      assert.equal(await childRequirementCount(sessionId), 0, "and stops requiring the child extension");

      // Back on, same session, no reload. A withdrawn registration must be
      // rebuildable: leaving a handle behind would make this throw upstream.
      start.handler("on", {
        cwd: root,
        mode: "tui",
        sessionManager: { getSessionId: () => sessionId },
        ui: {},
      });
      await loaded.settled();
      assert.equal(await workflowRegistered(sessionId), true, "on reinstates it in the same session");
      assert.equal(await childRequirementCount(sessionId), 1);

      // A registration failure is stored, so a working session reports none, and
      // the only messages so far are the command answers above.
      assert.doesNotMatch(loaded.status(), /^\s*x /m, "no failure is recorded for a clean registration");
      assert.equal(
        loaded.messages.filter((message: string) => message.includes("[subagents]")).length,
        0,
        "nothing was pushed to the transcript as passive status",
      );
    } finally {
      loaded.emit("session_shutdown", { reason: "quit" });
      loaded.close();
    }
  });

  test(`lifecycle (${onReturns} on): a replacement session never inherits the old registration`, { skip }, async () => {
    const root = tempProject({ autoEnable: true });
    const loaded = await loadExtension(root, { onReturns }, { sessionId: "session-b1-first" });
    try {
      loaded.emit("session_start", { reason: "startup" }, {
        cwd: root,
        mode: "tui",
        sessionManager: { getSessionId: () => "session-b1-first", getSessionFile: () => "/first.jsonl" },
        ui: {},
      });
      await loaded.settled();
      assert.equal(await workflowRegistered("session-b1-first"), true);

      // Quit, `/reload`, new, resume and fork all arrive as session_shutdown.
      loaded.emit("session_shutdown", { reason: "new" });
      await loaded.settled();
      assert.equal(await workflowRegistered("session-b1-first"), false, "the ended session's resource is gone");
      assert.equal(await childRequirementCount("session-b1-first"), 0);

      // The replacement announces itself with its own id; identity is updated
      // before any dependent hook, so the resource lands on the new id only.
      loaded.emit("session_start", { reason: "new" }, {
        cwd: root,
        mode: "tui",
        sessionManager: { getSessionId: () => "session-b1-second", getSessionFile: () => "/second.jsonl" },
        ui: {},
      });
      await loaded.settled();
      assert.equal(await workflowRegistered("session-b1-second"), true, "the new session registers for itself");
      assert.equal(await workflowRegistered("session-b1-first"), false, "and not for the old one");

      // A repeated session_start in one session must not double-register: a second
      // registration for the same id is refused upstream, which would show up as a
      // stored failure.
      loaded.emit("session_start", { reason: "resume" }, {
        cwd: root,
        mode: "tui",
        sessionManager: { getSessionId: () => "session-b1-second", getSessionFile: () => "/second.jsonl" },
        ui: {},
      });
      await loaded.settled();
      assert.equal(await workflowRegistered("session-b1-second"), true);
      assert.doesNotMatch(loaded.status(), /^\s*x /m, "a repeated session_start reuses the set instead of re-registering");
      assert.deepEqual(loaded.messages, []);
    } finally {
      loaded.emit("session_shutdown", { reason: "quit" });
      loaded.close();
    }
  });
}

test("lifecycle: the child-side hook is attached once even when the host cannot unsubscribe", async () => {
  const root = tempProject({ autoEnable: true });
  // No session flag and autoEnable is on: the child starts loaded, like a
  // dispatched `trellis-implement` does.
  {
    const loaded = await loadExtension(root, { onReturns: "void" }, { sessionId: "child-session", child: true });
    try {
      const run = () => ({
        messageType: "user",
        prompt: "Active task: .trellis/tasks/10-20-demo",
        systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
      });

      const first = run();
      loaded.emit("before_agent_start", first);
      assert.ok(first.systemPromptOptions.sections.pi_coworkflow_child, "the void host still injects");
      assert.equal(loaded.handlerCount("before_agent_start"), 2, "refresh runs before the single injector");

      // The session ends; the listener cannot be removed, so it must stay inert
      // and must not be attached a second time for the next session.
      loaded.emit("session_shutdown", { reason: "new" });
      const closed = run();
      loaded.emit("before_agent_start", closed);
      assert.equal(closed.systemPromptOptions.sections.pi_coworkflow_child, undefined, "an off session injects nothing");
      assert.equal(loaded.handlerCount("before_agent_start"), 2, "the unremovable listener was not duplicated");

      // The replacement session re-activates the module: the same listener has to
      // answer for the *new* runtime and still add exactly one block.
      loaded.emit("session_start", { reason: "new" });
      const reopened = run();
      loaded.emit("before_agent_start", reopened);
      assert.ok(reopened.systemPromptOptions.sections.pi_coworkflow_child, "the new session injects again");
      assert.equal(loaded.handlerCount("before_agent_start"), 2, "re-activation reuses the listener");
    } finally {
      loaded.emit("session_shutdown", { reason: "quit" });
      loaded.close();
    }
  }
});

test("lifecycle: a disposable host drops its listeners at session end", async () => {
  const root = tempProject({ autoEnable: true });
  const loaded = await loadExtension(root, { onReturns: "unsubscribe" }, { sessionId: "session-b1-dispose" });
  try {
    await loaded.settled();
    const before = loaded.handlerCount("session_start");
    assert.ok(before > 0);
    loaded.emit("session_shutdown", { reason: "quit" });
    // The orchestrator's handlers are attached by the factory and are permanent;
    // everything a module attached for the session is gone.
    assert.equal(loaded.handlerCount("agent_end"), 0, "the subagents observers were released");
    assert.equal(loaded.handlerCount("before_agent_start"), 1, "only the inert boundary refresh remains");
  } finally {
    loaded.close();
  }
});

test("lifecycle: a registration failure is stored for /status, never sent as a message", { skip }, async () => {
  const root = tempProject({ autoEnable: true });
  const sessionId = "session-b1-conflict";
  const { registerImplementReviewWorkflow } = (await import(here("../core/subagents-workflow.ts"))) as typeof import(
    "../core/subagents-workflow.ts"
  );
  // Hold the name first, so the module's own registration is refused by the owner
  // — the exact shape of "another copy of this extension already registered it".
  const held = await registerImplementReviewWorkflow(sessionId);
  assert.equal(held.ok, true, held.ok ? "" : held.message);
  if (!held.ok) return;

  const loaded = await loadExtension(root, { onReturns: "unsubscribe" }, { sessionId });
  try {
    loaded.emit("session_start", { reason: "startup" });
    await loaded.settled();
    assert.deepEqual(loaded.messages, [], "a failed registration does not inject a passive message");
    assert.match(loaded.status(), /x .*工作流资源/, "the failure is stored and shown by /status");
  } finally {
    held.registration.dispose();
    loaded.emit("session_shutdown", { reason: "quit" });
    loaded.close();
  }
});

test("lifecycle: switching subagent-context off drops the mandatory child requirement", { skip }, async () => {
  const root = tempProject({ autoEnable: true });
  const sessionId = "session-b1-childreq";
  const loaded = await loadExtension(root, { onReturns: "unsubscribe" }, { sessionId });
  try {
    loaded.emit("session_start", { reason: "startup" });
    await loaded.settled();
    assert.equal(await childRequirementCount(sessionId), 1);

    // The settings panel writes the switch and re-reads the live gates.
    const { controlSurface } = (await import(here("../extensions/coworkflow.ts"))) as {
      controlSurface(): { setSwitch(id: string, on: boolean): string };
    };
    controlSurface().setSwitch("subagent-context", false);
    await loaded.settled();
    assert.equal(
      await childRequirementCount(sessionId),
      0,
      "a project that switched the child guide off does not require its extension in children",
    );
    assert.equal(await workflowRegistered(sessionId), true, "the workflow itself is unaffected");

    controlSurface().setSwitch("subagent-context", true);
    await loaded.settled();
    assert.equal(await childRequirementCount(sessionId), 1, "and turning it back on restores the requirement");
  } finally {
    loaded.emit("session_shutdown", { reason: "quit" });
    loaded.close();
  }
});

test("lifecycle: a project that switched the subagents module off registers nothing", { skip }, async () => {
  const root = tempProject({ autoEnable: true, modules: { subagents: false } });
  const sessionId = "session-b1-off";
  const loaded = await loadExtension(root, { onReturns: "unsubscribe" }, { sessionId });
  try {
    loaded.emit("session_start", { reason: "startup" });
    await loaded.settled();
    assert.equal(await workflowRegistered(sessionId), false);
    assert.equal(await childRequirementCount(sessionId), 0);
  } finally {
    loaded.emit("session_shutdown", { reason: "quit" });
    loaded.close();
  }
});

// ── The per-module contract, without the orchestrator ─────────────────

test("subagent-context: activate reuses its listener and reads the live runtime", async () => {
  const { subagentContextModule } = (await import(here("../modules/subagent-context/index.ts"))) as typeof import(
    "../modules/subagent-context/index.ts"
  );
  const handlers: ((event: any, ctx: any) => any)[] = [];
  const host = {
    // A host that returns nothing: the documented unsubscribe is unavailable.
    on(_event: string, handler: (event: any, ctx: any) => any) {
      handlers.push(handler);
      return undefined;
    },
    getSessionName: () => undefined,
  };
  const runtime = (enabled: boolean) => ({
    isChild: true,
    enabled,
    cwd: process.cwd(),
    sessionId: "child",
    parentSessionId: null,
    sessionEpoch: 1,
    refresh: () => {},
    control: { moduleEnabled: () => true },
  });

  subagentContextModule.activate?.(host as never, runtime(false) as never);
  // A second activation in the same session (a repeated `/Coworkflow:start`)
  // must not attach a second handler.
  subagentContextModule.activate?.(host as never, runtime(false) as never);
  assert.equal(handlers.length, 1);

  const event = () => ({
    messageType: "user",
    prompt: "Active task: .trellis/tasks/10-20-demo",
    systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
  });
  const off = event();
  for (const handler of handlers) handler(off, { cwd: process.cwd() });
  assert.equal(off.systemPromptOptions.sections.pi_coworkflow_child, undefined, "a disabled runtime injects nothing");

  // Session end cannot unsubscribe, so the record stays; the next activation
  // points that same listener at the new runtime.
  subagentContextModule.onSessionEnd?.(host as never, runtime(false) as never);
  assert.equal(handlers.length, 1, "nothing was dropped for a host that cannot unsubscribe");
  subagentContextModule.activate?.(host as never, runtime(true) as never);
  assert.equal(handlers.length, 1, "still one listener");

  const on = event();
  for (const handler of handlers) handler(on, { cwd: process.cwd() });
  assert.ok(on.systemPromptOptions.sections.pi_coworkflow_child, "and it now injects for the live session");
});

test("fixture: the temp project's config is what the modules read", () => {
  const root = tempProject({ autoEnable: true });
  const config = JSON.parse(readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8")) as {
    autoEnable?: boolean;
    modules?: Record<string, boolean>;
  };
  assert.equal(config.autoEnable, true);
  assert.equal(config.modules?.subagents, true);
});
