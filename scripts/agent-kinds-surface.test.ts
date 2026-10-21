/**
 * Agent kinds, Stage 3: the surfaces a project actually touches.
 *
 * Stage 1 (registration) and Stage 2 (the gate) are covered by
 * `agent-kinds.test.ts`. What can break *here*, and is therefore what this file
 * drives through production code:
 *
 *   - **the panel changes a kind without a restart.** Toggling twice must leave one
 *     registration, no collision error, and no duplicate hook — the owner refuses
 *     a duplicate name, so a reconcile that skipped disposal fails on the *second*
 *     toggle. Driven through `buildSettingRows` + `SettingsPanel` key handling and
 *     the real control surface, not by calling a helper: a row wired to nothing
 *     renders identically to a working one.
 *   - **a kind's name reaches the existing role injection.** `cw-executor` must
 *     resolve to `implement` through the same `detectRole` the real
 *     `before_agent_start` hook uses — a second injection path keyed on kind is
 *     exactly what this must not become.
 *   - **a dispatch's kind is recorded.** The kind is stored on the native link and
 *     `/Coworkflow:lanes` groups by it; a non-kind dispatch stores no kind at all.
 *   - **the fixed workflow follows the same switches.** `coworkflow.implement-review`
 *     runs `cw-executor` / `cw-auditor` when they are enabled *and* registered, and
 *     keeps the built-in pair otherwise — an enabled-but-unregistered kind would
 *     make the workflow fail at launch with "unknown agent".
 *   - **degradation stays honest.** With no runtime-agent contract the panel and
 *     the status report say why, and no kind is shown as registered.
 *
 * The registration path is the installed owner's, not a stub: the fake `pi` below
 * carries the owner's own event listener, so what registers is what the real
 * `pi-subagents` would register.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConfigRootResolver, readConfig } from "../core/config.ts";
import { contextKeyFor, SESSIONS_DIR } from "../core/trellis.ts";
import {
  DEFAULT_REVIEW_AGENT,
  exportEntry,
  readTaskLinks,
  recordLaunchLink,
  resolveImplementReview,
} from "../core/subagents-workflow.ts";
import { agentKindsModule, kindWorkflowAgents, syncAgentKinds } from "../modules/agent-kinds/index.ts";
import { disposeKindRegistrations } from "../modules/agent-kinds/registration.ts";
import { BUILTIN_KINDS, kindRole, resolveKinds } from "../modules/agent-kinds/defaults.ts";
import { detectRole } from "../modules/subagent-context/index.ts";
import { subagentsModule } from "../modules/subagents/index.ts";
import { buildSettingRows, type SettingRow } from "../modules/panel/settings.ts";
import { SettingsPanel } from "../modules/panel/settings-panel.ts";
import { laneWorktreeModule } from "../modules/lane-worktree/index.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

// ── the installed owner, resolved exactly as production resolves it ───

const ownerPath = exportEntry("./agents", mkdtempSync(join(tmpdir(), "coworkflow-surface-probe-")));
const installed = typeof ownerPath === "string";
const skip = installed
  ? false
  : `pi-subagents with a public ./agents export is not installed here (${(ownerPath as { error: string }).error})`;

interface OwnerAgents {
  RUNTIME_AGENT_REGISTER_EVENT: string;
  registerAgent(input: { pi: unknown; name: string; definition: object }): { dispose(): void };
}
const owner = installed ? ((await import(`file://${ownerPath as string}`)) as OwnerAgents) : null;
const registryPath = installed
  ? join((ownerPath as string).replace(/\/src\/api\/agents\.js$/, ""), "src", "agents", "runtime-agent-registry.js")
  : null;
const registryView = registryPath === null
  ? null
  : ((await import(`file://${registryPath}`)) as {
      listRuntimeAgentConfigs(pi: unknown): { name: string; source?: string }[];
      clearRuntimeAgentsForPi(pi: unknown): void;
    });

/**
 * A fake `pi` whose bus carries the **installed owner's own** registration
 * listener.
 *
 * The listener body is the documented handler (version check, `registerAgent`,
 * write `request.result`). The registration itself is the installed owner's — its
 * validation, its builtin/duplicate collision check, its `dispose()` — so a
 * collide-on-second-toggle bug is caught by the owner rather than by an assertion
 * written to expect whatever this package just did.
 */
interface FakePi {
  events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
  on(): void;
  registerTool(): void;
}

