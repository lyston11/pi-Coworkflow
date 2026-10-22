/**
 * Project-level workflow config: `.pi/Coworkflow.json`.
 *
 * Two decisions live here, both deliberately per project:
 *
 *   1. **Opt-in.** No file means this project has not adopted the workflow, so
 *      the extension does nothing in it — no install steps, no runtime hooks,
 *      no prompt injection. A project that already has its own workflow design
 *      is unaffected until someone runs `/Coworkflow:init` there.
 *   2. **Per-module switches.** Each module can be enabled or disabled on its
 *      own, so a project can take the Trellis layer without the delegation
 *      policy, or the injection without the lane ledger.
 *
 * The file is meant to be committed: it is project configuration, unlike the
 * lane pointers under `.trellis/.runtime/`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
// The one list of thinking levels this package knows, taken from the module that
// already owns it instead of restated here: a second copy would let the panel offer
// a level this decoder drops, or drop one the panel offers. That module's only
// runtime import is `node:path` (the usage series is a type-only import), so this
// does not drag the usage reader into the config decoder.
import { THINKING_LEVELS, type ThinkingLevelName } from "../modules/panel/shared.ts";

export const CONFIG_REL = join(".pi", "Coworkflow.json");
/** The file name this package used before it was renamed to pi-Coworkflow. */
export const LEGACY_CONFIG_REL = join(".pi", "trellis-workflow.json");

export interface WorkflowConfig {
  version: 1;
  /** ISO timestamp of the last `/Coworkflow:init`. */
  installedAt?: string;
  /** Worktree directory prefix this project installed with. */
  worktreePrefix?: string;
  /**
   * Whether a new session turns the runtime modules on by itself. Absent or
   * false means the project is installed but inert: `/Coworkflow:start` enables
   * it for one session.
   */
  autoEnable?: boolean;
  /**
   * Concurrent async subagent runs this project allows. `undefined` means no
   * project limit, so pi-subagents' own (user-level) setting applies unchanged.
   */
  subagentConcurrency?: number;
  /**
   * Wall-clock budget one dispatched child run gets, in milliseconds.
   *
   * Upstream's backstop is 30 minutes and a child cannot see it, so a run that was making
   * progress gets killed mid-thought — often while writing its own handoff, which makes the
   * work unusable rather than merely unfinished. This is the number the workflows hand to
   * upstream and state in the child's task text. Absent means the built-in default.
   */
  subagentRunBudgetMs?: number;
  /**
   * Module id → enabled. An explicit value here always wins; an absent id is a
   * module added after this map was written, and its own declared
   * `newSwitchDefault` decides (see `resolveSwitch`).
   */
  modules: Record<string, boolean>;
  /**
   * Subagent kind → its project policy. A kind is a named agent definition plus
   * two switches, so this is the only place a project decides which kinds exist
   * and how many of each may run.
   *
   * Absent means the built-in default for that kind. A key naming a kind this
   * package does not ship is **preserved**: the project declared it, and dropping
   * it on the next read would silently delete a decision nobody retracted. That
   * kind has no asset behind it, so it is reported as declared-but-unavailable
   * instead of being registered or quietly ignored.
   */
  agentKinds?: Record<string, AgentKindConfig>;
}

/** One kind's project policy; every field absent means the built-in default. */
export interface AgentKindConfig {
  enabled?: boolean;
  maxConcurrent?: number;
  /**
   * The model this kind's children run on: `provider/id`, a bare id, or either with
   * a trailing `:level`.
   *
   * Absent means *inherit* — the project's `subagents.defaultModel`, then Pi's own
   * default. It lives here rather than in `subagents.agentOverrides` because our
   * kinds are runtime-registered: the definition is the authoritative place, and it
   * applies to every dispatch of the kind, including a hand-written
   * `subagent({ agent: "cw-executor" })` that this package never sees.
   */
  model?: string;
  /**
   * The thinking level this kind's children run at. Absent means inherit, like the
   * model — the two are independent, so a kind may pin a level on an inherited model.
   */
  thinking?: string;
}

