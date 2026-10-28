import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { capacityModule } from "../modules/capacity/index.ts";
import { laneWorktreeModule } from "../modules/lane-worktree/index.ts";
import { existingSubagentsBridge } from "../core/subagents-client.ts";
import { NATIVE_RUNS_FILE, readTaskLinks } from "../core/subagents-workflow.ts";
import { contextKeyFor, SESSIONS_DIR } from "../core/trellis.ts";
import { createConfigRootResolver } from "../core/config.ts";

const taskRef = ".trellis/tasks/demo";
function harness(voidOn = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-c1-")));
  const sessionId = `c1-${root.split("/").pop()}`;
  mkdirSync(join(root, taskRef), { recursive: true });
  writeFileSync(join(root, taskRef, "task.json"), JSON.stringify({ id: "demo", status: "in_progress" }));
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, modules: {} }));
  mkdirSync(join(root, SESSIONS_DIR), { recursive: true });
  writeFileSync(join(root, SESSIONS_DIR, `${contextKeyFor(sessionId)}.json`), JSON.stringify({ current_task: taskRef }));
  const listeners = new Map<string, Set<(event: any, ctx: any) => any>>();
  const bus = new Map<string, Set<(event: any) => void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  const messages: string[] = [];
  const switches = new Set(["capacity", "lane-worktree"]);
  let limit: number | null = 2;
  let unknown = false;
  let active = 0;
  const roots: { id: string; state: string }[] = [];
  const targets = new Map<string, Record<string, unknown>>();
  const requests: any[] = [];
  let spawnHandler: ((request: any, reply: (data: unknown) => void) => void) | undefined;
  const host: PiRuntimeHost = {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set);
      if (!voidOn) return () => { set.delete(handler); };
    },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message.content); },
    events: {
      on(name, handler) {
        const set = bus.get(name) ?? new Set(); set.add(handler); bus.set(name, set);
        return () => { set.delete(handler); };
      },
      emit(name, request: any) {
        if (name !== "subagents:rpc:v1:request") return;
        requests.push(request);
        const reply = (data: unknown, success = true) => queueMicrotask(() => {
          for (const handler of bus.get(`subagents:rpc:v1:reply:${request.requestId}`) ?? []) handler({
            version: 1, requestId: request.requestId, success, ...(success ? { data } : { error: { code: "not_found", message: "unknown alias" } }),
          });
        });
        if (request.method === "ping") reply({ version: 1, methods: ["ping", "status", "spawn"],
          capabilities: { status: true, asyncSpawn: true, fleetStatus: { version: 1 }, asyncStatusSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot" } },
          events: { asyncComplete: "subagent:async-complete" }, session: { sessionId } });
        else if (request.method === "status") {
          const id = request.params?.id;
          if (id) { const details = targets.get(id); reply({ details }, details !== undefined); }
          else reply(unknown ? {} : {
            fleet: { version: 1, entries: [], totalActive: 99, omitted: 99, topLevelAsyncCapacity: { used: active, limit: 10 } },
            asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1,
              caps: { maxRuns: 100, maxChildrenPerNode: 20, maxDepth: 4, maxStringLength: 1000, maxSerializedBytes: 100000 },
              omitted: { runs: Math.max(0, active - roots.length), children: 0, byteLimitExceeded: false },
              runs: roots.map((run) => ({ ...run, kind: "subagent", label: "child" })) },
          });
        } else if (request.method === "spawn") spawnHandler?.(request, reply);
      },
    },
  };
  const runtime = { cwd: root, sessionId, sessionEpoch: 1, enabled: true, isChild: false, refresh() {},
    // The temp directory is not a repository: `no-repo` resolves to itself, which
    // is what the lane ledger's project gate has always read.
    configRoots: createConfigRootResolver(),
    control: { moduleEnabled: (id: string) => switches.has(id), subagentConcurrency: () => limit } } as RuntimeContext;
  const ctx = () => ({ cwd: root, mode: "tui", sessionManager: { getSessionId: () => runtime.sessionId } });
  capacityModule.activate!(host, runtime);
  laneWorktreeModule.activate!(host, runtime);
  laneWorktreeModule.onSessionActivate!(host, runtime);
  async function emit(name: string, event: any) {
    const results = [];
    for (const handler of listeners.get(name) ?? []) {
      const result = await handler(event, ctx()); results.push(result);
      if (name === "tool_call" && result?.block) break;
    }
    return results;
  }
  return { root, host, runtime, ctx, messages, switches, commands, roots, targets, requests,
    limit: (value: number | null) => { limit = value; }, active: (value: number) => { active = value; },
    unknown: (value: boolean) => { unknown = value; },
    spawn: (handler: NonNullable<typeof spawnHandler>) => { spawnHandler = handler; },
    emit, count: (name: string) => listeners.get(name)?.size ?? 0,
    call: (id: string, input: Record<string, unknown> = {}) => emit("tool_call", { toolName: "subagent", toolCallId: id,
      input: { agent: "worker", task: `Active task: ${taskRef}`, ...input } }),
    result: (id: string, details?: unknown, isError = false) => emit("tool_result", { toolName: "subagent", toolCallId: id, details, isError }),
    notice: (runs: unknown[], content = "native completion") => emit("message_end", { message: { customType: "subagent-notify", details: { runs }, content } }),
    lanes: async () => { await commands.get("Coworkflow:lanes")!.handler("", ctx()); return messages.at(-1)!; },
    close: () => { capacityModule.onSessionEnd!(host, runtime); laneWorktreeModule.onSessionEnd!(host, runtime); rmSync(root, { recursive: true, force: true }); },
  };
}
const blocked = (results: any[]) => results.some((result) => result?.block === true);

