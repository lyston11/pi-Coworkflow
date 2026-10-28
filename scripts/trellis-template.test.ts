/**
 * Contract tests for the bundled Trellis template.
 *
 * The package stopped calling `trellis init/update` and started rendering its own
 * `templates/trellis/`. Five properties decide whether that substitution is
 * honest, and each has burned a project somewhere:
 *
 *   - golden — the template is the Trellis this project actually runs, so its
 *     bytes must equal the files in the repository. A template that quietly
 *     drifts is a project that silently runs a different workflow than the one
 *     the package documents.
 *   - idempotent — a second `/Coworkflow:init` writes nothing. Otherwise every
 *     init rewrites mtimes and the "is it up to date?" question becomes unanswerable.
 *   - user data — `.trellis/tasks|spec|workspace` are the project's history; a
 *     render that touches them is worse than no render at all.
 *   - migration — an old install's role agents and `trellis-*` Pi block are
 *     replaced, and the report says so.
 *   - no CLI — `trellis` not on PATH is not an error, because nothing needs it.
 *
 * Every test works in a temp directory; the golden test only reads the repo.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createContext } from "../core/module.ts";
import { agentsModule, SUBAGENT_GUIDE_REL } from "../modules/agents/index.ts";
import {
  TEMPLATE_ROOT,
  classifyTemplatePath,
  detectLegacy,
  missingConfigKeys,
  packageVersion,
  planTemplate,
  renderTemplate,
  templateEntries,
  topLevelBlocks,
} from "../modules/trellis/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A project directory with nothing in it yet. */
function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "coworkflow-template-"));
}

/** A context that records report lines instead of printing them. */
function contextFor(root: string, dry = false): { ctx: ReturnType<typeof createContext>; lines: string[] } {
  const lines: string[] = [];
  const ctx = createContext({
    root,
    prefix: "",
    dry,
    report: (status, message) => lines.push(`${status}:${message}`),
  });
  return { ctx, lines };
}

/** A minimal legacy install: the old role agents plus a `trellis-*` Pi block. */
function legacyProject(): string {
  const root = tempProject();
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  mkdirSync(join(root, ".trellis"), { recursive: true });
  for (const name of ["trellis-implement", "trellis-check", "trellis-research"]) {
    writeFileSync(join(root, ".pi", "agents", `${name}.md`), `# ${name}\n`);
  }
  writeFileSync(
    join(root, ".trellis", "workflow.md"),
    ["# Old workflow", "", "[codex-inline, Pi, Claude Code]", "- **Agent type**: `trellis-implement`", "[/codex-inline, Pi, Claude Code]", ""].join("\n"),
  );
  return root;
}

// ── template inventory ───────────────────────────────────────────────

test("template: the shipped tree covers every asset the init renders, and nothing project-owned", () => {
  const entries = templateEntries(TEMPLATE_ROOT);
  assert.ok(entries.length > 20, `expected a populated template, got ${entries.length} files`);
  const rels = entries.map((entry) => entry.rel.split("\\").join("/"));

  // The three roots named by the PRD, each with its real files behind it.
  for (const required of [
    ".trellis/workflow.md",
    ".trellis/config.yaml",
    ".trellis/agents/check.md",
    ".trellis/agents/implement.md",
    ".trellis/scripts/get_context.py",
    ".pi/extensions/trellis/index.ts",
    ".pi/prompts/trellis-start.md",
    ".agents/skills/trellis-meta/SKILL.md",
  ]) {
    assert.ok(rels.includes(required), `template is missing ${required}`);
  }

  // Nothing under the project's own record directories, and no Python bytecode.
  for (const rel of rels) {
    // `.gitkeep` keeps the empty `.pi/agents/` in git; it is never rendered.
    if (rel.endsWith(".gitkeep")) {
      assert.equal(classifyTemplatePath(rel), "placeholder");
      continue;
    }
    if (rel === ".trellis/config.yaml") {
      // The only file whose rule is "fill missing keys", never "overwrite".
      assert.equal(classifyTemplatePath(rel), "config");
      continue;
    }
    assert.equal(classifyTemplatePath(rel), "asset", `${rel} is not a writable asset`);
    assert.ok(!rel.includes("__pycache__"), `${rel} is a build artifact`);
    assert.ok(!rel.endsWith(".pyc"), `${rel} is a build artifact`);
    assert.ok(!rel.startsWith(".trellis/tasks/"), `${rel} would overwrite project tasks`);
  }
});

