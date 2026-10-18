/**
 * Trellis layout and context-injection primitives.
 *
 * Shared by the modules that need to read Trellis state: the child-side
 * injector (`subagent-context`) and the lane ledger (`lane-worktree`). Modules
 * own their own layer, but they must agree on where Trellis keeps things, so
 * that agreement lives here instead of being copied into each module.
 *
 * The injection semantics mirror the upstream Trellis sub-agent hooks
 * (`.cursor/hooks/inject-subagent-context.py` in the Trellis repo): the same
 * per-file / per-artifact / total byte budgets, the same truncation and index
 * notices, and the same "no curated entries" warning. Pi's Trellis extension
 * deleted that machinery when it went inline-only; this package re-implements
 * it for dispatched children, where the main session's prompt is not inherited.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TRELLIS_DIR = ".trellis";
export const SESSIONS_DIR = join(TRELLIS_DIR, ".runtime", "sessions");
export const LANES_DIR = join(TRELLIS_DIR, ".runtime", "lanes");
/**
 * Session-scoped "workflow is on for this session" flags.
 *
 * Lives under `.trellis/.runtime/` (gitignored, machine state) next to the
 * Trellis session pointers, because a dispatched child needs to read the flag
 * its parent set and it only knows the parent's session id.
 */
export const SESSION_FLAGS_FILE = join(TRELLIS_DIR, ".runtime", "workflow-sessions.json");
export const SPEC_DIR = join(TRELLIS_DIR, "spec");
export const TASKS_DIR = join(TRELLIS_DIR, "tasks");
/**
 * Instructions for dispatched children, separate from the project `AGENTS.md`.
 *
 * The project file is written for the session the user drives: planning,
 * dispatch, audit, merge. A child never does any of that, so inheriting it both
 * wastes tokens and gives the child duties it must not perform. This file holds
 * only what a child needs, and is injected by `subagent-context`.
 */
/**
 * Child-facing instructions. Owned by pi-Coworkflow, not Trellis: `trellis update`
 * must not treat it as something to reconcile.
 */
export const SUBAGENT_GUIDE = join(".pi", "Coworkflow", "subagent-AGENTS.md");

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Repository root for `cwd`, falling back to `cwd` outside a repository. */
export function repoRoot(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
}

/**
 * The checkout that owns `.trellis/`.
 *
 * A linked worktree (Trellis task worktree, pi-subagents lane worktree) keeps
 * task pointers, artifacts and lane records in the main checkout, so anything
 * read from Trellis state must resolve here rather than against the worktree.
 */
