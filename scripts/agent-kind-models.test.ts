/**
 * Per-kind models, Stage 1: the stored field, its validation, and what reaches the
 * installed owner's registration.
 *
 * What can break silently here, and is therefore what this file drives:
 *
 *   - **a stored typo must not take the kind down.** Upstream refuses a launch on an
 *     unusable model, so a malformed value has to be *dropped* on read instead of
 *     forwarded — the difference between "that model id is wrong" and "dispatch
 *     refused".
 *   - **the model must be part of the definition signature.** Reconcile compares
 *     signatures, so a model that is not in it reads as "unchanged" and the live
 *     registration keeps the old model — a panel writing a setting the session does
 *     not use, which is exactly the failure this module exists to remove. The
 *     assertions therefore read the *owner's* registry and its real registration
 *     path, not a helper's return value.
 *   - **clearing returns to inherit.** `null` has to delete the key: absent is how a
 *     kind says it has no model of its own.
 *   - **the report distinguishes pinned from inherited.** "继承默认" and a named model
 *     are different facts, and a report that blurs them cannot be compared with the
 *     panel.
 *
 * The owner is the installed pi-subagents, not a stub: the fake `pi` carries its own
 * registration listener, so what gets registered is what the real package registers.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConfigRootResolver, isKindModel, isThinkingLevel, readConfig } from "../core/config.ts";
import { exportEntry } from "../core/subagents-workflow.ts";
import { agentKindsModule, childModelFor, kindRegistrationPlan, modelForKind, syncAgentKinds } from "../modules/agent-kinds/index.ts";
import { resolveKinds } from "../modules/agent-kinds/defaults.ts";
import {
  createKindRegistry,
  disposeKindRegistrations,
  loadRuntimeAgentContract,
} from "../modules/agent-kinds/registration.ts";
import { THINKING_LEVELS } from "../modules/panel/shared.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

// ── the installed owner, resolved exactly as production resolves it ───

const ownerPath = exportEntry("./agents", mkdtempSync(join(tmpdir(), "coworkflow-models-probe-")));
/** The installed owner's package root, from whichever build file `./agents` resolves to. */
function ownerRoot(entryPath: string): string | null {
  // 0.81.0 resolves `./agents` to `bundle/agents.js`, older builds to `src/api/agents.js`. Both ship
  // `src/`, which is where the registry and the event listener live; deriving the root from the
  // resolved file instead of assuming one layout is what keeps these tests driving the real owner
  // after an upstream bump (a hardcoded `/src/api/agents.js` made the registry lookup silently miss,
  // and optional chaining turned that miss into "undefined" rather than "skipped").
  const match = /^(.*?)\/(?:bundle|src\/api)\/agents\.js$/.exec(entryPath);
  return match?.[1] ?? null;
}

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
  ? ownerRoot(ownerPath as string) === null ? null : join(ownerRoot(ownerPath as string)!, "src", "agents", "runtime-agent-registry.js")
  : null;
const registryView = registryPath === null || !existsSync(registryPath)
  ? null
  : ((await import(`file://${registryPath}`)) as {
      listRuntimeAgentConfigs(pi: unknown): { name: string; model?: string; thinking?: string }[];
      clearRuntimeAgentsForPi(pi: unknown): void;
    });

interface FakePi {
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
  on(): void;
  registerTool(): void;
}

/** A fake `pi` whose bus carries the installed owner's own registration listener. */
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

/** What the owner's registry says this agent runs on, or `undefined` when absent. */
function registeredModel(pi: FakePi, agent: string): string | undefined {
  return registryView?.listRuntimeAgentConfigs(pi).find((entry) => entry.name === agent)?.model;
}

function registeredThinking(pi: FakePi, agent: string): string | undefined {
  return registryView?.listRuntimeAgentConfigs(pi).find((entry) => entry.name === agent)?.thinking;
}

const KIND_KEYS = ["agent-kinds", "lane-worktree", "panel", "subagents", "subagent-context"];

