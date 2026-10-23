/**
 * Module: the subagent layer — reuse what is installed, install per project.
 *
 * This package does not ship a subagent runtime. `pi-subagents` is the runtime,
 * and this module's whole job is to make sure the project has one and to point
 * it at the project rather than at the user's machine:
 *
 *   1. **Reuse.** If `pi-subagents` is declared in the user's settings, in the
 *      project's settings, or present in Pi's npm directory, the module reports
 *      where it came from and version, and installs nothing. A user who already
 *      has the extension keeps exactly one copy.
 *   2. **Install per project.** Only when it is missing everywhere does the
 *      module declare it in the project's own `.pi/settings.json`, so the
 *      dependency belongs to the project and disappears with it. Nothing is
 *      written to the user's settings.
 *   3. **Anchor discovery to the repository root.** Trellis worktrees are
 *      linked Git worktrees; `subagents.projectRootResolution: "git-root"` keeps
 *      project agent discovery on the repository instead of an incidental
 *      nested `.pi` inside a worktree.
 *
 * The launch-context default is deliberately *not* written anywhere. With no
 * global preference, `pi-subagents` already defaults to `fresh`, which is what a
 * Trellis role needs; the module only reports when the user's own config sets
 * `fork`, because that would silently hand a Trellis child the parent's prompt
 * instead of its role context.
 *
 * At runtime the module is the *bridge* to that runtime, through its public API
 * only (see `core/subagents-client.ts` and `core/subagents-workflow.ts`):
 *
 *   - it registers the `coworkflow.implement-review` workflow resource for the
 *     current session, so an implement→review pair has extension-owned
 *     provenance instead of being whatever script a caller typed;
 *   - it requires this package's own extension in the children of this session,
 *     because the child-side role context *is* an extension, and a runner that
 *     cannot load it must be refused instead of quietly launching a role-blind
 *     child;
 *   - it offers `/Coworkflow:run`, which resolves the current Trellis task and
 *     its recorded worktree and launches that workflow against it.
 *
 * Nothing here reads pi-subagents' run directory or starts its own runner.
 */

import { readFileSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, isAbsolute } from "node:path";
import type { ModuleContext, PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { userSettingsPath, userSubagentConfigPath } from "../../core/agentdir.ts";
import { readConfig } from "../../core/config.ts";
import { installedVersion, readUserConfig, subagentsPackageDir, decodeNativeCompletions } from "../../core/pi-subagents.ts";
import { mainCheckout, repoRoot, activeTaskDir, resolveTaskDir, taskRefForDisplay } from "../../core/trellis.ts";
import { attachSubagents, existingSubagentsBridge, type SubagentsBridge } from "../../core/subagents-client.ts";
import { fanoutPolicyFor, kindWorkflowAgents, syncAgentKinds } from "../agent-kinds/index.ts";
import { requestSteer, requestStop } from "./run-control.ts";
import { resolveKinds } from "../agent-kinds/defaults.ts";
import {
  FANOUT_NAME,
  WORKFLOW_NAME,
  dispatchOverlap,
  readTaskIdentity,
  recordLaunchLink,
  recordRunSettled,
  registerChildExtensionRequirement,
  registerImplementReviewWorkflow,
  validTaskRef,
  type PreparedWorkflowContext,
} from "../../core/subagents-workflow.ts";
import { formatDispatchFacts, formatOverlapLine } from "../../core/dispatch-timing.ts";

const PROJECT_SETTINGS = join(".pi", "settings.json");
const PACKAGE = "pi-subagents";
/** The command namespace; the orchestrator registers the same prefix. */
const NS = "Coworkflow";
/** Settings spec for an npm source, in the form `pi install` itself writes. */
const PACKAGE_SPEC = `npm:${PACKAGE}`;
const ROOT_RESOLUTION_KEY = "projectRootResolution";
const ROOT_RESOLUTION_VALUE = "git-root";

interface JsonObject {
  [key: string]: unknown;
}

/** This package's extension entry, which children must load (see below). */
function extensionEntryPath(): string {
  return fileURLToPath(new URL("../../extensions/coworkflow.ts", import.meta.url));
}

function readObject(ctx: ModuleContext, path: string): JsonObject | null {
  const raw = ctx.read(path);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as JsonObject;
  } catch {
    ctx.report("warn", `${path} 不是合法的 JSON 对象，未改动`);
    return null;
  }
}

