/**
 * `/Comodels` per-kind pages, Stage 2: the page list, and what a kind page applies.
 *
 * What can break silently here, and is therefore what this file drives:
 *
 *   - **the page list is computed.** A hardcoded 主会话/子 agent pair is exactly what
 *     made a per-kind model unrepresentable; `panelPages`/`nextTab` are the
 *     production functions that build and cycle it, so a snapshot with one kind fewer
 *     must produce one page fewer and a disabled kind must keep its page.
 *   - **a kind page writes through the config and the registration.** Enter on a kind
 *     page must reach `control.setAgentKind` → `.pi/Coworkflow.json` *and* the
 *     installed owner's registry, not just the panel's own copy of the value. The
 *     assertions therefore read the config file and the owner's registry view.
 *   - **clearing returns to inherit.** The inherit row must delete the key; a kind
 *     that keeps a stale model after "继承" is a setting nobody made.
 *   - **thinking levels follow the kind's own model.** A kind that pins a
 *     non-reasoning model must offer that model's levels, not the session model's —
 *     the default page's rule, applied per kind.
 *
 * The panel is opened through the registered `/Comodels` command and the real
 * extension, with the installed pi-subagents as the registration owner: the fake bus
 * below carries the owner's own registration listener, so what registers is what the
 * real package registers.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readConfig } from "../core/config.ts";
import { exportEntry } from "../core/subagents-workflow.ts";
import {
  kindStateLabel,
  kindTab,
  kindsLayerNote,
  modelForRef,
  modelRefOf,
  modelRows,
  nextTab,
  panelPages,
  resolveTab,
  stripThinkingSuffix,
  thinkingRows,
  type PanelKindSnapshot,
  type PanelModel,
  type PanelSnapshot,
} from "../modules/panel/shared.ts";
import type { ModelPanel } from "../modules/panel/models-panel.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

// ── the installed owner, resolved exactly as production resolves it ───

const ownerPath = exportEntry("./agents", mkdtempSync(join(tmpdir(), "coworkflow-panel-probe-")));
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

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const emptyCost = {
  version: 1,
  parent: totals,
  children: [],
  childTotal: totals,
  total: totals,
  unresolvedAsyncChildren: 0,
};

/**
 * A fake `pi` whose bus carries both the installed owner's registration listener and
 * the public RPC replies `/Comodels` reads usage from.
 *
 * Two channels on one bus, because that is what production has: the owner registers
 * through `pi.events` and the panel reads cost through the same bus. A test that
 * stubbed either one would not be driving the path the panel uses.
 */
