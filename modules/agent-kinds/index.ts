/**
 * Module: typed subagent kinds (`cw-executor`, `cw-auditor`).
 *
 * A kind is a named agent definition plus two project policies (enabled, max
 * concurrent). This module owns the first half — making the kind exist in the
 * main session's agent list, through the installed pi-subagents owner's public
 * runtime-agent contract — and the policies that read it.
 *
 * What it deliberately is *not*: an execution path. Nothing here spawns a child,
 * chooses which kind gets a task, or keeps its own ledger of running kinds. A
 * kind's launches are the owner's, counted from the owner's own public status.
 *
 * ## Lifecycle
 *
 * Registration is process-local, has no session scope of its own, and returns a
 * `dispose()`. So this module:
 *
 *   - registers only in the parent session (`runtime.isChild` false): a child
 *     registering agents would leak them into its own subtree, and a kind's system
 *     prompt is meaningless inside a child;
 *   - keeps one disposable per kind, disposes before re-registering (the owner
 *     refuses a duplicate name, so skipping that turns the *second* toggle into a
 *     collision error), and leaves an unchanged definition alone;
 *   - disposes everything on `onSessionEnd`, and disowns a registration that lands
 *     after its session ended.
 *
 * ## The gate
 *
 * A `tool_call` that dispatches one of our kinds is checked against the project
 * policy before it reaches the owner: disabled kinds are refused, enabled kinds are
 * refused at their `maxConcurrent`. The count is the *owner's* — `entries[].agent`
 * from its public fleet projection — never a ledger of ours, because a mirror of
 * running work is a second source of truth that diverges silently.
 *
 * Two rules make the gate trustworthy rather than decorative:
 *
 *   - **unknown is not zero.** No `fleetStatus`, a malformed fleet DTO, an
 *     overflowing window, or a reply that lands after the session moved all
 *     refuse. A limit that cannot be counted must not admit.
 *   - **nothing else changes.** A dispatch of any other agent — builtin,
 *     `trellis-*`, another extension's — returns `undefined` before a single read.
 *     The gate is not a policy on the model's choices; it is a refusal of two
 *     specific ones.
 *
 * ## The stated boundary
 *
 * A child started *inside a workflow script* is not a child any `tool_call` of ours
 * decides: the script calls the owner's `runs.run` from the sandbox. That is refused
 * where it can be identified — `workflow: true`, or a script file whose text contains a
 * launch call — with a reason that says it skips admission and names
 * `coworkflow_dispatch`, the channel that does queue and admit. Named resources are
 * judged by their arguments; an unreadable script is unknown and passes through.
 * Claiming coverage of a path we cannot see would be the dishonest half-degradation
 * this module exists to remove.
 *
 * ## Honest degradation
 *
 * When the installed owner exports no compatible registration contract, nothing is
 * registered and `runtimeStatus` says exactly why. A kind that never registered is
 * never reported as available: the failure mode this rule exists for is a gate
 * that quietly does nothing while the panel claims otherwise.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";

import type { PiRuntimeHost, RuntimeContext, Unsubscribe, WorkflowModule } from "../../core/module.ts";
import { readConfig, type ResolvedAgentKind, type WorkflowConfig } from "../../core/config.ts";
import { attachSubagents, existingSubagentsBridge } from "../../core/subagents-client.ts";
import {
  BUILTIN_KINDS,
  agentNameFor,
  builtinKind,
  disabledKindMessage,
  kindOf,
  kindRole,
  resolveKinds,
  kindSystemPrompt,
  unregisteredKindMessage,
  unshippedKinds,
  type FanoutKindPolicy,
  type KindDefinitions,
} from "./defaults.ts";
import { readKindDefinitions } from "./definitions.ts";
import { registerKindPort } from "./port.ts";
import {
  FANOUT_NAME,
  RUN_BUDGET_MS,
  checkpointFor,
  type FanoutPolicy,
} from "../../core/subagents-workflow.ts";

/** The owner's built-in parallel workflow: `{ tasks: [{ agent, task }] }`. */
const PARALLEL_WORKFLOW = "parallel";

/**
 * The replacement a refusal names: one call, every work unit, queued by kind ceiling.
 *
 * A constant because the refusal wording is the whole point of this boundary — a gate that says
 * "no" without saying where to go sends the model looking for another ungoverned shape.
 */
export const DISPATCH_TOOL = "coworkflow_dispatch";
import { KIND_PREFIX } from "../../core/config.ts";
import {
  kindRegistryFor,
  loadRuntimeAgentContract,
  type DesiredKind,
} from "./registration.ts";

/** What one reconcile pass learned, stored for `/Coworkflow:status`. */
interface Snapshot {
  /** Why the contract was unavailable, when it was. */
  contractFailure?: string;
  /**
   * Kinds the owner accepted, with their agent names and the model each one was
   * registered with.
   *
   * The model is carried here rather than re-read by the report: `/Coworkflow:status`
   * and `/Comodels` must not be able to disagree about what a kind runs on, and the
   * registration is the fact that decides it.
   */
  registered: { kind: string; agent: string; model?: string; thinking?: string }[];
  /** Kinds that failed to register, with the owner's own reason (a collision). */
  failures: { kind: string; reason: string }[];
  /** Kinds the project declared that this package has no agent for. */
  unshipped: string[];
  /** Kinds a project definition file provides, with the agent name it registered. */
  definitions: { kind: string; agent: string }[];
  /**
   * Kinds the project switched off: declared, shipped, intentionally absent.
   *
   * Their model and thinking level are carried too. A disabled kind keeps its
   * settings — switching it on must apply what the project already chose, not reset
   * it — so the report names them the same way it names a registered kind's.
   */
  disabled: { kind: string; model?: string; thinking?: string }[];
}

interface State {
  /**
   * Bumped on every withdrawal or session end. A pass that lands after its own
   * generation moved disowns itself instead of registering for a session that
   * is gone — that counter is the whole reason no separate "closed" flag exists,
   * which would have to be reset by a call somebody could forget.
   */
  generation: number;
  /** What the last completed pass learned; read by `runtimeStatus` and the gate. */
  snapshot: Snapshot | null;
  /**
   * How many dispatches this session asked to block the main session, and were put in the background.
   *
   * Counted rather than silently corrected: the rewrite is visible in `/Coworkflow:status` as a fact.
   * A project rule that changes what a call does should be answerable when someone asks why the
   * child did not block.
   */
  forcedBackground: number;
  /** How many mechanical fields this session has filled in for callers. */
  defaultsFilled: number;
  /**
   * The fingerprint of what is registered right now, or `null` when nothing is.
   *
   * The gate compares the plan it just built from disk against this: a difference means a
   * definition changed under a live session, and the registration has to catch up before the
   * dispatch it is about to decide. That is what makes editing a file hot-reload instead of
   * "reload Pi".
   */
  registeredSignature: string | null;
  /**
   * Why the last reconcile pass registered nothing on purpose, when it did.
   *
   * `null` means the pass ran. A child session never registers (its kinds would
   * leak into its own subtree) and neither does a session with either gate off —
   * and "we are not supposed to" is a different answer from "the import has not
   * landed yet", which is the difference this field keeps.
   */
  skipped: "child" | "off" | null;
  /** The pass in flight, so a second caller awaits it instead of racing it. */
  pending: Promise<void>;
  /**
   * The gate's own hooks, kept so a second `activate` in the same session adds no
   * duplicate listener and `onSessionEnd` can release the one it has.
   */
  listeners: Map<string, Unsubscribe | void>;
  /**
   * Whether this module attached the shared subagents bridge. Only then does it
   * own closing it — `capacity` closes the one it created, and a session ending
   * must not leave a client behind because the module that made it was switched
   * off while this one stayed on.
   */
  attached: boolean;
}