function writeKinds(
  root: string,
  kinds: Record<string, { enabled?: boolean; maxConcurrent?: number; model?: unknown; thinking?: unknown }> | undefined,
): void {
  mkdirSync(join(root, ".pi"), { recursive: true });
  const config = {
    version: 1,
    autoEnable: true,
    modules: Object.fromEntries(KIND_KEYS.map((key) => [key, true])),
    ...(kinds ? { agentKinds: kinds } : {}),
  };
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify(config, null, 2));
}

function tempProject(
  kinds?: Record<string, { enabled?: boolean; maxConcurrent?: number; model?: unknown; thinking?: unknown }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-models-"));
  writeKinds(root, kinds);
  return root;
}

/** Outside any repository, so the config root is the temp directory itself. */
function runtimeFor(root: string): { runtime: Parameters<typeof syncAgentKinds>[1] } {
  return {
    runtime: {
      isChild: false,
      enabled: true,
      cwd: root,
      sessionId: "session-models",
      parentSessionId: null,
      sessionEpoch: 1,
      loadState: "auto",
      configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
      refresh() {},
      control: {
        moduleEnabled: (id: string) => id === "agent-kinds",
        subagentConcurrency: () => null,
      },
    } as unknown as Parameters<typeof syncAgentKinds>[1],
  };
}

// ── 1. what the config decoder accepts ────────────────────────────────

/**
 * A stored value upstream would refuse is dropped on read, not forwarded.
 *
 * The failure this prevents is a kind that stops registering because somebody typed
 * a model wrong: the panel would show a kind that is on, nothing would launch, and
 * the reason would arrive as "dispatch refused" rather than "that id is wrong".
 */
