/**
 * Module: one isolation worktree per pi session.
 *
 * Every dispatched child writes wherever the parent happens to be. When the parent
 * sits in the main checkout — the common case, and the only case when nobody ran
 * `task.py start` — five children from five sessions edit the same files. The
 * upstream `worktree: true` flag is not the answer: it is per *launch* (so one
 * session's five dispatches land on five branches), it needs a clean source tree
 * (a working checkout rarely is), and it returns patches instead of a checkout
 * someone can merge.
 *
 * So the isolation unit here is the *session*: `resolve()` returns one worktree —
 * the checkout the user already `cd`ed into, else the active Trellis task's
 * worktree, else a session worktree allocated on demand — and every launch path
 * (`tool_call` injection for direct dispatches and named workflows, the `spawn`
 * call inside `dispatch`) uses that one path. One session, one branch, one merge.
 *
 * ## What this module refuses to do
 *
 * - **No silent fallback.** If a worktree cannot be established (no repository,
 *   `worktree add` fails, a same-named branch belongs to something else), launching
 *   children is what fails, with the reason. Falling back to the shared checkout is
 *   the exact failure this module exists to prevent.
 * - **No automatic merge, push, rebase or deletion of unmerged work.** `/Coworkflow:merge`
 *   is an explicit command that stops on a dirty tree or a conflict, and session end
 *   only removes a worktree whose branch is already merged and whose tree is clean.
 * - **No second worktree inside a child.** `runtime.isChild` is skipped entirely: the
 *   parent already decided where this child runs.
 *
 * ## Why the task worktree wins over a new one
 *
 * A started Trellis task already has a branch and a worktree, and the project's rules
 * make it the unit of isolation. Allocating a session worktree on top would smuggle a
 * second, unnamed branch into the merge picture. The task worktree is validated by
 * `planRun` first — the same four checks (`/Coworkflow:run`'s) — and a task worktree
 * that fails validation is a reason to use a session worktree, not a reason to run in
 * the main checkout.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { GIT_TIMEOUT_MS } from "../../core/config.ts";
import type { PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { activeTaskDir, mainCheckout, repoRoot, taskRefForDisplay } from "../../core/trellis.ts";
import { planRun } from "../subagents/index.ts";

const NS = "Coworkflow";
const WORKTREE_PREFIX = "wt-cw-";
const BRANCH_PREFIX = "cw/";

/**
 * Records a fresh worktree does not contain but a child needs.
 *
 * Same set as the Trellis `after_start` hook materialises, for the same reason: a
 * linked worktree is a checkout of committed files only, so without these a child
 * cannot read its own PRD, the spec it must follow, or this package's kind
 * definitions. Symlinked, never copied — these are shared records, and a duplicate
 * would be a second history to diverge from.
 */
const MATERIALISE: readonly (readonly [string, "dir" | "file"])[] = [
  [".trellis/tasks", "dir"],
  [".trellis/scripts", "dir"],
  [".trellis/workspace", "dir"],
  [".trellis/config.yaml", "file"],
  [".trellis/workflow.md", "file"],
  [".pi", "dir"],
];

export interface SessionTree {
  /** Absolute path of the checkout children run in. */
  path: string;
  /** Branch HEAD of that checkout must be on. */
  branch: string;
  /** Branch the session tree was cut from, used by merge and status. */
  base: string;
  /** Where the answer came from, so status can tell "reused" from "allocated". */
  source: "cwd" | "task" | "session";
  /** `.trellis/tasks/<name>` when the tree came from a task. */
  taskRef?: string;
}

export interface SessionTreeFailure {
  ok: false;
  message: string;
}

const failure = (message: string): SessionTreeFailure => ({ ok: false, message });