test("capacity handlers: fresh status, alias reconciliation, failed-result release and management exclusion", async () => {
  const h = harness();
  try {
    assert.equal(blocked(await h.call("one")), false);
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 1);
    // The direct call is native before its result arrives; bounded roots omit it.
    h.active(1); h.targets.set("one", { runId: "native-one", toolCallId: "one" });
    assert.equal(blocked(await h.call("two")), false, "one native + one pending fits two; no duplicate count");
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 1);
    assert.equal(blocked(await h.call("three")), true);
    await h.result("two", undefined, true);
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 0);
    const count = h.requests.length;
    for (const input of [{ action: "status" }, { action: "stop" }, { action: "lane.recordMerge" }, { async: false }]) {
      assert.equal(blocked(await h.call("management", input)), false);
    }
    assert.equal(h.requests.length, count, "no public capacity read for non-async execution");
    h.active(0); h.roots.push({ id: "native-one", state: "paused" });
    assert.equal(blocked(await h.call("four")), false, "paused history does not consume an async owner slot");
    await h.result("four", { runId: "native-four" });
    await h.notice([{ runId: "native-four", status: "running" }, { runId: "native-four" }]);
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 1, "pending/malformed notice cannot release capacity");
    await h.notice([{ runId: "native-four", status: "completed" }]);
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 0, "structured terminal notice releases the exact bound reservation");
    assert.equal(h.messages.length, 0, "passive bookkeeping sends no messages");
  } finally { h.close(); }
});

test("capacity handlers: unknown configured capacity refuses, gates are live, replacement clears reservations", async () => {
  const h = harness(true);
  try {
    h.unknown(true);
    assert.equal(blocked(await h.call("unknown")), true);
    assert.equal(existingSubagentsBridge(h.host)?.activity().kind, "unknown");
    h.limit(null);
    assert.equal(blocked(await h.call("unlimited")), false);
    h.limit(1); h.unknown(false);
    assert.equal(blocked(await h.call("first")), false);
    assert.equal(blocked(await h.call("second")), true);
    h.switches.delete("capacity");
    assert.equal(blocked(await h.call("disabled")), false);
    await h.result("first", undefined, true);
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 0, "switching off never prevents result cleanup");
    h.switches.add("capacity");
    assert.equal(blocked(await h.call("held")), false);
    const count = h.count("tool_call");
    capacityModule.onSessionEnd!(h.host, h.runtime); laneWorktreeModule.onSessionEnd!(h.host, h.runtime);
    assert.equal(existingSubagentsBridge(h.host), undefined);
    h.runtime.sessionEpoch++; h.runtime.sessionId = "replacement";
    capacityModule.activate!(h.host, h.runtime); laneWorktreeModule.activate!(h.host, h.runtime);
    assert.equal(h.count("tool_call"), count, "void-returning hooks are retained once");
    assert.equal(blocked(await h.call("new-session")), false);
    assert.equal(existingSubagentsBridge(h.host)?.pending(), 1);
  } finally { h.close(); }
});

