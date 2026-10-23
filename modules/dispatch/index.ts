/**
 * Module: the queued dispatch channel (`coworkflow.dispatch`).
 *
 * Handing over ten work units one call at a time is what makes a parent session
 * serial and slow: the model dispatches until a ceiling refuses, then has to
 * remember what was left, wait, and dispatch again. This channel takes the whole
 * plan at once and keeps it: each unit is admitted through the same
 * `admitOne()` a direct dispatch uses, and a unit that does not fit the kind's
 * ceiling waits here until a running one finishes.
 *
 * ## What this is not
 *
 * Not a second executor and not a scheduler with its own truth. Every launch goes
 * through the owner's public RPC `spawn`, and every completion is *observed* from
 * the owner's public events — never polled, never inferred from a timer. The queue
 * is process-local state, and it is deliberately not persisted: a queue that
 * survives a session would be a second lifecycle ledger that disagrees with the
 * owner's, which is the failure this package exists to avoid.
 *
 * ## The rules that keep the queue honest
 *
 *   - **One admission authority.** `admitOne()` decides. A refusal that will not
 *     improve by waiting is a failure here too (`disabled`, `unregistered`,
 *     `unknown-count`, `session-gone`); only `over-ceiling` becomes "queued",
 *     because that is the one refusal a completion can lift.
 *   - **Dependencies are data.** `needs: [key…]` is satisfied only by `completed`
 *     prerequisites. A failed prerequisite fails its dependents with reason
 *     `dependency` — waiting cannot fix it.
 *   - **A new session invalidates the queue, and says so.** Reporting the new
 *     session as an empty queue would claim "nothing was in flight", which is the
 *     opposite of what happened to the runs the old session had started.
 */

import type { PiRuntimeHost, RuntimeContext, Unsubscribe, WorkflowModule } from "../../core/module.ts";
import { readConfig } from "../../core/config.ts";
import { decodeNativeCompletions } from "../../core/pi-subagents.ts";
import { attachSubagents } from "../../core/subagents-client.ts";
import { RUN_BUDGET_MS, checkpointFor } from "../../core/subagents-workflow.ts";
import { admitOne, agentKindsState, type AdmitFailure, type AdmitResult } from "../agent-kinds/index.ts";

/** Why a unit is waiting. Only these two can be lifted by something else happening. */
export type QueueReason = "ceiling" | "dependency";

/** One work unit as the caller hands it over. */
export interface DispatchTaskInput {
  /** Stable name other units use in `needs`; derived when absent. */
  key?: string;
  /** A kind from the project table (`executor`, `auditor`, …). */
  kind: string;
  /** The task text the child receives. */
  task: string;
  /** Keys that must be `completed` before this unit may start. */
  needs?: string[];
}

export interface DispatchInput {
  tasks: readonly DispatchTaskInput[];
  /** Isolate every launched child in a managed worktree. */
  worktree?: boolean;
}

export interface DispatchResult {
  started: { key: string; runId: string; kind: string }[];
  queued: { key: string; kind: string; reason: QueueReason }[];
  failed: { key: string; kind: string; reason: string }[];
}

/** What one launch produced: the owner's run id, or a reason it did not start. */
export type LaunchOutcome = { ok: true; runId: string } | { ok: false; reason: string };

export interface LaunchRequest {
  key: string;
  kind: string;
  /** The agent name the admitted policy resolved to; never re-derived here. */
  agent: string;
  task: string;
  worktree?: boolean;
}

/** The two side effects the queue needs, injected so the queue itself stays pure state. */
export interface DispatchDeps {
  admit(kind: string): Promise<AdmitResult>;
  launch(request: LaunchRequest): Promise<LaunchOutcome>;
}

type TaskStatus = "waiting" | "running" | "completed" | "failed";

interface Task {
  key: string;
  kind: string;
  task: string;
  needs: string[];
  status: TaskStatus;
  /** A queue reason while waiting, a failure reason once failed. */
  reason?: QueueReason | string;
  runId?: string;
  worktree?: boolean;
}

/** What a session replacement threw away, so the next report can say it happened. */
export interface SessionInvalidation {
  running: number;
  queued: number;
}