function writeObject(ctx: ModuleContext, path: string, value: JsonObject): void {
  ctx.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Where `pi-subagents` is already available, if anywhere. */
/**
 * Where pi-subagents stands, as three different facts.
 *
 * "The files are on disk" is not one of them being usable: Pi loads a package only
 * when a settings file **declares** it. A real session proved the difference — the
 * package sat in Pi's npm directory, nothing declared it, so no `subagent` tool
 * existed, while this module reported `复用已安装…未安装任何东西` and wrote nothing. A
 * green report over an absent tool is the failure this package keeps having to
 * remove, so the states are separated here instead of collapsed into "found".
 */
type PackageState =
  | { state: "declared"; where: "用户级 settings.json" | "项目级 .pi/settings.json" }
  | { state: "downloaded-only" }
  | { state: "absent" };

function packageState(ctx: ModuleContext): PackageState {
  const userSettings = readObject(ctx, userSettingsPath());
  if (declaresPackage(userSettings)) return { state: "declared", where: "用户级 settings.json" };
  const projectSettings = readObject(ctx, PROJECT_SETTINGS);
  if (declaresPackage(projectSettings)) return { state: "declared", where: "项目级 .pi/settings.json" };
  if (ctx.read(join(subagentsPackageDir(), "package.json")) !== null) return { state: "downloaded-only" };
  return { state: "absent" };
}

function declaresPackage(settings: JsonObject | null): boolean {
  if (settings === null) return false;
  const packages = settings.packages;
  if (!Array.isArray(packages)) return false;
  return packages.some((entry) => typeof entry === "string" && packageName(entry) === PACKAGE);
}

function packageName(spec: string): string {
  const withoutPrefix = spec.replace(/^npm:/, "");
  const at = withoutPrefix.lastIndexOf("@");
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
}

function reportContextDefault(ctx: ModuleContext): void {
  const config = readUserConfig();
  if (config === null) {
    ctx.report("warn", `${userSubagentConfigPath()} 不是合法的 JSON，未改动`);
    return;
  }
  if (config.defaultSubagentContext === "fork") {
    ctx.report(
      "warn",
      `你的 ${userSubagentConfigPath()} 设了 defaultSubagentContext: "fork"；Trellis 角色子会话必须显式 context: "fresh"，否则会继承主会话上下文而不是拿到角色上下文（本项目不写这个全局文件）`,
    );
    return;
  }
  ctx.report(
    "ok",
    config.defaultSubagentContext === undefined
      ? "子会话上下文默认 fresh（pi-subagents 自带默认；本项目不写全局配置）"
      : `子会话上下文默认 ${config.defaultSubagentContext}（来自你的全局配置；本项目不写它）`,
  );
}

/**
 * Count the children a dispatch call starts, from the call itself.
 *
 * A fanout names its tasks; `implement-review` runs two fixed steps; a direct dispatch is one child.
 * Counted from the request because that is the only place the number is stated — the runner reports
 * each child separately, and a number inferred from completions would silently miss the ones that
 * never complete.
 */
export function childrenOfCall(input: unknown): number {
  if (input === null || typeof input !== "object") return 1;
  const call = input as Record<string, unknown>;
  if (call.workflow === FANOUT_NAME) {
    const tasks = (call.args as Record<string, unknown> | undefined)?.tasks;
    return Array.isArray(tasks) ? tasks.length : 1;
  }
  if (call.workflow === WORKFLOW_NAME) return 2;
  return 1;
}

/**
 * Record that a dispatch started.
 *
 * Called for EVERY `subagent` call, task or not. Task-linked runs are additionally recorded by
 * lane-worktree, which is what gives them a task, a worktree and a lane; but tying the interval to
 * that record is why a dispatch with no task used to leave no trace at all.
 *
 * The run identity is not known yet — it arrives in the tool result — so the interval is started
 * here and attributed there, keyed by the one id both halves carry.
 */
function beginDispatch(host: PiRuntimeHost, runtime: RuntimeContext, event: { toolCallId?: unknown; input?: unknown }): void {
  const state = HOSTS.get(host);
  if (!state || runtime.isChild) return;
  const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (!callId) return;
  const input = event.input;
  const async = (input as Record<string, unknown> | null)?.async !== false;
  state.pending.set(callId, {
    startedAt: Date.now(),
    async,
    children: childrenOfCall(input),
    ...(typeof (input as Record<string, unknown> | null)?.workflow === "string"
      ? { workflow: String((input as Record<string, unknown>).workflow) }
      : {}),
  });
}

/**
 * Attribute a finished `tool_call` to its run and close or open its interval.
 *
 * The two halves settle differently and the difference is not cosmetic: an asynchronous dispatch's
 * result is a *launch receipt*, so the run is still going and the interval stays open; a foreground
 * dispatch or a failed launch is over when the result lands. Treating a receipt as an end would make
 * every async dispatch look like a zero-length one — which would then be counted as serial work.
 */
function settleDispatch(host: PiRuntimeHost, runtime: RuntimeContext, event: { toolCallId?: unknown; details?: unknown; isError?: unknown }): void {
  const state = HOSTS.get(host);
  if (!state || runtime.isChild) return;
  const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const record = callId === "" ? undefined : state.pending.get(callId);
  if (!record) return;
  state.pending.delete(callId);
  const root = runtime.configRoots.root(runtime.cwd);
  if (root === null) return;

  const details = event.details;
  const runId = details !== null && typeof details === "object" && typeof (details as { runId?: unknown }).runId === "string"
    ? (details as { runId: string }).runId
    : "";
  const failed = event.isError === true;
  // Counted here, not at the call: a refused or failed dispatch started nothing, and calling it a
  // dispatch would let a session that delegates nothing look like one that does.
  if (failed) {
    // And it gets no interval either: a dispatch that never ran has no place on a timeline, and
    // writing one would let a refused call prove "overlap" with a real run.
    state.facts.notStarted += 1;
    return;
  }
  const id = runId !== "" ? runId : `call:${callId}`;
  state.facts.dispatches += 1;
  state.facts.children += record.children;
  state.facts.lastDispatchAt = record.startedAt;
  const settled = !record.async;
  const now = new Date().toISOString();
  recordLaunchLink(root, {
    runId: id,
    taskRef: "",
    ...(record.workflow === undefined ? {} : { workflow: record.workflow }),
    ...(runtime.sessionId === null ? {} : { sessionId: runtime.sessionId }),
    startedAt: new Date(record.startedAt).toISOString(),
    ...(settled ? { settledAt: now } : {}),
  });
}

/**
 * The one line that says whether this session's dispatches overlapped.
 *
 * Read from the recorded links at render time, so it reports what happened rather
 * than what was believed to happen. Like every other status line here it is stored
 * state, never a message: a status line delivered as a user turn rewrites the run
 * it describes.
 */
/** What this session did, whether it dispatched or not. */
function factsLine(host: PiRuntimeHost, state: HostState): string[] {
  return [
    `  = subagents: ${formatDispatchFacts({
      ...state.facts,
      toolAvailable: subagentToolAvailable(host),
    })}`,
  ];
}

function overlapLine(state: HostState): string[] {
  try {
    const runtime = state.runtime;
    if (runtime === null) return [];
    const root = runtime.configRoots.root(runtime.cwd);
    if (root === null) return [];
    return [`  = subagents: ${formatOverlapLine(dispatchOverlap(root, runtime.sessionId))}`];
  } catch {
    // A status render must not take the report down with it.
    return [];
  }
}

/**
 * Which settings files declare pi-subagents, read at status time.
 *
 * A checklist ("check the declaration") costs the reader the investigation; the two
 * settings files are right there, so the status line states the finding instead. This
 * is what separates "no tool" from "no tool because nothing ever declared the package".
 */
export function declarationFinding(cwd: string): string {
  const read = (path: string): JsonObject | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
    } catch {
      return null;
    }
  };
  const user = read(userSettingsPath());
  const project = read(join(cwd, PROJECT_SETTINGS));
  const where: string[] = [];
  if (declaresPackage(user)) where.push("用户级 settings.json");
  if (declaresPackage(project)) where.push("项目 .pi/settings.json");
  if (where.length > 0) return `packages 里已声明（${where.join("、")}）`;
  return (
    "但两份 settings 的 packages 里都没有 pi-subagents —— 这是它没加载的直接原因：" +
    '把 "npm:pi-subagents" 加进 packages（用户级=所有项目，项目级=仅此项目）后重开 Pi；`pi list` 可核对'
  );
}

/**
 * Whether the `subagent` tool is actually declared to the model.
 *
 * The module's value is reuse: pi-subagents does the running, this layer points it at
 * Trellis. When the host does not declare the tool, everything below the guidance is
 * missing, so the honest report is the missing tool — not a green "已注册".
 */
export function subagentToolAvailable(host: { getActiveTools?(): string[] }): boolean | null {
  // A host that *throws* is as unable to answer as one that returns nothing, and Pi
  // does throw here: every action method is a stub that rejects calls made while the
  // extension is still loading. The claim of this function is "cannot say, do not
  // guess" — a throw must land on that answer rather than escaping into a report.
  let tools: unknown;
  try {
    tools = host.getActiveTools?.();
  } catch {
    return null;
  }
  if (!Array.isArray(tools)) return null; // host cannot say; do not guess either way
  return tools.includes("subagent");
}