test("config: a malformed stored model or thinking level is dropped, a usable one is kept", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-models-config-"));
  try {
    writeKinds(root, {
      executor: { enabled: true, model: "anthropic/claude-sonnet-4", thinking: "high" },
      // Whitespace, control characters, an over-long id and an empty string: all
      // unusable, all dropped rather than handed to upstream.
      auditor: { model: " anthropic/claude-4", thinking: "turbo" },
      researcher: { model: "bad\u0000id", thinking: "HIGH" },
      reviewer: { model: "x".repeat(201), thinking: "max" },
    });
    const config = readConfig(root);
    assert.ok(config);
    // A usable pair survives unchanged.
    assert.equal(config.agentKinds?.executor?.model, "anthropic/claude-sonnet-4");
    assert.equal(config.agentKinds?.executor?.thinking, "high");
    // Every unusable field is *absent*, not replaced with something invented — and
    // the rest of the entry (an enabled switch, a limit) is untouched by that.
    assert.deepEqual(config.agentKinds?.auditor, {});
    assert.deepEqual(config.agentKinds?.researcher, {});
    // A valid level next to a dropped model still survives: the two fields are
    // independent, so one bad value must not take the other with it.
    assert.deepEqual(config.agentKinds?.reviewer, { thinking: "max" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config: the validator is the one the panel and the writer share", () => {
  assert.equal(isKindModel("anthropic/claude-sonnet-4"), true, "provider/id");
  assert.equal(isKindModel("claude-sonnet-4"), true, "a bare id resolves against the current provider upstream");
  assert.equal(isKindModel("anthropic/claude-sonnet-4:high"), true, "a trailing :level pins the thinking level");
  assert.equal(isKindModel(""), false);
  assert.equal(isKindModel("   "), false, "whitespace is not a model id");
  assert.equal(isKindModel("a\nb"), false, "a control character is not part of an id");
  assert.equal(isKindModel("x".repeat(201)), false, "bounded, so a paste accident is not stored");
  assert.equal(isKindModel(42), false);

  // The level set is the one module that already owns it — never a second copy.
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true, level);
  assert.equal(isThinkingLevel("turbo"), false);
  assert.equal(isThinkingLevel("HIGH"), false, "levels are exact, not case-folded");
});

// ── 2. what reaches the registration ──────────────────────────────────

/**
 * The model and the thinking level travel inside the definition, which is the only
 * thing the owner registers.
 */
test("plan: a kind's model and thinking level reach the registration, and absence stays absent", () => {
  const moduleUrl = new URL("../modules/agent-kinds/index.ts", import.meta.url).href;
  const plan = kindRegistrationPlan(
    [
      { kind: "executor", label: "执行者", agent: "cw-executor", enabled: true, maxConcurrent: 5,
        model: "anthropic/claude-sonnet-4", thinking: "high" },
      // No model, no thinking: this is what "inherit" looks like on the wire, and it
      // must not be filled in — an invented model would override the project's own
      // `subagents.defaultModel` for this kind alone.
      { kind: "auditor", label: "审计者", agent: "cw-auditor", enabled: true, maxConcurrent: 5 },
    ],
    moduleUrl,
  );
  assert.deepEqual(plan.missingAssets, []);
  const [executor, auditor] = plan.desired;
  assert.equal(executor?.definition.model, "anthropic/claude-sonnet-4");
  assert.equal(executor?.definition.thinking, "high");
  assert.equal(auditor?.definition.model, undefined);
  assert.equal(auditor?.definition.thinking, undefined);
  assert.ok(!("model" in (auditor?.definition ?? {})), "the key is absent, not undefined-valued");
});

/**
 * A model change must re-register, and clearing must go back to inherit.
 *
 * Driven through `createKindRegistry` against the installed owner: the signature that
 * decides "unchanged" is production code, and the model is in it or it is not. A
 * reconcile that read a changed model as unchanged would leave the owner holding the
 * old one — the panel would report a setting the session does not use.
 */
test("registration: a changed model re-registers, the same model does not, and clearing goes back to inherit", { skip }, async () => {
  const { pi, listener } = fakePi();
  try {
    const contract = await loadRuntimeAgentContract({ events: pi.events });
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    const registry = createKindRegistry();
    const plan = (model?: string, thinking?: string) => {
      const desired = kindRegistrationPlan(
        [{ kind: "executor", label: "执行者", agent: "cw-executor", enabled: true, maxConcurrent: 5,
          ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }) }],
        new URL("../modules/agent-kinds/index.ts", import.meta.url).href,
      ).desired;
      return desired;
    };

    // Pinning a model reaches the owner's own record.
    assert.equal(registry.reconcile(contract.contract, plan("anthropic/claude-opus-4"))[0]?.ok, true);
    assert.equal(registeredModel(pi, "cw-executor"), "anthropic/claude-opus-4");
    const held = registryView?.listRuntimeAgentConfigs(pi).length;
    assert.equal(held, 1);

    // A different model is a different definition: it re-registers (one entry, no
    // collision), and the owner now holds the new value.
    assert.equal(registry.reconcile(contract.contract, plan("anthropic/claude-haiku-4"))[0]?.ok, true);
    assert.equal(registeredModel(pi, "cw-executor"), "anthropic/claude-haiku-4");
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 1, "re-registered, not duplicated");
    assert.deepEqual(registry.failures(), []);

    // A thinking level is part of the same comparison: changing only that must apply.
    assert.equal(registry.reconcile(contract.contract, plan("anthropic/claude-haiku-4", "high"))[0]?.ok, true);
    assert.equal(registeredThinking(pi, "cw-executor"), "high");

    // Same definition again: left alone (the owner sees no second registration).
    assert.equal(registry.reconcile(contract.contract, plan("anthropic/claude-haiku-4", "high"))[0]?.ok, true);
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 1);

    // Cleared: the definition carries no model, and the live registration does not
    // keep the old one — that is what "back to inherit" has to mean.
    assert.equal(registry.reconcile(contract.contract, plan())[0]?.ok, true);
    assert.equal(registeredModel(pi, "cw-executor"), undefined);
    assert.equal(registeredThinking(pi, "cw-executor"), undefined);
  } finally {
    listener();
    registryView?.clearRuntimeAgentsForPi(pi);
  }
});

