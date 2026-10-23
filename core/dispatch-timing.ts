/**
 * Did this session's dispatches actually overlap?
 *
 * Serial dispatch of independent work is the defect this measurement exists for:
 * two children that could have run together, launched one after the other, cost
 * the full wall-clock time of both and leave no trace anywhere. The old answer
 * was to inject a reminder into the conversation — a custom message reaches the
 * model as a *user turn* and rewrites the work it was describing — so the answer
 * is now a fact the parent can read: how many dispatches overlapped, how many did
 * not, and how many cannot be judged.
 *
 * The classification is deliberately conservative:
 *
 *   - **parallel** needs evidence: two known start times whose intervals cross.
 *   - **serial** needs a start *and* an end, and no crossing interval. A dispatch
 *     that is still running, or whose settle time was never observed, is not
 *     evidence of serial work.
 *   - everything else is `unresolved`. "I could not tell" is reported as such and
 *     is never folded into either count, because a missing interval counted as
 *     serial would make the number itself a lie.
 *
 * A still-running dispatch is not silently dropped either: its interval ends at
 * `now`, which is enough to prove overlap with a sibling that is running at the
 * same time, and not enough to prove anything else.
 */

/** One dispatch, as observed in this session. Missing fields stay missing. */
export interface DispatchInterval {
  /** Opaque identity; the dispatch's own call id, used only for reporting. */
  id: string;
  /** Epoch milliseconds when the dispatch was requested. Absent means unobserved. */
  startedAt?: number;
  /** Epoch milliseconds when the run was observed to finish. Absent means open or unknown. */
  settledAt?: number;
}

export interface OverlapSummary {
  /** Dispatches whose interval provably crosses a sibling's. */
  parallel: number;
  /** Dispatches with a complete interval that crossed nothing. */
  serial: number;
  /** Still running, or missing a timestamp: never counted as either. */
  unresolved: number;
  total: number;
}

function usable(start: number | undefined, end: number, settled: boolean): boolean {
  if (typeof start !== "number" || !Number.isFinite(start)) return false;
  if (!Number.isFinite(end)) return false;
  // A clock that went backwards yields no interval at all rather than a negative one.
  return settled ? end >= start : end >= start;
}

/** Whether two half-open intervals cross. */
function crosses(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Classify one session's dispatch intervals.
 *
 * `now` is explicit so the classification is a pure function of its inputs: a
 * test (and a rendered status line) can measure the same set at the same instant.
 */
export function summarizeOverlap(intervals: readonly DispatchInterval[], now: number = Date.now()): OverlapSummary {
  const spans: { start: number; end: number; settled: boolean }[] = [];
  let unresolved = 0;
  for (const interval of intervals) {
    const settled = typeof interval.settledAt === "number" && Number.isFinite(interval.settledAt);
    const end = settled ? (interval.settledAt as number) : now;
    if (!usable(interval.startedAt, end, settled)) {
      unresolved += 1;
      continue;
    }
    spans.push({ start: interval.startedAt as number, end, settled });
  }
  let parallel = 0;
  let serial = 0;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const overlapped = spans.some((other, otherIndex) => otherIndex !== index && crosses(span, other));
    if (overlapped) parallel += 1;
    else if (span.settled) serial += 1;
    else unresolved += 1;
  }
  return { parallel, serial, unresolved, total: intervals.length };
}

/**
 * The one line `/Coworkflow:status` renders.
 *
 * A session with nothing measured says so instead of showing `0 次并行`, which
 * would read as "no parallelism happened" rather than "nothing was observed".
 */
export function formatOverlapLine(summary: OverlapSummary): string {
  if (summary.total === 0) return "派单重叠: 本次会话还没有派单记录";
  const parts = [`${summary.parallel} 次并行`, `${summary.serial} 次串行`];
  if (summary.unresolved > 0) parts.push(`${summary.unresolved} 次仍在运行或时间未知（不计入串行）`);
  return `派单重叠: ${parts.join("、")}（本次会话）`;
}

/**
 * What a session did, as opposed to what it meant to do.
 *
 * The measurement above answers "did dispatches overlap". This answers the question that comes
 * before it: **did anything get dispatched at all.** A session can run hundreds of tool calls and
 * delegate none of them, and until now nothing in this package could say so — the only mechanism
 * that ever noticed was a message injected into the conversation, removed because a custom message
 * reaches the model as a user turn and rewrites the work it describes.
 *
 * So this is a fact, read where facts are read: `/Coworkflow:status`, and whatever renders it later.
 * It is deliberately not a warning, not a threshold, and not advice.
 */
export interface DispatchFacts {
  /** Tool calls this session made, of any kind. */
  toolCalls: number;
  /** `subagent` calls this session made. The unit that matters for delegation. */
  dispatches: number;
  /** Children those calls started, when the call named them (a fanout's tasks, a workflow's steps). */
  children: number;
  /** Calls that started nothing: refused by a gate, or the launch failed. */
  notStarted: number;
  /** Epoch ms of the most recent dispatch, or absent when there has been none. */
  lastDispatchAt?: number;
  /** The dispatch tool, as the host reports it. `null` means the host cannot say. */
  toolAvailable: boolean | null;
}

/** Age of the last dispatch in whole minutes, or absent when there has not been one. */
function ageMinutes(facts: DispatchFacts, now: number): number | undefined {
  if (facts.lastDispatchAt === undefined) return undefined;
  const minutes = Math.floor((now - facts.lastDispatchAt) / 60_000);
  // A clock that moved backwards is not evidence of a dispatch in the future.
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
}

/**
 * The one line `/Coworkflow:status` renders for these facts.
 *
 * Three states have to stay distinguishable, because collapsing them is how this package has
 * published wrong answers before: *the host said the tool is there*, *the host said it is not*, and
 * *the host could not say*. `subagent` is `model-only` exposure, so a probe that leans on
 * `ALL_TOOLS` or `tool_search` always answers "absent" — which is not an answer at all.
 */
export function formatDispatchFacts(facts: DispatchFacts, now: number = Date.now()): string {
  const availability =
    facts.toolAvailable === true
      ? "派单工具可用（读自 getActiveTools）"
      : facts.toolAvailable === false
        ? "派单工具不在本会话的工具列表里（读自 getActiveTools）"
        : "无法确定派单工具是否可用（宿主没有报告工具列表；本包不从 ALL_TOOLS / tool_search 推断）";
  const since = ageMinutes(facts, now);
  const parts = [`本会话工具调用 ${facts.toolCalls} 次`];
  if (facts.dispatches === 0) {
    parts.push("派单 0 次（全部由主会话自己做完）");
  } else {
    parts.push(`派单 ${facts.dispatches} 次`);
    if (facts.children > 0) parts.push(`共启动 ${facts.children} 个子 agent`);
  }
  if (facts.notStarted > 0) parts.push(`${facts.notStarted} 次没有启动（被拒或失败）`);
  if (facts.dispatches > 0 && since !== undefined) parts.push(`最近一次在 ${since} 分钟前`);
  return `${parts.join("、")}；${availability}`;
}