test("template: the dot-* rename maps onto the three real roots", () => {
  assert.ok(existsSync(join(TEMPLATE_ROOT, "dot-trellis")));
  assert.ok(existsSync(join(TEMPLATE_ROOT, "dot-pi")));
  assert.ok(existsSync(join(TEMPLATE_ROOT, "dot-agents")));
  const roots = new Set(templateEntries(TEMPLATE_ROOT).map((entry) => entry.rel.split(/[\\/]/)[0]));
  assert.deepEqual([...roots].sort(), [".agents", ".pi", ".trellis"]);
});

// ── golden ───────────────────────────────────────────────────────────

/**
 * The checkouts that hold this project's own rendered assets.
 *
 * `.trellis/` is committed, so it is read from this checkout. `.pi/` and
 * `.agents/` are generated locally: in a task worktree `.pi` is a link into the
 * primary checkout, and that link is the only signal used here — the primary root
 * is derived from it rather than hardcoded, and a checkout without the link simply
 * compares fewer files (reported, never silently passed).
 */
/**
 * Checkouts that hold the reference copy of the rendered tree.
 *
 * A linked worktree carries only committed files, while some rendered targets
 * (`.pi/extensions`, `.pi/prompts`) are project-local and untracked. When the test
 * runs inside a task worktree the reference therefore lives in the main checkout
 * that owns the shared Git directory.
 */
function referenceRoots(root: string): string[] {
  const roots = [root];
  try {
    const linked = realpathSync(join(root, ".pi"));
    const primary = dirname(linked);
    if (primary !== root) roots.push(primary);
  } catch {
    // No `.pi` link: fall through to the Git directory's owner.
  }
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const owner = dirname(common);
    if (owner !== root && !roots.includes(owner)) roots.push(owner);
  } catch {
    // Not a repository: this checkout is the only reference.
  }
  return roots;
}

function readReference(roots: string[], rel: string): string | null {
  for (const root of roots) {
    const path = join(root, rel);
    if (existsSync(path)) return readFileSync(path, "utf-8");
  }
  return null;
}

test("template: rendering reproduces the repository's Trellis files byte for byte", () => {
  const root = tempProject();
  const { ctx } = contextFor(root);
  renderTemplate(ctx);

  const references = referenceRoots(ROOT);
  const unavailable: string[] = [];
  let compared = 0;
  let rendered = 0;
  for (const entry of templateEntries(TEMPLATE_ROOT)) {
    const rel = entry.rel.split("\\").join("/");
    if (rel.endsWith(".gitkeep")) continue;
    rendered += 1;
    const expected = readReference(references, rel);
    if (expected === null) {
      unavailable.push(rel);
      continue;
    }
    assert.equal(
      readFileSync(join(root, rel), "utf-8"),
      expected,
      `${rel} rendered differently from the checked-in file`,
    );
    compared += 1;
  }
  assert.ok(compared >= 20, `expected to compare the rendered tree, compared ${compared} files`);
  assert.deepEqual(unavailable, [], `these template files have no reference copy to compare against`);
  assert.equal(compared, rendered, "every renderable template file must be compared");
});

// ── single-session policy at the rendered and injected boundaries ─────

