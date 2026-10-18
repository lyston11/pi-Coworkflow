/**
 * Saving Pi's project-trust decision, the same way `/trust` does.
 *
 * Pi gates `.pi/settings.json`, `.pi/extensions`, `.pi/agents`, `.pi/prompts`,
 * `.pi/skills`, `.pi/mcp.json`, `.pi/SYSTEM.md` and project `.agents/skills`
 * behind a trust decision, so an untrusted project cannot dispatch the Trellis
 * role agents or load the Trellis extension at all. Running `/Coworkflow:init`
 * *is* the human consent for that project, so init records the decision in
 * Pi's own trust store instead of asking the user to approve twice.
 *
 * The store is Pi's: `~/.pi/agent/trust.json`, a map of canonicalized absolute
 * paths to booleans, consulted by nearest-ancestor lookup
 * (`dist/core/trust-manager.js`, `findNearestTrustEntry`). This module mirrors
 * that shape and that lookup, including `realpathSync` canonicalization, so a
 * decision written here behaves exactly like one written by `/trust`.
 *
 * Two properties this deliberately does **not** have:
 *
 *   - It does not trust by marker. An extension *can* answer the
 *     `project_trust` event, but auto-trusting every folder that contains
 *     `.pi/Coworkflow.json` would let a repository grant itself trust by
 *     committing that file — and then run its own `.pi/extensions/*.ts`. Trust
 *     stays a decision made inside a project the user opened, not a property of
 *     a file.
 *   - It does not rewrite a trust file it cannot parse. An unreadable store is
 *     reported instead of being replaced.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Pi's agent directory, honouring the same env override Pi itself uses. */
export function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured === "~") return homedir();
  if (configured?.startsWith("~/") || configured?.startsWith("~\\")) {
    return join(homedir(), configured.slice(2));
  }
  if (configured) return configured;
  const configDir = process.env.PI_CONFIG_DIR?.trim() || ".pi";
  return join(homedir(), configDir, "agent");
}

export function trustFilePath(): string {
  return join(resolve(agentDir()), "trust.json");
}

/** Pi canonicalizes with `realpathSync`, falling back to the given path. */
function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

type TrustData = Record<string, boolean>;

function readTrustFile(path: string): TrustData | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const data: TrustData = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true || value === false) data[key] = value;
    }
    return data;
  } catch {
    return null;
  }
}

/** Nearest-ancestor decision, mirroring Pi's lookup. */
export function nearestTrustDecision(
  root: string,
): { path: string; decision: boolean } | null {
  const data = readTrustFile(trustFilePath());
  if (data === null) return null;
  let current = canonicalize(root);
  for (;;) {
    const decision = data[current];
    if (decision === true || decision === false) return { path: current, decision };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface TrustResult {
  /** Canonical path the decision was written for. */
  path: string;
  /** true when this call changed the store. */
  changed: boolean;
  /** A decision that already applied, when nothing was written. */
  inheritedFrom?: string;
  /** Set when the store could not be read or written. */
  error?: string;
}

/** Record `true` for `root` in Pi's trust store, unless it already applies. */
export function trustProject(root: string): TrustResult {
  const path = canonicalize(root);
  const file = trustFilePath();
  const existing = nearestTrustDecision(root);
  if (existing?.decision === true) {
    return {
      path,
      changed: false,
      ...(existing.path === path ? {} : { inheritedFrom: existing.path }),
    };
  }

  const data = readTrustFile(file);
  if (data === null) {
    return { path, changed: false, error: `${file} 不是合法的 JSON 对象，未改动` };
  }
  data[path] = true;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Temp file + rename: a concurrent Pi process can at worst lose its own
    // entry, never read a half-written store.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, file);
  } catch (error) {
    return {
      path,
      changed: false,
      error: `写入 ${file} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { path, changed: true };
}