export function mainCheckout(dir: string): string {
  const common =
    runGit(dir, ["rev-parse", "--absolute-git-common-dir"]) ??
    runGit(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return dir;
  const absolute = isAbsolute(common) ? common : join(dir, common);
  return basename(absolute) === ".git" ? dirname(absolute) : dir;
}

/** Mirror of the Trellis Pi extension's session-key derivation. */
export function contextKeyFor(sessionId: string): string {
  const normalized = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!normalized) return `pi_${hash(sessionId)}`;
  return `pi_${normalized}${normalized === sessionId ? "" : `_${hash(sessionId)}`}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Absolute task directory, or null when the ref leaves the repository. */
export function resolveTaskDir(root: string, ref: string): string | null {
  let candidate = ref.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!candidate) return null;
  if (candidate.startsWith("tasks/")) candidate = `${TRELLIS_DIR}/${candidate}`;
  const absolute = candidate.startsWith(TRELLIS_DIR)
    ? join(root, candidate)
    : isAbsolute(candidate)
      ? candidate
      : join(root, TRELLIS_DIR, "tasks", candidate);
  const real = realpathOf(absolute);
  const rootReal = realpathOf(root);
  const trellisReal = realpathOf(join(root, TRELLIS_DIR));
  if (!real) return null;
  const inside =
    (rootReal !== null && contains(rootReal, real)) ||
    (trellisReal !== null && contains(trellisReal, real));
  return inside ? absolute : null;
}

function realpathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // The task directory may not exist yet; lexical resolution still lets a
    // caller create it, and containment is checked against the same base.
    return resolve(path);
  }
}

function contains(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** The task the given session is working on, from its Trellis session pointer. */
export function activeTaskDir(root: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const raw = readText(join(root, SESSIONS_DIR, `${contextKeyFor(sessionId)}.json`));
  if (!raw) return null;
  try {
    const ref: unknown = (JSON.parse(raw) as { current_task?: unknown }).current_task;
    return typeof ref === "string" ? resolveTaskDir(root, ref) : null;
  } catch {
    return null;
  }
}

/** `.trellis/tasks/<name>` for display and for the AGENTS.md dispatch protocol. */
export function taskRefForDisplay(root: string, taskDir: string): string {
  const rel = relative(root, taskDir).split(sep).join("/");
  return rel || taskDir;
}

// ── Context injection ─────────────────────────────────────────────────

export interface InjectionLimits {
  maxFileBytes: number;
  maxArtifactBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: InjectionLimits = {
  maxFileBytes: 32768,
  maxArtifactBytes: 65536,
  maxTotalBytes: 131072,
};

const LIMIT_KEYS: Record<string, keyof InjectionLimits> = {
  max_file_bytes: "maxFileBytes",
  max_artifact_bytes: "maxArtifactBytes",
  max_total_bytes: "maxTotalBytes",
};

/** Read `context_injection:` from `.trellis/config.yaml`; `0` disables a limit. */
export function readInjectionLimits(root: string): InjectionLimits {
  const limits: InjectionLimits = { ...DEFAULT_LIMITS };
  const raw = readText(join(root, TRELLIS_DIR, "config.yaml"));
  if (!raw) return limits;

  let inSection = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^context_injection:\s*(#.*)?$/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^\S/.test(line)) break; // dedent ends the section
    const match = /^\s+([a-z_]+):\s*(\d+)\s*(#.*)?$/.exec(line);
    const key = match?.[1] === undefined ? undefined : LIMIT_KEYS[match[1]];
    if (key === undefined || match?.[2] === undefined) continue;
    limits[key] = Number(match[2]);
  }
  return limits;
}

export interface ContextEntry {
  file: string;
  reason: string;
  type: "file" | "directory";
}

/** Read `implement.jsonl` / `check.jsonl`; malformed lines are skipped. */
export function readJsonlEntries(taskDir: string, name: string): ContextEntry[] {
  const raw = readText(join(taskDir, name));
  if (!raw) return [];
  const entries: ContextEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as { file?: unknown; reason?: unknown; type?: unknown };
      if (typeof record.file !== "string" || !record.file.trim()) continue;
      entries.push({
        file: record.file.trim(),
        reason: typeof record.reason === "string" ? record.reason.trim() : "",
        type: record.type === "directory" ? "directory" : "file",
      });
    } catch {
      // A malformed line must not take the whole manifest down.
    }
  }
  return entries;
}

class Budget {
  private readonly total: number;
  private used = 0;

  constructor(total: number) {
    this.total = total;
  }

  hasRoom(size: number): boolean {
    return this.total <= 0 || this.used + size <= this.total;
  }
  add(size: number): void {
    this.used += size;
  }
}

/** Truncate to at most `cap` bytes without splitting a UTF-8 sequence. */
export function truncateUtf8(data: Buffer, cap: number): Buffer {
  if (cap <= 0 || data.length <= cap) return data;
  let end = cap;
  while (end > 0 && (data[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end === 0) return Buffer.alloc(0);
  const lead = data[end - 1]!;
  let width = 1;
  if ((lead & 0xe0) === 0xc0) width = 2;
  else if ((lead & 0xf0) === 0xe0) width = 3;
  else if ((lead & 0xf8) === 0xf0) width = 4;
  if (end - 1 + width > cap) end -= 1;
  return data.subarray(0, end);
}

function readFileBytes(root: string, file: string): Buffer | null {
  const path = isAbsolute(file) ? file : join(root, file);
  try {
    const real = resolve(path);
    const rootReal = resolve(root);
    const trellisReal = resolve(join(root, TRELLIS_DIR));
    if (!contains(rootReal, real) && !contains(trellisReal, real)) return null;
    if (!statSync(real).isFile()) return null;
    return readFileSync(real);
  } catch {
    return null;
  }
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Mirrors upstream `_is_binary_content`: NUL byte or invalid UTF-8. */
function isBinary(data: Buffer): boolean {
  if (data.includes(0)) return true;
  try {
    UTF8_DECODER.decode(data);
    return false;
  } catch {
    return true;
  }
}

function budgetedBlock(
  budget: Budget,
  header: string,
  plainPath: string,
  content: string,
  reason: string,
  size: number,
): string {
  const block = `=== ${header} ===\n${content}`;
  if (!budget.hasRoom(Buffer.byteLength(block))) {
    const notice = `[Trellis: not inlined (total context limit reached) — ${plainPath} (${size} bytes): ${reason}]`;
    budget.add(Buffer.byteLength(notice));
    return notice;
  }
  budget.add(Buffer.byteLength(block));
  return block;
}

function materializeFile(
  root: string,
  file: string,
  reason: string,
  limits: InjectionLimits,
  budget: Budget,
): string | null {
  const data = readFileBytes(root, file);
  if (data === null) return null;
  const size = data.length;
  if (isBinary(data)) {
    const notice = `[Trellis: not inlined (binary file) — ${file} (${size} bytes): ${reason}]`;
    budget.add(Buffer.byteLength(notice));
    return notice;
  }
  const truncated = truncateUtf8(data, limits.maxFileBytes);
  let content = truncated.toString("utf-8");
  if (truncated.length < size) {
    content += `\n[Trellis: truncated at ${limits.maxFileBytes} bytes — read ${file} for the full content]`;
  }
  return budgetedBlock(budget, `${file} — ${reason}`, file, content, reason, size);
}

function materializeArtifact(
  root: string,
  file: string,
  header: string,
  reason: string,
  limits: InjectionLimits,
  budget: Budget,
): string | null {
  const data = readFileBytes(root, file);
  if (data === null) return null;
  const size = data.length;
  const truncated = truncateUtf8(data, limits.maxArtifactBytes);
  let content = truncated.toString("utf-8");
  if (truncated.length < size) {
    content += `\n[Trellis: truncated at ${limits.maxArtifactBytes} bytes — read ${file} for the full content]`;
  }
  return budgetedBlock(budget, header, file, content, reason, size);
}

function materializeDirectory(
  root: string,
  dir: string,
  reason: string,
  limits: InjectionLimits,
  budget: Budget,
): string[] {
  const absolute = isAbsolute(dir) ? dir : join(root, dir);
  let names: string[];
  try {
    names = readdirSync(absolute).sort();
  } catch {
    return [];
  }
  const blocks: string[] = [];
  for (const name of names) {
    const block = materializeFile(root, join(dir, name), reason, limits, budget);
    if (block) blocks.push(block);
  }
  return blocks;
}

function agentContext(
  root: string,
  taskDir: string,
  name: string,
  limits: InjectionLimits,
  budget: Budget,
): string {
  const manifest = `${taskDir}/${name}.jsonl`;
  const blocks: string[] = [];
  for (const entry of readJsonlEntries(taskDir, `${name}.jsonl`)) {
    if (entry.type === "directory") {
      blocks.push(...materializeDirectory(root, entry.file, entry.reason, limits, budget));
    } else {
      const block = materializeFile(root, entry.file, entry.reason, limits, budget);
      if (block) blocks.push(block);
    }
  }
  if (blocks.length === 0) {
    // Zero curated context reaches the model silently otherwise. Say so in the
    // prompt, so the child reads the guidelines itself instead of assuming the
    // spec context was complete.
    return (
      `[Trellis] ${manifest} has no curated entries, so no spec/research context was injected. ` +
      "Before working, read the guidelines relevant to the code you will touch under .trellis/spec/, " +
      "and treat the task artifacts below as the only prepared context."
    );
  }
  return blocks.join("\n\n");
}

function specTree(root: string): string {
  const specRoot = join(root, SPEC_DIR);
  const lines = [`${SPEC_DIR}/`];
  let packages: string[] = [];
  try {
    packages = readdirSync(specRoot)
      .filter((name) => {
        try {
          return statSync(join(specRoot, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    packages = [];
  }
  for (const name of packages) {
    let layers: string[] = [];
    try {
      layers = readdirSync(join(specRoot, name))
        .filter((entry) => {
          try {
            return statSync(join(specRoot, name, entry)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      layers = [];
    }
    lines.push(`└── ${name}/${layers.length ? ` (${layers.join(", ")})` : ""}`);
  }
  return [
    "## Project Spec Directory Structure",
    "",
    "```",
    lines.join("\n"),
    "```",
    "",
    "To get structured package info, run: `python3 ./.trellis/scripts/get_context.py --mode packages`",
    "",
    "## Search Tips",
    "",
    `- Spec files: \`${SPEC_DIR}/**/*.md\``,
    "- Code search: use the grep / find tools",
  ].join("\n");
}