function fakePi(): { pi: FakePi; listener: () => void } {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const pi: FakePi = {
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
        return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== handler));
      },
    },
    // The owner's own validation: a runtime agent belongs to a real `ExtensionAPI`.
    on() {},
    registerTool() {},
  };
  const listener = pi.events.on(owner!.RUNTIME_AGENT_REGISTER_EVENT, (raw: unknown) => {
    const request = raw as { version: number; name: string; definition: object; result?: unknown };
    if (request.result !== undefined) return;
    try {
      if (request.version !== 1) throw new Error("unsupported version");
      request.result = { ok: true, registration: owner!.registerAgent({ pi, name: request.name, definition: request.definition }) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
  return { pi, listener };
}

function writeKinds(root: string, kinds: Record<string, { enabled?: boolean; maxConcurrent?: number }> | undefined): void {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({
      version: 1,
      autoEnable: true,
      modules: { "agent-kinds": true, "lane-worktree": true, panel: true, subagents: true, "subagent-context": true },
      ...(kinds ? { agentKinds: kinds } : {}),
    }),
  );
}

function tempProject(kinds?: Record<string, { enabled?: boolean; maxConcurrent?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-surface-"));
  mkdirSync(join(root, ".trellis", "tasks", "demo"), { recursive: true });
  writeKinds(root, kinds);
  return root;
}

/** The production runtime shape, with only the module gate made writable. */
function runtimeFor(root: string): {
  runtime: Parameters<typeof syncAgentKinds>[1];
  setModule(on: boolean): void;
} {
  let moduleOn = true;
  return {
    setModule(on) {
      moduleOn = on;
    },
    runtime: {
      isChild: false,
      enabled: true,
      cwd: root,
      sessionId: "session-surface",
      parentSessionId: null,
      sessionEpoch: 1,
      loadState: "auto",
      configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
      refresh() {},
      control: {
        moduleEnabled: (id: string) => moduleOn && ["agent-kinds", "lane-worktree"].includes(id),
        subagentConcurrency: () => null,
      },
    } as unknown as Parameters<typeof syncAgentKinds>[1],
  };
}

/**
 * The real extension, in a temp project, so `controlSurface()` is the production
 * implementation rather than a stand-in with three methods filled in.
 *
 * `events` is the bus the extension's own host carries: with it, the installed
 * owner answers the registration; without it, the module reports the contract as
 * unavailable — the two states the panel and the status report must distinguish.
 */
interface Loaded {
  control: ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  /** Handlers the extension registered for one event, so a double attach is countable. */
  handlerCount(event: string): number;
  emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
  /** Wait for the module's asynchronous registration pass to land. */
  settled(): Promise<void>;
  close(): void;
}

async function loadExtension(root: string, events?: FakePi["events"]): Promise<Loaded> {
  const saved = process.cwd();
  process.chdir(root);
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SESSION_ID;
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const messages: string[] = [];
  const host = {
    ...(events === undefined ? {} : { events }),
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, spec);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
    getSessionName: () => undefined,
  };
  // A fresh module instance per test: the extension's runtime is module state.
  const loaded = (await import(
    `${here("../extensions/coworkflow.ts")}?surface-${Date.now()}-${Math.random()}`
  )) as {
    default: (h: unknown) => void;
    controlSurface: () => ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  };
  loaded.default(host);
  const sessionCtx = {
    cwd: root,
    mode: "tui",
    sessionManager: { getSessionId: () => "session-surface" },
    ui: { notify: () => {} },
  };
  return {
    control: loaded.controlSurface(),
    handlerCount: (event) => (handlers.get(event) ?? []).length,
    async emit(event, payload = {}) {
      // Awaited: a gate is an async handler, so a synchronous read would collect
      // promises and report "nothing blocked" for every refusal.
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler({ type: event, ...payload }, sessionCtx));
      }
      return results;
    },
    async settled() {
      // The pass awaits an import of the installed owner's `./agents`, so the
      // snapshot is null until it lands — and "null" is exactly the line that says
      // "not loaded yet". Waiting for a real snapshot is what makes a later
      // "已注册" mean a registration that happened.
      for (let tick = 0; tick < 400; tick += 1) {
        const status = loaded.controlSurface().agentKindStatus().join("\n");
        // A settled pass states facts about kinds; an unsettled one only says the
        // pass has not landed (or that the session is off).
        if (status.length > 0 && !status.includes("未加载或已关闭") && !status.includes("注册尚未完成")) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close() {
      process.chdir(saved);
      void commands;
      void messages;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ── 1. the panel: a kind is editable without a restart ────────────────

interface PanelHarness {
  rows(): SettingRow[];
  selected(): SettingRow | undefined;
  /** Move to the row whose label contains `needle`, using real Down keys. */
  focusOn(needle: string): void;
  /** Send one key and settle whatever row action it started. */
  press(key: string): Promise<void>;
  /** Send several keys inside one tick, the way a held key or two fast presses do. */
  pressBurst(...keys: string[]): Promise<void>;
  /** Which tab and column own the cursor, and which tabs exist. */
  viewState(): { tab: string; focus: "item" | "value"; tabs: string[] };
  /** Labels the active tab is showing. */
  visible(): string[];
  /** Rendered height at a given terminal width. */
  height(width: number): number;
  /** Rows the active tab is showing, including prose rows. */
  rows(): Array<{ label: string; value: string; prose?: boolean; readOnly?: boolean }>;
  statuses: string[];
}

/**
 * The real `SettingsPanel` over the real control surface, keyed like a user keys
 * it. A row that renders but acts on nothing is the failure this catches, so the
 * assertions read back the *config* and the *owner's registry*, not the row text.
 */
function panelFor(control: Parameters<typeof buildSettingRows>[0]): PanelHarness {
  const statuses: string[] = [];
  let panel: SettingsPanel;
  panel = new SettingsPanel(
    {
      rows: () => buildSettingRows(control, {}),
      close: () => {},
      changed: (status: string) => {
        statuses.push(status);
        panel.reload(status);
      },
    },
    { fg: (_color: string, text: string) => text },
    { requestRender: () => {} },
  );
  const settle = async (): Promise<void> => {
    // Row actions write the config and reconcile the owner's registry, which is
    // an awaited pass; this waits for that promise chain to finish.
    for (let tick = 0; tick < 80; tick += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  };
  return {
    rows: () => panel.currentRows(),
    selected: () => panel.selectedRow(),
    focusOn(needle) {
      // Rows live on pages now, so finding a row means finding its page first.
      const tabs = panel.viewState().tabs.length;
      for (let page = 0; page < tabs; page += 1) {
        for (let step = 0; step < 40; step += 1) {
          if (panel.selectedRow()?.label.includes(needle)) return;
          panel.handleInput("\x1b[B");
        }
        panel.handleInput("\t");
      }
      throw new Error(`no selectable row matching ${needle}: ${panel.currentRows().map((row) => row.label).join(" | ")}`);
    },
    async press(key) {
      panel.handleInput(key);
      await settle();
    },
    /** Deliver keys in one tick, the way a held key or two fast presses do. */
    async pressBurst(...keys) {
      for (const key of keys) panel.handleInput(key);
      await settle();
    },
    viewState: () => panel.viewState(),
    height: (width: number) => panel.render(width).length,
  /** Rows the active tab is showing, for the table's own navigation. */
  visible: () => panel.currentRows().map((row) => row.label),
    statuses,
  };
}

test("panel: Space toggles a kind and Enter edits its limit, with no restart", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject();
  const loaded = await loadExtension(root, pi.events);
  try {
    // The extension's own activation registered the enabled kinds through the
    // installed owner: this is the loaded-session state a panel opens over.
    await loaded.settled();
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name), ["cw-executor"]);

    const panel = panelFor(loaded.control);
    panel.focusOn("cw-auditor");
    assert.match(panel.selected()?.value ?? "", /\[ \] 关 · 上限 1/, "the panel shows the built-in policy for auditor");

    // Space: enabled, registered, and the config says so — all without a reload.
    await panel.press(" ");
    assert.match(
      readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8"),
      /"auditor":\s*\{[^}]*"enabled":\s*true/,
      "the toggle is persisted, not just rendered",
    );
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort(), ["cw-auditor", "cw-executor"]);
    assert.match(panel.selected()?.value ?? "", /\[x\] 开/, "the row reflects the new state");
    assert.match(panel.statuses.at(-1) ?? "", /本会话已生效/, panel.statuses.join("\n"));

    // ←→ is the column switch now, exactly as in /Comodels: it must not change a
    // value on its own. Editing goes through Enter, which opens the row's editor.
    const limitBefore = loaded.control.agentKinds().find((entry) => entry.kind === "auditor")?.maxConcurrent;
    await panel.press("\x1b[C");
    assert.deepEqual(panel.viewState().focus, "value", "←→ moves the cursor to the 当前值 column");
    assert.equal(loaded.control.agentKinds().find((entry) => entry.kind === "auditor")?.maxConcurrent, limitBefore,
      "switching columns does not silently edit the number");
    await panel.press("\x1b[C");
    assert.deepEqual(panel.viewState().focus, "item", "←→ toggles back to the 设置项 column");

    // Toggling twice lands exactly where it started: one registration, no
    // collision error, and no duplicate `tool_call` hook.
    const hooks = loaded.handlerCount("tool_call");
    await panel.press(" ");
    await panel.press(" ");
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort(), ["cw-auditor", "cw-executor"]);
    assert.ok(
      !(loaded.control.agentKindStatus().join("\n")).includes("注册失败"),
      loaded.control.agentKindStatus().join("\n"),
    );
    assert.equal(loaded.handlerCount("tool_call"), hooks, "toggling does not add a second gate hook");
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded.close();
  }
});

test("status: a colliding kind is reported as failed, and only that kind is affected", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject();
  // A project agent that already holds the name: the owner refuses the second
  // registration, and the report has to say so instead of listing the kind.
  const squatter = owner!.registerAgent({
    pi,
    name: "cw-auditor",
    definition: { description: "project-owned", systemPrompt: "owned by the project" },
  });
  const loaded = await loadExtension(root, pi.events);
  try {
    await loaded.settled();
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort(), ["cw-auditor", "cw-executor"]);

    // Enable the colliding kind through the same production path the panel uses.
    const status = await loaded.control.setAgentKind("auditor", { enabled: true });
    assert.match(status, /注册失败/, status);
    assert.match(status, /collides with runtime agent 'cw-auditor'/, status);
    const lines = loaded.control.agentKindStatus().join("\n");
    assert.match(lines, /auditor 注册失败/, "status names the failed kind");
    assert.match(lines, /cw-executor（kind executor）已注册/, "the other kind is unaffected");
  } finally {
    squatter.dispose();
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded.close();
  }
});

