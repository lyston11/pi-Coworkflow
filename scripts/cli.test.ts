/**
 * The terminal entry: `pi-coworkflow`.
 *
 * Driven as a real subprocess, because that is how an external agent uses it — an exit code and
 * stdout/stderr, not a function call. Every case asserts the exit code as well as the text: an
 * agent decides from the code, and a refusal that exited 0 would be a lie it cannot detect.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cli.ts");

/** A project directory with a git repo, which is what `mainCheckout` needs to resolve. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, modules: {} }));
  return root;
}

function cli(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    cwd,
    encoding: "utf-8",
  });
  return { code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

test("cli: list reports the shipped kinds and exits 0", () => {
  const root = project();
  try {
    const listed = cli(["kind", "list"], root);
    assert.equal(listed.code, 0, listed.stderr);
    for (const kind of ["executor", "auditor", "researcher"]) {
      assert.match(listed.stdout, new RegExp(kind), `lists ${kind}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: set writes a definition an external agent can then read back", () => {
  const root = project();
  try {
    const set = cli(
      ["kind", "set", "builder", "label=建造者", "role=implement", "maxConcurrent=3", "prompt=按派单实现。"],
      root,
    );
    assert.equal(set.code, 0, set.stderr);
    const file = join(root, ".pi", "Coworkflow", "agents", "builder.md");
    assert.match(readFileSync(file, "utf-8"), /role: implement/);

    // It shows up in the resolved table, marked as a project definition.
    const listed = cli(["kind", "list", "--json"], root);
    const parsed = JSON.parse(listed.stdout) as { kinds: { kind: string; agent: string; source: string }[] };
    const builder = parsed.kinds.find((entry) => entry.kind === "builder");
    assert.equal(builder?.agent, "cw-builder");
    assert.equal(builder?.source, "file");

    // And `show` reports the prompt the children would receive.
    const shown = cli(["kind", "show", "builder"], root);
    assert.equal(shown.code, 0);
    assert.match(shown.stdout, /按派单实现。/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: a rejected value exits non-zero and leaves the file byte-identical", () => {
  const root = project();
  try {
    assert.equal(cli(["kind", "set", "builder", "role=implement", "prompt=x"], root).code, 0);
    const file = join(root, ".pi", "Coworkflow", "agents", "builder.md");
    const before = readFileSync(file, "utf-8");

    for (const [args, code] of [
      [["kind", "set", "builder", "role=nope"], 1],
      [["kind", "set", "builder", "typo=1"], 2],
      [["kind", "set", "builder", "maxConcurrent=0"], 1],
      [["kind", "set", "builder"], 2],
      [["kind", "show"], 2],
      [["kind", "show", "nope"], 2],
      [["kind", "remove", "nope"], 2],
      [["nonsense"], 2],
    ] as [string[], number][]) {
      const result = cli(args, root);
      assert.equal(result.code, code, `${args.join(" ")} → ${result.stderr || result.stdout}`);
    }
    assert.equal(readFileSync(file, "utf-8"), before, "no refusal changed the file");

    // A refusal is machine-readable too: an agent that asked for JSON gets JSON.
    const refused = cli(["kind", "set", "builder", "role=nope", "--json"], root);
    assert.equal(refused.code, 1);
    const body = JSON.parse(refused.stdout) as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: remove deletes a project definition and refuses anything else", () => {
  const root = project();
  try {
    assert.equal(cli(["kind", "set", "builder", "role=implement", "prompt=x"], root).code, 0);
    const removed = cli(["kind", "remove", "builder"], root);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /不再存在/);
    // The shipped kinds are not deletable: they are the package's, not the project's.
    const shipped = cli(["kind", "remove", "executor"], root);
    assert.equal(shipped.code, 2);
    assert.match(shipped.stderr, /没有项目定义文件/);
    // And a path built from an argument cannot escape the definitions directory.
    assert.equal(cli(["kind", "remove", "../escape"], root).code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: --project acts on another directory, and a worktree resolves to its main checkout", () => {
  const root = project();
  const elsewhere = mkdtempSync(join(tmpdir(), "coworkflow-cli-elsewhere-"));
  try {
    // Run from a directory that is not the project.
    const listed = cli(["kind", "list", "--project", root, "--json"], elsewhere);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).project, realpathSync(root));

    // A linked worktree only carries committed files, so the definition must land in the main
    // checkout — where every gate reads it.
    writeFileSync(join(root, "README.md"), "# x\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
    const worktree = join(elsewhere, "wt");
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "task"], { cwd: root });
    const inWorktree = cli(["kind", "set", "builder", "role=check", "prompt=x"], worktree);
    assert.equal(inWorktree.code, 0, inWorktree.stderr);
    // git reports the resolved path, so compare resolved paths: on macOS /var is a symlink to
    // /private/var and the literal strings differ for the same directory.
    const real = realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(inWorktree.stdout, new RegExp(real), "written into the main checkout");
    assert.equal(
      readFileSync(join(root, ".pi", "Coworkflow", "agents", "builder.md"), "utf-8").includes("role: check"),
      true,
      "the definition is in the main checkout, not the worktree",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("cli: --help and --version answer without touching a project", () => {
  const root = project();
  try {
    const help = cli(["--help"], root);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /pi-coworkflow/);
    assert.match(help.stdout, /退出码/);
    assert.equal(cli(["--version"], root).code, 0);
    // No arguments is help, not an error: a bare invocation is a question, not a mistake.
    assert.equal(cli([], root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
