/**
 * Pi's agent directory, and the paths inside it this package reads.
 *
 * Every module that looks at user-level state must resolve it the same way Pi
 * does, or the package disagrees with itself: a machine running with
 * `PI_CODING_AGENT_DIR` or `PI_CONFIG_DIR` set would have its trust decision
 * written to the right store (via `trust.ts`) while `pi-subagents` detection
 * looked in `~/.pi/agent` and found nothing — then "fixed" that by installing a
 * second copy into the project.
 *
 * The derivation mirrors Pi's own: `PI_CODING_AGENT_DIR` wins, otherwise
 * `~/$PI_CONFIG_DIR/agent` (default `~/.pi/agent`). `trust.ts` re-exports this
 * for its own store path.
 */

import { homedir } from "node:os";
import { join } from "node:path";

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

/** The user-level settings file Pi reads (`packages`, `subagents.*`, …). */
export function userSettingsPath(): string {
  return join(agentDir(), "settings.json");
}

/** pi-subagents' own user-level config file (capacity, context default, …). */
export function userSubagentConfigPath(): string {
  return join(agentDir(), "extensions", "subagent", "config.json");
}

/** Where Pi installs npm packages declared by any settings file. */
export function npmPackagesDir(): string {
  return join(agentDir(), "npm", "node_modules");
}
