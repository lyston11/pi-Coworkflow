/**
 * Agent kinds, Stage 1: the config shape, the kind table, and registration
 * against the *installed* pi-subagents owner.
 *
 * What can break silently here, and is therefore what this file drives:
 *
 *   - **the contract is read, not assumed.** The registration goes through the
 *     installed package's public `./agents` export and its documented
 *     `runtime-agent-register:v1` event. A stub registry would pass while the real
 *     owner refused every name — the collision path would never run.
 *   - **idempotent re-registration.** The owner rejects a duplicate name, so a
 *     reconcile that skipped disposal would fail on the *second* call. Toggling
 *     twice must leave one registration, no collision error, and no stale entry.
 *   - **honest degradation.** With no event bus, or with no owner listening, the
 *     contract is unavailable: nothing registers, the reason is returned, and a
 *     declared kind is *not* reported as available.
 *   - **a collision fails one kind only.** The others still register.
 *
 * Everything registers into the installed owner's process-local registry keyed by
 * a fake `pi`, and every test disposes it. Nothing spawns a child or touches a
 * real project: the project roots are temp directories with a config file.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readConfig, createConfigRootResolver, type WorkflowConfig } from "../core/config.ts";
import { checkpointFor, FANOUT_NAME } from "../core/subagents-workflow.ts";
import { exportEntry } from "../core/subagents-workflow.ts";
import {
  BUILTIN_KINDS,
  DEFAULT_MAX_CONCURRENT,
  agentNameFor,
  builtinAgentNames,
  kindOf,
  kindRole,
  kindSystemPrompt,
  resolveKinds,
  unshippedKinds,
} from "../modules/agent-kinds/defaults.ts";
import {
  createKindRegistry,
  disposeKindRegistrations,
  kindRegistryFor,
  loadRuntimeAgentContract,
  type DesiredKind,
} from "../modules/agent-kinds/registration.ts";
import { agentKindsModule, applyDispatchDefaults, decodeFanoutCall, decodeKindDispatch, decodeUngovernedLaunch, kindRegistrationPlan, kindWorkflowAgents, resolveDispatchKind, syncAgentKinds } from "../modules/agent-kinds/index.ts";
import { readKindDefinitions } from "../modules/agent-kinds/definitions.ts";
import { capacityModule } from "../modules/capacity/index.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

/** The installed owner, resolved exactly as the production code resolves it. */
function ownerModule(): string | { error: string } {
  return exportEntry("./agents", mkdtempSync(join(tmpdir(), "coworkflow-kinds-probe-")));
}

/** The installed owner's package root, from whichever build file `./agents` resolves to. */
function ownerRoot(entryPath: string): string | null {
  // 0.81.0 resolves `./agents` to `bundle/agents.js`, older builds to `src/api/agents.js`. Both ship
  // `src/`, which is where the registry and the event listener live; deriving the root from the
  // resolved file instead of assuming one layout is what keeps these tests driving the real owner
  // after an upstream bump (a hardcoded `/src/api/agents.js` made the registry lookup silently miss).
  const match = /^(.*?)\/(?:bundle|src\/api)\/agents\.js$/.exec(entryPath);
  return match?.[1] ?? null;
}


const ownerPath = ownerModule();
const installed = typeof ownerPath === "string";
const skip = installed
  ? false
  : `pi-subagents with a public ./agents export is not installed here (${(ownerPath as { error: string }).error})`;

interface OwnerAgents {
  RUNTIME_AGENT_REGISTER_EVENT: string;
  /** The owner's real registration: its own validation, collision and cleanup. */
  registerAgent(input: { pi: unknown; name: string; definition: object }): { dispose(): void };
  registerAgentViaEvents(input: { pi: unknown; name: string; definition: object }): { dispose(): void };
}

const owner = installed ? ((await import(`file://${ownerPath as string}`)) as OwnerAgents) : null;

/** The owner's own view of what it registered for this fake `pi`. */
interface RegistryView {
  listRuntimeAgentConfigs(pi: unknown): { name: string; source?: string }[];
  clearRuntimeAgentsForPi(pi: unknown): void;
}

const registryPath = installed
  ? ownerRoot(ownerPath as string) === null ? null : join(ownerRoot(ownerPath as string)!, "src", "agents", "runtime-agent-registry.js")
  : null;
const registryView: RegistryView | null =
  registryPath !== null && existsSync(registryPath) ? ((await import(`file://${registryPath}`)) as RegistryView) : null;

/** The owner's real event listener, from the installed package. */
const eventsPath = installed
  ? ownerRoot(ownerPath as string) === null ? null : join(ownerRoot(ownerPath as string)!, "src", "agents", "runtime-agent-events.js")
  : null;
const ownerInstaller: ((pi: unknown) => () => void) | null =
  eventsPath !== null && existsSync(eventsPath)
    ? ((await import(`file://${eventsPath}`)) as { registerRuntimeAgentEventListener(pi: unknown): () => void })
        .registerRuntimeAgentEventListener
    : null;

/**
 * A fake `pi` with a real event bus, and the owner's **own** registration listener
 * on it.
 *
 * `./agents` deliberately does not re-export the listener installer (only the
 * owner's extension installs it), so this prefers the owner's actual installer
 * from the installed package and falls back to the documented handler body —
 * version check, `registerAgent`, write `request.result` — when that internal
 * module is not where it is today. Either way the registration itself is the
 * installed owner's `registerAgent`: its validation, builtin and duplicate
 * collision checks, and its `dispose()`. Nothing here stubs registration.
 *
 * `rpc` answers `subagents:rpc:v1` requests on the same bus, so a test can drive
 * the gate's real public-count path (`ping` + `status`) rather than a stub.
 */
function fakePi(rpc?: (request: any) => { data?: unknown; success?: boolean } | undefined): {
  pi: { events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }; on(): void; registerTool(): void };
  listener: () => void;
  requests: any[];
} {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const requests: any[] = [];
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        const request = data as { requestId?: unknown };
        if (channel === "subagents:rpc:v1:request" && rpc) {
          requests.push(data);
          const answer = rpc(data);
          if (answer !== undefined && typeof request.requestId === "string") {
            queueMicrotask(() => {
              for (const handler of listeners.get(`subagents:rpc:v1:reply:${request.requestId}`) ?? []) handler({
                version: 1,
                requestId: request.requestId,
                success: answer.success !== false,
                ...(answer.success === false ? { error: { code: "unsupported", message: "not supported" } } : { data: answer.data }),
              });
            });
          }
          return;
        }
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
  if (ownerInstaller !== null) return { pi, listener: ownerInstaller(pi), requests };
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
  return { pi, listener, requests };
}

function tempProject(kinds?: Record<string, { enabled?: boolean; maxConcurrent?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-kinds-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({ version: 1, autoEnable: true, modules: { "agent-kinds": true }, ...(kinds ? { agentKinds: kinds } : {}) }),
  );
  return root;
}

/**
 * The production plan for the named kinds — assets included — rather than a
 * hand-built definition, so a missing asset or a wrong description fails here too.
 */
const moduleUrl = new URL("../modules/agent-kinds/index.ts", import.meta.url).href;

function desired(kinds: string[]): DesiredKind[] {
  const policy = kinds.map((kind) => ({
    kind,
    label: kind,
    agent: agentNameFor(kind),
    enabled: true,
    maxConcurrent: 1,
  }));
  const plan = kindRegistrationPlan(policy, moduleUrl);
  assert.deepEqual(plan.missingAssets, [], "every shipped kind must have a system-prompt asset");
  assert.equal(plan.desired.length, kinds.length);
  return plan.desired;
}

// ── the config shape ─────────────────────────────────────────────────

