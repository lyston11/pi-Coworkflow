/** Trellis → native identity/artifact pointers. Native status remains upstream-owned. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { PiRuntimeHost, RuntimeContext, Unsubscribe, WorkflowModule } from "../../core/module.ts";
import { readConfig } from "../../core/config.ts";
import { activeTaskDir, laneDir, resolveTaskDir, taskRefForDisplay } from "../../core/trellis.ts";
import { decodeNativeCompletions, decodeNativeResult, mergeNativeChildren, readNativeHandoff,
  readNativeWorkflowReceipt, type NativeChild, type NativeResult } from "../../core/pi-subagents.ts";
import { resolveChildTask } from "../subagent-context/index.ts";
import { builtinKind, kindOf } from "../agent-kinds/defaults.ts";
import { planRun } from "../subagents/index.ts";
import { requestStop } from "../subagents/run-control.ts";
import { attachSubagents, elapsedLabel } from "../../core/subagents-client.ts";
import { readRunLink, readTaskLinks, recordLaunchLink, type NativeRunLink } from "../../core/subagents-workflow.ts";

const NS = "Coworkflow";
const MAX_DISPLAY = 20;
/**
 * One dispatch that was attributed to a task.
 *
 * `kind` is read from the dispatch itself, at `tool_call` time: it is the only
 * moment the caller's own agent choice is observable, and a value reconstructed
 * afterwards from a session name or `results[]` would be a guess about which of
 * several children was ours.
 */
interface Target { root: string; taskRef: string; sessionId?: string; kind?: string; agent?: string; goal?: string }

/** How much of a dispatch's own task text is kept as its recorded goal. */
const MAX_GOAL = 120;
/** A goal long enough to crowd a lane line is cut with a visible ellipsis. */
function goalText(task: string): string | undefined {
  // One line, because a lane line is one line: the task text of a real dispatch is
  // multi-line prose, and pasting it whole would bury every other run.
  const flat = task.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > MAX_GOAL ? `${flat.slice(0, MAX_GOAL - 1)}…` : flat;
}
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

/**
 * The configuration root for this state, from the runtime's resolver.
 *
 * Every lane hook used to call `configRoot(cwd)` itself, which spawns `git`; the
 * resolver is keyed on cwd and epoch, so repeated reads in one session cost
 * nothing and an unresolvable root reads as "no config" instead of as the cwd.
 */
