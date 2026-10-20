/** Usage totals come from public native cost; daily history keeps Pi's model/timestamp records. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PiRuntimeHost, RuntimeContext } from "./module.ts";
import { attachSubagents, type NativeCost } from "./subagents-client.ts";
import { sessionEnabledSince } from "./trellis.ts";
import { configRoot } from "./config.ts";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function addUsage(target: UsageTotals, addend: UsageTotals): UsageTotals {
  target.input += addend.input;
  target.output += addend.output;
  target.cacheRead += addend.cacheRead;
  target.cacheWrite += addend.cacheWrite;
  target.cost += addend.cost;
  target.turns += addend.turns;
  return target;
}

export function isZeroUsage(usage: UsageTotals): boolean {
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.turns === 0
  );
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize a usage record.
 *
 * Pi session entries write cost as an object; numeric costs are accepted too.
 * Native RPC data is decoded strictly by subagents-client, never by this helper.
 */
export function normalizeUsage(raw: unknown, fallbackTurns = 1): UsageTotals | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const cost =
    typeof record.cost === "number"
      ? record.cost
      : record.cost !== null && typeof record.cost === "object"
        ? num((record.cost as Record<string, unknown>).total)
        : 0;
  const usage: UsageTotals = {
    input: num(record.input),
    output: num(record.output),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
    cost,
    turns: num(record.turns) || fallbackTurns,
  };
  return usage;
}

function modelKey(provider: unknown, model: unknown): string {
  const p = typeof provider === "string" ? provider : "";
  const m = typeof model === "string" ? model : "";
  if (p && m) return `${p}/${m}`;
  return m || p || "(未知模型)";
}

/** Group one session's entries by the model that produced each token. */
export function collectSessionUsage(entries: unknown[]): {
  byModel: Map<string, UsageTotals>;
  total: UsageTotals;
} {
  const byModel = new Map<string, UsageTotals>();
  const total = emptyUsage();

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;

    let provider: unknown;
    let model: unknown;
    let usage: UsageTotals | null = null;

    if (type === "message") {
      const message = record.message;
      if (message === null || typeof message !== "object") continue;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== "assistant") continue;
      provider = messageRecord.provider;
      model = messageRecord.model;
      usage = normalizeUsage(messageRecord.usage);
    } else if (type === "usage" || type === "compaction" || type === "branch_summary") {
      provider = record.provider;
      model = record.model;
      usage = normalizeUsage(record.usage);
    }

    if (usage === null) continue;
    const key = modelKey(provider, model);
    const bucket = byModel.get(key) ?? emptyUsage();
    addUsage(bucket, usage);
    byModel.set(key, bucket);
    addUsage(total, usage);
  }
  return { byModel, total };
}