export function configPath(root: string): string {
  return join(root, CONFIG_REL);
}

export function legacyConfigPath(root: string): string {
  return join(root, LEGACY_CONFIG_REL);
}

// ── Configuration root, resolved once per session ─────────────────────

/**
 * What one `git` invocation answered.
 *
 * Three cases, not two. "This directory is not in a repository" and "git could
 * not answer" used to be the same `null`, and both fell back to the caller's
 * cwd: the first is a real answer (the config of a project that lives outside a
 * repository is right here), the second must never be mistaken for one, or a
 * transient failure quietly points the config at a worktree and module switches
 * drift with the working directory.
 */
export type GitAnswer =
  | { kind: "ok"; out: string }
  | { kind: "no-repo" }
  | { kind: "failed"; reason: string };

/** The git seam. Injectable so a test needs no real repository. */
export type GitRunner = (cwd: string, args: string[]) => GitAnswer;

/** Where the project's `.pi/Coworkflow.json` is read from. */
export type ConfigRootResolution =
  | { kind: "resolved"; root: string }
  | { kind: "no-repo"; root: string }
  | { kind: "unresolved"; reason: string };

/**
 * A per-runtime cache for the configuration root.
 *
 * Deliberately not process-global: a lane or worktree session has to resolve its
 * own main checkout, and two sessions in one process must not share an answer.
 */
export interface ConfigRootResolver {
  /** Resolution for `cwd`, reused while `cwd` and the session epoch hold. */
  resolve(cwd: string): ConfigRootResolution;
  /** The root to read config from, or `null` when git could not answer. */
  root(cwd: string): string | null;
  /** Drop the memoised answer. */
  invalidate(): void;
}

const firstLine = (text: string): string => (text.split(/\r?\n/)[0] ?? "").trim();

/**
 * Real git. Keeps stderr, which is the only way to tell "no repo" from a failure.
 *
 * `LC_ALL=C` is forced: the classification below reads git's own message, and a
 * translated one ("not a git repository" is localized) would turn the ordinary
 * "this project lives outside a repository" answer into a spurious failure.
 */
const probeGit: GitRunner = (cwd, args) => {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return out ? { kind: "ok", out } : { kind: "failed", reason: `git ${args.join(" ")} 没有输出` };
  } catch (error) {
    const failure = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    if (/not a git repository/i.test(stderr)) return { kind: "no-repo" };
    const message = typeof failure.message === "string" ? failure.message : "git 执行失败";
    return { kind: "failed", reason: firstLine(stderr) || firstLine(message) };
  }
};

/**
 * The checkout whose `.pi/Coworkflow.json` governs `cwd`, or the reason there is
 * none to read.
 *
 * Resolved through the main checkout, so a lane or task worktree — which only
 * carries committed files — still finds the project's config. The common dir is
 * read from the toplevel, and a failure there is reported instead of being
 * treated as "this directory is the main checkout": a linked worktree reading its
 * own committed config would see a different project than its main checkout does.
 */
function resolveConfigRootAt(cwd: string, git: GitRunner): ConfigRootResolution {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.kind === "no-repo") return { kind: "no-repo", root: cwd };
  if (top.kind === "failed") return { kind: "unresolved", reason: top.reason };
  const dir = top.out;
  const absoluteCommon = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = absoluteCommon.kind === "ok" ? absoluteCommon : git(dir, ["rev-parse", "--git-common-dir"]);
  if (common.kind !== "ok") {
    return {
      kind: "unresolved",
      reason: common.kind === "failed" ? common.reason : "git rev-parse --git-common-dir 报告不在仓库内，但 toplevel 已解析",
    };
  }
  const absolute = isAbsolute(common.out) ? common.out : join(dir, common.out);
  return { kind: "resolved", root: basename(absolute) === ".git" ? dirname(absolute) : dir };
}