const STATES = new WeakMap<PiRuntimeHost, State>();

function stateFor(host: PiRuntimeHost): State {
  const existing = STATES.get(host);
  if (existing) return existing;
  const created: State = {
    generation: 0,
    snapshot: null,
    forcedBackground: 0,
    defaultsFilled: 0,
    registeredSignature: null,
    skipped: null,
    pending: Promise.resolve(),
    listeners: new Map(),
    attached: false,
  };
  STATES.set(host, created);
  return created;
}

// ── The gate ────────────────────────────────────

/**
 * A `subagent` call that dispatches one of this package's kinds.
 *
 * `null` for everything else — a plain `trellis-implement`, another extension's
 * agent, a `status`/`stop`/agent-management action. Those must reach the owner
 * exactly as they do without this module, which is why the decision is made in
 * the decoder and not by a chain of `if`s inside the hook.
 */
export interface KindDispatch {
  /** The agent name the caller asked for, e.g. `cw-executor`. */
  agent: string;
  /**
   * The kind it belongs to, e.g. `executor`.
   *
   * Filled in by `resolveDispatchKind` against the project's table: a definition may rename
   * its agent, so the name alone does not say which kind it is.
   */
  kind: string;
  /** Whether the call asks for a background run. Wording only; both occupy a kind slot. */
  async: boolean;
}

/**
 * Decode a `subagent` input into a kind dispatch, or `null` when it is not one.
 *
 * Three exclusions, each with a reason:
 *
 *   - an `action` other than `resume`/`append-step` is a management or control
 *     call (`status`, `stop`, `guide`, …), not a new child of a kind. `agent` is
 *     also a management *target* in those calls, so gating them would let a limit
 *     block a `stop` — refusing the operation that would free the slot.
 *   - an agent that is not a `cw-` name is not ours: the builtin table and every
 *     other extension keep behaving exactly as they did.
 *   - a `cw-` name the project's table does not resolve is not a kind either; the
 *     owner, not this gate, is the authority on whether it exists.
 *
 * The result carries no kind: which kind a name belongs to needs the project's table, and
 * that read belongs to `resolveDispatchKind` rather than to a payload shape check.
 */
export function decodeKindDispatch(input: unknown): { agent: string; async: boolean } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const call = input as Record<string, unknown>;
  const action = typeof call.action === "string" ? call.action.trim() : "";
  // `resume` and `append-step` start work; every other action manages it.
  if (action && action !== "resume" && action !== "append-step") return null;
  const agent = typeof call.agent === "string" ? call.agent.trim() : "";
  // The prefix is the only thing a shape check can decide: a `cw-` name belongs to this
  // package's namespace, and whether the project's table resolves it is
  // `resolveDispatchKind`'s job.
  if (!agent.startsWith(KIND_PREFIX)) return null;
  return { agent, async: call.async !== false };
}

/**
 * Fill the mechanical fields a dispatch needs, and say which ones were filled.
 *
 * The main session should state *what* to do; the budget, the fresh context and the hand-over
 * checkpoint are project policy, not per-dispatch judgement. Leaving them to the caller is what makes
 * dispatching feel more expensive than doing the work, which is the behaviour this fills in against.
 *
 * An explicit value always wins: a caller that asked for `context: "fork"` or its own `timeoutMs` knew
 * something this function does not. Mutating `input` in place is the documented `tool_call` mechanism,
 * the same mechanism the background rewrite used to use on its own.
 */
export function applyDispatchDefaults(
  input: unknown,
  budgetMs: number | undefined,
): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const call = input as Record<string, unknown>;
  const filled: string[] = [];

  // Background is not left to the caller or to upstream's default. `asyncByDefault` is a
  // project setting upstream honours, so an omitted `async` starts *foreground* (blocking the
  // main session) in a project that turned it off; an explicit `false` asks for exactly that.
  // Both are rewritten here, because "a child never blocks the parent" is this package's rule,
  // not a preference the dispatch site has to remember.
  //
  // The two rewrites are counted apart: `async` is the one the status line reports as
  // "a foreground dispatch turned into a background one", which an omitted field is not.
  if (call.async !== true) {
    const wasExplicit = call.async === false;
    call.async = true;
    filled.push(wasExplicit ? "async" : "async-default");
  }

  const budget = budgetMs ?? RUN_BUDGET_MS;
  const current = call.options;
  const options: Record<string, unknown> =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : (call.options = {} as Record<string, unknown>);
  if (options !== current) filled.push("options");

  if (options.context === undefined) {
    options.context = "fresh";
    filled.push("context");
  }
  if (options.timeoutMs === undefined) {
    options.timeoutMs = budget;
    filled.push("timeoutMs");
  }
  if (options.checkpointBeforeDeadlineMs === undefined) {
    const timeout = typeof options.timeoutMs === "number" ? options.timeoutMs : budget;
    options.checkpointBeforeDeadlineMs = checkpointFor(timeout);
    filled.push("checkpointBeforeDeadlineMs");
  }
  return filled;
}

/**
 * The per-kind batch of a `coworkflow.fanout` call, or `null` when this is not one.
 *
 * A fanout names kinds inside `args.tasks` instead of a top-level `agent`, so the gate has to read
 * it separately — otherwise the package's own recommended dispatch path is the one path the per-kind
 * limit never sees.
 */
export function decodeFanoutCall(input: unknown): { kind: string; count: number }[] | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const call = input as Record<string, unknown>;
  // Two shapes carry a batch, and both have to be seen. Ours names `kind`; the owner's own
  // `parallel` workflow names `agent`, which is how a real session on this package dispatched ten
  // cw-executor children while the per-kind ceiling silently never ran: the gate only recognised
  // its own workflow, so the path it did not recognise was the path that skipped the limit.
  if (call.workflow !== FANOUT_NAME && call.workflow !== PARALLEL_WORKFLOW) return null;
  const args = call.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const tasks = (args as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) return null;
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task === null || typeof task !== "object") continue;
    const entry = task as Record<string, unknown>;
    // Either spelling identifies the same kind; `gateFanout` resolves whichever came through against
    // the project's table, so an agent name that is not a kind is simply not ours.
    const name =
      typeof entry.kind === "string" && entry.kind
        ? entry.kind
        : typeof entry.agent === "string" && entry.agent
          ? entry.agent
          : "";
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts.size === 0 ? null : [...counts].map(([kind, count]) => ({ kind, count }));
}