export interface DispatchSnapshot {
  epoch: number;
  running: { key: string; kind: string; runId: string }[];
  queued: { key: string; kind: string; reason: QueueReason }[];
  failed: { key: string; kind: string; reason: string }[];
  completed: number;
  invalidated: SessionInvalidation | null;
}

/** The bound a single call may hand over: a plan, not a bulk import. */
const MAX_TASKS = 24;
const MAX_TEXT = 20_000;

export interface DispatchQueue {
  readonly epoch: number;
  /** Adopt a session epoch, invalidating whatever belonged to the previous one. */
  bindSession(epoch: number): SessionInvalidation | null;
  submit(input: DispatchInput): Promise<DispatchResult>;
  /** One observed completion: release the slot, then start what now fits. */
  settle(runId: string, outcome: "completed" | "failed"): Promise<DispatchResult>;
  snapshot(): DispatchSnapshot;
  /** `/Coworkflow:status` lines: current counts, or what a replacement discarded. */
  statusLines(): string[];
}

/**
 * Why an admission refusal is not queueable, in the user's words.
 *
 * `over-ceiling` never reaches here: it is the one refusal this channel answers
 * with a place in line. Every other code means "waiting changes nothing", and
 * saying that is more useful than leaving a unit in a queue that will never run.
 */
export function failureReason(failure: AdmitFailure): string {
  switch (failure.code) {
    case "disabled":
      return "kind 已关闭：等多久都不会有名额，先在 /Coworkflow:settings 打开它";
    case "unregistered":
      return "kind 未注册到 pi-subagents：本会话派不出去";
    case "unknown-count":
      return `无法确认该 kind 当前占用：${failure.reason}`;
    case "session-gone":
      return "会话已更换或该层已关闭，未启动子进程";
    case "over-ceiling":
      return "超过并发上限";
  }
}

/**
 * The queue itself: plain in-process state plus the two injected side effects.
 *
 * Every mutating entry point runs on one serialized chain, so two overlapping
 * `submit`/`settle` calls cannot both decide that the same slot is free — the
 * double-launch this shape exists to prevent.
 */