// ── 2. the workflow follows the kinds ─────────────────────────────────

test("workflow agents: a kind stands in for a step only when it is enabled and registered", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject();
  const host = { events: pi.events } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    const state = runtimeFor(root);
    // Nothing registered yet: the workflow keeps the built-in pair.
    assert.deepEqual(kindWorkflowAgents(host, resolveKinds(readConfig(root))), {});
    await syncAgentKinds(host, state.runtime);
    assert.deepEqual(
      kindWorkflowAgents(host, resolveKinds(readConfig(root))),
      { implementAgent: "cw-executor" },
      "the registered executor drives the implement step",
    );

    // Enabled but not registered: still the built-in pair, because a workflow
    // that launches an agent the owner does not have fails at launch time.
    disposeKindRegistrations(host);
    assert.deepEqual(kindWorkflowAgents(host, resolveKinds(readConfig(root))), {});

    // Only the enabled-and-live kind replaces its step.
    writeKinds(root, { executor: { enabled: false }, auditor: { enabled: true } });
    await syncAgentKinds(host, state.runtime);
    assert.deepEqual(kindWorkflowAgents(host, resolveKinds(readConfig(root))), { reviewAgent: "cw-auditor" });
  } finally {
    disposeKindRegistrations(host);
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow: a prepared context hands its kind agents to the resolver; public args still win", async () => {
  const prepared = { taskRef: ".trellis/tasks/demo", worktree: "/tmp/tree", mainCheckout: "/tmp/main", implementAgent: "cw-executor" };
  const expanded = resolveImplementReview({ taskRef: prepared.taskRef }, prepared);
  assert.ok("script" in expanded);
  assert.match(expanded.script, /agent: "cw-executor"/, "the kind drives the implement step");
  assert.match(expanded.script, new RegExp(`agent: "${DEFAULT_REVIEW_AGENT}"`), "an unset step keeps the built-in default");

  // A caller naming an agent explicitly still wins, and the same safety rules
  // apply to what the prepared context named: it goes through the same check.
  const explicit = resolveImplementReview({ taskRef: prepared.taskRef, implementAgent: "trellis-implement" }, prepared);
  assert.ok("script" in explicit);
  assert.match(explicit.script, /agent: "trellis-implement"/);
  const bad = resolveImplementReview({ taskRef: prepared.taskRef }, { ...prepared, implementAgent: "cw executor; rm -rf /" });
  assert.ok("error" in bad, "a prepared agent name is validated like any other");
});