test("instructions: direct execution is normal, delegation optional, safety retained", async () => {
  const root = tempProject();
  const { ctx } = contextFor(root);
  const projectRule = "# Project\n\nKeep the project's own constraints.\n";
  writeFileSync(join(root, "AGENTS.md"), projectRule);
  await agentsModule.apply?.(ctx);

  const parent = readFileSync(join(root, "AGENTS.md"), "utf-8");
  const child = readFileSync(join(root, SUBAGENT_GUIDE_REL), "utf-8");
  assert.ok(parent.startsWith(projectRule), "rendering preserves project-owned guidance");
  assert.equal(parent.split("<!-- pi-Coworkflow:start -->").length - 1, 1);
  assert.equal(parent.split("<!-- pi-Coworkflow:end -->").length - 1, 1);
  await agentsModule.apply?.(ctx);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf-8"), parent, "refresh is idempotent");
  assert.match(parent, /主会话默认负责端到端交付/);
  assert.match(parent, /只有收益高于重复上下文、交接和集成成本时才派单/);
  assert.match(parent, /不硬编码模型名称/);
  assert.doesNotMatch(parent, /执行全部交出去|默认并行，串行要给出理由|主会话自己动手的唯一场合/);
  for (const safety of ["files: []", "必须后台", "开关与数量限制", "禁止 `reset --hard`", "子 agent 不合并、不 push", "agentKinds.<kind>.model"]) {
    assert.ok(parent.includes(safety), `delegation still preserves ${safety}`);
  }
  assert.match(parent, /主会话的直接写入不受子任务队列的 `files` 检查保护/);
  assert.match(child, /可以受托提供规划、调研或审查建议/);
  assert.match(child, /咨询任务不自行修改代码/);
  assert.match(child, /不再派发子 agent/);
  assert.match(child, /不操作 Git index、不提交/);
  assert.doesNotMatch(parent + child, /gpt-6|deepseek/i, "policy must not pin the user's example models");
});

test("all platforms: the real phase extractor delivers direct implementation and read-only optional review", () => {
  const root = tempProject();
  renderTemplate(contextFor(root).ctx);
  const step = (id: string, platform = "pi"): string => execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [join(root, ".trellis", "scripts", "get_context.py"), "--mode", "phase", "--platform", platform, "--step", id],
    { cwd: root, encoding: "utf-8", timeout: 10_000 },
  );

  const implementation = step("2.1");
  const check = step("2.2");
  assert.match(implementation, /Implement directly in the main session by default/);
  assert.match(implementation, /Optional delegation/);
  assert.match(implementation, /background execution/);
  assert.match(implementation, /Duration alone is not a reason/);
  assert.match(check, /Check the work directly in the main session by default/);
  assert.match(check, /A separate reviewer is not required/);
  assert.match(check, /do not repeat unchanged checks/);
  assert.doesNotMatch(implementation + check, /Spawn the (implement|check) sub-agent|Dispatch the (implementation|quality check) to/);
  for (const platform of ["claude-code", "cursor", "opencode", "codex", "kiro", "gemini", "qoder", "codebuddy", "copilot", "droid", "oh-my-pi", "zcode", "snow", "reasonix", "trae", "grok", "kimi-code", "kilo", "antigravity", "devin", "deepseek-harness"]) {
    const implement = step("2.1", platform), review = step("2.2", platform);
    assert.match(implement, /Implement directly in the main session by default/, platform);
    assert.match(review, /reviewer is read-only/, platform);
    assert.doesNotMatch(implement + review, /Spawn the (implement|check) sub-agent|Auto-Fix|Self-Fix/, platform);
  }
});

