/**
 * Project-level workflow config: `.pi/Coworkflow.json`.
 *
 * Two decisions live here, both deliberately per project:
 *
 *   1. **Opt-in.** No file means this project has not adopted the workflow, so
 *      the extension does nothing in it — no install steps, no runtime hooks,
 *      no prompt injection. A project that already has its own workflow design
 *      is unaffected until someone runs `/workflow-setup` there.
 *   2. **Per-module switches.** Each module can be enabled or disabled on its
 *      own, so a project can take the Trellis layer without the delegation
 *      policy, or the injection without the lane ledger.
 *
 * The file is meant to be committed: it is project configuration, unlike the
 * lane pointers under `.trellis/.runtime/`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mainCheckout, repoRoot } from "./trellis.ts";

export const CONFIG_REL = join(".pi", "Coworkflow.json");
/** The file name this package used before it was renamed to pi-Coworkflow. */
export const LEGACY_CONFIG_REL = join(".pi", "trellis-workflow.json");

export interface WorkflowConfig {
  version: 1;
  /** ISO timestamp of the last `/workflow-setup`. */
  installedAt?: string;
  /** Worktree directory prefix this project installed with. */
  worktreePrefix?: string;
  /**
   * Whether a new session turns the runtime modules on by itself. Absent or
   * false means the project is installed but inert: `/workflow-session on`
   * enables it for one session.
   */
  autoEnable?: boolean;
  /**
   * Concurrent async subagent runs this project allows. `undefined` means no
   * project limit, so pi-subagents' own (user-level) setting applies unchanged.
   */
  subagentConcurrency?: number;
  /** Module id → enabled. An absent id is disabled. */
  modules: Record<string, boolean>;
}

export function configPath(root: string): string {
  return join(root, CONFIG_REL);
}

export function legacyConfigPath(root: string): string {
  return join(root, LEGACY_CONFIG_REL);
}

/**
 * The checkout whose config governs this session.
 *
 * Resolved through the main checkout so a lane or task worktree — which only
 * carries committed files — still finds the project's config.
 */
export function configRoot(cwd: string): string {
  return mainCheckout(repoRoot(cwd));
}

/** The project's config, or `null` when the project has not opted in. */
export function readConfig(root: string): WorkflowConfig | null {
  // The pre-rename file is read as a fallback so an adopted project keeps its
  // switches until the next run rewrites them under the new name.
  for (const path of [configPath(root), legacyConfigPath(root)]) {
    const raw = tryRead(path);
    if (raw === null) continue;
    const parsed = parseConfig(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function parseConfig(raw: string): WorkflowConfig | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as {
      modules?: unknown;
      worktreePrefix?: unknown;
      installedAt?: unknown;
      autoEnable?: unknown;
      subagentConcurrency?: unknown;
    };
    const modules: Record<string, boolean> = {};
    if (record.modules !== null && typeof record.modules === "object" && !Array.isArray(record.modules)) {
      for (const [id, value] of Object.entries(record.modules as Record<string, unknown>)) {
        modules[id] = value === true;
      }
    }
    return {
      version: 1,
      ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
      ...(typeof record.worktreePrefix === "string" ? { worktreePrefix: record.worktreePrefix } : {}),
      ...(record.autoEnable === true ? { autoEnable: true } : {}),
      ...(typeof record.subagentConcurrency === "number" &&
      Number.isInteger(record.subagentConcurrency) &&
      record.subagentConcurrency > 0
        ? { subagentConcurrency: record.subagentConcurrency }
        : {}),
      modules,
    };
  } catch {
    return null;
  }
}

/**
 * Write the config and retire the pre-rename file, so a project that adopted
 * the package under its old name keeps its switches instead of reading as
 * uninstalled.
 */
export function writeConfig(root: string, config: WorkflowConfig): void {
  const path = configPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  try {
    rmSync(legacyConfigPath(root));
  } catch {
    // No legacy file: nothing to retire.
  }
}

/**
 * Whether a module is on.
 *
 * Only an explicit `false` turns a module off: a key that is absent means the
 * module did not exist when the config was written, so a newly added layer
 * starts on instead of silently staying off in every existing project. Every
 * run rewrites the full switch map, so absence only happens that way.
 */
export function isEnabled(config: WorkflowConfig | null, id: string): boolean {
  return config !== null && config.modules[id] !== false;
}

export function enabledIds(config: WorkflowConfig | null, all: string[]): string[] {
  return all.filter((id) => isEnabled(config, id));
}
/** One-line switch summary for reports, for example `trellis=on worktree=off`. */
export function describeSwitches(config: WorkflowConfig | null, all: string[]): string {
  if (config === null) return "未安装（本项目的扩展不生效）";
  return all.map((id) => `${id}=${isEnabled(config, id) ? "on" : "off"}`).join(" ");
}

export function configExists(root: string): boolean {
  return existsSync(configPath(root));
}
