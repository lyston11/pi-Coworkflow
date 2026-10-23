/**
 * pi-Coworkflow — the Coworkflow layer for a project.
 *
 * Installed once at user level (`pi install`), adopted per project. This file is
 * only the orchestrator: it resolves the project's state, runs the modules that
 * are on, removes what a just-disabled module wrote, renders one report block
 * per module, and hands out the control surface the panels use. Every layer
 * lives in `modules/<id>/` and can be read, changed, or deleted on its own:
 *
 *   modules/trellis/           the modified Trellis itself (delegates to the CLI)
 *   modules/worktree/          the after_start hook that isolates every task
 *   modules/agents/            the two instruction files: project region + child guide
 *   modules/subagents/         reuse or project-install pi-subagents
 *   modules/subagent-context/  runtime: role-scoped Trellis context in a child
 *   modules/lane-worktree/     runtime: lane ledger + `/Coworkflow:lanes`
 *   modules/panel/             panels: `/Coworkflow:settings`, `/Comodels`
 *
 * Four rules shape the control flow:
 *
 *   - **Installed ≠ adopted.** Without `.pi/Coworkflow.json` the project has not
 *     been initialized, so nothing runs there: no install steps, no runtime
 *     hooks, no injection. `/Coworkflow:init` is the only thing that creates it.
 *   - **Adopted ≠ loaded.** Even in an initialized project a new session starts
 *     with the Coworkflow layer off: the user runs `/Coworkflow:start` in
 *     that session, or the project sets `autoEnable`. Until then a session is
 *     plain Pi — native `/model`, the user's own subagent configuration, no
 *     Trellis injection.
 *   - **Switches.** `.pi/Coworkflow.json` lists each module as on or off, so a
 *     project can take part of the layer. `--enable`/`--disable` persist, and so
 *     does `/Coworkflow:settings`.
 *   - **Session overrides project.** An explicit `/Coworkflow:start off`
 *     wins over `autoEnable: true`, so a session can always opt out.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type {
  ModuleContext,
  PiRuntimeHost,
  RuntimeContext,
  Status,
  WorkflowControl,
} from "../core/module.ts";
import { createContext, renderModule } from "../core/module.ts";
import type { WorkflowConfig, AgentKindConfig } from "../core/config.ts";
import {
  configPath,
  configRootNote,
  createConfigRootResolver,
  describeSwitches,
  isEnabled,
  isKindModel,
  isThinkingLevel,
  MAX_KIND_MODEL_LENGTH,
  readConfig,
  readConfigAt,
  resolveSwitch,
  writeConfig,
} from "../core/config.ts";
import { sessionFlag, sessionKeys, setSessionFlag } from "../core/trellis.ts";
import { checkSubagentModel, formatSubagentModelLine, readDeclaredSubagentModel } from "../core/model-report.ts";
import { existingSubagentsBridge, formatRunSummary } from "../core/subagents-client.ts";
import { childTailActions } from "../core/child-tail.ts";
import { decodeNativeCompletions, readUserConfig } from "../core/pi-subagents.ts";
import { disposeUsage, formatNativeCost, refreshUsage, usageSnapshot } from "../core/usage.ts";
import { nearestTrustDecision, trustFilePath, trustProject } from "../core/trust.ts";
import { MODULES, findModule, moduleIds } from "../modules/index.ts";
import { agentKindsModule, syncAgentKinds } from "../modules/agent-kinds/index.ts";
import { syncSubagentsRuntime } from "../modules/subagents/index.ts";
import { RUN_BUDGET_MS } from "../core/subagents-workflow.ts";
import { BUILTIN_KINDS, agentNameFor, builtinKind, resolveKinds } from "../modules/agent-kinds/defaults.ts";
import { DEFINITIONS_REL, definitionsDir, readKindDefinitions, writeDefinitionFile, writeKindDefinition } from "../modules/agent-kinds/definitions.ts";
import { THINKING_LEVELS } from "../modules/panel/shared.ts";
import { installedPrefix } from "../modules/worktree/index.ts";

const DEFAULT_PREFIX = "wt-";
const PREFIX_RE = /^[A-Za-z0-9._-]+$/;
const NS = "Coworkflow";

interface CommandContext {
  cwd?: string;
  /** "tui" for the interactive session; print/RPC modes get stderr reports. */
  mode?: string;
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    confirm?: (title: string, message: string) => Promise<boolean>;
    input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
  sessionManager?: { getSessionId?: () => string | undefined };
  /** Whether Pi loaded this project's trust-gated resources. */
  isProjectTrusted?: () => boolean;
}

/**
 * The failure an untrusted project produces, spelled out.
 *
 * Pi gates `.pi/settings.json`, `.pi/extensions`, `.pi/agents`, `.pi/prompts`
 * and project `.agents/skills` behind a trust decision, so without trust the
 * Trellis extension, the three role agents and the project's `subagents.*`
 * settings are all absent even though the files are on disk.
 */
function trustLine(ctx: CommandContext): { status: Status; message: string } | null {
  const trusted = ctx.isProjectTrusted?.();
  if (trusted === undefined) return null;
  if (trusted) {
    return { status: "ok", message: "项目已受信任：.pi/ 下的扩展、agent、提示词与项目设置都已加载" };
  }
  return {
    status: "warn",
    message:
      "本项目未受信任：.pi/settings.json、.pi/extensions、.pi/agents、.pi/prompts 都不会被加载——角色 agent 派单会失败、Trellis 注入与项目设置不生效。本命令会把信任决定写入 ~/.pi/agent/trust.json（`--no-trust` 可跳过），**下次在本项目开 Pi 生效**；本次也可用 `pi -a`，或在 ~/.pi/agent/settings.json 设 defaultProjectTrust: \"always\"",
  };
}

interface ParsedArgs {
  prefix?: string;
  dry: boolean;
  enable: string[];
  disable: string[];
  autoEnable?: boolean;
  trellisUpdate?: boolean;
  /** Skip saving Pi's project-trust decision for this project. */
  noTrust?: boolean;
  error?: string;
}

const ALL_IDS = MODULES.map((module) => module.id);
const RUNTIME_IDS = MODULES.filter((module) => module.activate && !module.alwaysActive).map(
  (module) => module.id,
);

function parseArgs(args: string): ParsedArgs {
  const parsed: ParsedArgs = { dry: false, enable: [], disable: [] };
  const words = args.trim().split(/\s+/).filter(Boolean);
  const list = (value: string): string[] =>
    value.split(",").map((id) => id.trim()).filter(Boolean);

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const value = (inline: string | undefined): string | undefined => {
      if (inline !== undefined) return inline;
      const next = words[i + 1];
      if (next !== undefined) i += 1;
      return next;
    };
    const withValue = ["--prefix", "--enable", "--disable", "--auto-enable"].find(
      (flag) => word === flag || word.startsWith(`${flag}=`),
    );
    if (word === "--dry-run") {
      parsed.dry = true;
    } else if (word === "--no-trust") {
      parsed.noTrust = true;
    } else if (word === "--trellis-update") {
      parsed.trellisUpdate = true;
    } else if (withValue === undefined) {
      return {
        ...parsed,
        error: `无法识别的参数：${word}（可用：--enable/--disable/--auto-enable/--prefix/--trellis-update/--dry-run）`,
      };
    } else {
      const inline = word.startsWith(`${withValue}=`)
        ? word.slice(withValue.length + 1)
        : undefined;
      const raw = value(inline);
      if (raw === undefined) return { ...parsed, error: `${withValue} 需要一个值` };
      if (withValue === "--prefix") parsed.prefix = raw;
      else if (withValue === "--enable") parsed.enable.push(...list(raw));
      else if (withValue === "--disable") parsed.disable.push(...list(raw));
      else if (raw === "on" || raw === "true") parsed.autoEnable = true;
      else if (raw === "off" || raw === "false") parsed.autoEnable = false;
      else return { ...parsed, error: `--auto-enable 只接受 on/off：${raw}` };
    }
  }

  if (parsed.prefix !== undefined && !PREFIX_RE.test(parsed.prefix)) {
    return { ...parsed, error: `worktree 前缀只允许 [A-Za-z0-9._-]：${parsed.prefix}` };
  }
  for (const id of [...parsed.enable, ...parsed.disable]) {
    if (!ALL_IDS.includes(id)) {
      return { ...parsed, error: `未知模块：${id}（可用：${moduleIds()}）` };
    }
  }
  return parsed;
}

