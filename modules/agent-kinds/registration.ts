/**
 * The runtime-agent contract of the installed `pi-subagents`.
 *
 * A kind becomes real by being *registered*, at which point the main session's
 * agent list genuinely contains `cw-<kind>` and routing to it is an ordinary
 * `subagent({ agent: "cw-executor", … })` call. This file owns that one
 * conversation with the owner and nothing else: no gate, no panel, no gate policy.
 *
 * ## Which mechanism, and why
 *
 * The owner documents two doors to the same registration:
 *
 *   1. the process-local event `pi-subagents:runtime-agent-register:v1`, wrapped
 *      as `registerAgentViaEvents()` in its public `./agents` export;
 *   2. `registerRuntimeAgent()` from the same export, called directly.
 *
 * This uses **(1)**, and the reason is the one requirement that a gate must never
 * fake: whether the owner is actually running. A direct call writes into a global
 * registry whether or not any pi-subagents extension is loaded in this process. If
 * none is, the entry is inert — no agent list exists to merge it into — while this
 * package would happily report the kind as available and then refuse nothing,
 * because nothing ever dispatches it. The event has the owner write the reply
 * itself, so *no listener* is a fact we can report: "pi-subagents is not loaded"
 * rather than "registered".
 *
 * The import exists only to read the constant and the wrapper, not to run the
 * owner: `./agents` is the same small documented subpath the workflow resource
 * uses, and it is resolved from the *installed* package directory (see
 * `loadSubagentsExport`), so a second runtime is never loaded.
 *
 * ## What the owner validates
 *
 * Names must avoid its builtin table (`worker`, `reviewer`, `delegate`, …) and
 * must be unique among runtime agents; that is why every kind is `cw-` prefixed
 * (`KIND_PREFIX`). A collision is the owner's error and it is reported as this
 * kind's failure — one bad kind never prevents the others from registering.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionEvents } from "../../core/module.ts";
import { agentDir } from "../../core/agentdir.ts";
import { loadSubagentsExport } from "../../core/subagents-workflow.ts";

/** The owner's registration definition, reduced to what a kind needs. */
export interface KindDefinition {
  description: string;
  systemPrompt: string;
  inheritProjectContext?: boolean;
  tools?: readonly string[];
  /**
   * The model this agent runs on: `provider/id`, a bare id, or either with a
   * trailing `:level`.
   *
   * Part of the definition rather than a launch argument on purpose: a kind is
   * runtime-*registered*, so the definition is what every dispatch of that kind
   * uses — including a hand-written `subagent({ agent: "cw-executor" })` that this
   * package never sees. A launch-level model would only cover dispatches this
   * package makes.
   */
  model?: string;
  /** The thinking level this agent runs at; absent means inherit. */
  thinking?: string;
}

export interface Disposable {
  dispose(): void;
}

/** What the installed owner actually offers. */
export interface RuntimeAgentContract {
  /** The documented event name, for diagnostics. */
  event: string;
  /** Register one agent; throws the owner's own error on a collision. */
  register(name: string, definition: KindDefinition): Disposable;
}

export type ContractOutcome =
  | { ok: true; contract: RuntimeAgentContract }
  | { ok: false; reason: string };

/** The subset of the owner's `./agents` module this package depends on. */
interface AgentsModule {
  RUNTIME_AGENT_REGISTER_EVENT?: unknown;
  registerAgentViaEvents?: (input: {
    pi: { events: ExtensionEvents };
    name: string;
    definition: KindDefinition;
  }) => Disposable;
}

const DOCUMENTED_EVENT = "pi-subagents:runtime-agent-register:v1";

/**
 * Directories the owner scans for *configured* agents, most local first.
 *
 * Kept in step with the owner's documented discovery order (project `.pi/agents`
 * and `.agents` walking upward, then the user directories). Only the existence of
 * a *name* matters here, not its contents, so this reads frontmatter and file
 * basenames and nothing else.
 */
