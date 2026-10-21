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

export const WORKFLOW_NAME = "coworkflow.implement-review";
export const WORKFLOW_VERSION = 1;
/** The two stable child keys; a rerun reuses nothing, they are identity for the mission ledger. */
export const IMPLEMENT_KEY = "implement";
export const REVIEW_KEY = "review";
export const DEFAULT_IMPLEMENT_AGENT = "trellis-implement";
export const DEFAULT_REVIEW_AGENT = "trellis-check";

const MAX_TASK_REF = 200;
const MAX_FOCUS = 2000;
const MAX_TITLE = 300;
const MAX_AGENT = 96;
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
  handoffPath?: string;
  workflowReceiptPath?: string;
  sessionId?: string;
  recordedAt: string;
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
  const links = readLinks(root).filter((entry) => entry.runId !== link.runId);
  links.push({ ...link, recordedAt: new Date().toISOString() });
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
 * Register this session's workflow resource.
 *
 * Replacing an existing registration is the caller's job (`dispose` first): the
 * owner refuses a duplicate name in the same session, and silently swallowing
 * that error would leave the session with no resource at all.
 */
export async function registerImplementReviewWorkflow(
  sessionId: string,
  options: { projectRoot?: string; context?: () => PreparedWorkflowContext | null } = {},
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
  try {
    const registration = api.registerWorkflowResource({
      sessionId,
      definition: {
        name: WORKFLOW_NAME,
        version: WORKFLOW_VERSION,
        resolve: (args) => resolveImplementReview(args, options.context?.()),
      },
    });
    return { ok: true, registration };
  } catch (error) {
    return {
      ok: false,
      message: `注册工作流资源 ${WORKFLOW_NAME} 失败：${error instanceof Error ? error.message : String(error)}。`,
    };
  }
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
