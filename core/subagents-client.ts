/**
 * The public pi-subagents RPC surface, as this package uses it.
 *
 * pi-subagents publishes an in-process event-bus RPC: requests go out on one
 * channel, replies come back on a channel named after the request id. That is its
 * documented extension contract, and it is what this package must use instead of
 * reading run directories: a private `status.json` shape is pi-subagents' state,
 * not its API, and every mirror of it is a bug waiting for the next release.
 *
 * Three rules shape this file, and they are the reason it owns the whole decoding
 * path rather than returning raw payloads to callers:
 *
 *   - **Correlated and bounded.** Every request carries a fresh UUID, its own
 *     reply listener, and a deadline. The listener is removed when the reply
 *     arrives, when the deadline fires, and when the session ends. A reply for a
 *     different request id is ignored rather than mistaken for ours.
 *   - **Never a guessed retry.** A spawn whose reply timed out is *ambiguous*:
 *     the run may exist. pi-subagents documents the alias
 *     `rpc-spawn-<requestId>` for exactly that case, so the failure surfaces the
 *     alias for a `status` lookup. Nothing here ever re-sends a spawn.
 *   - **Unknown is not zero.** A missing capability, a failed reply, or an
 *     unsupported method produces `kind: "unknown"` with a reason. Callers that
 *     render usage or enforce a concurrency limit must show the gap instead of a
 *     plausible `0`.
 *
 * The client is session-scoped by construction: it is created per host and
 * disposed on `session_shutdown`, because the RPC bridge behind it belongs to the
 * extension runtime that served that session. There is deliberately no
 * process-global cached client.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionEvents, Unsubscribe } from "./module.ts";

export const RPC_PROTOCOL_VERSION = 1;
export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
/** What pi-subagents records as the run alias of an RPC spawn (documented recovery path). */
export const RPC_SPAWN_ALIAS_PREFIX = "rpc-spawn-";
/** Identifies this extension to the owner; it is advisory metadata, not authority. */
export const RPC_SOURCE = "pi-Coworkflow";

const REQUEST_TIMEOUT_MS = 10_000;
const SPAWN_TIMEOUT_MS = 20_000;
/** Async states that still occupy one of the runner's slots. */
const ACTIVE_STATES = new Set(["queued", "running"]);

export type FailureReason = "unavailable" | "closed" | "timeout" | "refused" | "protocol";

export type Result<T> =
  | { ok: true; data: T; requestId?: string }
  | {
      ok: false;
      reason: FailureReason;
      /** Model- and user-facing: what failed and what to do about it. */
      message: string;
      /** pi-subagents' own error code when it refused the request. */
      code?: string;
      /**
       * Set on an unconfirmed emitted spawn: the request may have executed. Recovery goes
       * through `alias`, never through resending this request.
       */
      ambiguous?: { alias: string };
    };

// ── Decoding: the single owner of the RPC payload shape ───────────────

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface RpcReply {
  requestId: string;
  success: boolean;
  data: unknown;
  error?: { code?: string; message?: string };
}

/**
 * One reply envelope, or `null` when the payload is not a reply to *this*
 * request. Anything unreadable is dropped: a malformed reply must not be turned
 * into an empty success.
 */
export function decodeRpcReply(raw: unknown, requestId: string): RpcReply | null {
  const envelope = record(raw);
  if (envelope === null) return null;
  if (envelope.version !== RPC_PROTOCOL_VERSION) return null;
  if (envelope.requestId !== requestId) return null;
  if (typeof envelope.success !== "boolean") return null;
  if (envelope.success === false) {
    const error = record(envelope.error);
    if (!text(error?.code) || !text(error?.message)) return null;
    return {
      requestId,
      success: false,
      data: undefined,
      error: {
        ...(text(error?.code) ? { code: text(error?.code) } : {}),
        ...(text(error?.message) ? { message: text(error?.message) } : {}),
      },
    };
  }
  return { requestId, success: true, data: envelope.data };
}

export interface SubagentsPing {
  version: number;
  methods: string[];
  /**
   * Advertised capabilities, kept as a plain map so an unknown key is ignored
   * rather than mistaken for absence. Read them through `hasCapability`.
   */
  capabilities: Record<string, unknown>;
  events: Record<string, unknown>;
  session: Record<string, unknown>;
}

export function decodePing(data: unknown): SubagentsPing | null {
  const payload = record(data);
  if (payload?.version !== RPC_PROTOCOL_VERSION || !Array.isArray(payload.methods) ||
      !payload.methods.every((entry) => typeof entry === "string" && entry.length > 0) ||
      !record(payload.capabilities) || !record(payload.events) || !record(payload.session)) return null;
  return {
    version: RPC_PROTOCOL_VERSION,
    methods: payload.methods as string[],
    capabilities: record(payload.capabilities)!,
    events: record(payload.events)!,
    session: record(payload.session)!,
  };
}

/** Boolean seams require true; versioned DTO seams require the supported version. */
export function hasCapability(ping: SubagentsPing | null, name: string): boolean {
  if (ping?.version !== RPC_PROTOCOL_VERSION) return false;
  const value = ping.capabilities[name];
  if (["cost", "fleetStatus", "statusProjection", "runtimeAcknowledgedExtensions", "launchResolvedExtensions"].includes(name)) {
    return record(value)?.version === 1;
  }
  if (name === "asyncStatusSnapshot") {
    return record(value)?.version === 1 && record(value)?.kind === "pi-subagents.async-status-snapshot";
  }
  return value === true;
}

export interface NativeRun {
  id: string;
  state: string;
  label?: string;
  agent?: string;
  model?: string;
  startedAt?: number;
}

/**
 * What the native runner reports as currently active for this session.
 *
 * `unknown` is a first-class result: it means the public surface could not say,
 * which is different from "nothing is running" and must be shown that way.
 */
export type NativeActivity =
  | { kind: "known"; active: number; runs: NativeRun[]; omitted: number }
  | { kind: "unknown"; reason: string };

/**
 * The bounded `asyncSnapshot` projection of a successful `status` reply: per-run
 * ids and states. The fleet topLevelAsyncCapacity counter owns admission; a complete
 * snapshot is the compatibility fallback. Fleet entries are
 * deliberately not used — their keys are opaque display keys, not run ids.
 */
