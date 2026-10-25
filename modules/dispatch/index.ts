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
 *   - **Dependencies are data.** `needs: [key…]` is satisfied only by a *positively*
 *     `completed` prerequisite. A failed prerequisite fails its dependents with
 *     reason `dependency` — waiting cannot fix it. A cycle is refused at submission
 *     rather than left waiting forever.
 *   - **Only success releases a need.** `paused` / `stopped` / `failed` notices and
 *     payloads that say nothing are never treated as completion: one classifier reads
 *     both observation paths.
 *   - **Capacity is the owner's, and the launch path is shared.** A queued launch goes
 *     through the same public bridge reservation a direct dispatch uses, because an RPC
 *     spawn never reaches this package's `tool_call` hook.
 *   - **A closed gate stops automatic starts.** Module switches and session replacement
 *     are re-read immediately before each launch, including after an awaited read.
 *   - **A new session invalidates the queue, and says so.** Reporting the new
 *     session as an empty queue would claim "nothing was in flight", which is the
 *     opposite of what happened to the runs the old session had started.
 */

import { randomUUID } from "node:crypto";

import type { PiRuntimeHost, RuntimeContext, Unsubscribe, WorkflowModule } from "../../core/module.ts";
import { readConfig } from "../../core/config.ts";
import { decodeNativeCompletions } from "../../core/pi-subagents.ts";
import { attachSubagents, existingSubagentsBridge } from "../../core/subagents-client.ts";
import { RUN_BUDGET_MS, checkpointFor } from "../../core/subagents-workflow.ts";
import { admitOne, agentKindsState, type AdmitFailure, type AdmitResult } from "../agent-kinds/index.ts";

/**
 * Why a unit is waiting.
 *
 * `ceiling` (a slot or the project's shared total) and `dependency` (a prerequisite
 * is not completed yet) can be lifted by something happening. `gated` is the third: a
 * module switch or session replacement currently forbids automatic starts, and only a
 * state change lifts it — never a timer.
 */
export type QueueReason = "ceiling" | "dependency" | "gated";

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
  /**
   * Launches whose outcome is unknown: possibly started, never retried.
   *
   * Without this field such a unit appeared in no list at all, so a caller reading
   * only the counts saw `0 已启动 / 0 排队 / 0 失败` for work that may well be running.
   */
  unobserved: { key: string; kind: string; detail: string }[];
  /**
   * Set when the session changed while this operation was awaiting something.
   *
   * The operation belongs to the epoch it was called in, and never to the one that
   * replaced it: whatever it had started is reported, nothing new is started, and
   * the submission is not adopted into the new session's queue.
   */
  stale?: true;
}

/**
 * What one launch produced: the owner's run id, or a reason it did not start.
 *
 * `disposition` is what stops the queue from lying about a non-start:
 *   - `wait` — nothing was started and nothing was consumed (capacity), so the unit
 *     keeps its place in line;
 *   - `unobserved` — the request was emitted and its outcome is unknown. That is not
 *     "no process started" and it is not a completion; the unit is reported as
 *     unconfirmed and its reservation stays held until the session ends;
 *   - `gated` — nothing was emitted and nothing was consumed, but the reason is a
 *     closed switch rather than a full ceiling, so the unit keeps its place in line
 *     under the `gated` reason instead of claiming capacity will free it.
 */
export type LaunchOutcome = { ok: true; runId: string } | {
  ok: false;
  reason: string;
  disposition?: "failed" | "wait" | "unobserved" | "gated";
};

/** The verdict of one observed completion. Only `completed` releases a `needs`. */
export type SettleOutcome = "completed" | "failed" | "stopped";

const COMPLETED_STATES = new Set(["complete", "completed"]);
const STOPPED_STATES = new Set(["paused", "stopped", "detached", "interrupted"]);
const FAILED_STATES = new Set(["failed", "failure", "error", "rejected", "cancelled", "canceled", "partial", "aborted"]);

/**
 * One classifier for every completion route.
 *
 * The owner reports a run's end in two documented shapes — the async event's
 * `state`/`success` and `subagent-notify`'s `details.runs[].status` — and both name
 * ends that are *not* success (`paused`, `stopped`, `partial`). Reading either one as
 * "completed" would start a dependent on work nobody finished, so the verdict is
 * decided here once and `unknown` means "no evidence", never "fine".
 */