test("kinds config: unknown kinds and unreadable fields are preserved as the project wrote them", () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-kinds-config-"));
  try {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "Coworkflow.json"),
      JSON.stringify({
        version: 1,
        modules: {},
        agentKinds: {
          executor: { enabled: false, maxConcurrent: 5 },
          auditor: { maxConcurrent: 0 },
          reviewer: { enabled: true, maxConcurrent: 2 },
          "  spaced  ": { enabled: true },
          broken: "not-an-object",
        },
      }),
    );
    const config = readConfig(root);
    assert.ok(config);
    // An unknown kind is a decision the project made: dropping it would silently
    // retract it, so it is kept and reported as unshipped instead.
    assert.deepEqual(unshippedKinds(config), ["reviewer"]);
    assert.deepEqual(config.agentKinds?.reviewer, { enabled: true, maxConcurrent: 2 });
    // `0` is not "refuse everything" and not a valid limit; the field is dropped
    // and the built-in default applies, which `resolveKinds` reads.
    assert.deepEqual(config.agentKinds?.auditor, {});
    // A malformed entry and a key with stray whitespace are not policies.
    assert.equal(config.agentKinds?.broken, undefined);
    assert.equal(config.agentKinds?.["  spaced  "], undefined);

    const resolved = resolveKinds(config);
    assert.deepEqual(
      resolved.map((entry) => [entry.kind, entry.agent, entry.enabled, entry.maxConcurrent]),
      [
        ["executor", "cw-executor", false, 5],
        ["auditor", "cw-auditor", true, 5],
        ["researcher", "cw-researcher", true, 5],
      ],
      "the built-in defaults fill what the project did not say",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kinds table: names are cw- prefixed, map to Trellis roles, and prompts are assets not strings", () => {
  // One kind per Trellis role: adopting kinds means the `trellis-*` role agents are
  // no longer needed for any of the three. The role itself is declared in the asset's
  // frontmatter and read back through `kindRole` — never in this table.
  assert.deepEqual(builtinAgentNames(), ["cw-executor", "cw-auditor", "cw-researcher"]);
  assert.deepEqual(
    BUILTIN_KINDS.map((entry) => [entry.kind, "role" in entry]),
    [["executor", false], ["auditor", false], ["researcher", false]],
    "the table declares no role of its own",
  );
  assert.deepEqual(BUILTIN_KINDS.map((entry) => kindRole(entry.kind)), ["implement", "check", "research"]);
  assert.equal(kindOf("cw-executor"), "executor");
  assert.equal(kindOf("trellis-implement"), null, "a non-kind dispatch is not ours");
  assert.equal(kindOf("cw-unknown"), null, "only a shipped kind is ours");
  for (const entry of BUILTIN_KINDS) {
    const prompt = kindSystemPrompt(moduleUrl, entry.kind);
    assert.ok(prompt && prompt.length > 100, `${entry.kind} prompt comes from its asset`);
  }
  // A project that declares nothing gets the built-in defaults.
  assert.deepEqual(
    resolveKinds(null).map((entry) => [entry.kind, entry.enabled, entry.maxConcurrent]),
    [["executor", true, 5], ["auditor", true, 5], ["researcher", true, 5]],
  );
});

// ── the contract, against the installed owner ────────────────────────

test("contract: the public ./agents export and its event are what registration uses", { skip }, async () => {
  const { pi, listener } = fakePi();
  try {
    const loaded = await loadRuntimeAgentContract({ events: pi.events });
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.contract.event, owner!.RUNTIME_AGENT_REGISTER_EVENT);
    assert.equal(loaded.contract.event, "pi-subagents:runtime-agent-register:v1");
  } finally {
    listener();
  }
});

test("contract: no event bus means unavailable, with a reason instead of a silent no-op", async () => {
  const loaded = await loadRuntimeAgentContract({});
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.reason, /事件总线/);
});

test("contract: a bus with no owner listening is a refusal, not a registration", { skip }, async () => {
  const { pi } = fakePi();
  // A second bus that nobody listens on: this is exactly "pi-subagents is not
  // loaded in this process", the case a direct call would silently paper over.
  const orphan = {
    emit() {},
    on() {
      return () => {};
    },
  };
  const loaded = await loadRuntimeAgentContract({ events: orphan });
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.throws(() => loaded.contract.register("cw-executor", desired(["executor"])[0]!.definition), /not installed|not ready|does not support/);
  // The real bus still works, which is what makes the failure above meaningful.
  const real = await loadRuntimeAgentContract({ events: pi.events });
  assert.equal(real.ok, true);
});

test("registration: reconcile is idempotent, disposes before re-registering, and re-registers after dispose", { skip }, async () => {
  const { pi, listener } = fakePi();
  try {
    const contract = await loadRuntimeAgentContract({ events: pi.events });
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    const registry = createKindRegistry();
    const wanted = desired(["executor"]);

    const first = registry.reconcile(contract.contract, wanted);
    assert.deepEqual(first, [{ ok: true, kind: "executor", agent: "cw-executor" }]);
    assert.deepEqual(registry.registered().map((entry) => entry.agent), ["cw-executor"]);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name), ["cw-executor"]);

    // Toggling twice: the second reconcile must not collide. The owner refuses a
    // duplicate name, so this passing is the disposal-before-registration rule.
    const second = registry.reconcile(contract.contract, wanted);
    assert.deepEqual(second, [{ ok: true, kind: "executor", agent: "cw-executor" }]);
    assert.deepEqual(registry.failures(), []);
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 1, "no duplicate, no stale entry");

    // A changed definition re-registers rather than being ignored.
    const changed = [{ ...wanted[0]!, definition: { description: "edited", systemPrompt: "edited prompt" } }];
    assert.equal(registry.reconcile(contract.contract, changed)[0]?.ok, true);
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 1);

    // Off, then on: dispose removes it from the owner, and a later pass restores it.
    registry.dispose();
    assert.deepEqual(registry.registered(), []);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi), []);
    assert.equal(registry.reconcile(contract.contract, wanted)[0]?.ok, true);
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 1);

    // An empty desired set withdraws what is no longer wanted.
    assert.deepEqual(registry.reconcile(contract.contract, []), []);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi), []);
  } finally {
    listener();
    registryView?.clearRuntimeAgentsForPi(pi);
  }
});

test("registration: a name collision fails that kind only, with the owner's own reason", { skip }, async () => {
  const { pi, listener } = fakePi();
  try {
    const contract = await loadRuntimeAgentContract({ events: pi.events });
    assert.equal(contract.ok, true);
    if (!contract.ok) return;
    // A project (or another extension) already holds one of our names.
    const squatter = owner!.registerAgent({ pi, name: "cw-auditor", definition: { description: "theirs", systemPrompt: "theirs" } });
    const registry = createKindRegistry();
    const results = registry.reconcile(contract.contract, desired(["executor", "auditor"]));
    assert.deepEqual(
      results.map((entry) => [entry.kind, entry.ok]),
      [["executor", true], ["auditor", false]],
      "one bad kind never prevents the others",
    );
    const failure = registry.failures().find((entry) => entry.kind === "auditor");
    assert.ok(failure);
    assert.match(failure.reason, /collides with runtime agent 'cw-auditor'/);
    assert.deepEqual(registry.registered().map((entry) => entry.agent), ["cw-executor"]);
    squatter.dispose();
  } finally {
    listener();
    registryView?.clearRuntimeAgentsForPi(pi);
  }
});

// ── the module: gates, session end, and honest status ────────────────

interface Runtime {
  runtime: Parameters<typeof syncAgentKinds>[1];
  root: string;
  setEnabled(on: boolean): void;
  setModule(on: boolean): void;
}

function runtimeFor(root: string): Runtime {
  let enabled = true;
  let moduleOn = true;
  const resolver = createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) });
  return {
    root,
    setEnabled(on) {
      enabled = on;
    },
    setModule(on) {
      moduleOn = on;
    },
    runtime: {
      isChild: false,
      get enabled() {
        return enabled;
      },
      cwd: root,
      sessionId: "session-kinds",
      parentSessionId: null,
      sessionEpoch: 1,
      loadState: "auto",
      configRoots: resolver,
      refresh() {},
      control: {
        moduleEnabled: (id: string) => moduleOn && id === "agent-kinds",
        subagentConcurrency: () => null,
      },
    } as unknown as Parameters<typeof syncAgentKinds>[1],
  };
}