/** `12.3k` / `1.2M` / `512`, so a row stays one line wide. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** One-line usage summary. `cost` is omitted when nothing reported it. */
export function formatUsage(
  usage: UsageTotals,
  options: { cost?: boolean; turns?: boolean } = {},
): string {
  const parts = [`in ${formatTokens(usage.input)}`, `out ${formatTokens(usage.output)}`];
  const cache = usage.cacheRead + usage.cacheWrite;
  if (cache > 0) parts.push(`cache ${formatTokens(cache)}`);
  if (options.cost !== false && usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (options.turns !== false && usage.turns > 0) parts.push(`${usage.turns} turns`);
  return parts.join(" · ");
}

/** Descending by total tokens, so the biggest consumer reads first. */
export function topEntries(map: Map<string, UsageTotals>, limit: number): [string, UsageTotals][] {
  return [...map.entries()]
    .sort(
      (a, b) =>
        b[1].input + b[1].output + b[1].cacheRead + b[1].cacheWrite -
        (a[1].input + a[1].output + a[1].cacheRead + a[1].cacheWrite),
    )
    .slice(0, limit);
}

/** A token count for one local day, keyed by `YYYY-MM-DD`. */
export interface DailyTokens {
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DailySeries {
  /** Oldest first, exactly `days` entries; days without usage are zero. */
  days: DailyTokens[];
  total: number;
  /** Largest single day, for scaling bars. */
  peak: number;
  /** Missing native cost/history makes this a lower bound, never a complete zero. */
  incomplete?: boolean;
  unavailable?: boolean;
  reason?: string;
}

/** Local `YYYY-MM-DD` for a timestamp, so "today" matches the user's clock. */
export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The last `days` local days, oldest first, ending today. */
export function recentDays(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(localDay(d));
  }
  return out;
}

function emptyDay(day: string): DailyTokens {
  return { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function accumulateDay(day: DailyTokens, usage: UsageTotals): void {
  day.input += usage.input;
  day.output += usage.output;
  day.cacheRead += usage.cacheRead;
  day.cacheWrite += usage.cacheWrite;
}

function seriesFrom(byDay: Map<string, DailyTokens>, days: number, now = new Date()): DailySeries {
  const window = recentDays(days, now);
  const list = window.map((day) => byDay.get(day) ?? emptyDay(day));
  const total = list.reduce(
    (sum, day) => sum + day.input + day.output + day.cacheRead + day.cacheWrite,
    0,
  );
  const peak = list.reduce(
    (max, day) => Math.max(max, day.input + day.output + day.cacheRead + day.cacheWrite),
    0,
  );
  return { days: list, total, peak };
}

/**
 * Token usage per local day for one model, over a sliding window.
 *
 * `model` is the `provider/id` key used by the usage records; matching is exact
 * so two providers offering the same model name never share a series. Records
 * without a usable timestamp are skipped rather than bucketed into today, since
 * inventing a day would overstate recent usage.
 */
export function collectModelDailyUsage(
  entries: unknown[],
  model: string,
  days: number,
  now = new Date(),
  /** Only count records at or after this instant (ms), e.g. when the layer loaded. */
  since?: number,
): DailySeries {
  const byDay = new Map<string, DailyTokens>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    let provider: unknown;
    let modelId: unknown;
    let usage: UsageTotals | null = null;
    let stamp: unknown = record.timestamp;

    if (type === "message") {
      const message = record.message;
      if (message === null || typeof message !== "object") continue;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== "assistant") continue;
      provider = messageRecord.provider;
      modelId = messageRecord.model;
      usage = normalizeUsage(messageRecord.usage);
      stamp = record.timestamp ?? messageRecord.timestamp;
    } else if (type === "usage" || type === "compaction" || type === "branch_summary") {
      provider = record.provider;
      modelId = record.model;
      usage = normalizeUsage(record.usage);
    }
    if (usage === null) continue;
    if (modelKey(provider, modelId) !== model) continue;

    const at = typeof stamp === "string" || typeof stamp === "number" ? new Date(stamp) : null;
    if (at === null || Number.isNaN(at.getTime())) continue;
    if (since !== undefined && at.getTime() < since) continue;
    const key = localDay(at);
    const bucket = byDay.get(key) ?? emptyDay(key);
    accumulateDay(bucket, usage);
    byDay.set(key, bucket);
  }
  return seriesFrom(byDay, days, now);
}

function validateParentHistory(entries: unknown[] | null): string[] {
  if (entries === null) return ["主会话历史不可用"];
  const issues: string[] = [];
  for (const value of entries) {
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const message = row.type === "message" && row.message !== null && typeof row.message === "object"
      ? row.message as Record<string, unknown> : null;
    const usageBearing = message?.role === "assistant" || ["usage", "compaction", "branch_summary"].includes(String(row.type));
    if (!usageBearing) continue;
    const usage = message ? message.usage : row.usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage) ||
      ["input", "output", "cacheRead", "cacheWrite"].some((key) =>
        typeof (usage as Record<string, unknown>)[key] !== "number" ||
        !Number.isFinite((usage as Record<string, number>)[key]) || (usage as Record<string, number>)[key]! < 0)) {
      issues.push("主会话记录用量不完整");
      continue;
    }
    const provider = message ? message.provider : row.provider;
    const model = message ? message.model : row.model;
    const stamp = row.timestamp ?? message?.timestamp;
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model ||
      (typeof stamp !== "string" && typeof stamp !== "number") || Number.isNaN(new Date(stamp).getTime())) {
      issues.push("主会话记录缺少模型或时间，未猜测归属");
    }
  }
  return [...new Set(issues)];
}

