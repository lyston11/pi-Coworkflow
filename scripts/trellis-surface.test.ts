/**
 * Contract tests for the kind-only Trellis surface.
 *
 * Two things broke silently before and must not again:
 *
 *   - `.pi/agents/trellis-*.md` came back after `trellis update`, because `-s`
 *     protects *modified* files and a deleted file is not a modified one. The
 *     guard has to run on every init, so it has to be idempotent: second run
 *     deletes nothing, reports nothing alarming, and leaves every other agent
 *     definition alone.
 *   - `.trellis/workflow.md` carries eleven platforms in one file. Editing the
 *     Pi blocks is the whole task; touching a Claude Code / Kiro / Gemini block
 *     would silently change how those platforms dispatch. The non-Pi text is
 *     pinned by a digest of its own bytes, so a change there is a deliberate
 *     edit to this test rather than a side effect of the next rewrite.
 *
 * Every test runs in a temp directory except the workflow read, which only
 * reads the checked-in document.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = join(ROOT, ".trellis", "workflow.md");

// ── platform block parsing ────────────────────────────────────────────

/**
 * Split a workflow document into the bodies of its platform blocks.
 *
 * A platform block opens with `[Claude Code, Cursor, …]` and closes with
 * `[/…]`; task-state blocks look identical but carry a `:` in the marker
 * (`[workflow-state:in_progress]`) and are not platform-specific, so they are
 * left in the surrounding text.
 */
function platformBlocks(md: string): { pi: string[]; other: string[]; outside: string[] } {
  const pi: string[] = [];
  const other: string[] = [];
  const outside: string[] = [];
  let current: { name: string; body: string[] } | null = null;

  for (const line of md.split("\n")) {
    const open = /^\[([^\]]+)\]$/.exec(line)?.[1];
    const close = /^\[\/([^\]]+)\]$/.exec(line)?.[1];
    if (current === null && open !== undefined && !open.includes(":")) {
      current = { name: open, body: [] };
      continue;
    }
    if (current !== null && close === current.name) {
      const body = current.body.join("\n");
      (current.name.split(",").map((part) => part.trim()).includes("Pi") ? pi : other).push(body);
      current = null;
      continue;
    }
    if (current !== null) current.body.push(line);
    else outside.push(line);
    // `close` is read above; an unmatched closer is document text.
  }
  return { pi, other, outside };
}

const digest = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

/**
 * sha256 of the non-Pi platform blocks, joined by `\n--\n`.
 *
 * Recorded from the document *before* the kind-only rewrite: identical digests
 * are the proof that Claude Code / Codex / Cursor / Gemini / Kiro / … see the
 * same bytes they saw yesterday. If a future edit to those blocks is intended,
 * recompute this with `node --experimental-strip-types scripts/trellis-surface.test.ts`
 * only after reading why it changed.
 */
const NON_PI_DIGEST = "2ec86d6d6f323134ac603d5b0da5a18dc5bf4982208244dcfc00d637952a880f";

const workflow = readFileSync(WORKFLOW, "utf-8");
const blocks = platformBlocks(workflow);

// ── .trellis/workflow.md: Pi speaks kinds, nobody else moves ──────────

