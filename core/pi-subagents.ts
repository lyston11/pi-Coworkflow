/**
 * The pi-subagents contract this package depends on.
 *
 * Three of this package's modules read pi-subagents' on-disk state rather than
 * its API: `capacity` counts async runs, `subagent-context` recognises a child's
 * role from its session name, and the panels read run artifacts. Those shapes
 * belong to pi-subagents and can change under us, so instead of mirroring them
 * silently (and failing silently) this file centralizes the reads and gives the
 * callers a way to *detect* a broken contract and say so.
 *
 * The probe is deliberately cheap and non-throwing: one directory listing plus
 * one small JSON read, and "unknown" (no runs on disk yet) is treated as healthy
 * so a fresh machine does not see a warning it cannot act on.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { npmPackagesDir, userSubagentConfigPath } from "./agentdir.ts";
import { asyncRunsRoot } from "./capacity.ts";

export function subagentsPackageDir(): string {
  return join(npmPackagesDir(), "pi-subagents");
}

/** Installed pi-subagents version, or null when it is not in Pi's npm dir. */
export function installedVersion(): string | null {
  try {
    const raw = readFileSync(join(subagentsPackageDir(), "package.json"), "utf-8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export interface SubagentsUserConfig {
  /** Its own user-level capacity limit; there is no project override for it. */
  maxActiveAsyncRunsPerSession?: number;
  /** `fork` would hand a Trellis child the parent's prompt instead of its role context. */
  defaultSubagentContext?: string;
}

export function readUserConfig(): SubagentsUserConfig | null {
  let raw: string;
  try {
    raw = readFileSync(userSubagentConfigPath(), "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const limit = parsed.maxActiveAsyncRunsPerSession;
    const context = parsed.defaultSubagentContext;
    return {
      ...(typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? { maxActiveAsyncRunsPerSession: limit }
        : {}),
      ...(typeof context === "string" ? { defaultSubagentContext: context } : {}),
    };
  } catch {
    return null;
  }
}

export interface RunLedgerProbe {
  /**
   * `ok`      — the shape this package expects is present (or not yet testable).
   * `broken`  — a run record exists but lacks the fields the caller needs.
   */
  state: "ok" | "broken";
  /** How many run records were inspected. */
  sampled: number;
  /** What is missing, for the report. */
  missing: string[];
}

/**
 * Check that pi-subagents' `status.json` still carries what the callers read.
 *
 * `core/capacity.ts` attributes a run to a session through `status.sessionId`,
 * which is the parent session *file* path. If that field disappears the count
 * silently becomes zero — a project limit that never blocks anything is worse
 * than no limit, because it looks enforced. Probing one real record turns that
 * silence into a reportable warning.
 */
export function probeRunLedger(): RunLedgerProbe {
  const root = asyncRunsRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { state: "ok", sampled: 0, missing: [] };
  }

  const missing = new Set<string>();
  let sampled = 0;
  for (const entry of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, entry, "status.json"), "utf-8"));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    sampled += 1;
    const record = parsed as Record<string, unknown>;
    if (typeof record.sessionId !== "string") missing.add("sessionId");
    if (typeof record.state !== "string") missing.add("state");
    if (sampled >= 20) break;
  }

  return {
    state: sampled > 0 && missing.size > 0 ? "broken" : "ok",
    sampled,
    missing: [...missing],
  };
}
