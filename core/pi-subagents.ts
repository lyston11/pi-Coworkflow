/** Installed package/config metadata and public native result decoders. No run-directory scans. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { npmPackagesDir, userSubagentConfigPath } from "./agentdir.ts";

export function subagentsPackageDir(): string {
  return join(npmPackagesDir(), "pi-subagents");
}

/** Installed pi-subagents version, or null when it is not in Pi's npm dir. */
export function installedVersion(): string | null {
  try {
    const raw = readFileSync(join(subagentsPackageDir(), "package.json"), "utf-8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export interface SubagentsUserConfig {
  /** Its own user-level capacity limit; there is no project override for it. */
  maxActiveAsyncRunsPerSession?: number;
  /** `fork` would hand a Trellis child the parent's prompt instead of its role context. */
  defaultSubagentContext?: string;
  /**
   * How the `subagent` tool is exposed: `auto` (default), `dynamic`, or `eager`.
   *
   * Read from this file's top level — **not** from `subagents.toolActivation` in
   * settings.json, where nothing reads it. Getting that wrong once cost a machine
   * several restarts and a wrong diagnosis.
   */
  toolActivation?: string;
}

export function readUserConfig(): SubagentsUserConfig | null {
  let raw: string;
  try {
    raw = readFileSync(userSubagentConfigPath(), "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const limit = parsed.maxActiveAsyncRunsPerSession;
    const context = parsed.defaultSubagentContext;
    return {
      ...(typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? { maxActiveAsyncRunsPerSession: limit }
        : {}),
      ...(typeof context === "string" ? { defaultSubagentContext: context } : {}),
    };
  } catch {
    return null;
  }
}


function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 8192 ? value.trim() : undefined;
}
const CHILD_STATES = new Set(["pending", "queued", "running", "complete", "completed", "failed", "partial", "paused", "stopped", "rejected", "detached"]);
function state(value: unknown): string | undefined {
  return typeof value === "string" && CHILD_STATES.has(value) ? value : undefined;
}
function rows(value: unknown): unknown[] { return Array.isArray(value) ? value.slice(0, 500) : []; }
function indexOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export interface NativeChild {
  runId?: string;
  index?: number;
  stepIndex?: number;
  workflowKey?: string;
  agent?: string;
  status?: string;
  outputPath?: string;
  patchPath?: string;
  branch?: string;
  worktreePath?: string;
  diffStat?: string;
  filesChanged?: number;
}
export interface NativeResult {
  runId: string;
  missionId?: string;
  workflowRunId?: string;
  status?: string;
  handoffPath?: string;
  workflowReceiptPath?: string;
  children: NativeChild[];
}

/** Public tool_result details. Never treat a successful launch receipt as completion. */
export function decodeNativeResult(value: unknown): NativeResult | null {
  const details = object(value);
  const runId = str(details?.runId) ?? str(details?.asyncId);
  if (!details || !runId) return null;
  const summary = object(details.workflowChildren);
  const children: NativeChild[] = [];
  for (const raw of rows(details.results)) {
    const child = object(raw);
    const id = str(child?.runId);
    const index = indexOf(child?.index);
    if (!child || (!id && index === undefined)) continue;
    children.push({ runId: id, index, workflowKey: str(child.workflowKey), agent: str(child.agent),
      status: state(object(child.execution)?.status),
      outputPath: str(child.savedOutputPath) ?? str(object(child.artifactPaths)?.outputPath) });
  }
  if (summary?.version === 1 && summary.workflowRunId === runId) {
    for (const raw of rows(summary.children)) {
      const child = object(raw);
      const id = str(child?.runId);
      if (!child || !id) continue;
      const existing = children.find((candidate) => candidate.runId === id);
      const observed = { runId: id, agent: str(child.agent), status: state(child.state) };
      if (existing) Object.assign(existing, observed);
      else children.push(observed);
    }
  }
  const handoff = object(details.parallelHandoff);
  return { runId, missionId: str(details.missionId),
    workflowRunId: summary?.workflowRunId === runId ? runId : undefined,
    status: summary?.workflowRunId === runId ? state(summary.workflowState) : undefined,
    handoffPath: handoff?.version === 1 ? str(handoff.path) : undefined,
    workflowReceiptPath: str(details.workflowReceiptPath), children };
}

/** Native custom-message correlation; content/prose is deliberately never inspected. */
export function decodeNativeCompletions(value: unknown): NativeResult[] {
  const message = object(value);
  if (message?.customType !== "subagent-notify") return [];
  const completions: NativeResult[] = [];
  for (const raw of rows(object(message.details)?.runs)) {
    const run = object(raw);
    const runId = str(run?.runId) ?? str(run?.workflowRunId);
    if (!run || !runId || !["completed", "failed", "paused", "stopped"].includes(String(run.status))) continue;
    const children: NativeChild[] = [];
    for (const rawChild of rows(run.childRuns)) {
      const child = object(rawChild);
      const id = str(child?.runId);
      if (!child || !id) continue;
      children.push({ runId: id, workflowKey: str(child.workflowKey), agent: str(child.agent), status: state(child.status) });
    }
    completions.push({ runId, workflowRunId: str(run.workflowRunId), status: str(run.status),
      handoffPath: str(run.handoffPath), workflowReceiptPath: str(run.workflowReceiptPath), children });
  }
  return completions;
}

export interface NativeHandoff {
  children: NativeChild[];
  eligibility?: string;
  eligibilityReason?: string;
  mergeCommit?: string;
  prNumber?: number;
}

/** Read only a public handoff path supplied by a receipt or a preserved legacy pointer. */
export function readNativeHandoff(path: string, runId: string): NativeHandoff | null {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 2_000_000) return null;
    const manifest = object(JSON.parse(raw));
    if (manifest?.version !== 1 || manifest.runId !== runId) return null;
    const children: NativeChild[] = [];
    for (const rawGroup of rows(manifest.groups)) {
      const group = object(rawGroup);
      const tasks = rows(object(group?.cleanup)?.tasks).map(object);
      for (const rawChild of rows(group?.children)) {
        const child = object(rawChild);
        const id = str(child?.runId);
        const index = indexOf(child?.index);
        if (!child || (!id && index === undefined)) continue;
        const patch = object(child.patch);
        const matching = index === undefined ? [] : tasks.filter((task) => task?.index === index);
        const cleanup = matching.length === 1 ? matching[0] : undefined;
        children.push({ runId: id, index, stepIndex: indexOf(group?.stepIndex), workflowKey: str(child.workflowKey), agent: str(child.agent),
          status: state(child.status), outputPath: str(child.outputPath), patchPath: str(patch?.path),
          branch: str(patch?.branch) ?? str(cleanup?.branch), worktreePath: str(cleanup?.path),
          diffStat: str(patch?.diffStat), filesChanged: indexOf(patch?.filesChanged) });
      }
    }
    const eligibility = object(manifest.cleanupEligibility);
    const merge = object(manifest.merge);
    return { children, eligibility: str(eligibility?.state), eligibilityReason: str(eligibility?.reason),
      mergeCommit: str(merge?.mergeCommit), prNumber: indexOf(merge?.prNumber) };
  } catch { return null; }
}

