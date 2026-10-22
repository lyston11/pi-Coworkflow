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

/**
 * The file is the artifact.
 *
 * A kind's prompt is its own markdown document, so the CLI's main road is scaffold → edit →
 * `set --from` → check. These cases hold that road to its promises: the bytes the author wrote are
 * the bytes that land, a file the reader would refuse is never written, and `export` can hand back
 * a shipped kind's prompt so it can be edited rather than retyped.
 */
test("cli: scaffold leaves an editable file, and set --from applies it byte for byte", () => {
  const root = project();
  try {
    const scaffolded = cli(["kind", "scaffold", "builder"], root);
    assert.equal(scaffolded.code, 0, scaffolded.stderr);
    const file = join(root, ".pi", "Coworkflow", "agents", "builder.md");
    assert.ok(readFileSync(file, "utf-8").includes("这个 kind 的「subagents.md」"), "it explains itself");

    // A second scaffold refuses rather than clobbering; --force is the explicit way.
    assert.equal(cli(["kind", "scaffold", "builder"], root).code, 2);
    assert.equal(cli(["kind", "scaffold", "builder", "--force"], root).code, 0);

    // Edit it as a person (or an agent's editor) would, with formatting that matters.
    const edited = [
      "---",
      "label: 建造者",
      "role: implement",
      "description: 按派单实现一处改动",
      "maxConcurrent: 2",
      "---",
      "",
      "# 你负责什么",
      "",
      "按派单做完**一件**已定义的工作。",
      "",
      "- 交付物：改动的文件清单 + 跑过的命令；",
      "- 范围外的问题写进报告，不要顺手改。",
      "",
    ].join("\n");
    writeFileSync(file, edited);

    const applied = cli(["kind", "set", "builder", "--from", file], root);
    assert.equal(applied.code, 0, applied.stderr);
    // Byte for byte: headings, blank lines and emphasis must survive the round trip.
    assert.equal(readFileSync(file, "utf-8"), edited, "the authored bytes are what landed");

    const view = JSON.parse(cli(["kind", "show", "builder", "--json"], root).stdout) as {
      label: string;
      maxConcurrent: number;
      prompt: string;
    };
    assert.equal(view.label, "建造者");
    assert.equal(view.maxConcurrent, 2);
    assert.match(view.prompt, /按派单做完\*\*一件\*\*已定义的工作/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: export hands back a shipped kind's own prompt, and set --from rejects a bad file untouched", () => {
  const root = project();
  try {
    const out = join(root, "auditor.md");
    const exported = cli(["kind", "export", "auditor", "--out", out], root);
    assert.equal(exported.code, 0, exported.stderr);
    const text = readFileSync(out, "utf-8");
    // The shipped asset is a real document, not a one-liner: this is the thing that was too crude
    // to pass as `prompt="…"`.
    assert.ok(text.split("\n").length > 20, "the exported prompt is a document");
    assert.match(text, /^---\n/, "with frontmatter, so it can be edited and handed back");

    // Hand it back edited: the label changes, the prompt body is kept.
    writeFileSync(out, text.replace("label: 审计者", "label: 项目审计者"));
    assert.equal(cli(["kind", "set", "auditor", "--from", out], root).code, 0);
    assert.match(cli(["kind", "show", "auditor"], root).stdout, /项目审计者/);

    // A bad file is refused, and the existing definition is byte-identical afterwards.
    const target = join(root, ".pi", "Coworkflow", "agents", "auditor.md");
    const before = readFileSync(target, "utf-8");
    const bad = join(root, "bad.md");
    writeFileSync(bad, "---\nrole: nope\n---\n\nx\n");
    const refused = cli(["kind", "set", "auditor", "--from", bad], root);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /role 只能是/);
    assert.equal(readFileSync(target, "utf-8"), before, "a refusal changes nothing");

    // `--from` and `k=v` in one call is a usage error, not a silent precedence rule.
    assert.equal(cli(["kind", "set", "auditor", "--from", out, "label=x"], root).code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: check validates without writing and names what is wrong", () => {
  const root = project();
  try {
    assert.equal(cli(["kind", "scaffold", "builder"], root).code, 0);
    const checked = cli(["kind", "check"], root);
    assert.equal(checked.code, 0, checked.stderr);
    assert.match(checked.stdout, /定义文件全部可用/);

    // One broken file: check fails, names it, and writes nothing.
    const broken = join(root, ".pi", "Coworkflow", "agents", "broken.md");
    writeFileSync(broken, "---\nrole: nope\n---\n\nx\n");
    const before = readFileSync(broken, "utf-8");
    const failed = cli(["kind", "check"], root);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /broken：role 只能是/);
    assert.equal(readFileSync(broken, "utf-8"), before, "check never writes");

    // JSON form: an agent gets the failure rows, not a paragraph.
    const json = JSON.parse(cli(["kind", "check", "--json"], root).stdout) as {
      ok: boolean;
      failures: { kind: string; reason: string }[];
    };
    assert.equal(json.ok, false);
    assert.equal(json.failures[0]?.kind, "broken");

    // A kind with no definition file is a usage answer, not a validation failure.
    assert.equal(cli(["kind", "check", "nothing-here"], root).code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: prompt= warns that a shell string is the wrong tool for a system prompt", () => {
  const root = project();
  try {
    const result = cli(["kind", "set", "builder", "role=implement", "prompt=一行"], root);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /丢掉换行与格式/);
    assert.match(result.stderr, /--from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