function configuredAgentRoots(cwd: string, agentDir: string): string[] {
  const roots: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    roots.push(join(current, ".pi", "agents"), join(current, ".agents"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.push(join(agentDir, "agents"), join(homedir(), ".agents"));
  return roots;
}

/** Every configured agent name this kind would collide with, or `[]`. */
function configuredCollision(name: string, cwd: string, agentDir: string): string | null {
  for (const root of configuredAgentRoots(cwd, agentDir)) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const file = join(root, entry);
      const declared = frontmatterName(file);
      const stem = entry.slice(0, -".md".length);
      // A file whose frontmatter names something else still occupies its own
      // basename as an alias in the owner's discovery, so both are checked.
      if (declared === name || stem === name) return file;
    }
  }
  return null;
}

/** The `name:` of a markdown agent's frontmatter, or `null`. */
function frontmatterName(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;
  const line = /^name:\s*(.+)$/m.exec(match[1] ?? "");
  if (line === null) return null;
  const value = (line[1] ?? "").trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : null;
}

/**
 * Load the installed owner's registration contract, or say exactly why not.
 *
 * Every failure here is a string a user can act on, because the alternative —
 * registering nothing and reporting the kinds anyway — is indistinguishable from
 * a working gate until the first dispatch goes through.
 */
export async function loadRuntimeAgentContract(
  options: { events?: ExtensionEvents; projectRoot?: string; cwd?: string; agentDir?: string } = {},
): Promise<ContractOutcome> {
  const events = options.events;
  if (!events) {
    return { ok: false, reason: "宿主没有暴露进程内事件总线（pi.events），无法向 pi-subagents 注册运行时 agent。" };
  }
  const loaded = await loadSubagentsExport<AgentsModule>("./agents", options.projectRoot);
  if (!loaded.ok) return { ok: false, reason: loaded.message };
  const api = loaded.module;
  const register = api.registerAgentViaEvents;
  if (typeof register !== "function") {
    return {
      ok: false,
      reason: "已安装的 pi-subagents 的 ./agents 没有导出 registerAgentViaEvents；请升级 pi-subagents（需要运行时 agent 注册契约）。",
    };
  }
  const event = typeof api.RUNTIME_AGENT_REGISTER_EVENT === "string"
    ? api.RUNTIME_AGENT_REGISTER_EVENT
    : DOCUMENTED_EVENT;
  return {
    ok: true,
    contract: {
      event,
      register: (name, definition) => {
        // The owner validates builtin and runtime collisions at registration time,
        // but a *configured* agent holding the name is only caught later, in its
        // discovery merge — which throws, and that throw is not caught on the
        // dispatch path. One colliding file would therefore break every dispatch in
        // the session, kinds and plain agents alike, while this package happily
        // reported the kind as registered. Refusing here keeps the damage local and
        // the report true.
        const colliding = configuredCollision(name, options.cwd ?? process.cwd(), options.agentDir ?? agentDir());
        if (colliding !== null) {
          throw new Error(
            `已有项目/用户的 agent 占用了名称 ${name}（${colliding}）：pi-subagents 在发现阶段会因此拒绝整个会话的 agent 列表。`,
          );
        }
        return register({ pi: { events }, name, definition });
      },
    },
  };
}

/** One kind registration attempt's outcome. */
export type KindRegistration =
  | { ok: true; kind: string; agent: string }
  | { ok: false; kind: string; agent: string; reason: string };

/**
 * What a reconcile pass wants one kind to look like.
 *
 * The model and thinking level travel inside `definition`, not beside it: the
 * definition is what the owner registers, so a copy here would be a second place for
 * the two to disagree — and the signature that decides "unchanged" is computed from
 * the definition.
 */
export interface DesiredKind {
  kind: string;
  agent: string;
  definition: KindDefinition;
}

/**
 * The one disposable per kind, and the reconcile that keeps it honest.
 *
 * Two invariants, both of which a caller cannot be trusted to get right:
 *
 *   - **dispose before re-registering.** The owner refuses a duplicate name, so a
 *     re-registration that skipped disposal would fail with a collision error on
 *     the *second* toggle — the exact "toggling twice breaks it" bug.
 *   - **an unchanged kind is left alone.** Reconcile compares each kind's
 *     definition; an identical one keeps the live registration instead of
 *     disposing and re-adding it. A toggle that ends where it started therefore
 *     costs nothing at all, and cannot leave a duplicate behind.
 */