test("Pi: inline fallback and routing agree with the phase details", () => {
  const workflow = readFileSync(join(TEMPLATE_ROOT, "dot-trellis", "workflow.md"), "utf-8");
  const fallback = workflow.match(/\[workflow-state:in_progress-inline\]\n([\s\S]*?)\[\/workflow-state:in_progress-inline\]/)?.[1];
  assert.ok(fallback, "Pi must retain its inline fallback");
  assert.match(fallback, /main session implements and validates by default/);
  assert.match(fallback, /no mandatory execute\/audit pipeline/);
  assert.match(fallback, /commit \(Phase 3\.4\)/, "direct execution still reaches task closure");
  for (const name of ["in_progress", "in_progress-inline"]) {
    const body = workflow.slice(workflow.indexOf(`\n[workflow-state:${name}]\n`), workflow.indexOf(`[/workflow-state:${name}]`));
    assert.match(body, /main session implements and validates by default/);
    assert.doesNotMatch(body, /sub-agent flow|dispatch the audit kind|review\/fix/);
  }
  assert.match(workflow, /implement and check directly in the main session/);
  assert.match(workflow, /Active task: \(none\)/);
  const help = execFileSync(process.platform === "win32" ? "python" : "python3",
    [join(TEMPLATE_ROOT, "dot-trellis", "scripts", "task.py"), "--help"],
    { encoding: "utf-8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  for (const [, command] of workflow.matchAll(/task\.py ([a-z][a-z-]*)/g)) {
    assert.ok(help.includes(command!), `workflow references a real task command: ${command}`);
  }
  const reviewer = readFileSync(join(TEMPLATE_ROOT, "dot-trellis", "agents", "check.md"), "utf-8");
  assert.match(reviewer, /Do not edit files/);
  assert.doesNotMatch(reviewer, /fix.*directly|Auto-Fix|Self-Fix|NEVER ask.*fix/);
});

// ── idempotency ──────────────────────────────────────────────────────

test("template: a second render writes nothing and reports the project as up to date", () => {
  const root = tempProject();
  const first = contextFor(root);
  const firstReport = renderTemplate(first.ctx);
  assert.ok(firstReport.written.length > 0, "the first render of an empty project must write");

  const second = contextFor(root);
  const secondReport = renderTemplate(second.ctx);
  assert.deepEqual(secondReport.written, [], "the second render must not write a single file");
  assert.equal(secondReport.created, 0);
  assert.equal(secondReport.updated, 0);
  assert.ok(secondReport.skipped > 0);
  assert.ok(
    second.lines.some((line) => line.includes("未写入任何文件")),
    `the report must say nothing was written: ${second.lines.join(" | ")}`,
  );

  // The plan itself is the assertion that lasts: no writes pending.
  const plan = planTemplate({ root, version: packageVersion() });
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.config.action, "skip");
  assert.equal(plan.version.status, "skip");
});

// ── user data ────────────────────────────────────────────────────────

test("template: project records survive a render and a stale template never wins", () => {
  const root = tempProject();
  const task = join(root, ".trellis", "tasks", "10-23-mine", "task.json");
  mkdirSync(join(task, ".."), { recursive: true });
  writeFileSync(task, '{"id":"10-23-mine"}\n');
  const spec = join(root, ".trellis", "spec", "frontend", "note.md");
  mkdirSync(join(spec, ".."), { recursive: true });
  writeFileSync(spec, "# note\n");

  const { ctx } = contextFor(root);
  renderTemplate(ctx);

  assert.equal(readFileSync(task, "utf-8"), '{"id":"10-23-mine"}\n', "a task file must survive the render");
  assert.equal(readFileSync(spec, "utf-8"), "# note\n", "a spec file must survive the render");
  assert.deepEqual(detectLegacy(root), [], "a rendered project is not legacy");

  // Two renders in a row: still untouched, and nothing was ever planned for them.
  const plan = planTemplate({ root });
  for (const rel of [...plan.writes.map((write) => write.rel), ...plan.skips]) {
    assert.ok(!rel.startsWith(".trellis/tasks/"), `${rel} is project data`);
    assert.ok(!rel.startsWith(".trellis/spec/"), `${rel} is project data`);
  }
});

