/**
 * The configuration root, resolved once per runtime.
 *
 * Two defects are covered here, and both are about *when* the answer is
 * computed rather than what it is:
 *
 *   - `resolveLoadState()` runs at the start of every command and every agent
 *     turn, and gates run on `tool_call` and `before_agent_start`. Each call used
 *     to be `configRoot(cwd)` → three `execFileSync("git", …)`, so one dispatch
 *     cost several child processes.
 *   - `runGit()` swallowed failure and returned the caller's cwd, which made "git
 *     could not answer" indistinguishable from "the config is right here" and let
 *     module switches drift with the working directory.
 *
 * The first test drives the resolver directly with an injected runner, which is
 * the only seam a test may use for `git`. The second drives the real extension
 * through a fake `git` on `PATH`, so "no subprocess per gate evaluation" is
 * measured on the production path instead of asserted about a stub.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  configRootNote,
  createConfigRootResolver,
  readConfigAt,
  type GitAnswer,
  type GitRunner,
} from "../core/config.ts";
import { mainCheckout } from "../core/trellis.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

/** A runner that answers like a repository and counts what it was asked. */
function countingGit(root: string): { git: GitRunner; calls: () => string[][] } {
  const calls: string[][] = [];
  return {
    calls: () => calls,
    git: (cwd, args): GitAnswer => {
      calls.push([cwd, ...args]);
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { kind: "ok", out: join(root, "linked") };
      // The supported spelling. The old `--absolute-git-common-dir` is not a git
      // option: real git echoes it back with exit 0, which is why this fake used to
      // accept a flag production git never honoured.
      if (command === "rev-parse --path-format=absolute --git-common-dir") {
        return { kind: "ok", out: join(root, ".git") };
      }
      if (command === "rev-parse --git-common-dir") return { kind: "ok", out: ".git" };
      return { kind: "failed", reason: `unexpected: ${command}` };
    },
  };
}

test("config root: repeated reads in one session spawn no git, and epoch/cwd re-resolve", () => {
  const repository = "/nowhere/main";
  const { git, calls } = countingGit(repository);
  let epoch = 1;
  const resolver = createConfigRootResolver({ epoch: () => epoch, runGit: git });

  // A linked worktree and its own subdirectory are the same session: the first
  // read resolves the main checkout, the rest reuse it.
  assert.deepEqual(resolver.resolve("/nowhere/linked/src"), { kind: "resolved", root: repository });
  const afterFirst = calls().length;
  assert.equal(afterFirst, 2, "one toplevel read and one common-dir read, nothing more");
  for (let index = 0; index < 5; index += 1) {
    assert.equal(resolver.root("/nowhere/linked/src"), repository);
    assert.equal(resolver.resolve("/nowhere/linked/src").kind, "resolved");
  }
  assert.equal(calls().length, afterFirst, "repeated reads within one session spawn no git");
  assert.deepEqual(resolver.resolve("/nowhere/linked/src/"), { kind: "resolved", root: repository }, "the same path spelled differently is the same key");
  assert.equal(calls().length, afterFirst, "a trailing slash is not a different cwd");

  // The session boundary: the orchestrator increments the epoch on
  // `session_start`, and the resolver must not answer from the old session.
  epoch += 1;
  assert.equal(resolver.root("/nowhere/linked/src"), repository);
  assert.equal(calls().length, afterFirst + 2, "a new epoch re-resolves");

  // A cwd switch within one session (a lane or worktree change) re-resolves too,
  // so no answer leaks across worktrees.
  const before = calls().length;
  resolver.root("/nowhere/other-worktree");
  assert.equal(calls().length, before + 2, "a cwd change re-resolves");
  assert.equal(calls()[before]?.[0], "/nowhere/other-worktree");
});