// ── 3. the report distinguishes pinned from inherited ─────────────────

test("status: each registered kind says whether it pins a model or inherits", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject({
    executor: { model: "anthropic/claude-opus-4", thinking: "high" },
    auditor: { enabled: true },
    researcher: { enabled: false, model: "anthropic/claude-haiku-4" },
  });
  const host = { events: pi.events } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    await syncAgentKinds(host, runtimeFor(root).runtime);
    const text = (agentKindsModule.runtimeStatus?.(host) ?? []).join("\n");

    assert.match(text, /cw-executor（kind executor）已注册 · 模型 anthropic\/claude-opus-4 · 思考 high/, text);
    // Inherited is said, not left blank: "no model here" is what makes a project-wide
    // `subagents.defaultModel` change apply to this kind.
    assert.match(text, /cw-auditor（kind auditor）已注册 · 继承默认 · 思考 继承/, text);
    // A disabled kind keeps its stored model in the report: switching it on must
    // apply what the project already chose.
    assert.match(text, /researcher 已关闭.*模型 anthropic\/claude-haiku-4/, text);
  } finally {
    disposeKindRegistrations(host);
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. the control surface the panel writes through ───────────────────

interface Loaded {
  control: ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  settled(): Promise<void>;
  close(): void;
}

/** The real extension in a temp project, so the control is the production one. */
async function loadExtension(root: string, events: FakePi["events"]): Promise<Loaded> {
  const saved = process.cwd();
  process.chdir(root);
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SESSION_ID;
  const host = {
    events,
    on: () => () => {},
    registerCommand: () => {},
    sendMessage: () => {},
    getSessionName: () => undefined,
  };
  // A fresh module instance per test: the extension's runtime is module state.
  const loaded = (await import(
    `${here("../extensions/coworkflow.ts")}?models-${Date.now()}-${Math.random()}`
  )) as {
    default: (h: unknown) => void;
    controlSurface: () => ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  };
  loaded.default(host);
  return {
    control: loaded.controlSurface(),
    async settled() {
      for (let tick = 0; tick < 400; tick += 1) {
        const status = loaded.controlSurface().agentKindStatus().join("\n");
        if (status.length > 0 && !status.includes("未加载或已关闭") && !status.includes("注册尚未完成")) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close() {
      process.chdir(saved);
    },
  };
}

/** The stored block for one kind, read back from the config file. */
function storedKind(root: string, kind: string): { [key: string]: unknown } | undefined {
  const entry = readConfig(root)?.agentKinds?.[kind];
  return entry === undefined ? undefined : { ...entry };
}

test("control: setting a kind's model writes the config and re-registers that agent", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject();
  const loaded = await loadExtension(root, pi.events);
  try {
    await loaded.settled();
    // The state a fresh project is in: registered, on the inherited model.
    assert.equal(registeredModel(pi, "cw-executor"), undefined);

    const status = await loaded.control.setAgentKind("executor", {
      model: "anthropic/claude-opus-4",
      thinking: "high",
    });
    assert.match(String(status), /模型 anthropic\/claude-opus-4/, String(status));
    assert.match(String(status), /思考 high/, String(status));

    // Persisted, and applied to the live registration — not merely written.
    assert.equal(storedKind(root, "executor")?.model, "anthropic/claude-opus-4");
    assert.equal(storedKind(root, "executor")?.thinking, "high");
    assert.equal(registeredModel(pi, "cw-executor"), "anthropic/claude-opus-4");
    assert.equal(registeredThinking(pi, "cw-executor"), "high");
    // The other kinds are untouched: no cross-talk between kinds.
    assert.equal(registeredModel(pi, "cw-auditor"), undefined);
    assert.equal(storedKind(root, "auditor")?.model, undefined);

    // Clearing deletes the key, so the agent goes back to inheriting.
    const cleared = await loaded.control.setAgentKind("executor", { model: null, thinking: null });
    assert.match(String(cleared), /模型 继承/, String(cleared));
    assert.equal("model" in (storedKind(root, "executor") ?? {}), false, "null deletes the key");
    assert.equal("thinking" in (storedKind(root, "executor") ?? {}), false);
    assert.equal(registeredModel(pi, "cw-executor"), undefined);
    assert.equal(registeredThinking(pi, "cw-executor"), undefined);

    // The other settings on that kind survive a model edit.
    await loaded.control.setAgentKind("executor", { maxConcurrent: 3 });
    await loaded.control.setAgentKind("executor", { model: "anthropic/claude-sonnet-4" });
    assert.equal(storedKind(root, "executor")?.maxConcurrent, 3, "a model write keeps the limit");
    assert.equal(storedKind(root, "executor")?.enabled, undefined, "and does not invent switches");
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * An unusable value is refused with a message, and nothing is written.
 *
 * The decoder drops a malformed value on read, so a write that accepted one would
 * look applied until the next read and then silently vanish — the project would
 * believe it made a setting it did not.
 */
test("control: an unusable model is refused with a message, and the config is unchanged", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject();
  const loaded = await loadExtension(root, pi.events);
  try {
    await loaded.settled();
    const before = readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8");

    const bad = await loaded.control.setAgentKind("executor", { model: " anthropic/claude-4" });
    assert.match(String(bad), /模型 id 不可用/, String(bad));
    const unknownLevel = await loaded.control.setAgentKind("executor", { thinking: "turbo" });
    assert.match(String(unknownLevel), /未知思考等级/, String(unknownLevel));
    assert.match(String(unknownLevel), /high/, "the refusal names the levels that are available");

    assert.equal(readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8"), before, "nothing was written");
    assert.equal(registeredModel(pi, "cw-executor"), undefined);
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the project's subagent model travels with the dispatch ─────────────

/**
 * The model the child runs on must be the one `/Comodels` showed, even when the
 * child's working directory cannot see it.
 *
 * `subagents.defaultModel` lives in `.pi/settings.json` and the owner resolves it from
 * the **child's** cwd. A session worktree is a checkout of committed files, so an
 * uncommitted project setting is simply not in it — the child silently ran on a
 * different model while the panel kept reporting the declared one. These assertions
 * pin the repair: the parent resolves it once, from its own config root and its live
 * registry, and writes it into the dispatch.
 */
function modelRuntime(root: string): Parameters<typeof syncAgentKinds>[1] {
  return {
    isChild: false,
    enabled: true,
    cwd: root,
    sessionId: "session-model-travel",
    parentSessionId: null,
    sessionEpoch: 1,
    loadState: "auto",
    configRoots: createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) }),
    refresh() {},
    control: { moduleEnabled: () => true, subagentConcurrency: () => null },
  } as unknown as Parameters<typeof syncAgentKinds>[1];
}

const registryOf = (models: [string, string][], authenticated = true) => ({
  getAvailable: () => models.map(([provider, id]) => ({ provider, id })),
  hasConfiguredAuth: () => authenticated,
});

test("child model: resolved from the parent's settings, and a declared model the registry lacks is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-child-model-"));
  const write = (block: Record<string, unknown> | null): void => {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "settings.json"),
      JSON.stringify(block === null ? {} : { subagents: block }, null, 2),
    );
  };
  try {
    const runtime = modelRuntime(root);
    const registry = registryOf([["p", "m"]]);

    // Nothing declared: the owner's own precedence stays in charge, and this adds nothing.
    write(null);
    assert.equal(childModelFor(runtime, registry), null);

    // The two spellings a project may use both resolve to the same reference.
    write({ defaultModel: "m", defaultProvider: "p" });
    assert.deepEqual(childModelFor(runtime, registry), { model: "p/m" });
    write({ defaultModel: "p/m" });
    assert.deepEqual(childModelFor(runtime, registry), { model: "p/m" });

    // A host that cannot enumerate models cannot call one missing either.
    assert.deepEqual(childModelFor(runtime, {}), { model: "p/m" });

    // A declared model nobody has is a refusal, not a silent fallback to the parent's.
    write({ defaultModel: "p/gone" });
    const missing = childModelFor(runtime, registry);
    assert.ok(missing !== null && "problem" in missing);
    assert.match(missing.problem, /不在当前模型注册表中/);

    // Present but unusable is its own answer: the child would fail on the first call.
    write({ defaultModel: "p/m" });
    const unauthenticated = childModelFor(runtime, registryOf([["p", "m"]], false));
    assert.ok(unauthenticated !== null && "problem" in unauthenticated);
    assert.match(unauthenticated.problem, /没有可用凭据/);

    // A bare id with no provider cannot be resolved at all.
    write({ defaultModel: "bare" });
    const bare = childModelFor(runtime, registry);
    assert.ok(bare !== null && "problem" in bare);
    assert.match(bare.problem, /无法解析/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child model: the dispatch gate writes it into every launch shape and leaves an explicit choice alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-child-model-gate-"));
  try {
    writeKinds(root, undefined);
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultModel: "p/m" } }));
    const runtime = modelRuntime(root);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const host = {
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers.set(name, fn);
        return () => {};
      },
      events: { on: () => () => {}, emit() {} },
      registerCommand() {},
      registerTool() {},
      getActiveTools: () => [],
    };
    agentKindsModule.activate?.(host as never, runtime);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const gate = handlers.get("tool_call");
    if (gate === undefined) throw new Error("the tool_call gate is not registered");
    const ctx = { modelRegistry: registryOf([["p", "m"]]) };
    const call = async (input: Record<string, unknown>) =>
      await gate({ toolName: "subagent", input }, ctx);

    // A plain agent gets it too: `reviewer` reads the same settings file.
    const plain: Record<string, unknown> = { agent: "reviewer", task: "x" };
    assert.equal(await call(plain), undefined);
    assert.equal(plain.model, "p/m");

    // An explicit model is the caller's decision and survives untouched.
    const explicit: Record<string, unknown> = { agent: "reviewer", task: "x", model: "own/m" };
    await call(explicit);
    assert.equal(explicit.model, "own/m");

    // A batch: every entry that did not name a model gets it, per entry.
    const batch: Record<string, unknown> = {
      workflow: "coworkflow.fanout",
      args: { tasks: [{ kind: "executor", task: "a" }, { kind: "auditor", task: "b", model: "keep/me" }] },
    };
    await call(batch);
    const tasks = (batch.args as { tasks: Record<string, unknown>[] }).tasks;
    assert.equal(tasks[0]?.model, "p/m");
    assert.equal(tasks[1]?.model, "keep/me");

    // A declaration that cannot be resolved refuses the dispatch, and says why.
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultModel: "p/gone" } }));
    const refused = (await call({ agent: "reviewer", task: "x" })) as { block?: boolean; reason?: string } | undefined;
    assert.equal(refused?.block, true);
    assert.match(String(refused?.reason), /不在当前模型注册表中/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child model: a kind's own model wins over the project default, and the default still applies where no kind decided", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-kind-model-precedence-"));
  try {
    // Two kinds, two models, plus the project default: the arrangement the panel exists
    // for. The owner resolves a launch as `stepOverrides.model ?? agentConfig.model`, so a
    // default written into the dispatch outranks the kind — the bug this pins.
    writeKinds(root, {
      executor: { model: "kind/pinned" },
      auditor: { model: "kind/audit" },
      researcher: { enabled: true },
    });
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultModel: "proj/default" } }));
    const runtime = modelRuntime(root);
    const registry = registryOf([["kind", "pinned"], ["kind", "audit"], ["proj", "default"]]);

    // The resolver is the one decision point both entries use.
    assert.deepEqual(modelForKind("executor", resolveKinds(readConfig(root), undefined), runtime, registry), {
      model: "kind/pinned",
    });
    assert.deepEqual(modelForKind("cw-auditor", resolveKinds(readConfig(root), undefined), runtime, registry), {
      model: "kind/audit",
    });
    // No kind model of its own: the project default is what applies.
    assert.deepEqual(modelForKind("researcher", resolveKinds(readConfig(root), undefined), runtime, registry), {
      model: "proj/default",
    });
    // An agent this package does not own has no kind page either.
    assert.deepEqual(modelForKind(undefined, resolveKinds(readConfig(root), undefined), runtime, registry), {
      model: "proj/default",
    });
    // Nothing declared anywhere: the owner's own precedence stays in charge.
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({}));
    assert.equal(modelForKind("researcher", resolveKinds(readConfig(root), undefined), runtime, registry), null);
    // A kind's own model is not checked against the registry: it travels inside the
    // registration the owner already accepted, so refusing it here would be a second,
    // disagreeing answer. The default still is checked, because it is resolved here.
    assert.deepEqual(modelForKind("executor", resolveKinds(readConfig(root), undefined), runtime, registry), {
      model: "kind/pinned",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child model: the gate writes each kind's own model into every launch shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-kind-model-gate-"));
  try {
    writeKinds(root, { executor: { model: "kind/pinned" }, auditor: { model: "kind/audit" } });
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultModel: "proj/default" } }));
    const runtime = modelRuntime(root);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const host = {
      on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers.set(name, fn);
        return () => {};
      },
      events: { on: () => () => {}, emit() {} },
      registerCommand() {},
      registerTool() {},
      getActiveTools: () => [],
    };
    agentKindsModule.activate?.(host as never, runtime);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const gate = handlers.get("tool_call");
    if (gate === undefined) throw new Error("the tool_call gate is not registered");
    const ctx = { modelRegistry: registryOf([["kind", "pinned"], ["kind", "audit"], ["proj", "default"]]) };
    const call = async (input: Record<string, unknown>) => await gate({ toolName: "subagent", input }, ctx);

    // The model is written before the registration check, so these assertions read the
    // rewrite itself: whether this temp project has a live pi-subagents is a different
    // question, already covered by the registration tests above.
    const single: Record<string, unknown> = { agent: "cw-executor", task: "x" };
    await call(single);
    assert.equal(single.model, "kind/pinned", "a kind's own model is not overruled by the default");

    // A batch resolves per entry: two kinds, two models, in one call.
    const batch: Record<string, unknown> = {
      workflow: "coworkflow.fanout",
      args: { tasks: [{ kind: "executor", task: "a" }, { kind: "auditor", task: "b" }, { kind: "executor", task: "c", model: "own/keep" }] },
    };
    await call(batch);
    const tasks = (batch.args as { tasks: Record<string, unknown>[] }).tasks;
    assert.equal(tasks[0]?.model, "kind/pinned");
    assert.equal(tasks[1]?.model, "kind/audit");
    assert.equal(tasks[2]?.model, "own/keep", "an explicit model is still the caller's decision");

    // A plain agent has no kind page, so the project default applies to it.
    const plain: Record<string, unknown> = { agent: "reviewer", task: "x" };
    assert.equal(await call(plain), undefined);
    assert.equal(plain.model, "proj/default");

    // The default is still validated: a kindless launch refuses an unusable default.
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultModel: "proj/gone" } }));
    const refused = (await call({ agent: "reviewer", task: "x" })) as { block?: boolean; reason?: string } | undefined;
    assert.equal(refused?.block, true);
    assert.match(String(refused?.reason), /不在当前模型注册表中/);
    // ...while a kind that pinned its own model never consults the broken default at all.
    const pinned: Record<string, unknown> = { agent: "cw-executor", task: "x" };
    await call(pinned);
    assert.equal(pinned.model, "kind/pinned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