test("template: an existing config.yaml keeps its values and only gains missing top-level keys", () => {
  const root = tempProject();
  const configPath = join(root, ".trellis", "config.yaml");
  mkdirSync(join(root, ".trellis"), { recursive: true });
  const mine = "# my config\nsession_commit_message: \"chore: mine\"\nmax_journal_lines: 42\n";
  writeFileSync(configPath, mine);

  const { ctx } = contextFor(root);
  renderTemplate(ctx);

  const after = readFileSync(configPath, "utf-8");
  assert.match(after, /session_commit_message: "chore: mine"/, "a user value must not be overwritten");
  assert.match(after, /max_journal_lines: 42/);
  assert.match(after, /^# my config$/m, "the user's own header survives");
  // The template's other top-level keys were appended.
  const templateKeys = topLevelBlocks(readFileSync(join(TEMPLATE_ROOT, "dot-trellis", "config.yaml"), "utf-8")).map((block) => block.key);
  const afterKeys = new Set(topLevelBlocks(after).map((block) => block.key));
  for (const key of templateKeys) assert.ok(afterKeys.has(key), `${key} should have been appended`);
  assert.deepEqual(missingConfigKeys(after, readFileSync(join(TEMPLATE_ROOT, "dot-trellis", "config.yaml"), "utf-8")), []);
});

// ── migration ────────────────────────────────────────────────────────

test("template: an old install is upgraded — role agents gone, Pi block kind-only, and the report says so", () => {
  const root = legacyProject();
  const before = detectLegacy(root);
  assert.equal(before.length, 2, `both legacy markers should be detected: ${before.join(" | ")}`);

  const { ctx, lines } = contextFor(root);
  const report = renderTemplate(ctx);

  for (const name of ["trellis-implement", "trellis-check", "trellis-research"]) {
    assert.equal(existsSync(join(root, ".pi", "agents", `${name}.md`)), false, `${name} must be removed`);
  }
  assert.equal(report.removedAgents.length, 3);

  const workflow = readFileSync(join(root, ".trellis", "workflow.md"), "utf-8");
  assert.equal(workflow, readFileSync(join(TEMPLATE_ROOT, "dot-trellis", "workflow.md"), "utf-8"));
  assert.ok(!/Agent type[^\n]*trellis-/.test(workflow), "no platform dispatches legacy role agents");
  assert.match(workflow, /available project kind/, "optional delegation still uses configured kinds");

  assert.ok(
    lines.some((line) => line.includes("已从旧 Trellis 产物升级到本仓模板")),
    `the report must announce the upgrade: ${lines.join(" | ")}`,
  );
  assert.deepEqual(detectLegacy(root), [], "the upgraded project carries no legacy marker");
});

test("template: a dry run describes the migration and deletes nothing", () => {
  const root = legacyProject();
  const { ctx, lines } = contextFor(root, true);
  renderTemplate(ctx);

  for (const name of ["trellis-implement", "trellis-check", "trellis-research"]) {
    assert.equal(existsSync(join(root, ".pi", "agents", `${name}.md`)), true, "a dry run must not delete");
  }
  assert.ok(lines.some((line) => line.includes("会移除 3 个旧角色 agent")));
  assert.ok(lines.some((line) => line.includes("会写入")));
  assert.equal(existsSync(join(root, ".trellis", "agents", "implement.md")), false, "a dry run must not write");
});

// ── no external generator ────────────────────────────────────────────

test("template: a render succeeds with an empty PATH — nothing external is invoked", () => {
  const root = tempProject();
  const originalPath = process.env.PATH;
  // An empty PATH is the strongest form of "no external tool exists": rendering reads the
  // bundled template and writes files, and must not need anything else on the machine.
  process.env.PATH = "";
  try {
    const { ctx, lines } = contextFor(root);
    const report = renderTemplate(ctx);
    assert.ok(report.failed.length === 0, `render must not fail with no PATH: ${JSON.stringify(report.failed)}`);
    assert.ok(!lines.some((line) => line.startsWith("error:")), "an empty PATH is not an error");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("template: the module no longer shells out to `trellis init` or `trellis update`", () => {
  const source = readFileSync(join(ROOT, "modules", "trellis", "index.ts"), "utf-8");
  assert.ok(!/\["init"/.test(source), "the module must not call `trellis init`");
  assert.ok(!/\["update"/.test(source), "the module must not call `trellis update`");
  assert.ok(!/"-s"/.test(source), "no leftover Trellis CLI invocation remains in the module");
  assert.match(source, /templates\/trellis/, "the module must resolve the bundled template");
});