export function createDispatchQueue(deps: DispatchDeps, epoch: number): DispatchQueue {
  let currentEpoch = epoch;
  let tasks: Task[] = [];
  let invalidated: SessionInvalidation | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  }

  function index(): Map<string, Task> {
    return new Map(tasks.map((task) => [task.key, task]));
  }

  /** Fail every waiting unit whose prerequisite failed (or does not exist). */
  function cascade(): void {
    const byKey = index();
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (task.status !== "waiting") continue;
        const broken = task.needs.some((key) => {
          const dependency = byKey.get(key);
          return dependency === undefined || dependency.status === "failed";
        });
        if (!broken) continue;
        task.status = "failed";
        task.reason = "dependency";
        changed = true;
      }
    }
  }

  /**
   * One scheduling pass.
   *
   * Order is insertion order, and each unit is decided against the state at that
   * moment: an admission refusal for one unit never skips another kind's unit, and
   * a unit that just started raises the count the next `admitOne` reads.
   */
  async function pass(): Promise<DispatchResult> {
    cascade();
    const result: DispatchResult = { started: [], queued: [], failed: [] };
    for (const task of tasks) {
      if (task.status === "failed") {
        result.failed.push({ key: task.key, kind: task.kind, reason: String(task.reason ?? "failed") });
        continue;
      }
      if (task.status !== "waiting") continue;
      const unmet = task.needs.some((key) => index().get(key)?.status !== "completed");
      if (unmet) {
        task.reason = "dependency";
        result.queued.push({ key: task.key, kind: task.kind, reason: "dependency" });
        continue;
      }
      const admitted = await deps.admit(task.kind);
      if (!admitted.ok) {
        if (admitted.failure.code === "over-ceiling") {
          task.reason = "ceiling";
          result.queued.push({ key: task.key, kind: task.kind, reason: "ceiling" });
        } else {
          task.status = "failed";
          task.reason = failureReason(admitted.failure);
          result.failed.push({ key: task.key, kind: task.kind, reason: task.reason });
        }
        continue;
      }
      const launched = await deps.launch({
        key: task.key,
        kind: task.kind,
        agent: admitted.policy.agent,
        task: task.task,
        ...(task.worktree === true ? { worktree: true } : {}),
      });
      if (!launched.ok) {
        task.status = "failed";
        task.reason = launched.reason;
        result.failed.push({ key: task.key, kind: task.kind, reason: task.reason });
        continue;
      }
      task.status = "running";
      task.runId = launched.runId;
      delete task.reason;
      result.started.push({ key: task.key, runId: launched.runId, kind: task.kind });
    }
    // A unit that failed during this pass may have waiting dependents that the
    // opening cascade could not see yet.
    cascade();
    return result;
  }

  function validate(input: DispatchInput): { tasks: Task[]; worktree?: boolean } {
    if (input === null || typeof input !== "object") throw new Error("tasks 必须是数组。");
    const raw = input.tasks;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("tasks 至少要有 1 个工作单元。");
    if (raw.length > MAX_TASKS) throw new Error(`tasks 最多 ${MAX_TASKS} 个工作单元（一次交一个计划，不是批量导入）。`);
    const existing = index();
    const planned: Task[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, position) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`第 ${position + 1} 个工作单元不是对象。`);
      }
      const key = typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : `task-${position + 1}`;
      if (seen.has(key)) throw new Error(`工作单元 key 重复：${key}`);
      if (existing.has(key)) throw new Error(`工作单元 key 已在本会话队列里：${key}`);
      seen.add(key);
      const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
      if (!kind) throw new Error(`${key} 缺少 kind。`);
      const task = typeof entry.task === "string" ? entry.task.trim() : "";
      if (!task) throw new Error(`${key} 缺少 task 正文。`);
      if (task.length > MAX_TEXT) throw new Error(`${key} 的 task 正文过长（上限 ${MAX_TEXT} 字符）。`);
      // A prerequisite list, not prose: unknown keys are reported as failed by the
      // first pass (a dependency nothing satisfies cannot arrive later).
      const needs: string[] = [];
      if (Array.isArray(entry.needs)) {
        for (const value of entry.needs) {
          if (typeof value === "string" && value.trim() !== "") needs.push(value.trim());
        }
      }
      planned.push({ key, kind, task, needs: [...new Set(needs)], status: "waiting", ...(input.worktree === true ? { worktree: true } : {}) });
    });
    return { tasks: planned, ...(input.worktree === true ? { worktree: true } : {}) };
  }

  return {
    get epoch() {
      return currentEpoch;
    },

    bindSession(nextEpoch: number): SessionInvalidation | null {
      if (nextEpoch === currentEpoch) return null;
      const report: SessionInvalidation = {
        running: tasks.filter((task) => task.status === "running").length,
        queued: tasks.filter((task) => task.status === "waiting").length,
      };
      tasks = [];
      currentEpoch = nextEpoch;
      // Nothing in flight means nothing was discarded; that is not a report.
      invalidated = report.running + report.queued > 0 ? report : null;
      return invalidated;
    },

    submit(input: DispatchInput): Promise<DispatchResult> {
      return serial(async () => {
        const planned = validate(input);
        tasks.push(...planned.tasks);
        return pass();
      });
    },

    settle(runId: string, outcome: "completed" | "failed"): Promise<DispatchResult> {
      return serial(async () => {
        const task = tasks.find((entry) => entry.runId === runId && entry.status === "running");
        // An unobserved or foreign run is not silently "a slot freed": it simply is
        // not ours, so nothing starts on the strength of it.
        if (task === undefined) return { started: [], queued: [], failed: [] };
        if (outcome === "completed") {
          task.status = "completed";
          delete task.reason;
        } else {
          task.status = "failed";
          task.reason = "run 失败";
        }
        return pass();
      });
    },

    snapshot(): DispatchSnapshot {
      return {
        epoch: currentEpoch,
        running: tasks.flatMap((task) =>
          task.status === "running" && task.runId !== undefined
            ? [{ key: task.key, kind: task.kind, runId: task.runId }]
            : []),
        queued: tasks.flatMap((task) =>
          task.status === "waiting"
            ? [{ key: task.key, kind: task.kind, reason: (task.reason ?? "dependency") as QueueReason }]
            : []),
        failed: tasks.flatMap((task) =>
          task.status === "failed" ? [{ key: task.key, kind: task.kind, reason: String(task.reason ?? "failed") }] : []),
        completed: tasks.filter((task) => task.status === "completed").length,
        invalidated,
      };
    },

    statusLines(): string[] {
      const snapshot = this.snapshot();
      const counts = new Map<QueueReason, number>();
      for (const entry of snapshot.queued) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
      const reasons = [...counts].map(([reason, count]) => `${reason} ${count}`).join("、");
      const lines = [
        `  dispatch: ${snapshot.running.length} 运行 / ${snapshot.queued.length} 排队${reasons ? `（${reasons}）` : ""}`,
      ];
      if (snapshot.invalidated !== null) {
        lines.push(
          `  dispatch: 会话换代作废了上一代队列（${snapshot.invalidated.running} 运行 / ${snapshot.invalidated.queued} 排队）：` +
          "那些 run 仍属于旧会话，不在这里当作空队列",
        );
      }
      for (const entry of snapshot.failed) {
        lines.push(`  x dispatch: ${entry.key}（kind ${entry.kind}）失败：${entry.reason}`);
      }
      return lines;
    },
  };
}