/**
 * Re-declare a configured-but-inactive `subagent` tool.
 *
 * A session resumed from history that predates pi-subagents restores that history's tool
 * list, so a tool the project has configured sits present-but-inactive and every dispatch
 * instruction in the managed region becomes impossible to follow. The remedy used to be
 * `--tools +subagent,…` on every launch; the host can simply declare it again, which is
 * what enabling this module already asked for.
 *
 * Deliberately narrow: only when the tool is *configured* (so the package is loaded) and
 * *not active*. A tool that is not configured at all is a missing install, not this.
 */
export function reactivateSubagentTool(host: PiRuntimeHost): string | null {
  try {
    const active = host.getActiveTools?.();
    if (!Array.isArray(active) || active.includes("subagent")) return null;
    const configured = host.getAllTools?.()?.some((tool) => tool?.name === "subagent");
    if (configured !== true || typeof host.setActiveTools !== "function") return null;
    host.setActiveTools([...active, "subagent"]);
  } catch {
    // Same rule as above: a host that refuses to answer is not a host that needs
    // fixing, and this repair must never be the reason a session reports an error.
    return null;
  }
  return "  ~ subagents: 本会话历史里没有 subagent（恢复旧会话），已重新声明该工具";
}

export const subagentsModule: WorkflowModule = {
  id: "subagents",
  title: "subagent 层（复用已安装的 pi-subagents，缺失时项目级安装）",

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;
    const state = hostState(host);
    state.runtime = runtime;
    attachObservers(host, state, runtime);
    void syncSubagentsRuntime(host, runtime);
  },

  /**
   * Both live gates are read again: the session switch (`/Coworkflow:start off`)
   * withdraws the upstream registrations, and turning either back on reinstates
   * them in this same session, with no reload.
   */
  onRuntimeChange(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;
    hostState(host).runtime = runtime;
    void syncSubagentsRuntime(host, runtime);
  },

  /** `/Coworkflow:run` only exists while the session has the layer on. */
  onSessionActivate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;
    registerRunCommand(host, runtime);
    registerControlCommands(host, runtime);
    // Tool declarations belong to a session, not to loading: `setActiveTools` is an
    // action method and Pi refuses those while the extension is still being loaded
    // ("Action methods cannot be called during extension loading"). Doing this here
    // also means it happens once per session rather than once per process.
    const state = hostState(host);
    state.revivedTool = reactivateSubagentTool(host) !== null;
  },

  /**
   * Release the session-scoped registrations.
   *
   * The owner (pi-subagents) registers a workflow resource *per session* and
   * documents that the extension owns cleanup: a registration that outlives its
   * session either blocks the replacement (duplicate name) or resolves for the
   * wrong session. A registration still in flight is disowned rather than kept,
   * because it would belong to the session that just ended.
   */
  onSessionEnd(host: PiRuntimeHost, _runtime: RuntimeContext): void {
    const state = HOSTS.get(host);
    if (state) {
      // Withdraw rather than "dispose the handles": the generation moves with it,
      // so a registration still in flight disposes itself when it lands.
      withdraw(state);
      releaseListeners(state);
      state.runCommandRegistered = false;
      state.controlCommandsRegistered = false;
    }
    // The client's listeners belong to this session's RPC bridge too.
    existingSubagentsBridge(host)?.dispose();
  },