/**
 * A `subagent` call that starts its own children from JavaScript this package never sees.
 *
 * Two shapes, and both are upstream's own documented spellings rather than a guess about payloads:
 * a `workflow: true` request means "run the script in this reply's code block", and a `workflow`
 * string containing `/` means "run this script file" (any other string is a named resource). Only
 * the second can be looked at before the call is admitted, so only it can be told apart from a
 * script that starts nothing.
 */
export type UngovernedLaunch =
  | { shape: "inline-script" }
  | { shape: "script-file"; script: string };

/** The calls a workflow script makes to start children itself. */
const SCRIPT_LAUNCH = /\bruns\s*\.\s*(?:run|all|lanes)\s*\(/;

/** How much of a script file is read to decide. A launch call beyond this is not identified. */
const SCRIPT_READ_BYTES = 256 * 1024;

/**
 * Decode a `subagent` call whose children are started inside a script, or `null` for everything else.
 *
 * Why this is a refusal boundary at all: a script starts its children through the owner's own
 * `runs.run`, in the workflow sandbox, and no `tool_call` of ours is in that path. A kind's switch and
 * ceiling therefore cannot decide those launches — the work goes out uncounted and unblocked, which is
 * exactly the "claims to gate, does not gate" state this module exists to remove. The honest move is to
 * say so and name the channel that *is* admitted.
 *
 * What this function deliberately does **not** do:
 *
 *   - no `action` at all is refused: `status`/`stop`/`list`/`create` manage work, `validate` (which may
 *     legitimately carry `workflow: true` or a path) starts none, and `resume` continues a run that was
 *     already admitted.
 *   - a named resource (`parallel`, another extension's workflow) is not a script: it has its own
 *     arguments to decode, and `parallel` is decoded and admitted per kind elsewhere.
 *   - a script that is unreadable, or readable and calls none of `runs.run`/`runs.all`/`runs.lanes`, is
 *     passed through. Unknown is not evidence: refusing here would block a script that runs nothing,
 *     which is worse than the hole this closes.
 *
 * The reader is injected so the decision is a pure function of the payload plus what the file says.
 */
export function decodeUngovernedLaunch(
  input: unknown,
  readScript: (script: string) => string | null,
): UngovernedLaunch | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const call = input as Record<string, unknown>;
  const action = typeof call.action === "string" ? call.action.trim() : "";
  if (action) return null;

  const workflow = call.workflow;
  // The code-block form. Nothing in the payload carries the script, so there is nothing to inspect at
  // `tool_call` time — the shape is ungovernable whether or not that block happens to start children.
  if (workflow === true) return { shape: "inline-script" };

  // Upstream's rule, restated so this stays a shape check: a string with `/` is a script file, any
  // other string is a named resource. Guessing beyond that ("looks like a filename") is the heuristic
  // this boundary promises not to use.
  if (typeof workflow !== "string" || !workflow.includes("/")) return null;
  const script = readScript(workflow);
  if (script === null || !SCRIPT_LAUNCH.test(script)) return null;
  return { shape: "script-file", script: workflow };
}

/**
 * A bounded, failure-tolerant read of a script path, relative to the request's own `cwd`.
 *
 * Bounded because a script is a small file and the gate runs on every dispatch; tolerant because a
 * missing or unreadable path is not this gate's error to report — it is `null`, which
 * `decodeUngovernedLaunch` reads as "not identified" and passes through to the owner, which is the
 * component that actually owns script resolution and reports a bad path.
 */
export function readScriptForGate(
  script: string,
  cwd: string,
): string | null {
  const path = isAbsolute(script) ? script : resolvePath(cwd, script);
  let fd: number | null = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, SCRIPT_READ_BYTES);
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Which kind a dispatch names, resolved against the project's own table.
 *
 * Separate from `decodeKindDispatch` because the table needs a root and a read, and decoding
 * a payload should stay a pure shape check. A renamed kind (`agent: cw-builder`) is only
 * recognisable through the table, so this is the step that makes a project definition
 * dispatchable at all.
 */
export function resolveDispatchKind(
  agent: string,
  kinds: readonly ResolvedAgentKind[],
): string | null {
  return kindOf(agent, kinds);
}

function kindLabel(agent: string, kind: string): string {
  return `kind ${kind}（${agent}）`;
}

/** A refusal: `block` is what the host understands, `reason` is what the model reads. */
interface Refusal {
  block: true;
  reason: string;
}

function refusal(lines: string[], dispatch: KindDispatch): Refusal {
  return {
    block: true,
    // Saying that nothing was started matters: the model's next move depends on
    // whether an ambiguous half-launch might exist. There is none here.
    reason: [
      ...lines,
      `这次${dispatch.async ? "后台" : "前台"}派单被拦下，没有启动任何子进程。`,
    ].join(""),
  };
}

/** Kinds a project may actually dispatch right now, for a refusal that is actionable. */
function availableKinds(kinds: readonly ResolvedAgentKind[], snapshot: Snapshot | null): string[] {
  // Only a kind that the owner accepted in this session is available. "Enabled"
  // alone is a project decision, not a fact about the agent list — and naming a
  // kind that does not exist is exactly the dishonest degradation this gate exists
  // to prevent. No snapshot (or a failed contract) therefore names nothing.
  if (snapshot === null || snapshot.contractFailure !== undefined) return [];
  const live = new Set(snapshot.registered.map((entry) => entry.kind));
  return kinds.filter((entry) => entry.enabled && live.has(entry.kind)).map((entry) => entry.agent);
}

function disabledRefusal(dispatch: KindDispatch, available: readonly string[]): Refusal {
  // The wording lives in `disabledKindMessage` because `coworkflow.fanout` refuses
  // a disabled kind per task too: one vocabulary, or the two paths disagree about
  // what the user's switch means.
  return refusal([
    disabledKindMessage(dispatch.kind, dispatch.agent, available),
    `要恢复：在 /Coworkflow:settings 里打开 ${dispatch.kind}，无需重启。`,
  ], dispatch);
}

/**
 * Why an enabled kind is not registered — the honest answer, never a list of
 * kinds that only exist in the panel.
 */
function unregisteredRefusal(dispatch: KindDispatch, snapshot: Snapshot | null): Refusal {
  const failure = snapshot?.failures.find((entry) => entry.kind === dispatch.kind)?.reason;
  const reason = snapshot === null
    ? "本会话的 agent kind 注册尚未完成，无法确认它真的在 agent 列表里"
    : snapshot.contractFailure ?? failure ?? "该 kind 未注册（可能缺少系统提示资产或被上游拒绝）";
  return refusal([
    `本项目启用了 ${kindLabel(dispatch.agent, dispatch.kind)}，但它没有被注册到 pi-subagents：${reason}。`,
    "不把未注册的 kind 当成可用，比悄悄放行更有用：现在派单会在上游以「未知 agent」失败，或根本没有执行者。",
    "请检查 pi-subagents 是否提供运行时 agent 契约，或先修好上述原因。",
  ], dispatch);
}