// ── Host wiring: admission, the public RPC spawn, and observed completions ──

/** The owner's exact completion event, advertised as `events.asyncComplete`. */
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const TOOL_NAME = "coworkflow.dispatch";

interface HostState {
  runtime: RuntimeContext | null;
  queue: DispatchQueue | null;
  listeners: Unsubscribe[];
  toolRegistered: boolean;
}

const HOSTS = new WeakMap<PiRuntimeHost, HostState>();

function hostState(host: PiRuntimeHost): HostState {
  const existing = HOSTS.get(host);
  if (existing) return existing;
  const created: HostState = { runtime: null, queue: null, listeners: [], toolRegistered: false };
  HOSTS.set(host, created);
  return created;
}

/**
 * One launch through the owner's public RPC `spawn`.
 *
 * The budget and the hand-over checkpoint are project policy, not per-unit
 * judgement, so they are attached here instead of being asked of the caller. A
 * lost reply is reported as a failed unit rather than retried: `spawn` is not
 * idempotent, and re-sending would be the one thing this package must never do.
 */
async function spawnViaRpc(
  host: PiRuntimeHost,
  runtime: RuntimeContext,
  request: LaunchRequest,
): Promise<LaunchOutcome> {
  const epoch = runtime.sessionEpoch;
  const bridge = attachSubagents(host, { epoch, events: host.events });
  const root = runtime.configRoots.root(runtime.cwd);
  const budget = (root === null ? null : readConfig(root)?.subagentRunBudgetMs) ?? RUN_BUDGET_MS;
  const reply = await bridge.client.spawn({
    agent: request.agent,
    task: request.task,
    context: "fresh",
    timeoutMs: budget,
    checkpointBeforeDeadlineMs: checkpointFor(budget),
    ...(request.worktree === true ? { worktree: true } : {}),
  });
  if (runtime.sessionEpoch !== epoch) return { ok: false, reason: "会话在启动期间更换，未把这次启动算进本会话" };
  if (!reply.ok) return { ok: false, reason: reply.message };
  if (reply.data.runId === null) {
    return {
      ok: false,
      reason: "pi-subagents 的 spawn 回复没有运行确认；这次派单可能已经在跑，本扩展不会重发，请用 status 查证后再决定",
    };
  }
  return { ok: true, runId: reply.data.runId };
}

/**
 * The admission question, asked once per launch.
 *
 * The local guard after `admitOne()` covers the one window the public count cannot:
 * a unit started moments ago may not be visible in the owner's fleet yet, and
 * admitting on a stale count is how a ceiling of two starts four. Our own running
 * units are real work, so using them as a floor never refuses something that
 * actually fits.
 */
