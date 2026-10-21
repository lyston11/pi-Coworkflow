/**
 * The Trellis implement → review workflow, as a pi-subagents workflow resource.
 *
 * The point of a *named* resource instead of a raw script is provenance: the host
 * resolves the name against this extension's registered definition, validates
 * bounded plain-JSON args, and records resource provenance on the run. A raw
 * script would also work, but then the workflow content would be whatever the
 * caller typed, and "this package guarantees a fresh implement/review pair" would
 * be a claim about the model's memory rather than about code.
 *
 * Two contracts are load-bearing here:
 *
 *   - **`resolve` is synchronous, bounded, and free of I/O.** It validates the
 *     public args against host-prepared task/worktree context and returns script
 *     text. The host revalidates that context before commands and tool calls.
 *   - **Expansion is explicit.** Two stable child keys (`implement`, `review`),
 *     each with a `cwd` taken from the validated worktree (not from wherever the
 *     caller happens to be), fresh context, and a structured verdict. A negative
 *     or malformed verdict throws, so the workflow *fails* instead of returning a
 *     green result that means nothing.
 *
 * Registration follows pi-subagents' documented lifecycle: register on
 * `session_start` with `ctx.sessionManager.getSessionId()`, dispose before
 * replacing, dispose on `session_shutdown`. This module owns that lifecycle
 * because `pi-subagents` deliberately does not manage it for the extension.
 *
 * A separately installed Pi package is not a Node dependency of this package, so
 * the two subpaths are resolved from the *installed* pi-subagents package
 * directory and imported by file URL. That imports the small documented subpath
 * module, not the main extension, so no second runtime is loaded.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { subagentsPackageDir } from "./pi-subagents.ts";
import { summarizeOverlap, type DispatchInterval, type OverlapSummary } from "./dispatch-timing.ts";
import {
  BUILTIN_KINDS,
  agentNameFor,
  builtinKind,
  disabledKindMessage,
  unregisteredKindMessage,
  type FanoutKindPolicy,
} from "../modules/agent-kinds/defaults.ts";

export const WORKFLOW_NAME = "coworkflow.implement-review";
export const WORKFLOW_VERSION = 1;
/**
 * The independent-children workflow.
 *
 * "Run these N things" is the common case and the one this layer kept getting
 * wrong: a hand-written script that awaits `runs.run` in a loop is serial, gives
 * no signal that it was serial, and costs the sum of its children's runtimes. As a
 * registered resource, the concurrency is a property of *this package's code*
 * rather than a property of whoever wrote the script that day.
 */
export const FANOUT_NAME = "coworkflow.fanout";
export const FANOUT_VERSION = 1;
/** The two stable child keys; a rerun reuses nothing, they are identity for the mission ledger. */
export const IMPLEMENT_KEY = "implement";
export const REVIEW_KEY = "review";
export const DEFAULT_IMPLEMENT_AGENT = "trellis-implement";
export const DEFAULT_REVIEW_AGENT = "trellis-check";

const MAX_TASK_REF = 200;
const MAX_FOCUS = 2000;
const MAX_TITLE = 300;
const MAX_AGENT = 96;
/** A fanout stays small enough that its children are genuinely independent work. */
const MAX_FANOUT_TASKS = 8;
const MAX_FANOUT_TASK = 8000;
const FANOUT_ENTRY_FIELDS = ["kind", "task"] as const;
/** How much child output a later step may embed before it becomes a pointer only. */
const EMBED_LIMIT = 60_000;

const TASK_REF_RE = /^\.trellis\/tasks\/[A-Za-z0-9._-]+$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Created by the host's Git/task checks, never from workflow args. */
export interface PreparedWorkflowContext {
  taskRef: string;
  worktree: string;
  mainCheckout: string;
  title?: string;
  /**
   * A registered kind standing in for the `implement` step (`cw-executor`), when
   * the project has one.
   *
   * The fixed workflow then runs the same two steps with the agents the project
   * actually dispatches, so a kind's enablement governs this path too — and the
   * child's role context still comes from the one mapping, because
   * `subagent-context` resolves `cw-executor` to `implement`.
   */
  implementAgent?: string;
  /** A registered kind standing in for the `review` step (`cw-auditor`). */
  reviewAgent?: string;
}