/** Stored state, read on demand: a passive status never becomes a message. */
  runtimeStatus(host: PiRuntimeHost): string[] | null {
    // The tool check comes first and stands on its own: it is the one fact that makes
    // every dispatch instruction in the managed region impossible to follow.
    const missing = subagentToolAvailable(host) === false
      ? [
          [
            "  ! subagents: 本会话没有 subagent 工具：派单不可用，子 agent 的上下文注入也不会发生。",
            `声明检查：${declarationFinding(HOSTS.get(host)?.runtime?.cwd ?? process.cwd())}。`,
            "工具在两处被恢复，两处都要处理：① Pi 先按本会话历史恢复工具列表——历史里没有 subagent，恢复后就没有，--exclude-tools 不会把它补回来；",
            "② pi-subagents 默认 auto，只给 subagents_enable 加载器，恢复旧会话时还沿用历史里保存的选择（/reload 改不动它）。",
            "完整启动参数：--exclude-tools subagents_enable --tools +subagent,+bg_wait,+contact_supervisor,+subagent_supervisor；",
            "长期等价写法：settings.json 的 defaultTools 里加这几项，或把 ",
            `${userSubagentConfigPath()} 的 toolActivation 设为 eager（这个键不在 settings.json 的 subagents 下）`,
          ].join(""),
        ]
      : [];
    const state = HOSTS.get(host);
    if (!state) return missing.length > 0 ? missing : null;
    const set = state.current;
    const session = set ? `（session ${set.sessionId.slice(0, 8)}）` : "";
    return [
      ...missing,
      `  ${set?.workflow ? "=" : "-"} subagents: 工作流资源 ${WORKFLOW_NAME}、${FANOUT_NAME} ${set?.workflow ? `已注册${session}` : "未注册"}`,
      `  ${set?.children ? "=" : "-"} subagents: 子会话必需扩展 ${set?.children ? "已登记" : "未登记（subagent-context 关闭或本会话未加载 Coworkflow 时不登记）"}`,
      ...(state.revivedTool
        ? ["  ~ subagents: 本会话历史里没有 subagent（恢复旧会话），已重新声明该工具"]
        : []),
      ...(set?.failure === undefined ? [] : [`  x subagents: ${set.failure}`]),
      ...factsLine(host, state),
      ...overlapLine(state),
    ];
  },

  apply(ctx: ModuleContext): void {
    const found = packageState(ctx);
    const version = installedVersion();
    if (found.state === "declared") {
      ctx.report("ok", `复用已安装的 ${PACKAGE}${version ? ` v${version}` : ""}（来自${found.where}），未安装任何东西`);
    } else if (ctx.dry) {
      ctx.report(
        "created",
        found.state === "downloaded-only"
          ? `${PACKAGE} 的文件已在 Pi 的 npm 目录里，但没有任何 settings 声明它 —— 把那一条声明写进项目 .pi/settings.json 的 packages（否则 Pi 不会加载它，subagent 工具也就不存在；需要项目信任 + 重开 Pi）`
          : `把 ${PACKAGE_SPEC} 声明到项目 .pi/settings.json 的 packages（项目级安装；Pi 下次启动时拉取，需要项目信任）`,
      );
    } else {
      const settings = readObject(ctx, PROJECT_SETTINGS);
      if (settings === null) return;
      const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
      packages.push(PACKAGE_SPEC);
      settings.packages = packages;
      writeObject(ctx, PROJECT_SETTINGS, settings);
      ctx.report(
        "created",
        found.state === "downloaded-only"
          ? `${PACKAGE} 的文件已在 Pi 的 npm 目录里，但没有被任何 settings 声明，所以它从未加载过（这正是本会话没有 subagent 工具的原因）。现已把 ${PACKAGE_SPEC} 写进项目 .pi/settings.json 的 packages：重开 Pi 后生效，且需要项目受信任`
          : `${PACKAGE_SPEC} 声明到项目 .pi/settings.json 的 packages（项目级；Pi 下次启动时拉取，需要项目信任才加载）`,
      );
    }

    const settings = readObject(ctx, PROJECT_SETTINGS);
    if (settings === null) return;
    const subagents =
      settings.subagents !== null && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...(settings.subagents as JsonObject) }
        : {};
    // Dynamic tool activation lives in pi-subagents' own config file, NOT in
    // `settings.subagents` — a real diagnosis went wrong by writing it to settings.json,
    // where nothing reads it, and then reloading repeatedly with no effect. The path is
    // the extension's own: <agent dir>/extensions/subagent/config.json, top-level key.
    const activationConfig = readUserConfig();
    const activation = activationConfig?.toolActivation;
    if (activation === "eager") {
      ctx.report("ok", `${userSubagentConfigPath()}: toolActivation = eager（subagent 从第一次请求就可用）`);
    } else {
      ctx.report(
        "warn",
        `toolActivation 不是 "eager"（当前 ${activation === undefined ? "未设置（上游默认 auto）" : String(activation)}，读自 ${userSubagentConfigPath()}）。auto 模式下新会话只给 subagents_enable 加载器，且**恢复旧会话时会沿用当时保存的工具声明**——历史里没有 loader 就不会补上，/reload 也救不回来。两条路：① 启动时加 --exclude-tools subagents_enable（入口被排除，subagent 直接可用）；② 在 ${userSubagentConfigPath()} 写 {"toolActivation": "eager"} 后重开 Pi。注意这个键**不在** settings.json 的 subagents 里，写在那里不会被读取`,
      );
    }

    if (subagents[ROOT_RESOLUTION_KEY] === ROOT_RESOLUTION_VALUE) {
      ctx.report("ok", `.pi/settings.json: subagents.${ROOT_RESOLUTION_KEY} = ${ROOT_RESOLUTION_VALUE}`);
    } else {
      subagents[ROOT_RESOLUTION_KEY] = ROOT_RESOLUTION_VALUE;
      settings.subagents = subagents;
      writeObject(ctx, PROJECT_SETTINGS, settings);
      ctx.report(
        "updated",
        `.pi/settings.json: subagents.${ROOT_RESOLUTION_KEY} = ${ROOT_RESOLUTION_VALUE}（worktree 里也按仓库根发现 agent）`,
      );
    }

    reportContextDefault(ctx);
  },

  remove(ctx: ModuleContext): void {
    const settings = readObject(ctx, PROJECT_SETTINGS);
    if (settings === null) return;

    // Drop the package declaration only when the user level still provides it,
    // so switching the module off never leaves the project without a runtime
    // that another project or session may still depend on.
    const userSettings = readObject(ctx, userSettingsPath());
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    if (declaresPackage(settings)) {
      if (declaresPackage(userSettings)) {
        settings.packages = packages.filter(
          (entry) => !(typeof entry === "string" && packageName(entry) === PACKAGE),
        );
        writeObject(ctx, PROJECT_SETTINGS, settings);
        ctx.report("updated", `已从项目 settings 移除 ${PACKAGE_SPEC}（用户级仍然提供，不影响其他项目）`);
      } else {
        ctx.report(
          "warn",
          `项目 settings 里的 ${PACKAGE_SPEC} 是唯一来源，保留它；要彻底移除跑 \`pi remove -l ${PACKAGE_SPEC}\``,
        );
      }
    }

    const subagents = settings.subagents;
    if (subagents === null || typeof subagents !== "object" || Array.isArray(subagents)) {
      if (!declaresPackage(settings)) ctx.report("ok", "项目 settings 里没有本模块写入的键");
      return;
    }
    const next = { ...(subagents as JsonObject) };
    delete next[ROOT_RESOLUTION_KEY];
    if (Object.keys(next).length === 0) delete settings.subagents;
    else settings.subagents = next;
    writeObject(ctx, PROJECT_SETTINGS, settings);
    ctx.report("updated", "已移除 .pi/settings.json 的 subagents.projectRootResolution");
  },
};

// ── Runtime: the workflow resource, the child requirement, `/Coworkflow:run` ──

/**
 * Per-host runtime state.
 *
 * Keyed by the host rather than kept in module variables: a host outlives one
 * session (and a `/reload` can load a second copy of this module into the same
 * process), so two sessions must never share one registration set, one
 * generation counter, or one in-flight promise.
 */
interface HostState {
  /** Bumped whenever the registrations we want are withdrawn or the session ends. */
  generation: number;
  /**
   * True when this session's restored tool list lacked `subagent` and it was re-declared.
   */
  revivedTool?: boolean;
  /**
   * What this session has done, counted where the calls pass.
   *
   * Counted here rather than derived later: a dispatch that is counted only when it has a task is
   * how eight hours of work with no delegation reads as nothing at all.
   */
  facts: {
    toolCalls: number;
    dispatches: number;
    children: number;
    /** Calls that never started a child: refused by a gate, or the launch itself failed. */
    notStarted: number;
    lastDispatchAt?: number;
  };
  /**
   * Dispatches whose `tool_call` was seen and whose run identity has not arrived yet.
   *
   * The run id exists only in the tool result, so the interval has to be started first and
   * attributed second. Keyed by `toolCallId`, which is the only id both halves share.
   */
  pending: Map<string, { startedAt: number; async: boolean; children: number; workflow?: string }>;
  /** The set we currently want, and the promise that builds it. */
  current: RegistrationSet | null;
  /** Hooks this module attached for this host, released on session end. */
  listeners: (() => void)[];
  /** True once the observation listeners are attached; see `attachObservers`. */
  observersAttached: boolean;
  /** True when a listener could not be released, so it must not be re-attached. */
  permanentListener: boolean;
  runCommandRegistered: boolean;
  /** `/Coworkflow:stop` and `/Coworkflow:steer`, registered with the same lifetime. */
  controlCommandsRegistered: boolean;
  /** The live runtime of the session this host is serving; refreshed on every activation. */
  runtime: RuntimeContext | null;
}

/** One workflow-resource + child-requirement pair, built for one session. */
interface RegistrationSet {
  sessionId: string;
  generation: number;
  /** Whether the child-side module was on when this set was built. */
  wantsChildren: boolean;
  root: string;
  prepared: PreparedWorkflowContext | null;
  workflow: { dispose(): void } | null;
  children: { dispose(): void } | null;
  /** Why registration did not happen, so `/Coworkflow:run` can refuse with it. */
  failure?: string;
  /** Settles when both registrations have been attempted, success or not. */
  done: Promise<void>;
}

const HOSTS = new WeakMap<PiRuntimeHost, HostState>();