export async function admitDispatch(
  host: PiRuntimeHost,
  state: HostState,
  runtime: RuntimeContext,
  kind: string,
): Promise<AdmitResult> {
  const admitted = await admitOne(host, agentKindsState(host), runtime, { kind, count: 1 });
  if (!admitted.ok) return admitted;
  const local = state.queue?.snapshot().running.filter((entry) => entry.kind === kind).length ?? 0;
  if (local >= admitted.policy.maxConcurrent) {
    return {
      ok: false,
      failure: {
        code: "over-ceiling",
        limit: admitted.policy.maxConcurrent,
        occupancy: local,
        requested: 1,
      },
    };
  }
  return admitted;
}

/** The session's queue, created on first use and re-bound to the current epoch. */
function queueFor(host: PiRuntimeHost, runtime: RuntimeContext): DispatchQueue {
  const state = hostState(host);
  state.runtime = runtime;
  if (state.queue === null) {
    const deps: DispatchDeps = {
      admit: (kind) => admitDispatch(host, state, runtime, kind),
      launch: (request) => spawnViaRpc(host, runtime, request),
    };
    state.queue = createDispatchQueue(deps, runtime.sessionEpoch);
  }
  state.queue.bindSession(runtime.sessionEpoch);
  return state.queue;
}

/** Settle one run from either observation path; a stale observation changes nothing. */
function observeCompletion(host: PiRuntimeHost, runId: string, outcome: "completed" | "failed"): void {
  const state = HOSTS.get(host);
  if (state?.queue === null || state?.queue === undefined) return;
  void state.queue.settle(runId, outcome).catch(() => {});
}

/** The completion payload's own verdict, without reading prose. */
function outcomeOf(payload: unknown): "completed" | "failed" {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (record.success === false) return "failed";
  const state = typeof record.state === "string" ? record.state : typeof record.status === "string" ? record.status : "";
  return state === "failed" || state === "stopped" || state === "rejected" || state === "cancelled" ? "failed" : "completed";
}

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_TASKS,
      description: "全部工作单元，一次交完；放不进 kind 上限的会排队，完成一个自动启动下一个。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "task"],
        properties: {
          key: { type: "string", minLength: 1, description: "本单元的名字，needs 用它引用；省略则按位置生成 task-<n>。" },
          kind: { type: "string", minLength: 1, description: "项目 kind 表里的名字，例如 executor / auditor / researcher。" },
          task: { type: "string", minLength: 1, description: "交给子 agent 的任务正文。" },
          needs: {
            type: "array",
            description: "必须已 completed 的前置单元 key；前置 failed 时本单元也 failed（reason dependency）。",
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    worktree: { type: "boolean", description: "每个子项都在受管 worktree 里跑。" },
  },
} as const;

/** The model-facing report: what started, what waits, and why anything failed. */
export function renderDispatchResult(result: DispatchResult): string {
  const lines: string[] = [];
  lines.push(
    `dispatch: ${result.started.length} 已启动 / ${result.queued.length} 排队 / ${result.failed.length} 失败`,
  );
  for (const entry of result.started) lines.push(`  + ${entry.key}（kind ${entry.kind}）runId ${entry.runId}`);
  for (const entry of result.queued) {
    lines.push(
      `  … ${entry.key}（kind ${entry.kind}）排队：${entry.reason === "ceiling" ? "名额已满，完成一个就自动启动它" : "前置单元未完成"}`,
    );
  }
  for (const entry of result.failed) lines.push(`  x ${entry.key}（kind ${entry.kind}）失败：${entry.reason}`);
  if (result.queued.length > 0) {
    lines.push("排队中的单元由 pi-subagents 的完成事件驱动，没有轮询；本会话的队列不写盘，会话换代后作废并报告。");
  }
  return lines.join("\n");
}