test("lanes: production result/notification handlers preserve per-child identity, state and patch", async () => {
  const h = harness(); h.limit(null);
  try {
    await h.call("workflow");
    await h.result("workflow", { runId: "workflow-run", background: true, missionId: "mission" });
    assert.match(await h.lanes(), /run workflow-run[^\n]*\[未知\]/, "launch is not terminal success");
    const handoff = join(h.root, "handoff.json");
    writeFileSync(handoff, JSON.stringify({ version: 1, runId: "workflow-run", groups: [{ stepIndex: 0,
      children: [
        { index: 0, runId: "impl", workflowKey: "implement", agent: "writer", status: "completed", patch: { path: "/artifacts/impl.patch", branch: "impl" } },
        { index: 1, runId: "review", workflowKey: "review", agent: "checker", status: "failed", patch: { path: "/artifacts/review.patch", branch: "review" } },
      ], cleanup: { tasks: [{ index: 0, path: "/trees/impl" }, { index: 1, path: "/trees/review" }] } }] }));
    await h.notice([{ runId: "workflow-run", workflowRunId: "workflow-run", status: "failed", handoffPath: handoff,
      childRuns: [{ runId: "review", workflowKey: "review", agent: "checker", status: "failed" },
        { runId: "impl", workflowKey: "implement", agent: "writer", status: "completed" }] }]);
    const output = await h.lanes();
    const impl = output.slice(output.indexOf("  - impl"), output.indexOf("  - review"));
    const review = output.slice(output.indexOf("  - review"), output.indexOf("合并计划"));
    assert.match(impl, /\[completed\]/); assert.match(impl, /impl\.patch/); assert.doesNotMatch(impl, /review\.patch/);
    assert.match(review, /\[failed\]/); assert.match(review, /review\.patch/); assert.doesNotMatch(review, /impl\.patch/);
    const stored = JSON.parse(readFileSync(join(h.root, NATIVE_RUNS_FILE), "utf8"));
    assert.equal(stored.runs.length, 1);
    assert.equal(stored.runs[0].runId, "workflow-run"); assert.equal(stored.runs[0].missionId, "mission");
    for (const key of ["status", "children", "patches", "task", "root"]) assert.equal(key in stored.runs[0], false, key);
    const before = readFileSync(join(h.root, NATIVE_RUNS_FILE), "utf8");
    await h.notice([], `Child run: fabricated\nParallel handoff: /wrong.json`);
    await h.notice([{ runId: "unrelated", status: "completed", handoffPath: "/wrong.json" }]);
    assert.equal(readFileSync(join(h.root, NATIVE_RUNS_FILE), "utf8"), before);
  } finally { h.close(); }
});