/** Public workflow receipts retain exact child attempt ids and keyed output references. */
export function readNativeWorkflowReceipt(path: string, runId: string): NativeChild[] {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > 2_000_000) return [];
    const receipt = object(JSON.parse(raw));
    if (receipt?.version !== 1 || receipt.workflowRunId !== runId) return [];
    const entries = object(receipt.entries);
    if (!entries) return [];
    return Object.entries(entries).slice(0, 500).flatMap(([key, raw]) => {
      const entry = object(raw);
      const id = str(entry?.latestRunId);
      if (!entry || !id) return [];
      return [{ runId: id, workflowKey: key, agent: str(entry.agent), outputPath: str(entry.outputReference) }];
    });
  } catch { return []; }
}

/** Join only exact child ids or unambiguous native index coordinates, never array order. */
export function mergeNativeChildren(...groups: NativeChild[][]): NativeChild[] {
  const merged: NativeChild[] = [];
  for (const child of groups.flat()) {
    const candidates = merged.filter((existing) => {
      if (child.runId || existing.runId) return child.runId !== undefined && child.runId === existing.runId;
      return child.index !== undefined && child.index === existing.index && child.stepIndex === existing.stepIndex;
    });
    const fields = Object.fromEntries(Object.entries(child).filter(([, value]) => value !== undefined));
    if (candidates.length === 1) Object.assign(candidates[0]!, fields);
    else merged.push({ ...child });
  }
  return merged;
}
