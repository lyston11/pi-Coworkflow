/**
 * Module: lane ledger and merge plan.
 *
 * Parallel lanes are pi-subagents' job, and it already does the hard parts: it
 * allocates a managed worktree per lane, captures each child's patch, and keeps
 * a parallel handoff manifest with lane status, merge evidence and cleanup
 * eligibility (`lane.status` / `lane.recordMerge` / `worktree.cleanup`). None of
 * that is re-implemented here.
 *
 * What was missing is the Trellis side of the ledger: a lane's manifest path
 * lived only in the run's result text (`Parallel handoff: <path>`), so it was
 * not bound to the task, and nothing gave the main session a merge plan. This
 * module therefore:
 *
 *   1. records a pointer per lane under `.trellis/.runtime/lanes/<task>/`
 *      (gitignored, next to Trellis's own session pointers — lane pointers are
 *      machine state and must not be committed),
 *   2. exposes `/Coworkflow:lanes`, which reads those pointers plus each manifest
 *      and prints lane facts and the Trellis-conformant merge sequence.
 *
 * It never merges, never applies a patch, and never removes a worktree: the main
 * session audits and merges, and destructive cleanup stays behind pi-subagents'
 * own authority policy.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { mainCheckout, readText, repoRoot, laneDir, activeTaskDir, taskRefForDisplay } from "../../core/trellis.ts";
import { attachLedger } from "../../core/ledger.ts";

const HANDOFF_LINE_RE = /^Parallel handoff:\s*(.+?)\s*$/m;

export interface LaneRecord {
  version: 1;
  runId: string;
  agent?: string;
  handoffPath: string;
  taskRef: string;
  sessionId?: string;
  recordedAt: string;
}

interface LaneFacts {
  runId: string;
  handoffPath: string;
  agent?: string;
  status?: string;
  worktree?: string;
  branch?: string;
  patchPath?: string;
  diffStat?: string;
  filesChanged?: number;
  eligibility?: string;
  eligibilityReason?: string;
  mergeCommit?: string;
  prNumber?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The manifest path pi-subagents reports for a worktree-isolated run. */
