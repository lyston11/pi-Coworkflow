import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindLaunchTask, contextKeyFor, resolveChildTask } from "../core/trellis.ts";
import { placeChildLaunch, sessionWorktreeModule } from "../modules/session-worktree/index.ts";
import { subagentContextModule } from "../modules/subagent-context/index.ts";

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cw-runtime-contracts-"))), root = join(base, "repo");
  mkdirSync(root);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test", GIT_COMMITTER_EMAIL: "test@test", PYTHONDONTWRITEBYTECODE: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: "pipe" }).trim();
  git("init", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".trellis\n.pi\n");
  git("add", "."); git("commit", "-m", "fixture");
  const makeTask = (name: string) => {
    const dir = join(root, ".trellis/tasks", name), tree = join(base, `wt-${name}`);
    mkdirSync(dir, { recursive: true });
    git("worktree", "add", "-b", `feat/${name}`, tree);
    writeFileSync(join(dir, "task.json"), JSON.stringify({ id: name, worktree_path: tree, branch: `feat/${name}` }));
    writeFileSync(join(dir, "prd.md"), `TASK-${name}-CONTENT`);
    return { dir, tree };
  };
  const pointer = (name: string) => {
    const path = join(root, ".trellis/.runtime/sessions", `${contextKeyFor("parent")}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ current_task: `.trellis/tasks/${name}` }));
  };
  const runtime: any = { cwd: root, isChild: false, enabled: true, sessionId: "parent", sessionEpoch: 1,
    configRoots: { root: () => root }, control: { moduleEnabled: () => true } };
  return { root, base, env, git, makeTask, pointer, runtime, close: () => rmSync(base, { recursive: true, force: true }) };
}

test("task and cwd are bound together across pointer changes, queued starts, and explicit opt-out", () => {
  const f = fixture();
  try {
    const a = f.makeTask("a"), b = f.makeTask("b"), host = {};
    f.pointer("a");
    const first = placeChildLaunch(host, f.runtime, "Do A");
    const queued = bindLaunchTask(f.root, "parent", "Queued A");
    assert.equal(first.cwd, a.tree);
    f.pointer("b");
    assert.equal(placeChildLaunch(host, f.runtime, "Do B").cwd, b.tree);
    assert.equal(placeChildLaunch(host, f.runtime, queued.task).cwd, a.tree);
    assert.equal(placeChildLaunch(host, f.runtime, `Active task: ${a.dir}\nA`).cwd, a.tree);
    const independent = placeChildLaunch(host, f.runtime, "Active task: (none)\nIndependent");
    assert.notEqual(independent.cwd, a.tree); assert.notEqual(independent.cwd, b.tree);
    // The bound task wins over wherever the parent happens to sit: a child sent to B
    // runs in B even when the parent is already inside A's worktree.
    assert.equal(placeChildLaunch(host, { ...f.runtime, cwd: a.tree }, `Active task: ${b.dir}`).cwd, b.tree);
    assert.throws(() => placeChildLaunch(host, f.runtime, `Active task: ${b.dir}`, a.tree), /不一致/);
    f.git("-C", b.tree, "checkout", "-b", "foreign");
    assert.throws(() => placeChildLaunch(host, f.runtime, "Do B"), /校验失败/);
    assert.ok(existsSync(a.tree));
  } finally { f.close(); }
});

test("real task records are required; directories, corrupt records and symlink escapes fail closed", () => {
  const f = fixture();
  try {
    const a = f.makeTask("a");
    assert.equal(resolveChildTask(f.root, undefined, `Active task: ${a.dir}`).kind, "task");
    mkdirSync(join(f.root, ".trellis/spec"));
    for (const ref of [".trellis/spec", ".trellis/tasks", ".trellis/tasks/a/../..", ".trellis/tasks/a/task.json"]) {
      assert.equal(resolveChildTask(f.root, undefined, `Active task: ${ref}`).kind, "invalid", ref);
      assert.throws(() => bindLaunchTask(f.root, "parent", `Active task: ${ref}`), /无效/);
    }
    writeFileSync(join(a.dir, "task.json"), "[]");
    assert.equal(resolveChildTask(f.root, undefined, `Active task: ${a.dir}`).kind, "invalid");
    const outside = join(f.base, "outside"); mkdirSync(outside); writeFileSync(join(outside, "task.json"), "{}");
    symlinkSync(outside, join(f.root, ".trellis/tasks/escape"));
    assert.equal(resolveChildTask(f.root, undefined, "Active task: .trellis/tasks/escape").kind, "invalid");
  } finally { f.close(); }
});

test("child session entries preserve task/none across follow-up, reload and branch replay; retargeting blocks tools", () => {
  const f = fixture();
  try {
    const a = f.makeTask("a"), b = f.makeTask("b"); f.pointer("a");
    for (const initial of ["Active task: (none)", `Active task: ${a.dir}`]) {
      const entries: any[] = [];
      const runtime = { ...f.runtime, isChild: true, sessionId: "child", parentSessionId: "parent" };
      const makeHost = () => {
        const handlers: Record<string, any> = {};
        const host: any = { getSessionName: () => "cw-planner: probe", on: (name: string, fn: any) => { handlers[name] = fn; },
          appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }) };
        subagentContextModule.activate?.(host, runtime);
        const run = (prompt: string) => {
          const event = { prompt, systemPrompt: "BASE", systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> } };
          handlers.before_agent_start(event, { cwd: f.root, sessionManager: { getBranch: () => entries } });
          return event.systemPromptOptions.sections.pi_coworkflow_child!;
        };
        return { host, handlers, run };
      };
      let h = makeHost();
      const first = h.run(initial);
      f.pointer("b");
      const followup = h.run("Continue");
      assert.equal(followup, first);
      assert.equal(entries.length, 1, "one native custom entry, not one per turn");
      subagentContextModule.onSessionEnd?.(h.host, runtime);
      h = makeHost();
      assert.equal(h.run("Continue after reload"), first);
      assert.equal(entries.length, 1);
      h.run(`Active task: ${b.dir}`);
      assert.equal(h.handlers.tool_call({ toolName: "write" })?.block, true);
      h.run("Return to original work");
      assert.equal(h.handlers.tool_call({ toolName: "read" }), undefined);
      entries.length = 0; // Rewind to a branch before the binding entry.
      assert.match(h.run(`Active task: ${b.dir}`), /TASK-b-CONTENT/);
    }
    const handlers: Record<string, any> = {};
    subagentContextModule.activate?.({ on: (name, fn) => { handlers[name] = fn; }, getSessionName: () => "cw-planner" },
      { ...f.runtime, isChild: true, sessionId: "bad-child", parentSessionId: "parent" });
    handlers.before_agent_start({ prompt: "Active task: .trellis/spec", systemPrompt: "BASE" }, { cwd: f.root });
    assert.equal(handlers.tool_call({ toolName: "bash" }).block, true);
  } finally { f.close(); }
});

test("auto-worktree refuses foreign branch occupancy without rewriting task.json", () => {
  const f = fixture();
  try {
    const dir = join(f.root, ".trellis/tasks/c"), tree = join(f.base, "wt-c");
    mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ id: "c", branch: "feat/c" }); writeFileSync(join(dir, "task.json"), data);
    f.git("worktree", "add", "-b", "foreign", tree);
    const hook = new URL("../modules/worktree/assets/auto_worktree.py", import.meta.url).pathname;
    assert.throws(() => execFileSync("python3", [hook], { cwd: f.root, env: { ...f.env, TASK_JSON_PATH: join(dir, "task.json") }, stdio: "pipe" }), /belongs to foreign/);
    assert.equal(readFileSync(join(dir, "task.json"), "utf8"), data);
    assert.equal(f.git("-C", tree, "branch", "--show-current"), "foreign");
    f.git("-C", tree, "checkout", "-b", "feat/c");
    execFileSync("python3", [hook], { cwd: f.root, env: { ...f.env, TASK_JSON_PATH: join(dir, "task.json") }, stdio: "pipe" });
    assert.equal(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")).branch, "feat/c");
  } finally { f.close(); }
});