test("lanes: adoption gates, explicit invalid tasks, direct result children and legacy pointers survive", async () => {
  const h = harness(true); h.limit(null);
  try {
    await h.call("invalid", { task: "Active task: .trellis/tasks/missing" });
    await h.result("invalid", { runId: "invalid-run" });
    assert.deepEqual(readTaskLinks(h.root, taskRef), []);
    h.runtime.enabled = false; // Passive adoption remains permitted with this module on.
    await h.call("direct");
    await h.result("direct", { runId: "direct", results: [{ index: 7, agent: "worker", execution: { status: "failed" }, savedOutputPath: "/out/seven.md" }] });
    assert.equal(readTaskLinks(h.root, taskRef).length, 1);
    h.switches.delete("lane-worktree");
    await h.call("disabled"); await h.result("disabled", { runId: "disabled" });
    await h.notice([{ runId: "direct", status: "completed", handoffPath: "/ignored.json" }]);
    assert.equal(readTaskLinks(h.root, taskRef).length, 1);
    h.runtime.enabled = true;
    assert.match(await h.lanes(), /已关闭/);
    h.switches.add("lane-worktree");
    const handoff = join(h.root, "legacy-handoff.json");
    writeFileSync(handoff, JSON.stringify({ version: 1, runId: "legacy", groups: [{ stepIndex: 0,
      children: [{ index: 3, agent: "legacy-worker", status: "completed", patch: { path: "/legacy.patch" } }] }] }));
    const legacyDir = join(h.root, ".trellis", ".runtime", "lanes", "demo");
    mkdirSync(legacyDir, { recursive: true });
    const legacy = join(legacyDir, "legacy.json");
    const saved = JSON.stringify({ version: 1, runId: "legacy", taskRef, handoffPath: handoff });
    writeFileSync(legacy, saved);
    const output = await h.lanes();
    assert.match(output, /direct \/ index 7.*\[failed\]/);
    assert.match(output, /seven\.md/); assert.match(output, /legacy \/ index 3.*\[completed\]/);
    assert.match(output, /legacy\.patch/); assert.equal(readFileSync(legacy, "utf8"), saved);
    const count = h.count("message_end");
    laneWorktreeModule.onSessionEnd!(h.host, h.runtime);
    h.runtime.sessionEpoch++; h.runtime.sessionId = "new-session";
    laneWorktreeModule.activate!(h.host, h.runtime); laneWorktreeModule.onSessionActivate!(h.host, h.runtime);
    assert.equal(h.count("message_end"), count);
    assert.doesNotMatch(await h.lanes(), /index 7/, "old transient child observations do not leak into the new session");
  } finally { h.close(); }
});