/**
 * Create the resolver one runtime owns.
 *
 * `epoch` is read live on every call, so the orchestrator's `session_start`
 * increment (and a cwd switch) invalidates the answer without anything having to
 * tell the resolver: it is a key comparison, not an event.
 */
export function createConfigRootResolver(
  options: { epoch?: () => number; runGit?: GitRunner } = {},
): ConfigRootResolver {
  const epochOf = options.epoch ?? (() => 0);
  const git = options.runGit ?? probeGit;
  let memo: { cwd: string; epoch: number; resolution: ConfigRootResolution } | null = null;

  const cached = (cwd: string): ConfigRootResolution => {
    const key = resolvePath(cwd);
    const epoch = epochOf();
    if (memo !== null && memo.cwd === key && memo.epoch === epoch) return memo.resolution;
    const resolution = resolveConfigRootAt(key, git);
    memo = { cwd: key, epoch, resolution };
    return resolution;
  };

  return {
    resolve: cached,
    root(cwd) {
      const resolution = cached(cwd);
      return resolution.kind === "unresolved" ? null : resolution.root;
    },
    invalidate() {
      memo = null;
    },
  };
}

/**
 * One status line for a resolution, or `null` when it is the ordinary case.
 *
 * An unresolvable root is reported, never rendered as "the config is here": that
 * difference is the whole reason the resolver has a third state.
 */
export function configRootNote(resolution: ConfigRootResolution, cwd?: string): string | null {
  switch (resolution.kind) {
    case "unresolved":
      return `配置根无法解析：git 读取失败（${resolution.reason}）——本会话不读取任何项目的 .pi/Coworkflow.json，也不把它当成当前目录`;
    case "no-repo":
      return `配置根：${resolution.root}（不在 git 仓库内，按当前目录读取）`;
    case "resolved":
      return cwd !== undefined && resolvePath(cwd) !== resolution.root
        ? `配置根：${resolution.root}（主 checkout）`
        : null;
  }
}

/**
 * The project's config through a resolver, or `null` when there is none to read.
 *
 * An unresolvable root reads as "no config" — never as "read the current
 * directory instead" — so a transient git failure makes this session inert rather
 * than silently governed by whatever config happens to sit where it was started.
 * `/Coworkflow:status` reports the unresolved state itself.
 */
export function readConfigAt(resolver: ConfigRootResolver, cwd: string): WorkflowConfig | null {
  const root = resolver.root(cwd);
  return root === null ? null : readConfig(root);
}