test("config root: a git failure is unresolved, never the current directory", () => {
  const failure: GitAnswer = { kind: "failed", reason: "fatal: unable to read tree" };
  const resolver = createConfigRootResolver({ runGit: () => failure });

  const directory = mkdtempSync(join(tmpdir(), "coworkflow-root-failure-"));
  try {
    // A project that *is* initialized here: the point is that a failed
    // resolution must not read it, because nothing established that this is the
    // checkout whose config governs the session.
    mkdirSync(join(directory, ".pi"), { recursive: true });
    writeFileSync(join(directory, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, modules: { panel: true } }));

    const resolution = resolver.resolve(directory);
    assert.equal(resolution.kind, "unresolved");
    assert.equal(resolver.root(directory), null, "an unresolvable root is null, not the cwd");
    assert.equal(readConfigAt(resolver, directory), null, "no config is read through an unresolved root");

    const note = configRootNote(resolution, directory);
    assert.ok(note?.includes("无法解析"), "the state is reportable, and says so");
    assert.ok(note?.includes("fatal: unable to read tree"), "and carries the reason git gave");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("config root: outside a repository the root is the directory itself, and said so", () => {
  const resolver = createConfigRootResolver({ runGit: () => ({ kind: "no-repo" }) });
  const directory = mkdtempSync(join(tmpdir(), "coworkflow-root-norepo-"));
  try {
    assert.deepEqual(resolver.resolve(directory), { kind: "no-repo", root: directory });
    assert.equal(resolver.root(directory), directory, "a real answer, unlike a failure");
    assert.match(configRootNote({ kind: "no-repo", root: directory }, directory) ?? "", /不在 git 仓库内/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── The production path: gate evaluation through the real extension ────

interface Harness {
  /** Every `git` invocation the production runner made, in order. */
  gitCalls(): string[];
  /** Make git answer a failure from now on. */
  breakGit(): void;
  control: ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
  /** `/Coworkflow:status` output, which is where an unresolved root has to show. */
  status(): string;
  /** Restore `PATH`/cwd and drop the fixture. Called from the test's `finally`. */
  close(): void;
}

/**
 * A `git` on `PATH`, so what is measured is the production `execFileSync` runner
 * rather than a stub standing in for it. A test that counts calls on an injected
 * runner cannot prove the *gate path* stopped spawning; this one can.
 */
async function loadProduction(repository: string): Promise<Harness> {
  const fixture = mkdtempSync(join(tmpdir(), "coworkflow-root-prod-"));
  const bin = join(fixture, "bin");
  const log = join(fixture, "git.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      // `-C <dir> <command…>`: drop both so `$1 $2` is the command.
      "shift 2",
      'if [ -n "$FAKE_GIT_FAIL" ]; then',
      '  printf "fatal: unable to read tree\\n" >&2',
      "  exit 128",
      "fi",
      'case "$1 $2" in',
      `  "rev-parse --show-toplevel") printf '%s\\n' '${repository}'; exit 0;;`,
      `  "rev-parse --path-format=absolute --git-common-dir") printf '%s\\n' '${repository}/.git'; exit 0;;`,
      `  "rev-parse --git-common-dir") printf '.git\\n'; exit 0;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  mkdirSync(join(repository, ".pi"), { recursive: true });
  writeFileSync(
    join(repository, ".pi", "Coworkflow.json"),
    JSON.stringify({ version: 1, autoEnable: true, modules: { panel: true, subagents: true } }),
  );

  const saved = { cwd: process.cwd(), path: process.env.PATH };
  process.chdir(repository);
  // The fake stays on `PATH` for the harness's whole life, not just its load: a
  // resolver that wrongly re-resolved would otherwise reach the *real* git, and
  // the call count would miss exactly the spawns this test exists to catch.
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  const reset = (): void => {
    process.chdir(saved.cwd);
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    delete process.env.FAKE_GIT_FAIL;
  };
  try {
    // A fresh factory call is a fresh runtime, and its resolver is new too: that
    // is exactly the boundary a replacement session gives us.
    const loaded = (await import(`${here("../extensions/coworkflow.ts")}?root-${Date.now()}-${Math.random()}`)) as {
      default: (host: unknown) => void;
      controlSurface: () => ReturnType<(typeof import("../extensions/coworkflow.ts"))["controlSurface"]>;
    };
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
    const messages: string[] = [];
    loaded.default({
      on: () => () => {},
      registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, spec);
      },
      sendMessage(message: { content: string }) {
        messages.push(message.content);
      },
    });
    return {
      control: loaded.controlSurface(),
      close: reset,
      status() {
        const command = commands.get("Coworkflow:status");
        assert.ok(command, "status is always registered");
        const before = messages.length;
        command.handler("", { cwd: repository, mode: "tui", sessionManager: { getSessionId: () => "root-session" } });
        return messages.splice(before).join("\n");
      },
      gitCalls: () => {
        try {
          return readFileSync(log, "utf-8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
      breakGit() {
        process.env.FAKE_GIT_FAIL = "1";
      },
    };
  } catch (error) {
    reset();
    rmSync(fixture, { recursive: true, force: true });
    throw error;
  }
}

test("config root: the gate path resolves once, so repeated module checks spawn no git", async () => {
  // `realpathSync`: on macOS `/var` is a symlink to `/private/var`, and the
  // resolver keys on the path the process reports, not on the spelling a test
  // happened to make up.
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-root-repo-")));
  const loaded = await loadProduction(repository);
  try {
    const { control } = loaded;
    // Load already resolved once: the extension reads the project's consent.
    const afterLoad = loaded.gitCalls().length;
    assert.ok(afterLoad >= 2, "load resolves the root through real git");

    assert.equal(control.moduleEnabled("panel"), true);
    assert.equal(control.moduleEnabled("subagents"), true);
    assert.equal(control.switches().panel, true);
    assert.equal(control.initialized(), true);
    assert.equal(control.configRoot(), repository);
    assert.equal(control.configRootNote(), null, "an ordinary resolution needs no note");
    for (let index = 0; index < 20; index += 1) control.moduleEnabled("panel");

    assert.equal(
      loaded.gitCalls().length,
      afterLoad,
      "twenty more gate evaluations — each of which used to spawn three processes — spawn nothing",
    );
  } finally {
    loaded.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

test("config root: a git failure surfaces as unresolved and reads no config, not the cwd", async () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-root-broken-")));
  // Break git *before* the runtime resolves anything: a fresh runtime is a
  // replacement session, and that is the boundary no previous answer may cross.
  const loaded = await loadProduction(repository);
  loaded.breakGit();
  const broken = await loadProduction(repository);
  try {
    assert.ok(broken.gitCalls().length >= 1, "the second runtime asked git, and git failed");
    assert.equal(loaded.control.moduleEnabled("panel"), true, "the first runtime answered before git broke");

    assert.equal(broken.control.configRoot(), null, "unresolved, not whatever directory it started in");
    assert.match(broken.control.configRootNote() ?? "", /无法解析/);
    assert.match(broken.control.configRootNote() ?? "", /unable to read tree/, "and names why");
    // The project *is* initialized where the cwd points. Reading it would be
    // precisely the silent fallback this change removes.
    assert.equal(broken.control.initialized(), false);
    assert.equal(broken.control.moduleEnabled("panel"), false);
    const switches = broken.control.switches();
    assert.equal(switches.panel, false, "no switch is read through a broken root");
    assert.equal(switches.subagents, false, "including the ones the project had switched on");
    // Nothing is written into a directory git could not confirm.
    assert.match(broken.control.setSwitch("panel", false), /无法解析/);
    // And the state is what `/Coworkflow:status` reports: an unresolved root is a
    // line of its own, not a project path that was guessed.
    const status = broken.status();
    assert.match(status, /配置根无法解析/);
    assert.match(status, /unable to read tree/);
    assert.ok(!status.includes(`配置: ${repository}`), "no project path is presented as the config");
    assert.match(status, /不列出模块开关/, "and the report says why the switches are missing instead of inventing them");
  } finally {
    broken.close();
    loaded.close();
    rmSync(repository, { recursive: true, force: true });
  }
});

/**
 * The main checkout must be found with a git option that exists.
 *
 * `rev-parse --absolute-git-common-dir` is not one: git echoes unknown `--`
 * arguments back on stdout with exit 0, so the probe read its own argument, every
 * caller kept the worktree as the "main" root, and a fake git that answered the
 * flag hid it. This drives real git against a real linked worktree, so the
 * regression cannot be satisfied by a stub again.
 */
test("config root: a real linked worktree resolves to the main checkout", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-root-real-")));
  const repo = join(base, "repo");
  const linked = join(base, "linked");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): boolean =>
    spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).status === 0;
  try {
    assert.ok(git("init", "-q"), "temp repo");
    assert.ok(git("config", "user.email", "t@example.test"));
    assert.ok(git("config", "user.name", "t"));
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    assert.ok(git("add", "seed.txt"));
    assert.ok(git("commit", "-q", "-m", "seed"));
    assert.ok(git("worktree", "add", "-q", "-b", "feat/x", linked), "linked worktree");

    // The resolver, through production git — no injected runner.
    const resolver = createConfigRootResolver();
    assert.deepEqual(resolver.resolve(linked), { kind: "resolved", root: repo },
      "a worktree only carries committed files, so its config lives in the main checkout");
    assert.deepEqual(resolver.resolve(repo), { kind: "resolved", root: repo });

    // And the older helper the lanes/trellis code still calls agrees with it.
    assert.equal(mainCheckout(linked), repo);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
