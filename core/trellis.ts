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

import { GIT_TIMEOUT_MS } from "./config.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * Child-facing instructions. Owned by pi-Coworkflow, outside the rendered surface, so
 * a render never treats it as something to reconcile.
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
      // Bounded for the same reason as the config probe: a synchronous child owns the event loop,
      // and "git did not answer" has a representable outcome (`null`) while a hang does not.
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
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
  // `--path-format=absolute` is the supported spelling. `--absolute-git-common-dir`
  // looks like an option but is not one: rev-parse echoes unknown `--` arguments
  // back on stdout with exit 0, so it silently returned its own name and every
  // caller treated the worktree as the main checkout.
  const common =
    runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ??
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

/**
 * The task the given session is working on, from its Trellis session pointer.
 *
 * Accepts either spelling of a session identity — the id Pi's context exposes, or
 * the session file path pi-subagents publishes to a child — because the pointer is
 * keyed by the former and a dispatched child only knows the latter.
 */
export function activeTaskDir(root: string, session: string | null): string | null {
  for (const key of sessionKeys(session)) {
    const raw = readText(join(root, SESSIONS_DIR, `${contextKeyFor(key)}.json`));
    if (!raw) continue;
    try {
      const ref: unknown = (JSON.parse(raw) as { current_task?: unknown }).current_task;
      const resolved = typeof ref === "string" ? resolveTaskDir(root, ref) : null;
      if (resolved) return resolved;
    } catch {
      // A corrupt pointer is not this caller's problem; try the next key.
    }
  }
  return null;
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
  profile: "role" | "task" = "role",
): string {
  const planning = role === "research" && profile === "task";
  if (role === "research" && (!planning || !taskDir)) return specTree(root);
  if (!taskDir) return "";

  const limits = readInjectionLimits(root);
  const budget = new Budget(limits.maxTotalBytes);
  const parts: string[] = [];

  // Planning needs the question before supporting specs; existing implementation
  // and check profiles retain their established manifest-first order.
  if (!planning) parts.push(agentContext(root, taskDir, role, limits, budget));

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
  if (planning) parts.push(agentContext(root, taskDir, "implement", limits, budget));
  return parts.join("\n\n");
}

/** Sentinels around the region `/Coworkflow:init` writes into the project `AGENTS.md`. */
export const MANAGED_REGION_START = "<!-- pi-Coworkflow:start -->";
export const MANAGED_REGION_END = "<!-- pi-Coworkflow:end -->";
/** Sentinels around the block this package appends to a child's system prompt. */
export const CHILD_BLOCK_START = "<!-- pi-Coworkflow:subagent-context -->";
export const CHILD_BLOCK_END = "<!-- pi-Coworkflow:subagent-context:end -->";

/**
 * Remove the managed region (and its heading) from a piece of inherited text.
 *
 * Only the region between the sentinels goes. Everything a project wrote by
 * itself — how to build, which files matter, its own conventions — is what a
 * child still needs, and an earlier version of this function deleted it together
 * with the parent-duty policy because both arrived in the same container.
 *
 * An older block may have been written without the end sentinel; it was always
 * appended last, so the tail is taken as the block. That keeps a prompt that this
 * package already extended from being extended twice.
 */