function overLimitRefusal(
  dispatch: KindDispatch,
  limit: number,
  occupancy: number,
): Refusal {
  return refusal([
    `${kindLabel(dispatch.agent, dispatch.kind)} 的并发上限是 ${limit}，当前已有 ${occupancy} 个在运行（pi-subagents 公开 fleet 状态）。`,
    `请先等其中一个结束（subagent({ action: "status" }) 查看进度），或在 /Coworkflow:settings 里调高 ${dispatch.kind} 的上限。`,
  ], dispatch);
}

function unreadableCountRefusal(dispatch: KindDispatch, limit: number, reason: string): Refusal {
  return refusal([
    `本项目给 ${kindLabel(dispatch.agent, dispatch.kind)} 设了并发上限 ${limit}，但无法确认现在有几个在运行：${reason}`,
    "为避免把上限变成一句空话，这次派单被拦下。请在 /Coworkflow:settings 里调高或调整该 kind 的上限，或确认 pi-subagents 提供 fleet 状态能力。",
  ], dispatch);
}

/**
 * Refuse a launch this package cannot admit, and name the launch that it can.
 *
 * The two facts a reader needs are both here: *why* this shape escapes the gate (the children are
 * started inside a script, so no `tool_call` of ours decides them), and *where to go instead*. A
 * refusal that only says "no" is how a caller ends up hunting for the next ungoverned spelling.
 */
function ungovernedLaunchRefusal(launch: UngovernedLaunch): Refusal {
  const shape = launch.shape === "inline-script"
    ? "workflow: true（脚本写在回复的代码块里）"
    : `workflow: "${launch.script}"（脚本文件里自己调用 runs.run）`;
  return {
    block: true,
    reason: [
      `这次 subagent 调用是脚本内自建启动（${shape}）：子进程由那段脚本自己启动，不经过本包的准入。`,
      "每个 kind 的开关与并发上限都在准入里，所以这种形状派出去的工作既不会被上限挡住，也不会被计数——本包管不到它。",
      `请改用 ${DISPATCH_TOOL}：一次交全部工作单元，按 kind 上限自动排队（完成一个自动放行下一个），依赖用 needs 表达，每次启动前都经同一处准入。`,
      `只拒这种能识别的形状：直接派单、parallel 与 ${FANOUT_NAME} 批次照常放行。`,
      "这次派单被拦下，没有启动任何子进程。",
    ].join(""),
  };
}

/** Count a rewrite: one un-blocked dispatch and the fields it had to fill are different facts. */
function countDefaults(state: State, filled: readonly string[]): void {
  state.defaultsFilled += filled.length;
  if (filled.includes("async")) state.forcedBackground += 1;
}

/**
 * Render one admission failure for a single dispatch.
 *
 * The decision is `admitOne`'s; only the wording is per shape. `session-gone` is a refusal rather
 * than a message because the launch would have gone to a session that no longer exists.
 */
function refusalForFailure(
  failure: AdmitFailure,
  dispatch: KindDispatch,
  snapshot: Snapshot | null,
): Refusal | undefined {
  switch (failure.code) {
    case "session-gone":
      return { block: true, reason: "会话已更换或该层已关闭，未启动子进程。" };
    case "disabled":
      return disabledRefusal(dispatch, failure.available);
    case "unregistered":
      return unregisteredRefusal(dispatch, snapshot);
    case "unknown-count":
      return unreadableCountRefusal(dispatch, failure.limit, failure.reason);
    case "over-ceiling":
      return overLimitRefusal(dispatch, failure.limit, failure.occupancy);
  }
}

/**
 * Render one admission failure for a batch.
 *
 * A batch has one fact a single dispatch does not: how many it wanted. Saying so is the difference
 * between "you are full" and "you asked for four with room for two".
 */
function fanoutRefusalFor(
  failure: AdmitFailure,
  entry: { count: number; kind: string; agent: string },
  snapshot: Snapshot | null,
): Refusal | undefined {
  const dispatch: KindDispatch = { agent: entry.agent, kind: entry.kind, async: true };
  if (failure.code !== "over-ceiling") return refusalForFailure(failure, dispatch, snapshot);
  return {
    block: true,
    reason: [
      `这个 coworkflow.fanout 要启动 ${failure.requested} 个 ${kindLabel(entry.agent, entry.kind)}，但本项目的上限是 ${failure.limit}，当前已有 ${failure.occupancy} 个在运行。`,
      `整批被拦下，本次调用没有启动任何子进程：workflow 要么全跑要么不跑，只启动一部分比一个都不启动更糟。`,
      `请减少该 kind 的任务数、等其中一个结束，或在 /Coworkflow:settings 里调高 ${entry.kind} 的上限。要用排队替代整批拒绝，请改用 coworkflow_dispatch。`,
    ].join(""),
  };
}

/**
 * What one reconcile pass should register, from the project's kind policy.
 *
 * A kind whose system prompt asset is missing is *not* registered and is reported
 * separately: an agent with an empty prompt is worse than an absent one, because
 * it looks available. `moduleUrl` is `import.meta.url` of this module in
 * production, so a test can drive the same plan without a copy of it.
 */
export function kindRegistrationPlan(
  kinds: readonly ResolvedAgentKind[],
  moduleUrl: string,
): { desired: DesiredKind[]; missingAssets: string[] } {
  const desired: DesiredKind[] = [];
  const missingAssets: string[] = [];
  for (const entry of kinds) {
    if (!entry.enabled) continue;
    // A project definition carries its own prompt; the shipped asset is the fallback. Only a
    // kind with neither is unusable, and that is a per-kind failure rather than a silent skip.
    const prompt = entry.promptFromFile ?? kindSystemPrompt(moduleUrl, entry.kind);
    if (prompt === null) {
      missingAssets.push(entry.kind);
      continue;
    }
    desired.push({
      kind: entry.kind,
      agent: entry.agent,
      definition: {
        // A definition's own description wins; the shipped one is the fallback, and an
        // empty description is refused by the owner, so it is never what we hand over.
        description: entry.description || builtinKind(entry.kind)?.description || `Coworkflow kind ${entry.kind}`,
        systemPrompt: prompt,
        // `parseAgentKinds` has already dropped anything unusable, so a value that
        // reaches here is one upstream will accept at registration. Absent stays
        // absent: the field is how a kind says "inherit".
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
      },
    });
  }
  return { desired, missingAssets };
}

/**
 * A stable fingerprint of what a registration pass would install.
 *
 * Hot reload needs one question answered cheaply: "is what the owner holds still what the files
 * say?" Comparing the plan itself is the honest comparison — the prompt, the agent name and the
 * policy are all in it, so an edit to any of them shows up here and nothing else does.
 */