/** No artifacts are discovered here: only exact sessionFile pointers from native cost. */
export interface UsageSnapshot {
  cost: NativeCost;
  parentEntries: unknown[] | null;
  childEntries: unknown[];
  historyIssues: string[];
  since?: number;
}

const unavailable = (reason: string): UsageSnapshot => ({
  cost: { kind: "unknown", reason }, parentEntries: null, childEntries: [], historyIssues: [reason],
});
interface UsageState {
  runtime: RuntimeContext;
  epoch: number;
  sessionId: string | null;
  snapshot: UsageSnapshot;
  pending?: Promise<void>;
  revision: number;
}
const observations = new WeakMap<object, UsageState>();

/** Read-only rendering access; no RPC, configuration reads or filesystem scans. */
export function usageSnapshot(host: object, runtime: RuntimeContext): UsageSnapshot {
  const state = observations.get(host);
  return runtime.enabled && state?.runtime === runtime && state.epoch === runtime.sessionEpoch &&
    state.sessionId === runtime.sessionId ? state.snapshot : unavailable("尚未读取本会话用量");
}

export function disposeUsage(host: object): void {
  observations.delete(host);
}

interface UsageContext {
  sessionManager?: { getSessionId?: () => string | undefined; getEntries?: () => unknown[] };
}

/** Session/open/settled/completion boundary only; concurrent refreshes share work, latest context wins. */
export async function refreshUsage(host: PiRuntimeHost, runtime: RuntimeContext, ctx: UsageContext = {}): Promise<void> {
  if (runtime.isChild || !runtime.enabled || !runtime.control.moduleEnabled("panel")) {
    disposeUsage(host);
    return;
  }
  const contextId = ctx.sessionManager?.getSessionId?.();
  if (contextId && contextId !== runtime.sessionId) return;
  let state = observations.get(host);
  if (!state || state.runtime !== runtime || state.epoch !== runtime.sessionEpoch || state.sessionId !== runtime.sessionId) {
    state = { runtime, epoch: runtime.sessionEpoch, sessionId: runtime.sessionId,
      snapshot: unavailable("正在读取公开用量"), revision: 0 };
    observations.set(host, state);
  }
  const current = state;
  const entries = ctx.sessionManager?.getEntries?.();
  current.snapshot = { ...current.snapshot, parentEntries: Array.isArray(entries) ? [...entries] : null,
    historyIssues: validateParentHistory(Array.isArray(entries) ? entries : null),
    since: sessionEnabledSince(configRoot(runtime.cwd), runtime.sessionId) };
  current.revision += 1;
  if (current.pending) return current.pending;
  const valid = (): boolean => observations.get(host) === current && current.epoch === runtime.sessionEpoch &&
    current.sessionId === runtime.sessionId && runtime.enabled;
  const bridge = attachSubagents(host, { epoch: runtime.sessionEpoch, events: host.events });
  current.pending = (async () => {
    // One extra boundary arriving during I/O must not get a pre-completion cost snapshot.
    // This drains explicit requests only; it never schedules a poll or timer.
    let revision: number;
    do {
      revision = current.revision;
      const cost = await bridge.client.cost();
      if (!valid()) return;
      const history = await readChildHistory(cost);
      if (!valid()) return;
      current.snapshot = { ...current.snapshot, cost,
        childEntries: history.childEntries,
        historyIssues: [...validateParentHistory(current.snapshot.parentEntries), ...history.historyIssues] };
    } while (revision !== current.revision && valid());
  })().finally(() => { current.pending = undefined; });
  return current.pending;
}