export type SubagentRole = "implement" | "check" | "research";

/**
 * Role-scoped Trellis context, mirroring upstream `get_implement_context`,
 * `get_check_context`, and `get_research_context`.
 */
export function buildRoleContext(
  root: string,
  taskDir: string | null,
  role: SubagentRole,
): string {
  if (role === "research") return specTree(root);
  if (!taskDir) return "";

  const limits = readInjectionLimits(root);
  const budget = new Budget(limits.maxTotalBytes);
  const parts: string[] = [];

  const curated = agentContext(root, taskDir, role, limits, budget);
  if (curated) parts.push(curated);

  const artifacts: [string, string][] = [
    ["prd.md", "Requirements document"],
    ["design.md", "Technical design document"],
    ["implement.md", "Execution plan document"],
  ];
  for (const [file, reason] of artifacts) {
    const block = materializeArtifact(
      root,
      `${taskDir}/${file}`,
      `${taskDir}/${file} (${reason})`,
      reason,
      limits,
      budget,
    );
    if (block) parts.push(block);
  }
  return parts.join("\n\n");
}

/** The system-prompt block a dispatched child receives. */
/**
 * Strip inherited project instructions out of a child's system prompt.
 *
 * Pi renders every discovered `AGENTS.md`/`CLAUDE.md` as
 * `<project_instructions path="…">…</project_instructions>`. pi-subagents includes
 * them for agents declaring `inheritProjectContext: true`, which the Trellis role
 * templates do, and a child must never end up with two instruction sets — its own
 * guide and the project's main-session policy. Removing the inherited block here
 * keeps that true for any agent, including ones this package does not own, and
 * touches nothing outside a project that adopted the workflow.
 */