test("module: enabled kinds register with the owner, session end withdraws them, status tells the truth", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject({ auditor: { enabled: true } });
  const host = { events: pi.events } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    const state = runtimeFor(root);
    await syncAgentKinds(host, state.runtime);
    assert.deepEqual(
      registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort(),
      ["cw-auditor", "cw-executor", "cw-researcher"],
      "declared-enabled kinds appear in the owner's agent list",
    );
    const lines = agentKindsModule.runtimeStatus!(host) ?? [];
    assert.ok(lines.some((line) => line.includes("cw-executor") && line.includes("已注册")), lines.join("\n"));

    // The session switch off withdraws them: a withdrawn layer must not keep
    // resolving a kind the model could still dispatch.
    state.setEnabled(false);
    await syncAgentKinds(host, state.runtime);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi), []);

    // And back on restores them, in the same session, with no duplicate.
    state.setEnabled(true);
    await syncAgentKinds(host, state.runtime);
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 3);
    await syncAgentKinds(host, state.runtime);
    assert.equal(registryView?.listRuntimeAgentConfigs(pi).length, 3, "repeated reconcile registers nothing twice");

    // Session end: disposal must not throw and must leave nothing that would act
    // on the next session.
    agentKindsModule.onSessionEnd!(host, state.runtime);
    agentKindsModule.onSessionEnd!(host, state.runtime);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi), []);
    assert.deepEqual(agentKindsModule.runtimeStatus!(host), ["  - agent-kinds: 本会话未加载或已关闭，未注册任何 kind"]);
  } finally {
    disposeKindRegistrations(host);
    registryView?.clearRuntimeAgentsForPi(pi);
    rmSync(root, { recursive: true, force: true });
    listener();
  }
});

test("module: a disabled kind is not registered, and the project switch withdraws the rest", { skip }, async () => {
  const { pi, listener } = fakePi();
  // Every kind is on by default now, so "disabled" has to be the project's own choice —
  // which is exactly the state this test is about.
  const root = tempProject({ auditor: { enabled: false } });
  const host = { events: pi.events } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    const state = runtimeFor(root);
    await syncAgentKinds(host, state.runtime);
    const on = ["cw-executor", "cw-researcher"];
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort(), on);
    const lines = agentKindsModule.runtimeStatus!(host) ?? [];
    assert.ok(lines.some((line) => line.includes("auditor") && line.includes("已关闭")), lines.join("\n"));

    state.setModule(false);
    await syncAgentKinds(host, state.runtime);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi), []);
    state.setModule(true);
    await syncAgentKinds(host, state.runtime);
    assert.deepEqual(registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort(), on);
  } finally {
    disposeKindRegistrations(host);
    registryView?.clearRuntimeAgentsForPi(pi);
    rmSync(root, { recursive: true, force: true });
    listener();
  }
});

test("module: no compatible contract registers nothing and says why, never listing a kind as available", async () => {
  const root = tempProject({ auditor: { enabled: true } });
  // No `events` at all: the host does not expose a bus, so no owner can be reached.
  const host = {} as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    const state = runtimeFor(root);
    await syncAgentKinds(host, state.runtime);
    const lines = agentKindsModule.runtimeStatus!(host) ?? [];
    assert.ok(lines.some((line) => /x agent-kinds:.*事件总线/.test(line)), lines.join("\n"));
    assert.ok(!lines.some((line) => line.includes("已注册")), "nothing may be reported as available");
    assert.ok(lines.some((line) => line.includes("未注册任何 kind")));
    assert.deepEqual(kindRegistryFor(host).registered(), []);

    // A config declaring kinds that has no bus must still not register anything on
    // a later pass, and must keep reporting the reason.
    await syncAgentKinds(host, state.runtime);
    assert.ok(!(agentKindsModule.runtimeStatus!(host) ?? []).some((line) => line.includes("已注册")));
  } finally {
    disposeKindRegistrations(host);
    rmSync(root, { recursive: true, force: true });
  }
});

test("degradation: an installed owner without the public ./agents export registers nothing and says why", async () => {
  const root = tempProject({ auditor: { enabled: true } });
  const pkg = join(root, "node_modules", "pi-subagents");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "pi-subagents", exports: { "./workflow-resources": "./workflow.js" } }),
  );
  const bus = {
    emit() {},
    on() {
      return () => {};
    },
  };
  const host = { events: bus } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    const state = runtimeFor(root);
    await syncAgentKinds(host, state.runtime);
    const lines = agentKindsModule.runtimeStatus!(host) ?? [];
    // The exact reason, not a list of kinds that do not exist: a project-local
    // owner is preferred over the user-level one, so this is the one that answers.
    assert.ok(lines.some((line) => line.startsWith("  x agent-kinds: ") && line.includes("./agents")), lines.join("\n"));
    assert.ok(lines.some((line) => line.includes("未注册任何 kind")));
    assert.ok(!lines.some((line) => line.includes("已注册")));
    assert.deepEqual(kindRegistryFor(host).registered(), []);
  } finally {
    disposeKindRegistrations(host);
    rmSync(root, { recursive: true, force: true });
  }
});

test("module: a declared-but-unshipped kind is preserved and reported, never registered", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = tempProject({ reviewer: { enabled: true, maxConcurrent: 2 } });
  const host = { events: pi.events } as unknown as Parameters<typeof syncAgentKinds>[0];
  try {
    const config: WorkflowConfig | null = readConfig(root);
    assert.deepEqual(unshippedKinds(config), ["reviewer"]);
    await syncAgentKinds(host, runtimeFor(root).runtime);
    // Every shipped kind registers; the unshipped one is reported and never registered.
    const names = registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name).sort() ?? [];
    assert.deepEqual(names, ["cw-auditor", "cw-executor", "cw-researcher"]);
    assert.ok(!names.includes("reviewer"), "a kind this package does not ship is never registered");
    const lines = agentKindsModule.runtimeStatus!(host) ?? [];
    assert.ok(lines.some((line) => line.includes("reviewer") && line.includes("本包没有这个 kind")), lines.join("\n"));
  } finally {
    disposeKindRegistrations(host);
    registryView?.clearRuntimeAgentsForPi(pi);
    rmSync(root, { recursive: true, force: true });
    listener();
  }
});

// ── the gate: `tool_call` admission, per kind ────────────────────────
//
// These drive the production `tool_call` hook, not `decodeKindDispatch` alone: the
// count comes from a real `ping` + `status` round trip over the fake bus, so a gate
// that never asked the owner (and therefore never counted) fails here.

interface GateHarness {
  root: string;
  host: Parameters<typeof syncAgentKinds>[0];
  runtime: Parameters<typeof syncAgentKinds>[1];
  /** Live children the fake owner reports, one entry per running run. */
  live: string[];
  requests: any[];
  /** The first blocking result for one `subagent` call, if any. */
  call(input: Record<string, unknown>): Promise<{ block?: true; reason?: string } | undefined>;
  setEnabled(on: boolean): void;
  setModule(on: boolean): void;
  setConcurrency(limit: number | null): void;
  /** Hooks currently installed for one event name. */
  count(name: string): number;
  close(): void;
}

