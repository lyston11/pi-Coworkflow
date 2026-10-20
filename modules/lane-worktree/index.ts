/** Trellis → native identity/artifact pointers. Native status remains upstream-owned. */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PiRuntimeHost, RuntimeContext, Unsubscribe, WorkflowModule } from "../../core/module.ts";
import { configRoot, readConfig } from "../../core/config.ts";
import { activeTaskDir, laneDir, repoRoot, resolveTaskDir, taskRefForDisplay } from "../../core/trellis.ts";
import { decodeNativeCompletions, decodeNativeResult, mergeNativeChildren, readNativeHandoff,
  readNativeWorkflowReceipt, type NativeChild, type NativeResult } from "../../core/pi-subagents.ts";
import { resolveChildTask } from "../subagent-context/index.ts";
import { planRun } from "../subagents/index.ts";
import { attachSubagents } from "../../core/subagents-client.ts";
import { readRunLink, readTaskLinks, recordLaunchLink, type NativeRunLink } from "../../core/subagents-workflow.ts";

const NS = "Coworkflow";
const MAX_DISPLAY = 20;
interface Target { root: string; taskRef: string; sessionId?: string }
interface State {
  runtime: RuntimeContext;
  closed: boolean;
  epoch: number;
  calls: Map<string, Target>;
  observations: Map<string, NativeResult>;
  listeners: Map<string, Unsubscribe | void>;
  commandRegistered: boolean;
}
const STATES = new WeakMap<PiRuntimeHost, State>();

function enabled(state: State): boolean {
  const rt = state.runtime;
  // Passive artifact adoption is project-gated; it does not require /start.
  return !state.closed && !rt.isChild && rt.control.moduleEnabled("lane-worktree") &&
    readConfig(configRoot(rt.cwd)) !== null;
}
function resetEpoch(state: State): void {
  if (state.epoch === state.runtime.sessionEpoch) return;
  state.epoch = state.runtime.sessionEpoch;
  state.calls.clear();
  state.observations.clear();
}
function remember(state: State, result: NativeResult): void {
  const previous = state.observations.get(result.runId);
  const fields = Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
  state.observations.set(result.runId, { ...previous, ...fields, runId: result.runId,
    children: mergeNativeChildren(previous?.children ?? [], result.children) });
  if (state.observations.size > 200) state.observations.delete(state.observations.keys().next().value!);
}
function adoptResult(state: State, root: string, result: NativeResult): void {
  const link = readRunLink(root, result.runId);
  if (!link) return;
  remember(state, result);
  if ((result.handoffPath && result.handoffPath !== link.handoffPath) ||
      (result.workflowReceiptPath && result.workflowReceiptPath !== link.workflowReceiptPath)) {
    recordLaunchLink(root, { ...link,
      ...(result.handoffPath ? { handoffPath: result.handoffPath } : {}),
      ...(result.workflowReceiptPath ? { workflowReceiptPath: result.workflowReceiptPath } : {}),
    });
  }
}