/** The project's config, or `null` when the project has not opted in. */
export function readConfig(root: string): WorkflowConfig | null {
  // The pre-rename file is read as a fallback so an adopted project keeps its
  // switches until the next run rewrites them under the new name.
  for (const path of [configPath(root), legacyConfigPath(root)]) {
    const raw = tryRead(path);
    if (raw === null) continue;
    const parsed = parseConfig(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function parseConfig(raw: string): WorkflowConfig | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as {
      modules?: unknown;
      worktreePrefix?: unknown;
      installedAt?: unknown;
      autoEnable?: unknown;
      subagentConcurrency?: unknown;
      agentKinds?: unknown;
      subagentRunBudgetMs?: unknown;
    };
    const agentKinds = parseAgentKinds(record.agentKinds);
    const modules: Record<string, boolean> = {};
    if (record.modules !== null && typeof record.modules === "object" && !Array.isArray(record.modules)) {
      for (const [id, value] of Object.entries(record.modules as Record<string, unknown>)) {
        modules[id] = value === true;
      }
    }
    return {
      version: 1,
      ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
      ...(typeof record.worktreePrefix === "string" ? { worktreePrefix: record.worktreePrefix } : {}),
      ...(record.autoEnable === true ? { autoEnable: true } : {}),
      ...(isRunBudget(record.subagentRunBudgetMs) ? { subagentRunBudgetMs: record.subagentRunBudgetMs } : {}),
      ...(typeof record.subagentConcurrency === "number" &&
      Number.isInteger(record.subagentConcurrency) &&
      record.subagentConcurrency > 0
        ? { subagentConcurrency: record.subagentConcurrency }
        : {}),
      modules,
      ...(agentKinds === undefined ? {} : { agentKinds }),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a stored budget is usable.
 *
 * Bounded rather than merely positive: a value below a minute cannot fit even one tool call
 * and a value above a few hours is indistinguishable from "no deadline", and both would be
 * silently accepted by upstream as a real number.
 */
export function isRunBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_RUN_BUDGET_MS && value <= MAX_RUN_BUDGET_MS;
}

export const MIN_RUN_BUDGET_MS = 60_000;
export const MAX_RUN_BUDGET_MS = 4 * 60 * 60 * 1000;

/** `cw-<kind>`: the namespace that keeps a kind away from builtins and project agents. */
export const KIND_PREFIX = "cw-";

/** One kind's policy with every default applied, which is what the gate reads. */
export interface ResolvedAgentKind {
  /** The kind as the project spells it, without the name prefix. */
  kind: string;
  /** How the panel and the reports name it (`执行者`, `审计者`). */
  label: string;
  /** The registered agent name: `cw-<kind>`. */
  agent: string;
  enabled: boolean;
  maxConcurrent: number;
  /**
   * The model this kind pins, or absent for inherit.
   *
   * There is no built-in default to fill in: a kind that declares nothing inherits,
   * and inventing a model here would silently override the project's own
   * `subagents.defaultModel` for one kind.
   */
  model?: string;
  /** The thinking level this kind pins, or absent for inherit. */
  thinking?: string;
}

/**
 * The longest model id this decoder accepts, in characters.
 *
 * Bounded rather than merely non-empty: a model id is a short token (`provider/id`
 * plus an optional `:level`), and a kilobyte of text in that field is a paste
 * accident that upstream would happily store and then fail to launch.
 */
export const MAX_KIND_MODEL_LENGTH = 200;

/** Control characters, NUL included: a model id is a token, not prose. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Whether a stored value is usable as a runtime agent definition's `model`.
 *
 * A stored value that fails here is **dropped, not forwarded**. Upstream validates
 * `model` at registration and refuses the launch, so passing a typo through would
 * take the whole kind down and surface as "dispatch refused" — the user would go
 * looking at their dispatch policy instead of at the model id they mistyped.
 * Dropping it means the kind keeps working on the inherited model, and the panel can
 * say the stored value was not usable.
 */
export function isKindModel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_KIND_MODEL_LENGTH) return false;
  // Upstream rejects leading/trailing whitespace too; a value that needs trimming is
  // a value somebody mistyped, not one this layer should silently repair.
  if (value.trim() !== value) return false;
  return !CONTROL_CHARS.test(value);
}

/** Whether a stored value is one of the thinking levels this package offers. */
export function isThinkingLevel(value: unknown): value is ThinkingLevelName {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Decode the kinds block, or `undefined` when the project declared none.
 *
 * Four rules, each of which is a decision the gate depends on:
 *
 *   - a value that is not an object is not a policy, so it is dropped rather
 *     than turned into "enabled with some default";
 *   - a limit that is not a positive integer is dropped for the same reason —
 *     `0` would read as "refuse everything" and `-1` as "no limit", and neither
 *     is what an unreadable value means;
 *   - a model or thinking level that is not usable is dropped rather than
 *     forwarded, because upstream fails a *launch* on an unusable one — a stored
 *     typo would take the kind down instead of reading as "that id is wrong";
 *   - an unknown kind is preserved with whatever it declared. The project owns
 *     the key; only the built-in table decides whether there is an agent behind it.
 */
function parseAgentKinds(value: unknown): Record<string, AgentKindConfig> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kinds: Record<string, AgentKindConfig> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    if (kind.trim() !== kind || !kind) continue;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as { enabled?: unknown; maxConcurrent?: unknown; model?: unknown; thinking?: unknown };
    kinds[kind] = {
      ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
      ...(typeof entry.maxConcurrent === "number" && Number.isInteger(entry.maxConcurrent) && entry.maxConcurrent > 0
        ? { maxConcurrent: entry.maxConcurrent }
        : {}),
      ...(isKindModel(entry.model) ? { model: entry.model } : {}),
      ...(isThinkingLevel(entry.thinking) ? { thinking: entry.thinking } : {}),
    };
  }
  return Object.keys(kinds).length > 0 ? kinds : undefined;
}