export function planSignature(desired: readonly DesiredKind[]): string {
  // A short, stable hash of the prompt: the text can be kilobytes and a signature is compared on
  // every dispatch, but comparing only its length would miss a prompt replaced with one of equal
  // size — exactly the kind of stealth change this is supposed to catch.
  const hash = (text: string): string => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  };
  return desired
    .map((entry) =>
      [
        entry.kind,
        entry.agent,
        entry.definition.description,
        entry.definition.model ?? "-",
        entry.definition.thinking ?? "-",
        `${entry.definition.systemPrompt.length}:${hash(entry.definition.systemPrompt)}`,
      ].join("|"),
    )
    .join("\n");
}

/**
 * Make this host's registrations match the project's kind policy.
 *
 * Both live gates are read here, at call time: the session switch
 * (`runtime.enabled`) and this module's project switch. Off means *withdraw* —
 * a withdrawn layer must not keep resolving `cw-executor` for the model.
 */
function schedule(host: PiRuntimeHost, runtime: RuntimeContext): Promise<void> {
  const state = stateFor(host);
  const registry = kindRegistryFor(host);
  const wanted = !runtime.isChild && runtime.enabled && runtime.control.moduleEnabled("agent-kinds");
  if (!wanted) {
    state.generation += 1;
    registry.dispose();
    state.snapshot = null;
    state.registeredSignature = null;
    state.skipped = runtime.isChild ? "child" : "off";
    return Promise.resolve();
  }
  state.skipped = null;
  const token = state.generation;
  // A pass is live only while its own generation holds: a session end or a switch
  // off moves the number, and that is how a late landing disowns itself.
  const live = (): boolean => state.generation === token && !runtime.isChild;
  const previous = state.pending;
  const run = (async () => {
    await previous;
    const root = runtime.configRoots.root(runtime.cwd);
    const config: WorkflowConfig | null = root === null ? null : readConfig(root);
    // Read at every pass, not cached across sessions: an edited definition is picked up by
    // re-activation, which is what makes `/reload` the hot-reload boundary.
    const read = readKindDefinitions(root);
    const kinds = resolveKinds(config, read.definitions);
    const { desired, missingAssets } = kindRegistrationPlan(kinds, import.meta.url);
    const contract = await loadRuntimeAgentContract({
      events: host.events,
      projectRoot: root ?? undefined,
      // The collision check must look where the owner looks: the session's working
      // directory (and its parents) plus the user's agent directories.
      cwd: runtime.cwd,
    });
    if (!live()) {
      // The session ended, or the layer went off, while the contract was loading.
      // Whatever this pass would have registered must not survive it.
      registry.dispose();
      return;
    }
    const results = registry.reconcile(contract.ok ? contract.contract : null, desired);
    state.registeredSignature = contract.ok ? planSignature(desired) : null;
    const policyOf = new Map(kinds.map((entry) => [entry.kind, entry]));
    const snapshot: Snapshot = {
      ...(contract.ok ? {} : { contractFailure: contract.reason }),
      registered: results.flatMap((entry) => {
        if (!entry.ok) return [];
        const policy = policyOf.get(entry.kind);
        return [{
          kind: entry.kind,
          agent: entry.agent,
          ...(policy?.model === undefined ? {} : { model: policy.model }),
          ...(policy?.thinking === undefined ? {} : { thinking: policy.thinking }),
        }];
      }),
      failures: [
        ...results.flatMap((entry) => (entry.ok ? [] : [{ kind: entry.kind, reason: entry.reason }])),
        ...missingAssets.map((kind) => ({
          kind,
          reason: "既没有项目定义文件，也没有本包的系统提示资产（modules/agent-kinds/assets/）",
        })),
        ...read.failures,
      ],
      unshipped: unshippedKinds(config, read.definitions),
      definitions: kinds.flatMap((entry) =>
        entry.source === "file" ? [{ kind: entry.kind, agent: entry.agent }] : []
      ),
      disabled: kinds.flatMap((entry) => entry.enabled ? [] : [{
        kind: entry.kind,
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
      }]),
    };
    state.snapshot = snapshot;
  })().catch((error: unknown) => {
    state.snapshot = {
      contractFailure: `注册 agent kind 失败：${error instanceof Error ? error.message : String(error)}`,
      registered: [],
      failures: [],
      unshipped: [],
      definitions: [],
      disabled: [],
    };
  });
  state.pending = run;
  return run;
}

/**
 * How one registered kind's model reads in a status line: pinned, or inherited.
 *
 * The two are different facts and the report must not blur them: "继承默认" says this
 * kind has no model of its own, which is what makes a project-wide change to
 * `subagents.defaultModel` apply to it. A pinned model is named in full so the line
 * can be compared with the panel without re-reading the config.
 */
function kindModelSuffix(entry: { model?: string; thinking?: string }): string {
  const model = entry.model === undefined ? "继承默认" : `模型 ${entry.model}`;
  const thinking = entry.thinking === undefined ? "继承" : entry.thinking;
  return ` · ${model} · 思考 ${thinking}`;
}

/**
 * The per-kind admission gate for one `tool_call`.
 *
 * Reads everything at call time: the session switch, the project switch, the
 * project's current kind policy from disk, and the registration snapshot the last
 * reconcile pass produced. A toggle in `/Coworkflow:settings` therefore takes
 * effect on the next dispatch with no restart, and never on a run already admitted
 * (closing a kind stops new work, not work in flight).
 *
 * Order matters and is deliberate: disabled → not registered → over limit. Each is
 * a cheaper, more specific reason than the next, and an unregistered kind is
 * reported as such rather than as "over the limit" when both could be said.
 */
/**
 * Why a dispatch was refused, as data.
 *
 * Data and not a message: three call sites now ask the same question (a direct dispatch, a batch, and
 * the queued channel), and the wording differs per shape — a batch must say "整批被拦下", a queued
 * launch must say "留在这里等名额". One decision, three renderings, so the three can never disagree
 * about whether a kind was disabled or merely full.
 */
export type AdmitFailure =
  | { code: "session-gone" }
  | { code: "disabled"; available: string[] }
  | { code: "unregistered" }
  | { code: "unknown-count"; limit: number; reason: string }
  | { code: "over-ceiling"; limit: number; occupancy: number; requested: number };

export type AdmitResult =
  | { ok: true; kind: string; policy: ResolvedAgentKind; config: WorkflowConfig | null }
  | { ok: false; failure: AdmitFailure };

/**
 * The one admission decision every launch goes through.
 *
 * Reads at call time: the session and project switches, the project's kind policy from disk, the
 * registration snapshot, and the owner's live count. Order is deliberate — session gone, disabled,
 * unregistered, then count — because each is a cheaper and more specific reason than the next, and
 * an unregistered kind is reported as such rather than as "over the limit" when both could be said.
 *
 * `count` is how many launches the caller intends to start right now. A batch passes its size so the
 * whole batch is admitted or refused together; the queued channel passes 1 per launch so each one is
 * decided against what is running at that moment.
 *
 * Every public read happens here and nowhere else: a second reader is how two paths end up counting
 * the same launch twice.
 */