function hostState(host: PiRuntimeHost): HostState {
  const existing = HOSTS.get(host);
  if (existing) return existing;
  const created: HostState = {
    generation: 0,
    current: null,
    listeners: [],
    observersAttached: false,
    permanentListener: false,
    runCommandRegistered: false,
    controlCommandsRegistered: false,
    runtime: null,
    facts: { toolCalls: 0, dispatches: 0, children: 0, notStarted: 0 },
    pending: new Map(),
  };
  HOSTS.set(host, created);
  return created;
}

function disposeQuietly(handle: { dispose(): void } | null): void {
  try {
    handle?.dispose();
  } catch {
    // Disposal is idempotent upstream; a throw must not escape a shutdown path.
  }
}

/**
 * A validated plan, carrying the agents the fixed workflow should run.
 *
 * The two step agents follow the project's kinds when one is enabled *and* live in
 * this session's agent list; otherwise the built-in pair stays. Read at plan time
 * rather than at registration, because the plan is what `resolve` hands to the
 * workflow, and a toggle in `/Coworkflow:settings` must reach this path with no
 * restart.
 */
function withKindAgents(
  host: PiRuntimeHost,
  root: string,
  plan: RunPlan,
): PreparedWorkflowContext {
  const config = readConfig(root);
  const budget = config?.subagentRunBudgetMs;
  return {
    ...plan,
    ...kindWorkflowAgents(host, resolveKinds(config)),
    // The project's run budget travels with the prepared context, so both workflows hand
    // upstream the number the project chose instead of the built-in default.
    ...(budget === undefined ? {} : { runBudgetMs: budget }),
  };
}

/** Withdraw the set we wanted: the registration goes, the generation moves. */
function withdraw(state: HostState): void {
  const current = state.current;
  state.current = null;
  state.generation += 1;
  if (current === null) return;
  disposeQuietly(current.children);
  disposeQuietly(current.workflow);
  current.children = null;
  current.workflow = null;
}

function releaseListeners(state: HostState): void {
  for (const unsubscribe of state.listeners.splice(0)) {
    try {
      unsubscribe();
    } catch {
      // A listener that cannot be removed must not break the shutdown path.
    }
  }
  // Only a listener that never had an unsubscribe is still attached afterwards.
  state.observersAttached = state.permanentListener;
}

/**
 * Make this host's registrations match the two live gates.
 *
 * Both gates are read here, at call time: `runtime.enabled` is the session switch
 * and `moduleEnabled("subagents")` is the project switch. Off means *withdraw*, not
 * "leave it registered and ignore it" — the owner registers these per session and
 * a withdrawn layer must not keep a resolvable workflow name or require this
 * extension in children.
 *
 * Same-session callers await the reconciliation that is already running instead
 * of observing a half-built set. A registration that finishes after the session it
 * was built for ended (or after the layer was switched off) is disposed by that
 * same check, so a late import cannot leave a handle behind.
 *
 * `sessionId` is passed explicitly by the command, which reads the id from its own
 * context: the orchestrator's identity is updated on `session_start`, and a command
 * that runs before that event (or in a host that never fires it) still knows which
 * session it is registering for.
 */
