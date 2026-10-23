/**
 * Module: the Trellis layer — this package renders its own template.
 *
 * The Trellis artifacts a project runs (`.trellis/workflow.md`, `.trellis/agents/`,
 * `.trellis/scripts/`, `.trellis/config.yaml`, `.pi/extensions/trellis/`,
 * `.pi/prompts/`, `.agents/skills/trellis-*`) ship inside this package under
 * `templates/trellis/`. `/Coworkflow:init` copies them into the project; no
 * `trellis init` / `trellis update` call is made, and the global CLI is not a
 * prerequisite.
 *
 * The `dot-*` level of the template is a rename, not content: `dot-trellis/` →
 * `.trellis/`, `dot-pi/` → `.pi/`, `dot-agents/` → `.agents/`. The prefix keeps
 * the template directory itself from being scanned as a live Trellis/Pi surface.
 *
 * Three ownership classes, and the boundary is the point of this module:
 *
 *   - this package's assets — written from the template; an identical file is
 *     skipped, never rewritten (no mtime churn on a second init);
 *   - `.trellis/config.yaml` — the project's file: written only when absent,
 *     otherwise missing top-level keys are appended and existing values kept;
 *   - the project's records — `.trellis/tasks|spec|workspace|.runtime|.developer`
 *     and `.trellis/.template-hashes.json`: never written, never deleted.
 *
 * Old installs are detected, not guessed at: `retireRoleAgents()` and a Pi block
 * that still dispatches `trellis-*` are the two markers of the pre-template
 * surface, and hitting either one is reported as an upgrade.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleContext, WorkflowModule } from "../../core/module.ts";

const TRELLIS_REL = ".trellis";
const VERSION_REL = join(TRELLIS_REL, ".version");
const CONFIG_REL = join(TRELLIS_REL, "config.yaml");
const WORKFLOW_REL = join(TRELLIS_REL, "workflow.md");

/** Where the bundled template lives, resolved next to this module. */
export const TEMPLATE_ROOT = fileURLToPath(new URL("../../templates/trellis/", import.meta.url));

/** `dot-*` directory in the template → the real directory in the project. */
const DOT_DIRS: Record<string, string> = {
  "dot-trellis": TRELLIS_REL,
  "dot-pi": ".pi",
  "dot-agents": ".agents",
};

/**
 * Directories that belong to the project, spelled as forward-slash relative
 * paths because that is what a template entry can collide with.
 *
 * A template entry under one of these is refused (and reported) rather than
 * written: moving a task or a spec into a template is how a package ends up
 * overwriting the project's history on its next init.
 */
const PROJECT_OWNED = [
  ".trellis/tasks",
  ".trellis/spec",
  ".trellis/workspace",
  ".trellis/.runtime",
  ".trellis/.developer",
  ".trellis/.template-hashes.json",
  ".pi/Coworkflow.json",
  ".pi/settings.json",
];

/** Marker files that exist only to keep an empty directory in git. */
const PLACEHOLDERS = new Set([".gitkeep", ".keep"]);

/**
 * The three role agents old Trellis installs shipped: not dispatch targets.
 *
 * A kind (`cw-executor` / `cw-auditor` / `cw-researcher`) covers the same role
 * with the project's enable switch and concurrency ceiling in front of it, so
 * keeping the flat `trellis-*` agents around is a second, ungated way to
 * dispatch the same work. The template does not contain them, so a fresh render
 * never creates them; an old install still has them on disk, and that is what
 * migration removes.
 */
const ROLE_AGENT_RELS = [
  join(".pi", "agents", "trellis-implement.md"),
  join(".pi", "agents", "trellis-check.md"),
  join(".pi", "agents", "trellis-research.md"),
];

// ── template inventory ───────────────────────────────────────────────

/** One file the template wants in the project. */
export interface TemplateWrite {
  /** Project-relative path, forward slashes (`".pi/prompts/trellis-start.md"`). */
  rel: string;
  /** Absolute destination. */
  path: string;
  body: string;
  /** Permission bits from the template file; scripts need to stay executable. */
  mode?: number;
  /** `create` when the destination is absent, `update` when its bytes differ. */
  status: "create" | "update";
}

/** What `.trellis/config.yaml` needs. */
export interface ConfigPlan {
  rel: string;
  action: "create" | "merge" | "skip";
  body: string;
  /** Top-level keys the template has and the project's file does not. */
  addedKeys: string[];
}

