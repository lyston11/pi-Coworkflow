/**
 * Token and cost accounting for the panel.
 *
 * Two sources, both already on disk because Pi and pi-subagents wrote them:
 *
 *   主会话  Pi's own session entries. Every assistant message carries
 *           `{provider, model, usage}`, and `usage` entries (cache warming) plus
 *           compaction/branch summaries carry usage too, so grouping the current
 *           session's entries by model gives exactly what each main-session model
 *           consumed. This is the same data Pi's footer totals.
 *   子 agent pi-subagents' run artifacts: `<sessionDir>/subagent-artifacts/
 *           <runId>_<agent>_meta.json` holds `{runId, parentSessionId, agent,
 *           model, usage}`, and project-mode artifacts hold the same under
 *           `<cwd>/.pi/subagents/artifacts/`. Summing them per agent is the
 *           child half of the same accounting pi-subagents' `/subagent-cost`
 *           renders (it reports `parent` + `children` + `childTotal`), read from
 *           the documented artifact rather than from its internals.
 *
 * Nothing is cached or persisted: the panel reads the files each time it opens,
 * so the numbers always match what Pi and pi-subagents just wrote.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
 * Pi writes `cost` as an object (`{input, output, cacheRead, cacheWrite, total}`);
 * pi-subagents' run metadata writes it as a plain number. Both are accepted.
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

export interface ChildUsage {
  runs: number;
  byAgent: Map<string, UsageTotals>;
  total: UsageTotals;
}

/** Sum pi-subagents' per-run metadata files, optionally only one parent session. */
export function collectChildUsage(
  artifactDirs: string[],
  parentSessionId?: string | null,
): ChildUsage {
  const byAgent = new Map<string, UsageTotals>();
  const total = emptyUsage();
  let runs = 0;

  for (const dir of artifactDirs) {
    for (const file of listMetaFiles(dir)) {
      const meta = readJson(join(dir, file));
      if (meta === null) continue;
      if (
        parentSessionId &&
        typeof meta.parentSessionId === "string" &&
        meta.parentSessionId !== parentSessionId
      ) {
        continue;
      }
      const usage = normalizeUsage(meta.usage, 0);
      if (usage === null) continue;
      runs += 1;
      const agent = typeof meta.agent === "string" && meta.agent ? meta.agent : "(未知 agent)";
      const model = typeof meta.model === "string" ? ` · ${meta.model}` : "";
      const key = `${agent}${model}`;
      const bucket = byAgent.get(key) ?? emptyUsage();
      addUsage(bucket, usage);
      byAgent.set(key, bucket);
      addUsage(total, usage);
    }
  }
  return { runs, byAgent, total };
}

/** pi-subagents names its per-run metadata `<runId>_<agent>_meta.json`. */
function listMetaFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith("_meta.json"))
      .sort();
  } catch {
    return [];
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > 512 * 1024) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