function gateHarness(options: {
  kinds?: Record<string, { enabled?: boolean; maxConcurrent?: number }>;
  fleetStatus?: boolean;
  malformedFleet?: boolean;
  omitted?: number;
  events?: boolean;
} = {}): GateHarness {
  const root = tempProject(options.kinds);
  const live: string[] = [];
  const built = fakePi((request) => {
    if (request.method === "ping") {
      return {
        data: {
          version: 1,
          methods: ["ping", "status", "spawn"],
          capabilities: {
            status: true,
            asyncSpawn: true,
            ...(options.fleetStatus === false ? {} : { fleetStatus: { version: 1 } }),
          },
          events: {},
          session: { sessionId: "session-gate" },
        },
      };
    }
    if (request.method === "status") {
      return {
        data: {
          fleet: options.malformedFleet
            ? { version: 1, entries: [{ key: 1 }], totalActive: 1, omitted: 0 }
            : {
                version: 1,
                entries: live.map((agent, index) => ({
                  key: `fleet-${index + 1}`,
                  agent,
                  startedAt: index,
                  tokens: { input: 0, output: 0, total: 0 },
                })),
                totalActive: live.length,
                omitted: options.omitted ?? 0,
                topLevelAsyncCapacity: { used: live.length, limit: 10 },
              },
        },
      };
    }
    return undefined;
  });

  const listeners = new Map<string, Set<(event: any, ctx: any) => any>>();
  const host = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    },
    ...(options.events === false ? {} : { events: built.pi.events }),
  } as unknown as Parameters<typeof syncAgentKinds>[0];

  let enabled = true;
  let moduleOn = true;
  let limit: number | null = null;
  const resolver = createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) });
  const runtime = {
    isChild: false,
    get enabled() {
      return enabled;
    },
    cwd: root,
    sessionId: "session-gate",
    parentSessionId: null,
    sessionEpoch: 1,
    loadState: "auto",
    configRoots: resolver,
    refresh() {},
    control: {
      moduleEnabled: (id: string) => moduleOn && (id === "agent-kinds" || id === "capacity"),
      subagentConcurrency: () => limit,
    },
  } as unknown as Parameters<typeof syncAgentKinds>[1];

  // The production activation: this is what registers the `tool_call` hook, so the
  // tests below drive the shipped gate rather than calling its helper directly.
  agentKindsModule.activate!(host, runtime);

  async function emit(name: string, event: any): Promise<any[]> {
    const results: any[] = [];
    for (const handler of listeners.get(name) ?? []) {
      const result = await handler(event, {});
      results.push(result);
      // The host stops at the first refusal, which is how a gate's block is real.
      if (name === "tool_call" && result?.block) break;
    }
    return results;
  }

  return {
    root,
    host,
    runtime,
    live,
    requests: built.requests,
    async call(input) {
      const results = await emit("tool_call", { toolName: "subagent", toolCallId: "call-1", input });
      return results.find((result) => result?.block === true);
    },
    setEnabled(on) {
      enabled = on;
    },
    setModule(on) {
      moduleOn = on;
    },
    setConcurrency(value) {
      limit = value;
    },
    count(name) {
      return listeners.get(name)?.size ?? 0;
    },
    close() {
      agentKindsModule.onSessionEnd!(host, runtime);
      capacityModule.onSessionEnd!(host, runtime);
      disposeKindRegistrations(host);
      registryView?.clearRuntimeAgentsForPi(built.pi);
      built.listener();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("gate decoder: only a work-starting call is ours; the kind comes from the table", () => {
  // The decoder is a shape check: which kind a name belongs to needs the project's table,
  // because a definition may rename the agent.
  assert.deepEqual(decodeKindDispatch({ agent: "cw-executor", task: "x" }), { agent: "cw-executor", async: true });
  assert.deepEqual(decodeKindDispatch({ agent: " cw-auditor ", task: "x", async: false }), { agent: "cw-auditor", async: false });
  // `resume`/`append-step` start work on a run that was already admitted.
  assert.equal(decodeKindDispatch({ agent: "cw-executor", action: "resume", message: "go" })?.agent, "cw-executor");
  assert.equal(decodeKindDispatch({ agent: "cw-executor", action: "append-step" })?.agent, "cw-executor");
  const shipped = resolveKinds(null);
  assert.equal(resolveDispatchKind("cw-executor", shipped), "executor");
  assert.equal(resolveDispatchKind("cw-builder", shipped), null, "a name the table does not know is not ours");
  assert.equal(
    resolveDispatchKind("cw-builder", [
      ...shipped,
      { kind: "builder", agent: "cw-builder" } as (typeof shipped)[number],
    ]),
    "builder",
    "but a renamed kind resolves through the table",
  );
  for (const input of [
    // Not ours: the builtin table and other extensions keep their own agents. The prefix is
    // what the shape check can decide; whether the table knows the name is the next step.
    { agent: "worker", task: "x" },
    { agent: "trellis-implement", task: "x" },
    // Not a dispatch: management actions use `agent` as a target, not a child.
    { action: "status" },
    { action: "stop", agent: "cw-executor" },
    { action: "create", agent: "cw-executor" },
    { agent: "" },
    {},
    null,
    undefined,
    "subagent",
    ["cw-executor"],
  ]) {
    assert.equal(decodeKindDispatch(input), null, JSON.stringify(input) ?? "undefined");
  }
  // A `cw-` name in the namespace but not in the table passes the shape check and is then
  // refused by the table: the gate reads both, and neither step alone is the decision.
  const unknown = decodeKindDispatch({ agent: "cw-unknown", task: "x" });
  assert.ok(unknown, "the prefix is in this package's namespace");
  assert.equal(resolveDispatchKind(unknown!.agent, resolveKinds(null)), null, "but no kind claims it");
});

/**
 * The boundary this task exists for: a child started *inside a script* is not a child this package can
 * admit, and saying so is the difference between a stated boundary and a gate that claims coverage it
 * does not have.
 */
test("boundary decoder: only the two documented script spellings are ungovernable, never a named resource", () => {
  const launching = "const a = await runs.run('a', { agent: 'cw-executor', task: 'x' });";
  const reads = (script: string): string | null =>
    script === "./workflows/launch.js" || script === "/abs/launch.js"
      ? launching
      : script === "./workflows/pure.js"
        ? "return runs; // mentions the namespace but starts nothing"
        : null;

  assert.deepEqual(decodeUngovernedLaunch({ workflow: true }, reads), { shape: "inline-script" });
  assert.deepEqual(
    decodeUngovernedLaunch({ workflow: "./workflows/launch.js" }, reads),
    { shape: "script-file", script: "./workflows/launch.js" },
  );
  assert.deepEqual(
    decodeUngovernedLaunch({ workflow: "/abs/launch.js", async: true }, reads),
    { shape: "script-file", script: "/abs/launch.js" },
    "an absolute path is still a script file",
  );

  for (const input of [
    // Every named resource: our own fanout, the owner's parallel batch, another extension's workflow,
    // a bare name. Upstream's rule is a `/` that makes a string a file path, so these are not scripts.
    { workflow: "parallel", args: { tasks: [{ agent: "worker", task: "x" }] } },
    { workflow: FANOUT_NAME, args: { tasks: [{ kind: "executor", task: "x" }] } },
    { workflow: "someone.else" },
    // A script that starts nothing of its own, and one we cannot read: unknown is not evidence.
    { workflow: "./workflows/pure.js" },
    { workflow: "./workflows/missing.js" },
    // No action at all is what this decoder looks at, so nothing is a new launch.
    { action: "status" },
    { action: "validate", workflow: true },
    { action: "stop", workflow: "./workflows/launch.js" },
    // A direct dispatch carries no `workflow` at all.
    { agent: "cw-executor", task: "x" },
    {},
    null,
    "subagent",
    ["workflow"],
  ]) {
    assert.equal(decodeUngovernedLaunch(input, reads), null, JSON.stringify(input) ?? "undefined");
  }
});

test("gate: a script-internal launch is refused and told to use coworkflow_dispatch", { skip }, async () => {
  const h = gateHarness();
  try {
    await syncAgentKinds(h.host, h.runtime);
    const before = h.requests.length;

    // The code-block form: nothing in the payload carries the script, so the shape is refused as such.
    const inline = await h.call({ workflow: true, args: { whatever: true } });
    assert.ok(inline, "a code-block workflow escapes every admission this package has");
    assert.match(inline.reason ?? "", /不经过本包的准入/);
    assert.match(inline.reason ?? "", /coworkflow_dispatch/);
    assert.match(inline.reason ?? "", /没有启动任何子进程/);

    // The script-path form: the file is read, and only a script that actually starts children is refused.
    writeFileSync(
      join(h.root, "launch.js"),
      "const a = await runs.run('a', { agent: 'cw-executor', task: 'x' });\nreturn a;",
    );
    writeFileSync(join(h.root, "pure.js"), "return runs.all.length; // no launch call here");
    const file = await h.call({ workflow: "./launch.js", args: {} });
    assert.ok(file, "a script that starts its own children is the shape this gate cannot admit");
    assert.match(file.reason ?? "", /runs\.run/);
    assert.match(file.reason ?? "", /coworkflow_dispatch/);
    assert.equal(await h.call({ workflow: "./pure.js" }), undefined, "a script that starts nothing is not refused");
    assert.equal(await h.call({ workflow: "./absent.js" }), undefined, "an unreadable script is unknown, not a guess");

    assert.equal(h.requests.length, before, "the boundary decision costs no public read");

    // The boundary is not a policy on ordinary dispatching: a named batch and a direct call still pass,
    // and the owner's `parallel` batch of agents that are not kinds is not this gate's business at all.
    assert.equal(
      await h.call({ workflow: "parallel", args: { tasks: [{ agent: "worker", task: "x" }] } }),
      undefined,
      "an ordinary parallel batch of someone else's agents is untouched",
    );
    assert.equal(await h.call({ agent: "trellis-implement", task: "work" }), undefined);
    assert.equal(await h.call({ agent: "cw-executor", task: "one" }), undefined, "a direct dispatch of a kind is still admitted");

    // With the layer off, nothing about this package's boundary applies.
    h.setModule(false);
    assert.equal(await h.call({ workflow: true }), undefined);
  } finally {
    h.close();
  }
});

test("gate: a disabled kind is refused, and the reason names only kinds that really exist", { skip }, async () => {
  // Disabled is the project's choice now, so the harness declares it.
  const h = gateHarness({ kinds: { auditor: { enabled: false } } });
  try {
    await syncAgentKinds(h.host, h.runtime);
    const refused = await h.call({ agent: "cw-auditor", task: "audit this" });
    assert.ok(refused, "a disabled kind must not be dispatched");
    assert.match(refused.reason ?? "", /关闭了 kind auditor（cw-auditor）/);
    assert.match(refused.reason ?? "", /当前可用的 kind：cw-executor、cw-researcher/);
    assert.match(refused.reason ?? "", /没有启动任何子进程/);
    assert.equal(h.requests.length, 0, "a disabled kind costs no public read: it is refused before counting");
  } finally {
    h.close();
  }
});

test("gate: over-limit is refused with the limit and the occupancy; one below the limit is admitted", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 2 } } });
  try {
    await syncAgentKinds(h.host, h.runtime);
    h.live.push("cw-executor");
    assert.equal(await h.call({ agent: "cw-executor", task: "one" }), undefined, "1 of 2 occupies the limit but does not reach it");
    // Exactly at the limit: no room for one more, which is what a limit of 2 means.
    h.live.push("cw-executor");
    const refused = await h.call({ agent: "cw-executor", task: "two" });
    assert.ok(refused);
    assert.match(refused.reason ?? "", /并发上限是 2/);
    assert.match(refused.reason ?? "", /当前已有 2 个在运行/);
    // Another agent's occupancy is not this kind's occupancy: three runs, one of
    // them ours, is still one of two.
    h.live.length = 0;
    h.live.push("cw-executor", "trellis-implement", "worker");
    assert.equal(await h.call({ agent: "cw-executor", task: "three" }), undefined, "other agents do not consume a kind slot");
    h.live.length = 0;
    h.live.push("trellis-implement", "worker");
    assert.equal(await h.call({ agent: "cw-executor", task: "four" }), undefined, "zero of ours is below the limit");
    h.live.length = 0;
    h.live.push("cw-executor", "cw-executor");
    assert.ok(await h.call({ agent: "cw-executor", task: "five" }), "two of two is at the limit");
  } finally {
    h.close();
  }
});

