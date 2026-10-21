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

import { statSync, realpathSync } from "node:fs";
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
import { kindWorkflowAgents, syncAgentKinds } from "../agent-kinds/index.ts";
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
import { formatOverlapLine } from "../../core/dispatch-timing.ts";

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
function detect(ctx: ModuleContext): string | null {
  const userSettings = readObject(ctx, userSettingsPath());
  if (declaresPackage(userSettings)) return "用户级 settings.json";
  const projectSettings = readObject(ctx, PROJECT_SETTINGS);
  if (declaresPackage(projectSettings)) return "项目级 .pi/settings.json";
  if (ctx.read(join(subagentsPackageDir(), "package.json")) !== null) return "Pi 的 npm 目录";
  return null;
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
 * The one line that says whether this session's dispatches overlapped.
 *
 * Read from the recorded links at render time, so it reports what happened rather
 * than what was believed to happen. Like every other status line here it is stored
 * state, never a message: a status line delivered as a user turn rewrites the run
 * it describes.
 */
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

export const subagentsModule: WorkflowModule = {
  id: "subagents",
  title: "subagent 层（复用已安装的 pi-subagents，缺失时项目级安装）",

  /**
   * Attach this host's runtime state and observers.
   *
   * Nothing session-scoped is registered here: the workflow resource and the
   * child requirement are scoped to a *session id* upstream, and at extension
   * load there is none yet. What this does is install the per-host state and the
   * observation listeners once, then ask that state to match the live gates —
   * which it repeats on every `onRuntimeChange` and `session_start`.
   */
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
    const state = HOSTS.get(host);
    if (!state) return null;
    const set = state.current;
    const session = set ? `（session ${set.sessionId.slice(0, 8)}）` : "";
    return [
      `  ${set?.workflow ? "=" : "-"} subagents: 工作流资源 ${WORKFLOW_NAME}、${FANOUT_NAME} ${set?.workflow ? `已注册${session}` : "未注册"}`,
      `  ${set?.children ? "=" : "-"} subagents: 子会话必需扩展 ${set?.children ? "已登记" : "未登记（subagent-context 关闭或本会话未加载 Coworkflow 时不登记）"}`,
      ...(set?.failure === undefined ? [] : [`  x subagents: ${set.failure}`]),
      ...overlapLine(state),
    ];
  },

  apply(ctx: ModuleContext): void {
    const found = detect(ctx);
    if (found) {
      const version = installedVersion();
      ctx.report("ok", `复用已安装的 ${PACKAGE}${version ? ` v${version}` : ""}（来自${found}），未安装任何东西`);
    } else if (ctx.dry) {
      ctx.report(
        "created",
        `把 ${PACKAGE_SPEC} 声明到项目 .pi/settings.json 的 packages（项目级安装；Pi 下次启动时拉取，需要项目信任）`,
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
        `${PACKAGE_SPEC} 声明到项目 .pi/settings.json 的 packages（项目级；Pi 下次启动时拉取，需要项目信任才加载）`,
      );
    }

    const settings = readObject(ctx, PROJECT_SETTINGS);
    if (settings === null) return;
    const subagents =
      settings.subagents !== null && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...(settings.subagents as JsonObject) }
        : {};
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
  return { ...plan, ...kindWorkflowAgents(host, resolveKinds(readConfig(root))) };
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
  track(state, host.on("tool_call", async (event: any) => {
    if (event?.toolName !== "subagent") return;
    const workflow = event.input?.workflow;
    // Only this package's own resources are policed here. A raw script, another
    // extension's workflow, or a plain direct dispatch is not ours to judge.
    if (workflow !== WORKFLOW_NAME && workflow !== FANOUT_NAME) return;
    if (!runtime.enabled || !runtime.control.moduleEnabled("subagents")) {
      return { block: true, reason: "Coworkflow 工作流模块已关闭。" };
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
    if (event?.toolName === "subagent") refresh();
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