export function settleOutcomeOf(payload: unknown): SettleOutcome | "unknown" {
  const record = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (record === null) return "unknown";
  const declared = typeof record.state === "string" ? record.state : typeof record.status === "string" ? record.status : "";
  const state = declared.trim().toLowerCase();
  // An explicit failure outranks a contradictory success flag: the conservative
  // reading is the one that does not release a dependency.
  if (record.success === false) return "failed";
  if (STOPPED_STATES.has(state)) return "stopped";
  if (FAILED_STATES.has(state)) return "failed";
  if (COMPLETED_STATES.has(state)) return "completed";
  return "unknown";
}

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
  /**
   * Whether an automatic start is allowed right now, with the reason when it is not.
   *
   * Read immediately before every launch *and* again after an awaited admission: a
   * module switched off, or a session replaced, during that read must not start work.
   */
  gate?(): string | null;
}

/**
 * `unobserved` is a launch whose outcome is unknown: the request was emitted and we
 * have neither the owner's run id nor proof that nothing started. It is deliberately
 * neither `running` (that would claim we can watch it) nor `failed` (that would claim
 * it did not run and would fail its dependents on a guess).
 */
type TaskStatus = "waiting" | "running" | "completed" | "failed" | "unobserved";

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
  /** Launches that may have started and can no longer be observed from here. */
  unobserved: number;
}

