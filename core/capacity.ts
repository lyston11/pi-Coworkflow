/**
 * Observing pi-subagents' active async runs.
 *
 * pi-subagents keeps one directory per async run under a temp root
 * (`os.tmpdir()/pi-subagents-<scope>/async-subagent-runs`, or
 * `PI_SUBAGENTS_TEMP_ROOT`), each with a `status.json` holding `state`, `pid`,
 * `cwd` and — importantly — `sessionId`, which is the *parent session file* that
 * owns the run.
 *
 * That makes the same accounting pi-subagents does for its own
 * `maxActiveAsyncRunsPerSession` observable from outside, which is what the
 * project-scoped capacity gate needs: pi-subagents reads its capacity only from
 * its own user-level config file, with no project override, so a project-level
 * limit has to be enforced by the project.
 *
 * The terminal set mirrors `TERMINAL_STATES` in pi-subagents'
 * `runs/background/async-retention.js`, so a run is only released here when
 * pi-subagents would consider it finished.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** States that mean a run no longer occupies capacity. */
export const TERMINAL_RUN_STATES = new Set(["complete", "failed", "stopped", "rejected"]);

export interface ActiveRun {
  runId: string;
  state: string;
  agent?: string;
  pid?: number;
  startedAt?: number;
  lastUpdate?: number;
}

/** Mirror of pi-subagents' `resolveTempScopeId`. */
function tempScopeId(): string {
  try {
    const uid = process.getuid?.();
    if (typeof uid === "number") return `uid-${uid}`;
  } catch {
    // Fall through to the environment-based scope.
  }
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return `user-${value.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  }
  try {
    return `user-${userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  } catch {
    return `user-${homedir().split(/[\\/]/).pop() ?? "unknown"}`;
  }
}

/** pi-subagents' async run root, honouring its own env override. */
export function asyncRunsRoot(): string {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const root = configured ? configured : join(tmpdir(), `pi-subagents-${tempScopeId()}`);
  return join(root, "async-subagent-runs");
}

function readStatus(runDir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, "status.json"), "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Async runs still occupying capacity, owned by the given parent session.
 *
 * `sessionFile` is the parent session's `.jsonl` path, which is exactly what
 * pi-subagents stores in `status.json`. A run whose state is non-terminal but
 * whose recorded process is gone is released too: that is real evidence rather
 * than a timeout guess, and without it a crashed runner could hold the project's
 * capacity forever.
 */
export function activeRunsForSession(sessionFile: string | null): ActiveRun[] {
  if (!sessionFile) return [];
  const root = asyncRunsRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const active: ActiveRun[] = [];
  for (const entry of entries) {
    const status = readStatus(join(root, entry));
    if (status === null) continue;
    if (status.sessionId !== sessionFile) continue;
    const state = typeof status.state === "string" ? status.state : "";
    if (TERMINAL_RUN_STATES.has(state)) continue;
    if (status.endedAt !== undefined && !isProcessAlive(status.pid)) continue;
    active.push({
      runId: typeof status.runId === "string" ? status.runId : entry,
      state: state || "unknown",
      ...(agentNameOf(status) ? { agent: agentNameOf(status) } : {}),
      ...(typeof status.pid === "number" ? { pid: status.pid } : {}),
      ...(typeof status.startedAt === "number" ? { startedAt: status.startedAt } : {}),
      ...(typeof status.lastUpdate === "number" ? { lastUpdate: status.lastUpdate } : {}),
    });
  }
  return active.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** The run's agent name lives on its first step, not on the run record. */
function agentNameOf(status: Record<string, unknown>): string | undefined {
  const steps = status.steps;
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    if (step === null || typeof step !== "object") continue;
    const agent = (step as { agent?: unknown }).agent;
    if (typeof agent === "string" && agent.trim()) return agent.trim();
  }
  return undefined;
}

/**
 * Whether a `subagent` tool call would start a new run rather than read or
 * manage existing ones. Management actions (`status`, `lane.*`, `worktree.*`,
 * `mission.*`, `doctor`, …) must never be blocked, or a session at its cap could
 * not even ask what is running.
 */
export function startsNewRun(input: Record<string, unknown>): boolean {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (action && action !== "resume" && action !== "append-step") return false;
  // A foreground call blocks the parent and reserves no async slot in
  // pi-subagents' own accounting, so it is not counted here either.
  if (input.async === false) return false;
  return true;
}

/** Reservations older than this are dropped: the call must have failed. */
const RESERVATION_TTL_MS = 5 * 60 * 1000;
/** Allowance for the run's own timestamp lagging the reservation clock. */
const RESERVATION_MATCH_SKEW_MS = 2000;

export interface CapacitySnapshot {
  /** Runs already visible in pi-subagents' run directory. */
  runs: ActiveRun[];
  /** Dispatches admitted in this process whose run is not on disk yet. */
  pending: number;
  /** What the limit is compared against. */
  total: number;
}

/**
 * In-process reservation of dispatch slots.
 *
 * Reading pi-subagents' run directory has a blind spot: two `subagent` calls
 * issued in the *same* assistant turn are both evaluated before the first run's
 * `status.json` exists, so a disk-only count would let both through. A
 * reservation taken at `tool_call` and released at the matching `tool_result`
 * closes that window.
 *
 * A reservation is not counted once a run it could have created is visible —
 * matched by `startedAt` at or after the reservation — so a run never counts
 * twice while its tool call is still open. Reservations are keyed by tool call id
 * and expire, so a blocked or failed call cannot hold a slot forever.
 */
export class CapacityTracker {
  private readonly reservations = new Map<string, number>();

  reserve(toolCallId: string, at = Date.now()): void {
    this.reservations.set(toolCallId, at);
  }

  release(toolCallId: string): void {
    this.reservations.delete(toolCallId);
  }

  snapshot(sessionFile: string | null, now = Date.now()): CapacitySnapshot {
    for (const [id, at] of this.reservations) {
      if (now - at > RESERVATION_TTL_MS) this.reservations.delete(id);
    }

    const runs = activeRunsForSession(sessionFile);
    if (this.reservations.size === 0) {
      return { runs, pending: 0, total: runs.length };
    }

    // Claim visible runs for the oldest reservations first, so each run cancels
    // at most one reservation.
    const claimed = new Set<string>();
    const ordered = [...this.reservations.entries()].sort((a, b) => a[1] - b[1]);
    let pending = 0;
    for (const [, at] of ordered) {
      const match = runs.find(
        (run) =>
          !claimed.has(run.runId) &&
          run.startedAt !== undefined &&
          run.startedAt >= at - RESERVATION_MATCH_SKEW_MS,
      );
      if (match) claimed.add(match.runId);
      else pending += 1;
    }
    return { runs, pending, total: runs.length + pending };
  }
}