test("gate: an unreadable or unavailable fleet count refuses instead of assuming there is room", { skip }, async () => {
  for (const options of [{ fleetStatus: false }, { malformedFleet: true }, { omitted: 2 }]) {
    const h = gateHarness(options);
    try {
      await syncAgentKinds(h.host, h.runtime);
      assert.equal(h.live.length, 0, "the owner reports nothing running");
      const refused = await h.call({ agent: "cw-executor", task: "work" });
      assert.ok(refused, `unknown count must refuse (${JSON.stringify(options)})`);
      // Never `0`: the refusal says it could not count, and why.
      assert.match(refused.reason ?? "", /无法确认现在有几个在运行/);
      assert.match(refused.reason ?? "", /上限 5/);
      assert.doesNotMatch(refused.reason ?? "", /当前已有 0 个/);
    } finally {
      h.close();
    }
  }
});

test("gate: an enabled kind that nothing registered is refused, never silently started", async () => {
  // No `events` on the host: the runtime-agent contract cannot be reached, so no
  // kind is registered. The gate must still refuse a declared kind.
  const h = gateHarness({ events: false });
  try {
    await syncAgentKinds(h.host, h.runtime);
    const refused = await h.call({ agent: "cw-executor", task: "work" });
    assert.ok(refused);
    assert.match(refused.reason ?? "", /没有被注册到 pi-subagents/);
    assert.match(refused.reason ?? "", /事件总线/);
  } finally {
    h.close();
  }
});

test("gate: non-kind dispatches and management calls are byte-for-byte untouched", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    await syncAgentKinds(h.host, h.runtime);
    // A kind already at its limit, so any leak of the gate onto other names shows.
    h.live.push("cw-executor");
    const before = h.requests.length;
    for (const input of [
      { agent: "trellis-implement", task: "work" },
      { agent: "worker", task: "work" },
      { agent: "reviewer", task: "review" },
      { agent: "cw-unknown", task: "work" },
      { action: "status" },
      { action: "stop", agent: "cw-executor" },
      { action: "list" },
      {},
      { agent: "cw-executor", action: "status" },
    ]) {
      assert.equal(await h.call(input), undefined, JSON.stringify(input));
    }
    assert.equal(h.requests.length, before, "no public read, no block: these calls never touch the gate's count");
  } finally {
    h.close();
  }
});

test("gate: the project-wide limit and the per-kind limit both hold, and neither masks the other", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    capacityModule.activate!(h.host, h.runtime);
    await syncAgentKinds(h.host, h.runtime);

    // Per-kind refuses while the project-wide limit has room: its own reason wins.
    h.setConcurrency(5);
    h.live.push("cw-executor");
    const kindBlocked = await h.call({ agent: "cw-executor", task: "one" });
    assert.ok(kindBlocked);
    assert.match(kindBlocked.reason ?? "", /并发上限是 1/);

    // The project-wide limit refuses while the kind has room: the coarse gate still
    // applies to a kind, which is what "both must admit" means.
    h.live.length = 0;
    h.live.push("trellis-implement");
    h.setConcurrency(1);
    const globalBlocked = await h.call({ agent: "cw-executor", task: "two" });
    assert.ok(globalBlocked);
    assert.match(globalBlocked.reason ?? "", /本项目（Coworkflow）的子 agent 并发上限是 1/);
    assert.doesNotMatch(globalBlocked.reason ?? "", /并发上限是 1\./);

    // Both would block: the narrower, more specific refusal is the one the model
    // reads, which is what "per-kind admission runs first" buys.
    h.setConcurrency(1);
    h.live.push("cw-executor");
    const both = await h.call({ agent: "cw-executor", task: "both" });
    assert.ok(both);
    assert.match(both.reason ?? "", /kind executor（cw-executor） 的并发上限是 1/);
    assert.doesNotMatch(both.reason ?? "", /本项目（Coworkflow）的子 agent 并发上限/);

    // Both admit: the dispatch goes through.
    h.setConcurrency(5);
    h.live.length = 0;
    assert.equal(await h.call({ agent: "cw-executor", task: "three" }), undefined);
  } finally {
    h.close();
  }
});