export function stripManagedRegion(text: string): string {
  if (!text) return text;
  let out = text;
  for (;;) {
    const start = out.indexOf(MANAGED_REGION_START);
    if (start === -1) break;
    const end = out.indexOf(MANAGED_REGION_END, start);
    if (end === -1) break;
    // The region carries its own heading between the sentinels, so cutting
    // exactly between them leaves no orphan title behind.
    const rest = out.slice(end + MANAGED_REGION_END.length).replace(/^\s*/, "");
    out = `${out.slice(0, start).replace(/\s*$/, "")}\n${rest}`;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Strip this package's managed region out of inherited project instructions.
 *
 * Pi renders every discovered `AGENTS.md`/`CLAUDE.md` as
 * `<project_instructions path="…">…</project_instructions>`, and pi-subagents
 * includes them for agents declaring `inheritProjectContext: true` — which the
 * Trellis role templates do. The child must not receive the parent's own duties
 * (planning, dispatch, audit, merge), but it does need the rest of the file, so
 * only the managed region is removed. A container left empty is dropped whole.
 */
export function stripManagedRegionFromPrompt(systemPrompt: string): string {
  if (!systemPrompt) return systemPrompt;
  const withoutContainers = systemPrompt.replace(
    /<project_instructions\b([^>]*)>([\s\S]*?)<\/project_instructions>/g,
    (whole: string, attrs: string, body: string) => {
      const next = stripManagedRegion(body);
      if (!next) return "";
      if (next === body.trim()) return whole;
      return `<project_instructions${attrs}>\n${next}\n</project_instructions>`;
    },
  );
  // A copy outside a container (an unwrapped file, or a prompt Pi built another
  // way) still carries the same policy, so the sentinel scan runs on the rest.
  return stripManagedRegion(withoutContainers);
}

/**
 * Remove a child block this package appended on an earlier run.
 *
 * `before_agent_start` fires for every run of a session, and a session that was
 * injected once must not accumulate one block per run. Building the prompt
 * idempotently means starting from the host's prompt minus our own previous
 * block, never from the host's prompt plus whatever it already carried.
 */
export function stripOwnInjection(systemPrompt: string): string {
  if (!systemPrompt) return systemPrompt;
  let out = systemPrompt;
  for (;;) {
    const start = out.indexOf(CHILD_BLOCK_START);
    if (start === -1) break;
    const end = out.indexOf(CHILD_BLOCK_END, start);
    const stop = end === -1 ? out.length : end + CHILD_BLOCK_END.length;
    const rest = out.slice(stop).replace(/^\s*/, "");
    out = `${out.slice(0, start).replace(/\s*$/, "")}\n${rest}`;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
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

/**
 * The session id encoded in a session file path, when the path carries one.
 *
 * pi-subagents publishes `PI_SUBAGENT_PARENT_SESSION` as the parent session
 * *file* (`~/.pi/agent/sessions/<dir>/<timestamp>_<sessionId>.jsonl`), because
 * that is what it uses to attribute an async run. A child therefore knows its
 * parent by path, while this package records the switch by session id — which is
 * what Pi's command context exposes. Looking up one key space with the other's
 * value never matched, so a dispatched child always read "no flag" and fell back
 * to the project's `autoEnable`, quietly losing the workflow the parent had just
 * started. Reducing the path to the id it contains makes both spellings resolve.
 */
export function sessionIdFromFile(file: string | null | undefined): string | null {
  if (!file) return null;
  const name = file.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/\.jsonl$/i, "");
  // `<timestamp>_<uuid>` is Pi's session file name; anything else is not ours.
  const match = /_([0-9a-fA-F][0-9a-fA-F-]{7,})$/.exec(stem);
  return match?.[1] ?? null;
}

/** Every id-based key a session can be recognised by, path spellings included. */
export function sessionKeys(...candidates: (string | null | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    keys.add(candidate);
    const fromFile = sessionIdFromFile(candidate);
    if (fromFile) keys.add(fromFile);
  }
  return [...keys];
}

export function laneDir(root: string, taskDir: string): string {
  return join(root, LANES_DIR, basename(taskDir));
}

/**
 * Write a whole file without ever exposing a half-written one.
 *
 * Two pi processes can run in the same project — the same session flags file, the same run ledger —
 * and both write from event handlers. A plain truncate-and-write is not atomic: the other process can
 * read it mid-write, fail to parse, and take the empty result as "no flags / no runs" (every reader
 * here swallows a parse error by design). Temp-then-rename in the same directory makes the swap
 * atomic, so a concurrent reader sees the old file or the new one, never a fragment.
 */
export function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // A leftover temp file is harmless; failing to remove it must not mask the original error.
    }
    throw error;
  }
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
    writeFileAtomic(join(root, SESSION_FLAGS_FILE), `${JSON.stringify(flags, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