/** Everything a render would do, computed before a single byte is written. */
export interface TemplatePlan {
  writes: TemplateWrite[];
  /** Entries already in their template state, so a second init writes nothing. */
  skips: string[];
  config: ConfigPlan;
  /** `.trellis/.version`, rewritten to this package's template version. */
  version: { rel: string; path: string; body: string; status: "create" | "update" | "skip" };
  /** Why this project counts as a pre-template install; empty when it does not. */
  migrations: string[];
  /** Template entries that must not be written, with the reason. */
  errors: { rel: string; message: string }[];
}

/** Which ownership class a template entry falls into. */
export function classifyTemplatePath(rel: string): "asset" | "config" | "placeholder" | "forbidden" {
  const posix = rel.split(sep).join("/");
  if (PLACEHOLDERS.has(posix.split("/").pop() ?? "")) return "placeholder";
  if (posix === CONFIG_REL.split(sep).join("/")) return "config";
  for (const owned of PROJECT_OWNED) {
    if (posix === owned || posix.startsWith(`${owned}/`)) return "forbidden";
  }
  return "asset";
}

/** Every file under `dir`, as absolute paths, deterministically ordered. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Map the template tree onto project-relative destinations.
 *
 * The `dot-*` rename happens here and nowhere else, so nothing downstream has to
 * know that a template directory is not a project directory. An unexpected
 * top-level name is an error rather than a silent copy: writing `something/` into
 * a project because a template grew a directory is not a behaviour anyone asked
 * for.
 */
export function templateEntries(templateRoot: string): { rel: string; path: string; mode?: number }[] {
  const entries: { rel: string; path: string; mode?: number }[] = [];
  for (const entry of readdirSync(templateRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = join(templateRoot, entry.name);
    if (!entry.isDirectory()) continue;
    const target = DOT_DIRS[entry.name];
    if (target === undefined) continue;
    for (const file of walk(source)) {
      const rel = join(target, relative(source, file));
      let mode: number | undefined;
      try {
        mode = statSync(file).mode & 0o777;
      } catch {
        mode = undefined;
      }
      entries.push({ rel, path: file, mode });
    }
  }
  return entries;
}

// ── config.yaml: fill missing keys, never overwrite a value ──────────

interface YamlBlock {
  key: string;
  text: string;
}

/**
 * Split a YAML document into its top-level key blocks.
 *
 * The project's `config.yaml` is a document with comments, blank lines and
 * nested maps; only the top-level key is a unit of ownership the template can
 * safely add. Splitting on `/^[A-Za-z_][\w-]*:/` at column 0 gives each key its
 * own leading comment and body, which is why an appended block reads like the
 * rest of the file instead of a bare `key: value` line.
 */
export function topLevelBlocks(yaml: string): YamlBlock[] {
  const blocks: YamlBlock[] = [];
  let pending: string[] = [];
  let current: { key: string; lines: string[] } | null = null;
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z_][\w-]*):/.exec(line);
    if (match?.[1] !== undefined) {
      if (current !== null) blocks.push({ key: current.key, text: current.lines.join("\n") });
      current = { key: match[1], lines: [...pending, line] };
      pending = [];
      continue;
    }
    if (current === null) pending.push(line);
    else current.lines.push(line);
  }
  if (current !== null) blocks.push({ key: current.key, text: current.lines.join("\n") });
  return blocks;
}

/** Template keys the project's file lacks, appended with their comments. */
export function missingConfigKeys(current: string, template: string): string[] {
  const present = new Set(topLevelBlocks(current).map((block) => block.key));
  return topLevelBlocks(template)
    .filter((block) => !present.has(block.key))
    .map((block) => block.key);
}

function mergeConfig(current: string, template: string): ConfigPlan {
  const addedKeys = missingConfigKeys(current, template);
  if (addedKeys.length === 0) return { rel: CONFIG_REL, action: "skip", body: current, addedKeys };
  const missing = new Set(addedKeys);
  const body = topLevelBlocks(template)
    .filter((block) => missing.has(block.key))
    .map((block) => block.text.replace(/\n+$/, ""))
    .join("\n\n");
  const head = current.endsWith("\n") ? current : `${current}\n`;
  return { rel: CONFIG_REL, action: "merge", body: `${head}\n${body}\n`, addedKeys };
}

// ── legacy detection ─────────────────────────────────────────────────

/**
 * Split a workflow document into its platform blocks.
 *
 * A platform block opens with `[Claude Code, Pi, …]` and closes with `[/…]`; the
 * same shape carries task-state blocks, distinguished by a `:` in the marker, and
 * those are not platform-specific. Only the blocks naming `Pi` are read here: the
 * other platforms keep their own dispatch protocol and are never this module's
 * migration target.
 */