test("defaults: an owned launch is background whether async is omitted or false", () => {
  // Upstream follows `asyncByDefault` when `async` is omitted, and a project that turned it
  // off gets a foreground child that blocks the main session. "A child never blocks the
  // parent" is this package's rule, so the field is written rather than assumed.
  const omitted = { agent: "cw-executor", task: "work" } as Record<string, unknown>;
  const omittedFilled = applyDispatchDefaults(omitted, undefined);
  assert.equal(omitted.async, true, "an omitted async is written as true");
  assert.ok(omittedFilled.includes("async-default"), "counted as a filled default");
  assert.ok(!omittedFilled.includes("async"), "not as a foreground dispatch rewritten");

  const foreground = { agent: "cw-executor", task: "work", async: false } as Record<string, unknown>;
  const filled = applyDispatchDefaults(foreground, undefined);
  assert.equal(foreground.async, true, "an explicit foreground request is rewritten");
  assert.ok(filled.includes("async"), "and reported as the rewrite it is");

  // Everything else still follows the caller: its own context and budget win.
  const explicit = {
    agent: "cw-executor",
    task: "work",
    async: true,
    options: { context: "fork", timeoutMs: 123456 },
  } as Record<string, unknown>;
  const kept = applyDispatchDefaults(explicit, 60000);
  assert.equal(explicit.async, true);
  assert.deepEqual(explicit.options, {
    context: "fork",
    timeoutMs: 123456,
    checkpointBeforeDeadlineMs: checkpointFor(123456),
  });
  assert.ok(!kept.includes("async") && !kept.includes("async-default"), "nothing was rewritten");
});

test("gate: a caller that omits async still gets a background launch", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true } } });
  try {
    await syncAgentKinds(h.host, h.runtime);
    const omitted: Record<string, unknown> = { agent: "cw-executor", task: "work" };
    assert.equal(await h.call(omitted), undefined, "admitted");
    assert.equal(omitted.async, true, "the gate wrote the field the caller left out");
    const foreground: Record<string, unknown> = { agent: "cw-executor", task: "work", async: false };
    assert.equal(await h.call(foreground), undefined, "admitted");
    assert.equal(foreground.async, true, "and an explicit false is rewritten too");
  } finally {
    h.close();
  }
});

test("workflow agents: the kind's resolved role decides the step, not the shipped kind's role", { skip }, async () => {
  // A project definition may give a kind its own role. Reading the shipped kind's role
  // instead launched the implement step with an agent whose children receive check context —
  // the same kind, two answers, from two places.
  const h = gateHarness({ kinds: { executor: { enabled: false } } });
  try {
    mkdirSync(join(h.root, ".pi", "Coworkflow", "agents"), { recursive: true });
    writeFileSync(
      join(h.root, ".pi", "Coworkflow", "agents", "builder.md"),
      ["---", "agent: cw-builder", "role: implement", "description: builds the thing", "---", "", "You build it.", ""].join("\n"),
    );
    await syncAgentKinds(h.host, h.runtime);
    const kinds = resolveKinds(readConfig(h.root), readKindDefinitions(h.root).definitions);
    assert.equal(kinds.find((entry) => entry.kind === "builder")?.role, "implement", "the file's role is resolved");
    assert.deepEqual(
      kindWorkflowAgents(h.host, kinds),
      { implementAgent: "cw-builder", reviewAgent: "cw-auditor" },
      "the enabled and registered kind drives the implement step, the shipped auditor keeps the review step",
    );
  } finally {
    h.close();
  }
});

test("gate: it runs only in the parent session and only while the layer is on", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    await syncAgentKinds(h.host, h.runtime);
    h.live.push("cw-executor");
    h.setModule(false);
    assert.equal(await h.call({ agent: "cw-executor", task: "work" }), undefined, "a switched-off module does not police");
    h.setModule(true);
    h.setEnabled(false);
    assert.equal(await h.call({ agent: "cw-executor", task: "work" }), undefined, "a switched-off session does not police");
    h.setEnabled(true);
    assert.ok(await h.call({ agent: "cw-executor", task: "work" }), "back on, the gate refuses again with no reload");
    // A child must not gate its own subtree.
    (h.runtime as { isChild: boolean }).isChild = true;
    assert.equal(await h.call({ agent: "cw-executor", task: "work" }), undefined);
    (h.runtime as { isChild: boolean }).isChild = false;
  } finally {
    h.close();
  }
});

test("gate: session end releases the hook, and re-activation installs exactly one", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    assert.equal(h.count("tool_call"), 1);
    // A second activation in the same session must not add a listener: two gates
    // would ask the owner twice and could admit one launch into two slots.
    agentKindsModule.activate!(h.host, h.runtime);
    assert.equal(h.count("tool_call"), 1);

    agentKindsModule.onSessionEnd!(h.host, h.runtime);
    assert.equal(h.count("tool_call"), 0, "nothing stays registered for the next session");

    (h.runtime as { sessionEpoch: number }).sessionEpoch = 2;
    agentKindsModule.activate!(h.host, h.runtime);
    assert.equal(h.count("tool_call"), 1, "one hook again, not two");
    await syncAgentKinds(h.host, h.runtime);
    assert.deepEqual(
      kindRegistryFor(h.host).registered().map((entry) => entry.agent).sort(),
      ["cw-auditor", "cw-executor", "cw-researcher"],
      "re-registered after the session ended",
    );
    assert.equal(await h.call({ agent: "cw-executor", task: "work" }), undefined, "the reinstated gate does not refuse a free kind");
  } finally {
    h.close();
  }
});


/**
 * A configured agent holding a kind's name must not break the whole session.
 *
 * The owner validates builtin and runtime collisions at registration, but a
 * *configured* agent (`.pi/agents/cw-executor.md`) is only caught later, in its
 * discovery merge — which throws on a path with no try around it. One such file
 * therefore broke every dispatch in the session, kinds and plain agents alike,
 * while this package still reported the kind as registered.
 */
test("registration: a configured agent with a kind's name fails that kind only, and the owner still works", { skip }, async () => {
  const { pi } = fakePi();
  const project = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-kinds-configured-")));
  try {
    mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "agents", "cw-executor.md"),
      "---\nname: cw-executor\ndescription: project owned\n---\n\nProject's own executor.\n",
    );
    const loaded = await loadRuntimeAgentContract({ events: pi.events, cwd: project, agentDir: join(project, "user-agent-dir") });
    assert.equal(loaded.ok, true);

    // The colliding kind is refused here, locally, instead of poisoning the whole
    // session's agent discovery on the first dispatch.
    assert.throws(
      () => loaded.ok && loaded.contract.register("cw-executor", { description: "ours", systemPrompt: "ours", tools: [] }),
      /占用了名称 cw-executor/,
    );
    // Its neighbours are unaffected: one collision is not the entire layer.
    const other = loaded.ok ? loaded.contract.register("cw-auditor", { description: "audit", systemPrompt: "audit", tools: [] }) : null;
    assert.ok(other !== null);
    assert.deepEqual(
      registryView?.listRuntimeAgentConfigs(pi).map((entry) => entry.name),
      ["cw-auditor"],
      "the non-colliding kind registered in the owner",
    );
    other?.dispose();
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/**
 * The operator's own example: three executors and one auditor at the same time,
 * with each kind's ceiling counted separately.
 *
 * A single project-wide number cannot express this, and a shared counter would make
 * one kind's work consume another kind's budget — which is exactly the distinction
 * the kinds exist for.
 */
test("gate: three executors and one auditor run together, each kind counted on its own", { skip }, async () => {
  const h = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 3 }, auditor: { enabled: true, maxConcurrent: 1 } } });
  try {
    await syncAgentKinds(h.host, h.runtime);

    // Three executors occupy executor, and leave auditor untouched.
    h.live.push("cw-executor", "cw-executor", "cw-executor");
    const fourthExecutor = await h.call({ agent: "cw-executor", task: "4th" });
    assert.ok(fourthExecutor, "a 4th executor is refused at a ceiling of 3");
    assert.match(fourthExecutor.reason ?? "", /并发上限是 3/);
    assert.match(fourthExecutor.reason ?? "", /当前已有 3 个在运行/);

    // The auditor's single slot is free even though three executors are running.
    assert.equal(await h.call({ agent: "cw-auditor", task: "audit" }), undefined,
      "another kind's occupancy is not this kind's occupancy");

    // And it is one: the second auditor is refused while the executors keep their own count.
    h.live.push("cw-auditor");
    const secondAuditor = await h.call({ agent: "cw-auditor", task: "audit 2" });
    assert.ok(secondAuditor, "a 2nd auditor is refused at a ceiling of 1");
    assert.match(secondAuditor.reason ?? "", /并发上限是 1/);

    // At capacity, another executor is still judged on executors only.
    const fifthExecutor = await h.call({ agent: "cw-executor", task: "5th" });
    assert.ok(fifthExecutor);
    assert.doesNotMatch(fifthExecutor.reason ?? "", /auditor/, "the refusal does not blame another kind");
  } finally {
    h.close();
  }
});

