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
 *   modules/agents-md/         the AGENTS.md constraint region (policy)
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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ModuleContext,
  PiRuntimeHost,
  RuntimeContext,
  Status,
  WorkflowControl,
} from "../core/module.ts";
import { createContext, renderModule } from "../core/module.ts";
import type { WorkflowConfig } from "../core/config.ts";
import {
  configPath,
  configRoot,
  describeSwitches,
  isEnabled,
  readConfig,
  writeConfig,
} from "../core/config.ts";
import { sessionFlag, setSessionFlag } from "../core/trellis.ts";
import { activeRunsForSession } from "../core/capacity.ts";
import { nearestTrustDecision, trustFilePath, trustProject } from "../core/trust.ts";
import { MODULES, moduleIds } from "../modules/index.ts";
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
  control: {
    initialized: () => false,
    switches: () => ({}),
    moduleIds: () => ALL_IDS,
    autoEnable: () => false,
    prefix: () => DEFAULT_PREFIX,
    facts: () => [],
    setSwitch: () => "control 尚未就绪",
    setAutoEnable: () => "control 尚未就绪",
    loadState: () => "off",
    setPrefix: () => "control 尚未就绪",
    subagentConcurrency: () => null,
    setSubagentConcurrency: () => "control 尚未就绪",
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
/** Resolve both the switch and the reason for it. */
function resolveLoadState(cwd: string): { enabled: boolean; state: RuntimeContext["loadState"] } {
  const root = configRoot(cwd);
  const config = readConfig(root);
  if (config === null) return { enabled: false, state: "off" };
  if (runtime.isChild) {
    const flag = sessionFlag(root, runtime.parentSessionId);
    const enabled = flag ?? config.autoEnable === true;
    return { enabled, state: enabled ? "child" : "off" };
  }
  const flag = sessionFlag(root, runtime.sessionId);
  if (flag !== undefined) return { enabled: flag, state: flag ? "started" : "off" };
  return config.autoEnable === true ? { enabled: true, state: "auto" } : { enabled: false, state: "off" };
}

function resolveEnabled(cwd: string): boolean {
  const root = configRoot(cwd);
  const config = readConfig(root);
  if (config === null) return false;

  // pi-subagents' runner exports PI_SUBAGENT_PARENT_SESSION before any session
  // event, so a child can resolve its flag from the very first load. The parent's
  // own session id only arrives with `session_start` (and again on `/reload`),
  // which is why the session-scoped parts are re-evaluated there.
  const id = runtime.isChild ? runtime.parentSessionId : runtime.sessionId;
  const flag = sessionFlag(root, id);
  if (flag !== undefined) return flag;
  return config.autoEnable === true;
}

/**
 * Re-resolve the switch and, if it just turned on, register the feature commands.
 *
 * Called at the start of every command and every agent turn, so a `/reload`, a
 * `/Coworkflow:start` from another window, or a flag written a moment ago all
 * take effect without a restart. Cheap: one small JSON read.
 */
function refreshSession(): void {
  const resolved = resolveLoadState(runtime.cwd);
  const was = runtime.enabled;
  runtime.enabled = resolved.enabled;
  runtime.loadState = resolved.state;
  if (runtime.enabled && !was) activateSession();
}

function runtimeReport(): string | null {
  const runtimes = MODULES.filter((module) => module.activate);
  if (runtimes.length === 0) return null;
  return [
    `[runtime] 本会话（isChild=${runtime.isChild ? "true" : "false"}，Coworkflow ${runtime.enabled ? "已加载" : "未加载"}）`,
    ...runtimes.map((module) => {
      if (!runtimeActive.includes(module.id)) {
        return `  - ${module.id} 未注册（本会话加载时未启用，/${NS}:start 后生效）`;
      }
      if (module.alwaysActive) return `  = ${module.id} 常驻`;
      return runtime.enabled
        ? `  = ${module.id} 已注册并生效`
        : `  = ${module.id} 已注册（未加载：不生效，/${NS}:start 打开）`;
    }),
    ...runtimeErrors.map((entry) => `  x ${entry}`),
  ].join("\n");
}

/** Register the feature commands a module only exposes while the layer is on. */
function activateSession(): void {
  for (const module of MODULES) {
    if (!module.onSessionActivate || sessionActivated.includes(module.id)) continue;
    if (!isEnabled(readConfig(configRoot(runtime.cwd)), module.id)) continue;
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

function runSetup(args: string, ctx: CommandContext, forceDry: boolean): string {
  const parsed = parseArgs(args);
  if (parsed.error) return parsed.error;

  const cwd = ctx.cwd ?? process.cwd();
  const root = gitRoot(cwd);
  const dry = forceDry || parsed.dry;
  const existing = readConfig(root);
  const firstInstall = existing === null;

  // Switches: an uninitialized project defaults to everything on, so one init
  // installs the whole layer; `--enable`/`--disable` then persist. A module
  // missing from an existing config is one that was added later, so it starts
  // on as well — `isEnabled` treats only an explicit `false` as off.
  const switches: Record<string, boolean> = {};
  for (const id of ALL_IDS) {
    switches[id] = firstInstall ? true : isEnabled(existing, id);
  }
  for (const id of parsed.enable) switches[id] = true;
  for (const id of parsed.disable) switches[id] = false;

  const autoEnable = parsed.autoEnable ?? existing?.autoEnable === true;
  const prefix =
    parsed.prefix ?? existing?.worktreePrefix ?? installedPrefix(root) ?? DEFAULT_PREFIX;
  const enabled = MODULES.filter((module) => switches[module.id] === true);
  // Only a module that was on and is now off has artifacts to take back.
  const switchedOff = MODULES.filter(
    (module) => switches[module.id] !== true && isEnabled(existing, module.id),
  );

  const blocks: string[] = [
    `${dry ? "体检（未改动任何文件）" : firstInstall ? "初始化本项目" : "刷新本项目"} — ${root}`,
    `  配置: ${configPath(root)}${firstInstall ? "（不存在）" : ""}`,
    `  开关: ${describeSwitches({ version: 1, modules: switches }, ALL_IDS)}`,
    `  自动加载: ${autoEnable ? "on（新会话直接加载 Coworkflow）" : `off（新会话需 /${NS}:start）`}`,
  ];
  const totals: Partial<Record<Status, number>> = {};

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

  if (!dry) {
    writeConfig(root, {
      version: 1,
      installedAt: new Date().toISOString(),
      worktreePrefix: prefix,
      ...(autoEnable ? { autoEnable: true } : {}),
      modules: switches,
    });
  }

  const runModule = (module: (typeof MODULES)[number], action: "apply" | "remove"): void => {
    const steps: { status: Status; message: string }[] = [];
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
      },
    });
    try {
      if (action === "apply") module.apply?.(context);
      else module.remove?.(context);
    } catch (error) {
      context.report("error", `模块异常：${error instanceof Error ? error.message : String(error)}`);
    }
    if (steps.length > 0) blocks.push(renderModule(module, steps));
  };

  for (const module of enabled) {
    if (module.apply) runModule(module, "apply");
  }
  for (const module of switchedOff) {
    if (module.remove) runModule(module, "remove");
  }

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

function runStart(args: string, ctx: CommandContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  const root = configRoot(cwd);
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
  if (on) activateSession();

  if (!sessionId) {
    return `本会话 Coworkflow → ${on ? "已加载" : "未加载"}，但拿不到 session id：子 agent 不会跟随本会话状态，建议 /${NS}:init --auto-enable on。`;
  }
  // Stamp the flag under *every* id this session can be known by. Pi exposes the
  // session id on the command context, but a hook can also arrive with the env
  // id or none at all, and `/reload` resolves the flag from whichever it has —
  // so one id written and another read is exactly how a session silently falls
  // back to "not loaded". Writing both ids (and remembering them) removes the
  // guesswork.
  const knownIds = new Set<string>([sessionId]);
  if (runtime.sessionId) knownIds.add(runtime.sessionId);
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
 * pi-subagents' own capacity limit, read for display only.
 *
 * It lives in pi-subagents' user-level config file and has no project override,
 * which is why this package enforces a project limit itself instead of writing
 * here. Shown in the settings panel so both numbers are visible at once.
 */
function readPiSubagentsLimit(): number | null {
  const file = join(homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  try {
    const value = (JSON.parse(raw) as { maxActiveAsyncRunsPerSession?: unknown })
      .maxActiveAsyncRunsPerSession;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The parent session file path, which is what pi-subagents records per run. */
function sessionFileOf(ctx: any): string | null {
  const file = ctx?.sessionManager?.getSessionFile?.();
  return typeof file === "string" && file ? file : null;
}

/** The control surface the panels use; same operations as the slash commands. */
function createControl(): WorkflowControl {
  const rootOf = (): string => configRoot(runtime.cwd);
  return {
    initialized: () => readConfig(rootOf()) !== null,
    switches: () => {
      const config = readConfig(rootOf());
      const switches: Record<string, boolean> = {};
      for (const id of ALL_IDS) switches[id] = isEnabled(config, id);
      return switches;
    },
    moduleIds: () => ALL_IDS,
    autoEnable: () => readConfig(rootOf())?.autoEnable === true,
    prefix: () => readConfig(rootOf())?.worktreePrefix ?? installedPrefix(rootOf()) ?? DEFAULT_PREFIX,
    facts: () => {
      const root = rootOf();
      const config = readConfig(root);
      const own = readPiSubagentsLimit();
      const sessionFile = sessionFileOf(null);
      const active = runtime.enabled ? activeRunsForSession(sessionFile) : [];
      return [
        `配置: ${configPath(root)}${config === null ? "（不存在）" : ""}`,
        `初始化于: ${config?.installedAt ?? "-"}`,
        `本会话: ${runtime.enabled ? "已加载" : `未加载（/${NS}:start）`}`,
        `pi-subagents 自身上限: ${own === null ? "不限（用户级配置）" : `${own}（用户级配置）`}`,
        `活跃 async run: ${active.length}${active.length > 0 ? `（${active.map((run) => run.agent ?? "?").join("、")}）` : ""}`,
      ];
    },
    setSwitch: (id, on) => {
      if (!ALL_IDS.includes(id)) return `未知模块：${id}`;
      const root = rootOf();
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
      const runtimeNote = RUNTIME_IDS.includes(id) ? "（运行时模块：重开会话生效）" : "";
      return `${id} → ${on ? "on" : "off"}${runtimeNote}`;
    },
    loadState: () => runtime.loadState,
    setAutoEnable: (on) => {
      const root = rootOf();
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
      const config = readConfig(root);
      if (config === null) return `本项目未初始化：先 /${NS}:init`;
      return runSetup(`--prefix ${value}`, { cwd: root }, false)
        .split("\n")
        .filter((line) => line.includes("前缀") || line.includes("worktree"))
        .slice(0, 1)
        .join("") || `worktree 前缀 → ${value}`;
    },
    subagentConcurrency: () => readConfig(rootOf())?.subagentConcurrency ?? null,
    setSubagentConcurrency: (value) => {
      const root = rootOf();
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
    init: (args) => runSetup(args, { cwd: rootOf() }, false),
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
  const isChild =
    process.env.PI_SUBAGENT_CHILD === "1" || process.env.TRELLIS_SUBAGENT_CHILD === "1";
  runtime = {
    isChild,
    enabled: false,
    loadState: "off",
    refresh: () => refreshSession(),
    cwd: process.cwd(),
    sessionId: process.env.PI_SESSION_ID ?? null,
    parentSessionId: process.env.PI_SUBAGENT_PARENT_SESSION ?? null,
    control: createControl(),
  };

  // The project's consent is read at load; the session id and any session flag
  // only arrive with the first session event.
  {
    const resolved = resolveLoadState(runtime.cwd);
    runtime.enabled = resolved.enabled;
    runtime.loadState = resolved.state;
  }

  for (const module of MODULES) {
    if (!module.activate) continue;
    const allowed = module.alwaysActive || runtime.enabled;
    if (!allowed && readConfig(configRoot(runtime.cwd)) === null) continue;
    try {
      module.activate(pi, runtime);
      runtimeActive.push(module.id);
    } catch (error) {
      // A broken runtime hook must not take the session down; the status report
      // names it instead.
      runtimeErrors.push(
        `${module.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // A session that starts with the layer on (autoEnable, or its own flag from an
  // earlier `/Coworkflow:start`) also gets the feature commands right away.
  if (runtime.enabled) activateSession();

  /**
   * Re-resolve the session scope whenever Pi tells us the session (again).
   *
   * `session_start` fires on a fresh session *and* on `/reload`, and it carries
   * the real session id — which the load-time resolution did not have yet. This
   * is the difference between "my project auto-enables" and "this session asked
   * for the workflow": after `/reload`, the flag written by `/Coworkflow:start`
   * must still apply, and a session that never asked must stay plain Pi even if
   * the project auto-enables.
   */
  pi.on?.("session_start", (_event: any, ctx: any) => {
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd;
    const id = sessionIdOf(ctx, runtime);
    if (id) runtime.sessionId = id;
    runtime.cwd = cwd;
    const resolved = resolveLoadState(cwd);
    runtime.enabled = resolved.enabled;
    runtime.loadState = resolved.state;
    if (runtime.enabled) activateSession();
    return undefined;
  });

  const setupHandler =
    (forceDry: boolean) =>
    (args: string, ctx: CommandContext): void => {
      runtime.refresh();
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