export function stripProjectInstructions(systemPrompt: string): string {
  if (!systemPrompt) return systemPrompt;
  const stripped = systemPrompt
    .replace(/<project_instructions\b[^>]*>[\s\S]*?<\/project_instructions>\s*/g, "")
    .replace(/\n{3,}/g, "\n\n");
  return stripped.trim();
}

/** The project's child-facing instructions, or null when it has none. */
export function readSubagentGuide(root: string): string | null {
  // The pre-move location (`.trellis/subagent-AGENTS.md`) is read as a fallback so
  // an adopted project keeps working until the next `/Coworkflow:init`.
  for (const rel of [SUBAGENT_GUIDE, join(TRELLIS_DIR, "subagent-AGENTS.md")]) {
    const raw = readText(join(root, rel));
    if (raw !== null && raw.trim()) return raw.trim();
  }
  return null;
}

export function renderInjection(
  role: SubagentRole,
  taskRef: string,
  context: string,
  guide?: string | null,
): string {
  return [
    "<!-- pi-Coworkflow:subagent-context -->",
    ...(guide ? ["## 子 agent 工作约定（本项目）", "", guide, ""] : []),
    `## Trellis 子任务上下文（role: ${role}）`,
    "",
    taskRef ? `Active task: ${taskRef}` : "Active task: (none)",
    "",
    context,
    "",
    "## 边界",
    "",
    "- 你是被派发的子 agent：只做派单提示词里指定给你的那部分，不要自己创建 Trellis 任务、不要改任务状态、不要合并或 push。",
    "- 任务状态、合并与清理由主会话负责；需要决策时用 `contact_supervisor` 提问，不要自行扩大范围。",
  ].join("\n");
}