export function decodeAsyncSnapshot(data: unknown): { runs: NativeRun[]; omitted: number; truncated: boolean } | null {
  const snapshot = record(record(data)?.asyncSnapshot);
  const caps = record(snapshot?.caps);
  const omitted = record(snapshot?.omitted);
  if (snapshot?.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1 ||
      count(snapshot.generatedAt) === undefined || !caps ||
      !["maxRuns", "maxChildrenPerNode", "maxDepth", "maxStringLength", "maxSerializedBytes"].every((key) => count(caps[key]) !== undefined) ||
      !omitted || count(omitted.runs) === undefined || count(omitted.children) === undefined ||
      typeof omitted.byteLimitExceeded !== "boolean" || !Array.isArray(snapshot.runs)) return null;
  const runs: NativeRun[] = [];
  const states = new Set(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);
  const ids = new Set<string>();
  for (const entry of snapshot.runs) {
    const run = record(entry);
    const id = text(run?.id);
    const state = text(run?.state);
    if (!run || !id || !state || !states.has(state) || ids.has(id) ||
        !["subagent", "workflow"].includes(String(run.kind)) || typeof run.label !== "string" ||
        (run.startedAt !== undefined && count(run.startedAt) === undefined)) return null;
    ids.add(id);
    runs.push({ id, state, label: run.label,
      ...(text(run.agent) ? { agent: text(run.agent) } : {}),
      ...(text(run.model) ? { model: text(run.model) } : {}),
      ...(typeof run.startedAt === "number" ? { startedAt: run.startedAt } : {}),
    });
  }
  if (runs.length > (caps.maxRuns as number)) return null;
  return { runs, omitted: omitted.runs as number,
    truncated: omitted.runs !== 0 || omitted.children !== 0 || omitted.byteLimitExceeded };
}

export interface FleetTokens {
  input: number;
  output: number;
  total: number;
}

/**
 * One row of the public fleet window, exactly as the DTO documents it.
 *
 * `key` is an **opaque display key**: the DTO deliberately never exposes a run,
 * async or tool id, so this row can enrich a display and can never be attributed
 * to a run. Nothing in this package joins `key` to a run id — that join does not
 * exist upstream, and inventing one would silently attribute one run's work to
 * another.
 */
export interface FleetEntry {
  key: string;
  agent: string;
  role?: string;
  model?: string;
  effort?: string;
  /** The caller-facing goal the owner recorded, when it recorded one. */
  goal?: string;
  startedAt: number;
  /** The row's `{ input, output, total }`, absent when the row carried no usage. */
  tokens?: FleetTokens;
}

export interface FleetWindowKnown {
  entries: FleetEntry[];
  /** Active children before the bounded entry window. */
  totalActive: number;
  /** Active children the window does not describe. */
  omitted: number;
  /** Sum over this window's rows, or `null` when no row carried usage. */
  tokens: FleetTokens | null;
  /**
   * Why the window's totals are a lower bound; empty means they are complete.
   *
   * A bounded window that reports `omitted > 0`, a row without usage, or a reply
   * the owner cut at its byte limit can all leave the sum short of the real total,
   * and the only honest way to show a short sum is to say it is short.
   */
  gaps: string[];
}

/** The fleet window, or the reason it cannot be read. Never a zero standing in for a gap. */
export type FleetWindow = ({ kind: "known" } & FleetWindowKnown) | { kind: "unknown"; reason: string };

function decodeFleetTokens(raw: unknown): FleetTokens | undefined {
  const tokens = record(raw);
  if (tokens === null) return undefined;
  const input = count(tokens.input);
  const output = count(tokens.output);
  const total = count(tokens.total);
  if (input === undefined || output === undefined || total === undefined) return undefined;
  return { input, output, total };
}

/** The snapshot projection's own truncation marker, which also bounds this reply. */
function byteLimitExceeded(data: unknown): boolean {
  return record(record(record(data)?.asyncSnapshot)?.omitted)?.byteLimitExceeded === true;
}

/**
 * The public fleet window: per-row display facts plus the gaps that make its sum a
 * lower bound.
 *
 * Strictness is the same as every other decoder here: a row that is not fully
 * readable (missing key/agent/startedAt, or a metadata field that is not text) is a
 * protocol failure for the whole payload, not a half-trusted row. Unknown extra
 * fields are ignored, so a newer owner adding one does not break this. `tokens` is
 * the one optional field: it is display-only, so its absence degrades the sum
 * (recorded in `gaps`) instead of discarding rows a caller may need for counting.
 */
export function decodeFleetWindow(data: unknown): FleetWindowKnown | null {
  const fleet = record(record(data)?.fleet);
  if (fleet?.version !== 1 || !Array.isArray(fleet.entries) || count(fleet.totalActive) === undefined ||
      count(fleet.omitted) === undefined) return null;
  const entries: FleetEntry[] = [];
  let input = 0;
  let output = 0;
  let total = 0;
  let withUsage = 0;
  for (const entry of fleet.entries) {
    const row = record(entry);
    if (row === null) return null;
    const key = text(row.key);
    const agent = text(row.agent);
    const startedAt = count(row.startedAt);
    if (key === undefined || agent === undefined || startedAt === undefined) return null;
    if (["role", "model", "effort", "goal"].some((field) => row[field] !== undefined && text(row[field]) === undefined)) return null;
    const tokens = row.tokens === undefined ? undefined : decodeFleetTokens(row.tokens);
    if (row.tokens !== undefined && tokens === undefined) return null;
    if (tokens !== undefined) {
      input += tokens.input;
      output += tokens.output;
      total += tokens.total;
      withUsage += 1;
    }
    entries.push({ key, agent, startedAt,
      ...(text(row.role) ? { role: text(row.role) } : {}),
      ...(text(row.model) ? { model: text(row.model) } : {}),
      ...(text(row.effort) ? { effort: text(row.effort) } : {}),
      ...(text(row.goal) ? { goal: text(row.goal) } : {}),
      ...(tokens ? { tokens } : {}),
    });
  }
  const totalActive = fleet.totalActive as number;
  const omitted = fleet.omitted as number;
  const gaps: string[] = [];
  if (omitted > 0) gaps.push(`窗口外还有 ${omitted} 个活跃 run`);
  if (withUsage < entries.length) gaps.push(`窗口内有 ${entries.length - withUsage} 行没有携带用量`);
  if (byteLimitExceeded(data)) gaps.push("这次 status 回复已超出字节上限");
  if (entries.length + omitted !== totalActive) gaps.push("窗口行数与活跃计数不一致");
  return {
    entries,
    totalActive,
    omitted,
    // Zero rows is a real zero only because `totalActive` agrees; otherwise the
    // gap above says the window cannot describe what is running.
    tokens: entries.length === 0 ? { input: 0, output: 0, total: 0 } : withUsage === 0 ? null : { input, output, total },
    gaps,
  };
}

export interface FleetAgentCounts {
  /** Live entries per resolved agent name, from the fleet's bounded public window. */
  counts: Map<string, number>;
  totalActive: number;
  /** Active runs the window does not describe: overflow, or rows it could not render. */
  omitted: number;
}

/**
 * Per-agent counts from the public fleet projection.
 *
 * The fleet DTO exposes `entries[].agent` (a resolved agent name) and never a run
 * or async id, which is exactly what a per-kind limit needs and nothing more: how
 * many `cw-executor` are active right now, from the owner's own state rather than
 * from a mirror of it. `null` means the payload is not a readable fleet DTO — the
 * caller must treat that as unknown, never as "nothing is running".
 */