function configRootOf(state: State): string | null {
  return state.runtime.configRoots.root(state.runtime.cwd);
}
function enabled(state: State): boolean {
  const rt = state.runtime;
  // Passive artifact adoption is project-gated; it does not require /start.
  if (state.closed || rt.isChild || !rt.control.moduleEnabled("lane-worktree")) return false;
  const root = configRootOf(state);
  return root !== null && readConfig(root) !== null;
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

/**
 * `/Coworkflow:lanes` arguments: a task reference (the default form), or a stop
 * request naming one run.
 *
 * Everything except the stop form leaves the command read-only. The stop form is
 * parsed here rather than by splitting on whitespace at the call site, because a
 * task reference is free-form text and must keep working unchanged.
 */
export function parseLanesArgs(args: string): { taskRef: string; stop?: string } | { error: string } {
  const trimmed = args.trim();
  const match = /^stop(?:\s+(.*))?$/i.exec(trimmed);
  if (match === null) return { taskRef: trimmed };
  const runId = (match[1] ?? "").trim();
  if (!runId) {
    return { error: "用法：/Coworkflow:lanes stop <runId>；runId 不能为空。先用 /Coworkflow:lanes 查看本任务记录过的 run。" };
  }
  if (/\s/.test(runId)) return { error: `runId 不能包含空白字符：${runId}` };
  return { taskRef: "", stop: runId };
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
      const root = configRootOf(current);
      if (root === null) return;
      const task = typeof input.task === "string" ? input.task : "";
      const explicit = resolveChildTask(root, undefined, task);
      // An explicit invalid reference cannot silently adopt a different active task.
      const taskDir = explicit.kind === "task" ? explicit.dir : explicit.kind === "invalid" || /Active task:/i.test(task) ? null :
        activeTaskDir(root, current.runtime.sessionId);
      if (!taskDir) return;
      const taskRef = taskRefForDisplay(root, taskDir);
      if (taskRef) {
        // A kind this package ships is recorded; any other agent (a builtin,
        // another extension's, a `cw-` name we do not ship) has no kind, which is
        // a different fact from "kind unknown" and is stored as absence.
        const kind = kindOf(typeof input.agent === "string" ? input.agent : undefined);
        // The agent name and the goal are what *we* sent: recorded here, at the one
        // moment the caller's own choice is observable, and never reconstructed from
        // the runner afterwards.
        const agent = typeof input.agent === "string" && input.agent.trim() ? input.agent.trim() : undefined;
        const goal = goalText(task);
        current.calls.set(event.toolCallId, {
          root,
          taskRef,
          sessionId: current.runtime.sessionId ?? undefined,
          ...(kind === null ? {} : { kind }),
          ...(agent === undefined ? {} : { agent }),
          ...(goal === undefined ? {} : { goal }),
        });
      }
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
        ...(target.kind ? { kind: target.kind } : {}),
        ...(target.agent ? { agent: target.agent } : {}),
        ...(target.goal ? { goal: target.goal } : {}),
        ...(result.missionId ? { missionId: result.missionId } : {}),
        ...(result.handoffPath ? { handoffPath: result.handoffPath } : {}),
        ...(result.workflowReceiptPath ? { workflowReceiptPath: result.workflowReceiptPath } : {}),
      });
      // A correlated call already knows its root; anything else needs one, and an
      // unresolved root means there is no project to record into.
      const root = target?.root ?? configRootOf(current);
      if (root === null) return;
      adoptResult(current, root, result);
    });
    listen("message_end", (event) => {
      if (!enabled(current)) return;
      resetEpoch(current);
      const root = configRootOf(current);
      if (root === null) return;
      for (const result of decodeNativeCompletions(event?.message)) adoptResult(current, root, result);
    });
  },
  onSessionActivate(host, runtime) {
    const state = STATES.get(host);
    if (!state || state.commandRegistered || runtime.isChild || !host.registerCommand) return;
    state.commandRegistered = true;
    host.registerCommand(`${NS}:lanes`, {
      description: "查看当前任务的原生子 run 与交接/补丁；`/Coworkflow:lanes stop <runId>` 请求停止一个本任务记录过的 run（接受≠终止）；最终验收和合并仍由主会话决定",
      handler: async (args, ctx) => {
        runtime.refresh();
        const say = (text: string) => host.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
        if (!runtime.enabled || !enabled(state)) { say(`本会话未加载或 lane-worktree 已关闭；先 /${NS}:start 并启用该模块。`); return; }
        resetEpoch(state);
        const epoch = runtime.sessionEpoch;
        const parsed = parseLanesArgs(args);
        if ("error" in parsed) { say(parsed.error); return; }
        // The command's own cwd may be a worktree: the resolver returns the main
        // checkout for it, or null when git could not answer.
        const root = runtime.configRoots.root(typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd);
        if (root === null) { say("配置根无法解析（git 读取失败）：不读取任何项目的 lane 记录。"); return; }
        const taskDir = parsed.taskRef ? resolveTaskDir(root, parsed.taskRef) : activeTaskDir(root, runtime.sessionId);
        if (!taskDir) { say("没有可解析的任务；可传入 .trellis/tasks/<name>。"); return; }
        const taskRef = taskRefForDisplay(root, taskDir) ?? taskDir;
        if (parsed.stop !== undefined) {
          // Only a run this task recorded may be stopped: an arbitrary id would let
          // this command act on work that belongs to another task or session.
          const link = readRunLink(root, parsed.stop);
          const recorded = link !== undefined && link.taskRef === taskRef;
          if (!recorded) {
            say([
              `run ${parsed.stop} 不是任务 ${taskRef} 记录过的 run：本命令只停止自己记录过的 run，不接受任意 id。`,
              ...(link === undefined ? [] : [`该 run 记录在任务 ${link.taskRef} 下。`]),
              "用 /Coworkflow:lanes 查看本任务记录过的 run id。",
            ].join("\n"));
            return;
          }
          if (link.sessionId !== undefined && link.sessionId !== runtime.sessionId) {
            // pi-subagents 只停止当前会话的 run；先本地说清，而不是发一个必然被拒的请求。
            say([
              `run ${parsed.stop} 属于会话 ${link.sessionId.slice(0, 8)}，不是当前会话：pi-subagents 的 stop 只接受当前会话的 run。`,
              "未发出任何停止请求。",
            ].join("\n"));
            return;
          }
          const report = await requestStop(host, runtime, parsed.stop);
          say([`任务: ${taskRef}`, "", ...report.lines].join("\n"));
          return;
        }
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
        const integration = planRun(root, parsed.taskRef || null, taskDir);
        // The exit block is a report: planRun already validated the worktree, and
        // everything below is a git read. Nothing here merges, archives or removes.
        const lines = [`任务: ${taskRef}`, ...exitState(root, taskRef, integration)];
        if (!links.length) lines.push("尚未记录原生 run；已有 legacy lane 文件保持原样。");
        // A grouping line, not a second listing: which kinds this task's runs were
        // dispatched as, and how many each. Grouped only by the recorded kind, so
        // a run without one is counted as such instead of being attributed.
        const byKind = new Map<string, number>();
        for (const link of links) byKind.set(link.kind ?? "", (byKind.get(link.kind ?? "") ?? 0) + 1);
        if (byKind.size > 0) {
          lines.push(`按 kind 分组: ${[...byKind.entries()]
            .map(([kind, count]) => `${kind ? kindLabel(kind) : "非 kind 派单"} ×${count}`)
            .join(" · ")}`);
        }
        if (readTaskLinks(root, taskRef).length > MAX_DISPLAY) lines.push(`仅显示最近 ${MAX_DISPLAY} 个 run。`);
        const now = Date.now();
        for (const link of links) {
          const observation = state.observations.get(link.runId);
          // Only a run id from the snapshot is attributable; the fleet window has
          // opaque display keys and is never joined to a run here.
          const nativeRun = link.sessionId === runtime.sessionId && activity?.kind === "known"
            ? activity.runs.find((run) => run.id === link.runId) : undefined;
          const nativeState = nativeRun?.state;
          // The kind is on the line itself, so a run is attributable without
          // cross-referencing anything: `[kind]` is absent for a dispatch that was
          // not one of this package's kinds, which is a fact, not a gap.
          //
          // Agent, elapsed and goal are printed only when they are known, and each
          // comes from a named source: the runner's own snapshot, or this package's
          // record of what it dispatched. A field nothing can answer is absent, not
          // `0s` and not a guess.
          const agent = nativeRun?.agent ?? link.agent;
          const elapsed = elapsedLabel(nativeRun?.startedAt, now);
          lines.push("", `- run ${link.runId}${agent === undefined ? "" : ` · ${agent}${nativeRun?.agent ? "" : "（本包派单记录）"}`} [${
            observation?.status ?? nativeState ?? "未知"}]${elapsed === undefined ? "" : ` · ${elapsed}`}${
            link.kind ? ` · kind ${kindLabel(link.kind)}` : ""}`,
            ...(link.goal ? [`  目标（本包派单记录）: ${link.goal}`] : []),
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

/** `执行者（executor）`, or the bare kind for one this build does not ship. */
function kindLabel(kind: string): string {
  const label = builtinKind(kind)?.label;
  return label === undefined ? kind : `${label}（${kind}）`;
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

function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** A read-only git probe: `null` means git could not answer, never "no". */
function gitProbe(cwd: string, args: string[]): { code: number; out: string } | null {
  try {
    return { code: 0, out: execFileSync("git", ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    const code = (error as { status?: unknown }).status;
    return typeof code === "number" ? { code, out: "" } : null;
  }
}

/** The task identity fields the exit check needs; `planRun` remains the validator. */
function readExitRecord(root: string, taskRef: string): { branch: string | null; base: string } {
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim().replace(/^refs\/heads\//, "") : null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, taskRef, "task.json"), "utf8"));
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    return { branch: read(record.branch), base: read(record.base_branch) ?? "main" };
  } catch {
    return { branch: null, base: "main" };
  }
}

/**
 * Report whether the task can be closed out, and only then how.
 *
 * The merge/archive/worktree rules exist otherwise only in prose, so an abandoned
 * task worktree stays invisible. A cleanup command is printed only when the branch
 * is merged into its base *and* the validated worktree has no uncommitted change;
 * otherwise the failing precondition is named and no command is printed. Never a
 * forced removal: an unfinished task is a decision for the human, not a flag.
 */
function exitState(root: string, taskRef: string, integration: ReturnType<typeof planRun>): string[] {
  const record = readExitRecord(root, taskRef);
  const repo = integration.ok ? integration.mainCheckout : root;
  const lines = ["", "任务退出状态（只读检查：本命令不合并、不归档、不删除任何东西）："];
  const failed: string[] = [];
  let merged: boolean | null = null;
  if (record.branch === null) {
    lines.push("- 分支: task.json 没有记录 branch，无法判断合并状态");
    failed.push("task.json 缺少 branch");
  } else {
    const probe = gitProbe(repo, ["merge-base", "--is-ancestor", record.branch, record.base]);
    merged = probe === null ? null : probe.code === 0 ? true : probe.code === 1 ? false : null;
    const counted = gitProbe(repo, ["rev-list", "--count", `${record.base}..${record.branch}`]);
    const ahead = counted?.code === 0 && /^\d+$/.test(counted.out) ? Number(counted.out) : null;
    if (merged === true) lines.push(`- 分支 ${record.branch}: 已合并进 ${record.base}（领先 ${ahead ?? "?"} 个提交）`);
    else if (merged === false) {
      lines.push(`- 分支 ${record.branch}: 尚未合并进 ${record.base}（还领先 ${ahead ?? "?"} 个提交）`);
      failed.push(`分支 ${record.branch} 未合并进 ${record.base}（领先 ${ahead ?? "?"} 个提交）`);
    } else {
      lines.push(`- 分支 ${record.branch}: 与 ${record.base} 的合并状态无法判定（git 读取失败）`);
      failed.push(`无法判定 ${record.branch} 是否已合并进 ${record.base}`);
    }
  }
  let worktree: string | null = null;
  if (integration.ok) {
    worktree = integration.worktree;
    lines.push(`- worktree: ${integration.worktree} 存在，且是该仓库已注册的任务 worktree`);
    const status = gitProbe(integration.worktree, ["status", "--porcelain", "--untracked-files=normal"]);
    const entries = status?.code === 0 ? status.out.split("\n").filter(Boolean) : null;
    if (entries === null) {
      lines.push("- 工作树状态: 无法读取（git status 失败）");
      failed.push("无法读取工作树的未提交改动");
    } else if (entries.length === 0) {
      lines.push("- 工作树状态: 干净，没有未提交的改动");
    } else {
      lines.push(`- 工作树状态: ${entries.length} 处未提交改动（未跟踪但被忽略的文件不计）`,
        ...entries.slice(0, 5).map((entry) => `    ${entry}`),
        ...(entries.length > 5 ? [`    …… 其余 ${entries.length - 5} 项`] : []));
      failed.push(`工作树有 ${entries.length} 处未提交改动`);
    }
  } else {
    lines.push(`- worktree: 未满足前提 —— ${integration.message}`);
    failed.push("任务 worktree 前提未满足");
    if (merged === false) failed.push(`分支 ${record.branch} 未合并进 ${record.base}`);
  }
  if (failed.length === 0 && worktree !== null && record.branch !== null) {
    lines.push("", "清理命令（前提已满足: 分支已合并且工作树干净；逐条执行并复核结果）:",
      `  git -C ${quote(repo)} worktree remove ${quote(worktree)}`,
      `  git -C ${quote(repo)} branch -d ${quote(record.branch)}`);
  } else {
    lines.push("", `不提供清理命令: 前提未满足 —— ${failed.join("；")}。保留现场并先解决上述项，不以强制方式掩盖未完成的工作。`);
  }
  return lines;
}

function mergePlan(root: string, integration: ReturnType<typeof planRun>, runId: string, handoffPath: string, children: NativeChild[]): string[] {
  const target = { laneId: runId, handoffPath };
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