export async function admitOne(
  host: PiRuntimeHost,
  state: State,
  runtime: RuntimeContext,
  request: { kind: string; count?: number },
): Promise<AdmitResult> {
  const count = request.count ?? 1;
  const on = (): boolean => !runtime.isChild && runtime.enabled && runtime.control.moduleEnabled("agent-kinds");
  const fail = (failure: AdmitFailure): AdmitResult => ({ ok: false, failure });

  const readPolicy = (): { kinds: ResolvedAgentKind[]; policy: ResolvedAgentKind | undefined; config: WorkflowConfig | null } => {
    const root = runtime.configRoots.root(runtime.cwd);
    const config = root === null ? null : readConfig(root);
    const kinds = resolveKinds(config, readKindDefinitions(root).definitions);
    return { kinds, policy: kinds.find((entry) => entry.kind === request.kind), config };
  };

  await state.pending;
  if (!on()) return fail({ code: "session-gone" });

  const current = readPolicy();
  if (current.policy === undefined) return fail({ code: "unregistered" });
  if (!current.policy.enabled) {
    return fail({ code: "disabled", available: availableKinds(current.kinds, state.snapshot) });
  }
  // Enabled but not in the owner's list: a contract that could not be reached, a collision, a
  // missing asset. Refusing says so; admitting would start nothing.
  const snapshot = state.snapshot;
  const registeredSnapshot =
    snapshot !== null && snapshot.contractFailure === undefined &&
    snapshot.registered.some((entry) => entry.kind === request.kind);
  if (!registeredSnapshot) return fail({ code: "unregistered" });

  const epoch = runtime.sessionEpoch;
  // One client, one serialized read queue, shared with the project-wide capacity gate.
  const bridge = attachSubagents(host, { epoch, events: host.events });
  state.attached = true;
  const observed = await bridge.agentCount(current.policy.agent);
  // A count that lands after the session moved belongs to a session that is gone.
  if (!on() || runtime.sessionEpoch !== epoch) return fail({ code: "session-gone" });

  // Re-read after the public read: a toggle during it must decide this dispatch.
  const late = readPolicy();
  if (late.policy === undefined) return fail({ code: "unregistered" });
  if (!late.policy.enabled) {
    return fail({ code: "disabled", available: availableKinds(late.kinds, state.snapshot) });
  }
  if (observed.kind === "unknown") {
    return fail({ code: "unknown-count", limit: late.policy.maxConcurrent, reason: observed.reason });
  }
  if (observed.count + count > late.policy.maxConcurrent) {
    return fail({
      code: "over-ceiling",
      limit: late.policy.maxConcurrent,
      occupancy: observed.count,
      requested: count,
    });
  }
  return { ok: true, kind: late.policy.kind, policy: late.policy, config: late.config };
}

/**
 * The decision for a `coworkflow.fanout` call.
 *
 * The workflow resolver already refuses a batch that alone exceeds a kind's ceiling, but a fanout
 * also has to respect what is *running*: three executors already going against a ceiling of five
 * leaves room for two, not for a batch of three. That needs the owner's live count, which only the
 * gate has, so the check lives here rather than in the resolver.
 *
 * Order is the same as the single-agent path — disabled, then unregistered, then over the ceiling —
 * and the whole call is refused rather than part of it: a workflow is all-or-nothing, and starting
 * four of five lanes would be worse than starting none.
 */
async function gateFanout(
  host: PiRuntimeHost,
  state: State,
  runtime: RuntimeContext,
  batch: { kind: string; count: number }[],
  kinds: readonly ResolvedAgentKind[],
  input: unknown,
): Promise<Refusal | undefined> {
  const on = (): boolean => !runtime.isChild && runtime.enabled && runtime.control.moduleEnabled("agent-kinds");
  await state.pending;
  if (!on()) return;

  // One normalisation for the whole function. A batch item arrives as a kind ("executor") from this
  // package's own workflow and as an agent name ("cw-executor") from the owner's `parallel` one;
  // resolving in one place is what keeps both loops below from silently looking up the wrong name —
  // which is exactly how the owner's workflow escaped the ceiling the first time.
  const entries = batch.map(({ kind: named, count }) => {
    const policy = kinds.find((entry) => entry.kind === named) ?? kinds.find((entry) => entry.agent === named);
    const kind = policy?.kind ?? named;
    return { count, policy, kind, agent: policy?.agent ?? agentNameFor(kind) };
  });

  // A batch with no kind of ours in it is not this gate's business, and it must not cost a public
  // read: the owner's `parallel` workflow is a general purpose one, and a plain batch of
  // `reviewer`/`trellis-check` tasks used to be refused here as "an unregistered kind" — the shape
  // check promised in `decodeKindDispatch` (a name the table does not know passes untouched) had no
  // counterpart on the batch path. Returning before `attachSubagents` is what makes that a fact.
  const own = entries.filter(
    (entry): entry is typeof entry & { policy: ResolvedAgentKind } => entry.policy !== undefined,
  );
  if (own.length === 0) return;

  // One launch at a time through the single admission authority, so a batch cannot be admitted by
  // a different rule than a direct dispatch — and a refused batch still starts nothing.
  for (const entry of own) {
    const admitted = await admitOne(host, state, runtime, { kind: entry.kind, count: entry.count });
    if (admitted.ok) continue;
    return fanoutRefusalFor(admitted.failure, entry, state.snapshot);
  }

  // Admitted: the same defaults as a single dispatch, so a batch does not need a different story.
  const fanoutRoot = runtime.configRoots.root(runtime.cwd);
  countDefaults(
    state,
    applyDispatchDefaults(input, fanoutRoot === null ? undefined : readConfig(fanoutRoot)?.subagentRunBudgetMs),
  );
  return;
}