export interface KindRegistry {
  /** Bring the registered set in line with `desired`; returns one line per kind. */
  reconcile(contract: RuntimeAgentContract | null, desired: readonly DesiredKind[]): KindRegistration[];
  /** Every kind currently registered, with the agent name it owns. */
  registered(): { kind: string; agent: string }[];
  /** Why a kind failed, as of the last reconcile. */
  failures(): { kind: string; reason: string }[];
  /** Withdraw everything. Idempotent; safe on a shutdown path. */
  dispose(): void;
}

/**
 * The comparison key for "is this kind's live registration still the one we want".
 *
 * Every field that reaches the owner's definition belongs here. A field left out
 * would make a change to it read as "unchanged", so reconcile would keep the live
 * registration and the session would keep running the old value — a panel writing a
 * setting the session does not use, which is exactly the failure this module exists
 * to remove.
 */
function signature(definition: KindDefinition): string {
  return JSON.stringify({
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: definition.tools ?? [],
    model: definition.model ?? null,
    thinking: definition.thinking ?? null,
  });
}

interface Held {
  agent: string;
  signature: string;
  handle: Disposable;
}

export function createKindRegistry(): KindRegistry {
  const held = new Map<string, Held>();
  let failures: { kind: string; reason: string }[] = [];

  const disposeKind = (kind: string): void => {
    const entry = held.get(kind);
    if (entry === undefined) return;
    held.delete(kind);
    try {
      entry.handle.dispose();
    } catch {
      // Disposal is idempotent upstream; a throw must not escape a shutdown path.
    }
  };

  return {
    reconcile(contract, desired) {
      const results: KindRegistration[] = [];
      failures = [];
      if (contract === null) {
        // No contract means nothing may stay registered: a registration from an
        // earlier load cannot be verified, so keeping it would be a kind that
        // reports as available without the owner behind it.
        for (const kind of [...held.keys()]) disposeKind(kind);
        return desired.map((entry) => ({
          ok: false as const,
          kind: entry.kind,
          agent: entry.agent,
          reason: "pi-subagents 的运行时 agent 契约不可用，未注册",
        }));
      }

      const wanted = new Set(desired.map((entry) => entry.kind));
      for (const kind of [...held.keys()]) if (!wanted.has(kind)) disposeKind(kind);

      for (const entry of desired) {
        const next = signature(entry.definition);
        const current = held.get(entry.kind);
        if (current !== undefined && current.signature === next && current.agent === entry.agent) {
          results.push({ ok: true, kind: entry.kind, agent: entry.agent });
          continue;
        }
        // Disposal first, always: the owner rejects a second registration under a
        // name it already holds, which is what a changed definition would be.
        disposeKind(entry.kind);
        try {
          const handle = contract.register(entry.agent, entry.definition);
          held.set(entry.kind, { agent: entry.agent, signature: next, handle });
          results.push({ ok: true, kind: entry.kind, agent: entry.agent });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push({ kind: entry.kind, reason });
          results.push({ ok: false, kind: entry.kind, agent: entry.agent, reason });
        }
      }
      return results;
    },
    registered() {
      return [...held.entries()].map(([kind, entry]) => ({ kind, agent: entry.agent }));
    },
    failures() {
      return [...failures];
    },
    dispose() {
      for (const kind of [...held.keys()]) disposeKind(kind);
      failures = [];
    },
  };
}

/**
 * The registry one runtime host owns.
 *
 * Keyed by the host, not kept in a module variable: a host outlives one session
 * (`/reload` loads a second copy of the module into the same process), and two
 * sessions in one process must never share a registration set — the second one's
 * `dispose()` would withdraw the first one's kinds.
 */
const REGISTRIES = new WeakMap<object, KindRegistry>();

export function kindRegistryFor(host: object): KindRegistry {
  const existing = REGISTRIES.get(host);
  if (existing !== undefined) return existing;
  const created = createKindRegistry();
  REGISTRIES.set(host, created);
  return created;
}

/**
 * Withdraw every kind this host registered. Idempotent, never throws.
 *
 * This is what `onSessionEnd` calls: the owner's registration is process-local and
 * is not scoped to a session by the owner, so a registration that outlives its
 * session would answer for the next one. The registry is kept (not dropped) so the
 * next activation re-registers into the same place instead of leaking a new set.
 */
export function disposeKindRegistrations(host: object): void {
  REGISTRIES.get(host)?.dispose();
}