test("lanes: main invocation applies only in the verified task tree and retains original artifact roots", async () => {
  const h = harness(); h.limit(null);
  try {
    const git = (args: string[], input?: string) => execFileSync("git", ["-C", h.root, ...args], { encoding: "utf8", input,
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@test",
        GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@test" } }).trim();
    git(["init", "-b", "main"]);
    const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
    const commit = git(["commit-tree", tree, "-m", "fixture"]); git(["update-ref", "refs/heads/main", commit]);
    const worktree = join(h.root, "task tree"); git(["worktree", "add", "-b", "task", worktree]);
    const taskFile = join(h.root, taskRef, "task.json");
    writeFileSync(taskFile, JSON.stringify({ worktree_path: worktree, branch: "task" }));
    mkdirSync(join(h.root, "artifacts"));
    writeFileSync(join(h.root, "artifacts", "handoff.json"), JSON.stringify({ version: 1, runId: "lane-run",
      cleanupEligibility: { state: "eligible", reason: "review evidence retained" }, merge: { mergeCommit: "reviewed-sha" },
      groups: [{ stepIndex: 0, children: [{ index: 0, runId: "child", status: "completed",
        patch: { path: "artifacts/child.patch", branch: "child-branch" } }],
        cleanup: { tasks: [{ index: 0, path: "/other-child-tree" }] } }] }));
    writeFileSync(join(h.root, "artifacts", "receipt.json"), JSON.stringify({ version: 1, workflowRunId: "lane-run",
      entries: { implement: { latestRunId: "child", outputReference: "artifacts/output.md" } } }));
    await h.call("lane-call");
    await h.result("lane-call", { runId: "lane-run", parallelHandoff: { version: 1, path: "artifacts/handoff.json" },
      workflowReceiptPath: "artifacts/receipt.json" });
    const output = await h.lanes();
    assert.ok(output.includes(`cd '${worktree}' && git apply --3way '${join(h.root, "artifacts/child.patch")}'`));
    assert.ok(!output.includes(`cd '${h.root}' && git apply`));
    assert.match(output, /child \(implement\).*\[completed\]/);
    assert.match(output, /output: artifacts\/output.md/);
    assert.ok(output.includes(`"handoffPath":"${join(h.root, "artifacts/handoff.json")}"`));
    assert.ok(output.includes(`"repo":"${h.root}"`), "cleanup retains the original repo root");
    const linksBefore = readFileSync(join(h.root, NATIVE_RUNS_FILE), "utf8");
    for (const [identity, reason] of [
      [{ branch: "task" }, /没有 worktree_path/],
      [{ worktree_path: h.root, branch: "main" }, /主 checkout/],
      [{ worktree_path: worktree, branch: "another-task" }, /Git 归属\/任务分支校验失败/],
    ] as const) {
      writeFileSync(taskFile, JSON.stringify(identity));
      const unavailable = await h.lanes();
      assert.match(unavailable, /缺少已验证的任务集成 worktree/);
      assert.match(unavailable, reason);
      assert.doesNotMatch(unavailable, /git apply/);
      assert.match(unavailable, /child \(implement\).*\[completed\]/);
      assert.match(unavailable, /artifacts\/child.patch/);
      assert.match(unavailable, /证据状态: eligible/);
      assert.match(unavailable, /已记录合并: commit reviewed-sha/);
      assert.match(unavailable, /lane.recordMerge/);
      assert.match(unavailable, /worktree.cleanup/);
    }
    assert.equal(readFileSync(join(h.root, NATIVE_RUNS_FILE), "utf8"), linksBefore, "planning does not rewrite identity links");
  } finally { h.close(); }
});

test("own RPC command and direct async tools share admission before the spawn receipt", async () => {
  const h = harness();
  const { subagentsModule, syncSubagentsRuntime } = await import("../modules/subagents/index.ts");
  try {
    const git = (args: string[], input?: string) => execFileSync("git", ["-C", h.root, ...args], { encoding: "utf8", input,
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@test",
        GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@test" } }).trim();
    git(["init", "-b", "main"]);
    const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
    const commit = git(["commit-tree", tree, "-m", "fixture"]); git(["update-ref", "refs/heads/main", commit]);
    const worktree = join(h.root, "worktree"); git(["worktree", "add", "-b", "task", worktree]);
    writeFileSync(join(h.root, taskRef, "task.json"), JSON.stringify({ worktree_path: worktree, branch: "task" }));
    h.switches.add("subagents");
    subagentsModule.activate!(h.host, h.runtime); subagentsModule.onSessionActivate!(h.host, h.runtime);
    await syncSubagentsRuntime(h.host, h.runtime);
    let receipt: (() => void) | undefined;
    let started!: () => void;
    const emitted = new Promise<void>((resolve) => { started = resolve; });
    h.spawn((request, reply) => {
      const alias = `rpc-spawn-${request.requestId}`;
      h.active(1); h.targets.set(alias, { runId: "rpc-run", toolCallId: alias });
      receipt = () => reply({ details: { runId: "rpc-run" }, text: "accepted" });
      started();
    });
    const running = h.commands.get("Coworkflow:run")!.handler("", h.ctx());
    // A bounded rejection if prerequisites fail, rather than hanging this fixture.
    await Promise.race([emitted, Promise.resolve(running).then(() => { throw new Error(h.messages.join("\n")); })]);
    assert.equal(blocked(await h.call("direct-during-spawn")), false, "the native RPC owner counts once, before its receipt");
    assert.equal(blocked(await h.call("third")), true);
    receipt!(); await running;
    assert.equal(h.requests.filter((request) => request.method === "spawn").length, 1);
    assert.equal(readTaskLinks(h.root, taskRef).some((link) => link.runId === "rpc-run"), true);
    h.limit(1);
    await h.commands.get("Coworkflow:run")!.handler("", h.ctx());
    assert.equal(h.requests.filter((request) => request.method === "spawn").length, 1, "own command obeys the same limit");
  } finally { subagentsModule.onSessionEnd!(h.host, h.runtime); h.close(); }
});

test("lanes: exit state prints cleanup only when the branch is merged and the worktree is clean", async () => {
  const h = harness(); h.limit(null);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@test" };
  const git = (cwd: string, args: string[], input?: string) => execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], env }).trim();
  const fingerprint = () => JSON.stringify({
    refs: git(h.root, ["for-each-ref"]),
    worktrees: git(h.root, ["worktree", "list", "--porcelain"]),
    main: git(h.root, ["status", "--porcelain", "--untracked-files=normal"]),
  });
  try {
    git(h.root, ["init", "-b", "main"]);
    writeFileSync(join(h.root, "base.txt"), "base\n");
    git(h.root, ["add", "base.txt"]);
    git(h.root, ["commit", "-m", "base"]);
    const worktree = join(h.root, "task tree");
    git(h.root, ["worktree", "add", "-b", "task", worktree]);
    const taskFile = join(h.root, taskRef, "task.json");
    writeFileSync(taskFile, JSON.stringify({ worktree_path: worktree, branch: "task", base_branch: "main" }));
    writeFileSync(join(worktree, "work.txt"), "work\n");
    git(worktree, ["add", "work.txt"]);
    git(worktree, ["commit", "-m", "task work"]);

    // Unmerged: a clean worktree is not enough, and the ahead count is reported.
    const unmerged = await h.lanes();
    assert.match(unmerged, /尚未合并进 main（还领先 1 个提交）/);
    assert.match(unmerged, /不提供清理命令: 前提未满足 —— 分支 task 未合并进 main/);
    assert.doesNotMatch(unmerged, /worktree remove/);
    assert.doesNotMatch(unmerged, /branch -[dD]/);

    // Merged but dirty: still no command, and the dirty precondition is named.
    git(h.root, ["merge", "--ff-only", "task"]);
    writeFileSync(join(worktree, "work.txt"), "uncommitted\n");
    const dirty = await h.lanes();
    assert.match(dirty, /已合并进 main（领先 0 个提交）/);
    assert.match(dirty, /工作树状态: 1 处未提交改动/);
    assert.match(dirty, /不提供清理命令: 前提未满足 —— 工作树有 1 处未提交改动/);
    assert.doesNotMatch(dirty, /worktree remove/);
    assert.doesNotMatch(dirty, /branch -[dD]/);

    // Merged and clean: the exact commands, with no forced variants anywhere.
    git(worktree, ["checkout", "--", "work.txt"]);
    const before = fingerprint();
    const clean = await h.lanes();
    assert.match(clean, /分支 task: 已合并进 main（领先 0 个提交）/);
    assert.match(clean, /工作树状态: 干净，没有未提交的改动/);
    assert.ok(clean.includes(`git -C '${h.root}' worktree remove '${worktree}'`), clean);
    assert.ok(clean.includes(`git -C '${h.root}' branch -d 'task'`), clean);
    assert.doesNotMatch(clean, /--force|\s-D\s/, "never suggests a forced removal");
    assert.equal(fingerprint(), before, "rendering the report mutates no repository state");

    // A recorded worktree that is gone is stated, and prints nothing destructive.
    writeFileSync(taskFile, JSON.stringify({ worktree_path: join(h.root, "gone tree"), branch: "task", base_branch: "main" }));
    const missing = await h.lanes();
    assert.match(missing, /worktree: 未满足前提 —— .*不存在或不是目录/);
    assert.match(missing, /任务 worktree 前提未满足/);
    assert.doesNotMatch(missing, /worktree remove/);
    assert.doesNotMatch(missing, /branch -[dD]/);
    assert.equal(fingerprint(), before, "a failed precondition leaves the repository untouched");
  } finally { h.close(); }
});

/**
 * The base branch is a property of the repository, not a constant.
 *
 * The exit check defaulted to `main`, so a repository whose default branch is `master`
 * (or anything else) got a verdict against a branch that may not exist — "尚未合并进 main"
 * for work that was merged, or the reverse, with nothing saying the branch was a guess.
 */
test("lanes: the exit check reads the repository's base branch instead of assuming main", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-base-"));
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
  try {
    git(["init", "-q", "-b", "trunk"]);
    git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
    const { baseBranchProbe } = await import("../modules/lane-worktree/index.ts");
    // No origin/HEAD here, so the branch that actually exists decides it.
    assert.equal(baseBranchProbe(root), "trunk");
    // A single-branch repository answers with that branch, whatever it is called.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "cw-base2-"));
    execFileSync("git", ["-C", other, "init", "-q", "-b", "spine"]);
    execFileSync("git", ["-C", other, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "i"]);
    assert.equal(baseBranchProbe(other), "spine", "the checked-out default branch is the honest answer");
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