function git(cwd: string, args: string[]): { ok: true; out: string } | { ok: false; reason: string } {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      // Bounded for the same reason every other git call in this package is: a
      // synchronous child owns the event loop, and `worktree add` on a slow filesystem
      // must fail with a reason instead of freezing the session.
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return { ok: true, out };
  } catch (error) {
    const detail = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof detail.stderr === "string" ? detail.stderr.trim() : "";
    const message = typeof detail.message === "string" ? detail.message : "git 执行失败";
    return { ok: false, reason: (stderr.split(/\r?\n/)[0] || message.split(/\r?\n/)[0] || "git 执行失败").trim() };
  }
}

/** The base branch a session tree should be cut from and merged back into. */
function baseBranch(repo: string): string {
  const remote = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote.ok && remote.out) return remote.out.replace(/^origin\//, "");
  const current = git(repo, ["symbolic-ref", "--short", "HEAD"]);
  if (current.ok && current.out) return current.out;
  return "main";
}

/** Real path when the filesystem can answer, otherwise the path as given. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `dir` is a linked worktree of `repo` (not the main checkout). */
function isLinkedWorktree(dir: string, repo: string): boolean {
  if (realOrSelf(dir) === realOrSelf(mainCheckout(dir))) return false;
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const mine = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (!common.ok || !mine.ok) return false;
  // Compared as real paths: a temporary root on macOS reaches the same directory as
  // `/var/...` and `/private/var/...`, and a prefix check on the spellings says "not mine".
  return common.out !== mine.out && realOrSelf(dirname(common.out)) === realOrSelf(mainCheckout(repo));
}

function branchOf(dir: string): string | null {
  const head = git(dir, ["symbolic-ref", "--short", "HEAD"]);
  return head.ok && head.out ? head.out : null;
}