/**
 * Every kind starts the same, and the number is the project's to change.
 *
 * The defaults used to be a policy this package imposed — executor 3, auditor 1,
 * researcher 2, with the latter two off. A session reading that sees "you may have one
 * auditor", which is a split decision nobody made, and the per-kind ceilings were below
 * what an ordinary task needs. The ceiling is a guard the project sets, not a permission
 * this package allocates.
 */
test("kinds: every kind starts enabled with the same ceiling", () => {
  for (const entry of BUILTIN_KINDS) {
    assert.equal(entry.defaults.enabled, true, `${entry.kind} is available unless the project says otherwise`);
    assert.equal(entry.defaults.maxConcurrent, DEFAULT_MAX_CONCURRENT, `${entry.kind} starts at the shared ceiling`);
  }
  assert.ok(DEFAULT_MAX_CONCURRENT >= 5, "the starting ceiling is not a bottleneck");
  // The ceiling is advisory in the sense that it is editable; it is enforced once set.
  // The resolved kind carries more than the policy now — its role, description, where it
  // came from and which fields the project chose — so assert the fields this test is about
  // rather than the whole object: a shape change should not read as a policy change.
  const resolved = resolveKinds({ version: 1, modules: {}, agentKinds: { executor: { maxConcurrent: 12 } } })
    .find((entry) => entry.kind === "executor");
  assert.equal(resolved?.maxConcurrent, 12, "the project's number wins");
  assert.equal(resolved?.enabled, true, "and an unrelated field keeps its default");
  assert.equal(resolved?.chosen?.maxConcurrent, true, "and is reported as chosen, not defaulted");
  assert.deepEqual(
    { kind: resolved?.kind, label: resolved?.label, agent: resolved?.agent, source: resolved?.source },
    { kind: "executor", label: "执行者", agent: "cw-executor", source: "shipped" },
    "the identity of a shipped kind is unchanged",
  );
});

/**
 * A fanout is checked against what is running, not only against its own size.
 *
 * The resolver refuses a batch that alone overshoots the ceiling; only the gate can see the owner's
 * live count, so the occupancy-aware half lives there. Both halves matter: three in flight against a
 * ceiling of five leaves room for two, and a fanout of three would overshoot even though three is
 * under five.
 */
test("gate: the same ceiling holds for the owner's parallel workflow", { skip }, async () => {
  // The regression that matters: a live session on this package dispatched ten cw-executor children
  // through `{ workflow: "parallel", args: { tasks: [{ agent: "cw-executor", … }] } }`, and the gate
  // did not see it because it only recognised its own workflow. Driving the production gate here, not
  // just the decoder, is the whole point.
  const harness = gateHarness({ kinds: { executor: { maxConcurrent: 5 } } });
  try {
    const parallel = (count: number) => ({
      workflow: "parallel",
      args: { tasks: Array.from({ length: count }, (_, i) => ({ agent: "cw-executor", task: `t${i}` })) },
    });
    harness.live.push("cw-executor", "cw-executor", "cw-executor");
    assert.equal(await harness.call(parallel(2)), undefined, "within the ceiling, the gate stays out of it");

    harness.live.push("cw-executor");
    const over = await harness.call(parallel(2));
    assert.ok(over, "six against a ceiling of five with four running must be refused");
    const reason = String(over.reason ?? "");
    assert.match(reason, /要启动 2 个/);
    assert.match(reason, /上限是 5/);
    assert.match(reason, /整批被拦下/, "a workflow is all-or-nothing");
  } finally {
    harness.close();
  }
});

test("gate: a fanout respects the kind ceiling including what is already running", { skip }, async () => {
  const harness = gateHarness({ kinds: { executor: { maxConcurrent: 5 } } });
  try {
    const fanout = (count: number) => ({
      workflow: "coworkflow.fanout",
      args: { tasks: Array.from({ length: count }, (_, i) => ({ kind: "executor", task: `t${i}` })) },
    });

    // Room: three in flight against a ceiling of five, a batch of two fits.
    harness.live.push("cw-executor", "cw-executor", "cw-executor");
    assert.equal(await harness.call(fanout(2)), undefined, "within the ceiling, the gate stays out of it");

    // Four in flight: a batch of two would reach six, so the whole call is refused.
    harness.live.push("cw-executor");
    const over = await harness.call(fanout(2));
    assert.ok(over, "the call must be refused");
    const reason = String(over.reason ?? "");
    assert.match(reason, /要启动 2 个/);
    assert.match(reason, /上限是 5/);
    assert.match(reason, /当前已有 4 个在运行/);
    assert.match(reason, /整批被拦下/, "a workflow is all-or-nothing");
    assert.match(reason, /\/Coworkflow:settings/, "and says where to change it");

    // A disabled kind is refused for the fanout too, with the batch never starting.
    const off = gateHarness({ kinds: { auditor: { enabled: false } } });
    try {
      const refused = await off.call({ workflow: "coworkflow.fanout", args: { tasks: [{ kind: "auditor", task: "x" }] } });
      assert.ok(refused, "a disabled kind inside a fanout is refused");
      assert.match(String(refused.reason ?? ""), /关闭了 kind auditor/);
    } finally {
      off.close();
    }
  } finally {
    harness.close();
  }
});

/**
 * A dispatch never occupies the main session.
 *
 * `async` defaults to on, so a blocking child only happens when the caller asks for one — and this
 * project does not allow that. The gate rewrites the request rather than refusing it: the child still
 * runs, the caller still gets a run id to wait on, so nothing is lost but the block.
 */
test("gate: one admission authority, so a direct dispatch and a batch refuse for the same reason", { skip }, async () => {
  const harness = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    // Full: one already running against a ceiling of one.
    harness.live.push("cw-executor");
    const direct = await harness.call({ agent: "cw-executor", task: "x" });
    const batch = await harness.call({
      workflow: "coworkflow.fanout",
      args: { tasks: [{ kind: "executor", task: "a" }] },
    });
    assert.ok(direct?.block && batch?.block, "both shapes refuse");
    assert.match(direct!.reason!, /并发上限是 1/);
    assert.match(batch!.reason!, /上限是 1/);

    // Disabled: both say the kind is off, neither says "over the limit".
    harness.live.length = 0;
    harness.setModule(false);
    harness.setModule(true);
    const root = harness.root;
    writeFileSync(
      join(root, ".pi", "Coworkflow.json"),
      JSON.stringify({ version: 1, modules: {}, agentKinds: { executor: { enabled: false } } }),
    );
    const directOff = await harness.call({ agent: "cw-executor", task: "x" });
    const batchOff = await harness.call({
      workflow: "coworkflow.fanout",
      args: { tasks: [{ kind: "executor", task: "a" }] },
    });
    assert.match(directOff?.reason ?? "", /关闭|disabled|打开/);
    assert.match(batchOff?.reason ?? "", /关闭|disabled|打开/);
    assert.doesNotMatch(directOff?.reason ?? "", /并发上限/);
    assert.doesNotMatch(batchOff?.reason ?? "", /已有 0 个在运行/);
  } finally {
    harness.close();
  }
});