test("workflow: the Pi blocks name kinds, never the trellis-* role agents", () => {
  assert.equal(blocks.pi.length, 5, "expected the five `[codex-inline, Pi, …]` blocks");
  const piText = blocks.pi.join("\n");
  for (const body of blocks.pi) {
    assert.doesNotMatch(body, /Agent type\*\*:\s*`trellis-/, "a Pi block still dispatches a trellis-* agent type");
    assert.doesNotMatch(
      body,
      /trellis-(implement|check|research)/,
      "a Pi block still mentions a trellis-* role agent instead of its kind",
    );
  }
  for (const kind of ["cw-executor", "cw-auditor", "cw-researcher"]) {
    assert.match(piText, new RegExp(kind), `the Pi blocks never dispatch ${kind}`);
  }
  assert.match(piText, /\/Coworkflow:status/, "the kind names must be pointed at /Coworkflow:status");
});

test("workflow: the Pi implement/check steps dispatch a kind and leave acceptance to the main session", () => {
  const piText = blocks.pi.join("\n");
  assert.match(piText, /Dispatch the implementation to the execute kind/);
  assert.match(piText, /Dispatch the quality check to the audit kind/);
  assert.match(piText, /Acceptance stays in the main session/);
  assert.match(piText, /A verdict is evidence, not acceptance/);
  // The old inline instruction told the main session to do the work itself.
  assert.doesNotMatch(piText, /^1\. Load the `trellis-before-dev` skill/m);
  assert.doesNotMatch(piText, /^\d\. Implement the code per reviewed artifacts$/m);
});

test("workflow: the non-Pi platform blocks are byte-identical to the pre-rewrite document", () => {
  assert.equal(blocks.other.length, 8, "expected the eight non-Pi platform blocks");
  assert.equal(digest(blocks.other.join("\n--\n")), NON_PI_DIGEST, "a non-Pi platform block changed");
  // Nothing of this package may leak into a platform this task does not own.
  assert.doesNotMatch(blocks.other.join("\n"), /cw-(executor|auditor|researcher)/);
  assert.doesNotMatch(blocks.outside.join("\n"), /cw-(executor|auditor|researcher)/);
  // The multi-platform dispatch protocol is intact, wording included.
  const otherText = blocks.other.join("\n");
  assert.equal(otherText.split("Agent type**: `trellis-implement`").length - 1, 3);
  assert.equal(otherText.split("Agent type**: `trellis-check`").length - 1, 1);
  assert.equal(otherText.split("Agent type**: `trellis-research`").length - 1, 1);
});

// ── modules/trellis: the role-agent guard ─────────────────────────────

const ROLE_AGENTS = ["trellis-implement.md", "trellis-check.md", "trellis-research.md"];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-trellis-"));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  mkdirSync(join(root, ".trellis"), { recursive: true });
  return root;
}

test("trellis: the role-agent guard deletes the three trellis-* agents and is idempotent", async () => {
  const { retireRoleAgents } = (await import("../modules/trellis/index.ts")) as typeof import(
    "../modules/trellis/index.ts"
  );
  const root = tempProject();
  for (const name of ROLE_AGENTS) writeFileSync(join(root, ".pi", "agents", name), `# ${name}\n`);
  // A project agent and this package's own kinds live in the same directory and
  // are none of the guard's business.
  writeFileSync(join(root, ".pi", "agents", "cw-executor.md"), "# cw-executor\n");
  writeFileSync(join(root, ".pi", "agents", "reviewer.md"), "# reviewer\n");

  const first = retireRoleAgents(root);
  assert.deepEqual(
    first.removed.map((rel) => rel.split("/").pop()),
    ROLE_AGENTS,
    "the first run must remove exactly the three role agents",
  );
  assert.deepEqual(first.kept, []);
  for (const name of ROLE_AGENTS) assert.equal(existsSync(join(root, ".pi", "agents", name)), false);
  assert.equal(existsSync(join(root, ".pi", "agents", "cw-executor.md")), true);
  assert.equal(existsSync(join(root, ".pi", "agents", "reviewer.md")), true);

  const second = retireRoleAgents(root);
  assert.deepEqual(second.removed, [], "the second run must not claim to have removed anything");
  assert.equal(second.kept.length, 3, "an absent role agent is reported as kept, not as an error");
  assert.deepEqual(retireRoleAgents(root), second, "repeated runs must be identical");
});

test("trellis: the guard reports the removal and names the rebuild it will undo", async () => {
  const { createContext } = (await import("../core/module.ts")) as typeof import("../core/module.ts");
  const { retireRoleAgentsAndReport } = (await import("../modules/trellis/index.ts")) as typeof import(
    "../modules/trellis/index.ts"
  );
  const reports = (dry: boolean, root: string): string[] => {
    const lines: string[] = [];
    const ctx = createContext({
      root,
      prefix: "",
      dry,
      report: (status, message) => lines.push(`${status}:${message}`),
    });
    retireRoleAgentsAndReport(ctx);
    return lines;
  };

  // Dry: the fact is described, nothing is deleted.
  const dryRoot = tempProject();
  for (const name of ROLE_AGENTS) writeFileSync(join(dryRoot, ".pi", "agents", name), "# role\n");
  const dryLine = only(reports(true, dryRoot));
  assert.match(dryLine, /^updated:会移除 3 个角色 agent/);
  for (const name of ROLE_AGENTS) assert.equal(existsSync(join(dryRoot, ".pi", "agents", name)), true);

  // Real: removed, and the report says `trellis update` puts them back.
  const line = only(reports(false, dryRoot));
  assert.match(line, /^updated:已移除 3 个角色 agent/);
  assert.match(line, /trellis update/);
  assert.match(line, /下次 init 会再移除/);

  // Already clean: one quiet line, no error, no panic.
  const cleanLine = only(reports(false, reportFreeRoot()));
  assert.match(cleanLine, /^ok:/);
  assert.match(cleanLine, /已不存在/);
});

/** Exactly one report line, so the assertions below read a string. */
function only(lines: string[]): string {
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line !== undefined);
  return line;
}

function reportFreeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-trellis-clean-"));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  return root;
}

test("trellis: the guard runs after `trellis update -s` and after a fresh `trellis init`", () => {
  const source = readFileSync(join(ROOT, "modules", "trellis", "index.ts"), "utf-8");
  const updateAt = source.indexOf('["update", "-s"]');
  const initAt = source.indexOf('["init", "--pi", "-y"]');
  assert.ok(updateAt > 0 && initAt > 0, "the aligner commands moved: this test reads the module source");
  const afterUpdate = source.indexOf("retireRoleAgentsAndReport(ctx)", updateAt);
  const afterInit = source.indexOf("retireRoleAgentsAndReport(ctx)", initAt);
  assert.ok(afterUpdate > updateAt, "no guard call after `trellis update -s`");
  assert.ok(afterInit > initAt, "no guard call after `trellis init`, which writes the same agents");
});