function gitRoot(cwd: string): string {
  const proc = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
  const out = (proc.stdout ?? "").trim();
  return proc.status === 0 && out ? out : cwd;
}

/** Terminal-visible report, for modes where the transcript renders nothing. */
function report(text: string): void {
  try {
    console.error(text);
  } catch {
    // stderr unavailable: nothing else to do.
  }
}

let runtime: RuntimeContext = {
  isChild: false,
  enabled: false,
  loadState: "off",
  refresh: () => {},
  cwd: process.cwd(),
  sessionId: null,
  parentSessionId: null,
  sessionEpoch: 0,
  configRoots: createConfigRootResolver(),
  control: {
    initialized: () => false,
    switches: () => ({}),
    moduleIds: () => ALL_IDS,
    configRoot: () => null,
    configRootNote: () => null,
    autoEnable: () => false,
    prefix: () => DEFAULT_PREFIX,
    facts: () => [],
    setSwitch: () => "control 尚未就绪",
    setAutoEnable: () => "control 尚未就绪",
    loadState: () => "off",
    moduleEnabled: () => false,
    setPrefix: () => "control 尚未就绪",
    subagentConcurrency: () => null,
    runBudgetMinutes: () => null,
    setRunBudgetMinutes: () => "control 尚未就绪",
    defineKind: () => "control 尚未就绪",
    removeKind: () => "control 尚未就绪",
    setSubagentConcurrency: () => "control 尚未就绪",
    agentKinds: () => [],
    setAgentKind: () => "control 尚未就绪",
    agentKindStatus: () => [],
    settleAgentKinds: () => Promise.resolve(),
    settleSubagents: () => Promise.resolve(),
    init: () => "control 尚未就绪",
  },
};
const runtimeErrors: string[] = [];
const runtimeActive: string[] = [];
const sessionActivated: string[] = [];

function sessionIdOf(ctx: CommandContext | undefined, rt: RuntimeContext): string | null {
  const fromCtx = ctx?.sessionManager?.getSessionId?.();
  if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  return rt.sessionId;
}

/**
 * Resolve whether this session runs the Coworkflow layer.
 *
 * Precedence: an explicit session switch wins (so `/Coworkflow:start off` is
 * respected even when the project auto-enables), then the project switch. A
 * dispatched child cannot have its own switch, so it reads the flag of the
 * parent session id it was told about — which is why the flag lives in a file.
 */
/**
 * The first explicit switch among a session's known keys.
 *
 * A session can be addressed by its id or by its session file path, and both
 * spellings have to resolve to the same entry: `/Coworkflow:start` writes the id,
 * a dispatched child reads the parent's file path.
 */
function firstFlag(root: string, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const flag = sessionFlag(root, key);
    if (flag !== undefined) return flag;
  }
  return undefined;
}

/** Resolve both the switch and the reason for it. */
function resolveLoadState(cwd: string): { enabled: boolean; state: RuntimeContext["loadState"] } {
  // One resolution per (cwd, epoch): this runs at the start of every command and
  // every agent turn, and the uncached form spawns `git`.
  const root = runtime.configRoots.root(cwd);
  // An unresolvable root is inert, not "read wherever we started": the difference
  // between the two is exactly what used to make module switches drift.
  if (root === null) return { enabled: false, state: "off" };
  const config = readConfig(root);
  if (config === null) return { enabled: false, state: "off" };
  if (runtime.isChild) {
    // The parent is known here by whichever spelling the runner published — a
    // session file path, or an id — so resolve through both key spaces.
    const flag = firstFlag(root, sessionKeys(runtime.parentSessionId));
    const enabled = flag ?? config.autoEnable === true;
    return { enabled, state: enabled ? "child" : "off" };
  }
  const flag = firstFlag(root, sessionKeys(runtime.sessionId));
  if (flag !== undefined) return { enabled: flag, state: flag ? "started" : "off" };
  return config.autoEnable === true ? { enabled: true, state: "auto" } : { enabled: false, state: "off" };
}

/**
 * Re-resolve the switch and make the runtime layer match it.
 *
 * Called at the start of every command and every agent turn, so a `/reload`, a
 * `/Coworkflow:start` from another window, or a flag written a moment ago all
 * take effect without a restart. Cheap: one small JSON read.
 *
 * Two things happen when the layer turns on here rather than at load:
 *
 *   - the runtime modules that were skipped at load are registered now
 *     (`ensureRuntime`), so hooks act in this very session;
 *   - the feature commands register (`activateSession`).
 *
 * Turning it *off* is not "do nothing": a hook that reads the switch at event
 * time goes quiet by itself, but a resource the upstream package registered for
 * this session (a workflow resource, a required child extension) has to be
 * withdrawn explicitly. `notifyRuntimeChange` is what tells an owner that both
 * gates moved; it is idempotent, so calling it on every command costs nothing.
 */
function refreshSession(): void {
  const resolved = resolveLoadState(runtime.cwd);
  runtime.enabled = resolved.enabled;
  runtime.loadState = resolved.state;
  ensureRuntime();
  if (runtime.enabled) activateSession();
  // Unconditional and idempotent: a module's reconciliation is a comparison, so
  // this costs nothing when the gates did not move, and it is the only way a
  // switch written by another window reaches a session-scoped upstream
  // registration between two `session_start` events.
  notifyRuntimeChange();
}

/**
 * Tell every registered module that the gates may have moved.
 *
 * Modules decide for themselves what "off" means: hooks read the gate at event
 * time, while a module holding session-scoped upstream registrations withdraws
 * them here and rebuilds them when the gate comes back on.
 */