function schedule(state: HostState, runtime: RuntimeContext, host: PiRuntimeHost, explicitSessionId?: string): Promise<void> {
  const wanted = runtime.enabled && runtime.control.moduleEnabled("subagents");
  const sessionId = explicitSessionId ?? runtime.sessionId;
  if (!wanted || !sessionId) {
    // Nothing to build yet, or the layer just went off: withdraw and be done.
    if (state.current !== null) withdraw(state);
    return Promise.resolve();
  }
  // The child requirement is not unconditional: it says "refuse a launch that
  // cannot load this extension", which only makes sense while the child-side
  // module is on. A set built under the other answer has to be rebuilt.
  const wantsChildren = runtime.control.moduleEnabled("subagent-context");
  // The runtime's resolver: this runs on every reconciliation, and the uncached
  // pair spawns `git` three times. A null root means git could not answer, and
  // registering a workflow against a guessed root is worse than not registering.
  const root = runtime.configRoots.root(runtime.cwd);
  if (root === null) {
    if (state.current !== null) withdraw(state);
    return Promise.resolve();
  }
  const plan = planRun(root, null, activeTaskDir(root, sessionId));
  const prepared = plan.ok ? withKindAgents(host, root, plan) : null;

  const current = state.current;
  if (
    current !== null &&
    current.sessionId === sessionId &&
    current.generation === state.generation &&
    current.wantsChildren === wantsChildren && current.root === root
  ) {
    // Already the right set, or still building it: awaiting is what makes a
    // second caller see a complete set rather than a partial one.
    current.prepared = prepared;
    return current.done;
  }

  // A different session, or a rebuilt set: the old handles go first, and its
  // generation moves so a still-pending build disowns itself.
  withdraw(state);
  const token: RegistrationSet = {
    sessionId,
    generation: state.generation,
    wantsChildren,
    root,
    prepared,
    workflow: null,
    children: null,
    done: Promise.resolve(),
  };
  state.current = token;
  const live = (): boolean => state.current === token && state.generation === token.generation;

  token.done = (async () => {
    // Required guidance must be registered before a workflow can be resolved.
    if (wantsChildren) {
      const entry = extensionEntryPath();
      if (!existsAsFile(entry)) {
        token.failure = `找不到本扩展的入口 ${entry}：无法登记子会话必需扩展。`;
        return;
      }
      const children = await registerChildExtensionRequirement(sessionId, entry, root);
      if (!live()) { if (children.ok) disposeQuietly(children.registration); return; }
      if (!children.ok) { token.failure = children.message; return; }
      token.children = children.registration;
    }
    const workflow = await registerImplementReviewWorkflow(sessionId, {
      projectRoot: root,
      // Resolver callbacks may read only memory. moduleEnabled() reads project
      // settings, so schedule()/tool_call must evaluate those gates beforehand.
      context: () => live() && runtime.enabled && (!wantsChildren || token.children !== null) &&
        token.failure === undefined ? token.prepared : null,
      // The fanout's kind policy is resolved the same way and at the same moment:
      // in memory, from the project's config plus the owner's accepted kind
      // registrations, never by the resolver reading either.
      fanoutPolicy: () => fanoutPolicyFor(host, runtime),
    });
    if (!live()) { if (workflow.ok) disposeQuietly(workflow.registration); return; }
    if (workflow.ok) token.workflow = workflow.registration;
    else { token.failure = workflow.message; disposeQuietly(token.children); token.children = null; }
  })().catch((error: unknown) => {
    // A registration failure is stored, never thrown into an event handler.
    token.failure ??= `注册会话资源失败：${error instanceof Error ? error.message : String(error)}`;
  });
  return token.done;
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Reconcile this host's session-scoped registrations with the live gates, and
 * settle when the reconciliation is done.
 *
 * The orchestrator calls it (fire and forget) from `activate`,
 * `onRuntimeChange` and `/Coworkflow:start`; the command and the focused tests
 * await it because they need to know whether the resource actually exists. A
 * second caller in the same session awaits the build already in flight rather
 * than reading a half-built set.
 */
export function syncSubagentsRuntime(host: PiRuntimeHost, runtime: RuntimeContext): Promise<void> {
  if (runtime.isChild) return Promise.resolve();
  return schedule(hostState(host), runtime, host);
}

/**
 * The bridge this host's session owns, created or refreshed on demand.
 *
 * `sessionEpoch` is what makes a replacement session use a new client instead of
 * the previous session's disposed one, so it is read at call time and never
 * captured at load (the orchestrator's first `session_start` moves it to 1).
 */
function bridgeFor(host: PiRuntimeHost, runtime: RuntimeContext): SubagentsBridge {
  return attachSubagents(host, { epoch: runtime.sessionEpoch, events: host.events });
}

/** Everything `/Coworkflow:run` needs, or the exact reason it cannot proceed. */
interface RunPlan {
  ok: true;
  root: string;
  taskRef: string;
  worktree: string;
  mainCheckout: string;
  title?: string;
}
interface RunPlanFailure {
  ok: false;
  message: string;
}

/**
 * Resolve the current task and its recorded worktree.
 *
 * This is the half `resolve` cannot do (it may not touch the filesystem): the
 * task directory must exist, and `task.json` must record a worktree that really is
 * a directory and is not the main checkout. A task that was never started has no
 * worktree, and the answer is "start it", not "run in the main checkout".
 */
export function planRun(root: string, taskDirRef: string | null, taskDir: string | null): RunPlan | RunPlanFailure {
  if (taskDir === null) {
    return {
      ok: false,
      message: taskDirRef
        ? `任务引用 ${taskDirRef} 解析不到存在的任务目录（${root}）：先 \`trellis task start\` 或修正引用。`
        : `当前会话没有活跃的 Trellis 任务（${root}）：先 \`trellis task start <name>\`（或 \`/trellis:start\`）选定任务。`,
    };
  }
  const taskRef = taskRefForDisplay(root, taskDir);
  if (!validTaskRef(taskRef) || (taskDirRef !== null && [".", ".."].includes(taskDirRef.replace(/\\/g, "/").split("/").pop() ?? ""))) {
    return { ok: false, message: "任务引用必须是 .trellis/tasks/<name>，不能是 '.' 或 '..'。" };
  }
  const identity = readTaskIdentity(root, taskRef);
  if (identity === null) {
    return { ok: false, message: `${taskRef}/task.json 不可读或不是合法 JSON 对象：无法确认任务身份与隔离 worktree。` };
  }
  if (identity.worktree === null) {
    return {
      ok: false,
      message: [
        `${taskRef} 还没有隔离 worktree（task.json 里没有 worktree_path）。`,
        "Coworkflow 的实现在任务的独立 worktree 里跑，不在主 checkout 里跑：先 `trellis task start`（会触发 after_start 钩子建 worktree），再运行本命令。",
      ].join(""),
    };
  }
  let worktree: string;
  let main: string;
  try {
    if (!isAbsolute(identity.worktree) || !statSync(identity.worktree).isDirectory()) throw new Error("directory");
    worktree = realpathSync(identity.worktree);
    main = realpathSync(mainCheckout(repoRoot(root)));
  } catch {
    return { ok: false, message: `${taskRef} 记录的工作树不存在或不是目录：${identity.worktree}` };
  }
  if (worktree === main) return { ok: false, message: `${taskRef}：拒绝在主 checkout 里跑实现（${main}）。` };
  if (!identity.branch) return { ok: false, message: `${taskRef}/task.json 没有 branch，无法确认工作树归属。` };
  try {
    const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (realpathSync(git(worktree, ["rev-parse", "--show-toplevel"])) !== worktree ||
        realpathSync(git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
        realpathSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) throw new Error("not a linked worktree in this repository");
    const blocks = git(main, ["worktree", "list", "--porcelain", "-z"]).split("\0\0");
    const expectedBranch = identity.branch.startsWith("refs/heads/") ? identity.branch : `refs/heads/${identity.branch}`;
    const member = blocks.find((block) => {
      const path = block.split("\0").find((line) => line.startsWith("worktree "))?.slice(9);
      try { return path !== undefined && realpathSync(path) === worktree; } catch { return false; }
    });
    if (!member?.split("\0").includes(`branch ${expectedBranch}`) || git(worktree, ["symbolic-ref", "HEAD"]) !== expectedBranch) {
      throw new Error("worktree membership or task branch mismatch");
    }
    return { ok: true, root: main, taskRef, worktree, mainCheckout: main,
      ...(identity.title ? { title: identity.title } : {}) };
  } catch (error) {
    return { ok: false, message: `${taskRef} 工作树 Git 归属/任务分支校验失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseRunArgs(args: string): { focus?: string } | { error: string } {
  const trimmed = args.trim();
  if (!trimmed) return {};
  // Free text is a review focus; it is passed through as data, never as code.
  if (trimmed.length > 2000) return { error: "复核重点过长（最多 2000 字符）" };
  return { focus: trimmed };
}

/**
 * `<runId> [rest]`, or the reason the arguments cannot name a run.
 *
 * The run id is a single token; everything after it is free text (instructions),
 * passed on as data. An empty id is refused here, before any RPC: a control call
 * with no target would either act on "the newest run" or fail upstream, and
 * neither is what the user asked for.
 */
export function parseControlArgs(
  args: string,
  options: { instructionsRequired: boolean },
): { runId: string; instructions: string } | { error: string } {
  const trimmed = args.trim();
  if (!trimmed) return { error: "缺少 runId：用法见 /Coworkflow:stop <runId> [instructions] 与 /Coworkflow:steer <runId> <instructions>。" };
  const split = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const runId = split?.[1] ?? "";
  const instructions = (split?.[2] ?? "").trim();
  if (!runId) return { error: "runId 不能为空。" };
  if (options.instructionsRequired && !instructions) {
    return { error: `缺少指令：用法 /Coworkflow:steer ${runId} <instructions>。` };
  }
  if (instructions.length > 4000) return { error: "指令过长（最多 4000 字符）。" };
  return { runId, instructions };
}

/**
 * `/Coworkflow:stop <runId> [instructions]` and `/Coworkflow:steer <runId> <instructions>`.
 *
 * The general control commands: they accept any run id this session's owner will
 * act on, so a run started by `/Coworkflow:run`, by a plain dispatch, or by another
 * Coworkflow command is reachable. Ownership and lifecycle stay upstream's — the
 * owner rejects a foreign or already-terminal target in its own words, and those
 * words are what the user reads.
 *
 * Both commands are capability-honest: when the installed owner does not advertise
 * the method, nothing is sent and the command says exactly that.
 */
function registerControlCommands(host: PiRuntimeHost, runtime: RuntimeContext): void {
  const state = hostState(host);
  if (state.controlCommandsRegistered) return;
  state.controlCommandsRegistered = true;
  const say = (text: string, ctx: any): void => {
    try {
      host.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
    } catch {
      // Fall through to the console path.
    }
    if (ctx?.mode !== "tui") {
      try {
        console.error(text);
      } catch {
        // stderr unavailable.
      }
    }
  };

  host.registerCommand?.(`${NS}:stop`, {
    description:
      "请求停止一个异步 run（接受≠终止：会再读一次公开状态并把两件事分开说）；可选 instructions 会先作为 steer 指令送达再停止。run 的归属与生命周期仍由 pi-subagents 判定",
    handler: async (args: string, ctx: any) => {
      runtime.refresh();
      if (!runtime.enabled) { say(`本会话未加载 Coworkflow：先运行 /${NS}:start`, ctx); return; }
      if (!runtime.control.moduleEnabled("subagents")) {
        say("本项目把 subagents 模块关掉了：`/Coworkflow:settings` 打开它之后才能控制 run。", ctx);
        return;
      }
      const parsed = parseControlArgs(args, { instructionsRequired: false });
      if ("error" in parsed) { say(parsed.error, ctx); return; }
      const lines: string[] = [];
      if (parsed.instructions) {
        // Instructions first, then the stop: the caller asked for both, and
        // reporting each outcome separately is the only way neither is implied.
        const steered = await requestSteer(host, runtime, parsed.runId, parsed.instructions);
        lines.push(...steered.lines, "");
      }
      const report = await requestStop(host, runtime, parsed.runId);
      say([...lines, ...report.lines].join("\n"), ctx);
    },
  });

  host.registerCommand?.(`${NS}:steer`, {
    description:
      "给一个正在运行的异步 run 追加指令（不杀进程，也不是新派单）；指令只作为数据传给 pi-subagents",
    handler: async (args: string, ctx: any) => {
      runtime.refresh();
      if (!runtime.enabled) { say(`本会话未加载 Coworkflow：先运行 /${NS}:start`, ctx); return; }
      if (!runtime.control.moduleEnabled("subagents")) {
        say("本项目把 subagents 模块关掉了：`/Coworkflow:settings` 打开它之后才能控制 run。", ctx);
        return;
      }
      const parsed = parseControlArgs(args, { instructionsRequired: true });
      if ("error" in parsed) { say(parsed.error, ctx); return; }
      const report = await requestSteer(host, runtime, parsed.runId, parsed.instructions);
      say(report.lines.join("\n"), ctx);
    },
  });
}

/**
 * `/Coworkflow:run [复核重点]` — launch the implement → review workflow.
 *
 * The command never falls back to a foreground/CLI launch: if the public bridge is
 * unusable the answer says why, because starting a process is not evidence that
 * the task was delivered.
 */
function registerRunCommand(host: PiRuntimeHost, runtime: RuntimeContext): void {
  const state = hostState(host);
  if (state.runCommandRegistered) return;
  state.runCommandRegistered = true;

  host.registerCommand?.(`${NS}:run`, {
    description:
      "用 pi-subagents 的原生工作流跑「实现 → 独立复核」（coworkflow.implement-review）：在当前 Trellis 任务的隔离 worktree 里执行，复核不通过就失败；不自动合并、不自动清理",
    handler: async (args: string, ctx: any) => {
      runtime.refresh();
      const say = (text: string): void => {
        try {
          host.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
        } catch {
          // Fall through to the console path.
        }
        if (ctx?.mode !== "tui") {
          try {
            console.error(text);
          } catch {
            // stderr unavailable.
          }
        }
      };

      if (!runtime.enabled) {
        say(`本会话未加载 Coworkflow：先运行 /${NS}:start`);
        return;
      }
      if (!runtime.control.moduleEnabled("subagents")) {
        say("本项目把 subagents 模块关掉了：`/Coworkflow:settings` 打开它之后才能用原生工作流派单。");
        return;
      }
      const parsed = parseRunArgs(args);
      if ("error" in parsed) {
        say(parsed.error);
        return;
      }

      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd;
      const root = runtime.configRoots.root(cwd);
      if (root === null) {
        say("配置根无法解析（git 读取失败）：本命令不派单，避免在主 checkout 不确定的情况下启动子进程。");
        return;
      }
      const sessionId = ctx?.sessionManager?.getSessionId?.() ?? runtime.sessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        say("拿不到当前会话 id：pi-subagents 的工作流资源按会话注册，没有 id 无法解析资源。请在交互式会话里运行本命令。");
        return;
      }

      const epoch = runtime.sessionEpoch;
      const bridge = bridgeFor(host, runtime);
      const capability = await bridge.client.requireCapabilities();
      if (!capability.ok) {
        say(capability.message);
        return;
      }

      // Same-session reconciliation: this either returns the set that is already
      // registered or awaits the build that is in flight, so two commands in
      // one turn cannot observe a half-built registration.
      if (!runtime.enabled || runtime.sessionEpoch !== epoch) { say("会话已更换或关闭，未派单。"); return; }
      await schedule(state, runtime, host, sessionId);
      const registered = state.current;
      if (registered === null || registered.sessionId !== sessionId || registered.workflow === null) {
        say(
          registered?.failure ??
            `工作流资源 ${WORKFLOW_NAME} 未注册（session ${sessionId.slice(0, 8)}）：本命令不会退回自建脚本或 CLI 派单。`,
        );
        return;
      }
      if (registered.failure !== undefined) {
        say(registered.failure);
        return;
      }

      const plan = planRun(root, null, activeTaskDir(root, sessionId));
      if (!plan.ok) {
        say(plan.message);
        return;
      }

      registered.prepared = withKindAgents(host, root, plan);
      const launchId = `coworkflow-run-${randomUUID()}`;
      const admission = await bridge.admit(launchId, runtime.control.moduleEnabled("capacity") ? runtime.control.subagentConcurrency() : null);
      if (!admission.admit) {
        say(admission.reason);
        return;
      }

      const freshPlan = planRun(root, null, activeTaskDir(root, sessionId));
      if (runtime.sessionEpoch !== epoch || !runtime.enabled || state.current !== registered ||
          !runtime.control.moduleEnabled("subagents") || !freshPlan.ok ||
          freshPlan.taskRef !== plan.taskRef || freshPlan.worktree !== plan.worktree) {
        registered.prepared = null;
        bridge.release(launchId);
        say("会话或任务工作树已改变，未派单；请重新检查当前任务。");
        return;
      }
      // The kind pass first: which agents this workflow runs must be the ones the
      // owner really has, not whichever pair a not-yet-landed registration left.
      await syncAgentKinds(host, runtime);
      registered.prepared = withKindAgents(host, root, freshPlan);
      const missionTitle = `Trellis ${plan.taskRef.split("/").pop() ?? plan.taskRef}: 实现与复核`;
      const result = await bridge.client.spawn({
        workflow: WORKFLOW_NAME,
        args: {
          taskRef: plan.taskRef,
          ...(parsed.focus ? { focus: parsed.focus } : {}),
        },
        options: { mission: { title: missionTitle, objective: `实现并独立复核 ${plan.taskRef}` } },
        cwd: plan.worktree,
      }, (alias) => bridge.trackAlias(launchId, alias));

      if (!result.ok) {
        if (result.ambiguous) bridge.hold(launchId, result.ambiguous.alias);
        else bridge.release(launchId);
        say(result.message);
        return;
      }
      bridge.bind(launchId, result.data.runId);
      recordLaunchLink(root, {
        runId: result.data.runId ?? "",
        ...(result.data.missionId ? { missionId: result.data.missionId } : {}),
        taskRef: plan.taskRef,
        worktree: plan.worktree,
        workflow: WORKFLOW_NAME,
        sessionId,
      });
      say(
        [
          `已用原生工作流 ${WORKFLOW_NAME} 派单：${plan.taskRef}`,
          `  工作树: ${plan.worktree}`,
          `  run: ${result.data.runId}`,
          ...(result.data.missionId ? [`  mission: ${result.data.missionId}`] : []),
          "工作流会先跑实现、再跑独立复核；复核不是 pass 就以失败结束。",
          "完成通知由 pi-subagents 自己送达（父会话被唤醒）；本命令不自动合并、不自动清理 worktree，最终验收与合并仍由主会话决定。",
        ].join("\n"),
      );
    },
  });
}

/**
 * Attach the observation listeners once per host.
 *
 * Every handler re-reads both gates and resolves its bridge at call time, so a
 * listener that could not be removed (a host whose `on` returns nothing) is inert
 * instead of wrong. The flag therefore means "listeners exist on this host", not
 * "this session's listeners": it stays true while they are still attached, which
 * is exactly when re-attaching would double every observation.
 */
function attachObservers(host: PiRuntimeHost, state: HostState, runtime: RuntimeContext): void {
  if (state.observersAttached || !host.on) return;
  state.observersAttached = true;
  let inFlight = false;
  const refresh = (): void => {
    if (inFlight || !runtime.enabled || !runtime.control.moduleEnabled("subagents")) return;
    inFlight = true;
    void bridgeFor(host, runtime)
      .observe()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  refresh();
  // Every tool call is counted, not only dispatches: the comparison is the fact.
  track(state, host.on("tool_call", () => {
    const live = HOSTS.get(host);
    if (live && runtime.isChild === false) live.facts.toolCalls += 1;
    return undefined;
  }));
  // A dispatch's interval starts here, before admission: a refused dispatch still happened, and a
  // measurement that silently drops the refused ones would flatter the session.
  track(state, host.on("tool_call", (event: any) => {
    if (event?.toolName === "subagent") beginDispatch(host, runtime, event);
    return undefined;
  }));
  track(state, host.on("tool_call", async (event: any) => {
    if (event?.toolName !== "subagent") return;
    const workflow = event.input?.workflow;
    // Only this package's own resources are policed here. A raw script, another
    // extension's workflow, or a plain direct dispatch is not ours to judge.
    if (workflow !== WORKFLOW_NAME && workflow !== FANOUT_NAME) return;
    if (!runtime.enabled || !runtime.control.moduleEnabled("subagents")) {
      // The refusal has to name the fix, because the most common way to hit it is a
      // non-interactive session where the obvious fix does not work: `/Coworkflow:start` typed into
      // `pi -p` is sent as a prompt, not executed, so the first dispatch is refused and the reader is
      // left guessing. Both real remedies are named here.
      return {
        block: true,
        reason: [
          "Coworkflow 在本会话没有启用，所以这个工作流没有派单。",
          "交互会话：先运行 /Coworkflow:start。",
          "非交互会话（pi -p / 脚本）：斜杠命令会被当成提示词，不会执行——先执行 ",
          `\`pi-coworkflow session on --session ${runtime.sessionId ?? "<会话 id>"}\`（或直接写 .trellis/.runtime/workflow-sessions.json 的 on: true）。`,
        ].join(""),
      };
    }
    await schedule(state, runtime, host);
    const current = state.current;
    if (!current?.workflow || current.failure) {
      return { block: true, reason: current?.failure ?? `工作流资源 ${String(workflow)} 未注册。` };
    }
    // The implement→review pair runs in a verified task worktree, so it is refused
    // without one. A fanout is general-purpose: its children fall back to the
    // workflow's own cwd when no task is prepared, which the host still chose.
    if (workflow === WORKFLOW_NAME && !current.prepared) {
      return { block: true, reason: "没有经过宿主校验的活跃任务工作树，未派单。" };
    }
    return undefined;
  }));
  track(state, host.on("agent_end", () => {
    refresh();
    return undefined;
  }));
  track(state, host.on("tool_result", (event: any) => {
    if (event?.toolName !== "subagent") return undefined;
    settleDispatch(host, runtime, event);
    refresh();
    return undefined;
  }));
  // A structured native completion closes that run's dispatch interval. This is
  // the only place a settle time is recorded, so a run whose completion is never
  // observed keeps an open interval and is reported as unknown rather than counted
  // as serial work. Deliberately passive: no message, no report, just the fact.
  track(state, host.on("message_end", (event: any) => {
    if (!runtime.enabled || !runtime.control.moduleEnabled("subagents")) return undefined;
    const completions = decodeNativeCompletions(event?.message);
    if (completions.length === 0) return undefined;
    const root = runtime.configRoots.root(runtime.cwd);
    if (root === null) return undefined;
    for (const completion of completions) recordRunSettled(root, completion.runId);
    return undefined;
  }));
}

/**
 * Remember one unsubscribe — or remember that the host gave none.
 *
 * When `on` returns nothing the listener is permanent, so `observersAttached` must
 * stay true after the session ends: the handler is gate-checked, and re-attaching
 * would register a second copy of every observation.
 */
function track(state: HostState, unsubscribe: (() => void) | void): void {
  if (typeof unsubscribe === "function") state.listeners.push(unsubscribe);
  else state.permanentListener = true;
}

/**
 * Settle the registrations this host's current session is building.
 *
 * Exposed for the focused tests and for a later stage that must know the resource
 * exists before it launches; the orchestrator itself never awaits, because the build may finish late — a late result
 * is either kept (same session) or disposed (session gone).
 */
export function subagentsRuntimeSettled(host: PiRuntimeHost): Promise<void> {
  return HOSTS.get(host)?.current?.done ?? Promise.resolve();
}

/** Undo a failed install of the runtime resources for the *current* session only. */
export function resetSubagentsRuntime(host: PiRuntimeHost): void {
  const state = HOSTS.get(host);
  if (!state) return;
  withdraw(state);
  state.runCommandRegistered = false;
  state.controlCommandsRegistered = false;
}