const MAX_HISTORY_FILES = 128;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function readChildHistory(cost: NativeCost): Promise<Pick<UsageSnapshot, "childEntries" | "historyIssues">> {
  const childEntries: unknown[] = [];
  const historyIssues: string[] = [];
  if (cost.kind === "unknown") return { childEntries, historyIssues: [cost.reason] };
  if (cost.incomplete) historyIssues.push(`${cost.unresolvedAsyncChildren} 个子任务用量未解析`);
  const seen = new Set<string>();
  let bytesLeft = MAX_HISTORY_BYTES;
  for (const child of cost.children) {
    const path = child.sessionFile;
    if (!path || !isAbsolute(path)) {
      historyIssues.push("子任务缺少可用的原生 sessionFile");
      continue;
    }
    if (seen.has(path)) continue;
    if (seen.size >= MAX_HISTORY_FILES || bytesLeft <= 0) {
      historyIssues.push("子会话历史超过读取预算");
      break;
    }
    seen.add(path);
    try {
      // Explicit bounded reads prevent a growing log from bypassing the stat limit.
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      let body: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) { historyIssues.push("原生 sessionFile 不是普通文件"); continue; }
        const size = stat.size;
        if (size > Math.min(MAX_FILE_BYTES, bytesLeft)) {
          historyIssues.push("子会话历史超过读取预算");
          continue;
        }
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const result = await file.read(buffer, offset, size - offset, offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        bytesLeft -= size;
        body = buffer.subarray(0, offset).toString("utf8");
        if (offset !== size || (await file.stat()).size !== size) historyIssues.push("子会话历史读取时发生变化");
      } finally { await file.close(); }
      const entries: unknown[] = [];
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); }
        catch { historyIssues.push("子会话历史含未完整写入或无效的记录"); }
      }
      if (entries.length === 0 && !isZeroUsage(child.usage)) historyIssues.push("子会话历史为空");
      const usable: unknown[] = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const message = row.type === "message" && row.message !== null && typeof row.message === "object"
          ? row.message as Record<string, unknown> : row;
        if (message.usage === undefined) {
          if (message.role === "assistant") historyIssues.push("子会话记录缺少用量");
          continue;
        }
        const stamp = row.timestamp ?? message.timestamp;
        if (typeof message.provider !== "string" || !message.provider || typeof message.model !== "string" || !message.model ||
            (typeof stamp !== "string" && typeof stamp !== "number") || Number.isNaN(new Date(stamp).getTime())) {
          historyIssues.push("子会话记录缺少模型或时间，未猜测归属");
          continue;
        }
        const usage = message.usage as Record<string, unknown> | null;
        if (!usage || typeof usage !== "object" || ["input", "output", "cacheRead", "cacheWrite"].some((key) =>
          typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || (usage[key] as number) < 0)) {
          historyIssues.push("子会话记录用量不完整");
          continue;
        }
        usable.push(entry);
      }
      if (usable.length === 0 && !isZeroUsage(child.usage)) historyIssues.push("子会话历史缺少原生已记录的用量");
      childEntries.push(...usable);
    } catch {
      historyIssues.push("无法读取原生指向的子会话历史");
    }
  }
  return { childEntries, historyIssues: [...new Set(historyIssues)] };
}

/** Keep the existing combined per-model chart; native totals have no model/day attribution. */
export function collectUsageHistory(snapshot: UsageSnapshot, model: string, days: number, now = new Date()): DailySeries {
  const series = collectModelDailyUsage([...(snapshot.parentEntries ?? []), ...snapshot.childEntries], model, days, now, snapshot.since);
  const issues = [...snapshot.historyIssues];
  if (snapshot.parentEntries === null) issues.push("主会话历史不可用");
  if (snapshot.cost.kind === "unknown") issues.push(snapshot.cost.reason);
  const incomplete = issues.length > 0;
  return { ...series, incomplete, unavailable: incomplete && series.total === 0,
    ...(incomplete ? { reason: [...new Set(issues)].join("；") } : {}) };
}

/** Whole-session native cost, separate from the since-enable/model/day chart. */
export function formatNativeCost(cost: NativeCost): string {
  if (cost.kind === "unknown") return `原生用量未知（${cost.reason}）`;
  const suffix = cost.incomplete ? `（不完整：${cost.unresolvedAsyncChildren} 个子任务未解析）` : "";
  return `原生本会话合计${cost.incomplete ? " ≥" : ""} ${formatUsage(cost.total)}${suffix}`;
}