export function decodeFleetAgentCounts(data: unknown): FleetAgentCounts | null {
  const window = decodeFleetWindow(data);
  if (window === null) return null;
  const counts = new Map<string, number>();
  for (const entry of window.entries) counts.set(entry.agent, (counts.get(entry.agent) ?? 0) + 1);
  return { counts, totalActive: window.totalActive, omitted: window.omitted };
}

/**
 * How long a run has been going, from the public `startedAt` and a caller-supplied
 * clock reading.
 *
 * No timer and no polling: the caller passes `now`, so a rendering path stays
 * cache-only and a test can pin the clock. `undefined` means the start time is not
 * known (or is in the future, which is a clock we cannot use) — never `0s`.
 */
export function elapsedLabel(startedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined) return undefined;
  const ms = now - startedAt;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `已运行 ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `已运行 ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `已运行 ${hours}h` : `已运行 ${hours}h ${minutes % 60}m`;
}

/** How many run lines a panel summary prints before it stops. */
const MAX_SUMMARY_RUNS = 8;

function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * The bounded per-run summary a panel shows, from both public projections.
 *
 * Each projection does the job it can actually do: the snapshot names runs (id,
 * agent, state, `startedAt`), so a line is attributable to a run; the fleet window
 * carries usage, but only inside a bounded window that reports its own gaps. No
 * fleet key is ever paired with a run id here.
 *
 * Elapsed time comes from `startedAt` at render time, so rendering stays
 * cache-only, and a token sum that does not cover every active run is labelled a
 * lower bound instead of being printed as the total.
 *
 * `actions` is a run-id-keyed cache of what each child was last seen doing, read
 * from the tail of its own session log at a refresh boundary. It is deliberately a
 * lookup, not a read: rendering never touches the filesystem, and a run without an
 * entry says nothing rather than printing an empty action. The suffix names the
 * source, because a tail read is not a live event stream.
 */
export function formatRunSummary(
  activity: NativeActivity,
  fleet: FleetWindow,
  now: number,
  actions: Map<string, string> = new Map(),
): string[] {
  const lines: string[] = [];
  if (activity.kind === "unknown") {
    lines.push(`子 run 明细: 未知（${activity.reason}）`);
  } else if (activity.runs.length === 0) {
    lines.push("子 run 明细: 公开状态里没有正在运行的子 run");
  } else {
    lines.push(`子 run 明细: ${activity.runs.length} 个${activity.omitted > 0 ? `（另有 ${activity.omitted} 个不在公开窗口内）` : ""}`);
    const shown = activity.runs.slice(0, MAX_SUMMARY_RUNS);
    for (const run of shown) {
      const action = actions.get(run.id);
      lines.push(`  · ${run.agent ?? "未知"} [${run.state}] · ${elapsedLabel(run.startedAt, now) ?? "已运行 未知"}${
        run.model ? ` · ${run.model}` : ""} · run ${run.id.slice(0, 8)}${
        action === undefined ? "" : ` · 正在 ${action}（读自子会话日志尾部）`}`);
    }
    if (activity.runs.length > shown.length) lines.push(`  …… 其余 ${activity.runs.length - shown.length} 个未列出`);
  }
  if (fleet.kind === "unknown") {
    lines.push(`子 run tokens: 未知（${fleet.reason}）`);
  } else if (fleet.tokens === null) {
    lines.push("子 run tokens: 未知（fleet 窗口里的行没有携带用量）");
  } else {
    const sum = `in ${compactCount(fleet.tokens.input)} / out ${compactCount(fleet.tokens.output)}`;
    lines.push(fleet.gaps.length === 0
      ? `子 run tokens: ${sum}（fleet 窗口完整）`
      : `子 run tokens: 不完整 —— ${fleet.gaps.join("；")}；窗口内求和只是下界（${sum}）`);
  }
  return lines;
}

/** Per-agent live counts, or the reason they cannot be counted. */
export type NativeAgentCounts =
  | { kind: "known"; counts: Map<string, number>; totalActive: number }
  | { kind: "unknown"; reason: string };

/** The fleet counter counts top-level async owners, not the fleet's displayed children. */
export function decodeTopLevelCapacity(data: unknown): number | null {
  const fleet = record(record(data)?.fleet);
  const capacity = record(fleet?.topLevelAsyncCapacity);
  if (fleet?.version !== 1 || !Array.isArray(fleet.entries) || count(fleet.totalActive) === undefined ||
      count(fleet.omitted) === undefined || count(capacity?.used) === undefined || count(capacity?.limit) === undefined) return null;
  return capacity!.used as number;
}

export interface NativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface NativeCostChild {
  label?: string;
  agent?: string;
  runId?: string;
  /** Present when pi-subagents could attribute a session file; the only safe way to read child history. */
  sessionFile?: string;
  usage: NativeUsage;
}

/**
 * Native cost, or the reason it is unavailable. `unresolvedAsyncChildren > 0`
 * makes `childTotal` a lower bound — that uncertainty travels with the value so a
 * chart can mark it instead of hiding it.
 */
export type NativeCost =
  | {
      kind: "known";
      parent: NativeUsage;
      childTotal: NativeUsage;
      total: NativeUsage;
      children: NativeCostChild[];
      unresolvedAsyncChildren: number;
      /** True when at least one async child could not be read: totals are a lower bound. */
      incomplete: boolean;
    }
  | { kind: "unknown"; reason: string };