/** A stable, filesystem-safe token for this session, so a replacement never reuses a tree. */
export function sessionToken(sessionId: string | null): string {
  const seed = sessionId?.trim();
  if (!seed) return createHash("sha256").update(String(process.pid)).digest("hex").slice(0, 8);
  return createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

/**
 * The session worktree's path and branch.
 *
 * `wt-cw-<token>` / `cw/<token>`: short, greppable, and distinct from the two
 * prefixes already in use (`wt-` for Trellis tasks, `feat/` for their branches) so a
 * stale tree cannot be mistaken for a task's.
 */
export function sessionTreeNames(repo: string, token: string): { path: string; branch: string; base: string } {
  return {
    path: join(dirname(repo), `${WORKTREE_PREFIX}${token}`),
    branch: `${BRANCH_PREFIX}${token}`,
    base: baseBranch(repo),
  };
}

/**
 * Establish the tree a session's children run in.
 *
 * Resolution order, each step answering on its own:
 *   1. the checkout the user is already in, when it is a linked worktree — that *is*
 *      the isolation unit, and allocating another would nest one inside another;
 *   2. the active Trellis task's worktree, when `planRun` validates it;
 *   3. a session worktree, allocated now.
 */
export function resolveSessionTree(options: {
  repo: string;
  cwd: string;
  sessionId: string | null;
  taskDir?: string | null;
}): SessionTree | SessionTreeFailure {
  const { repo, cwd, sessionId } = options;
  const root = git(repo, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return failure(`无法确认 ${repo} 是 git 仓库（${root.reason}）：没有仓库就无法隔离工作区。`);

  if (isLinkedWorktree(cwd, repo)) {
    return { path: cwd, branch: branchOf(cwd) ?? "", base: baseBranch(repo), source: "cwd" };
  }

  const taskDir = options.taskDir === undefined ? activeTaskDir(mainCheckout(repo), sessionId) : options.taskDir;
  // The task tree is validated against the main checkout, whose path git reports in its
  // real spelling. Resolving the task directory the same way is what keeps `planRun`'s
  // task identity (`root` + relative ref) honest on a filesystem with symlinked roots.
  const taskPlan = taskDir === null || taskDir === undefined
    ? null
    : planRun(mainCheckout(repo), null, realOrSelf(taskDir));
  if (taskPlan !== null && taskPlan.ok) {
    return {
      path: taskPlan.worktree,
      branch: taskPlan.worktree ? (branchOf(taskPlan.worktree) ?? taskPlan.taskRef) : taskPlan.taskRef,
      base: baseBranch(repo),
      source: "task",
      taskRef: taskPlan.taskRef,
    };
  }

  const names = sessionTreeNames(repo, sessionToken(sessionId));
  const existing = existsSync(names.path);
  if (existing) {
    if (!isLinkedWorktree(names.path, repo)) {
      return failure(`${names.path} 已存在但不是本仓库的 linked worktree：不覆盖、不 --force，请先人工确认。`);
    }
    if (branchOf(names.path) !== names.branch) {
      return failure(`${names.path} 已存在但不在 ${names.branch} 上（当前 ${branchOf(names.path) ?? "detached"}）：不覆盖已有工作。`);
    }
    return { path: names.path, branch: names.branch, base: names.base, source: "session" };
  }

  const branchExists = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${names.branch}`]);
  if (branchExists.ok) {
    return failure(`分支 ${names.branch} 已存在但没有对应的 worktree：不覆盖已有分支，请先人工确认或删除。`);
  }

  const added = git(repo, ["worktree", "add", "-b", names.branch, names.path, names.base]);
  if (!added.ok) {
    return failure(`无法创建会话 worktree ${names.path}（${added.reason}）：子 agent 不会退回共享 checkout 执行。`);
  }
  materialise(repo, names.path);
  return { path: names.path, branch: names.branch, base: names.base, source: "session" };
}

/**
 * Link the records a child needs into a fresh worktree.
 *
 * A failed symlink is not fatal for the whole tree: `.trellis/` can legitimately be
 * absent in a project that never adopted it, and refusing the dispatch over a missing
 * record would be worse than running with what exists. `.pi` is the one that matters
 * and it is reported.
 */
function materialise(repo: string, worktree: string): string[] {
  const problems: string[] = [];
  for (const [relative, kind] of MATERIALISE) {
    const from = join(repo, relative);
    const to = join(worktree, relative);
    if (!existsSync(from) || existsSync(to) || isDanglingLink(to)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(from, to, kind === "dir" ? "dir" : "file");
    } catch (error) {
      problems.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

function isDanglingLink(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isSymbolicLink()) return false;
    // Present but pointing nowhere: replacing it is the only way the link works again.
    return !existsSync(join(readlinkSync(path)));
  } catch {
    return false;
  }
}

/** Merge state, for the command and for the status line. */
export interface TreeState {
  dirty: boolean;
  /** Commits on the session branch that the base does not have. */
  ahead: number;
  /** Commits on the base the session branch does not have. */
  behind: number;
  changed: string[];
}

export function inspectTree(tree: SessionTree): TreeState | SessionTreeFailure {
  const status = git(tree.path, ["status", "--porcelain"]);
  const ahead = git(tree.path, ["rev-list", "--count", `${tree.base}..HEAD`]);
  const behind = git(tree.path, ["rev-list", "--count", `HEAD..${tree.base}`]);
  if (!status.ok || !ahead.ok || !behind.ok) {
    return failure(`无法读取 ${tree.path} 的 git 状态（${(!status.ok && status.reason) || (!ahead.ok && ahead.reason) || "git rev-parse 失败"}）。`);
  }
  const changed = git(tree.path, ["diff", "--name-only", `${tree.base}...HEAD`]);
  return {
    dirty: status.out !== "",
    ahead: Number.parseInt(ahead.out || "0", 10) || 0,
    behind: Number.parseInt(behind.out || "0", 10) || 0,
    changed: changed.ok && changed.out ? changed.out.split(/\r?\n/).filter(Boolean) : [],
  };
}

/**
 * Whether a call starts children, as opposed to managing work that already exists.
 *
 * `action` calls (`status`, `stop`, `steer`, `list`, `validate`, `resume`, `models`,
 * `guide`) launch nothing this session must place, and `validate` legitimately carries
 * a script; rewriting their `cwd` would be a no-op at best.
 */
export function launchesChildren(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const call = input as Record<string, unknown>;
  if (typeof call.action === "string" && call.action.trim()) return false;
  return call.agent !== undefined || call.task !== undefined || call.workflow !== undefined;
}

interface HostState {
  /** Cache per session: resolution runs `git` and must not run on every tool call. */
  tree: SessionTree | SessionTreeFailure | null;
  token: string | null;
  reportedProblems: string[];
}

const HOSTS = new WeakMap<object, HostState>();

function stateFor(host: PiRuntimeHost): HostState {
  let state = HOSTS.get(host);
  if (!state) {
    state = { tree: null, token: null, reportedProblems: [] };
    HOSTS.set(host, state);
  }
  return state;
}

/** Cache identity: a new session means a new tree, so the token is the key. */
function tokenFor(runtime: RuntimeContext): string {
  return sessionToken(runtime.sessionId);
}

/**
 * The tree for this session, resolving on first use.
 *
 * Returns the failure object rather than throwing: every caller has something better
 * to do than crash — `dispatch` refuses that unit, the injection path leaves the call
 * alone but records why, and status prints it.
 */
export function sessionTree(host: PiRuntimeHost, runtime: RuntimeContext): SessionTree | SessionTreeFailure {
  const state = stateFor(host);
  const token = tokenFor(runtime);
  if (state.token !== token) {
    state.tree = null;
    state.token = token;
  }
  if (state.tree !== null) return state.tree;

  const cwd = runtime.cwd;
  const repo = repoRoot(cwd);
  if (mainCheckout(repo) === cwd && !existsSync(join(repo, ".git"))) {
    state.tree = failure(`${cwd} 不在 git 仓库里：无法分配隔离 worktree。`);
    return state.tree;
  }
  const resolved = resolveSessionTree({ repo, cwd, sessionId: runtime.sessionId });
  state.tree = resolved;
  if ("ok" in resolved) state.reportedProblems = [];
  return resolved;
}

/** Test seam: forget everything cached for this host. */
export function resetSessionTree(host: object): void {
  HOSTS.delete(host);
}

function describe(tree: SessionTree): string {
  if (tree.source === "task") return `${tree.path} · ${tree.branch}（任务 ${tree.taskRef ?? "?"}）`;
  if (tree.source === "cwd") return `${tree.path} · ${tree.branch}（当前检出）`;
  return `${tree.path} · ${tree.branch}`;
}

export const sessionWorktreeModule: WorkflowModule = {
  id: "session-worktree",
  title: "会话隔离（每个 pi 会话一个 worktree，子 agent 在其中执行，合并回基线由命令完成）",
  // Switching this on is the default (no `newSwitchDefault` declaration): unlike
  // `capacity`, which refuses work a project asked for, this module *places* work the
  // project already asks for into the checkout its own rules say it belongs in (the AGENTS
  // contract: implementation never happens in the main checkout). Leaving it off would keep
  // the failure it exists to remove — five sessions editing one checkout — so "off" would be
  // the unsafe default. It can still refuse a launch, but only when no tree can be
  // established, and the refusal carries the reason and names the way out.

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild) return;
    // Injection: a direct dispatch or a named workflow gets the session tree as its
    // cwd, so the child works where this session is allowed to work. An explicit
    // `cwd` is the caller's decision and is left alone.
    host.on?.("tool_call", (event: any) => {
      // Read at event time, never captured: `/Coworkflow:start off` must return the
      // session to plain Pi without a restart.
      if (!runtime.enabled || !runtime.control.moduleEnabled("session-worktree")) return undefined;
      if (event?.toolName !== "subagent") return undefined;
      const input = event.input;
      if (!launchesChildren(input)) return undefined;
      const call = input as Record<string, unknown>;
      // An explicit `cwd` is the caller's decision: this module places launches that
      // did not say where they belong, it does not overrule one that said.
      if (call.cwd !== undefined) return undefined;
      const tree = sessionTree(host, runtime);
      if ("ok" in tree) {
        // A launch that cannot be placed is a launch this module did not authorize.
        // Blocking here is the entire point: the alternative is a child writing into
        // the shared checkout with nothing said about it.
        return { block: true, reason: `${tree.message} 本次派单没有启动。` };
      }
      call.cwd = tree.path;
      return undefined;
    });
  },

  onSessionActivate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild || !host.registerCommand) return;
    host.registerCommand(`${NS}:merge`, {
      description: "把本会话 worktree 的分支合并回基线分支（有未提交改动或冲突时停下，不 push）",
      async handler(args: string) {
        const lines = await runMerge(host, runtime, args);
        return lines.join("\n");
      },
    } as never);
  },

  runtimeStatus(host: PiRuntimeHost): string[] | null {
    const state = HOSTS.get(host);
    if (!state?.tree) return null;
    if ("ok" in state.tree) {
      return [`  ! session-worktree: ${state.tree.message}`];
    }
    const tree = state.tree;
    const inspected = inspectTree(tree);
    if ("ok" in inspected) return [`  ! session-worktree: ${describe(tree)} · ${inspected.message}`];
    const health = `${inspected.dirty ? "dirty" : "clean"} · ${inspected.ahead} commits ahead`
      + (inspected.behind > 0 ? ` · ${inspected.behind} behind` : "");
    const problem = state.reportedProblems.length ? ` · 软链失败：${state.reportedProblems.join("; ")}` : "";
    return [`  - session-worktree: ${describe(tree)} · ${health}${problem}`];
  },

  onSessionEnd(host: PiRuntimeHost): void {
    HOSTS.delete(host);
  },
};

/**
 * Merge the session branch back, or say precisely why not.
 *
 * Deliberately not automatic: the project's rule is that merges are done by a human or
 * a single integration channel. What this does is make the merge *possible* — show the
 * commits, refuse a dirty tree, stop on conflict — and never push.
 */
export async function runMerge(host: PiRuntimeHost, runtime: RuntimeContext, args: string): Promise<string[]> {
  const tree = sessionTree(host, runtime);
  if ("ok" in tree) return [`未合并：${tree.message}`];
  const inspected = inspectTree(tree);
  if ("ok" in inspected) return [`未合并：${inspected.message}`];
  const target = args.trim() || tree.base;
  if (inspected.dirty) {
    return [
      `未合并：${tree.path} 有未提交改动（${inspected.changed.slice(0, 5).join(", ") || "工作区"}）。`,
      "先提交或 stash，再运行本命令；本命令不替你 commit。",
    ];
  }
  if (inspected.ahead === 0) {
    return [`无事可合并：${tree.branch} 相对 ${target} 没有提交。`];
  }
  const main = mainCheckout(repoRoot(tree.path));
  const head = branchOf(main);
  if (head === null) return [`未合并：${main} 处于 detached HEAD，无法确定要合并到哪个分支。`];
  if (head !== target) {
    return [
      `未合并：${main} 当前检出的是 ${head}，不是 ${target}。`,
      `本命令不切换分支（会动到你可能正在用的检出）；请先在该检出切到 ${target}，或显式传入分支名。`,
    ];
  }
  const merged = git(main, ["merge", "--no-ff", "-m", `merge ${tree.branch} into ${target}`, tree.branch]);
  if (!merged.ok) {
    const conflicts = git(main, ["diff", "--name-only", "--diff-filter=U"]);
    const files = conflicts.ok && conflicts.out ? conflicts.out.split(/\r?\n/).filter(Boolean) : [];
    return [
      `合并停下：git merge 返回失败（${merged.reason}）。现场已保留，未解冲突、未回滚、未 push。`,
      ...(files.length ? [`冲突文件：${files.join(", ")}`] : []),
      `解决后重新提交即可；要放弃：git -C ${main} merge --abort`,
    ];
  }
  return [
    `已合并：${tree.branch} → ${target}（${inspected.ahead} 个提交，--no-ff）。未 push。`,
    `worktree 仍保留在 ${tree.path}；确认无需再改后可用 git worktree remove 清理。`,
  ];
}
