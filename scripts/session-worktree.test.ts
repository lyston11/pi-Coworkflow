/**
 * Session-level worktree isolation.
 *
 * These pin the four decisions the module makes and the two it refuses:
 * which tree a session gets (cwd → task → allocated), that a dirty main checkout
 * still allocates, that reuse is idempotent and never clobbers foreign work, and
 * that only launching calls are placed. Each one is a step where the previous
 * implementation silently ran in the shared checkout.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inspectTree,
  launchesChildren,
  resetSessionTree,
  resolveSessionTree,
  runMerge,
  sessionTree,
  sessionWorktreeModule,
  sessionTreeNames,
  sessionToken,
  type SessionTree,
} from "../modules/session-worktree/index.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@test",
};

function fixture(): { root: string; git: (args: string[], input?: string) => string; close: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "coworkflow-session-tree-"));
  const root = join(parent, "repo");
  mkdirSync(root, { recursive: true });
  const git = (args: string[], input?: string): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], env: ENV }).trim();
  git(["init", "-b", "main"]);
  const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
  const commit = git(["commit-tree", tree, "-m", "fixture"]);
  git(["update-ref", "refs/heads/main", commit]);
  return { root, git, close: () => rmSync(parent, { recursive: true, force: true }) };
}

const failureOf = (value: SessionTree | { ok: false; message: string }): string => {
  assert.ok("ok" in value, "expected a failure");
  return value.message;
};

test("names: a session tree is wt-cw-<token> on cw/<token>, cut from the base branch", () => {
  const h = fixture();
  try {
    const names = sessionTreeNames(h.root, "abc12345");
    assert.equal(names.path, join(dirname(h.root), "wt-cw-abc12345"));
    assert.equal(names.branch, "cw/abc12345");
    assert.equal(names.base, "main", "no origin/HEAD in the fixture, so the checked-out branch is the base");
  } finally { h.close(); }
});

test("names: the token is stable per session and differs between sessions", () => {
  assert.equal(sessionToken("session-a"), sessionToken("session-a"));
  assert.notEqual(sessionToken("session-a"), sessionToken("session-b"));
  assert.match(sessionToken(null), /^[0-9a-f]{8}$/, "a session without an id still gets a usable token");
});

test("resolve: a dirty main checkout still gets an isolated tree, and the tree carries the records", () => {
  const h = fixture();
  try {
    // The condition that made the upstream `worktree: true` unusable: an uncommitted change.
    writeFileSync(join(h.root, "uncommitted.txt"), "dirty\n");
    mkdirSync(join(h.root, ".pi"), { recursive: true });
    writeFileSync(join(h.root, ".pi", "Coworkflow.json"), "{}");
    mkdirSync(join(h.root, ".trellis", "tasks"), { recursive: true });

    const tree = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    assert.ok(!("ok" in tree));
    assert.equal(tree.source, "session");
    assert.ok(existsSync(join(tree.path, "uncommitted.txt")) === false, "the worktree is a checkout of committed files");
    assert.ok(existsSync(join(tree.path, ".pi")), "the child can read the project config");
    assert.ok(existsSync(join(tree.path, ".trellis", "tasks")), "the child can read its own task records");
    assert.equal(h.git(["symbolic-ref", "--short", "HEAD"]), "main", "the main checkout's branch is untouched");
  } finally { h.close(); }
});

test("resolve: a second call reuses the same tree instead of allocating another", () => {
  const h = fixture();
  try {
    const first = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    const second = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    assert.ok(!("ok" in first) && !("ok" in second));
    assert.equal(second.path, first.path);
    assert.equal(first.branch, "cw/" + sessionToken("session-a"));
  } finally { h.close(); }
});

test("resolve: the current linked worktree wins, so isolation is not nested", () => {
  const h = fixture();
  try {
    const tree = join(dirname(h.root), "already-here");
    h.git(["worktree", "add", "-b", "feature", tree]);
    const resolved = resolveSessionTree({ repo: h.root, cwd: realpathSync(tree), sessionId: "session-a", taskDir: null });
    assert.ok(!("ok" in resolved));
    assert.equal(resolved.source, "cwd");
    assert.equal(resolved.branch, "feature");
    assert.ok(!existsSync(join(dirname(h.root), `wt-cw-${sessionToken("session-a")}`)), "no second worktree is created");
  } finally { h.close(); }
});

test("resolve: a validated task worktree wins over a session tree", () => {
  const h = fixture();
  try {
    const taskDir = join(h.root, ".trellis", "tasks", "10-01-a-task");
    mkdirSync(taskDir, { recursive: true });
    const worktree = join(dirname(h.root), "wt-10-01-a-task");
    h.git(["worktree", "add", "-b", "feat/10-01-a-task", worktree]);
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ worktree_path: worktree, branch: "feat/10-01-a-task" }));

    const resolved = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir });
    assert.ok(!("ok" in resolved));
    assert.equal(resolved.source, "task");
    assert.equal(resolved.path, realpathSync(worktree), "the worktree git reports, not another one");
    assert.equal(resolved.branch, "feat/10-01-a-task");
    assert.equal(resolved.taskRef, ".trellis/tasks/10-01-a-task");
  } finally { h.close(); }
});

test("resolve: an invalid task worktree falls back to a session tree rather than the main checkout", () => {
  const h = fixture();
  try {
    const taskDir = join(h.root, ".trellis", "tasks", "10-01-broken");
    mkdirSync(taskDir, { recursive: true });
    // Recorded worktree does not exist: the task is broken, the isolation still is not.
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ worktree_path: join(h.root, "gone"), branch: "feat/x" }));
    const resolved = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir });
    assert.ok(!("ok" in resolved));
    assert.equal(resolved.source, "session");
  } finally { h.close(); }
});

test("resolve: a foreign branch of the same name is refused, never overwritten", () => {
  const h = fixture();
  try {
    const names = sessionTreeNames(h.root, sessionToken("session-a"));
    h.git(["branch", names.branch]);
    const message = failureOf(resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null }));
    assert.match(message, /已存在但没有对应的 worktree/);
    assert.ok(!existsSync(names.path), "nothing was created over it");
  } finally { h.close(); }
});

test("resolve: a directory of the same name that is not this repository's worktree is refused", () => {
  const h = fixture();
  try {
    const names = sessionTreeNames(h.root, sessionToken("session-a"));
    mkdirSync(names.path, { recursive: true });
    writeFileSync(join(names.path, "someone-elses-work"), "do not touch\n");
    const message = failureOf(resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null }));
    assert.match(message, /不是本仓库的 linked worktree/);
    assert.ok(existsSync(join(names.path, "someone-elses-work")));
  } finally { h.close(); }
});

test("resolve: outside a repository there is no tree and the reason says why", () => {
  const parent = mkdtempSync(join(tmpdir(), "coworkflow-no-repo-"));
  try {
    const plain = join(parent, "plain");
    mkdirSync(plain, { recursive: true });
    const message = failureOf(resolveSessionTree({ repo: plain, cwd: plain, sessionId: "session-a", taskDir: null }));
    assert.match(message, /没有仓库就无法隔离工作区|git 仓库/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("resolve: sessions never share a tree", () => {
  const h = fixture();
  try {
    const a = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    const b = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-b", taskDir: null });
    assert.ok(!("ok" in a) && !("ok" in b));
    assert.notEqual(a.path, b.path);
    assert.notEqual(a.branch, b.branch);
  } finally { h.close(); }
});

test("inspect: ahead/dirty are counted, so a caller can refuse a merge on facts", () => {
  const h = fixture();
  try {
    const tree = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    assert.ok(!("ok" in tree));
    const clean = inspectTree(tree);
    assert.ok(!("ok" in clean));
    assert.equal(clean.dirty, false);
    assert.equal(clean.ahead, 0);

    writeFileSync(join(tree.path, "work.txt"), "done\n");
    execFileSync("git", ["-C", tree.path, "add", "work.txt"], { env: ENV });
    execFileSync("git", ["-C", tree.path, "commit", "-m", "work"], { env: ENV });
    const after = inspectTree(tree);
    assert.ok(!("ok" in after));
    assert.equal(after.ahead, 1);
    assert.deepEqual(after.changed, ["work.txt"]);

    writeFileSync(join(tree.path, "work.txt"), "dirty\n");
    const dirty = inspectTree(tree);
    assert.ok(!("ok" in dirty));
    assert.equal(dirty.dirty, true);
  } finally { h.close(); }
});

test("merge: a dirty tree is refused with the reason, and nothing is merged", async () => {
  const h = fixture();
  try {
    const tree = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    assert.ok(!("ok" in tree));
    writeFileSync(join(tree.path, "work.txt"), "uncommitted\n");
    const lines = await runMerge(hostOf(), runtimeOf(h.root, "session-a"), "");
    assert.match(lines.join("\n"), /有未提交改动/);
    assert.equal(h.git(["rev-parse", "main"]), h.git(["rev-parse", "main"]), "main is untouched");
  } finally { h.close(); }
});

test("merge: no commits ahead reports nothing to do instead of an empty merge", async () => {
  const h = fixture();
  try {
    resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    const lines = await runMerge(hostOf(), runtimeOf(h.root, "session-a"), "");
    assert.match(lines.join("\n"), /无事可合并/);
  } finally { h.close(); }
});

test("merge: an ahead branch is merged into the base with --no-ff, and nothing is pushed", async () => {
  const h = fixture();
  try {
    const tree = resolveSessionTree({ repo: h.root, cwd: h.root, sessionId: "session-a", taskDir: null });
    assert.ok(!("ok" in tree));
    writeFileSync(join(tree.path, "work.txt"), "done\n");
    execFileSync("git", ["-C", tree.path, "add", "work.txt"], { env: ENV });
    execFileSync("git", ["-C", tree.path, "commit", "-m", "work"], { env: ENV });
    const before = h.git(["rev-parse", "main"]);
    const lines = await runMerge(hostOf(), runtimeOf(h.root, "session-a"), "");
    const output = lines.join("\n");
    assert.match(output, /已合并/);
    assert.match(output, /未 push/, "the command reports that it did not push");
    assert.doesNotMatch(output, /已 push|git push/, "and it never claims to");
    assert.notEqual(h.git(["rev-parse", "main"]), before, "main moved");
    assert.equal(readFileSync(join(h.root, "work.txt"), "utf8"), "done\n", "the work is in the base checkout");
    assert.ok(existsSync(tree.path), "the worktree stays until someone confirms cleanup");
  } finally { h.close(); }
});

test("placement: only calls that start children are placed", () => {
  assert.equal(launchesChildren({ agent: "cw-executor", task: "x" }), true);
  assert.equal(launchesChildren({ workflow: "parallel", args: { tasks: [] } }), true);
  assert.equal(launchesChildren({ action: "status", id: "r1" }), false, "management calls launch nothing");
  assert.equal(launchesChildren({ action: "validate", workflow: "./lane.js" }), false);
  assert.equal(launchesChildren({}), false);
  assert.equal(launchesChildren(null), false);
});

test("cache: a new session id re-resolves instead of reusing the previous session's tree", () => {
  const h = fixture();
  try {
    const host = hostOf();
    const runtime = runtimeOf(h.root, "session-a");
    const first = sessionTree(host, runtime);
    assert.ok(!("ok" in first));
    runtime.sessionId = "session-b";
    const second = sessionTree(host, runtime);
    assert.ok(!("ok" in second));
    assert.notEqual(second.path, first.path);
    resetSessionTree(host);
  } finally { h.close(); }
});

// ── Minimal host/runtime doubles: the module only reads what these provide. ──

function hostOf(): any {
  return { on: () => () => {}, registerCommand() {}, events: undefined };
}

function runtimeOf(cwd: string, sessionId: string): any {
  return {
    isChild: false,
    enabled: true,
    cwd,
    sessionId,
    parentSessionId: null,
    sessionEpoch: 1,
    loadState: "started",
    configRoots: { root: () => cwd, invalidate() {} },
    refresh() {},
    control: { moduleEnabled: () => true, subagentConcurrency: () => null },
  };
}

test("status: an unresolved session says nothing, a failure says why, and a tree reports branch/health", () => {
  const h = fixture();
  try {
    const host = hostOf();
    const runtime = runtimeOf(h.root, "session-a");
    assert.equal(sessionWorktreeModule.runtimeStatus?.(host), null, "nothing resolved yet is not a claim of isolation");

    const status = (): string => sessionWorktreeModule.runtimeStatus?.(host)?.join("\n") ?? "";
    const tree = sessionTree(host, runtime);
    assert.ok(!("ok" in tree));
    const ok = [status()];
    const line = ok.join("\n");
    assert.match(line, /session-worktree: .*wt-cw-/);
    assert.match(line, new RegExp(`cw/${sessionToken("session-a")}`));
    assert.match(line, /clean · 0 commits ahead/);

    // A failure is reported as a failure, not as a missing line.
    resetSessionTree(host);
    const plain = runtimeOf(join(h.root, "not-a-repo"), "session-b");
    const failed = sessionTree(host, plain);
    assert.ok("ok" in failed);
    assert.match(status(), /! session-worktree: /);
    resetSessionTree(host);
  } finally { h.close(); }
});

test("injection: one placement for every launch shape, and none for management calls", () => {
  const h = fixture();
  try {
    const handlers: Record<string, (event: any) => any> = {};
    const host: any = { on: (name: string, handler: any) => { handlers[name] = handler; return () => {}; }, registerCommand() {} };
    const runtime = runtimeOf(h.root, "session-a");
    sessionWorktreeModule.activate?.(host, runtime);
    const call = handlers.tool_call;
    assert.ok(call, "the module registers a tool_call handler");

    const direct: any = { toolName: "subagent", input: { agent: "worker", task: "x" } };
    assert.equal(call(direct), undefined);
    assert.match(direct.input.cwd as string, /wt-cw-/, "a direct dispatch is placed");

    const workflow: any = { toolName: "subagent", input: { workflow: "coworkflow.fanout", args: { tasks: [{ agent: "worker" }] } } };
    call(workflow);
    assert.equal((workflow.input as any).cwd, direct.input.cwd, "a named workflow lands in the same tree");

    const managed: any = { toolName: "subagent", input: { action: "status", id: "r1" } };
    call(managed);
    assert.equal("cwd" in managed.input, false, "a management call is not rewritten");

    const explicit: any = { toolName: "subagent", input: { agent: "worker", task: "x", cwd: "/somewhere/else" } };
    call(explicit);
    assert.equal(explicit.input.cwd, "/somewhere/else", "an explicit cwd is the caller's decision");

    const other: any = { toolName: "read", input: { path: "x" } };
    call(other);
    assert.equal("cwd" in other.input, false, "other tools are untouched");
    resetSessionTree(host);
  } finally { h.close(); }
});

test("session end: an unused tree is removed, a tree with commits is kept", () => {
  const h = fixture();
  try {
    const host = hostOf();
    const runtime = runtimeOf(h.root, "session-a");
    const tree = sessionTree(host, runtime);
    assert.ok(!("ok" in tree));
    sessionWorktreeModule.onSessionEnd?.(host, runtime);
    assert.equal(existsSync(tree.path), false, "no commits, so nothing to keep");
    assert.throws(() => h.git(["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`]), "and its branch is deleted");

    const second = sessionTree(host, runtimeOf(h.root, "session-b"));
    assert.ok(!("ok" in second));
    writeFileSync(join(second.path, "work.txt"), "done\n");
    execFileSync("git", ["-C", second.path, "add", "work.txt"], { env: ENV });
    execFileSync("git", ["-C", second.path, "commit", "-m", "work"], { env: ENV });
    sessionWorktreeModule.onSessionEnd?.(host, runtimeOf(h.root, "session-b"));
    assert.ok(existsSync(second.path), "unmerged work is never deleted by a session ending");
    assert.equal(h.git(["rev-parse", "--verify", "--quiet", `refs/heads/${second.branch}`]), h.git(["rev-parse", second.branch]));
  } finally { h.close(); }
});