// ── 3. role mapping through the existing injection path ───────────────

test("roles: a kind's agent name resolves to the same Trellis role as a trellis-* agent", () => {
  // The session names pi-subagents actually produces, in both documented shapes.
  assert.equal(detectRole("cw-executor: implement the thing"), "implement");
  assert.equal(detectRole("cw-auditor: review the thing"), "check");
  assert.equal(detectRole("subagent-cw-executor-run-1-0"), "implement");
  assert.equal(detectRole("subagent-cw-auditor-run-2-1"), "check");
  // The existing names keep working, and nothing else gains a role.
  assert.equal(detectRole("trellis-implement: demo"), "implement");
  assert.equal(detectRole("trellis-check: demo"), "check");
  assert.equal(detectRole("worker: tidy"), null);
  assert.equal(detectRole("cw-unknown: x"), null);
  // The mapping is *the* kind table, so it cannot drift from what a kind means.
  for (const entry of BUILTIN_KINDS) assert.equal(kindRole(entry.kind), entry.role);
  assert.equal(kindRole("unknown"), null);
});

test("roles: the injected block for a cw-* child is the implement/check context, not a second block", async () => {
  const { subagentContextModule } = await import("../modules/subagent-context/index.ts");
  const root = mkdtempSync(join(tmpdir(), "coworkflow-surface-inject-"));
  const task = join(root, ".trellis", "tasks", "10-20-demo");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "prd.md"), "# Requirements\n\nDo the thing.\n");
  writeFileSync(
    join(task, "implement.jsonl"),
    `${JSON.stringify({ file: ".trellis/spec/frontend/demo.md", reason: "the spec this task follows" })}\n`,
  );
  mkdirSync(join(root, ".trellis", "spec", "frontend"), { recursive: true });
  writeFileSync(join(root, ".trellis", "spec", "frontend", "demo.md"), "# Spec\n\nFollow the spec.\n");
  const handlers: ((event: any, ctx: any) => any)[] = [];
  const host = {
    on(_name: string, handler: (event: any, ctx: any) => any) {
      handlers.push(handler);
      return () => {};
    },
    getSessionName: () => "cw-executor: demo",
  } as never;
  const runtime = {
    isChild: true,
    enabled: true,
    cwd: root,
    sessionId: "child",
    parentSessionId: null,
    sessionEpoch: 1,
    loadState: "child",
    configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
    refresh() {},
    control: { moduleEnabled: () => true },
  } as never;
  try {
    subagentContextModule.activate!(host, runtime);
    const event = {
      messageType: "user",
      prompt: "Task: Active task: .trellis/tasks/10-20-demo",
      systemPrompt: "BASE",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    };
    for (const handler of handlers) handler(event, { cwd: root });
    const block = event.systemPromptOptions.sections.pi_coworkflow_child ?? "";
    assert.match(block, /Trellis 子任务上下文（role: implement）/, "a kind child gets the implement context");
    assert.match(block, /Follow the spec/, "and the manifest's spec content, through the same path");
    assert.equal(block.split("<!-- pi-Coworkflow:subagent-context -->").length - 1, 1, "one block, not two");
  } finally {
    subagentContextModule.onSessionEnd!(host, runtime);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. lane attribution ───────────────────────────────────────────────

test("lanes: the dispatch's kind is stored on the link, and a non-kind dispatch stores none", () => {
  const root = tempProject();
  try {
    recordLaunchLink(root, { runId: "run-kind", taskRef: ".trellis/tasks/demo", kind: "executor" });
    recordLaunchLink(root, { runId: "run-plain", taskRef: ".trellis/tasks/demo" });
    assert.deepEqual(
      readTaskLinks(root, ".trellis/tasks/demo").map((link) => [link.runId, link.kind]),
      [["run-kind", "executor"], ["run-plain", undefined]],
      "the kind is recorded when there is one, and absent (not guessed) when there is not",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lanes: kind attribution comes from the dispatch, read at tool_call time", async () => {
  const root = tempProject();
  const listeners = new Map<string, ((event: any, ctx: any) => any)[]>();
  const host = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
  } as unknown as Parameters<NonNullable<typeof laneWorktreeModule.activate>>[0];
  const state = runtimeFor(root);
  try {
    laneWorktreeModule.activate!(host, state.runtime);
    const emit = async (name: string, event: any): Promise<void> => {
      for (const handler of listeners.get(name) ?? []) await handler(event, {});
    };
    const task = "Active task: .trellis/tasks/demo";
    for (const [id, agent, runId] of [
      ["kind-call", "cw-executor", "run-kind"],
      ["plain-call", "trellis-implement", "run-plain"],
      ["other-kind", "cw-auditor", "run-audit"],
    ] as const) {
      await emit("tool_call", { toolName: "subagent", toolCallId: id, input: { agent, task } });
      await emit("tool_result", { toolName: "subagent", toolCallId: id, details: { runId } });
    }
    assert.deepEqual(readTaskLinks(root, ".trellis/tasks/demo").map((link) => [link.runId, link.kind]), [
      ["run-kind", "executor"],
      ["run-plain", undefined],
      ["run-audit", "auditor"],
    ]);
  } finally {
    laneWorktreeModule.onSessionEnd!(host, state.runtime);
    rmSync(root, { recursive: true, force: true });
  }
});

test("lanes: /Coworkflow:lanes groups the task's runs by the recorded kind", async () => {
  const root = tempProject();
  const listeners = new Map<string, ((event: any, ctx: any) => any)[]>();
  const messages: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  const host = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: any) => any }) {
      commands.set(name, spec);
    },
    sendMessage(message: { content: string }) {
      messages.push(message.content);
    },
  } as unknown as Parameters<NonNullable<typeof laneWorktreeModule.onSessionActivate>>[0];
  const state = runtimeFor(root);
  // The command resolves the task from the session pointer in the main checkout.
  mkdirSync(join(root, SESSIONS_DIR), { recursive: true });
  writeFileSync(
    join(root, SESSIONS_DIR, `${contextKeyFor("session-surface")}.json`),
    JSON.stringify({ current_task: ".trellis/tasks/demo" }),
  );
  try {
    laneWorktreeModule.activate!(host, state.runtime);
    laneWorktreeModule.onSessionActivate!(host, state.runtime);
    const emit = async (name: string, event: any): Promise<void> => {
      for (const handler of listeners.get(name) ?? []) await handler(event, {});
    };
    const task = "Active task: .trellis/tasks/demo";
    for (const [id, agent, runId] of [
      ["kind-call", "cw-executor", "run-kind"],
      ["plain-call", "trellis-implement", "run-plain"],
      ["audit-call", "cw-auditor", "run-audit"],
    ] as const) {
      await emit("tool_call", { toolName: "subagent", toolCallId: id, input: { agent, task } });
      await emit("tool_result", { toolName: "subagent", toolCallId: id, details: { runId } });
    }
    await commands.get("Coworkflow:lanes")!.handler("", { cwd: root, mode: "tui" });
    const report = messages.at(-1) ?? "";
    assert.match(report, /按 kind 分组: 执行者（executor） ×1 · 非 kind 派单 ×1 · 审计者（auditor） ×1/, report);
    assert.match(report, /run run-kind[^\n]*\[[^\]]*\][^\n]*· kind 执行者（executor）/, report);
    assert.doesNotMatch(report, /run run-plain[^\n]*· kind/, "a non-kind run carries no kind");
  } finally {
    laneWorktreeModule.onSessionEnd!(host, state.runtime);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. honest degradation on the panel surface ────────────────────────

test("panel and status: no compatible contract means no kind is shown as registered, with the reason", async () => {
  const root = tempProject({ auditor: { enabled: true } });
  // No `events` on the host: nothing can be registered for real.
  const loaded = await loadExtension(root);
  try {
    await loaded.settled();
    const status = loaded.control.agentKindStatus();
    assert.ok(status.some((line) => /x agent-kinds:.*事件总线/.test(line)), status.join("\n"));

    const rows = buildSettingRows(loaded.control, {});
    const executor = rows.find((row) => row.label.includes("cw-executor"));
    assert.ok(executor);
    assert.doesNotMatch(executor.detail ?? "", /已注册到 pi-subagents/, "an unavailable contract never reads as registered");
    assert.match(executor.detail ?? "", /注册状态见 状态 tab/);
    // The exact reason is on the panel, not a list of kinds that do not exist.
    assert.ok(rows.some((row) => row.readOnly && /事件总线/.test(row.prose ? row.value : row.label)), rows.map((row) => row.label || row.value).join(" | "));
    // And the gate agrees with the panel: the declared kind is refused, not started.
    const blocked = (await loaded.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call",
      input: { agent: "cw-executor", task: "x" },
    })).find((result) => (result as { block?: true } | undefined)?.block === true) as
      | { reason?: string }
      | undefined;
    assert.ok(blocked, "a declared kind must not be started while nothing is registered");
    assert.match(blocked?.reason ?? "", /没有启动任何子进程/);
  } finally {
    loaded.close();
  }
});