export function laneDir(root: string, taskDir: string): string {
  return join(root, LANES_DIR, basename(taskDir));
}

// ── Session-scoped enable flags ───────────────────────────────────────

const FLAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FLAG_MAX_ENTRIES = 200;

interface FlagEntry {
  on: boolean;
  at: number;
  /**
   * When this session first turned Coworkflow on.
   *
   * Usage is only attributed to Coworkflow from this instant onward: tokens spent
   * before the layer was loaded were not produced by it, so counting them would
   * inflate every number the panel reports.
   */
  since?: number;
}

interface FlagFile {
  version: 1;
  sessions: Record<string, FlagEntry>;
}

function readFlags(root: string): FlagFile {
  const raw = readText(join(root, SESSION_FLAGS_FILE));
  if (!raw) return { version: 1, sessions: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    const sessions =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { sessions?: unknown }).sessions
        : undefined;
    if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) {
      return { version: 1, sessions: {} };
    }
    const kept: Record<string, FlagEntry> = {};
    for (const [id, value] of Object.entries(sessions as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const entry = value as { on?: unknown; at?: unknown; since?: unknown };
      if (typeof entry.on !== "boolean" || typeof entry.at !== "number") continue;
      kept[id] = {
        on: entry.on,
        at: entry.at,
        ...(typeof entry.since === "number" ? { since: entry.since } : {}),
      };
    }
    return { version: 1, sessions: kept };
  } catch {
    return { version: 1, sessions: {} };
  }
}

/**
 * The session's explicit workflow switch: `true`/`false` when the session set
 * one, `undefined` when it never did (the project switch then decides).
 */
export function sessionFlag(root: string, sessionId: string | null): boolean | undefined {
  const entry = sessionFlagEntry(root, sessionId);
  return entry?.on;
}

/** The whole stored flag, including when this session turned Coworkflow on. */
export function sessionFlagEntry(root: string, sessionId: string | null): FlagEntry | undefined {
  if (!sessionId) return undefined;
  const entry = readFlags(root).sessions[sessionId];
  if (!entry) return undefined;
  return Date.now() - entry.at < FLAG_MAX_AGE_MS ? entry : undefined;
}

/** Epoch ms this session turned Coworkflow on, or undefined when it never did. */
export function sessionEnabledSince(root: string, sessionId: string | null): number | undefined {
  const entry = sessionFlagEntry(root, sessionId);
  if (!entry || entry.on !== true) return undefined;
  return entry.since ?? entry.at;
}

/** Record or clear the session switch, pruning stale entries. Best effort. */
export function setSessionFlag(root: string, sessionId: string, on: boolean | null): boolean {
  const flags = readFlags(root);
  const now = Date.now();
  for (const [id, entry] of Object.entries(flags.sessions)) {
    if (now - entry.at >= FLAG_MAX_AGE_MS) delete flags.sessions[id];
  }
  if (on === null) {
    delete flags.sessions[sessionId];
  } else {
    // Turning it on starts the attribution clock; re-stamping while already on
    // keeps the original instant, so reloading does not reset the window.
    const previous = flags.sessions[sessionId];
    const since = on ? (previous?.on === true ? (previous.since ?? previous.at) : now) : undefined;
    flags.sessions[sessionId] = {
      on,
      at: now,
      ...(since !== undefined ? { since } : {}),
    };
  }

  const entries = Object.entries(flags.sessions).sort((a, b) => b[1].at - a[1].at);
  for (const [id] of entries.slice(FLAG_MAX_ENTRIES)) delete flags.sessions[id];

  try {
    mkdirSync(dirname(join(root, SESSION_FLAGS_FILE)), { recursive: true });
    writeFileSync(join(root, SESSION_FLAGS_FILE), `${JSON.stringify(flags, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