/**
 * Write the config and retire the pre-rename file, so a project that adopted
 * the package under its old name keeps its switches instead of reading as
 * uninstalled.
 */
export function writeConfig(root: string, config: WorkflowConfig): void {
  const path = configPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  try {
    rmSync(legacyConfigPath(root));
  } catch {
    // No legacy file: nothing to retire.
  }
}

/**
 * What a switch key the config does not name means for one module.
 *
 * An absent key means the module was added after this project's config was
 * written, so nobody here has chosen anything yet. The two answers are not
 * interchangeable: `"on"` starts a newly added observation or record by itself,
 * while `"off"` keeps a newly added *gate* out until the project opts in — a
 * module that can refuse work must never begin policing a project on the
 * strength of a version upgrade.
 */
export type SwitchDefault = "on" | "off";

/** What `isEnabled` assumes when a module declares nothing: today's behaviour. */
export const DEFAULT_NEW_SWITCH: SwitchDefault = "on";

/**
 * A module's switch declaration, structurally: the fields `isEnabled` and
 * `describeSwitches` read. A `WorkflowModule` satisfies it, so callers pass the
 * registry entry and never restate the default. Does not import the module
 * contract, which imports this file.
 */
export interface SwitchDeclaration {
  id: string;
  newSwitchDefault?: SwitchDefault;
}

/** Where one module's effective switch came from. */
export interface SwitchResolution {
  on: boolean;
  /**
   * `chosen` — the config names this module, so the value is this project's own
   * decision; `defaulted` — the key is absent and the module's declaration
   * decided it. A report must not present the second as consent that happened.
   */
  source: "chosen" | "defaulted";
}

/** How one module's switch resolves, and whether it was chosen or defaulted. */
export function resolveSwitch(
  config: WorkflowConfig,
  id: string,
  declared: SwitchDefault = DEFAULT_NEW_SWITCH,
): SwitchResolution {
  const stored = config.modules[id];
  if (typeof stored === "boolean") return { on: stored, source: "chosen" };
  return { on: declared === "on", source: "defaulted" };
}

/**
 * Whether a module is on.
 *
 * An explicit value in the config always wins. A key that is absent is a module
 * that did not exist when the config was written, and then the module's own
 * declaration decides — `"on"` unless it says otherwise. Every init run rewrites
 * the full switch map, so absence only happens for a module added later.
 */
export function isEnabled(
  config: WorkflowConfig | null,
  id: string,
  declared: SwitchDefault = DEFAULT_NEW_SWITCH,
): boolean {
  return config !== null && resolveSwitch(config, id, declared).on;
}

/**
 * One-line switch summary for reports, for example `trellis=on capacity=off（默认）`.
 *
 * A defaulted switch is marked, because "on" alone reads as a decision this
 * project made, and for an absent key nobody made one. Pass the declarations the
 * caller knows about — the registry — not a map of resolved booleans, which would
 * erase exactly the difference this line has to keep.
 */
export function describeSwitches(
  config: WorkflowConfig | null,
  declarations: readonly SwitchDeclaration[],
): string {
  if (config === null) return "未安装（本项目的扩展不生效）";
  return declarations
    .map((declaration) => {
      const state = resolveSwitch(config, declaration.id, declaration.newSwitchDefault);
      const mark = state.source === "defaulted" ? "（默认）" : "";
      return `${declaration.id}=${state.on ? "on" : "off"}${mark}`;
    })
    .join(" ");
}