function decodeUsage(raw: unknown): NativeUsage | null {
  const usage = record(raw);
  if (usage === null) return null;
  const fields = ["input", "output", "cacheRead", "cacheWrite", "turns"] as const;
  if (fields.some((key) => count(usage[key]) === undefined) ||
      typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return null;
  return { input: usage.input as number, output: usage.output as number,
    cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number,
    cost: usage.cost, turns: usage.turns as number };
}

export function decodeCost(data: unknown): NativeCost | null {
  const payload = record(data);
  if (payload?.version !== 1 || !Array.isArray(payload.children) || count(payload.unresolvedAsyncChildren) === undefined) return null;
  const parent = decodeUsage(payload.parent);
  const childTotal = decodeUsage(payload.childTotal);
  const total = decodeUsage(payload.total);
  if (parent === null || childTotal === null || total === null) return null;
  const children: NativeCostChild[] = [];
  for (const entry of payload.children) {
    const child = record(entry);
    const usage = decodeUsage(child?.usage);
    if (child === null || usage === null || !text(child.label) || !text(child.agent) ||
        ["runId", "sessionFile"].some((key) => child[key] !== undefined && !text(child[key]))) return null;
    children.push({
      usage,
      ...(text(child.label) ? { label: text(child.label) } : {}),
      ...(text(child.agent) ? { agent: text(child.agent) } : {}),
      ...(text(child.runId) ? { runId: text(child.runId) } : {}),
      ...(text(child.sessionFile) ? { sessionFile: text(child.sessionFile) } : {}),
    });
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
    const sum = children.reduce((value, child) => value + child.usage[key], 0);
    const equal = (a: number, b: number): boolean => key === "cost"
      ? Math.abs(a - b) <= Number.EPSILON * 16 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b;
    if (!equal(sum, childTotal[key]) || !equal(parent[key] + childTotal[key], total[key])) return null;
  }
  const unresolved = payload.unresolvedAsyncChildren as number;
  return {
    kind: "known",
    parent,
    childTotal,
    total,
    children,
    unresolvedAsyncChildren: unresolved,
    incomplete: unresolved > 0,
  };
}

/**
 * What pi-subagents acknowledges when a stop request is accepted.
 *
 * `accepted` is deliberately not `stopped`: the owner documents a successful
 * `stop` reply as an acceptance receipt for the exact run (`state: "stopping"`),
 * not as its retirement. Termination has to be established by a later `status`
 * read plus process-terminal evidence, so the type must not let a caller render
 * this as "the run died".
 */
export interface StopReceipt {
  /** The request was accepted. This is *not* proof the run terminated. */
  accepted: true;
  /** The owner's own acknowledgement state (documented as `stopping`). */
  state: string;
  /** The run the acknowledgement is for, when the owner names it. */
  runId: string | null;
  /** The state the run was in when the stop was accepted (`running`/`queued`/`paused`). */
  previousState?: string;
  /** Set for a child-scoped stop. */
  childId?: string;
  asyncDir?: string;
  /** The owner's own sentence, passed through unchanged. */
  text: string;
}

/**
 * One `stop` reply, or `null` when it is not an acceptance receipt.
 *
 * A reply without a `state` is unreadable and therefore a protocol error: turning
 * it into "success" would claim an acceptance nobody made.
 */
export function decodeStopReceipt(data: unknown): StopReceipt | null {
  const payload = record(data);
  const state = text(payload?.state);
  if (payload === null || state === undefined) return null;
  return {
    accepted: true,
    state,
    runId: text(payload.runId) ?? null,
    ...(text(payload.previousState) ? { previousState: text(payload.previousState)! } : {}),
    ...(text(payload.childId) ? { childId: text(payload.childId)! } : {}),
    ...(text(payload.asyncDir) ? { asyncDir: text(payload.asyncDir)! } : {}),
    text: text(payload.message) ?? "",
  };
}

/**
 * What pi-subagents acknowledges when instructions were delivered to a run.
 *
 * `deliveryStatus: "queued"` is a normal, successful acknowledgement: the
 * instructions are on their way, not necessarily applied yet.
 */
export interface SteerReceipt {
  accepted: true;
  /** `delivered` or `queued`, from the owner's own steering receipt. */
  deliveryStatus?: string;
  /** The steering request id, for correlating an owner-side event. */
  requestId?: string;
  state?: string;
  /** The owner's own sentence, passed through unchanged. */
  text: string;
}

/**
 * One `steer` reply, or `null` when it carries neither a steering receipt nor a
 * sentence. An empty object is not an acknowledgement.
 */
export function decodeSteerReceipt(data: unknown): SteerReceipt | null {
  const payload = record(data);
  if (payload === null) return null;
  // The owner answers through the ordinary `steer` action, so the receipt is the
  // tool result: a sentence plus optional `details.steering`. Neither alone is
  // required, but an empty object is not an acknowledgement.
  const steering = record(record(payload.details)?.steering);
  const line = text(payload.text) ?? "";
  if (steering === null && !line) return null;
  return {
    accepted: true,
    text: line,
    ...(text(steering?.deliveryStatus) ? { deliveryStatus: text(steering?.deliveryStatus)! } : {}),
    ...(text(steering?.requestId) ? { requestId: text(steering?.requestId)! } : {}),
    ...(text(steering?.state) ? { state: text(steering?.state)! } : {}),
  };
}

/**
 * What pi-subagents acknowledges when an interrupt was requested.
 *
 * An interrupt asks the running child to stop at its next step; like `stop`, the
 * acknowledgement is not a terminal state.
 */
export interface InterruptReceipt {
  accepted: true;
  /** The owner's own sentence, passed through unchanged. */
  text: string;
}

export function decodeInterruptReceipt(data: unknown): InterruptReceipt | null {
  const payload = record(data);
  const textValue = text(payload?.text);
  if (payload === null || textValue === undefined) return null;
  return { accepted: true, text: textValue };
}

export interface SpawnReceipt {
  /** The async run id, and the recovery target for `status`/`stop`. */
  runId: string | null;
  asyncDir: string | null;
  /** Authoritative when present: the mission the launch was recorded in. */
  missionId: string | null;
  text: string;
}

export function decodeSpawnReceipt(data: unknown): SpawnReceipt {
  const payload = record(data);
  const details = record(payload?.details);
  const runId = text(details?.runId) ?? text(details?.asyncId) ?? null;
  return {
    runId,
    asyncDir: text(details?.asyncDir) ?? null,
    missionId: text(details?.missionId) ?? null,
    text: text(payload?.text) ?? "",
  };
}

// ── Project admission, shared by the direct tool and this package's own launch ──

export interface AdmissionRequest {
  /** The project's own ceiling, or `null` when the project sets none. */
  limit: number | null;
  activity: NativeActivity;
  /** Launches this process admitted whose run is not visible natively yet. */
  pending: number;
}

export type Admission = { admit: true; total: number | null } | { admit: false; reason: string; total?: number };

/**
 * Whether one more launch fits under the project's ceiling.
 *
 * The project limit is a compatibility policy: pi-subagents has no documented
 * project-level override for its own capacity key, so the project enforces its
 * own. It is counted from *native* activity, and a limit that cannot be counted
 * is refused rather than silently ignored — a limit that never blocks anything
 * looks enforced, which is worse than no limit at all.
 */
export function decideAdmission(request: AdmissionRequest): Admission {
  if (request.limit === null) {
    return { admit: true, total: request.activity.kind === "known" ? request.activity.active + request.pending : null };
  }
  if (request.activity.kind === "unknown") {
    return {
      admit: false,
      reason: [
        `本项目设了子 agent 并发上限 ${request.limit}，但 pi-subagents 的公开状态接口现在说不出活跃 run 数（${request.activity.reason}）。`,
        "为避免把上限变成一句空话，这次派单被拦下。请在 `/Coworkflow:settings` 里清空「本项目并发上限」（留空 = 不限），或检查 pi-subagents 是否提供 status 能力。",
      ].join(""),
    };
  }
  const total = request.activity.active + request.pending;
  if (total < request.limit) return { admit: true, total };
  const running = request.activity.runs
    .map((run) => `${run.agent ?? "?"}(${run.id.slice(0, 8)}, ${run.state})`)
    .join("、");
  return {
    admit: false,
    total,
    reason: [
      `本项目（Coworkflow）的子 agent 并发上限是 ${request.limit}，当前已有 ${total} 个活跃 async run${request.pending > 0 ? `（其中 ${request.pending} 个是本轮刚派出的）` : ""}${running ? `：${running}` : ""}。`,
      "这次派单被拦下，没有启动任何子进程。请先让其中一个结束（`bg_wait` 等待，或用 `subagent({ action: \"status\" })` 查看进度），再重新派发；",
      "也可以让用户在 `/Coworkflow:settings` 里把「子 agent 并发上限」调高（留空 = 不限）。",
    ].join(""),
  };
}

// ── The client ────────────────────────────────────────────────────────

export interface SubagentsClientOptions {
  events: ExtensionEvents | undefined;
  requestTimeoutMs?: number;
  spawnTimeoutMs?: number;
}

export class SubagentsClient {
  private readonly events: ExtensionEvents | undefined;
  private readonly requestTimeoutMs: number;
  private readonly spawnTimeoutMs: number;
  /** Settlers of in-flight requests, so `dispose()` can reject them all at once. */
  private readonly inflight = new Set<(result: Result<never>) => void>();
  private closed = false;
  private pingResult: SubagentsPing | null = null;

  constructor(options: SubagentsClientOptions) {
    this.events = options.events;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS;
  }

  /** Whether this session can talk to pi-subagents at all. */
  get available(): boolean {
    return this.events !== undefined && !this.closed;
  }

  /** Why the client cannot be used, for a report or a refusal message. */
  unavailableReason(): string {
    if (this.closed) return "本会话的 pi-subagents 通道已随会话结束关闭。";
    return "宿主没有提供 `pi.events` 共享事件总线：无法使用 pi-subagents 的公开 RPC（本扩展不读它的私有运行目录，也不另起运行器）。请升级 Pi 或确认工作流在会话内运行。";
  }

  /**
   * Send one request and wait for its own reply.
   *
   * The listener is attached before the emit, so a synchronous responder cannot
   * reply into the void, and it is removed on every exit path.
   */
  private send(
    method: string,
    params: unknown,
    timeoutMs: number,
    beforeEmit?: (requestId: string) => void,
  ): Promise<Result<unknown>> {
    if (!this.available) {
      return Promise.resolve({ ok: false, reason: this.closed ? "closed" : "unavailable", message: this.unavailableReason() });
    }
    const events = this.events as ExtensionEvents;
    const requestId = randomUUID();
    const channel = `${RPC_REPLY_PREFIX}${requestId}`;

    return new Promise<Result<unknown>>((resolve) => {
      let settled = false;
      let unsubscribe: Unsubscribe | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let emitted = false;

      const finish = (result: Result<unknown>): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        try {
          unsubscribe?.();
        } catch {
          // A listener that cannot be removed must not turn into a thrown error.
        }
        this.inflight.delete(finish as (result: Result<never>) => void);
        if (!result.ok && method === "spawn" && emitted && result.reason !== "refused") {
          const alias = `${RPC_SPAWN_ALIAS_PREFIX}${requestId}`;
          result = { ...result, ambiguous: { alias },
            message: `${result.message} 请求可能已执行，不要重发；通过 status id: "${alias}" 查证。` };
        }
        resolve(result);
      };

      this.inflight.add(finish as (result: Result<never>) => void);

      try {
        unsubscribe = events.on(channel, (raw) => {
          const reply = decodeRpcReply(raw, requestId);
          if (reply === null) {
            if (record(raw)?.requestId === requestId) finish({ ok: false, reason: "protocol", message: `Malformed RPC ${method} reply; execution is unconfirmed.` });
            return;
          }
          if (reply.success) {
            finish({ ok: true, data: reply.data, requestId });
            return;
          }
          finish({
            ok: false,
            reason: "refused",
            message: reply.error?.message ?? `pi-subagents 拒绝了 RPC ${method}，但没有给出原因。`,
            ...(reply.error?.code ? { code: reply.error.code } : {}),
          });
        });

        if (settled) { unsubscribe?.(); return; }
        timer = setTimeout(() => {
          const alias = method === "spawn" ? `${RPC_SPAWN_ALIAS_PREFIX}${requestId}` : undefined;
          finish({
            ok: false,
            reason: "timeout",
            message:
              method === "spawn"
                ? `pi-subagents 在 ${timeoutSeconds(timeoutMs)} 秒内没有确认 RPC spawn。这次请求可能已经执行，不要重发：用 status id: "${alias}" 查证后再决定。`
                : `pi-subagents 在 ${timeoutSeconds(timeoutMs)} 秒内没有回复 RPC ${method}。`,
            ...(alias ? { ambiguous: { alias } } : {}),
          });
        }, timeoutMs);
        // A pending deadline is bookkeeping, not work: it must not keep the host
        // process alive on its own.
        (timer as { unref?: () => void }).unref?.();

        beforeEmit?.(requestId);
        emitted = true;
        events.emit(RPC_REQUEST_EVENT, {
          version: RPC_PROTOCOL_VERSION,
          requestId,
          method,
          params,
          source: { extension: RPC_SOURCE },
        } satisfies Record<string, unknown>);
      } catch (error) {
        finish({
          ok: false,
          reason: "unavailable",
          message: `发送 RPC ${method} 失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  }

  /** One `ping`, cached per client, so capability checks do not spam the owner. */
  async ping(): Promise<Result<SubagentsPing>> {
    if (!this.available) return { ok: false, reason: this.closed ? "closed" : "unavailable", message: this.unavailableReason() };
    if (this.pingResult !== null) return { ok: true, data: this.pingResult };
    const reply = await this.send("ping", undefined, this.requestTimeoutMs);
    if (this.closed) return { ok: false, reason: "closed", message: this.unavailableReason() };
    if (!reply.ok) return reply;
    const ping = decodePing(reply.data);
    if (ping === null) {
      return {
        ok: false,
        reason: "protocol",
        message: "pi-subagents 的 ping 回复不带 version/methods/capabilities，无法确认它支持的协议；本扩展不会猜测。",
      };
    }
    this.pingResult = ping;
    return { ok: true, data: ping };
  }

  /**
   * Check the capability floor this package actually relies on.
   *
   * It checks advertised capabilities, not a guessed semver: a renamed method or
   * a missing async spawn seam must be reported as such.
   */
  async requireCapabilities(): Promise<{ ok: true; ping: SubagentsPing } | { ok: false; message: string }> {
    const reply = await this.ping();
    if (!reply.ok) return { ok: false, message: reply.message };
    const ping = reply.data;
    const missing: string[] = [];
    if (ping.version !== RPC_PROTOCOL_VERSION) missing.push(`协议版本 ${ping.version}（本扩展要求 ${RPC_PROTOCOL_VERSION}）`);
    if (!ping.methods.includes("spawn")) missing.push("spawn 方法");
    if (!ping.methods.includes("status")) missing.push("status 方法");
    if (!hasCapability(ping, "status")) missing.push("capabilities.status");
    if (!hasCapability(ping, "asyncSpawn")) missing.push("capabilities.asyncSpawn");
    if (missing.length > 0) {
      return {
        ok: false,
        message: [
          `已安装的 pi-subagents 缺少本扩展需要的公开能力：${missing.join("、")}。`,
          "本扩展不会退回读取它的私有运行目录，也不会装第二份运行器。请升级 pi-subagents（0.79 系列的 extension-api 提供这些能力）。",
        ].join(""),
      };
    }
    return { ok: true, ping };
  }

  async status(params: Record<string, unknown> = {}): Promise<Result<Record<string, unknown>>> {
    const ping = await this.ping();
    if (!ping.ok) return ping;
    if (!ping.data.methods.includes("status") || !hasCapability(ping.data, "status")) {
      return { ok: false, reason: "unavailable", message: "pi-subagents 没有通告 status 能力。" };
    }
    const reply = await this.send("status", params, this.requestTimeoutMs);
    if (this.closed) return { ok: false, reason: "closed", message: this.unavailableReason() };
    if (!reply.ok) return reply;
    const data = record(reply.data);
    if (data === null) {
      return {
        ok: false,
        reason: "protocol",
        message: "pi-subagents 的 status 回复不是对象，无法使用；本扩展不猜测运行状态。",
      };
    }
    return { ok: true, data };
  }

  /**
   * Native cost, with its uncertainty preserved.
   *
   * A missing `cost` capability is a documented "unsupported", not a zero: the
   * consumer must be able to tell "no usage yet" from "this build cannot say".
   */
  async cost(): Promise<NativeCost> {
    const capability = await this.ping();
    if (!capability.ok) return { kind: "unknown", reason: capability.message };
    if (!capability.data.methods.includes("cost") || !hasCapability(capability.data, "cost")) {
      return {
        kind: "unknown",
        reason: "pi-subagents 没有通告 cost 能力（0.79 系列的 ping.capabilities.cost 才提供），因此用量只能按父会话历史估算。",
      };
    }
    const reply = await this.send("cost", undefined, this.requestTimeoutMs);
    if (!reply.ok) return { kind: "unknown", reason: reply.message };
    if (this.closed) return { kind: "unknown", reason: this.unavailableReason() };
    const decoded = decodeCost(reply.data);
    if (decoded === null) {
      return { kind: "unknown", reason: "pi-subagents 的 cost 回复缺少 parent/childTotal/total 用量字段，无法当作已知值使用。" };
    }
    return decoded;
  }

  /**
   * Whether the installed owner advertises one RPC method.
   *
   * A method that is not advertised is never sent. pi-subagents would answer an
   * unknown method with `unsupported_method`, but "we tried and it said no" is a
   * different fact from "this build cannot do it" — and only the second one is
   * honest to report as a missing capability. An explicit `capabilities[method]`
   * of `false` counts as not advertised; an absent entry does not, because the
   * advertised method list is the documented seam.
   */
  private async advertises(
    method: string,
  ): Promise<{ ok: true; ping: SubagentsPing } | { ok: false; message: string }> {
    const reply = await this.ping();
    if (!reply.ok) return { ok: false, message: reply.message };
    const ping = reply.data;
    if (!ping.methods.includes(method) || ping.capabilities[method] === false) {
      return {
        ok: false,
        message: [
          `已安装的 pi-subagents 没有通告 RPC ${method} 方法（它通告的方法是：${ping.methods.join("、")}），`,
          "所以这次不做任何操作：本扩展不会发一个对方可能不认识的请求，也不会退回读取它的私有运行目录。请升级 pi-subagents。",
        ].join(""),
      };
    }
    return { ok: true, ping };
  }

  /**
   * Request that one async run stop — an *accepted request*, never a terminated run.
   *
   * Three things are deliberately different from `spawn`:
   *
   *   - the capability is checked first, so nothing is emitted into a build that
   *     does not have the method;
   *   - a refused or timed-out reply is reported as `refused`/`timeout` with the
   *     owner's own message, with no `ambiguous` alias: a stop that failed does not
   *     mean the run died, and a caller must not read it that way;
   *   - a readable reply is an acceptance receipt. Termination needs a subsequent
   *     `status` read (and process-terminal evidence), which is the caller's job.
   */
  async stop(params: Record<string, unknown>): Promise<Result<StopReceipt>> {
    const advertised = await this.advertises("stop");
    if (!advertised.ok) return { ok: false, reason: "unavailable", message: advertised.message };
    const reply = await this.send("stop", params, this.requestTimeoutMs);
    if (this.closed) return { ok: false, reason: "closed", message: this.unavailableReason() };
    if (!reply.ok) return reply;
    const receipt = decodeStopReceipt(reply.data);
    if (receipt === null) {
      return {
        ok: false,
        reason: "protocol",
        message: "pi-subagents 的 stop 回复不带 state 字段：无法确认这次停止请求是否被接受；本扩展不把它当成成功，也不当成 run 已经结束。",
      };
    }
    return { ok: true, data: receipt };
  }

  /**
   * Deliver instructions to a running async run without killing it.
   *
   * The message travels as data in the RPC params, never as a command line or an
   * evaluated string: this wrapper does no quoting, no interpolation and no
   * script generation.
   */
  async steer(params: Record<string, unknown>): Promise<Result<SteerReceipt>> {
    const advertised = await this.advertises("steer");
    if (!advertised.ok) return { ok: false, reason: "unavailable", message: advertised.message };
    const reply = await this.send("steer", params, this.requestTimeoutMs);
    if (this.closed) return { ok: false, reason: "closed", message: this.unavailableReason() };
    if (!reply.ok) return reply;
    const receipt = decodeSteerReceipt(reply.data);
    if (receipt === null) {
      return {
        ok: false,
        reason: "protocol",
        message: "pi-subagents 的 steer 回复既没有 steering 回执也没有说明文字：无法确认指令是否被接收，本扩展不把它当成已送达。",
      };
    }
    return { ok: true, data: receipt };
  }

  /**
   * Ask a running async run to interrupt at its next step.
   *
   * Like `stop`, an acknowledgement is not a terminal state; unlike `stop`, the
   * owner's own interrupt path only supports non-workflow, non-external async runs
   * and says so in its refusal, which is passed through unchanged.
   */
  async interrupt(params: Record<string, unknown>): Promise<Result<InterruptReceipt>> {
    const advertised = await this.advertises("interrupt");
    if (!advertised.ok) return { ok: false, reason: "unavailable", message: advertised.message };
    const reply = await this.send("interrupt", params, this.requestTimeoutMs);
    if (this.closed) return { ok: false, reason: "closed", message: this.unavailableReason() };
    if (!reply.ok) return reply;
    const receipt = decodeInterruptReceipt(reply.data);
    if (receipt === null) {
      return {
        ok: false,
        reason: "protocol",
        message: "pi-subagents 的 interrupt 回复没有说明文字：无法确认这次中断请求是否被接受，本扩展不把它当成成功。",
      };
    }
    return { ok: true, data: receipt };
  }

  /**
   * How many runs of each agent are live, from the public fleet projection.
   *
   * A per-kind limit needs this and only this. Everything that makes the count
   * unreadable — no `fleetStatus` capability, a failed or malformed reply, a
   * truncated window — is `unknown` with a reason, because a limit that cannot be
   * counted must refuse rather than assume there is room.
   */
  async agentActivity(): Promise<NativeAgentCounts> {
    const capability = await this.ping();
    if (!capability.ok) return { kind: "unknown", reason: capability.message };
    if (!capability.data.methods.includes("status") || !hasCapability(capability.data, "status")) {
      return { kind: "unknown", reason: "pi-subagents 没有通告 status 能力，无法读取每个 agent 当前有几个在运行。" };
    }
    if (!hasCapability(capability.data, "fleetStatus")) {
      return {
        kind: "unknown",
        reason: "pi-subagents 没有通告 fleetStatus 能力，因此没有公开的 per-agent 活跃条目可数（0.79 系列的 ping.capabilities.fleetStatus 才提供）。",
      };
    }
    const reply = await this.status({});
    if (!reply.ok) return { kind: "unknown", reason: reply.message };
    if (this.closed) return { kind: "unknown", reason: this.unavailableReason() };
    const fleet = decodeFleetAgentCounts(reply.data);
    if (fleet === null) {
      return { kind: "unknown", reason: "pi-subagents 的 fleet 投影不是可解析的 entries/totalActive/omitted，无法按 agent 计数。" };
    }
    if (fleet.omitted > 0) {
      return {
        kind: "unknown",
        reason: `pi-subagents 的 fleet 投影是有界窗口，还有 ${fleet.omitted} 个活跃 run 不在其中，无法按 agent 精确计数。`,
      };
    }
    return { kind: "known", counts: fleet.counts, totalActive: fleet.totalActive };
  }

  /**
   * The public fleet window, with its gaps preserved.
   *
   * Same capability floor as `agentActivity`: no `fleetStatus`, a failed reply or
   * an unreadable payload is `unknown` with a reason, because a display that shows
   * `0` for a window it could not read is worse than one that says it cannot see.
   */
  async fleetWindow(): Promise<FleetWindow> {
    const capability = await this.ping();
    if (!capability.ok) return { kind: "unknown", reason: capability.message };
    if (!capability.data.methods.includes("status") || !hasCapability(capability.data, "status")) {
      return { kind: "unknown", reason: "pi-subagents 没有通告 status 能力，无法读取 fleet 窗口。" };
    }
    if (!hasCapability(capability.data, "fleetStatus")) {
      return {
        kind: "unknown",
        reason: "pi-subagents 没有通告 fleetStatus 能力，因此没有公开的 per-run 显示窗口可读（0.79 系列的 ping.capabilities.fleetStatus 才提供）。",
      };
    }
    const reply = await this.status({});
    if (!reply.ok) return { kind: "unknown", reason: reply.message };
    if (this.closed) return { kind: "unknown", reason: this.unavailableReason() };
    const window = decodeFleetWindow(reply.data);
    if (window === null) {
      return { kind: "unknown", reason: "pi-subagents 的 fleet 投影不是可解析的 entries/totalActive/omitted，无法当作已知值使用。" };
    }
    return { kind: "known", ...window };
  }

  /** What the native runner reports as active for this session, or why it cannot say. */
  async observeActivity(): Promise<NativeActivity> {
    const capability = await this.ping();
    if (!capability.ok) return { kind: "unknown", reason: capability.message };
    const reply = await this.status({});
    if (!reply.ok) return { kind: "unknown", reason: reply.message };
    if (this.closed) return { kind: "unknown", reason: this.unavailableReason() };
    const snapshot = hasCapability(capability.data, "asyncStatusSnapshot") ? decodeAsyncSnapshot(reply.data) : null;
    const capacity = hasCapability(capability.data, "fleetStatus") ? decodeTopLevelCapacity(reply.data) : null;
    if (capacity !== null) return { kind: "known", active: capacity, runs: snapshot?.runs ?? [], omitted: snapshot?.omitted ?? 0 };
    if (!snapshot || snapshot.truncated) {
      return { kind: "unknown", reason: "pi-subagents 缺少完整有效的 asyncSnapshot 或顶层容量计数，无法按 run 计数。" };
    }
    return { kind: "known", active: snapshot.runs.filter((run) => ACTIVE_STATES.has(run.state)).length,
      runs: snapshot.runs, omitted: 0 };
  }

  /**
   * Launch one async run through the public RPC.
   *
   * No retry, ever: `spawn` is not idempotent, and a timeout does not prove that
   * nothing started.
   */
  async spawn(params: Record<string, unknown>, beforeEmit?: (alias: string) => void): Promise<Result<SpawnReceipt>> {
    const capability = await this.requireCapabilities();
    if (!capability.ok) return { ok: false, reason: "unavailable", message: capability.message };
    const reply = await this.send("spawn", params, this.spawnTimeoutMs, (id) => beforeEmit?.(`${RPC_SPAWN_ALIAS_PREFIX}${id}`));
    if (!reply.ok) return reply;
    const receipt = decodeSpawnReceipt(reply.data);
    if (receipt.runId === null || this.closed) {
      return {
        ok: false,
        reason: this.closed ? "closed" : "protocol",
        ambiguous: { alias: `${RPC_SPAWN_ALIAS_PREFIX}${reply.requestId}` },
        message: [
          `请通过 status id: "${RPC_SPAWN_ALIAS_PREFIX}${reply.requestId}" 查证。`,
          "pi-subagents 的 spawn 没有可用的运行确认。",
          "这次派单可能已经在跑，本扩展不会重发；请用 `subagent({ action: \"status\" })` 查证后再决定。",
        ].join(""),
      };
    }
    return { ok: true, data: receipt };
  }

  /** Drop every listener this client owns. Idempotent, and safe after a session end. */
  dispose(): void {
    this.closed = true;
    const pending = [...this.inflight];
    this.inflight.clear();
    for (const finish of pending) {
      finish({ ok: false, reason: "closed", message: "会话结束，未完成的 pi-subagents 请求已取消。" });
    }
    this.pingResult = null;
  }
}

function timeoutSeconds(ms: number): string {
  return ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
}

// ── One bridge per runtime, for the whole session ─────────────────────

/** Session observations and conservative launch reservations; no retries or scheduler. */
export interface SubagentsBridge {
  readonly client: SubagentsClient;
  /** The session epoch this bridge was built for. */
  readonly epoch: number;
  /** Fresh read of native activity, cached for `admitSync` afterwards. */
  observe(): Promise<NativeActivity>;
  /** Fresh read of the public fleet window, for a bounded per-run display. */
  fleet(): Promise<FleetWindow>;
  /** Last public observation for synchronous rendering; never synthesizes zero. */
  activity(): NativeActivity;
  /** Last fleet read for synchronous rendering; never synthesizes a complete window. */
  fleetView(): FleetWindow;
  admit(launchId: string, limit: number | null): Promise<Admission>;
  admitSync(launchId: string, limit: number | null): Admission;
  /**
   * Live runs of one agent, from the same serialized public reads admission uses.
   * `unknown` means the count could not be established; a caller enforcing a
   * per-kind limit must refuse then, not assume zero.
   */
  agentCount(agent: string): Promise<{ kind: "known"; count: number } | { kind: "unknown"; reason: string }>;
  /**
   * Record that an admitted launch became this native run, so the reservation is
   * dropped as soon as the runtime reports the run itself.
   */
  bind(launchId: string, runId: string | null): void;
  /** Preserve an ambiguous launch until public status identifies it or the session ends. */
  hold(launchId: string, alias: string): void;
  /** Correlate an existing reservation before emission; do not create one for an unlimited launch. */
  trackAlias(launchId: string, alias: string): void;
  /** Drop one reservation: the launch either became a native run or did not happen. */
  release(launchId: string): void;
  /** Completion releases a correlated owner without inventing a new lifecycle state. */
  releaseRun(runId: string): void;
  pending(): number;
  dispose(): void;
}

const BRIDGES = new WeakMap<object, SubagentsBridge>();

interface Reservation {
  runId?: string;
  alias?: string;
}

/**
 * The session's bridge, created on first use.
 *
 * Keyed by the runtime host: a host outlives one session but not the extension
 * runtime, and a new session must not inherit the previous session's client (its
 * RPC bridge belonged to the runtime that served that session). `sessionEpoch`
 * is the signal that a replacement happened.
 */
export function attachSubagents(
  host: object,
  options: { epoch: number; events: ExtensionEvents | undefined },
): SubagentsBridge {
  const existing = BRIDGES.get(host);
  if (existing && existing.epoch === options.epoch) return existing;
  existing?.dispose();

  const client = new SubagentsClient({ events: options.events });
  const reservations = new Map<string, Reservation>();
  let lastActivity: NativeActivity | null = null;
  let lastFleet: FleetWindow | null = null;
  let disposed = false;

  // Serialize public reads and admission, so overlapping tools and our command share
  // one capacity decision. Result hooks may still release/bind while a read awaits.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  }
  const observe = async (): Promise<NativeActivity> => {
    if (disposed) return { kind: "unknown", reason: "本会话已结束。" };
    const confirmed = new Map<string, Reservation>();
    for (const [launchId, entry] of reservations) {
      const target = entry.runId ?? entry.alias;
      if (!target) continue;
      const recovery = await client.status({ id: target });
      if (disposed) return { kind: "unknown", reason: "本会话已结束。" };
      const details = recovery.ok ? record(recovery.data.details) : null;
      const id = text(details?.runId);
      if (id && (!entry.runId || id === entry.runId) &&
          (!entry.alias || !text(details?.toolCallId) || details?.toolCallId === entry.alias)) {
        entry.runId = id;
        confirmed.set(launchId, entry);
      }
    }
    // Read capacity AFTER resolving aliases. Even a truncated display includes
    // those already-native owners in the authoritative top-level count.
    const activity = await client.observeActivity();
    if (disposed) return { kind: "unknown", reason: "本会话已结束。" };
    if (activity.kind === "known") {
      for (const [id, entry] of confirmed) {
        if (reservations.get(id) === entry) reservations.delete(id);
      }
    }
    reconcile(activity);
    lastActivity = activity;
    return activity;
  };

  const bridge: SubagentsBridge = {
    client,
    epoch: options.epoch,
    observe: () => serial(observe),
    fleet() {
      return serial(async () => {
        if (disposed) return { kind: "unknown" as const, reason: "本会话已结束。" };
        const window = await client.fleetWindow();
        if (disposed) return { kind: "unknown" as const, reason: "本会话已结束。" };
        lastFleet = window;
        return window;
      });
    },
    fleetView() {
      return lastFleet ?? { kind: "unknown", reason: "尚未读取公开 fleet 窗口" };
    },
    activity: () => lastActivity ?? { kind: "unknown", reason: "尚未读取公开状态" },
    admit(launchId, limit) {
      return serial(async () => {
        if (disposed) return { admit: false, reason: "本会话已结束。" };
        if (limit === null) {
          reservations.delete(launchId);
          return { admit: true, total: null };
        }
        const activity = await observe();
        return settle(launchId, limit, activity);
      });
    },
    admitSync(launchId, limit) {
      if (disposed) return { admit: false, reason: "本会话已结束。" };
      if (limit === null) {
        reservations.delete(launchId);
        return { admit: true, total: null };
      }
      if (lastActivity === null) {
        return {
          admit: false,
          reason: [
            `本项目设了子 agent 并发上限 ${limit}，但还没有读到 pi-subagents 的公开运行状态，无法计数。`,
            "为避免把上限变成一句空话，这次派单被拦下。请先用 `/Coworkflow:run` 或面板刷新一次状态，或在 `/Coworkflow:settings` 里清空「本项目并发上限」（留空 = 不限）。",
          ].join(""),
        };
      }
      return settle(launchId, limit, lastActivity);
    },
    agentCount(agent) {
      return serial(async () => {
        if (disposed) return { kind: "unknown" as const, reason: "本会话已结束。" };
        const observed = await client.agentActivity();
        if (disposed) return { kind: "unknown" as const, reason: "本会话已结束。" };
        if (observed.kind === "unknown") return observed;
        return { kind: "known" as const, count: observed.counts.get(agent) ?? 0 };
      });
    },
    release(launchId) {
      reservations.delete(launchId);
    },
    bind(launchId, runId) {
      const entry = reservations.get(launchId);
      if (entry === undefined) return;
      if (runId !== null) entry.runId = runId;
    },
    trackAlias(launchId, alias) {
      const entry = reservations.get(launchId);
      if (entry && !disposed) entry.alias = alias;
    },
    hold(launchId, alias) {
      if (!disposed) reservations.set(launchId, { alias });
    },
    releaseRun(runId) {
      for (const [id, entry] of reservations) if (entry.runId === runId) reservations.delete(id);
    },
    pending() {
      return reservations.size;
    },
    dispose() {
      disposed = true;
      reservations.clear();
      lastActivity = null;
      lastFleet = null;
      client.dispose();
      if (BRIDGES.get(host) === bridge) BRIDGES.delete(host);
    },
  };

  function reconcile(activity: NativeActivity): void {
    // A reservation whose run is now visible natively has done its job: keeping it
    // would count one launch twice.
    if (activity.kind === "known") {
      const visible = new Set(activity.runs.map((run) => run.id));
      for (const [id, entry] of reservations) {
        if (entry.runId !== undefined && visible.has(entry.runId)) reservations.delete(id);
      }
    }
  }

  function settle(launchId: string, limit: number, activity: NativeActivity): Admission {
    if (disposed) return { admit: false, reason: "本会话已结束。" };
    reconcile(activity);
    const decision = decideAdmission({ limit, activity, pending: reservations.size });
    if (decision.admit) reservations.set(launchId, {});
    return decision;
  }

  BRIDGES.set(host, bridge);
  return bridge;
}

/** The bridge this host already has, if any. Never creates one. */
export function existingSubagentsBridge(host: object): SubagentsBridge | undefined {
  return BRIDGES.get(host);
}