function fakePi(): { pi: FakePi; listener: () => void } {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const dispatch = (channel: string, data: unknown): void => {
    for (const handler of listeners.get(channel) ?? []) handler(data);
  };
  const reply = (request: Record<string, unknown>, data: unknown): void =>
    dispatch(`subagents:rpc:v1:reply:${String(request.requestId)}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data,
    });
  const pi: FakePi = {
    events: {
      emit(channel: string, data: unknown) {
        if (channel !== "subagents:rpc:v1:request") {
          dispatch(channel, data);
          return;
        }
        const request = data as Record<string, unknown>;
        // Enough of the protocol for the panel's usage read: a ping that advertises
        // `cost`, an empty cost report, and a fleet window with nothing running.
        const answer = request.method === "ping"
          ? { version: 1, methods: ["status", "cost"], capabilities: { cost: { version: 1 } }, events: {}, session: {} }
          : request.method === "cost"
            ? emptyCost
            : { fleet: { version: 1, totalActive: 0, omitted: 0, entries: [], topLevelAsyncCapacity: { used: 0, limit: null } } };
        queueMicrotask(() => reply(request, answer));
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

// ── 1. the page list is computed, never declared ─────────────────────

const strong: PanelModel = { provider: "p", id: "strong", name: "Strong", available: true };
const cheap: PanelModel = {
  provider: "p",
  id: "cheap",
  name: "Cheap",
  available: true,
  // A non-reasoning model: its only level is `off`, which is how the test tells a
  // kind page's levels from the session model's.
  raw: { provider: "p", id: "cheap", reasoning: false },
};

function kindEntry(kind: string, label: string, rest: Partial<PanelKindSnapshot> = {}): PanelKindSnapshot {
  return {
    kind,
    label,
    agent: `cw-${kind}`,
    enabled: true,
    model: "",
    thinking: "",
    effectiveModel: strong,
    ...rest,
  };
}

function snapshot(kinds: PanelKindSnapshot[], kindsActive = true): PanelSnapshot {
  return {
    models: [strong, cheap],
    sessionModel: "p/strong",
    sessionThinking: "medium",
    subagentModel: "",
    subagentThinking: "",
    sessionEffectiveModel: strong,
    subagentEffectiveModel: strong,
    kinds,
    kindsActive,
    history: { selectedModel: "p/strong", selected: { days: [], total: 0, peak: 0 } },
  };
}

test("panel: the page list follows the snapshot's kinds, and a disabled kind keeps its page", () => {
  const three = snapshot([
    kindEntry("executor", "执行者"),
    kindEntry("auditor", "审计者"),
    kindEntry("researcher", "调研者", { enabled: false, model: "p/cheap" }),
  ]);
  const pages = panelPages(three);
  assert.deepEqual(pages.map((page) => page.label), [
    "主会话",
    "子 agent（默认）",
    "执行者 cw-executor",
    "审计者 cw-auditor",
    "调研者 cw-researcher",
  ]);
  assert.deepEqual(pages.map((page) => page.tab), ["session", "subagent", "kind:executor", "kind:auditor", "kind:researcher"]);
  // A disabled kind still has a page, and says so: its model is stored and would
  // apply the moment the kind is switched on again.
  assert.equal(pages[4]?.note, "已关闭");
  assert.equal(pages[3]?.note, undefined);

  // One kind fewer is one page fewer — the list is not a fixed pair plus extras.
  const two = snapshot([kindEntry("executor", "执行者"), kindEntry("auditor", "审计者")]);
  assert.equal(panelPages(two).length, 4);
  assert.deepEqual(panelPages(two).map((page) => page.label), [
    "主会话",
    "子 agent（默认）",
    "执行者 cw-executor",
    "审计者 cw-auditor",
  ]);
  // And no kinds at all leaves exactly the two scopes every project has.
  assert.equal(panelPages(snapshot([])).length, 2);

  // Tab cycles every page and wraps, whatever the count is.
  const first = pages[0]!.tab;
  let tab = first;
  const seen: string[] = [];
  for (let step = 0; step < pages.length; step += 1) {
    tab = nextTab(three, tab);
    seen.push(tab);
  }
  assert.deepEqual(seen, ["subagent", "kind:executor", "kind:auditor", "kind:researcher", "session"]);

  // A page whose kind is gone falls back to the session page instead of rendering an
  // empty table: the config block can be removed while a panel is open.
  assert.equal(resolveTab(two, kindTab("researcher")), "session");
  assert.equal(resolveTab(two, kindTab("auditor")), kindTab("auditor"));
  assert.equal(kindTab("executor"), "kind:executor");

  // With the layer off nothing is registered, so the page says that instead of
  // claiming the kind is merely switched off — a different fact, and a write on that
  // page only changes the stored policy.
  const layerOff = snapshot([kindEntry("executor", "执行者")], false);
  assert.equal(panelPages(layerOff)[2]?.note, "本会话未启用");
  assert.match(kindsLayerNote(layerOff), /未注册任何 kind/);
  assert.equal(kindsLayerNote(three), "", "an active layer adds no note");
});

// ── 1b. a stored pin the registry cannot resolve ────────────────────

test("panel: a pin the registry cannot resolve stays unresolved and keeps its own current row", () => {
  // `ollama/llama3:latest` is a model id whose colon is not a thinking level. It used
  // to be stripped to `ollama/llama3`, resolve to nothing, and then fall back to the
  // *inherited* model — which marked that model's row current, so one untouched Enter
  // wrote it over the pin.
  assert.equal(stripThinkingSuffix("ollama/llama3:latest"), "ollama/llama3:latest");
  assert.equal(stripThinkingSuffix("openrouter/x:free"), "openrouter/x:free");
  // Only a known level is a level, the rule upstream's `splitKnownThinkingSuffix` uses.
  assert.equal(stripThinkingSuffix("p/strong:high"), "p/strong");
  assert.equal(stripThinkingSuffix("p/strong:max"), "p/strong");
  assert.equal(stripThinkingSuffix("p/strong"), "p/strong");

  const llama: PanelModel = { provider: "ollama", id: "llama3:latest", name: "Llama 3", available: true };
  const models = [strong, cheap, llama];
  assert.equal(modelForRef(models, "ollama/llama3:latest")?.id, "llama3:latest", "a non-level suffix resolves");
  assert.equal(modelForRef(models, "p/strong:high")?.id, "strong");
  assert.equal(modelForRef(models, "typo/x"), undefined);

  // A bare id offered by two providers is ambiguous, not "the first match": upstream's
  // own resolver returns undefined there, and picking one would show — and write back —
  // the wrong provider's model.
  const twinA: PanelModel = { provider: "a", id: "twin", name: "Twin A", available: true };
  const twinB: PanelModel = { provider: "b", id: "twin", name: "Twin B", available: true };
  assert.equal(modelForRef([twinA, twinB], "twin"), undefined, "two matches is unresolved");
  assert.equal(modelForRef([twinA, twinB], "twin", "b")?.provider, "b", "the preferred provider settles it");
  assert.equal(modelForRef([twinA], "twin")?.provider, "a", "one match is unambiguous");

  // A pinned-but-unresolved model: `effectiveModel` is undefined (the inherited model
  // is a different setting, never a substitute), the page says so, and the pin keeps a
  // row of its own marked current so the cursor seeds on what the project stored.
  const unresolvable = snapshot([
    kindEntry("auditor", "审计者", { model: "anthropic/claude-opus-4", effectiveModel: undefined }),
  ]);
  assert.equal(kindStateLabel(unresolvable, unresolvable.kinds[0]!), "固定 anthropic/claude-opus-4（不在当前模型注册表中）");
  const rows = modelRows(unresolvable, kindTab("auditor"));
  assert.equal(rows[0]?.current, false, "the inherit row is not in effect");
  assert.equal(rows.filter((row) => row.current).length, 1, "exactly one row is current");
  assert.equal(rows[1]?.current, true, "the stored pin's own row is current");
  assert.equal(rows[1]?.model?.ref, "anthropic/claude-opus-4");
  assert.match(rows[1]?.label ?? "", /不在模型注册表/);
  // The thinking column offers the generic set rather than the inherited model's levels,
  // which would misdescribe what the kind pins.
  assert.deepEqual(
    thinkingRows(unresolvable, kindTab("auditor")).map((row) => row.label).slice(0, 2),
    ["(默认 / 继承主会话思考)", "off"],
  );

  // A resolvable pin: one row is current, and it is the pin's — the inherited model is
  // not marked, which is what made the cursor land on the wrong row before.
  const pinnedCheap = snapshot([kindEntry("auditor", "审计者", { model: "cheap", effectiveModel: cheap })]);
  const cheapRows = modelRows(pinnedCheap, kindTab("auditor"));
  assert.equal(cheapRows.filter((row) => row.current).length, 1);
  assert.equal(cheapRows.find((row) => row.model?.id === "cheap")?.current, true);
  assert.equal(cheapRows.find((row) => row.model?.id === "strong")?.current, false);
  // The pin's row writes the pin back verbatim, so a bare id or a `:latest` tag
  // survives an Enter that never moved.
  assert.equal(cheapRows.find((row) => row.model?.id === "cheap")?.model?.writeRef, "cheap");
  assert.equal(modelRefOf(cheapRows.find((row) => row.model?.id === "cheap")!.model!), "cheap");
});

// ── 2. what a kind page shows ─────────────────────────────────────────

test("panel: a kind page's rows are that kind's model, and its levels follow the kind's own model", () => {
  const inheriting = snapshot([kindEntry("executor", "执行者")]);
  const pinned = snapshot([kindEntry("executor", "执行者", { model: "p/cheap", effectiveModel: cheap })]);

  // Inherit: the first row is the inherit row and it is what is in effect.
  const inheritRows = modelRows(inheriting, kindTab("executor"));
  assert.ok(inheritRows[0]?.label.includes("继承主会话模型"));
  assert.equal(inheritRows[0]?.current, true);
  assert.equal(inheritRows[1]?.current, false);

  // Pinned: no row is marked current by string match on `p/cheap` alone — the kind's
  // resolved model is what the page marks, so a bare id or a `:level` suffix still
  // marks the right row.
  const pinnedRows = modelRows(pinned, kindTab("executor"));
  assert.equal(pinnedRows[0]?.current, false, "the inherit row is not in effect");
  assert.equal(pinnedRows.find((row) => row.model?.id === "cheap")?.current, true);
  assert.equal(pinnedRows.find((row) => row.model?.id === "strong")?.current, false);
  const bareId = modelRows(
    snapshot([kindEntry("executor", "执行者", { model: "cheap:high", effectiveModel: cheap })]),
    kindTab("executor"),
  );
  assert.equal(bareId.find((row) => row.model?.id === "cheap")?.current, true, "a bare id with a :level still matches");

  // Thinking levels: the kind's own model's levels when it pins one, the inherited
  // (session) model's when it does not.
  const inheritingLevels = thinkingRows(inheriting, kindTab("executor")).map((row) => row.label);
  assert.ok(inheritingLevels.includes("xhigh"), "the session model's levels are offered while inheriting");
  const pinnedLevels = thinkingRows(pinned, kindTab("executor"));
  assert.deepEqual(pinnedLevels.map((row) => row.label), [
    "(默认 / 继承主会话思考)",
    "off",
  ], "a non-reasoning model offers only `off`");
  // The thinking level is independent of the model: pinning one does not pin the other.
  assert.equal(pinnedLevels[0]?.current, true, "thinking is still inherited here");
  // The default page is unchanged by any of this: it keeps its own scope's levels,
  // with its own inherit row first.
  assert.deepEqual(
    thinkingRows(inheriting, "subagent").map((row) => row.label),
    ["(默认 / 继承主会话思考)", ...thinkingRows(inheriting, "session").map((row) => row.label)],
  );
});

// ── 3. the real panel, the real config, the real owner ───────────────

interface Loaded {
  commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
  /**
   * The **real** control surface of the extension runtime this test loaded.
   *
   * Same module instance as the one whose `/Comodels` command was registered (the
   * import URL is shared), so `agentKinds()` here is what the panel's snapshot is built
   * from. That is what makes "the page list equals what the control resolves" a
   * statement about the source rather than about a hand-built fixture.
   */
  control: ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  /**
   * The runtime hooks the extension registered, so a test can fire one the way the host would.
   *
   * Hot reload is decided inside the `tool_call` gate, so proving it means firing that hook — not
   * calling a helper the gate happens to use.
   */
  handlers: { toolCall(event: { toolName: string; input: unknown }): Promise<unknown> };
  close(): void;
}

const KIND_MODULES = ["agent-kinds", "lane-worktree", "panel", "subagents", "subagent-context"];

function writeProject(
  root: string,
  kinds: Record<string, { enabled?: boolean; model?: string; thinking?: string }>,
  modules: Record<string, boolean> = Object.fromEntries(KIND_MODULES.map((id) => [id, true])),
): void {
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "Coworkflow.json"),
    JSON.stringify({
      version: 1,
      autoEnable: true,
      modules,
      agentKinds: kinds,
    }, null, 2),
  );
}

/** The real extension in a temp project, so `/Comodels` is the production command. */
async function loadExtension(root: string, events: FakePi["events"]): Promise<Loaded> {
  const saved = process.cwd();
  process.chdir(root);
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SESSION_ID;
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const toolCallHandlers: ((event: unknown) => unknown)[] = [];
  const host = {
    events,
    on: (event: string, handler: (payload: unknown) => unknown) => {
      if (event === "tool_call") toolCallHandlers.push(handler);
      return () => {};
    },
    registerCommand: (name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) => {
      commands.set(name, spec);
    },
    sendMessage: () => {},
    getThinkingLevel: () => "medium",
    getSessionName: () => undefined,
  };
  const url = `${here("../extensions/coworkflow.ts")}?panel-${Date.now()}-${Math.random()}`;
  const loaded = (await import(url)) as {
    default: (h: unknown) => void;
    controlSurface(): ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  };
  loaded.default(host);
  return {
    commands,
    control: loaded.controlSurface(),
    handlers: {
      /** Fire the gate the way the host does, for every registered listener. */
      async toolCall(event) {
        for (const handler of toolCallHandlers) await handler(event);
      },
    },
    close() { process.chdir(saved); },
  };
}

/** Open `/Comodels` and hand back the panel the command constructed. */
async function openPanel(
  loaded: Loaded,
  root: string,
  /** The models this session is scoped to; the default pair is what most cases use. */
  scopedModels: { model: Record<string, unknown> }[] = [
    // The shape Pi hands the panel: the model object itself, whose own `reasoning`
    // flag decides which thinking levels a page offers.
    { model: { provider: "p", id: "strong", name: "Strong" } },
    { model: { provider: "p", id: "cheap", name: "Cheap", reasoning: false } },
  ],
): Promise<ModelPanel> {
  let panel: ModelPanel | undefined;
  const commandCtx = {
    cwd: root,
    mode: "tui",
    model: { provider: "p", id: "strong", name: "Strong" },
    thinkingLevel: "medium",
    scopedModels,
    sessionManager: { getSessionId: () => "session-panel", getEntries: () => [] },
    ui: {
      notify: () => {},
      custom(factory: any) {
        panel = factory({ requestRender: () => {} }, { fg: (_: string, text: string) => text }, undefined, () => {}) as ModelPanel;
      },
    },
  };
  const command = loaded.commands.get("Comodels");
  assert.ok(command, "/Comodels is registered");
  await command.handler("", commandCtx);
  assert.ok(panel, "the command opened a panel");
  return panel;
}

/** Poll until `check` holds: applying a model awaits a re-registration. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 600; tick += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function storedKind(root: string, kind: string): Record<string, unknown> | undefined {
  const entry = readConfig(root)?.agentKinds?.[kind];
  return entry === undefined ? undefined : { ...entry };
}

test("Comodels: a page per kind, applying writes the config and re-registers that agent, clearing inherits again", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-"));
  let loaded: Loaded | undefined;
  try {
    writeProject(root, { auditor: { enabled: true } });
    loaded = await loadExtension(root, pi.events);
    // Registration is asynchronous; the panel exists regardless.
    await until(() => registeredModel(pi, "cw-executor") === undefined &&
      (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");

    const panel = await openPanel(loaded, root);

    // 主会话 + 子 agent（默认） + one page per kind, from the registry, in table order.
    assert.deepEqual(panel.pages().map((page) => page.label), [
      "主会话",
      "子 agent（默认）",
      "执行者 cw-executor",
      "审计者 cw-auditor",
      "调研者 cw-researcher",
    ]);
    assert.equal(panel.currentTab(), "session");

    // Tab walks the computed list; three presses land on the auditor's own page.
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "subagent");
    panel.handleInput("\t");
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "kind:auditor");
    assert.match(panel.render(160).join("\n"), /\[审计者 cw-auditor\]/);

    // Inheriting: the inherit row is what is in effect, and the thinking column
    // offers the inherited model's levels.
    assert.ok(panel.currentRows()[0]?.label.includes("继承主会话模型"));
    assert.equal(panel.currentRows()[0]?.current, true);
    assert.match(panel.render(160).join("\n"), /xhigh/);
    assert.equal(registeredModel(pi, "cw-auditor"), undefined);

    // Pick the non-reasoning model: the config is written *and* the registered agent
    // now carries that model.
    panel.handleInput("\x1b[B"); // inherit → p/strong
    panel.handleInput("\x1b[B"); // p/strong → p/cheap
    panel.handleInput("\r");
    await until(() => registeredModel(pi, "cw-auditor") === "p/cheap", "cw-auditor to re-register with the new model");
    assert.equal(storedKind(root, "auditor")?.model, "p/cheap");
    // Only that kind: no cross-talk between pages.
    assert.equal(storedKind(root, "executor")?.model, undefined);
    assert.equal(registeredModel(pi, "cw-executor"), undefined);

    // The page now reports a pinned model, and its thinking levels are that model's.
    let rendered = panel.render(160).join("\n");
    assert.match(rendered, /模型 p\/cheap/, "the status line reports what the writer did");
    assert.doesNotMatch(rendered, /xhigh/, "a non-reasoning model does not offer xhigh");
    assert.match(rendered, /off/);
    assert.equal(panel.currentRows().find((row) => row.model?.id === "cheap")?.current, true);

    // Clearing goes back to inherit: the key is deleted and the registration drops it.
    panel.handleInput("\x1b[A");
    panel.handleInput("\x1b[A");
    assert.ok(panel.currentRows()[0]?.label.includes("继承主会话模型"));
    panel.handleInput("\r");
    await until(() => registeredModel(pi, "cw-auditor") === undefined, "cw-auditor to go back to inheriting");
    assert.equal("model" in (storedKind(root, "auditor") ?? {}), false, "null deletes the key");
    rendered = panel.render(160).join("\n");
    assert.match(rendered, /继承/, "the page says it inherits again");
    assert.match(rendered, /xhigh/, "and offers the inherited model's levels again");

    // The default page keeps writing `subagents.*` for agents that are not kinds.
    panel.handleInput("\t"); // kind:auditor → kind:researcher
    panel.handleInput("\t"); // → session
    panel.handleInput("\t"); // → subagent
    assert.equal(panel.currentTab(), "subagent");
    panel.handleInput("\x1b[B"); // 继承 → p/strong
    panel.handleInput("\r");
    await until(() => existsSync(join(root, ".pi", "settings.json")), "the project settings write");
    const settings = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf-8")) as {
      subagents?: { defaultModel?: string; defaultProvider?: string };
    };
    assert.equal(settings.subagents?.defaultModel, "strong");
    assert.equal(settings.subagents?.defaultProvider, "p");
    assert.equal(storedKind(root, "executor")?.model, undefined, "the default page writes no kind");
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Comodels: a disabled kind keeps its page and keeps the model it had stored", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-off-"));
  let loaded: Loaded | undefined;
  try {
    writeProject(root, { researcher: { enabled: false, model: "p/cheap" } });
    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    const panel = await openPanel(loaded, root);

    const page = panel.pages().find((entry) => entry.tab === kindTab("researcher"));
    assert.ok(page, "a disabled kind still has a page");
    assert.equal(page.note, "已关闭");

    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "kind:researcher");
    const rendered = panel.render(160).join("\n");
    assert.match(rendered, /已关闭/, "the page says the kind is off");
    assert.match(rendered, /p\/cheap/, "and still shows the model it would apply");
    // The stored model is not silently dropped just because the kind is off.
    assert.equal(storedKind(root, "researcher")?.model, "p/cheap");
    assert.equal(registeredModel(pi, "cw-researcher"), undefined, "a disabled kind is not registered");
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. the page list IS what the control surface resolves ────────────

test("Comodels: the page list equals what control.agentKinds() resolves, and a disabled kind keeps its page", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-source-"));
  let loaded: Loaded | undefined;
  try {
    // Three kinds declared, one of them off, plus a kind this package does not ship.
    // The unshipped one is preserved in the config but has no asset behind it, so it
    // gets no page — the status line is where it is reported.
    writeProject(root, {
      executor: { enabled: true },
      auditor: { enabled: true },
      researcher: { enabled: false, model: "p/cheap" },
      reviewer: { enabled: true },
    });
    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    const panel = await openPanel(loaded, root);

    // The source, not a snapshot: the pages are exactly the registry's kinds, in the
    // registry's order, with the two scopes in front. A hand-built list in the panel
    // would drift from this the moment the shipped table changed.
    const resolved = loaded.control.agentKinds();
    assert.deepEqual(panel.pages().map((page) => page.tab), [
      "session",
      "subagent",
      ...resolved.map((entry) => kindTab(entry.kind)),
    ]);
    assert.deepEqual(panel.pages().map((page) => page.label), [
      "主会话",
      "子 agent（默认）",
      ...resolved.map((entry) => `${entry.label} ${entry.agent}`),
    ]);
    // The declared-but-unshipped kind keeps no page, and the panel never invents one.
    assert.equal(panel.pages().some((page) => page.label.includes("reviewer")), false);
    assert.equal(resolved.some((entry) => entry.kind === "reviewer"), false);

    // A disabled kind keeps its page and says it is off, while an enabled one does not.
    const off = panel.pages().find((page) => page.tab === kindTab("researcher"));
    assert.equal(off?.note, "已关闭");
    assert.equal(panel.pages().find((page) => page.tab === kindTab("executor"))?.note, undefined);
    // And the stored model of the disabled kind is still what its page reports.
    assert.equal(resolved.find((entry) => entry.kind === "researcher")?.model, "p/cheap");

    // Removing the declared policy does not remove a *shipped* kind's page: the page
    // exists because this package ships an agent for it, not because the config named
    // it. The panel and the control surface agree about that, which is the invariant.
    const withoutPolicy = JSON.parse(readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8")) as {
      agentKinds?: Record<string, unknown>;
    };
    delete withoutPolicy.agentKinds;
    writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify(withoutPolicy, null, 2));
    assert.deepEqual(
      loaded.control.agentKinds().map((entry) => kindTab(entry.kind)),
      resolved.map((entry) => kindTab(entry.kind)),
      "the shipped table, not the config block, decides which kinds exist",
    );
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. Enter without moving must write back what was already stored ───

/**
 * The B1 reproductions.
 *
 * Both cases put a kind's stored pin somewhere the panel's `Enter` could previously
 * overwrite it: the cursor seeded on a row that was not the pin, and one press wrote a
 * model the user never chose. The assertion is on the *config on disk* and the owner's
 * registry, because "the panel thinks it did not change" is not the same fact.
 */
test("Comodels: Enter with the cursor untouched writes back the stored pin, never the inherited model", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-pin-"));
  let loaded: Loaded | undefined;
  try {
    // A pin outside this session's `scopedModels` — the ordinary case for a kind pinned
    // to a model the user is not currently on.
    writeProject(root, { auditor: { enabled: true, model: "anthropic/claude-opus-4" } });
    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    const panel = await openPanel(loaded, root);

    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "kind:auditor");

    // Exactly one row is current and it is the stored pin's own row, so the cursor
    // seeds on the pin rather than on the inherit row or the inherited model.
    const rows = panel.currentRows();
    assert.equal(rows.filter((row) => row.current).length, 1, "no double-marked rows");
    assert.equal(rows[0]?.current, false, "the inherit row is not in effect");
    assert.equal(rows[1]?.current, true);
    assert.equal(rows[1]?.model?.ref, "anthropic/claude-opus-4");
    assert.match(panel.render(160).join("\n"), /不在当前模型注册表中/);

    // Enter without moving: the id is not in the registry, so nothing is written — and
    // crucially the inherited model is not written over the pin.
    panel.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(storedKind(root, "auditor")?.model, "anthropic/claude-opus-4", "the pin is untouched");
    assert.equal(registeredModel(pi, "cw-auditor"), "anthropic/claude-opus-4");
    assert.match(panel.render(160).join("\n"), /不在当前模型注册表中，未写入/);

    // The inherit row still clears it: L1 must not lock a user out of going back. The
    // row below the pin is the inherit row, and Enter on it deletes the key (asserted
    // below) — that is what proves the cursor moved there.
    assert.ok(panel.currentRows()[0]?.label.includes("继承主会话模型"), "the inherit row is the first row");
    panel.handleInput("\x1b[A");
    panel.handleInput("\r");
    await until(() => registeredModel(pi, "cw-auditor") === undefined, "cw-auditor to go back to inheriting");
    assert.equal("model" in (storedKind(root, "auditor") ?? {}), false);
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Comodels: a pin whose id carries a non-level colon suffix resolves and survives Enter untouched", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-tag-"));
  let loaded: Loaded | undefined;
  try {
    // `ollama/llama3:latest` — the colon is part of the model id, not a thinking level.
    // Stripping any `:word` used to turn this into `ollama/llama3`, which resolved to
    // nothing and then presented the inherited model as the kind's own.
    writeProject(root, { auditor: { enabled: true, model: "ollama/llama3:latest" } });
    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    const panel = await openPanel(loaded, root, [
      { model: { provider: "p", id: "strong", name: "Strong" } },
      { model: { provider: "p", id: "cheap", name: "Cheap", reasoning: false } },
      { model: { provider: "ollama", id: "llama3:latest", name: "Llama 3", reasoning: false } },
    ]);

    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "kind:auditor");

    const rows = panel.currentRows();
    assert.equal(rows.filter((row) => row.current).length, 1, "exactly one row is current");
    assert.equal(rows.find((row) => row.current)?.model?.id, "llama3:latest", "the pin's own row is current");
    assert.equal(rows.find((row) => row.model?.id === "strong")?.current, false, "the inherited model is not marked");
    // The header says it is pinned, and does not claim it is missing from the registry.
    const rendered = panel.render(160).join("\n");
    assert.match(rendered, /固定 ollama\/llama3:latest/);
    assert.doesNotMatch(rendered, /不在当前模型注册表中/);

    // Enter without moving writes back the same string — the tag is not normalised away.
    panel.handleInput("\r");
    await until(() => registeredModel(pi, "cw-auditor") === "ollama/llama3:latest", "cw-auditor to keep its pin");
    assert.equal(storedKind(root, "auditor")?.model, "ollama/llama3:latest", "the stored string is unchanged");
    // Its thinking levels follow its own model (a non-reasoning one), not the session's.
    assert.doesNotMatch(panel.render(160).join("\n"), /xhigh/);
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. the layer being off, and an unknown model id ──────────────────

test("Comodels: with agent-kinds off the kind pages say nothing is registered, and an unknown model is refused", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-layer-"));
  let loaded: Loaded | undefined;
  try {
    writeProject(
      root,
      { auditor: { enabled: true } },
      Object.fromEntries(KIND_MODULES.map((id) => [id, id !== "agent-kinds"])),
    );
    loaded = await loadExtension(root, pi.events);
    const panel = await openPanel(loaded, root);

    // The pages still exist (the panel is always available), but nothing is registered,
    // and each kind page says that instead of accepting a write that reads as applied.
    const pages = panel.pages();
    assert.equal(pages.some((page) => page.tab === kindTab("auditor")), true);
    assert.equal(pages.find((page) => page.tab === kindTab("auditor"))?.note, "本会话未启用");
    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "kind:auditor");
    const rendered = panel.render(160).join("\n");
    assert.match(rendered, /本会话未启用 agent-kinds，未注册任何 kind/);
    // A kind page writes `.pi/Coworkflow.json`; naming the subagents settings file here
    // would send the user to a file that never receives this setting.
    assert.match(rendered, /\.pi\/Coworkflow\.json · agentKinds\.auditor/);
    assert.doesNotMatch(rendered, /\.pi\/settings\.json/);
    assert.equal((registryView?.listRuntimeAgentConfigs(pi).length ?? 0), 0, "nothing registered with the layer off");

    // An unknown-but-well-formed id is refused **by the panel**, with the id named, and
    // the config is not touched: an unresolvable id would only fail the kind at launch.
    // The path a user actually reaches is a stored pin the session's registry lacks —
    // the panel holds the registry, so it is the layer that can say no before writing.
    await loaded.control.setAgentKind("auditor", { model: "typo/does-not-exist" });
    const before = readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8");
    const reopened = await openPanel(loaded, root);
    reopened.handleInput("\t");
    reopened.handleInput("\t");
    reopened.handleInput("\t");
    assert.equal(reopened.currentTab(), "kind:auditor");
    assert.equal(reopened.currentRows().filter((row) => row.current).length, 1);
    reopened.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.match(reopened.render(160).join("\n"), /typo\/does-not-exist 不在当前模型注册表中，未写入/);
    assert.equal(readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8"), before, "the config is untouched");
    assert.equal((registryView?.listRuntimeAgentConfigs(pi).length ?? 0), 0, "and nothing was registered");
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * An untouched `Enter` must not delete a stored thinking level it cannot offer.
 *
 * The model column got this treatment first; the thinking column did not, and the same
 * data loss was reachable in two ordinary steps: set a level while the kind inherits (the
 * generic set offers it), then pin a model whose own set does not — the level then has no
 * row, nothing is current, the cursor seeds on the inherit row, and one `Enter` deletes it.
 */
test("Comodels: an untouched Enter on the thinking column keeps a level the page cannot offer", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-level-"));
  let loaded: Loaded | undefined;
  try {
    // The second scoped model is `reasoning: false`, so its own set is `[off]` — exactly
    // the page state that made the stored level unreachable.
    writeProject(root, { auditor: { enabled: true, model: "p/cheap", thinking: "high" } });
    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    const panel = await openPanel(loaded, root);

    panel.handleInput("\t");
    panel.handleInput("\t");
    panel.handleInput("\t");
    assert.equal(panel.currentTab(), "kind:auditor");
    panel.handleInput("\x1b[C"); // into the thinking column

    // The stored level keeps a row of its own and is the only current one, so the cursor
    // seeds on the value the project stored rather than on the inherit row.
    const levels = panel.currentRows();
    assert.equal(levels.filter((row) => row.current).length, 1, "no double-marked rows");
    assert.equal(levels[0]?.current, false, "the inherit row is not in effect");
    assert.equal(levels[1]?.current, true);
    assert.equal(levels[1]?.thinking, "high");

    panel.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(storedKind(root, "auditor")?.thinking, "high", "the stored level is untouched");

    // And the inherit row still clears it, so the fix does not lock the user out.
    panel.handleInput("\x1b[A");
    panel.handleInput("\r");
    await until(() => storedKind(root, "auditor")?.thinking === undefined, "the level to be cleared");
    assert.equal("thinking" in (storedKind(root, "auditor") ?? {}), false);
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A project-defined kind gets its own page.
 *
 * This is the whole point of the port from the panel's side: the page list is computed from the
 * resolved kind table, so a definition file adds a page with no panel change — and the panel holds
 * no kind list of its own.
 */
test("Comodels: a project-defined kind gets its own page, and removing the file removes it", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-panel-port-"));
  let loaded: Loaded | undefined;
  try {
    writeProject(root, {});
    mkdirSync(join(root, ".pi", "Coworkflow", "agents"), { recursive: true });
    const file = join(root, ".pi", "Coworkflow", "agents", "builder.md");
    writeFileSync(file, "---\nlabel: 建造者\nrole: implement\n---\n\n按派单实现一处改动。\n");

    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    const panel = await openPanel(loaded, root);

    const pages = panel.pages().map((page) => page.label);
    assert.ok(
      pages.some((page) => page.includes("建造者")),
      `the definition's kind has a page: ${pages.join(" | ")}`,
    );
    // The owner holds the agent the definition names. (Its prompt is asserted in
    // scripts/kind-port.test.ts against the registration plan; this suite is about the panel.)
    assert.ok(
      registryView?.listRuntimeAgentConfigs(pi).some((entry) => entry.name === "cw-builder"),
      "and the owner holds the agent",
    );

    // Removing the file removes the page and the agent.
    rmSync(file);
    await loaded.control.settleAgentKinds();
    assert.equal(
      registryView?.listRuntimeAgentConfigs(pi).some((entry) => entry.name === "cw-builder"),
      false,
      "the agent is withdrawn with its definition",
    );
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Hot reload: a definition edited on disk under a live session takes effect on the next dispatch.
 *
 * The interesting case is an edit made by something *other* than this package — an editor, another
 * program, the CLI in another process. Before this, the prompt in the owner's registration only
 * caught up on `/reload`, while the gate read the new policy immediately: the two halves of one kind
 * would disagree, and the dispatch would start a child with the old instructions.
 */
test("kinds: editing a definition file hot-reloads into the next dispatch, with no reload", { skip }, async () => {
  const { pi, listener } = fakePi();
  const root = mkdtempSync(join(tmpdir(), "coworkflow-hot-reload-"));
  let loaded: Loaded | undefined;
  try {
    writeProject(root, {});
    mkdirSync(join(root, ".pi", "Coworkflow", "agents"), { recursive: true });
    const file = join(root, ".pi", "Coworkflow", "agents", "builder.md");
    // `model` is the field this harness can read back off the owner's registry, so it is what proves
    // the *registration* caught up. The prompt travels the identical path.
    const definition = (prompt: string, model?: string): string =>
      [
        "---",
        "label: 建造者",
        "role: implement",
        ...(model === undefined ? [] : [`model: ${model}`]),
        "---",
        "",
        prompt,
        "",
      ].join("\n");
    writeFileSync(file, definition("第一版提示词。"));
    loaded = await loadExtension(root, pi.events);
    await until(() => (registryView?.listRuntimeAgentConfigs(pi).length ?? 0) > 0, "the kinds to register");
    assert.equal(registeredModel(pi, "cw-builder"), undefined, "it starts inheriting");

    // Somebody edits the file with an editor while the session is live. No command, no reload.
    writeFileSync(file, definition("第二版提示词，完全换掉。", "p/from-edit"));

    // A kind dispatch is what reaches the gate: it compares the plan on disk with the plan the owner
    // holds, and reconciles before deciding. Firing a non-kind tool call would return from the gate
    // earlier and prove nothing, which is why this is a `cw-builder` dispatch.
    await loaded.handlers.toolCall({ toolName: "subagent", input: { agent: "cw-builder", task: "x" } });

    assert.equal(
      registeredModel(pi, "cw-builder"),
      "p/from-edit",
      "the edit is in the owner's registration before the dispatch it was about to decide",
    );
    assert.equal(
      registryView?.listRuntimeAgentConfigs(pi).filter((entry) => entry.name === "cw-builder").length,
      1,
      "and reconciling did not duplicate the agent",
    );

    // Deleting the file withdraws the agent the same way — the other direction of the same fact.
    rmSync(file);
    await loaded.handlers.toolCall({ toolName: "subagent", input: { agent: "cw-builder", task: "x" } });
    assert.equal(
      registryView?.listRuntimeAgentConfigs(pi).some((entry) => entry.name === "cw-builder"),
      false,
      "a deleted definition is withdrawn without a reload",
    );
  } finally {
    registryView?.clearRuntimeAgentsForPi(pi);
    listener();
    loaded?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