test("gate: the mechanical fields a dispatch needs are filled in, and explicit values are kept", { skip }, async () => {
  const harness = gateHarness();
  try {
    const bare: Record<string, any> = { agent: "cw-executor", task: "x" };
    assert.equal(await harness.call(bare), undefined);
    assert.equal(bare.async, true, "an absent async is written as true: upstream's asyncByDefault may be false");
    assert.equal(bare.options.context, "fresh", "context defaults to a fresh child");
    assert.equal(typeof bare.options.timeoutMs, "number");
    assert.ok(bare.options.timeoutMs > 0);
    assert.equal(
      bare.options.checkpointBeforeDeadlineMs,
      checkpointFor(bare.options.timeoutMs),
      "the hand-over warning scales with the budget",
    );

    // An explicit choice is the caller's, and this never overwrites it.
    const explicit: Record<string, any> = {
      agent: "cw-executor",
      task: "x",
      async: true,
      options: { context: "fork", timeoutMs: 90_000, checkpointBeforeDeadlineMs: 1_000 },
    };
    assert.equal(await harness.call(explicit), undefined);
    assert.equal(explicit.options.context, "fork");
    assert.equal(explicit.options.timeoutMs, 90_000);
    assert.equal(explicit.options.checkpointBeforeDeadlineMs, 1_000);
  } finally {
    harness.close();
  }
});

test("gate: a foreground dispatch is put in the background, and the rewrite is reported", { skip }, async () => {
  const harness = gateHarness();
  try {
    // A kind dispatch that asked to block.
    const foreground = { agent: "cw-executor", task: "x", async: false };
    assert.equal(await harness.call(foreground), undefined, "it is admitted, not refused");
    assert.equal(foreground.async, true, "but the request the host runs is a background one");

    // The fanout path is the same rule, on the same object.
    const fanout = {
      workflow: "coworkflow.fanout",
      async: false,
      args: { tasks: [{ kind: "executor", task: "a" }] },
    };
    assert.equal(await harness.call(fanout), undefined);
    assert.equal(fanout.async, true, "a fanout cannot block the main session either");

    // A call that already asked for background is left at that value: the field is present,
    // and no rewrite is counted for it.
    const background = { agent: "cw-executor", task: "x", async: true };
    assert.equal(await harness.call(background), undefined);
    assert.equal(background.async, true, "an explicit background request is unchanged");

    // Reported as a fact, so "why did my child not block?" has an answer.
    const status = agentKindsModule.runtimeStatus!(harness.host) ?? [];
    assert.ok(
      status.some((line) => line.includes("已把 2 次") && line.includes("改为后台")),
      status.join("\n"),
    );

    // A refused dispatch is not counted: nothing was admitted, so nothing was rewritten.
    harness.setModule(false);
    const refused = { agent: "cw-executor", task: "x", async: false };
    assert.equal(await harness.call(refused), undefined, "the layer is off, so the gate stays out of it");
    assert.equal(refused.async, false, "and a disabled layer does not rewrite other people's calls");
  } finally {
    harness.close();
  }
});

test("gate: a parallel batch of agents this package does not own is admitted without a public read", { skip }, async () => {
  // A plain batch — the everyday use of the owner's `parallel` workflow — used to be looked up in the
  // project's kind table item by item, miss, and be refused whole as "an unregistered kind". The
  // direct-dispatch path has always promised the opposite: a name the table does not know is not this
  // gate's business. The batch path now keeps that promise, and keeps it *before* the owner is asked
  // for anything: a gate that reads fleet status to decide a batch it does not police costs a public
  // round trip per ordinary fanout.
  const harness = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    await syncAgentKinds(harness.host, harness.runtime);
    const before = harness.requests.length;
    const batch = {
      workflow: "parallel",
      args: { tasks: [{ agent: "reviewer", task: "review" }, { agent: "trellis-check", task: "check" }] },
    };
    assert.equal(await harness.call(batch), undefined, "no kind of ours in the batch, so no refusal");
    assert.equal(
      harness.requests.length,
      before,
      "and no public read either: the fleet is not asked about agents the ceiling does not cover",
    );
  } finally {
    harness.close();
  }
});

test("gate: a mixed batch is refused for its own kind only, and names only that kind", { skip }, async () => {
  // Mixed batches are how a session actually works: one executor doing the edit, a reviewer outside
  // this package. The refusal is about the executor alone; mentioning the reviewer would read as if
  // the reviewer were over a ceiling, and the model would have no way to tell which task to drop.
  const harness = gateHarness({ kinds: { executor: { enabled: true, maxConcurrent: 1 } } });
  try {
    await syncAgentKinds(harness.host, harness.runtime);
    harness.live.push("cw-executor");
    const refused = await harness.call({
      workflow: "parallel",
      args: {
        tasks: [
          { agent: "cw-executor", task: "implement" },
          { agent: "reviewer", task: "review" },
        ],
      },
    });
    assert.ok(refused, "the executor is at its ceiling, so the batch is refused");
    const reason = String(refused.reason ?? "");
    // R4: which kind (and its agent name), the ceiling, the occupancy, and that nothing started.
    assert.match(reason, /cw-executor/, "the kind's agent is named");
    assert.match(reason, /executor/, "and so is the kind");
    assert.match(reason, /上限是 1/, "the ceiling is stated");
    assert.match(reason, /当前已有 1 个在运行/, "and what is running now");
    assert.match(reason, /没有启动任何子进程/, "and that nothing was started");
    assert.doesNotMatch(reason, /reviewer/, "the unrelated agent is not part of the reason");
    assert.doesNotMatch(reason, /trellis-/, "nor is any other non-kind name");
  } finally {
    harness.close();
  }
});

/**
 * The owner's own parallel workflow dispatches kinds too, and it bypassed the ceiling.
 *
 * Found on a live machine: a session dispatched ten `cw-executor` children through
 * `subagent({ workflow: "parallel", args: { tasks: [{ agent: "cw-executor", … }] } })` — the gate only
 * recognised `coworkflow.fanout`, so the recommended path enforced the per-kind limit and the path the
 * model actually chose did not. A limit that the most convenient dispatch shape skips is not a limit.
 */
test("gate: the owner's parallel workflow is measured by the same per-kind ceiling", () => {
  const parallel = (agents: string[]): unknown => ({
    workflow: "parallel",
    args: { tasks: agents.map((agent, i) => ({ agent, task: `t${i}` })) },
  });
  // Five executors is the ceiling; six must be seen and refused.
  assert.deepEqual(decodeFanoutCall(parallel(["cw-executor", "cw-executor"])), [
    { kind: "cw-executor", count: 2 },
  ]);
  const six = decodeFanoutCall(parallel(Array.from({ length: 6 }, () => "cw-executor")));
  assert.deepEqual(six, [{ kind: "cw-executor", count: 6 }], "the batch size is visible");

  // Our own shape still decodes, and non-kind agents in a parallel batch are not ours.
  assert.deepEqual(decodeFanoutCall({ workflow: "coworkflow.fanout", args: { tasks: [{ kind: "auditor" }] } }), [
    { kind: "auditor", count: 1 },
  ]);
  assert.deepEqual(decodeFanoutCall(parallel(["trellis-check", "worker"])), [
    { kind: "trellis-check", count: 1 },
    { kind: "worker", count: 1 },
  ], "it reports what it saw; resolving against the table is the gate's job");

  // Anything that is not a batch is not this gate's business.
  assert.equal(decodeFanoutCall({ workflow: "parallel", args: {} }), null);
  assert.equal(decodeFanoutCall({ workflow: "other", args: { tasks: [{ agent: "cw-executor" }] } }), null);
});