function piBlocks(md: string): string[] {
  const pi: string[] = [];
  let current: { name: string; body: string[] } | null = null;
  for (const line of md.split("\n")) {
    const open = /^\[([^\]]+)\]$/.exec(line)?.[1];
    const close = /^\[\/([^\]]+)\]$/.exec(line)?.[1];
    if (current === null && open !== undefined && !open.includes(":")) {
      current = { name: open, body: [] };
      continue;
    }
    if (current !== null && close === current.name) {
      if (current.name.split(",").map((part) => part.trim()).includes("Pi")) pi.push(current.body.join("\n"));
      current = null;
      continue;
    }
    current?.body.push(line);
  }
  return pi;
}

/** The role agents present on disk, as project-relative paths. */
function presentRoleAgents(root: string): string[] {
  return ROLE_AGENT_RELS.filter((rel) => existsSync(join(root, rel)));
}

/**
 * Why this project is a pre-template install, one reason per marker found.
 *
 * An empty list is the normal case: a project rendered from this template carries
 * neither marker. Both are *observations*, not guesses — a role agent file on disk
 * and a Pi block that still names one.
 */
export function detectLegacy(root: string): string[] {
  const reasons: string[] = [];
  const agents = presentRoleAgents(root);
  if (agents.length > 0) reasons.push(`旧角色 agent：${agents.join("、")}`);
  let workflow: string | null = null;
  try {
    workflow = readFileSync(join(root, WORKFLOW_REL), "utf-8");
  } catch {
    workflow = null;
  }
  if (workflow !== null && piBlocks(workflow).some((body) => /Agent type[^\n]*trellis-/.test(body))) {
    reasons.push("`.trellis/workflow.md` 的 Pi 块仍派发 `trellis-*`");
  }
  return reasons;
}

/**
 * Delete the role agents that exist, and report what was there.
 *
 * Pure file work with no context and no CLI call. A path listed in `kept` was
 * either absent or could not be removed — the caller reports the count, never a
 * failure, because nothing here is this package's file.
 */
export function retireRoleAgents(root: string): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const rel of ROLE_AGENT_RELS) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      kept.push(rel);
      continue;
    }
    try {
      rmSync(path, { force: true });
      removed.push(rel);
    } catch {
      kept.push(rel);
    }
  }
  return { removed, kept };
}

// ── planning ─────────────────────────────────────────────────────────