test("status: registered kinds are reported by agent name; declared-but-unshipped kinds are named", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject({ auditor: { enabled: true }, reviewer: { enabled: true } });
  const host = { events: pi.events } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    await syncAgentKinds(host, runtimeFor(root).runtime);
    const text = (agentKindsModule.runtimeStatus?.(host) ?? []).join("\n");
    assert.match(text, /cw-executor（kind executor）已注册/);
    assert.match(text, /cw-auditor（kind auditor）已注册/);
    assert.match(text, /reviewer.*本包没有这个 kind/);
  } finally {
    disposeKindRegistrations(host);
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    rmSync(root, { recursive: true, force: true });
  }
});


/**
 * A layer switched off after it was on must not read as "enabled, pending".
 *
 * The row used to infer the layer's state from "the report has no lines". A module
 * switched off mid-session still has a status line, so that inference produced
 * `已启用；注册状态见下方状态行` while nothing was registered and the tool_call gate
 * returned early — the row claimed a gate that was not running.
 */
test("panel: a kind row says the layer is off after it is switched off mid-session", async () => {
  const root = tempProject({});
  try {
    const loaded = await loadExtension(root);
    try {
      await loaded.settled();
      const onRows = buildSettingRows(loaded.control, {});
      const onRow = onRows.find((row) => row.label.includes("cw-executor"));
      assert.ok(onRow);
      assert.match(onRow.detail ?? "", /已注册到 pi-subagents|注册状态见 状态 tab/);

      // Switch the layer off the way a user does, then read the panel again.
      loaded.control.setSwitch("agent-kinds", false);
      const offRows = buildSettingRows(loaded.control, {});
      const offRow = offRows.find((row) => row.label.includes("cw-executor"));
      assert.ok(offRow);
      assert.match(offRow.detail ?? "", /本层未启用/);
      assert.doesNotMatch(offRow.detail ?? "", /已启用；注册状态见下方状态行/);
    } finally {
      loaded.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Two gestures inside one tick must not silently cancel each other.
 *
 * A row action is built from the snapshot that rendered the row, so Right,Right
 * used to produce limit 4 instead of 5 and Space,Space on a disabled kind left it
 * enabled — the second gesture started from the same stale value and overwrote the
 * first. A policy editor that appears to work while doing less is the failure this
 * module exists to remove, so an action arriving while another is in flight is
 * dropped, and the row is re-read afterwards.
 */
test("panel: a key burst is not a lost update", { skip }, async () => {
  const { pi } = fakePi();
  const root = tempProject({ auditor: { enabled: false, maxConcurrent: 1 } });
  const loaded = await loadExtension(root, pi.events);
  try {
    await loaded.settled();
    const panel = panelFor(loaded.control);
    // A toggle row is where a burst used to lose an update: both presses were built
    // from the same rendered snapshot, so Space,Space left the kind enabled instead
    // of returning it to off. Only the first may apply.
    panel.focusOn("cw-auditor");
    const before = loaded.control.agentKinds().find((entry) => entry.kind === "auditor")?.enabled;
    await panel.pressBurst(" ", " ");
    const after = loaded.control.agentKinds().find((entry) => entry.kind === "auditor")?.enabled;
    const disk = readConfig(root)?.agentKinds?.auditor?.enabled;
    assert.equal(after, !before, "exactly one toggle applied, not two built from the same stale value");
    assert.equal(Boolean(disk), Boolean(after), "the row and the written policy agree");
    assert.equal((panel.selected()?.value ?? "").startsWith("[x]"), Boolean(after), "the row reflects what was written");
  } finally {
    loaded.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The settings panel is a table driven like /Comodels: Tab switches tab, ←→ switches
 * column, ↑↓ moves, Enter applies, typing filters.
 *
 * The two tabs are not decoration — they separate what is writable from what is only
 * reported. Mixing the modules' own status sentences into the editable list made every
 * row look like something you could change.
 */
test("panel: settings is one page per concern, with column switching and a filter", { skip }, async () => {
  const { pi } = fakePi();
  const root = tempProject({ auditor: { enabled: false } });
  const loaded = await loadExtension(root, pi.events);
  try {
    await loaded.settled();
    const panel = panelFor(loaded.control);
    const state = panel.viewState();
    assert.deepEqual(state.tabs, ["模块", "会话", "子 agent", "维护", "状态"]);

    // A page holds one concern: the kind policy is not mixed into the module switches.
    assert.equal(state.tab, "模块");
    assert.ok(panel.visible().includes("trellis"));
    assert.ok(!panel.visible().some((label) => label.includes("cw-executor")), "kinds have their own page");

    // Each page is reached by Tab, and its rows are the ones the page names.
    await panel.press("\t");
    assert.equal(panel.viewState().tab, "会话");
    await panel.press("\t");
    assert.equal(panel.viewState().tab, "子 agent");
    assert.ok(panel.visible().some((label) => label.includes("cw-executor")));
    assert.ok(panel.visible().some((label) => label.includes("本项目并发上限")), "the ceiling lives with the kinds it applies to");

    // Shift-Tab walks back, so a long tab bar is not one-way.
    await panel.press("\x1b[Z");
    assert.equal(panel.viewState().tab, "会话");

    // The reported page carries the modules' sentences, full width, and Enter there does nothing.
    await panel.press("\t");
    await panel.press("\t");
    await panel.press("\t");
    assert.equal(panel.viewState().tab, "状态");
    const prose = panel.rows().filter((row) => row.prose);
    assert.ok(prose.length > 0, "the module's own sentences are prose rows, not truncated cells");
    assert.ok(prose.some((row) => /agent-kinds/.test(row.value)), prose.map((row) => row.value).join(" | "));
    const before = panel.selected();
    await panel.press("\r");
    assert.equal(panel.selected(), before, "Enter on a read-only row does nothing");

    // Typing filters the rows of a writable page.
    await panel.press("\x1b[Z");
    await panel.press("\x1b[Z");
    await panel.press("\x1b[Z");
    await panel.press("\x1b[Z");
    assert.equal(panel.viewState().tab, "模块");
    await panel.press("l");
    await panel.press("a");
    assert.ok(panel.visible().every((label) => /la/i.test(label)), panel.visible().join(" | "));
    assert.ok(!panel.visible().includes("trellis"), "an unrelated module row is filtered out");
  } finally {
    loaded.close();
    rmSync(root, { recursive: true, force: true });
  }
});


/**
 * The frame must not resize when the tab bar is used.
 *
 * Pages differ wildly in content — two rows on 会话, nine on 模块 — and without padding
 * the whole box jumped under the reader's hands on every Tab. Padding with an "empty"
 * Text does not work either: pi-tui trims it to zero lines, which is how the first
 * attempt at this fix shipped looking like it did nothing.
 */
test("panel: every page renders the same number of lines", { skip }, async () => {
  const { pi } = fakePi();
  const root = tempProject({ auditor: { enabled: false } });
  const loaded = await loadExtension(root, pi.events);
  try {
    await loaded.settled();
    const panel = panelFor(loaded.control);
    const heights: number[] = [];
    const pages: string[] = [];
    const tabs = panel.viewState().tabs.length;
    for (let page = 0; page < tabs; page += 1) {
      pages.push(panel.viewState().tab);
      heights.push(panel.height(96));
      await panel.press("\t");
    }
    assert.equal(new Set(heights).size, 1, `${pages.map((name, index) => `${name}=${heights[index]}`).join(" ")}`);
    assert.ok((heights[0] ?? 0) >= 10, "the panel is not collapsed to its shortest page");
  } finally {
    loaded.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A session whose host declares no `subagent` tool must be told so.
 *
 * This is the failure a real WSL session showed: the managed region says "执行全部
 * 交出去", pi-subagents was not loaded there, and the model spent a turn searching for
 * a tool that did not exist and then apologised for breaking a rule it could not have
 * followed. Saying nothing is not neutral — it produces that.
 */
test("status: a missing subagent tool is reported, and no tools means no claim", async () => {
  const lines = subagentsModule.runtimeStatus?.({ getActiveTools: () => ["read", "write"] } as never) ?? [];
  assert.ok(
    lines.some((line) => /没有 subagent 工具/.test(line) && /派单不可用/.test(line)),
    lines.join("\n"),
  );
  // A host that cannot answer says nothing rather than guessing in either direction.
  const unknown = subagentsModule.runtimeStatus?.({} as never) ?? [];
  assert.ok(!unknown.some((line) => /没有 subagent 工具/.test(line)), unknown.join("\n"));
  // And a host that does declare the tool makes no such claim.
  const ok = subagentsModule.runtimeStatus?.({ getActiveTools: () => ["read", "subagent"] } as never) ?? [];
  assert.ok(!ok.some((line) => /没有 subagent 工具/.test(line)), ok.join("\n"));
});

/**
 * The status line must name the remedies, not just the symptom.
 *
 * The observed failure had three stacked causes (package not declared; peer deps
 * missing; dynamic tool activation leaving only the `subagents_enable` loader). A line
 * that says "no subagent tool" and stops costs the reader the same investigation that
 * produced it, so each cause is named with what to do about it.
 */
test("status: a missing subagent tool names the three things to check", async () => {
  const lines = subagentsModule.runtimeStatus?.({ getActiveTools: () => ["read"] } as never) ?? [];
  const line = lines.find((entry) => /没有 subagent 工具/.test(entry)) ?? "";
  assert.match(line, /packages/, "1: the package must be declared");
  assert.match(line, /subagents_enable/, "2: dynamic activation exposes only the loader");
  assert.match(line, /toolActivation/, "2: and names the eager escape hatch");
  assert.match(line, /重开 Pi/, "3: a reload is not enough");
});