export function extractHandoffPath(event: any): string | undefined {
  const fromDetails = str(event?.details?.handoffPath);
  if (fromDetails) return fromDetails;
  const texts: string[] = Array.isArray(event?.content)
    ? event.content
        .map((part: unknown) =>
          part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .filter(Boolean)
    : [];
  for (const text of texts) {
    const match = HANDOFF_LINE_RE.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function runIdFromHandoffPath(handoffPath: string): string {
  const file = handoffPath.split("/").pop() ?? "";
  const stem = file.replace(/\.json$/, "");
  return stem && stem !== "handoff" ? stem : file || handoffPath;
}

function readLaneFacts(record: LaneRecord): LaneFacts {
  const facts: LaneFacts = { runId: record.runId, handoffPath: record.handoffPath, agent: record.agent };
  const raw = readText(record.handoffPath);
  if (!raw) return facts;
  let manifest: any;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return facts;
  }
  if (manifest === null || typeof manifest !== "object") return facts;

  const groups: any[] = Array.isArray(manifest.groups) ? manifest.groups : [];
  for (const group of groups) {
    const children: any[] = Array.isArray(group?.children) ? group.children : [];
    const cleanups: any[] = Array.isArray(group?.cleanup?.tasks) ? group.cleanup.tasks : [];
    for (const child of children) {
      const patch = child?.patch ?? {};
      facts.agent ??= str(child?.agent) ?? record.agent;
      facts.status = str(child?.status) ?? facts.status;
      facts.branch = str(patch?.branch) ?? facts.branch;
      facts.patchPath = str(patch?.path) ?? facts.patchPath;
      facts.diffStat = str(patch?.diffStat) ?? facts.diffStat;
      facts.filesChanged = num(patch?.filesChanged) ?? facts.filesChanged;
      const worktree = cleanups.find((task) => num(task?.index) === num(child?.index));
      facts.worktree = str(worktree?.path) ?? facts.worktree;
      facts.branch = str(worktree?.branch) ?? facts.branch;
    }
    for (const task of cleanups) {
      facts.worktree ??= str(task?.path);
      facts.branch ??= str(task?.branch);
    }
  }

  const eligibility = manifest.cleanupEligibility;
  facts.eligibility = str(eligibility?.state);
  facts.eligibilityReason = str(eligibility?.reason);
  facts.mergeCommit = str(manifest.merge?.mergeCommit);
  facts.prNumber = num(manifest.merge?.prNumber);
  return facts;
}

function readLaneRecords(root: string, taskDir: string): LaneRecord[] {
  const dir = laneDir(root, taskDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const records: LaneRecord[] = [];
  for (const name of names) {
    const raw = readText(join(dir, name));
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") records.push(parsed as LaneRecord);
    } catch {
      // A corrupt pointer must not hide the other lanes.
    }
  }
  return records;
}

function sessionIdOf(ctx: any, runtime: RuntimeContext): string | null {
  const fromCtx = ctx?.sessionManager?.getSessionId?.();
  return typeof fromCtx === "string" && fromCtx ? fromCtx : runtime.sessionId;
}

function renderLanes(root: string, taskDir: string, records: LaneRecord[]): string {
  const taskRef = taskRefForDisplay(root, taskDir);
  if (records.length === 0) {
    return [
      `任务: ${taskRef}`,
      "  没有 lane 记录。",
      "",
      "只有 worktree 隔离的派单才会留下 lane 证据；主会话用 `subagent({ ..., async: true, worktree: true })` 派单后这里会出现记录。",
    ].join("\n");
  }

  const lines = [`任务: ${taskRef}`, `lanes: ${records.length}`, ""];
  const plans: string[] = [];

  for (const record of records) {
    const facts = readLaneFacts(record);
    const size = facts.diffStat
      ? ` (${facts.diffStat})`
      : facts.filesChanged !== undefined
        ? ` (${facts.filesChanged} files)`
        : "";
    lines.push(`lane ${facts.runId}  agent=${facts.agent ?? "?"}  status=${facts.status ?? "?"}`);
    if (facts.worktree) lines.push(`  worktree: ${facts.worktree}`);
    if (facts.branch) lines.push(`  branch:   ${facts.branch}`);
    if (facts.patchPath) lines.push(`  patch:    ${facts.patchPath}${size}`);
    else if (!readText(facts.handoffPath)) lines.push("  patch:    manifest 不可读（可能已被保留策略清理）");
    lines.push(`  handoff:  ${facts.handoffPath}`);
    if (facts.eligibility) {
      lines.push(
        `  证据状态: ${facts.eligibility}${facts.eligibilityReason ? ` — ${facts.eligibilityReason}` : ""}`,
      );
    }
    if (facts.mergeCommit) {
      lines.push(
        `  已记录合并: commit ${facts.mergeCommit}${facts.prNumber !== undefined ? ` (PR #${facts.prNumber})` : ""}`,
      );
    }
    lines.push("");

    const apply = facts.patchPath
      ? `cd ${root} && git apply --3way ${facts.patchPath}`
      : `# 该 lane 没有 patch 文件，改动可能仍在 ${facts.worktree ?? "<worktree>"} 里，人工核对`;
    plans.push(
      [
        `# lane ${facts.runId}`,
        `1. 复核状态: subagent({ action: "lane.status", options: { laneId: "${facts.runId}", handoffPath: "${facts.handoffPath}" } })`,
        `2. 取回改动: ${apply}`,
        "3. 审计改动并跑受影响范围的最小充分检查，然后 commit（主会话的 worktree 里）",
        `4. 记录证据: subagent({ action: "lane.recordMerge", options: { laneId: "${facts.runId}", handoffPath: "${facts.handoffPath}", merge: { prNumber: <n>, reviewedHead: "<sha>", mergeCommit: "<sha>", treeEquivalent: true, postMergeChecks: "recorded", attestedBy: "operator", attestedAt: "<iso>" } } })`,
        `5. 清理: subagent({ action: "worktree.cleanup", options: { repo: "${root}", mode: "plan" } }) → 核对后 mode: "apply"`,
      ].join("\n"),
    );
  }

  lines.push("合并计划（主会话执行，本命令不会自动合并、不会删除 worktree）：", "", ...plans);
  return lines.join("\n");
}

/** The checkout whose `.trellis/` state a command should read. */
function resolveRootsFor(runtime: RuntimeContext, ctx: any): string {
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd;
  return mainCheckout(repoRoot(cwd));
}

/** Register `/Coworkflow:lanes`; idempotent, since a session may activate twice. */
function registerLanesCommand(host: PiRuntimeHost, runtime: RuntimeContext): void {
  if (lanesCommandRegistered) return;
  lanesCommandRegistered = true;

  host.registerCommand?.("Coworkflow:lanes", {
    description:
      "列出当前 Trellis 任务的 lane（worktree 隔离派单）状态、patch 路径与合并计划；不改动任何东西",
    handler: (_args: string, ctx: any) => {
      runtime.refresh();
      if (!runtime.enabled) {
        const message = "本会话未加载 Coworkflow：先运行 /Coworkflow:start";
        try {
          host.sendMessage?.({ customType: "pi-Coworkflow", content: message, display: true });
        } catch {
          ctx?.ui?.notify?.(message, "warning");
        }
        if (ctx?.mode !== "tui") {
          try {
            console.error(message);
          } catch {
            // stderr unavailable.
          }
        }
        return;
      }
      const root = resolveRootsFor(runtime, ctx);
      const taskDir = activeTaskDir(root, sessionIdOf(ctx, runtime));
      const text = taskDir
        ? renderLanes(root, taskDir, readLaneRecords(root, taskDir))
        : `当前会话没有活跃 Trellis 任务（${root}），无法定位 lane 记录。`;
      try {
        host.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
      } catch {
        ctx?.ui?.notify?.(text, "info");
      }
      if (ctx?.mode !== "tui") {
        try {
          console.error(text);
        } catch {
          // stderr unavailable.
        }
      }
    },
  });
}

let lanesCommandRegistered = false;

export const laneWorktreeModule: WorkflowModule = {
  id: "lane-worktree",
  title: "lane 账目与合并计划（worktree 隔离的派单）",

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;

    // Recording is gated on the project being adopted, not on this session having
    // run `/Coworkflow:start`: a lane dispatched from a session that had not loaded
    // the layer still produced artifacts, and leaving it out of the ledger is how
    // `/Coworkflow:lanes` silently under-reports. The shared ledger applies that
    // rule once; this module only turns a recorded result into a pointer.
    const ledger = attachLedger(host, runtime);

    ledger.onResult((dispatch, event, ctx) => {
      const handoffPath = extractHandoffPath(event);
      if (!handoffPath) return;

      const root = resolveRootsFor(runtime, ctx);
      const sessionId = sessionIdOf(ctx, runtime);
      const taskDir = activeTaskDir(root, sessionId);
      if (!taskDir) return;

      const runId = runIdFromHandoffPath(handoffPath);
      // Bind the run id back onto the dispatch, so a later completion or failure
      // notification can be traced to the call that started it.
      ledger.bindRun(dispatch.callId, runId);

      const record: LaneRecord = {
        version: 1,
        runId,
        ...(dispatch.agent ? { agent: dispatch.agent } : {}),
        handoffPath,
        taskRef: taskRefForDisplay(root, taskDir),
        ...(sessionId ? { sessionId } : {}),
        recordedAt: new Date().toISOString(),
      };
      try {
        const dir = laneDir(root, taskDir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${record.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      } catch {
        // Losing a pointer must never break the tool result the model reads.
      }
    });

    if (runtime.enabled) registerLanesCommand(host, runtime);
  },

  /**
   * The lane command only exists while the session has Coworkflow loaded; the
   * recording hook above stays registered but does not depend on that.
   */
  onSessionActivate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;
    registerLanesCommand(host, runtime);
  },
};