export type Expansion = { script: string } | { error: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function validTaskRef(value: string): boolean {
  return value.length <= MAX_TASK_REF && TASK_REF_RE.test(value) && ![".", ".."].includes(value.split("/").pop()!);
}

/** One independent child of `coworkflow.fanout`, already validated and keyed. */
export interface FanoutChild {
  key: string;
  /** The project-facing kind, e.g. `executor`. */
  kind: string;
  /** The agent that kind resolves to, e.g. `cw-executor`. */
  agent: string;
  task: string;
}

/**
 * How a fanout task may be dispatched: the kind policies the host resolved in
 * memory, plus the refusals those policies produce.
 *
 * The resolver stays pure. It cannot read the project config (I/O) or the owner's
 * registry (also I/O), so the host resolves the project's kind policy at gate time
 * and hands the answer over. A task whose kind is absent from `kinds` is a kind
 * this package does not ship, which is a different error from a disabled one.
 */
export interface FanoutPolicy {
  kinds: readonly FanoutKindPolicy[];
  /** The exact reason the kind policy could not be read, when it could not. */
  unavailable?: string;
}

/**
 * Validate and expand `coworkflow.fanout`.
 *
 * Same contract as `resolveImplementReview`: synchronous, bounded, no I/O, and the
 * caller cannot supply filesystem authority. The only host-owned input is the
 * verified worktree, used as the children's `cwd`; without it the children inherit
 * the workflow's own cwd, which the host also chose.
 *
 * A task names a **kind**, never an agent: one vocabulary, and the kind→agent
 * mapping stays where it already lives (`agentNameFor`), so a fanout child is the
 * same agent a direct kind dispatch would run.
 */
export function resolveFanout(
  args: Readonly<Record<string, unknown>>,
  prepared?: PreparedWorkflowContext | null,
  policy?: FanoutPolicy | null,
): Expansion {
  const allowed = new Set(["tasks", "focus"]);
  const unsupported = Object.keys(args).filter((key) => !allowed.has(key));
  if (unsupported.length) return { error: `workflow '${FANOUT_NAME}' args contain unsupported fields: ${unsupported.join(", ")}.` };
  const focus = args.focus === undefined ? undefined : str(args.focus);
  if (args.focus !== undefined && (!focus || focus.length > MAX_FOCUS)) return { error: `args.focus must contain 1–${MAX_FOCUS} characters.` };
  if (!Array.isArray(args.tasks)) return { error: `args.tasks must be an array of 1–${MAX_FANOUT_TASKS} { kind, task } objects.` };
  if (args.tasks.length < 1 || args.tasks.length > MAX_FANOUT_TASKS) {
    return { error: `args.tasks must contain 1–${MAX_FANOUT_TASKS} tasks (received ${args.tasks.length}).` };
  }
  const children: PlannedChild[] = [];
  for (let index = 0; index < args.tasks.length; index += 1) {
    const raw: unknown = args.tasks[index];
    const where = `args.tasks[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: `${where} must be a { kind, task } object.` };
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).filter((key) => !(FANOUT_ENTRY_FIELDS as readonly string[]).includes(key));
    if (extra.length) return { error: `${where} contains unsupported fields: ${extra.join(", ")}.` };
    const kind = str(entry.kind);
    if (!kind || kind.length > MAX_AGENT || !AGENT_RE.test(kind)) return { error: `${where}.kind must be a kind name this package ships.` };
    const task = typeof entry.task === "string" ? entry.task.trim() : "";
    if (!task || task.length > MAX_FANOUT_TASK) return { error: `${where}.task must contain 1–${MAX_FANOUT_TASK} characters.` };
    const shipped = fanoutKindOf(policy, kind);
    if (shipped === null) {
      return { error: `${where}.kind '${kind}' is not a kind this package ships; available kinds: ${shippedKinds(policy)}.` };
    }
    // The key comes from the position, never from caller text: two children may
    // legitimately be the same kind asking about different work, and upstream
    // rejects a duplicate key outright.
    children.push({
      key: `task-${index + 1}`, kind, agent: shipped.agent, task,
      refusal: shipped.dispatchable ? null : (shipped.refusal ?? defaultRefusal(policy, shipped)),
    });
  }
  return { script: buildFanoutScript({ children,
    ...(focus ? { focus } : {}), ...(prepared?.worktree ? { cwd: prepared.worktree } : {}) }) };
}

/** The policy entry for a kind this package ships, or `null` for any other name. */
function fanoutKindOf(policy: FanoutPolicy | null | undefined, kind: string): FanoutKindPolicy | null {
  // A declared kind the host did not resolve is still a kind this package ships;
  // whether it may dispatch is then answered by the host's own reason, never by a
  // guess made here.
  if (!policy) return builtinKind(kind) === null ? null : { kind, agent: agentNameFor(kind), dispatchable: true };
  return policy.kinds.find((entry) => entry.kind === kind) ?? null;
}

/** The kind policy could not be read: refuse, because "probably fine" is the old bug. */
function defaultRefusal(policy: FanoutPolicy | null | undefined, shipped: FanoutKindPolicy): string {
  return [
    `无法确认 kind ${shipped.kind}（${shipped.agent}）现在是否可以派单：${policy?.unavailable ?? "本包没有给出该 kind 的策略"}。`,
    "为避免把已关闭的 kind 当成可用，这个任务被拒绝；其他任务不受影响。",
  ].join("");
}

/** The kinds a caller may name, for an error that is actionable. */
function shippedKinds(policy: FanoutPolicy | null | undefined): string {
  const kinds = policy ? policy.kinds.map((entry) => entry.kind) : BUILTIN_KINDS.map((entry) => entry.kind);
  return kinds.length > 0 ? kinds.join("、") : "（无）";
}

/** Pure expansion of host-verified context. Public args cannot supply filesystem authority. */
export function resolveImplementReview(args: Readonly<Record<string, unknown>>, prepared?: PreparedWorkflowContext | null): Expansion {
  if (!prepared) return { error: "The host has no prepared task/worktree context. Select a valid task and refresh Coworkflow before dispatch." };
  const allowed = new Set(["taskRef", "focus", "implementAgent", "reviewAgent"]);
  const unsupported = Object.keys(args).filter((key) => !allowed.has(key));
  if (unsupported.length) return { error: `workflow '${WORKFLOW_NAME}' args contain unsupported fields: ${unsupported.join(", ")}.` };
  if (typeof args.taskRef !== "string" || !validTaskRef(args.taskRef)) {
    return { error: "args.taskRef must be a Trellis task directory: '.trellis/tasks/<name>'." };
  }
  if (args.taskRef !== prepared.taskRef) return { error: "args.taskRef does not match the host's prepared active task." };
  const focus = args.focus === undefined ? undefined : str(args.focus);
  if (args.focus !== undefined && (!focus || focus.length > MAX_FOCUS)) return { error: `args.focus must contain 1–${MAX_FOCUS} characters.` };
  const implementAgent = args.implementAgent === undefined
    ? (prepared.implementAgent ?? DEFAULT_IMPLEMENT_AGENT)
    : str(args.implementAgent);
  const reviewAgent = args.reviewAgent === undefined
    ? (prepared.reviewAgent ?? DEFAULT_REVIEW_AGENT)
    : str(args.reviewAgent);
  for (const [name, value] of [["implementAgent", implementAgent], ["reviewAgent", reviewAgent]] as const) {
    if (!value || value.length > MAX_AGENT || !AGENT_RE.test(value)) return { error: `args.${name} must be a safe agent name.` };
  }
  if (implementAgent === reviewAgent) return { error: "args.implementAgent and args.reviewAgent must differ." };
  return { script: buildScript({ taskRef: prepared.taskRef, worktree: prepared.worktree,
    taskTitle: prepared.title?.slice(0, MAX_TITLE), focus, implementAgent: implementAgent!, reviewAgent: reviewAgent! }) };
}

interface ScriptInput {
  taskRef: string;
  worktree: string;
  taskTitle?: string;
  focus?: string;
  implementAgent: string;
  reviewAgent: string;
}

const IMPLEMENT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    changedFiles: { type: "array", items: { type: "string" } },
    residualRisks: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "changedFiles", "residualRisks"],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "changes_requested", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
};

/**
 * Every fanout child answers in the same shape, on purpose.
 *
 * One child's structured output is what the parent reads to tell which task
 * succeeded, so the shape is the same for all of them and a child that returns
 * nothing usable is a *failed* task rather than a silent pass.
 */
const FANOUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    handoff: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: ["status", "summary", "handoff"],
  additionalProperties: false,
};

/** One child plus the refusal that stops it, decided before any child starts. */
type PlannedChild = FanoutChild & { refusal: string | null };

interface FanoutScriptInput {
  children: PlannedChild[];
  focus?: string;
  cwd?: string;
}

/**
 * Build the fanout script text.
 *
 * The concurrency is the whole point and it is written to be unmistakable: the
 * `map` *starts* every child, and only afterwards is anything awaited, so a later
 * child can never queue behind an earlier one. Each child's rejection becomes that
 * child's own outcome, so one failure cannot cancel its siblings.
 */
function buildFanoutScript(input: FanoutScriptInput): string {
  const focus = input.focus ? `\n本次扇出的共同要求（来自主会话）：${input.focus}\n` : "";
  return `
const tasks = ${JSON.stringify(input.children)};
const cwd = ${JSON.stringify(input.cwd ?? null)};
const FANOUT_SCHEMA = ${JSON.stringify(FANOUT_SCHEMA)};
const MAX_SUMMARY = 4000;

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function bounded(value, limit) {
  const text = textOf(value).trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function structuredOf(result) {
  const structured = result && result.structuredOutput;
  return structured && typeof structured === "object" && !Array.isArray(structured) ? structured : null;
}

// One outcome per task: a child that failed is reported as that task's failure,
// with its own run identity when the runner produced one.
function outcome(task, result, error) {
  const structured = result ? structuredOf(result) : null;
  const verdict = structured && typeof structured.status === "string" ? structured.status : null;
  const ok = !error && result !== null && result !== undefined && result.ok === true && verdict === "completed";
  const summary = structured && textOf(structured.summary).trim()
    ? bounded(structured.summary, MAX_SUMMARY)
    : bounded(result && result.output, MAX_SUMMARY) || bounded(error && error.message, MAX_SUMMARY) || "(no summary)";
  return {
    key: task.key,
    kind: task.kind,
    agent: task.agent,
    ok: ok,
    status: verdict === null ? (ok ? "completed" : "failed") : verdict,
    summary: summary,
    handoff: structured && textOf(structured.handoff).trim()
      ? bounded(structured.handoff, 2000)
      : (result && textOf(result.outputReference)) || null,
    runId: result && typeof result.runId === "string" ? result.runId : null,
    outputReference: result && typeof result.outputReference === "string" ? result.outputReference : null,
    error: error ? bounded(error.message, MAX_SUMMARY) : (result && textOf(result.error) ? bounded(result.error, MAX_SUMMARY) : null)
  };
}

function paramsFor(task) {
  const params = {
    label: task.key + " " + task.agent,
    agent: task.agent,
    task: task.task + ${JSON.stringify(focus)},
    worktree: false,
    context: "fresh",
    acceptance: {
      level: "checked",
      report: "on",
      criteria: ["Complete exactly this task and report the evidence it needs"],
      evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files"]
    },
    outputSchema: FANOUT_SCHEMA
  };
  if (cwd !== null) params.cwd = cwd;
  return params;
}

// A task whose kind the project disabled (or never registered) is its own failure,
// decided before any child starts: the fanout refuses that task instead of starting
// a kind the panel says is off, and the other tasks still run.
function refused(task) {
  return {
    key: task.key, kind: task.kind, agent: task.agent, ok: false, status: "failed",
    summary: task.refusal, handoff: null, runId: null, outputReference: null, error: task.refusal
  };
}

// Start every child first; nothing is awaited inside this map.
const launched = tasks.map(function (task) {
  if (task.refusal !== null) return Promise.resolve(refused(task));
  return runs.run(task.key, paramsFor(task)).then(
    function (result) { return outcome(task, result, null); },
    function (error) { return outcome(task, null, error); }
  );
});

// Every child is already running; this only waits for them to settle.
const results = await Promise.all(launched);

const okCount = results.filter(function (entry) { return entry.ok === true; }).length;
const failedCount = results.length - okCount;

// Fail-closed only when nothing succeeded: a partial fanout is a real outcome the
// parent must see, not a workflow error that hides the children that did finish.
if (okCount === 0) {
  const reasons = results.map(function (entry) { return entry.key + ": " + entry.summary; }).join("; ");
  throw new Error("coworkflow.fanout: all " + results.length + " task(s) failed (" + reasons + ")");
}

return {
  status: failedCount === 0 ? "completed" : "partial",
  // A green fanout is a completed execution, not an accepted change: the parent
  // still audits, decides about merge, and owns cleanup.
  acceptance: "parent-owned",
  note: "扇出正常结束只代表执行完成，不代表验收通过；每个子任务的结论都要由主会话自己核对，合并、清理与最终结论仍由主会话决定。",
  concurrency: "parallel",
  total: results.length,
  completed: okCount,
  failed: failedCount,
  results: results
};
`;
}

/**
 * Build the script text.
 *
 * Everything caller-supplied goes through `JSON.stringify` as *data*: the args
 * never become code, and no shell command is assembled from them. The only
 * interpolation into a prompt is the task reference, the worktree path and an
 * optional review focus, all already length- and shape-bounded above.
 */
function buildScript(input: ScriptInput): string {
  const taskLine = `Active task: ${input.taskRef}`;
  const title = input.taskTitle ? `任务标题：${input.taskTitle}\n` : "";
  const focus = input.focus ? `\n复核重点（来自主会话）：${input.focus}\n` : "";

  const implementTask = [
    taskLine,
    "",
    `${title}在这个任务自己的隔离 worktree（${input.worktree}）里实现本任务的需求。`,
    "",
    "要求：",
    "- 先读任务目录里的 prd.md、design.md、implement.md 与 implement.jsonl 点名的 spec，再动手。",
    "- 只改本任务范围内的代码；不要扩大范围、不要顺手重构无关文件。",
    "- 不要 git commit / push / merge，不要合并或清理 worktree；这些是主会话的职责。",
    "- 跑受影响范围的最小充分检查（typecheck / 聚焦测试），把真实输出写进结论。",
    `- 最后用结构化输出汇报：status（completed / blocked / failed）、summary、changedFiles、residualRisks。${focus}`,
  ].join("\n");

  const reviewIntro = [
    taskLine,
    "",
    "复核刚才那个实现子任务交付的改动，只读判断与报告，不要改代码、不要提交。",
    "",
    "要求：",
    "- 对照 prd.md / design.md / implement.md 和受影响范围的 spec 判断这份改动是否满足要求。",
    "- 检查自报的验证结论是否真的支持结论（有没有改到别人正在改的文件、有没有漏掉回归）。",
    "- 给出结构化输出：verdict（pass / changes_requested / blocked）、summary、findings（仅列阻塞问题，pass 时必须为空数组）。只要还有阻塞问题就必须给 changes_requested 或 blocked，不要为了让流程通过而给 pass。",
  ].join("\n");

  return `
const worktree = ${JSON.stringify(input.worktree)};
const taskRef = ${JSON.stringify(input.taskRef)};
const implementTask = ${JSON.stringify(implementTask)};
const reviewIntro = ${JSON.stringify(reviewIntro)};
const IMPLEMENT_SCHEMA = ${JSON.stringify(IMPLEMENT_SCHEMA)};
const REVIEW_SCHEMA = ${JSON.stringify(REVIEW_SCHEMA)};
const EMBED_LIMIT = ${EMBED_LIMIT};

function fail(message) {
  throw new Error("coworkflow.implement-review: " + message);
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function strings(value) {
  return Array.isArray(value) && value.every(function (entry) { return typeof entry === "string" && entry.trim().length > 0; });
}

function summary(value) {
  return value && typeof value.summary === "string" && value.summary.trim().length > 0 && value.summary.length <= 4000;
}

function project(child) {
  if (!child || typeof child !== "object") return {};
  const structured = child.structuredOutput;
  return {
    runId: typeof child.runId === "string" ? child.runId : null,
    outputReference: typeof child.outputReference === "string" ? child.outputReference : null,
    artifactPaths: Array.isArray(child.artifactPaths)
      ? child.artifactPaths.filter(function (entry) { return typeof entry === "string"; })
      : [],
    structured: structured && typeof structured === "object" && !Array.isArray(structured) ? structured : null
  };
}

const implement = await runs.run(${JSON.stringify(IMPLEMENT_KEY)}, {
  label: "implement " + taskRef,
  agent: ${JSON.stringify(input.implementAgent)},
  task: implementTask,
  cwd: worktree,
  worktree: false,
  context: "fresh",
  acceptance: { level: "checked", report: "on", criteria: ["Fulfil the active task within scope"],
    evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files"] },
  outputSchema: IMPLEMENT_SCHEMA
});

if (!implement || implement.ok !== true) {
  fail("the implement step did not complete (" + textOf(implement && implement.error) + ")");
}
const implemented = project(implement);
const implementVerdict = implemented.structured && typeof implemented.structured.status === "string"
  ? implemented.structured.status
  : null;
if (implementVerdict !== "completed") {
  fail("the implement step reported '" + String(implementVerdict) + "', not 'completed'; stopping before review");
}

if (!summary(implemented.structured) || !strings(implemented.structured.changedFiles) || !strings(implemented.structured.residualRisks)) {
  fail("the implement step returned malformed evidence or summary");
}

const implementOutput = textOf(implement.output);
const reviewTask = [
  reviewIntro,
  "",
  "实现子任务的 run id：" + String(implemented.runId),
  implemented.outputReference ? ("实现子任务的产物：" + implemented.outputReference) : "实现子任务的产物没有保存成文件，下面附上它的最终输出。",
  "",
  "实现自报的结论：",
  JSON.stringify(implemented.structured),
  "",
  implementOutput.length > EMBED_LIMIT
    ? "实现输出过长，节选前 " + EMBED_LIMIT + " 字符：\\n" + implementOutput.slice(0, EMBED_LIMIT)
    : "实现输出：\\n" + implementOutput
].join("\\n");

const review = await runs.run(${JSON.stringify(REVIEW_KEY)}, {
  label: "review " + taskRef,
  agent: ${JSON.stringify(input.reviewAgent)},
  task: reviewTask,
  cwd: worktree,
  worktree: false,
  context: "fresh",
  acceptance: { level: "attested", report: "on", criteria: ["Independently review the implementation against the active task"],
    evidence: ["review-findings", "residual-risks", "manual-notes"] },
  outputSchema: REVIEW_SCHEMA
});

if (!review || review.ok !== true) {
  fail("the review step did not complete (" + textOf(review && review.error) + ")");
}
const reviewed = project(review);
const verdict = reviewed.structured && typeof reviewed.structured.verdict === "string"
  ? reviewed.structured.verdict
  : null;
if (verdict !== "pass") {
  fail("the review step returned verdict '" + String(verdict) + "', not 'pass'; the work is not accepted");
}

if (!summary(reviewed.structured) || !strings(reviewed.structured.findings) || reviewed.structured.findings.length !== 0) {
  fail("the review step returned malformed evidence or pass with blocking findings");
}

return {
  status: "review-passed",
  // A green workflow is a completed execution, not an accepted change: the parent
  // still audits, decides about merge, and owns cleanup.
  acceptance: "parent-owned",
  note: "工作流正常结束只代表执行完成，不代表验收通过；合并、清理与最终结论仍由主会话决定。",
  taskRef: taskRef,
  worktree: worktree,
  implement: {
    runId: implemented.runId,
    verdict: implementVerdict,
    summary: implemented.structured.summary,
    changedFiles: implemented.structured.changedFiles,
    residualRisks: implemented.structured.residualRisks,
    outputReference: implemented.outputReference,
    artifactPaths: implemented.artifactPaths
  },
  review: {
    runId: reviewed.runId,
    verdict: verdict,
    summary: reviewed.structured.summary,
    findings: reviewed.structured.findings,
    outputReference: reviewed.outputReference,
    artifactPaths: reviewed.artifactPaths
  }
};
`;
}

// ── Task identity (the part that does have I/O, kept out of `resolve`) ──

export interface TaskIdentity {
  taskRef: string;
  title?: string;
  /** The worktree Trellis recorded for this task, when the task was started. */
  worktree: string | null;
  branch: string | null;
}

/** What `task.json` records about a task's isolation. `taskRef` is repo-relative. */
export function readTaskIdentity(root: string, taskRef: string): TaskIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, taskRef, "task.json"), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const worktree = str(record.worktree_path);
  const branch = str(record.branch);
  const title = str(record.title);
  return {
    taskRef,
    ...(title ? { title } : {}),
    worktree: worktree ?? null,
    branch: branch ?? null,
  };
}

// ── Task ↔ native identity links ──────────────────────────────────────

/**
 * Where the task → native run/mission links live.
 *
 * Machine state next to Trellis's own runtime files, not project content: a link
 * records "this Trellis task produced this native run", which is what a later
 * session (or `/Coworkflow:lanes`) needs in order to find the work again. It is
 * deliberately *not* a lifecycle database — pi-subagents' mission store and status
 * are the lifecycle, this is only the identity mapping between the two systems.
 */
export const NATIVE_RUNS_FILE = join(".trellis", ".runtime", "native-runs.json");
const MAX_LINKS = 200;

export interface NativeRunLink {
  runId: string;
  missionId?: string;
  taskRef: string;
  worktree?: string;
  workflow?: string;
  /**
   * The subagent kind this run was dispatched as (`executor`, `auditor`), when one
   * of this package's kinds launched it.
   *
   * Recorded from the dispatch itself, not inferred later: `/Coworkflow:lanes`
   * groups by it, and a run whose agent was a builtin or another extension's has
   * no kind at all rather than a guessed one.
   */
  kind?: string;
  /**
   * The agent name this dispatch asked for, from this package's own record of the
   * call.
   *
   * It is a record of what we sent, not a reading of the runner's state: the
   * runner's own per-run view is the snapshot's `agent`, and `/Coworkflow:lanes`
   * shows that one whenever it is available.
   */
  agent?: string;
  /**
   * The task text this dispatch was given, from this package's own record.
   *
   * Truncated before it is stored, and never presented as the runner's own `goal`
   * field: the fleet DTO's goal belongs to an opaque display row that cannot be
   * attributed to a run, so a goal shown next to a run id can only come from here.
   */
  goal?: string;
  handoffPath?: string;
  workflowReceiptPath?: string;
  sessionId?: string;
  recordedAt: string;
  /**
   * When the dispatch was launched, kept stable across later updates of this link.
   *
   * `recordedAt` is rewritten every time the link is adopted again (a handoff path
   * arriving after completion moves it to that moment), so it cannot answer "when
   * did this start" — the one fact the overlap measurement needs.
   */
  startedAt?: string;
  /**
   * When the run was observed to finish.
   *
   * Absent means unknown — still running, or the completion was never observed —
   * and an unknown interval is never counted as serial work.
   */
  settledAt?: string;
}

function readLinks(root: string): NativeRunLink[] {
  let raw: string;
  try {
    raw = readFileSync(join(root, NATIVE_RUNS_FILE), "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const runs = parsed !== null && typeof parsed === "object" ? (parsed as { runs?: unknown }).runs : undefined;
    if (!Array.isArray(runs)) return [];
    return runs.filter((entry): entry is NativeRunLink => {
      if (entry === null || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      return typeof record.runId === "string" && typeof record.taskRef === "string";
    });
  } catch {
    return [];
  }
}

/**
 * Record one link, after a correlated successful receipt.
 *
 * Only a receipt identifies a run: nothing here infers an identity from a pending
 * launch or from "the only outstanding dispatch", because a wrong link sends a
 * later session to work that belongs to somebody else.
 */
export function recordLaunchLink(root: string, link: Omit<NativeRunLink, "recordedAt">): void {
  const existing = readLinks(root);
  const previous = existing.find((entry) => entry.runId === link.runId);
  const now = new Date().toISOString();
  const links = existing.filter((entry) => entry.runId !== link.runId);
  const startedAt = link.startedAt ?? previous?.startedAt ?? now;
  const settledAt = link.settledAt ?? previous?.settledAt;
  links.push({
    ...link,
    recordedAt: now,
    // A later update of the same link (an adopted handoff path) must not move the
    // launch time: only the first record of a run knows when it started.
    startedAt,
    ...(settledAt === undefined ? {} : { settledAt }),
  });
  const kept = links.slice(-MAX_LINKS);
  const path = join(root, NATIVE_RUNS_FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, runs: kept }, null, 2)}\n`);
  } catch {
    // Losing a link must never break the command that produced it.
  }
}

/** Exact native identity lookup for completion observers; no task fallback. */
export function readRunLink(root: string, runId: string): NativeRunLink | undefined {
  return readLinks(root).find((entry) => entry.runId === runId);
}

/** Links recorded for one task, newest last. */
export function readTaskLinks(root: string, taskRef: string): NativeRunLink[] {
  return readLinks(root).filter((entry) => entry.taskRef === taskRef);
}

/** Links recorded in one session, oldest first. */
export function readSessionLinks(root: string, sessionId: string): NativeRunLink[] {
  return readLinks(root).filter((entry) => entry.sessionId === sessionId);
}

/**
 * Record that a linked run finished, so its dispatch interval is closed.
 *
 * Called from an observed structured completion only: a link with no settle time
 * stays *unknown*, and unknown is never counted as serial work. Re-settling an
 * already-closed run keeps the first answer, because the completion that mattered
 * was the one the runtime reported.
 */
export function recordRunSettled(root: string, runId: string, at: string = new Date().toISOString()): void {
  const link = readLinks(root).find((entry) => entry.runId === runId);
  if (!link || link.settledAt !== undefined) return;
  recordLaunchLink(root, { ...link, settledAt: at });
}

function epochMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * How many of this session's dispatches actually overlapped.
 *
 * Read from the recorded links, so it is a fact about what happened rather than a
 * count of what the model said it did. A link whose timestamps are missing stays
 * unresolved: the measurement never turns "I could not tell" into "serial".
 */
export function dispatchOverlap(root: string, sessionId: string | null, now: number = Date.now()): OverlapSummary {
  if (sessionId === null) return summarizeOverlap([], now);
  const intervals: DispatchInterval[] = readSessionLinks(root, sessionId).map((link) => {
    const startedAt = epochMs(link.startedAt);
    const settledAt = epochMs(link.settledAt);
    return {
      id: link.runId,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(settledAt === undefined ? {} : { settledAt }),
    };
  });
  return summarizeOverlap(intervals, now);
}

// ── Registration against the installed package ────────────────────────

interface Disposable {
  dispose(): void;
}

interface WorkflowResourcesModule {
  registerWorkflowResource(input: {
    sessionId: string;
    definition: {
      name: string;
      version: number;
      resolve: (args: Readonly<Record<string, unknown>>) => Expansion;
    };
  }): Disposable;
}

interface RequiredChildExtensionsModule {
  registerRequiredChildExtensions(input: {
    sessionId: string;
    extensions: readonly { id: string; path: string }[];
    requireForAllRunners?: boolean;
  }): Disposable;
}

/**
 * Resolve one documented export subpath of the installed pi-subagents package.
 *
 * Reading `exports` rather than guessing a file path keeps this working when the
 * package layout changes; a missing entry is reported, never patched over.
 */
export type SubagentsSubpath = "./workflow-resources" | "./required-child-extensions" | "./agents";

export function exportEntry(subpath: SubagentsSubpath, projectRoot = process.cwd()): string | { error: string } {
  const require = createRequire(join(resolve(projectRoot), "package.json"));
  const directories = [join(projectRoot, ".pi", "npm", "node_modules", "pi-subagents"),
    ...(require.resolve.paths("pi-subagents") ?? []).slice(0, 16).map((path) => join(path, "pi-subagents")),
    subagentsPackageDir()];
  const dir = directories.find((path) => existsSync(join(path, "package.json")));
  if (!dir) return { error: "找不到已安装的 pi-subagents：请在项目级或用户级安装，本扩展不会加载第二份运行器。" };
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    // Node's ESM conditions, in manifest order; never select a types/require-only entry.
    function target(value: unknown): string | undefined {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(target).find(Boolean);
      if (!value || typeof value !== "object") return undefined;
      for (const [key, entry] of Object.entries(value)) {
        if (["import", "node", "default"].includes(key)) {
          const resolved = target(entry);
          if (resolved) return resolved;
        }
      }
      return undefined;
    }
    const entry = target(manifest.exports?.[subpath]);
    if (!entry?.startsWith("./")) return { error: `pi-subagents（${dir}）没有可用的公开导出 ${subpath}；请升级。` };
    const path = resolve(dir, entry);
    const local = relative(resolve(dir), path);
    if (local.startsWith("..") || isAbsolute(local) || !existsSync(path)) return { error: `pi-subagents 的导出 ${subpath} 无效。` };
    return path;
  } catch (error) {
    return { error: `无法读取 pi-subagents 的公开导出：${String(error)}` };
  }
}

/**
 * Import one documented subpath of the installed owner.
 *
 * Shared by every consumer rather than copied: "where is the installed
 * pi-subagents" is one question with one answer, and a second copy would drift the
 * moment either the layout or the search order changes.
 */
export async function loadSubagentsExport<T>(subpath: SubagentsSubpath, projectRoot?: string): Promise<{ ok: true; module: T } | { ok: false; message: string }> {
  const entry = exportEntry(subpath, projectRoot);
  if (typeof entry !== "string") return { ok: false, message: entry.error };
  try { return { ok: true, module: (await import(pathToFileURL(entry).href)) as T }; }
  catch (error) { return { ok: false, message: `导入 pi-subagents 的 ${subpath} 失败：${String(error)}` }; }
}

export type RegistrationOutcome =
  | { ok: true; registration: Disposable }
  | { ok: false; message: string };

/**
 * Register this session's workflow resources.
 *
 * Both names are registered here, in one pass, because they answer the same
 * question — "can this session dispatch extension-owned work at all?" — and a
 * session that silently had one without the other would be a layer that half
 * works. The returned handle disposes both; a partial failure disposes whatever
 * landed before it and reports the reason, so a session either has the pair or
 * knows why it has neither.
 *
 * Replacing an existing registration is the caller's job (`dispose` first): the
 * owner refuses a duplicate name in the same session, and silently swallowing that
 * error would leave the session with no resource at all.
 */
export async function registerImplementReviewWorkflow(
  sessionId: string,
  options: {
    projectRoot?: string;
    context?: () => PreparedWorkflowContext | null;
    /** The project's kind policy, resolved in memory by the caller; see `resolveFanout`. */
    fanoutPolicy?: () => FanoutPolicy;
  } = {},
): Promise<RegistrationOutcome> {
  const loaded = await loadSubagentsExport<WorkflowResourcesModule>("./workflow-resources", options.projectRoot);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const api = loaded.module;
  if (typeof api.registerWorkflowResource !== "function") {
    return {
      ok: false,
      message: "已安装的 pi-subagents 的 ./workflow-resources 没有导出 registerWorkflowResource；请升级 pi-subagents。",
    };
  }
  const definitions = [
    { name: WORKFLOW_NAME, version: WORKFLOW_VERSION, resolve: (args: Readonly<Record<string, unknown>>) => resolveImplementReview(args, options.context?.()) },
    { name: FANOUT_NAME, version: FANOUT_VERSION,
      resolve: (args: Readonly<Record<string, unknown>>) => resolveFanout(args, options.context?.(), options.fanoutPolicy?.()) },
  ];
  const registered: Disposable[] = [];
  for (const definition of definitions) {
    try {
      registered.push(api.registerWorkflowResource({ sessionId, definition }));
    } catch (error) {
      for (const handle of registered) { try { handle.dispose(); } catch { /* idempotent upstream */ } }
      return {
        ok: false,
        message: `注册工作流资源 ${definition.name} 失败：${error instanceof Error ? error.message : String(error)}。`,
      };
    }
  }
  return {
    ok: true,
    registration: {
      dispose() {
        for (const handle of registered) handle.dispose();
        registered.length = 0;
      },
    },
  };
}

/**
 * Require this extension in this session's children.
 *
 * The child-side half of this package (role-scoped Trellis context) is delivered
 * by an extension *inside the child*. A runner that cannot load extensions would
 * silently launch a role-blind child that believes it has no task, so the
 * requirement is marked for all runners: such a launch is rejected with an
 * actionable error instead of quietly degrading.
 */
export async function registerChildExtensionRequirement(
  sessionId: string,
  extensionPath: string,
  projectRoot?: string,
): Promise<RegistrationOutcome> {
  const loaded = await loadSubagentsExport<RequiredChildExtensionsModule>("./required-child-extensions", projectRoot);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const api = loaded.module;
  if (typeof api.registerRequiredChildExtensions !== "function") {
    return {
      ok: false,
      message: "已安装的 pi-subagents 的 ./required-child-extensions 没有导出 registerRequiredChildExtensions；请升级 pi-subagents。",
    };
  }
  try {
    const registration = api.registerRequiredChildExtensions({
      sessionId,
      extensions: [{ id: "pi-coworkflow", path: extensionPath }],
      requireForAllRunners: true,
    });
    return { ok: true, registration };
  } catch (error) {
    return {
      ok: false,
      message: `登记子会话必需的扩展失败：${error instanceof Error ? error.message : String(error)}。`,
    };
  }
}