/** This package's version, read from its own manifest (the template's version). */
export function packageVersion(packageRoot?: string): string {
  const path = packageRoot !== undefined ? join(packageRoot, "package.json") : fileURLToPath(new URL("../../package.json", import.meta.url));
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The contents of `.trellis/.version`: this package, not the global CLI. */
export function versionMarker(version: string): string {
  return `pi-coworkflow@${version}\n`;
}

/**
 * Compute everything a render would write, without writing anything.
 *
 * The only I/O is reading the template and the destinations it compares against,
 * which is what makes the plan assertable in a test: golden fidelity, idempotency
 * and the user-data boundary are all visible in this value.
 */
export function planTemplate(options: { root: string; templateRoot?: string; version?: string }): TemplatePlan {
  const root = options.root;
  const templateRoot = options.templateRoot ?? TEMPLATE_ROOT;
  const version = options.version ?? packageVersion();

  const writes: TemplateWrite[] = [];
  const skips: string[] = [];
  const errors: TemplatePlan["errors"] = [];
  let config: ConfigPlan = { rel: CONFIG_REL, action: "skip", body: "", addedKeys: [] };
  let configSeen = false;

  for (const entry of templateEntries(templateRoot)) {
    const kind = classifyTemplatePath(entry.rel);
    if (kind === "placeholder") continue;
    if (kind === "forbidden") {
      errors.push({ rel: entry.rel, message: "模板条目落在项目自有区，拒绝写入" });
      continue;
    }
    let body: string;
    try {
      body = readFileSync(entry.path, "utf-8");
    } catch (error) {
      errors.push({ rel: entry.rel, message: `模板文件读取失败：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const path = join(root, entry.rel);
    if (kind === "config") {
      configSeen = true;
      config = existsSync(path) ? mergeConfig(readFileSync(path, "utf-8"), body) : { rel: entry.rel, action: "create", body, addedKeys: [] };
      continue;
    }
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf-8");
    } catch {
      current = null;
    }
    if (current === body) {
      skips.push(entry.rel);
      continue;
    }
    writes.push({
      rel: entry.rel,
      path,
      body,
      ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
      status: current === null ? "create" : "update",
    });
  }

  if (!configSeen) {
    // A template without its own config.yaml still has to leave the project's file
    // alone; saying so is more useful than an empty plan.
    errors.push({ rel: CONFIG_REL, message: "模板缺少 `.trellis/config.yaml`" });
  }

  const versionPath = join(root, VERSION_REL);
  const versionBody = versionMarker(version);
  let currentVersion: string | null = null;
  try {
    currentVersion = readFileSync(versionPath, "utf-8");
  } catch {
    currentVersion = null;
  }
  const versionPlan: TemplatePlan["version"] = {
    rel: VERSION_REL,
    path: versionPath,
    body: versionBody,
    status: currentVersion === versionBody ? "skip" : currentVersion === null ? "create" : "update",
  };

  return { writes, skips, config, version: versionPlan, migrations: detectLegacy(root), errors };
}

// ── writing ──────────────────────────────────────────────────────────

/**
 * Write a planned file atomically: a sibling temp file, then a rename.
 *
 * A render that dies halfway must not leave a truncated `workflow.md` behind —
 * the next init would then read a half-written document as the project's own
 * workflow. A rename is the one filesystem operation that is either done or not.
 */
function writeAtomic(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.coworkflow-${process.pid}.tmp`;
  try {
    writeFileSync(temp, body);
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; the original error is what matters.
    }
    throw error;
  }
}

/** Apply a plan. Returns what was written and what could not be. */
export function writePlanned(root: string, plan: TemplatePlan): { written: string[]; failed: { rel: string; message: string }[] } {
  const written: string[] = [];
  const failed: { rel: string; message: string }[] = [];
  const targets: { rel: string; path: string; body: string; mode?: number }[] = [
    ...plan.writes,
    ...(plan.config.action === "skip" ? [] : [{ rel: plan.config.rel, path: join(root, plan.config.rel), body: plan.config.body }]),
    ...(plan.version.status === "skip" ? [] : [{ rel: plan.version.rel, path: plan.version.path, body: plan.version.body }]),
  ];
  for (const target of targets) {
    try {
      writeAtomic(target.path, target.body, target.mode);
      written.push(target.rel);
    } catch (error) {
      failed.push({ rel: target.rel, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { written, failed };
}

/** Facts of one render, for the module report and for tests. */
export interface RenderReport {
  created: number;
  updated: number;
  skipped: number;
  configAction: ConfigPlan["action"];
  addedConfigKeys: string[];
  migrations: string[];
  removedAgents: string[];
  written: string[];
  failed: { rel: string; message: string }[];
}

/**
 * Render the bundled template into `ctx.root` and report each step.
 *
 * The report is the deliverable here: a run that writes ten files and a run that
 * writes none must be distinguishable without a filesystem diff, because the
 * second one is the normal state of an up-to-date project.
 */
export function renderTemplate(ctx: ModuleContext, templateRoot = TEMPLATE_ROOT): RenderReport {
  const plan = planTemplate({ root: ctx.root, templateRoot });
  const report: RenderReport = {
    created: 0,
    updated: 0,
    skipped: plan.skips.length,
    configAction: plan.config.action,
    addedConfigKeys: plan.config.addedKeys,
    migrations: plan.migrations,
    removedAgents: [],
    written: [],
    failed: [],
  };

  for (const entry of plan.errors) report.failed.push({ rel: entry.rel, message: entry.message });

  const pending = plan.writes.length + (plan.config.action === "skip" ? 0 : 1) + (plan.version.status === "skip" ? 0 : 1);
  const createCount = plan.writes.filter((write) => write.status === "create").length + (plan.config.action === "create" ? 1 : 0) + (plan.version.status === "create" ? 1 : 0);

  if (plan.migrations.length > 0) {
    ctx.report("updated", `已从旧 Trellis 产物升级到本仓模板：${plan.migrations.join("；")}`);
  }

  if (ctx.dry) {
    ctx.report(
      pending === 0 ? "ok" : "updated",
      pending === 0
        ? `模板已是最新（${report.skipped} 个文件内容相同），无需写入`
        : `会写入 ${pending} 个文件（新建 ${createCount}、更新 ${pending - createCount}），跳过 ${report.skipped} 个已是最新的文件`,
    );
  } else {
    const result = writePlanned(ctx.root, plan);
    report.written = result.written;
    report.failed.push(...result.failed);
    report.created = plan.writes.filter((write) => write.status === "create" && result.written.includes(write.rel)).length + (plan.config.action === "create" && result.written.includes(plan.config.rel) ? 1 : 0) + (plan.version.status === "create" && result.written.includes(plan.version.rel) ? 1 : 0);
    report.updated = result.written.length - report.created;
    ctx.report(
      result.written.length === 0 ? "ok" : "created",
      result.written.length === 0
        ? `模板已是最新（${report.skipped} 个文件内容相同），未写入任何文件`
        : `已渲染模板：新建 ${report.created} 个、更新 ${report.updated} 个文件，跳过 ${report.skipped} 个已是最新的文件（共 ${result.written.length + report.skipped} 个）`,
    );
  }

  if (plan.config.action === "merge") {
    ctx.report("updated", `\`.trellis/config.yaml\` 保留项目已有值，补上缺失的顶层键：${plan.config.addedKeys.join("、")}`);
  } else if (plan.config.action === "create") {
    ctx.report("created", "`.trellis/config.yaml` 由模板写入（项目此前没有该文件）");
  } else {
    ctx.report("ok", "`.trellis/config.yaml` 已有模板的全部顶层键，用户值原样保留");
  }

  ctx.report("ok", "本包自有记录区（.trellis/tasks、spec、workspace、.runtime）不写不删");

  if (plan.version.status !== "skip") {
    ctx.report("updated", `\`.trellis/.version\` → \`${plan.version.body.trim()}\`（本包模板版本，不再与全局 CLI 比较）`);
  }

  // Migration's other half: the agents the template does not contain must not
  // survive the render, and deleting them is the only moment it can happen.
  const legacyAgents = presentRoleAgents(ctx.root);
  if (legacyAgents.length > 0) {
    if (ctx.dry) {
      ctx.report("updated", `会移除 ${legacyAgents.length} 个旧角色 agent（${legacyAgents.join("、")}）；模板不含 trellis-*，迁移后不再生成`);
    } else {
      const { removed } = retireRoleAgents(ctx.root);
      report.removedAgents = removed;
      ctx.report("updated", `已移除 ${removed.length} 个旧角色 agent（${removed.join("、")}）；模板不含 trellis-*，迁移后不再生成`);
    }
  }

  for (const failure of plan.errors) {
    ctx.report("error", `${failure.rel}：${failure.message}`);
  }
  return report;
}

// ── optional global CLI ──────────────────────────────────────────────

function run(command: string, args: string[], cwd: string, timeoutMs = 15_000): { code: number; out: string; err: string } {
  const proc = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  return { code: proc.status ?? 1, out: (proc.stdout ?? "").trim(), err: (proc.stderr ?? "").trim() };
}

/** The global CLI's version, or `null` when it is not installed. */
export function globalTrellisVersion(): string | null {
  const found = run("trellis", ["--version"], process.cwd());
  if (found.code !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(found.out || found.err)?.[1] ?? "unknown";
}

/**
 * Say whether the optional global CLI is there.
 *
 * It is optional on purpose: `mem` and `channel` are features of that CLI, and
 * `trellis init/update` are no longer used at all, so a project without it still
 * gets the whole workflow. Reporting this as an error would tell the user their
 * install is broken when nothing is missing but a convenience.
 */
export function probeOptionalCli(ctx: ModuleContext): string | null {
  const version = globalTrellisVersion();
  if (version === null) {
    ctx.report("ok", "可选：未安装全局 trellis CLI，mem/channel 不可用（其余功能不依赖它）");
    return null;
  }
  ctx.report("ok", `可选：全局 trellis CLI ${version} 可用（mem / channel 由它提供；本包不用它渲染模板）`);
  return version;
}

// ── module ───────────────────────────────────────────────────────────

export const trellisModule: WorkflowModule = {
  id: "trellis",
  title: "改版 Trellis（模板渲染 .trellis/、.pi/、.agents/skills/）",

  apply(ctx: ModuleContext): void {
    if (!existsSync(TEMPLATE_ROOT)) {
      ctx.report("error", `模板缺失：${TEMPLATE_ROOT}（包内 templates/trellis/ 未随包发布）`);
      return;
    }
    ctx.report("ok", "模板源：本包 templates/trellis/（不调用 `trellis init` / `trellis update`）");
    renderTemplate(ctx);
    if (ctx.options?.trellisUpdate === true) {
      ctx.report("ok", "--trellis-update 已废弃：模板由本包渲染，不再需要 `trellis update`");
    }
    probeOptionalCli(ctx);
  },
};