function notifyRuntimeChange(): void {
  if (runtimeHost && (!runtime.enabled || !runtime.control.moduleEnabled("panel"))) disposeUsage(runtimeHost);
  if (!runtimeHost) return;
  for (const module of MODULES) {
    if (!module.onRuntimeChange || !runtimeActive.includes(module.id)) continue;
    try {
      module.onRuntimeChange(runtimeHost, runtime);
    } catch (error) {
      runtimeErrors.push(
        `${module.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Register any runtime module this session is allowed to have.
 *
 * Two switches decide it:
 *
 *   module switch     a module the project switched off installs nothing. This
 *                     was the gap: registration used to look only at adoption,
 *                     so a disabled module kept a live hook while its install
 *                     artifacts were removed.
 *   project adoption  without `.pi/Coworkflow.json` the project never opted in,
 *                     so no module that acts on the model is installed. The
 *                     exception is `alwaysActive`: the settings and model
 *                     panels register anyway so an uninitialized project can be
 *                     told why they are refusing, instead of the fuzzy matcher
 *                     silently offering Pi's own command.
 *
 * Session state is not consulted here: hooks that act on the model read
 * `runtime.enabled` at event time, and hooks that only record (the lane ledger)
 * are deliberately adoption-gated so a dispatch from a session that never ran
 * `/Coworkflow:start` is still recorded. `runtimeActive` makes the call
 * idempotent, and every module's `activate` is required to be idempotent for its
 * own registrations.
 */
function ensureRuntime(): void {
  if (!runtimeHost) return;
  const config = readConfigAt(runtime.configRoots, runtime.cwd);
  for (const module of MODULES) {
    if (!module.activate || runtimeActive.includes(module.id)) continue;
    if (config !== null ? !isEnabled(config, module.id, module.newSwitchDefault) : !module.alwaysActive) continue;
    try {
      module.activate(runtimeHost, runtime);
      runtimeActive.push(module.id);
    } catch (error) {
      // A broken runtime hook must not take the session down; the status report
      // names it instead.
      runtimeErrors.push(
        `${module.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Release everything the runtime modules acquired for the session that ends here.
 *
 * `session_shutdown` arrives for quit, `/reload` and session replacement. A module
 * that declares `onSessionEnd` releases its registrations there, so it must be
 * activated again for the next session — it is dropped from `runtimeActive` for
 * that reason. A module without `onSessionEnd` keeps its registrations on a host
 * that outlives the session (the dispatch ledger is one ledger per host on
 * purpose), so it stays marked active and nothing is registered twice.
 */
function endSession(): void {
  if (runtimeHost) disposeUsage(runtimeHost);
  for (const module of MODULES) {
    if (!module.onSessionEnd) continue;
    try {
      module.onSessionEnd(runtimeHost!, runtime);
    } catch (error) {
      runtimeErrors.push(
        `${module.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const index = runtimeActive.indexOf(module.id);
    if (index !== -1) runtimeActive.splice(index, 1);
  }
  sessionActivated.length = 0;
  runtime.enabled = false;
  runtime.loadState = "off";
}

function runtimeReport(): string | null {
  const runtimes = MODULES.filter((module) => module.activate);
  if (runtimes.length === 0) return null;
  const states: string[] = [];
  for (const module of runtimes) {
    try {
      for (const line of module.runtimeStatus?.(runtimeHost!) ?? []) states.push(`  [${module.id}]${line}`);
    } catch (error) {
      runtimeErrors.push(`${module.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The configuration root the gates actually read, and — when git could not
  // answer — that fact rather than a path. This is the line that makes a
  // resolution failure visible instead of silently reading the starting cwd.
  const rootResolution = runtime.configRoots.resolve(runtime.cwd);
  const rootNote = configRootNote(rootResolution, runtime.cwd);
  // One read for the whole report: every line below needs the same file to tell
  // "this project switched it off" from "this module was never chosen here".
  const reportConfig = readConfigAt(runtime.configRoots, runtime.cwd);
  const rootLine = rootResolution.kind === "unresolved"
    ? [`  ! 配置根无法解析（${rootResolution.reason}）：本会话不读取任何项目的 .pi/Coworkflow.json，也不回退到当前目录`]
    : [
      `  = 配置根: ${rootResolution.root}${
        // Only a resolved root can be *the* main checkout. A directory outside any
        // repository resolves to itself, and claiming it is a main checkout would
        // assert the opposite of what the resolver just said.
        rootResolution.kind === "resolved" && rootNote !== null ? "（主 checkout）" : ""
      }`,
    ];
  return [
    `[runtime] 本会话（isChild=${runtime.isChild ? "true" : "false"}，Coworkflow ${runtime.enabled ? "已加载" : "未加载"}）`,
    ...rootLine,
    ...runtimes.map((module) => {
      if (!runtimeActive.includes(module.id)) {
        if (reportConfig === null) return `  - ${module.id} 未注册（本项目未初始化或配置根无法解析）`;
        // "off" and "never chosen, declared off" are different facts: one is a
        // decision this project made, the other a gate it never opted into.
        return resolveSwitch(reportConfig, module.id, module.newSwitchDefault).source === "defaulted"
          ? `  - ${module.id} 未注册（该模块声明默认关闭，本项目未选择）`
          : `  - ${module.id} 未注册（本项目把该模块关掉了）`;
      }
      if (module.alwaysActive) return `  = ${module.id} 常驻`;
      return runtime.enabled
        ? `  = ${module.id} 已注册并生效`
        : `  = ${module.id} 已注册（本会话未加载：不生效，/${NS}:start 打开）`;
    }),
    ...runtimeErrors.map((entry) => `  x ${entry}`),
    ...states,
  ].join("\n");
}

/** Register the feature commands a module only exposes while the layer is on. */
function activateSession(): void {
  for (const module of MODULES) {
    if (!module.onSessionActivate || sessionActivated.includes(module.id)) continue;
    if (!isEnabled(readConfigAt(runtime.configRoots, runtime.cwd), module.id, module.newSwitchDefault)) continue;
    try {
      module.onSessionActivate(runtimeHost!, runtime);
      sessionActivated.push(module.id);
    } catch (error) {
      runtimeErrors.push(
        `${module.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

let runtimeHost: PiRuntimeHost | null = null;

/**
 * The subagent model, resolved against the host's registry when the host offers one.
 *
 * Reads the two settings files in precedence order (project beats user), because "which file said
 * this" is part of the answer — a stale value in the wrong file looks identical to a correct one in
 * the right file until someone asks where it came from.
 */
function subagentModelLines(root: string, ctx: CommandContext): string[] {
  try {
    const declared = readDeclaredSubagentModel(root);
    const registry = (ctx as { modelRegistry?: { getAvailable?(): unknown[]; hasConfiguredAuth?(model: unknown): boolean } })
      .modelRegistry;
    const available =
      typeof registry?.getAvailable === "function"
        ? (registry.getAvailable() as { provider?: unknown; id?: unknown }[])
            .map((model) => {
              const provider = String(model?.provider ?? "");
              const id = String(model?.id ?? "");
              if (provider === "" || id === "") return null;
              const authenticated =
                typeof registry?.hasConfiguredAuth === "function"
                  ? Boolean(registry.hasConfiguredAuth(model))
                  : undefined;
              return { provider, id, ...(authenticated === undefined ? {} : { authenticated }) };
            })
            .filter((model) => model !== null)
        : undefined;
    const session = (ctx as { model?: { provider?: unknown; id?: unknown } }).model;
    const sessionModel =
      typeof session?.provider === "string" && typeof session?.id === "string"
        ? { provider: session.provider, id: session.id }
        : null;
    return [`  ${formatSubagentModelLine(checkSubagentModel({ declared, available, sessionModel }))}`];
  } catch (error) {
    return [`  ~ 子 agent 模型：无法判定（${error instanceof Error ? error.message : String(error)}）`];
  }
}

function runSetup(args: string, ctx: CommandContext, forceDry: boolean): string {
  const parsed = parseArgs(args);
  if (parsed.error) return parsed.error;

  const cwd = ctx.cwd ?? process.cwd();
  const dry = forceDry || parsed.dry;

  // The root this report must not lie about: a resolution that failed is a third
  // state, and every number after this point would otherwise describe a
  // directory nothing confirmed — presented as if it were the project.
  const resolution = runtime.configRoots.resolve(cwd);
  if (resolution.kind === "unresolved") {
    ctx.ui?.notify?.("配置根无法解析，未改动任何文件", "error");
    return [
      `${dry ? "体检（未改动任何文件）" : "初始化本项目"} — 配置根无法解析`,
      `  x 配置根无法解析：git 读取失败（${resolution.reason}）`,
      `  - 本会话不读取任何项目的 .pi/Coworkflow.json，也不把当前目录当成配置根`,
      `  - 因此这里不列出模块开关：它们没有可读的出处`,
      `  → git 恢复后重试 /${NS}:init（或 /${NS}:status）`,
    ].join("\n");
  }

  // The config root, not the worktree: a task worktree only carries committed
  // files, so writing the config there would put the switches somewhere no gate
  // reads.
  const root = resolution.root;
  // What a subagent will actually run on. Reported for the same reason every other line here is:
  // a declared model that does not resolve falls back to the parent's, silently, and the session
  // that discovered this had four children fail with a connection error and execute nothing.
  const modelLines = subagentModelLines(root, ctx);
  const existing = readConfig(root);
  const firstInstall = existing === null;

  // Switches: `--enable`/`--disable` persist, an explicit value in an existing
  // config always wins, and a key it does not name belongs to a module added
  // after that config was written — so the module's declaration decides ('on'
  // for a layer that only observes or records, 'off' for one that can refuse
  // work and must be opted into). A project with no config has named nothing at
  // all, which is the same case, so there is one rule and no exception.
  // `chosen` keeps the difference for the report; the map written below is full.
  const switches: Record<string, boolean> = {};
  const chosen: Record<string, boolean> = {};
  const stored: WorkflowConfig = existing ?? { version: 1, modules: {} };
  for (const module of MODULES) {
    const resolved = resolveSwitch(stored, module.id, module.newSwitchDefault);
    switches[module.id] = resolved.on;
    if (resolved.source === "chosen") chosen[module.id] = resolved.on;
  }
  for (const id of parsed.enable) {
    switches[id] = true;
    chosen[id] = true;
  }
  for (const id of parsed.disable) {
    switches[id] = false;
    chosen[id] = false;
  }

  const autoEnable = parsed.autoEnable ?? existing?.autoEnable === true;
  const prefix =
    parsed.prefix ?? existing?.worktreePrefix ?? installedPrefix(root) ?? DEFAULT_PREFIX;
  const enabled = MODULES.filter((module) => switches[module.id] === true);
  // Only a module that was on and is now off has artifacts to take back.
  const switchedOff = MODULES.filter(
    (module) => switches[module.id] !== true && isEnabled(existing, module.id, module.newSwitchDefault),
  );

  // The switch line reports what was *chosen*: a key that is absent from the
  // config, or was left at its declared default this run, is marked `（默认）`
  // rather than printed as a decision the project never made.
  const switchLine = describeSwitches({ version: 1, modules: chosen }, MODULES);

  const blocks: string[] = [
    `${dry ? "体检（未改动任何文件）" : firstInstall ? "初始化本项目" : "刷新本项目"} — ${root}`,
    `  配置: ${configPath(root)}${firstInstall ? "（不存在）" : ""}`,
    `  开关: ${switchLine}`,
    `  自动加载: ${autoEnable ? "on（新会话直接加载 Coworkflow）" : `off（新会话需 /${NS}:start）`}`,
  ];
  const totals: Partial<Record<Status, number>> = {};

  // A linked worktree is where the user stands and also not where the gates read
  // the config from, so the report says both. The `no-repo` answer already has its
  // own warning below (`不是 git 仓库根`), and `unresolved` returned above.
  if (resolution.kind === "resolved") {
    const note = configRootNote(resolution, root);
    if (note) blocks.push(`  = ${note}`);
  }

  const trust = trustLine(ctx);
  if (trust) {
    blocks.push(`  ${trust.status === "warn" ? "!" : "="} ${trust.message}`);
    if (trust.status === "warn") totals.warn = (totals.warn ?? 0) + 1;
  }

  // Running init inside a project is the consent Pi's trust gate is waiting for,
  // so record the decision here instead of sending the user to approve twice.
  if (parsed.noTrust) {
    blocks.push("  - 未改动 Pi 的项目信任决定（--no-trust）");
  } else if (dry) {
    const existing = nearestTrustDecision(root);
    blocks.push(
      existing?.decision === true
        ? `  = 项目信任：已受信任（${existing.path}）`
        : `  + 项目信任：运行 /${NS}:init 会把 ${root} 记入 ${trustFilePath()}（本次未改动）`,
    );
  } else {
    const saved = trustProject(root);
    if (saved.error) {
      blocks.push(`  x ${saved.error}`);
      totals.error = (totals.error ?? 0) + 1;
    } else if (saved.changed) {
      blocks.push(
        `  + 项目信任：已把 ${saved.path} 记入 ${trustFilePath()}；**本会话启动时已按未受信任加载，下次在本项目开 Pi 才生效**（或本次用 \`pi -a\`）`,
      );
      totals.created = (totals.created ?? 0) + 1;
    } else if (saved.inheritedFrom) {
      blocks.push(`  = 项目信任：继承自 ${saved.inheritedFrom}，未改动`);
    } else {
      blocks.push(`  = 项目信任：已受信任（${saved.path}）`);
    }
  }

  if (firstInstall) {
    blocks.push(
      `  本项目尚未初始化：未初始化前本扩展在项目里不做任何事（不改文件、不注入 prompt）`,
    );
  }
  if (!existsSync(join(root, ".git"))) {
    blocks.push(`  ! ${root} 不是 git 仓库根；worktree 隔离依赖 git`);
    totals.warn = (totals.warn ?? 0) + 1;
  }
  if (parsed.autoEnable !== undefined) {
    blocks.push("  ! 自动加载的改动在会话启动时读取：本会话仍是旧状态，重开会话生效");
  }

  // The config is written *after* the modules run: it is the project's record of
  // what is installed, so a module that fails must not be recorded as on. Only a
  // dry run skips the write, and it is the only thing that reports without it.
  const runModule = (
    module: (typeof MODULES)[number],
    action: "apply" | "remove",
  ): "ok" | "failed" => {
    const steps: { status: Status; message: string }[] = [];
    let failed = false;
    const context = createContext({
      root,
      prefix,
      dry,
      flags: {
        trellisUpdate: parsed.trellisUpdate === true,
        ...(existing?.subagentConcurrency !== undefined
          ? { subagentConcurrency: existing.subagentConcurrency }
          : {}),
      },
      report(status, message) {
        steps.push({ status, message });
        totals[status] = (totals[status] ?? 0) + 1;
        if (status === "error") failed = true;
      },
    });
    try {
      if (action === "apply") module.apply?.(context);
      else module.remove?.(context);
    } catch (error) {
      context.report("error", `模块异常：${error instanceof Error ? error.message : String(error)}`);
    }
    if (steps.length > 0) blocks.push(renderModule(module, steps));
    return failed ? "failed" : "ok";
  };

  for (const module of enabled) {
    if (module.apply && runModule(module, "apply") === "failed") {
      // A module that could not install is recorded as off, so the next
      // `/Coworkflow:init` retries it instead of treating it as done.
      switches[module.id] = false;
    }
  }
  for (const module of switchedOff) {
    if (module.remove) runModule(module, "remove");
  }

  if (!dry) {
    writeConfig(root, {
      version: 1,
      installedAt: new Date().toISOString(),
      worktreePrefix: prefix,
      ...(autoEnable ? { autoEnable: true } : {}),
      modules: switches,
      // Init writes the switch map it knows about, not the whole file: the kind
      // policies (including kinds this build does not ship) belong to the project
      // and would otherwise be silently retracted by a refresh.
      ...(existing?.agentKinds === undefined ? {} : { agentKinds: existing.agentKinds }),
    });
  }

  // Before the runtime block: the model question is answered from the settings files and the host's
  // registry, so it belongs with the other "what will this project actually do" lines.
  if (modelLines.length > 0) blocks.push(modelLines.join("\n"));

  const runtimeBlock = runtimeReport();
  if (runtimeBlock) blocks.push(runtimeBlock);
  blocks.push(`  modules: ${moduleIds()}`);

  // A hint, not a change: init never decides whether this session runs the
  // workflow. Saying which command does that is the difference between "installed"
  // and "running", and it is the one step people miss.
  const loadHint = runtime.enabled
    ? `  = 本会话已加载：/${NS}:lanes、/Comodels、子 agent 的 Trellis 注入可用`
    : `  → 本会话尚未加载：运行 /${NS}:start（之后 reload 也保持加载；新会话仍需各自 start，除非打开「新会话自动加载」）`;
  blocks.push(loadHint);

  const summary = (["created", "updated", "warn", "error"] as const)
    .filter((key) => totals[key])
    .map((key) => `${key}=${totals[key]}`)
    .join(" ");
  blocks.push(summary ? `  ${dry ? "预计 " : ""}${summary}` : "  无变化");

  const text = blocks.join("\n");
  const failed = (totals.error ?? 0) > 0;
  const warned = (totals.warn ?? 0) > 0;
  ctx.ui?.notify?.(
    failed
      ? "Coworkflow 有失败项，详见会话输出"
      : warned
        ? "Coworkflow 已就绪，但有需要处理的提醒"
        : dry
          ? "Coworkflow 体检完成"
          : firstInstall
            ? "Coworkflow 已初始化本项目"
            : "Coworkflow 已刷新",
    failed ? "error" : warned ? "warning" : "info",
  );
  return text;
}

/**
 * `/Coworkflow:kind` — list, inspect, define and remove subagent kinds.
 *
 * Every write goes through `control.defineKind`, which validates before touching the file and
 * re-syncs the session, so a rejected value is a sentence rather than a broken kind. `list`
 * and `show` read the resolved table, so they report what the session is actually using —
 * including which layer (project file or shipped) decided it.
 */
async function runKindCommand(args: string, ctx: CommandContext): Promise<string> {
  const control = controlSurface();
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "list";
  const kind = parts[1];
  const root = control.configRoot();
  const definitions = root === null ? new Map() : readKindDefinitions(root).definitions;
  const failures = root === null ? [] : readKindDefinitions(root).failures;
  const kinds = control.agentKinds();

  if (sub === "list") {
    if (kinds.length === 0) return `本项目还没有可用的 kind；用 /${NS}:init 安装后可用，或在 ${DEFINITIONS_REL}/<kind>.md 里定义。`;
    const lines = [`kind 一览（${DEFINITIONS_REL}/<kind>.md 可自定义）：`];
    for (const entry of kinds) {
      const chosen = entry.chosen ?? {};
      const limit = `${entry.maxConcurrent}${chosen.maxConcurrent === true ? "" : "（默认）"}`;
      const model = entry.model === undefined ? "继承" : entry.model;
      lines.push(
        `  - ${entry.kind} → ${entry.agent} · ${entry.label} · ${entry.enabled ? "on" : "off"} · 上限 ${limit} · 模型 ${model} · 角色 ${
          entry.role ?? "none"
        } · ${entry.source === "file" ? "项目定义" : "本包随附"}`,
      );
    }
    for (const failure of failures) lines.push(`  ! ${failure.kind}：${failure.reason}`);
    lines.push("", `用法：/${NS}:kind set <kind> label=… role=implement|check|research|none prompt=… model=… thinking=… maxConcurrent=… enabled=true|false`);
    return lines.join("\n");
  }

  if (sub === "show") {
    if (kind === undefined) return `用法：/${NS}:kind show <kind>`;
    const entry = kinds.find((candidate) => candidate.kind === kind);
    if (entry === undefined) {
      const failure = failures.find((candidate) => candidate.kind === kind);
      return failure === undefined
        ? `没有 kind ${kind}（/${NS}:kind list 看全部）`
        : `kind ${kind} 的定义无法使用：${failure.reason}`;
    }
    const definition = definitions.get(kind);
    return [
      `kind ${kind}`,
      `  agent: ${entry.agent}`,
      `  label: ${entry.label}`,
      `  role: ${entry.role ?? "none"}`,
      `  enabled: ${entry.enabled}${entry.chosen?.enabled === true ? "（项目选择）" : "（默认）"}`,
      `  maxConcurrent: ${entry.maxConcurrent}${entry.chosen?.maxConcurrent === true ? "（项目选择）" : "（默认）"}`,
      `  model: ${entry.model ?? "继承"}${entry.chosen?.model === true ? "（项目选择）" : ""}`,
      `  thinking: ${entry.thinking ?? "继承"}${entry.chosen?.thinking === true ? "（项目选择）" : ""}`,
      `  来源: ${entry.source === "file" ? `${DEFINITIONS_REL}/${kind}.md` : "本包随附"}`,
      "",
      definition === undefined ? "（没有项目定义文件；用 set 写一个即可覆盖本包的定义）" : `提示词（前 3 行）：\n${definition.prompt.split("\n").slice(0, 3).join("\n")}`,
    ].join("\n");
  }

  if (sub === "remove") {
    if (kind === undefined) return `用法：/${NS}:kind remove <kind>`;
    return await control.removeKind(kind);
  }

  if (sub === "set") {
    if (kind === undefined) return `用法：/${NS}:kind set <kind> key=value…（可用键：label agent role description model thinking maxConcurrent enabled prompt）`;
    // `--from <file>` first: the definition IS a markdown document, and a slash command that can
    // only take `k=v` would push people into quoting a prompt on one line.
    const fromAt = parts.indexOf("--from", 2);
    if (fromAt !== -1) {
      const path = parts[fromAt + 1];
      if (path === undefined) return `用法：/${NS}:kind set ${kind} --from <file.md>`;
      const written = control.defineKind(kind, { __from: path });
      return await written;
    }
    const patch: Record<string, unknown> = {};
    for (const pair of parts.slice(2)) {
      const at = pair.indexOf("=");
      if (at <= 0) return `无法解析 ${JSON.stringify(pair)}：需要 key=value`;
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (key === "maxConcurrent") patch[key] = Number(value);
      else if (key === "enabled") patch[key] = value === "true";
      else patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      return `没有要改的字段：/${NS}:kind set ${kind} label=… role=… prompt=…`;
    }
    return await control.defineKind(kind, patch);
  }

  return `未知子命令 ${sub}；可用：list / show <kind> / set <kind> key=value… / remove <kind>`;
}

function runStart(args: string, ctx: CommandContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  const resolved = runtime.configRoots.resolve(cwd);
  if (resolved.kind === "unresolved") {
    return `配置根无法解析：git 读取失败（${resolved.reason}）。本次不改会话状态：${NS}:start 需要先确认项目配置所在的 checkout。`;
  }
  const root = resolved.root;
  const config = readConfig(root);
  const action = args.trim().toLowerCase() || "on";

  if (config === null) {
    return `本项目未初始化 Coworkflow（${configPath(root)} 不存在）：先运行 /${NS}:init。`;
  }
  if (action !== "on" && action !== "off" && action !== "status") {
    return `用法：/${NS}:start [off|status]（默认 on）`;
  }
  if (action === "status") {
    return [
      `本会话 Coworkflow: ${runtime.enabled ? "已加载" : "未加载"}`,
      `项目自动加载: ${config.autoEnable === true ? "on" : "off"}`,
      `运行时模块: ${RUNTIME_IDS.join(", ")}`,
      `session: ${sessionIdOf(ctx, runtime) ?? "(未知)"}`,
      // Without the stored flag nothing survives a reload, so show it.
      `会话标记: ${sessionFlag(root, sessionIdOf(ctx, runtime)) === true ? "on" : "off（reload 后会回到未加载）"}`,
    ].join("\n");
  }

  const on = action === "on";
  const sessionId = sessionIdOf(ctx, runtime);
  runtime.enabled = on;
  if (on) {
    // `refresh()` runs first in every command handler, so the runtime modules
    // were already registered before this command got here; activation adds the
    // feature commands. Both are idempotent, and both run here too in case a
    // caller drove the control surface directly.
    ensureRuntime();
    activateSession();
  }
  // The session switch is one of the two gates a module reads, so the owners of
  // session-scoped upstream registrations have to hear about it: off withdraws
  // them, on reinstates them — in this same session.
  notifyRuntimeChange();

  if (!sessionId) {
    return `本会话 Coworkflow → ${on ? "已加载" : "未加载"}，但拿不到 session id：子 agent 不会跟随本会话状态，建议 /${NS}:init --auto-enable on。`;
  }
  // Stamp the flag under *every* id this session can be known by. Pi exposes the
  // session id on the command context, but a hook can also arrive with the env
  // id or none at all, and `/reload` resolves the flag from whichever it has —
  // so one id written and another read is exactly how a session silently falls
  // back to "not loaded". Writing both ids (and remembering them) removes the
  // guesswork.
  // Every spelling a reader might use: the command's id, the process id, and the
  // session file path's id — a child of this session looks itself up by the path
  // its runner published.
  const knownIds = new Set<string>(
    sessionKeys(sessionId, runtime.sessionId, sessionFileOf(ctx)),
  );
  for (const id of knownIds) setSessionFlag(root, id, on);
  const stored = [...knownIds].every((id) => sessionFlag(root, id) === on);
  const note = stored
    ? ""
    : `\n! 无法写入 ${root}/.trellis/.runtime/workflow-sessions.json：子 agent 不会跟随本会话状态，建议 /${NS}:init --auto-enable on`;
  return on
    ? `本会话 Coworkflow → 已加载：/${NS}:lanes、/Comodels、子 agent 的 Trellis 注入都可用（记录在 .trellis/.runtime/workflow-sessions.json，优先于项目自动加载）${note}`
    : `本会话 Coworkflow → 未加载：本会话回到原生 Pi（原生 /model、你自己的 subagent 配置、无 Trellis 注入）${note}`;
}

/**
 * The last session file Pi reported.
 *
 * pi-subagents records runs per parent session *file*, and the settings panel has
 * no command context of its own, so the path is remembered from the events that
 * do carry one. Reading it through a `null` context — which is what this used to
 * do — always produced `null`, and every "active run" number in the panel was
 * therefore a hardcoded zero.
 */
let lastSessionFile: string | null = null;

function noteSessionFile(ctx: any): string | null {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (typeof file === "string" && file) lastSessionFile = file;
  return lastSessionFile;
}

/** The parent session file path, which is what pi-subagents records per run. */
function sessionFileOf(ctx: any): string | null {
  return noteSessionFile(ctx);
}

/**
 * The model part of a `setAgentKind` report line.
 *
 * Two different facts, said differently: a pinned model is named, an absent one is
 * called out as inheriting. A report that only prints the value would read
 * `模型 ` (empty) after a clear, which is indistinguishable from a bug.
 */
function kindModelLine(entry: { model?: string; thinking?: string } | undefined): string {
  if (entry === undefined) return "";
  const model = entry.model === undefined ? "继承" : entry.model;
  const thinking = entry.thinking === undefined ? "继承" : entry.thinking;
  return `，模型 ${model}，思考 ${thinking}`;
}

/** The control surface the panels use; same operations as the slash commands. */
function createControl(): WorkflowControl {
  // The resolver is the runtime's own, so a panel that reads five values in one
  // render resolves `git` zero times after the first call, and an unresolvable
  // root is a state these methods report instead of a directory they invent.
  const rootOf = (): string | null => runtime.configRoots.root(runtime.cwd);
  const unresolved = (): string => {
    const resolved = runtime.configRoots.resolve(runtime.cwd);
    return `配置根无法解析：git 读取失败（${resolved.kind === "unresolved" ? resolved.reason : "未知原因"}）——本次不改动任何文件`;
  };
  return {
    initialized: () => {
      const root = rootOf();
      return root !== null && readConfig(root) !== null;
    },
    switches: () => {
      const root = rootOf();
      const config = root === null ? null : readConfig(root);
      const switches: Record<string, boolean> = {};
      for (const module of MODULES) switches[module.id] = isEnabled(config, module.id, module.newSwitchDefault);
      return switches;
    },
    moduleIds: () => ALL_IDS,
    configRoot: () => rootOf(),
    configRootNote: () => configRootNote(runtime.configRoots.resolve(runtime.cwd), runtime.cwd),
    autoEnable: () => {
      const root = rootOf();
      return root !== null && readConfig(root)?.autoEnable === true;
    },
    prefix: () => {
      const root = rootOf();
      if (root === null) return DEFAULT_PREFIX;
      return readConfig(root)?.worktreePrefix ?? installedPrefix(root) ?? DEFAULT_PREFIX;
    },
    facts: () => {
      const root = rootOf();
      const config = root === null ? null : readConfig(root);
      const own = readUserConfig()?.maxActiveAsyncRunsPerSession ?? null;
      const bridge = runtimeHost ? existingSubagentsBridge(runtimeHost) : undefined;
      const activity = bridge?.activity();
      const rootLine = root === null
        ? `配置: 无法解析配置根（git 读取失败）；本会话不读取任何项目的 .pi/Coworkflow.json`
        : `配置: ${configPath(root)}${config === null ? "（不存在）" : ""}`;
      return [
        rootLine,
        `初始化于: ${config?.installedAt ?? "-"}`,
        `本会话: ${runtime.enabled ? "已加载" : `未加载（/${NS}:start）`}`,
        `pi-subagents 自身上限: ${own === null ? "不限（用户级配置）" : `${own}（用户级配置）`}`,
        `活跃 async run: ${activity?.kind === "known" ? activity.active : `未知（${activity?.reason ?? "尚未读取公开状态"}）`}`,
        // What a "should I interrupt this?" decision can actually be based on:
        // per-run state/agent/elapsed from the attributable snapshot, tokens from
        // the bounded fleet window with its gaps stated, what each child last wrote
        // in its own session log, and nothing invented for what no projection
        // carries.
        ...formatRunSummary(activity ?? { kind: "unknown", reason: "尚未读取公开状态" },
          bridge?.fleetView() ?? { kind: "unknown", reason: "尚未读取公开 fleet 窗口" }, Date.now(),
          // A cache lookup, never a read: what each run last did, from the bounded
          // tail of its own session file, refreshed at the same boundaries as usage.
          runtimeHost ? childTailActions(runtimeHost, runtime) : new Map()),
        formatNativeCost(runtimeHost ? usageSnapshot(runtimeHost, runtime).cost : { kind: "unknown", reason: "会话未就绪" }),
      ];
    },
    setSwitch: (id, on) => {
      if (!ALL_IDS.includes(id)) return `未知模块：${id}`;
      const root = rootOf();
      if (root === null) return unresolved();
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      const switches = { ...config.modules, [id]: on };
      writeConfig(root, { ...config, modules: switches });
      const module = MODULES.find((candidate) => candidate.id === id);
      if (!module) return `未知模块：${id}`;
      const context: ModuleContext = createContext({
        root,
        prefix: config.worktreePrefix ?? DEFAULT_PREFIX,
        dry: false,
        report: () => {},
      });
      try {
        if (on) module.apply?.(context);
        else module.remove?.(context);
      } catch (error) {
        return `${id} → ${on ? "on" : "off"}，但应用失败：${error instanceof Error ? error.message : String(error)}`;
      }
      if (on && module.activate) {
        // A switched-on runtime module attaches now instead of at the next
        // reload. A module holding session-scoped upstream registrations also
        // has to rebuild them; `notifyRuntimeChange` below is what makes that
        // work without a reload in either direction.
        try {
          ensureRuntime();
          if (runtime.enabled) activateSession();
        } catch (error) {
          return `${id} → on，但运行时注册失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      notifyRuntimeChange();
      if (on && module.activate) return `${id} → on（本会话已生效）`;
      // Off: hooks stay attached but read the switch at event time, and a module
      // that holds session-scoped upstream registrations withdraws them here.
      return `${id} → ${on ? "on" : "off"}`;
    },
    loadState: () => runtime.loadState,
    moduleEnabled: (id) => {
      const root = rootOf();
      // The module's own declaration decides an absent key, exactly as it does
      // for a gate evaluation: a module added by a later version must read the
      // same state here as the hook that acts on it.
      return root !== null && isEnabled(readConfig(root), id, findModule(id)?.newSwitchDefault);
    },
    setAutoEnable: (on) => {
      const root = rootOf();
      if (root === null) return unresolved();
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      writeConfig(root, { ...config, ...(on ? { autoEnable: true } : { autoEnable: false }) });
      return on
        ? "新会话自动加载 → on（下次打开 pi 即加载 Coworkflow）"
        : `新会话自动加载 → off（每次新会话需 /${NS}:start）`;
    },
    setPrefix: (value) => {
      if (!PREFIX_RE.test(value)) return `前缀只允许 [A-Za-z0-9._-]：${value}`;
      const root = rootOf();
      if (root === null) return unresolved();
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      // A prefix is one value in the config plus one line in the hook script.
      // Running the whole install pipeline for it would rewrite the managed
      // AGENTS.md region and re-register every module for a one-line change, and
      // scraping the report for a return value is not a contract.
      writeConfig(root, { ...config, worktreePrefix: value });
      const context = createContext({
        root,
        prefix: value,
        dry: false,
        report: () => {},
      });
      try {
        findModule("worktree")?.apply?.(context);
      } catch (error) {
        return `worktree 前缀 → ${value}，但钩子未更新：${error instanceof Error ? error.message : String(error)}`;
      }
      return `worktree 前缀 → ${value}（钩子已更新；已在运行的 worktree 不受影响）`;
    },
    subagentConcurrency: () => {
      const root = rootOf();
      return root === null ? null : readConfig(root)?.subagentConcurrency ?? null;
    },
    setSubagentConcurrency: (value) => {
      const root = rootOf();
      if (root === null) return unresolved();
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      const next: WorkflowConfig = { ...config };
      if (value === null) delete next.subagentConcurrency;
      else next.subagentConcurrency = value;
      writeConfig(root, next);
      return value === null
        ? "子 agent 并发上限 → 不限（本项目；不再拦截派单）"
        : `子 agent 并发上限 → ${value}（本项目；由 Coworkflow 在派单时拦截）`;
    },
    runBudgetMinutes: () => {
      const root = rootOf();
      const stored = root === null ? undefined : readConfig(root)?.subagentRunBudgetMs;
      return stored === undefined ? null : Math.round(stored / 60000);
    },
    setRunBudgetMinutes: (value) => {
      const root = rootOf();
      if (root === null) return unresolved();
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      const next: WorkflowConfig = { ...config };
      if (value === null) delete next.subagentRunBudgetMs;
      else next.subagentRunBudgetMs = value * 60000;
      writeConfig(root, next);
      return value === null
        ? `子 agent 运行上限 → 内置默认（${Math.round(RUN_BUDGET_MS / 60000)} 分钟）`
        : `子 agent 运行上限 → ${value} 分钟（本项目；下一次派单生效）`;
    },
    agentKinds: () => {
      const root = rootOf();
      // Through the project's definitions: a custom or renamed kind has to reach both
      // panels, and this is the one place they read the table from.
      return resolveKinds(root === null ? null : readConfig(root), readKindDefinitions(root).definitions);
    },
    setAgentKind: async (kind, patch) => {
      const root = rootOf();
      if (root === null) return unresolved();
      // Known means "shipped or defined by this project": the config may name a kind a
      // definition file provides, and refusing it would make the panel unable to configure
      // the very kinds this port exists for.
      const defined = readKindDefinitions(root).definitions;
      if (builtinKind(kind) === null && defined.get(kind) === undefined) {
        return `未知 kind：${kind}（本包随附 ${BUILTIN_KINDS.map((entry) => entry.kind).join("、")}；其它 kind 需要先在 ${DEFINITIONS_REL} 里定义）`;
      }
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      if (patch.maxConcurrent !== undefined && patch.maxConcurrent !== null &&
          (!Number.isInteger(patch.maxConcurrent) || patch.maxConcurrent < 1)) {
        return `并发上限需要 ≥ 1 的整数：${patch.maxConcurrent}`;
      }
      // Validated here, not on the next read: the decoder *drops* an unusable model,
      // so writing one would look applied in this session and be gone after a
      // reload. Refusing with a message is what lets the panel say why.
      if (patch.model !== undefined && patch.model !== null && !isKindModel(patch.model)) {
        return `模型 id 不可用：${JSON.stringify(patch.model)}（需要 1-${MAX_KIND_MODEL_LENGTH} 个字符、无空白前后缀与控制字符的 provider/id 或裸 id）`;
      }
      if (patch.thinking !== undefined && patch.thinking !== null && !isThinkingLevel(patch.thinking)) {
        return `未知思考等级：${JSON.stringify(patch.thinking)}（可用：${THINKING_LEVELS.join("、")}）`;
      }
      // An absent field keeps whatever the project already said, so toggling one
      // switch cannot silently reset the other value to its built-in default.
      const previous = config.agentKinds?.[kind] ?? {};
      const next: AgentKindConfig = { ...previous };
      if (patch.enabled !== undefined) next.enabled = patch.enabled;
      if (patch.maxConcurrent === null) delete next.maxConcurrent;
      else if (patch.maxConcurrent !== undefined) next.maxConcurrent = patch.maxConcurrent;
      // `null` deletes the key: absent is how a kind says "inherit", and the two
      // must not be able to disagree about it.
      if (patch.model === null) delete next.model;
      else if (patch.model !== undefined) next.model = patch.model;
      if (patch.thinking === null) delete next.thinking;
      else if (patch.thinking !== undefined) next.thinking = patch.thinking;
      writeConfig(root, { ...config, agentKinds: { ...config.agentKinds, [kind]: next } });
      // Same path as a module switch, then awaited: re-registering is what makes
      // an enabled kind exist in the agent list before the next dispatch, and a
      // report that says "已注册" must be reading a registration that happened.
      //
      // A gate still running in this session already re-reads the policy from disk
      // after its own public read, so the toggle also decides a dispatch that was
      // in flight — no restart, and no "applied but only for the next session".
      if (runtimeHost !== null) await syncAgentKinds(runtimeHost, runtime);
      const lines = runtimeHost === null ? [] : agentKindsModule.runtimeStatus?.(runtimeHost) ?? [];
      const resolved = resolveKinds(readConfig(root), readKindDefinitions(root).definitions)
        .find((entry) => entry.kind === kind);
      const state = `${kind}（${agentNameFor(kind)}）→ ${resolved?.enabled ? "on" : "off"}${
        resolved === undefined ? "" : `，上限 ${resolved.maxConcurrent}`
      }${kindModelLine(resolved)}`;
      // The registration outcome, not just the policy: "on" and "available in the
      // agent list" are two different facts and the panel shows both.
      // One vocabulary with the status line: a kind that cannot be used is reported as
      // 无法使用 there, and a panel that answered with a different phrase for the same fact
      // is how two surfaces start disagreeing about what happened.
      const failure = lines.find((line) => line.includes(`${kind} 无法使用`));
      const registered = lines.some((line) => line.includes(agentNameFor(kind)) && line.includes("已注册"));
      return failure !== undefined
        ? `${state}；但无法使用：${failure.replace(/^\s*[x!=-]\s*agent-kinds:\s*/, "")}`
        : resolved?.enabled === true && !registered
          ? `${state}；无法使用（原因见「子 agent 类型」下的状态行）`
          : `${state}（本会话已生效，无需重启）`;
    },
    defineKind: async (kind, patch) => {
      const root = rootOf();
      if (root === null) return unresolved();
      // A whole file hands over its own bytes: the definition is a markdown document, and a
      // re-render would drop the author's headings, comments and spacing.
      const from = patch.__from;
      if (typeof from === "string") {
        let text: string;
        try {
          text = readFileSync(from, "utf-8");
        } catch (error) {
          return `${kind} 未写入：无法读取 ${from}（${error instanceof Error ? error.message : String(error)}）`;
        }
        const verbatim = writeDefinitionFile(root, kind, text);
        if (!verbatim.ok) return `${kind} 未写入：${verbatim.reason}`;
        if (runtimeHost !== null) await syncAgentKinds(runtimeHost, runtime);
        const resolvedEntry = resolveKinds(readConfig(root), readKindDefinitions(root).definitions)
          .find((entry) => entry.kind === kind);
        return `${kind} 已按 ${from} 写入 ${verbatim.path}（${
          resolvedEntry === undefined ? "但当前无法解析" : `agent ${resolvedEntry.agent}，${resolvedEntry.enabled ? "on" : "off"}`
        }）`;
      }
      const existing = readKindDefinitions(root).definitions.get(kind);
      const written = writeKindDefinition(root, kind, patch, existing);
      if (!written.ok) return `${kind} 未写入：${written.reason}`;
      if (runtimeHost !== null) await syncAgentKinds(runtimeHost, runtime);
      const kinds = resolveKinds(readConfig(root), readKindDefinitions(root).definitions);
      const entry = kinds.find((candidate) => candidate.kind === kind);
      return entry === undefined
        ? `${kind} 已写入 ${DEFINITIONS_REL}/${kind}.md，但当前无法解析（检查 frontmatter）`
        : `${kind}（${entry.agent}）已写入 ${DEFINITIONS_REL}/${kind}.md：${
            entry.enabled ? "on" : "off"
          }，上限 ${entry.maxConcurrent}${kindModelLine(entry)}（本会话已生效，无需重启）`;
    },
    removeKind: async (kind) => {
      const root = rootOf();
      if (root === null) return unresolved();
      const path = join(definitionsDir(root), `${kind}.md`);
      // Only inside the definitions directory, and only a file: this command deletes, and a
      // path built from user input is exactly where that goes wrong.
      if (!path.startsWith(definitionsDir(root) + sep) || !existsSync(path)) {
        return `${kind} 没有项目定义文件（随附的 kind 只能关掉，不能删除）`;
      }
      try {
        rmSync(path);
      } catch (error) {
        return `${kind} 未能删除：${error instanceof Error ? error.message : String(error)}`;
      }
      if (runtimeHost !== null) await syncAgentKinds(runtimeHost, runtime);
      return builtinKind(kind) === null
        ? `${kind} 的项目定义已删除，该 kind 不再存在（本会话已生效）`
        : `${kind} 的项目定义已删除，回到本包随附的定义（本会话已生效）`;
    },
    agentKindStatus: () => (runtimeHost === null ? [] : agentKindsModule.runtimeStatus?.(runtimeHost) ?? []),
    settleAgentKinds: () => (runtimeHost === null ? Promise.resolve() : syncAgentKinds(runtimeHost, runtime)),
    // Registration of the workflow resources is asynchronous, so a report built the
    // instant a session starts said "工作流资源…未注册" about registrations that were
    // simply still in flight. Awaiting them is what makes the line a fact.
    settleSubagents: () => (runtimeHost === null ? Promise.resolve() : syncSubagentsRuntime(runtimeHost, runtime)),
    init: (args) => runSetup(args, { cwd: rootOf() ?? runtime.cwd }, false),
  };
}

/**
 * The control surface of the session this extension was loaded into.
 *
 * Exposed so `scripts/verify.ts` can drive the panels against the real control
 * implementation instead of a stand-in.
 */
export function controlSurface(): WorkflowControl {
  return runtime.control;
}

export default function coworkflowExtension(pi: PiRuntimeHost): void {
  runtimeHost = pi;
  // A fresh factory call is a fresh extension runtime: whatever a previous one
  // registered belonged to the session it was loaded for.
  runtimeActive.length = 0;
  sessionActivated.length = 0;
  runtimeErrors.length = 0;
  const isChild =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.TRELLIS_SUBAGENT_CHILD === "1";
  // One resolver per extension runtime, never process-global: a lane or worktree
  // session resolves its own main checkout, and a replacement session starts from
  // a clean answer because the key includes `sessionEpoch`.
  const configRoots = createConfigRootResolver({ epoch: () => runtime.sessionEpoch });
  runtime = {
    isChild,
    enabled: false,
    loadState: "off",
    refresh: () => refreshSession(),
    cwd: process.cwd(),
    sessionId: process.env.PI_SESSION_ID ?? null,
    parentSessionId: process.env.PI_SUBAGENT_PARENT_SESSION ?? null,
    sessionEpoch: 0,
    configRoots,
    control: createControl(),
  };

  // The project's consent is read at load; the session id and any session flag
  // only arrive with the first session event.
  {
    const resolved = resolveLoadState(runtime.cwd);
    runtime.enabled = resolved.enabled;
    runtime.loadState = resolved.state;
  }

  // Refresh before module hooks read their gates. Keep this single host listener
  // inert after shutdown until the next session starts.
  let sessionEnded = false;
  pi.on?.("before_agent_start", () => {
    if (!sessionEnded) runtime.refresh();
  });

  /**
   * Register the runtime modules this session may use.
   *
   * An adopted project always gets the `alwaysActive` control surfaces (the
   * settings and model panels) plus, when the layer is on, the rest. A session
   * that starts with the layer *off* still registers nothing that acts on the
   * model — `ensureRuntime` adds those the moment `/Coworkflow:start` turns it
   * on, which is what used to require a reload.
   */
  ensureRuntime();
  // A session that starts with the layer on (autoEnable, or its own flag from an
  // earlier `/Coworkflow:start`) also gets the feature commands right away.
  if (runtime.enabled) activateSession();

  /**
   * Re-resolve the session scope whenever Pi says the session started.
   *
   * `session_start` fires on a fresh session, on `/reload`, and on a session
   * replacement, and it carries the real session id — which the load-time
   * resolution did not have yet. This is the difference between "my project
   * auto-enables" and "this session asked for the workflow": after `/reload`, the
   * flag written by `/Coworkflow:start` must still apply, and a session that never
   * asked must stay plain Pi even if the project auto-enables.
   *
   * Identity is updated before anything reads it: the epoch moves first, so a
   * module holding per-session state knows to rebuild, and every dependent hook
   * sees the new session id and cwd.
   */
  pi.on?.("session_start", (_event: any, ctx: any) => {
    sessionEnded = false;
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd;
    const id = sessionIdOf(ctx, runtime);
    // Identity first, then everything that depends on it: the epoch moves before
    // any dependent hook runs, and `notifyRuntimeChange` below is what re-registers
    // session-scoped upstream resources for the new id.
    runtime.sessionEpoch += 1;
    if (id) runtime.sessionId = id;
    runtime.cwd = cwd;
    // The session boundary is where a stale root must not survive: the epoch in
    // the resolver key already forces a re-resolution, and dropping the memo here
    // makes that explicit rather than incidental.
    runtime.configRoots.invalidate();
    const resolved = resolveLoadState(cwd);
    runtime.enabled = resolved.enabled;
    runtime.loadState = resolved.state;
    ensureRuntime();
    if (runtime.enabled) activateSession();
    notifyRuntimeChange();
    return refreshUsage(pi, runtime, ctx);
  });

  pi.on?.("agent_settled", (_event: unknown, ctx: any) => refreshUsage(pi, runtime, ctx));
  pi.on?.("message_end", (event: any, ctx: any) => {
    if (decodeNativeCompletions(event?.message).length > 0) return refreshUsage(pi, runtime, ctx);
    return undefined;
  });

  /**
   * Release session-scoped state on quit, `/reload`, and session replacement.
   *
   * A listener registered for one session would otherwise keep acting in the
   * next one — for a child injector that means injecting the finished child's
   * context into whoever runs here later.
   */
  pi.on?.("session_shutdown", () => {
    sessionEnded = true;
    endSession();
    return undefined;
  });

  const setupHandler =
    (forceDry: boolean) =>
    async (args: string, ctx: CommandContext): Promise<void> => {
      runtime.refresh();
      // Let the asynchronous registrations finish before describing them: a report that
      // races its own setup is a wrong report, and "未注册" is exactly the kind of wrong
      // that sends the reader off to fix something that is not broken.
      await controlSurface().settleSubagents();
      await controlSurface().settleAgentKinds();
      const text = runSetup(args, ctx, forceDry);
      try {
        pi.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
      } catch {
        // A command can run outside a session context.
      }
      // In the TUI the message above renders in the transcript; in print mode
      // nothing renders, so a terminal user would otherwise see no report at
      // all. stderr is Pi's own channel for extension-side output.
      if (ctx?.mode !== "tui") report(text);
    };

  pi.registerCommand?.(`${NS}:init`, {
    description:
      `初始化/刷新本项目的 Coworkflow 层（模块：${moduleIds()}）；--enable/--disable <id,...> 改模块开关，--auto-enable on|off 改新会话是否自动加载，--trellis-update 代跑 \`trellis update -s\`，--prefix <p> 改 worktree 前缀，--dry-run 只报告`,
    handler: setupHandler(false),
  });

  pi.registerCommand?.(`${NS}:status`, {
    description:
      "查看本项目是否已初始化、模块开关、自动加载、安装产物与本会话是否已加载 Coworkflow（不改动任何文件）",
    handler: setupHandler(true),
  });

  /**
   * `/Coworkflow:kind` — the DIY surface for subagent kinds.
   *
   * Deliberately a command and not only a file format: an agent that wants to define a kind
   * has to be able to do it through something that validates first and says what it changed.
   * Hand-writing frontmatter works too, and both go through the same writer.
   */
  pi.registerCommand?.(`${NS}:kind`, {
    description:
      `子 agent 类型（kind）的 DIY 端口：list / show <kind> / set <kind> key=value… / remove <kind>；定义写在 ${DEFINITIONS_REL}/<kind>.md，改完本会话立即生效`,
    handler: async (args: string, ctx: CommandContext) => {
      const text = await runKindCommand(args, ctx);
      try {
        pi.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
      } catch {
        // Same as the other commands: a host without sendMessage still gets the report below.
      }
      if (ctx?.mode !== "tui") report(text);
    },
  });

  pi.registerCommand?.(`${NS}:start`, {
    description:
      `在本会话加载 Coworkflow（子 agent 的 Trellis 注入、/${NS}:lanes、/Comodels）；off 卸载本会话，status 查看状态。不改项目配置`,
    handler: (args: string, ctx: CommandContext) => {
      const text = runStart(args, ctx);
      try {
        pi.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
      } catch {
        // Same as above.
      }
      if (ctx?.mode !== "tui") report(text);
    },
  });
}