export interface DispatchSnapshot {
  epoch: number;
  running: { key: string; kind: string; runId: string }[];
  queued: { key: string; kind: string; reason: QueueReason }[];
  failed: { key: string; kind: string; reason: string }[];
  /** Launches whose outcome is unknown: possibly started, never counted as success. */
  unobserved: { key: string; kind: string; detail: string }[];
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
  settle(runId: string, outcome: SettleOutcome): Promise<DispatchResult>;
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

/** The gate as a boolean answer: `null` means an automatic start is allowed. */
function closedReason(deps: DispatchDeps): string | null {
  if (typeof deps.gate !== "function") return null;
  return deps.gate();
}

/**
 * A submission that outlived its own session.
 *
 * Thrown rather than returned, because the batch was *not* adopted: an empty result
 * would read as "nothing to do", and a result with counts would attribute work to a
 * session that never accepted it.
 */
function staleSubmission(startedBeforeReplacement = 0): Error {
  const launched = startedBeforeReplacement > 0
    ? `换代前已启动了 ${startedBeforeReplacement} 个，它们属于上一代会话。`
    : "";
  return new Error(
    `会话已更换：这次提交没有并入新会话的队列，也没有自动重启。${launched}请在当前会话重新提交。`,
  );
}

/**
 * The first dependency cycle among the units of one batch, as the keys on it.
 *
 * Only the submitted batch is walked: a prerequisite that is already in the queue
 * cannot point back at a key that did not exist when it was accepted (an unknown key
 * fails its dependent there), so a cycle can only be within the batch — plus the
 * self-cycle a single unit can write for itself.
 */
function findCycle(planned: readonly Task[]): string[] | null {
  const byKey = new Map(planned.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const path: string[] = [];
  const walk = (key: string): string[] | null => {
    if (finished.has(key)) return null;
    if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key];
    visiting.add(key);
    path.push(key);
    for (const need of byKey.get(key)?.needs ?? []) {
      if (!byKey.has(need)) continue;
      const cycle = walk(need);
      if (cycle !== null) return cycle;
    }
    path.pop();
    visiting.delete(key);
    finished.add(key);
    return null;
  };
  for (const task of planned) {
    const cycle = walk(task.key);
    if (cycle !== null) return cycle;
  }
  return null;
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

  function emptyResult(): DispatchResult {
    return { started: [], queued: [], failed: [], unobserved: [] };
  }

  function index(): Map<string, Task> {
    return new Map(tasks.map((task) => [task.key, task]));
  }

  /**
   * The queue's own lists, read from the tasks as they are.
   *
   * One definition for both the snapshot and a pass's result: a tool response that
   * contradicts the snapshot it was just taken against — "queued: dependency" for a
   * unit the cascade had already failed, or a launch failure missing from `failed` —
   * is worse than no counts at all.
   */
  function waitingList(): { key: string; kind: string; reason: QueueReason }[] {
    return tasks.flatMap((task) =>
      task.status === "waiting"
        ? [{ key: task.key, kind: task.kind, reason: (task.reason ?? "dependency") as QueueReason }]
        : []);
  }

  function failedList(): { key: string; kind: string; reason: string }[] {
    return tasks.flatMap((task) =>
      task.status === "failed" ? [{ key: task.key, kind: task.kind, reason: String(task.reason ?? "failed") }] : []);
  }

  function unobservedList(): { key: string; kind: string; detail: string }[] {
    return tasks.flatMap((task) =>
      task.status === "unobserved"
        ? [{ key: task.key, kind: task.kind, detail: String(task.reason ?? "未确认") }]
        : []);
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
   *
   * Both gates are read here, not only at call time: `deps.gate()` before the
   * admission and again after it (the admission awaits public reads, and a module
   * switched off or a session replaced during that await must not launch anything).
   *
   * `opEpoch` is the epoch the operation was *called* in, captured before it joined
   * the serial chain. Comparing the live epoch against it is what stops an operation
   * that survived an awaited admission from launching into the session that replaced
   * it: after `bindSession(new)` the queue's epoch equals the runtime's again, so a
   * gate that only asked "do these agree?" would answer yes and let the old loop run.
   */
  async function pass(opEpoch: number): Promise<DispatchResult> {
    const result = emptyResult();
    if (currentEpoch !== opEpoch) {
      result.stale = true;
      return result;
    }
    cascade();
    const blocked = closedReason(deps);
    if (blocked !== null) {
      for (const task of tasks) {
        if (task.status !== "waiting") continue;
        task.reason = "gated";
        result.queued.push({ key: task.key, kind: task.kind, reason: "gated" });
      }
      return result;
    }
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
      // A session replacement during the admission ends this operation here.
      if (currentEpoch !== opEpoch) {
        result.stale = true;
        return result;
      }
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
      // The gate again, after the awaited admission: switching a module off during that
      // read must not let this launch through. (The session-replacement half of this
      // gate is the epoch identity check above, which the queue's own epoch cannot see.)
      if (closedReason(deps) !== null) {
        task.reason = "gated";
        result.queued.push({ key: task.key, kind: task.kind, reason: "gated" });
        continue;
      }
      const launched = await deps.launch({
        key: task.key,
        kind: task.kind,
        agent: admitted.policy.agent,
        task: task.task,
        ...(task.worktree === true ? { worktree: true } : {}),
      });
      // The launch itself awaits public reads: a replacement during it stops the
      // operation before it can record anything into the new epoch's queue.
      if (currentEpoch !== opEpoch) {
        result.stale = true;
        return result;
      }
      if (!launched.ok) {
        // Capacity, not this unit: nothing started and nothing was consumed, so it
        // keeps its place in line instead of being written off as a failure.
        if (launched.disposition === "wait") {
          task.reason = "ceiling";
          result.queued.push({ key: task.key, kind: task.kind, reason: "ceiling" });
          continue;
        }
        // A closed switch mid-launch: still nothing emitted, but waiting for capacity
        // is not what lifts it, so it keeps the `gated` reason.
        if (launched.disposition === "gated") {
          task.reason = "gated";
          result.queued.push({ key: task.key, kind: task.kind, reason: "gated" });
          continue;
        }
        // Emitted, unconfirmed: reported as such. Never retried, and never counted
        // as either success or a proven non-start.
        if (launched.disposition === "unobserved") {
          task.status = "unobserved";
          task.reason = launched.reason;
          result.unobserved.push({ key: task.key, kind: task.kind, detail: launched.reason });
          continue;
        }
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
    // A unit that failed during this pass may have waiting dependents the opening
    // cascade could not see yet. They are failed here, and that failure has to reach
    // the caller: a unit this pass already reported as `queued dependency` when it was
    // started is `failed dependency` by the time the pass returns, and the response
    // must say what is true when it is read, not what was true mid-loop.
    cascade();
    // `started` stays this pass's launch receipts (those are events, not state); the
    // three state lists are re-read from the queue itself.
    result.queued = waitingList();
    result.failed = failedList();
    result.unobserved = unobservedList();
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
    // Refused before anything is queued: a cycle can never be satisfied, and leaving
    // it in the queue would render as "waiting for its prerequisite" forever while
    // also occupying those keys. The submission is atomic — nothing is adopted.
    const cycle = findCycle(planned);
    if (cycle !== null) {
      throw new Error(`工作单元依赖成环：${cycle.join(" → ")}（needs 不能互相等待，也不能等自己）。`);
    }
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
        // An uncertain launch is not an empty queue: the process may well be running,
        // and it can no longer be observed from the session that replaced this one.
        unobserved: tasks.filter((task) => task.status === "unobserved").length,
      };
      tasks = [];
      currentEpoch = nextEpoch;
      // Nothing in flight means nothing was discarded; that is not a report.
      invalidated = report.running + report.queued + report.unobserved > 0 ? report : null;
      return invalidated;
    },

    submit(input: DispatchInput): Promise<DispatchResult> {
      // The epoch of the *call*, not of the moment this work finally runs: an awaited
      // admission must not carry an old submission into the next session.
      const opEpoch = currentEpoch;
      return serial(async () => {
        if (currentEpoch !== opEpoch) throw staleSubmission();
        const planned = validate(input);
        tasks.push(...planned.tasks);
        const result = await pass(opEpoch);
        // A replacement during the pass discarded the batch with the rest of the old
        // queue: reporting `0/0/0` would claim the caller's plan was never handed over.
        if (result.stale === true) throw staleSubmission(result.started.length);
        return result;
      });
    },

    settle(runId: string, outcome: SettleOutcome): Promise<DispatchResult> {
      const opEpoch = currentEpoch;
      return serial(async () => {
        // A completion observed for a session that is gone must not settle — or start
        // — anything in the session that replaced it.
        if (currentEpoch !== opEpoch) return emptyResult();
        const task = tasks.find((entry) => entry.runId === runId);
        // A duplicate observation of a run we already settled changes nothing.
        if (task !== undefined && task.status !== "running") {
          return emptyResult();
        }
        if (task !== undefined) {
          if (outcome === "completed") {
            task.status = "completed";
            delete task.reason;
          } else {
            // `stopped`/`paused` is not success: the dependents must not start on it,
            // and saying "failed" here would misdescribe what happened.
            task.status = "failed";
            task.reason = outcome === "stopped" ? "run 被停止或暂停" : "run 失败";
          }
        }
        // A completion — ours or a foreign run's — is a moment real capacity freed, so
        // waiting work gets one fresh admission here instead of waiting for the next
        // call. A foreign run is never read as success: only our own `completed` unit
        // releases a `needs`, and admission still asks the owner what is free. A closed
        // module switch or a replaced session is enforced inside `pass` itself, which is
        // why recording the end above does not depend on those switches.
        return pass(opEpoch);
      });
    },

    snapshot(): DispatchSnapshot {
      return {
        epoch: currentEpoch,
        running: tasks.flatMap((task) =>
          task.status === "running" && task.runId !== undefined
            ? [{ key: task.key, kind: task.kind, runId: task.runId }]
            : []),
        queued: waitingList(),
        failed: failedList(),
        unobserved: unobservedList(),
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
      for (const entry of snapshot.unobserved) {
        lines.push(
          `  ? dispatch: ${entry.key}（kind ${entry.kind}）启动未确认：${entry.detail}`,
        );
      }
      if (snapshot.invalidated !== null) {
        const report = snapshot.invalidated;
        const uncertain = report.unobserved > 0 ? ` / ${report.unobserved} 启动未确认` : "";
        lines.push(
          `  dispatch: 会话换代作废了上一代队列（${report.running} 运行 / ${report.queued} 排队${uncertain}）：` +
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
 * lost reply is reported as an unconfirmed launch rather than retried: `spawn` is not
 * idempotent, and re-sending would be the one thing this package must never do.
 *
 * The project-wide capacity reservation is taken on the same public bridge a direct
 * dispatch uses. An RPC spawn never passes through this package's `tool_call` hook, so
 * a per-kind ceiling alone would let the project's own total be exceeded.
 */
async function spawnViaRpc(
  host: PiRuntimeHost,
  runtime: RuntimeContext,
  request: LaunchRequest,
  gate?: () => string | null,
): Promise<LaunchOutcome> {
  const epoch = runtime.sessionEpoch;
  const bridge = attachSubagents(host, { epoch, events: host.events });
  const root = runtime.configRoots.root(runtime.cwd);
  const budget = (root === null ? null : readConfig(root)?.subagentRunBudgetMs) ?? RUN_BUDGET_MS;

  const launchId = `coworkflow-dispatch-${request.key}-${randomUUID()}`;
  const totalLimit = runtime.control.moduleEnabled("capacity") ? runtime.control.subagentConcurrency() : null;
  const admission = await bridge.admit(launchId, totalLimit);
  if (!admission.admit) {
    // The project's total is full, not the kind's: nothing started and no slot was
    // consumed, so the unit stays in line for the next completion.
    return { ok: false, reason: admission.reason, disposition: "wait" };
  }
  // The bridge read awaits public state, so the switch that was open when the queue
  // asked is not necessarily open now. Nothing has been emitted at this point, which
  // is the one moment a reservation can be dropped on proof rather than on a guess.
  if (runtime.sessionEpoch !== epoch) {
    bridge.release(launchId);
    return { ok: false, reason: "会话在启动期间更换，未把这次启动算进本会话", disposition: "gated" };
  }
  const closed = gate === undefined ? null : gate();
  if (closed !== null) {
    bridge.release(launchId);
    return { ok: false, reason: closed, disposition: "gated" };
  }

  const reply = await bridge.client.spawn(
    {
      agent: request.agent,
      task: request.task,
      context: "fresh",
      timeoutMs: budget,
      checkpointBeforeDeadlineMs: checkpointFor(budget),
      ...(request.worktree === true ? { worktree: true } : {}),
    },
    (alias) => bridge.trackAlias(launchId, alias),
  );
  if (runtime.sessionEpoch !== epoch) {
    bridge.release(launchId);
    return { ok: false, reason: "会话在启动期间更换，未把这次启动算进本会话", disposition: "gated" };
  }
  if (!reply.ok) {
    if (reply.ambiguous) {
      // Emitted and unconfirmed: the reservation stays held on the alias until the
      // session ends, exactly as the shared bridge does for a direct dispatch.
      bridge.hold(launchId, reply.ambiguous.alias);
      return { ok: false, reason: reply.message, disposition: "unobserved" };
    }
    bridge.release(launchId);
    return { ok: false, reason: reply.message };
  }
  if (reply.data.runId === null) {
    // Possibly emitted, with no run id to prove otherwise. `bind` with a null id is the
    // shared bridge's own way of keeping such a reservation (its alias, if one was
    // tracked, is what a later status read can identify); releasing it here would
    // hand the capacity of a live process to the next queued unit.
    bridge.bind(launchId, reply.data.runId);
    return {
      ok: false,
      reason: "pi-subagents 的 spawn 回复没有运行确认；这次派单可能已经在跑，本扩展不会重发，请用 status 查证后再决定",
      disposition: "unobserved",
    };
  }
  bridge.bind(launchId, reply.data.runId);
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
  // Unconfirmed launches count against the ceiling too: treating one as free would
  // admit work on capacity nobody proved was available.
  const local = state.queue?.snapshot().running.filter((entry) => entry.kind === kind).length ?? 0;
  const unknown = state.queue?.snapshot().unobserved.filter((entry) => entry.kind === kind).length ?? 0;
  if (local + unknown >= admitted.policy.maxConcurrent) {
    return {
      ok: false,
      failure: {
        code: "over-ceiling",
        limit: admitted.policy.maxConcurrent,
        occupancy: local + unknown,
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
    // Every automatic start asks the current switches: a module closed, or a
    // session replaced, stops the queue from starting anything on its own. The same
    // answer is asked again *after* the launch's own capacity read, where a launch
    // that has not emitted yet can still be withdrawn.
    const gate = (): string | null => {
      if (!runtime.enabled || runtime.isChild) return "本会话没有加载 Coworkflow";
      if (!runtime.control.moduleEnabled("dispatch")) return "dispatch 模块已关闭，当前不会自动启动";
      if (!runtime.control.moduleEnabled("agent-kinds")) return "agent-kinds 已关闭，当前不会自动启动";
      if (state.queue !== null && state.queue.epoch !== runtime.sessionEpoch) return "会话已更换";
      return null;
    };
    const deps: DispatchDeps = {
      admit: (kind) => admitDispatch(host, state, runtime, kind),
      launch: (request) => spawnViaRpc(host, runtime, request, gate),
      gate,
    };
    state.queue = createDispatchQueue(deps, runtime.sessionEpoch);
  }
  state.queue.bindSession(runtime.sessionEpoch);
  return state.queue;
}

/** Settle one run from either observation path; a stale observation changes nothing. */
function observeCompletion(host: PiRuntimeHost, runId: string, outcome: SettleOutcome | "unknown"): void {
  const state = HOSTS.get(host);
  if (!state?.queue || !state.runtime) return;
  const { runtime, queue } = state as { runtime: RuntimeContext; queue: DispatchQueue };
  // A notice that names no state is not evidence of anything: it must not complete a
  // unit, fail one, or start one — and it must not release the capacity reservation
  // its run may still be holding. Releasing on an unknown payload invents a free slot.
  if (outcome === "unknown") return;
  // A completion the owner reported releases that run's capacity reservation, which
  // is precisely the event the shared bridge reserves for `releaseRun`.
  existingSubagentsBridge(host)?.releaseRun(runId);
  if (runtime.isChild) return;
  if (queue.epoch !== runtime.sessionEpoch) {
    // A callback from a session that is gone may only invalidate: it must never start
    // work in the session that replaced it.
    queue.bindSession(runtime.sessionEpoch);
    return;
  }
  // The end is recorded even when a module switch currently forbids *starts*: the run
  // really ended, and dropping that would leave the unit running forever while losing
  // the completion, so re-enabling the module could never recover it. `pass` is what
  // decides whether anything may launch, and it refuses while a switch is closed.
  void queue.settle(runId, outcome).catch(() => {});
}

/** The completion payload's own verdict, without reading prose. */
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

/** What each waiting reason means, in the words the model and the user read. */
const QUEUED_REASON_TEXT: Record<QueueReason, string> = {
  ceiling: "名额已满，完成一个就自动启动它",
  dependency: "前置单元未完成",
  gated: "派单已被关闭或会话已更换，当前不会自动启动",
};

/** The model-facing report: what started, what waits, what is unconfirmed, and why anything failed. */
export function renderDispatchResult(result: DispatchResult): string {
  const lines: string[] = [];
  lines.push(
    `dispatch: ${result.started.length} 已启动 / ${result.queued.length} 排队 / ` +
    `${result.unobserved.length} 启动未确认 / ${result.failed.length} 失败`,
  );
  for (const entry of result.started) lines.push(`  + ${entry.key}（kind ${entry.kind}）runId ${entry.runId}`);
  for (const entry of result.queued) {
    lines.push(
      `  … ${entry.key}（kind ${entry.kind}）排队：${QUEUED_REASON_TEXT[entry.reason]}`,
    );
  }
  for (const entry of result.unobserved) {
    lines.push(`  ? ${entry.key}（kind ${entry.kind}）启动未确认：${entry.detail}`);
  }
  for (const entry of result.failed) lines.push(`  x ${entry.key}（kind ${entry.kind}）失败：${entry.reason}`);
  if (result.unobserved.length > 0) {
    lines.push(
      "启动未确认的单元可能已经在跑：本扩展不会重发，它们的容量仍算占用；先用 status 查证，再决定是否重新提交。",
    );
  }
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
   * the second one finds nothing to do. Both read the same classifier, so neither
   * can call a paused or stopped run a success.
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
        if (runId) observeCompletion(host, runId, settleOutcomeOf(record));
      });
      if (typeof off === "function") state.listeners.push(off);
      const settled = host.on?.("message_end", (event: any) => {
        for (const completion of decodeNativeCompletions(event?.message)) {
          // `decodeNativeCompletions` deliberately also reports `paused`/`stopped`,
          // because they are ends; whether one of them is *success* is this
          // classifier's question, and the answer for both is no.
          observeCompletion(host, completion.runId, settleOutcomeOf({ status: completion.status }));
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