async function gate(
  host: PiRuntimeHost,
  state: State,
  runtime: RuntimeContext,
  event: { toolName?: unknown; input?: unknown },
): Promise<Refusal | undefined> {
  const on = (): boolean => !runtime.isChild && runtime.enabled && runtime.control.moduleEnabled("agent-kinds");
  if (event?.toolName !== "subagent" || !on()) return;

  // Before any decode that only knows our own shapes: a script launch carries neither `agent` nor
  // `args.tasks`, so it would otherwise return here as "not this gate's business" — and that is
  // precisely the path that leaves the ceiling uncounted. No public read is spent on the decision.
  const request = event.input;
  const requestCwd = request !== null && typeof request === "object" && !Array.isArray(request) &&
      typeof (request as Record<string, unknown>).cwd === "string"
    ? ((request as Record<string, unknown>).cwd as string)
    : runtime.cwd;
  const ungoverned = decodeUngovernedLaunch(
    request,
    (script) => readScriptForGate(script, requestCwd),
  );
  if (ungoverned !== null) return ungovernedLaunchRefusal(ungoverned);

  const fanout = decodeFanoutCall(event.input);
  const decoded = decodeKindDispatch(event.input);
  if (decoded === null && fanout === null) return;

  /** The live policy for this kind, read from disk on every call. */
  const policyOf = (): { kinds: ResolvedAgentKind[]; policy: ResolvedAgentKind | undefined } => {
    const root = runtime.configRoots.root(runtime.cwd);
    const config = root === null ? null : readConfig(root);
    const kinds = resolveKinds(config, readKindDefinitions(root).definitions);
    return {
      kinds,
      policy: decoded === null ? undefined : kinds.find((entry) => entry.agent === decoded.agent),
    };
  };
  // Hot reload, before anything else decides: a definition edited on disk (by an editor, another
  // program, the CLI in another process) has to be what this dispatch actually starts, not something
  // that takes effect on the *next* one. The comparison is the plan the owner should hold against the
  // plan it does hold — no polling, no watcher, and it costs a directory read this gate already does.
  //
  // Deliberately before the kind lookup: a *deleted* definition leaves no kind to look up, and that
  // is exactly the case where the owner must be told to withdraw the agent. Behind the lookup, a
  // deletion would never reconcile and a withdrawn kind would stay dispatchable.
  const current = policyOf();
  if (state.registeredSignature !== null) {
    const planned = kindRegistrationPlan(current.kinds, import.meta.url);
    if (planSignature(planned.desired) !== state.registeredSignature) {
      await syncAgentKinds(host, runtime);
    }
  }

  if (fanout !== null) return await gateFanout(host, state, runtime, fanout, current.kinds, event.input);

  // A name the project's table does not know is not this gate's business: the dispatch goes
  // through untouched, exactly as it did before kinds existed.
  if (decoded === null) return;
  const kind = resolveDispatchKind(decoded.agent, current.kinds);
  if (kind === null) return;

  const dispatch: KindDispatch = { ...decoded, kind };
  // Every launch, wherever it starts, asks this one question.
  const admitted = await admitOne(host, state, runtime, { kind: dispatch.kind, count: 1 });
  if (!admitted.ok) return refusalForFailure(admitted.failure, dispatch, state.snapshot);

  // Admitted: fill what the caller should not have to think about, and never let it block the
  // main session. Both rewrites are project policy, applied in one place.
  countDefaults(state, applyDispatchDefaults(event.input, admitted.config?.subagentRunBudgetMs));
  return;
}

/**
 * The kind policy a `coworkflow.fanout` resolver needs, resolved in memory.
 *
 * A workflow resolver is synchronous and I/O-free by contract, so it cannot read
 * the project config or the owner's registry. This is where that reading happens:
 * at gate time, from the same `resolveKinds` the panel and the `tool_call` gate use,
 * so a fanout cannot disagree with a direct dispatch about what "disabled" means.
 *
 * `dispatchable` is the gate's own answer: enabled *and* accepted by the owner in
 * this session. A kind that is enabled but unregistered is refused with the
 * registration reason rather than started, because such a launch fails at the
 * runner as "unknown agent" — the dishonest half-degradation this module exists to
 * remove. When the policy itself cannot be read, every kind is refused for that
 * reason; "probably fine" is the bug, not the fallback.
 */
export function fanoutPolicyFor(host: object, runtime: RuntimeContext): FanoutPolicy {
  if (!runtime.enabled || !runtime.control.moduleEnabled("agent-kinds")) {
    return { kinds: shippedKindPolicies(), unavailable: "本会话的「子 agent 类型」（agent-kinds）模块已关闭，无法确认任何 kind 是否可以派单" };
  }
  // A root git could not resolve reads as "no config", which is the same answer
  // the panel gives: absent policy means the built-in defaults, not a guess.
  const root = runtime.configRoots.root(runtime.cwd);
  const kinds = resolveKinds(root === null ? null : readConfig(root), readKindDefinitions(root).definitions);
  const snapshot = STATES.get(host as PiRuntimeHost)?.snapshot ?? null;
  const live = snapshot === null || snapshot.contractFailure !== undefined
    ? null
    : new Set(snapshot.registered.map((entry) => entry.kind));
  const available = availableKinds(kinds, snapshot);
  return {
    kinds: kinds.map((entry) => {
      if (!entry.enabled) {
        return { kind: entry.kind, agent: entry.agent, dispatchable: false,
          refusal: disabledKindMessage(entry.kind, entry.agent, available) };
      }
      if (live === null || !live.has(entry.kind)) {
        return { kind: entry.kind, agent: entry.agent, dispatchable: false,
          refusal: unregisteredKindMessage(entry.kind, entry.agent, registrationReason(snapshot, entry.kind)) };
      }
      return {
        kind: entry.kind,
        agent: entry.agent,
        dispatchable: true,
        maxConcurrent: entry.maxConcurrent,
      };
    }),
  };
}

/** Every kind this package ships, marked dispatchable: the no-policy fallback. */
function shippedKindPolicies(): FanoutKindPolicy[] {
  return BUILTIN_KINDS.map((entry) => ({ kind: entry.kind, agent: agentNameFor(entry.kind), dispatchable: true }));
}

/** Why an enabled kind is not in the owner's agent list, in the gate's words. */
function registrationReason(snapshot: Snapshot | null, kind: string): string {
  if (snapshot === null) return "本会话的 agent kind 注册尚未完成，无法确认它真的在 agent 列表里";
  return snapshot.contractFailure ?? snapshot.failures.find((entry) => entry.kind === kind)?.reason ??
    "该 kind 未注册（可能缺少系统提示资产或被上游拒绝）";
}

/**
 * The agents `coworkflow.implement-review` should run, from the project's kinds.
 *
 * A kind replaces a fixed agent name *only* when it is both enabled and actually
 * registered in this session's agent list — an enabled-but-unregistered kind would
 * make the fixed workflow fail with "unknown agent", which is a worse answer than
 * running the built-in pair. Roles come from the resolved entry, so this and
 * `subagent-context` cannot disagree about what a kind receives.
 *
 * `entry.role` and not `kindRole(entry.kind)`: the latter reads the *shipped* kind's
 * default, so a project definition that declared `role: check` (or changed it away)
 * would be ignored here while the injected context followed the file — the workflow
 * would then hand the implement step to the agent whose children get check context.
 *
 * `undefined` means "keep the built-in default", never "no agent".
 */
export function kindWorkflowAgents(
  host: object,
  kinds: readonly ResolvedAgentKind[],
): { implementAgent?: string; reviewAgent?: string } {
  const live = new Set(kindRegistryFor(host).registered().map((entry) => entry.kind));
  const chosen: { implementAgent?: string; reviewAgent?: string } = {};
  for (const entry of kinds) {
    if (!entry.enabled || !live.has(entry.kind)) continue;
    if (entry.role === "implement") chosen.implementAgent = entry.agent;
    else if (entry.role === "check") chosen.reviewAgent = entry.agent;
  }
  return chosen;
}