export const dispatchModule: WorkflowModule = {
  id: "dispatch",
  title: "排队派单（coworkflow.dispatch：一次交全部工作单元，按 kind 上限排队续派）",

  /**
   * Register the tool and the two completion observation paths.
   *
   * Both completion paths are attached, deliberately: `subagent:async-complete` is
   * the exact correlation an RPC spawn gets when the owner advertises it, and the
   * settled notification (`message_end` → native completions) is the path that
   * existed before it. Neither polls; whichever arrives first settles the run and
   * the second one finds nothing to do.
   */
  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;
    const state = hostState(host);
    state.runtime = runtime;
    // One subscription per host: `activate` is idempotent, and a second copy of
    // these observers would settle every run twice.
    if (state.listeners.length === 0) {
      const off = host.events?.on(ASYNC_COMPLETE_EVENT, (payload: unknown) => {
        const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        const runId = typeof record.runId === "string" ? record.runId : typeof record.id === "string" ? record.id : "";
        if (runId) observeCompletion(host, runId, outcomeOf(record));
      });
      if (typeof off === "function") state.listeners.push(off);
      const settled = host.on?.("message_end", (event: any) => {
        for (const completion of decodeNativeCompletions(event?.message)) {
          observeCompletion(host, completion.runId, completion.status === "failed" ? "failed" : "completed");
        }
        return undefined;
      });
      if (typeof settled === "function") state.listeners.push(settled);
    }
    if (!state.toolRegistered && typeof host.registerTool === "function") {
      host.registerTool({
        name: TOOL_NAME,
        label: "排队派单",
        description:
          "一次交全部工作单元：每个单元按项目 kind 表的并发上限排队，完成一个自动启动下一个；needs 声明前置单元（全部 completed 才启动，前置 failed 则失败）。启动走上游公开 RPC spawn，完成由上游事件驱动，不轮询、不落盘。",
        parameters: PARAMETERS as unknown as Record<string, unknown>,
        execute: async (_toolCallId: unknown, params: any) => {
          if (!runtime.enabled || !runtime.control.moduleEnabled("dispatch")) {
            return text("本会话没有启用 dispatch 模块：先用 /Coworkflow:start 或 .pi/Coworkflow.json 打开它。", true);
          }
          if (!runtime.control.moduleEnabled("agent-kinds")) {
            return text("agent-kinds 关着：排队派单依赖 kind 表的并发上限，没有它就没有可排的队。请先打开 agent-kinds。", true);
          }
          const queue = queueFor(host, runtime);
          try {
            const result = await queue.submit({
              tasks: (params?.tasks ?? []) as DispatchTaskInput[],
              ...(params?.worktree === true ? { worktree: true } : {}),
            });
            return {
              content: [{ type: "text" as const, text: renderDispatchResult(result) }],
              details: result,
              structuredContent: result as unknown,
              ...(result.failed.length > 0 ? { isError: true } : {}),
            };
          } catch (error) {
            return text(`dispatch 未执行：${error instanceof Error ? error.message : String(error)}`, true);
          }
        },
      });
      state.toolRegistered = true;
    }
    // Bind the session this activation belongs to, so a queue left over from the
    // previous session is invalidated (and reported) before the first call.
    queueFor(host, runtime);
  },

  /**
   * Drop the observers; the tool registration stays (it reads the session at call time).
   *
   * A listener that outlived its session would settle a run for whichever session came
   * next, so session end releases them and the next activation re-subscribes. The tool
   * itself is session-agnostic: it binds the queue to the epoch of the call.
   */
  onSessionEnd(host: PiRuntimeHost): void {
    const state = HOSTS.get(host);
    if (!state) return;
    for (const off of state.listeners) {
      try {
        off();
      } catch {
        // Releasing must not turn a session end into an error.
      }
    }
    state.listeners = [];
  },

  runtimeStatus(host: PiRuntimeHost): string[] | null {
    const state = HOSTS.get(host);
    if (!state?.queue || !state.runtime) {
      return [`  - dispatch: 本会话未激活 dispatch（coworkflow.dispatch 不可用）`];
    }
    // A status render is also a valid moment to notice a session replacement: the
    // old queue's runs are not this session's, and reporting them as this session's
    // queue would be the empty-queue lie in the other direction.
    state.queue.bindSession(state.runtime.sessionEpoch);
    const lines = state.queue.statusLines();
    // A tool this host cannot register must not read as an available channel.
    if (!state.toolRegistered) {
      lines.push(`  ! dispatch: 本会话的宿主没有提供 registerTool，coworkflow.dispatch 不可用`);
    }
    return lines;
  },
};

function text(body: string, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: body }],
    details: { error: isError ? body : undefined },
    ...(isError ? { isError: true } : {}),
  };
}