export const laneWorktreeModule: WorkflowModule = {
  id: "lane-worktree",
  title: "Lane worktree（原生身份与交接指针）",
  activate(host, runtime) {
    if (runtime.isChild || !host.on) return;
    let state = STATES.get(host);
    if (!state) {
      state = { runtime, closed: false, epoch: runtime.sessionEpoch, calls: new Map(), observations: new Map(),
        listeners: new Map(), commandRegistered: false };
      STATES.set(host, state);
    }
    state.runtime = runtime;
    state.closed = false;
    resetEpoch(state);
    const current = state;
    const listen = (name: string, handler: (event: any, ctx: any) => any) => {
      if (!current.listeners.has(name)) current.listeners.set(name, host.on!(name, handler));
    };
    listen("tool_call", (event) => {
      if (!enabled(current) || event?.toolName !== "subagent") return;
      resetEpoch(current);
      const input = event.input;
      if (!input || typeof input !== "object" || (input.action && input.action !== "resume" && input.action !== "append-step")) return;
      if (typeof event.toolCallId !== "string") return;
      const root = configRoot(repoRoot(current.runtime.cwd));
      const task = typeof input.task === "string" ? input.task : "";
      const explicit = resolveChildTask(root, undefined, task);
      // An explicit invalid reference cannot silently adopt a different active task.
      const taskDir = explicit.kind === "task" ? explicit.dir : explicit.kind === "invalid" || /Active task:/i.test(task) ? null :
        activeTaskDir(root, current.runtime.sessionId);
      if (!taskDir) return;
      const taskRef = taskRefForDisplay(root, taskDir);
      if (taskRef) current.calls.set(event.toolCallId, { root, taskRef, sessionId: current.runtime.sessionId ?? undefined });
      // A blocked call from another extension may have no result. This is transient
      // correlation only; dropping old entries loses no persisted native identity.
      if (current.calls.size > 200) current.calls.delete(current.calls.keys().next().value!);
    });
    listen("tool_result", (event) => {
      if (event?.toolName !== "subagent") return;
      resetEpoch(current);
      const target = current.calls.get(event.toolCallId);
      current.calls.delete(event.toolCallId);
      if (!enabled(current)) return;
      resetEpoch(current);
      const result = decodeNativeResult(event.details);
      if (!result) return;
      if (target && event.isError !== true) recordLaunchLink(target.root, { taskRef: target.taskRef, sessionId: target.sessionId, runId: result.runId,
        ...(result.missionId ? { missionId: result.missionId } : {}),
        ...(result.handoffPath ? { handoffPath: result.handoffPath } : {}),
        ...(result.workflowReceiptPath ? { workflowReceiptPath: result.workflowReceiptPath } : {}),
      });
      adoptResult(current, target?.root ?? configRoot(current.runtime.cwd), result);
    });
    listen("message_end", (event) => {
      if (!enabled(current)) return;
      resetEpoch(current);
      const root = configRoot(current.runtime.cwd);
      for (const result of decodeNativeCompletions(event?.message)) adoptResult(current, root, result);
    });
  },
  onSessionActivate(host, runtime) {
    const state = STATES.get(host);
    if (!state || state.commandRegistered || runtime.isChild || !host.registerCommand) return;
    state.commandRegistered = true;
    host.registerCommand(`${NS}:lanes`, {
      description: "查看当前任务的原生子 run 与交接/补丁；最终验收和合并仍由主会话决定",
      handler: async (args, ctx) => {
        runtime.refresh();
        const say = (text: string) => host.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
        if (!runtime.enabled || !enabled(state)) { say(`本会话未加载或 lane-worktree 已关闭；先 /${NS}:start 并启用该模块。`); return; }
        resetEpoch(state);
        const epoch = runtime.sessionEpoch;
        const root = configRoot(repoRoot(ctx.cwd));
        const taskDir = args.trim() ? resolveTaskDir(root, args.trim()) : activeTaskDir(root, runtime.sessionId);
        if (!taskDir) { say("没有可解析的任务；可传入 .trellis/tasks/<name>。"); return; }
        const taskRef = taskRefForDisplay(root, taskDir) ?? taskDir;
        let links = readTaskLinks(root, taskRef);
        const legacy = readLegacyPointers(root, taskDir);
        for (const pointer of legacy) if (!links.some((link) => link.runId === pointer.runId)) links.push({
          runId: pointer.runId, taskRef, handoffPath: pointer.handoffPath, recordedAt: "legacy",
        });
        const shown = links.slice(-MAX_DISPLAY);
        const bridge = attachSubagents(host, { epoch, events: host.events });
        const activity = shown.length ? await bridge.observe() : null;
        // Only current-session links are queried: RPC status is session-scoped.
        await Promise.all(shown.filter((link) => link.sessionId === runtime.sessionId).map(async (link) => {
          const response = await bridge.client.status({ id: link.runId });
          if (!response.ok || state.closed || runtime.sessionEpoch !== epoch || !enabled(state)) return;
          const result = decodeNativeResult(response.data.details);
          if (result?.runId === link.runId) adoptResult(state, root, result);
        }));
        if (state.closed || runtime.sessionEpoch !== epoch || !runtime.enabled || !enabled(state)) return;
        links = shown.map((link) => readRunLink(root, link.runId) ?? link);
        const integration = planRun(root, args.trim() || null, taskDir);
        const lines = [`任务: ${taskRef}`];
        if (!links.length) lines.push("尚未记录原生 run；已有 legacy lane 文件保持原样。");
        if (readTaskLinks(root, taskRef).length > MAX_DISPLAY) lines.push(`仅显示最近 ${MAX_DISPLAY} 个 run。`);
        for (const link of links) {
          const observation = state.observations.get(link.runId);
          const nativeState = link.sessionId === runtime.sessionId && activity?.kind === "known"
            ? activity.runs.find((run) => run.id === link.runId)?.state : undefined;
          lines.push("", `- run ${link.runId} [${observation?.status ?? nativeState ?? "未知"}]`,
            ...(link.missionId ? [`  mission: ${link.missionId}`] : []),
            ...(link.worktree ? [`  worktree: ${shortPath(root, link.worktree)}`] : []));
          const handoffRef = observation?.handoffPath ?? link.handoffPath;
          const receiptRef = observation?.workflowReceiptPath ?? link.workflowReceiptPath;
          // Artifact references keep their original root even when apply targets another tree.
          const handoffPath = handoffRef ? resolve(root, handoffRef) : undefined;
          const receiptPath = receiptRef ? resolve(root, receiptRef) : undefined;
          if (handoffPath) lines.push(`  handoff: ${shortPath(root, handoffPath)}`);
          if (receiptPath) lines.push(`  receipt: ${shortPath(root, receiptPath)}`);
          const handoff = handoffPath ? readNativeHandoff(handoffPath, link.runId) : null;
          if (handoff?.eligibility) lines.push(`  证据状态: ${handoff.eligibility}${handoff.eligibilityReason ? ` — ${handoff.eligibilityReason}` : ""}`);
          if (handoff?.mergeCommit) lines.push(`  已记录合并: commit ${handoff.mergeCommit}${handoff.prNumber === undefined ? "" : ` (PR #${handoff.prNumber})`}`);
          if (handoffPath && !handoff) lines.push("  patch: manifest 不可读或身份不匹配（可能已被保留策略清理）");
          const children = mergeNativeChildren(
            receiptPath ? readNativeWorkflowReceipt(receiptPath, link.runId) : [],
            handoff?.children ?? [], observation?.children ?? []);
          for (const child of children) lines.push(...renderChild(root, link.runId, child));
          if (handoffPath) lines.push(...mergePlan(root, integration, link.runId, handoffPath, children));
        }
        say(lines.join("\n"));
      },
    });
  },
  onSessionEnd(host) {
    const state = STATES.get(host);
    if (!state) return;
    state.closed = true;
    state.calls.clear(); state.observations.clear(); state.commandRegistered = false;
    for (const [name, off] of state.listeners) if (typeof off === "function") { off(); state.listeners.delete(name); }
  },
  apply(ctx) { ctx.report("ok", `通过公开 result/completion 关联 task 与 run；/${NS}:lanes 展示每个子项的状态和交接补丁，不复制上游生命周期。`); },
  remove(ctx) { ctx.report("ok", "停止 lane 观察；已有 task/native 链接及 legacy lane 文件保留"); },
};

function shortPath(root: string, path: string): string {
  const rel = relative(root, resolve(root, path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
function renderChild(root: string, parent: string, child: NativeChild): string[] {
  const identity = child.runId ?? `${parent} / index ${child.index}${child.stepIndex === undefined ? "" : ` / step ${child.stepIndex}`}`;
  return [`  - ${identity}${child.workflowKey ? ` (${child.workflowKey})` : ""} · ${child.agent ?? "?"} [${child.status ?? "未知"}]`,
    ...(child.outputPath ? [`    output: ${shortPath(root, child.outputPath)}`] : []),
    ...(child.branch ? [`    branch: ${child.branch}`] : []),
    ...(child.worktreePath ? [`    worktree: ${shortPath(root, child.worktreePath)}`] : []),
    ...(child.patchPath ? [`    patch: ${shortPath(root, child.patchPath)}${child.diffStat ? ` (${child.diffStat})` : child.filesChanged === undefined ? "" : ` (${child.filesChanged} files)`}`] : ["    patch: 未提供"])];
}

/** Existing per-run pointers remain readable in their original task runtime directory. */
function readLegacyPointers(root: string, taskDir: string): { runId: string; handoffPath: string }[] {
  const dir = laneDir(root, taskDir);
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().slice(-200).flatMap((name) => {
      try {
        const row: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (!row || typeof row !== "object") return [];
        const link = row as Record<string, unknown>;
        return typeof link.runId === "string" && typeof link.handoffPath === "string" &&
          link.taskRef === taskRefForDisplay(root, taskDir) ? [{ runId: link.runId, handoffPath: link.handoffPath }] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function mergePlan(root: string, integration: ReturnType<typeof planRun>, runId: string, handoffPath: string, children: NativeChild[]): string[] {
  const target = { laneId: runId, handoffPath };
  const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
  return ["", "合并计划（主会话复核后执行；本命令不自动合并或清理）：",
    `1. 复核状态: subagent(${JSON.stringify({ action: "lane.status", options: target })})`,
    ...(integration.ok ? [`集成目标（任务 worktree）: ${integration.worktree}`]
      : [`缺少已验证的任务集成 worktree，暂不提供补丁应用命令：${integration.message}`]),
    ...children.map((child) => child.patchPath
      ? integration.ok
        ? `2. 取回 ${child.runId ?? `index ${child.index}`} 的改动: cd ${quote(integration.worktree)} && git apply --3way ${quote(resolve(root, child.patchPath))}`
        : `2. ${child.runId ?? `index ${child.index}`} 的 patch 保留供复核: ${resolve(root, child.patchPath)}`
      : `2. ${child.runId ?? `index ${child.index}`} 没有 patch；人工核对 ${child.worktreePath ?? "原生交接"}`),
    integration.ok
      ? "3. 审计改动并跑受影响范围的最小充分检查，然后在上述任务集成 worktree 里 commit。"
      : "3. 继续复核交接与改动证据；先修复任务 worktree 前提，再重新生成合并计划。",
    `4. 合并后记录证据: subagent({ action: "lane.recordMerge", options: { ...${JSON.stringify(target)}, merge: { prNumber: <n>, reviewedHead: "<sha>", mergeCommit: "<sha>", treeEquivalent: true, postMergeChecks: "recorded", attestedBy: "operator", attestedAt: "<iso>" } } })`,
    `5. 清理计划: subagent(${JSON.stringify({ action: "worktree.cleanup", options: { repo: root, handoffPath, mode: "plan" } })})；核对后依上游计划执行 apply。`];
}
