/**
 * Contract tests for the kind-only Trellis surface.
 *
 * Two things broke silently before and must not again:
 *
 *   - An old project still carried `.pi/agents/trellis-*.md` after the surface
 *     moved to kinds. The guard that clears them is migration cleanup, so it has
 *     to be idempotent: a second run deletes nothing, reports nothing alarming,
 *     and leaves every other agent definition alone.
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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = join(ROOT, ".trellis", "workflow.md");

// ── .trellis/workflow.md: one body, no platform-specific dispatch ─────

/**
 * The workflow document no longer carries per-platform blocks.
 *
 * It used to hold eleven `[Claude Code, Cursor, …]` blocks that each named an agent
 * to dispatch, which meant every platform read a different protocol and a rewrite of
 * one block silently changed another platform's behaviour. The policy is now one
 * document: the main session implements and checks by default, and delegation is an
 * option that names "a kind /Coworkflow:status lists" instead of a fixed agent.
 *
 * What must hold is therefore structural: no platform marker survives, and the two
 * Phase 2 steps keep the direct-first wording that replaced the dispatch protocol.
 * A reintroduced block would bring back exactly the divergence this removed.
 */
const workflow = readFileSync(WORKFLOW, "utf-8");

test("workflow: no platform-specific block survives, so every platform reads one protocol", () => {
  const markers = [...workflow.matchAll(/^\[([^\]\n]+)\]$/gm)].map((match) => match[1]!);
  const platformMarkers = markers.filter((name) => !name.startsWith("/") && !name.includes(":"));
  assert.deepEqual(platformMarkers, [], "a platform block was reintroduced");
  assert.doesNotMatch(workflow, /Agent type\*\*/, "no step dispatches a fixed agent any more");
  assert.doesNotMatch(workflow, /trellis-(implement|check|research)/, "a retired role agent is still named");
  assert.doesNotMatch(workflow, /cw-(executor|auditor|researcher|planner|worker)/, "no kind is hardcoded");
});

test("workflow: implement and check default to the main session and keep acceptance there", () => {
  assert.match(workflow, /Implement directly in the main session by default/);
  assert.match(workflow, /Check the work directly in the main session by default/);
  assert.match(workflow, /Keep final acceptance, commits and integration in the main session/);
  assert.match(workflow, /A child's verdict is evidence, not final acceptance/);
  assert.match(workflow, /Optional delegation/, "delegation stays available, as an option");
  assert.match(workflow, /\/Coworkflow:status/, "the live kind list is where agent names come from");
  assert.match(workflow, /reviewer is read-only/, "a delegated review never edits the work it reviews");
  // The retired protocol: dispatch every step to a named agent.
  assert.doesNotMatch(workflow, /Spawn the (implement|check) sub-agent|Dispatch the (implementation|quality check) to/);
});

test("workflow: every task command it documents actually exists", () => {
  const help = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [join(ROOT, ".trellis", "scripts", "task.py"), "--help"],
    { encoding: "utf-8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  const documented = new Set([...workflow.matchAll(/task\.py ([a-z][a-z-]*)/g)].map((match) => match[1]!));
  assert.ok(documented.size > 0, "the document still documents the task CLI");
  for (const command of documented) {
    assert.ok(help.includes(command), `workflow documents a task command that does not exist: ${command}`);
  }
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

test("trellis: the guard is the migration cleanup, so a render removes the old role agents", async () => {
  const { createContext } = (await import("../core/module.ts")) as typeof import("../core/module.ts");
  const { renderTemplate } = (await import("../modules/trellis/index.ts")) as typeof import(
    "../modules/trellis/index.ts"
  );
  const root = tempProject();
  for (const name of ROLE_AGENTS) writeFileSync(join(root, ".pi", "agents", name), `# ${name}\n`);
  writeFileSync(
    join(root, ".trellis", "workflow.md"),
    "[codex-inline, Pi]\n- **Agent type**: `trellis-implement`\n[/codex-inline, Pi]\n",
  );

  const lines: string[] = [];
  renderTemplate(
    createContext({ root, prefix: "", dry: false, report: (status, message) => lines.push(`${status}:${message}`) }),
  );

  for (const name of ROLE_AGENTS) assert.equal(existsSync(join(root, ".pi", "agents", name)), false);
  const joined = lines.join("\n");
  assert.match(joined, /已从旧 Trellis 产物升级到本仓模板/);
  assert.match(joined, /已移除 3 个旧角色 agent/);
  assert.match(joined, /模板不含 trellis-\*/, "the report must say the template will not recreate them");
  // Nothing regenerates them any more: the template is the only source.
  assert.doesNotMatch(joined, /trellis update/);

  // Already clean: no removal line at all.
  const clean = tempProject();
  const cleanLines: string[] = [];
  renderTemplate(
    createContext({ root: clean, prefix: "", dry: false, report: (status, message) => cleanLines.push(`${status}:${message}`) }),
  );
  assert.ok(!cleanLines.some((line) => line.includes("移除")), cleanLines.join(" | "));
});
