/**
 * The built-in kind table: which kinds this package ships, and what each one
 * defaults to.
 *
 * A kind is not a new execution path. It is a *name* the installed pi-subagents
 * owner registers as an agent, plus two project policies (enabled, max concurrent)
 * that this package enforces. Everything about how the child runs — model,
 * context, async, limits — stays the owner's business, so nothing here declares
 * a runner, a model, or a concurrency mechanism.
 *
 * Two things are deliberately data and not code:
 *
 *   - the system prompt of each kind is an asset file next to this module, so a
 *     project can edit what "executor" means without touching TypeScript;
 *   - the built-in default (`executor` on, `auditor` off) is a table entry, so
 *     the panel, the gate and the status report all read the same values instead
 *     of each carrying a copy.
 *
 * The role field is the bridge to the role-scoped Trellis context: a kind maps
 * onto the existing `implement` / `check` roles so `subagent-context` keeps one
 * injection path rather than gaining a second one keyed on kind.
 */

import { moduleAsset } from "../../core/module.ts";
import { KIND_PREFIX, type AgentKindConfig, type ResolvedAgentKind, type WorkflowConfig } from "../../core/config.ts";
import type { SubagentRole } from "../../core/trellis.ts";

/** One kind this package ships. */
export interface BuiltinKind {
  /** The project-facing name, as it appears in `agentKinds`. */
  kind: string;
  /** How the panel and the status report name it to the user. */
  label: string;
  /** The Trellis role its context comes from. */
  role: SubagentRole;
  /** What the owner shows in the agent list. */
  description: string;
  /** Asset holding the system prompt, relative to this module. */
  asset: string;
  /** Policy for a project that declares nothing about this kind. */
  defaults: Required<AgentKindConfig>;
}

/**
 * The kinds this package ships — one per Trellis role, so a project that adopts
 * kinds no longer needs the `trellis-*` role agents at all.
 *
 * `executor` is on by default because it is the one that replaces what a project
 * already does by hand; `auditor` and `researcher` are off because they are the
 * kinds that can *refuse* their own scope or spend unbounded time, and a project
 * must opt into them rather than discover one.
 */
export const BUILTIN_KINDS: readonly BuiltinKind[] = [
  {
    kind: "executor",
    label: "执行者",
    role: "implement",
    description: "Coworkflow 执行者：按派单做完一件已定义的工作并报告事实",
    asset: "./assets/executor.md",
    defaults: { enabled: true, maxConcurrent: 3 },
  },
  {
    kind: "auditor",
    label: "审计者",
    role: "check",
    description: "Coworkflow 审计者：只读复核一处改动，给出可复现的阻断项",
    asset: "./assets/auditor.md",
    defaults: { enabled: false, maxConcurrent: 1 },
  },
  {
    kind: "researcher",
    label: "调研者",
    role: "research",
    description: "Coworkflow 调研者：查清一个问题并给出有出处、可复现的答案",
    asset: "./assets/researcher.md",
    defaults: { enabled: false, maxConcurrent: 2 },
  },
];

/** The registered agent name for a kind, prefixed so it cannot collide with a builtin. */
export function agentNameFor(kind: string): string {
  return kind.startsWith(KIND_PREFIX) ? kind : `${KIND_PREFIX}${kind}`;
}

/** The kind a registered agent name belongs to, or `null` for any other agent. */
export function kindOf(agent: string | undefined): string | null {
  if (!agent?.startsWith(KIND_PREFIX)) return null;
  const kind = agent.slice(KIND_PREFIX.length);
  return kind && builtinKind(kind) !== null ? kind : null;
}

export function builtinKind(kind: string): BuiltinKind | null {
  return BUILTIN_KINDS.find((entry) => entry.kind === kind) ?? null;
}

/**
 * The Trellis role a kind's children are given, or `null` for a kind this package
 * does not ship.
 *
 * This is the *only* kind→role mapping: `subagent-context` reads it here instead
 * of keeping a second table keyed on the agent name, which is what would let the
 * two disagree about what `cw-executor` receives.
 */
export function kindRole(kind: string): SubagentRole | null {
  return builtinKind(kind)?.role ?? null;
}

/** Every agent name this package may register, whatever the project enabled. */
export function builtinAgentNames(): string[] {
  return BUILTIN_KINDS.map((entry) => agentNameFor(entry.kind));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The project's kind policy with every default applied, in table order.
 *
 * Absent config, an absent kind key, and an unreadable field all fall back to the
 * built-in default — the same rule `/Coworkflow:init` uses for module switches,
 * and for the same reason: a value that cannot be read is not a decision.
 */
export function resolveKinds(config: WorkflowConfig | null): ResolvedAgentKind[] {
  const declared = config?.agentKinds ?? {};
  return BUILTIN_KINDS.map((entry) => {
    const policy = declared[entry.kind];
    return {
      kind: entry.kind,
      label: entry.label,
      agent: agentNameFor(entry.kind),
      enabled: policy?.enabled ?? entry.defaults.enabled,
      maxConcurrent: positiveInteger(policy?.maxConcurrent) ?? entry.defaults.maxConcurrent,
    };
  });
}

/**
 * Kinds the project declared that this package has no agent for.
 *
 * They are preserved in the config rather than dropped — the project wrote them —
 * but they are never registered and never counted as available. Reported so the
 * panel and `/Coworkflow:status` can say "declared, not shipped" instead of
 * silently omitting a decision the user made.
 */
export function unshippedKinds(config: WorkflowConfig | null): string[] {
  return Object.keys(config?.agentKinds ?? {}).filter((kind) => builtinKind(kind) === null);
}

/** The kind's system prompt, or `null` when the asset is missing from the package. */
export function kindSystemPrompt(moduleUrl: string, kind: string): string | null {
  const entry = builtinKind(kind);
  if (entry === null) return null;
  const text = moduleAsset(moduleUrl, entry.asset)?.trim();
  return text ? text : null;
}