/**
 * Reconcile this host's kind registrations with the live gates, and settle when
 * the pass is done.
 *
 * The orchestrator calls it (fire and forget) from `activate` and
 * `onRuntimeChange`; a test awaits it because it needs to know whether the agent
 * actually registered. Same-session callers await the pass already in flight
 * instead of observing a half-built set.
 *
 * A child session is *recorded* as skipped rather than short-circuited here: the
 * status report has to be able to say "this is a child, kinds are the parent's"
 * instead of "still loading", which would send a reader looking for a bug.
 */
export function syncAgentKinds(host: PiRuntimeHost, runtime: RuntimeContext): Promise<void> {
  return schedule(host, runtime);
}

/**
 * This host's admission state, for another launch path that must ask the same authority.
 *
 * The queued channel (`modules/dispatch`) admits one unit at a time through `admitOne()`, and
 * `admitOne` decides from the registration snapshot this module owns. Exposing the state is
 * what lets that channel ask the *same* question instead of rebuilding a second one — a
 * reimplementation would drift the moment the gate's order or snapshot changes.
 */
export function agentKindsState(host: PiRuntimeHost): ReturnType<typeof stateFor> {
  return stateFor(host);
}

export const agentKindsModule: WorkflowModule = {
  id: "agent-kinds",
  title: "子 agent 类型（cw-executor / cw-auditor，按 kind 注册到 pi-subagents）",

  /**
   * Register this host's kinds, keep them matching the gates, and gate dispatches.
   *
   * Nothing is registered at load: the project config decides which kinds exist,
   * and reading it needs the configuration root — so the first pass runs here and
   * every later gate move runs it again.
   *
   * The `tool_call` listener is registered even while the layer is off, because a
   * hook cannot be added later by an event that already happened: it reads both
   * switches itself on every call, and `onSessionEnd` is the only place that
   * releases it.
   */
  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    const state = stateFor(host);
    if (host.on && !state.listeners.has("tool_call")) {
      state.listeners.set("tool_call", host.on("tool_call", (event: any) => gate(host, state, runtime, event)));
    }
    // The DIY port, registered once per host: the command writes through the same control
    // surface, and this is the programmatic door onto it.
    if (!state.listeners.has("kind-port")) {
      state.listeners.set("kind-port", registerKindPort(host, runtime, runtime.control));
    }
    void syncAgentKinds(host, runtime);
  },

  onRuntimeChange(host: PiRuntimeHost, runtime: RuntimeContext): void {
    void syncAgentKinds(host, runtime);
  },

  /** A new session, or a replacement: the previous registrations are not its own. */
  onSessionEnd(host: PiRuntimeHost, _runtime: RuntimeContext): void {
    const state = STATES.get(host);
    if (state) {
      state.generation += 1;
      state.snapshot = null;
      state.registeredSignature = null;
      state.skipped = "off";
      for (const [name, off] of state.listeners) {
        if (typeof off === "function") off();
        state.listeners.delete(name);
      }
      if (state.attached) {
        existingSubagentsBridge(host)?.dispose();
        state.attached = false;
      }
    }
    // The registry itself is kept: the next activation registers into it rather
    // than leaking a second set into the same process.
    kindRegistryFor(host).dispose();
  },

  /**
   * Registered kinds, or the exact reason none are.
   *
   * Never a list of kinds that "should" exist: `unshipped` and `failures` are
   * reported as what they are, so a reader can tell an unavailable contract from a
   * disabled kind from a name collision.
   */
  runtimeStatus(host: PiRuntimeHost): string[] | null {
    const state = STATES.get(host);
    if (state === undefined) {
      // The module is on in the project but this session never activated it (or the
      // layer is off). A row must not read "enabled, see the status line below" when
      // there is no line below and no gate running, so this answers with the reason
      // instead of null — the same honesty as the `skipped: "off"` branch reachable
      // when the module was activated and then gated off.
      return [`  - agent-kinds: 本会话未激活 agent-kinds：kind 不注册，也不拦截派单（用 /Coworkflow:start 在本会话启用）`];
    }
    const snapshot = state.snapshot;
    if (snapshot === null) {
      // Two different facts, and this line used to conflate them: a module that
      // was never activated in this session, and one whose registration pass is
      // still awaiting the owner's import. The second reports as pending, because
      // "not loaded" for a loaded session sends a reader looking for a bug.
      if (state.skipped === "child") {
        return [`  - agent-kinds: 这是子会话：kind 只在主会话注册，本会话不注册也不拦截派单`];
      }
      if (state.skipped === "off") {
        return [`  - agent-kinds: 本会话未加载或已关闭，未注册任何 kind`];
      }
      // A pass was started and has not landed: said as pending, because "not
      // loaded" for a loaded session sends a reader looking for a bug.
      return [`  - agent-kinds: 注册尚未完成（正在等待 pi-subagents 的运行时 agent 契约），此刻没有任何 kind 可用`];
    }
    if (snapshot.contractFailure !== undefined) {
      return [
        `  x agent-kinds: ${snapshot.contractFailure}`,
        `  - agent-kinds: 未注册任何 kind；声明过的 kind 派单会被拒绝，而不是被当成可用`,
      ];
    }
    // Where a kind came from is part of the fact: a project definition overrides what the
    // package ships, and a reader comparing the panel with the file needs to know which
    // layer decided what they are looking at.
    const fromFile = new Set(snapshot.definitions.map((entry) => entry.kind));
    const lines = snapshot.registered.map((entry) =>
      `  = agent-kinds: ${entry.agent}（kind ${entry.kind}）已注册${kindModelSuffix(entry)}${
        fromFile.has(entry.kind) ? " · 来自项目定义文件" : ""
      }`,
    );
    // "Nothing enabled" and "everything failed" are different facts, and the
    // second one must never read as the first: a reader who sees "没有启用的 kind"
    // stops looking, while a failed registration is exactly what they need to see.
    if (lines.length === 0 && snapshot.failures.length === 0 && snapshot.unshipped.length === 0) {
      lines.push(`  - agent-kinds: 没有启用的 kind，未注册任何 agent`);
    } else if (lines.length === 0) {
      lines.push(`  - agent-kinds: 没有已注册的 kind（启用的 kind 都未能注册，原因见下）`);
    }
    for (const entry of snapshot.disabled) {
      lines.push(`  - agent-kinds: ${entry.kind} 已关闭（不注册；派单会被拒绝）${kindModelSuffix(entry)}`);
    }
    if (state.forcedBackground > 0) {
      lines.push(
        `  ~ agent-kinds: 已把 ${state.forcedBackground} 次「前台」派单改为后台（本项目要求子 agent 不占住主会话；需要结果就用 bg_wait 等它）`,
      );
    }
    for (const entry of snapshot.failures) lines.push(`  x agent-kinds: ${entry.kind} 无法使用：${entry.reason}`);
    for (const kind of snapshot.unshipped) {
      lines.push(`  ! agent-kinds: 项目声明了 kind ${kind}，但本包没有这个 kind 的定义，未注册`);
    }
    return lines;
  },
};
