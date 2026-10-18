/**
 * Shared contract for workflow modules.
 *
 * A module owns one layer of the workflow and nothing else: it writes its own
 * files, registers its own hooks, and reports what it did. The orchestrator in
 * `extensions/workflow.ts` only sequences modules and renders their reports, so
 * adding, removing, or skipping a layer never touches the others.
 *
 * Modules never import Pi types: the surface they need from the host is tiny,
 * and declaring it here keeps every module self-contained and typecheckable
 * without Pi installed. The Trellis Pi extension takes the same approach.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Status = "created" | "updated" | "ok" | "skipped" | "warn" | "error";

/** Glyph per status, so a report is scannable in one pass. */
export const MARK: Record<Status, string> = {
  created: "+",
  updated: "~",
  ok: "=",
  skipped: "-",
  warn: "!",
  error: "x",
};

export interface ModuleContext {
  /** Repository root the module writes into. */
  root: string;
  /** Worktree directory prefix, for modules that spell out worktree paths. */
  prefix: string;
  /** Report only: never touch the filesystem. */
  dry: boolean;
  /** Command-line switches and project values a module may act on. */
  options?: Record<string, boolean | number | undefined>;
  /** Append a result line to this module's report. */
  report(status: Status, message: string): void;
  /** Read a file, or `null` when it does not exist. */
  read(path: string): string | null;
  /** Write when the content differs. Returns what happened; honours `dry`. */
  write(path: string, body: string, options?: { mode?: number }): Status;
}

export interface WorkflowModule {
  /** Stable id used by `--only` / `--skip`. */
  id: string;
  /** One-line description rendered as the module's report header. */
  title: string;
  /**
   * Install-time layer: files and registrations written into the project.
   * Omitted by modules that only contribute runtime behaviour.
   */
  apply?(ctx: ModuleContext): void | Promise<void>;
  /**
   * Undo what `apply` wrote, for a module that was just switched off. Only for
   * artifacts this package owns and can safely remove; anything owned by
   * another tool is left alone and reported instead.
   */
  remove?(ctx: ModuleContext): void | Promise<void>;
  /**
   * Runtime layer: hooks the module registers in a Pi session, in the parent
   * session, in a dispatched child, or in both. Called once per session load,
   * with `runtime.isChild` telling the module which side it is on.
   *
   * Hooks registered here are gated: unless the module is `alwaysActive`, the
   * handler must return early while `runtime.enabled` is false, so the project
   * switch and `/workflow-session` can turn the layer on and off within one
   * session.
   */
  activate?(host: PiRuntimeHost, runtime: RuntimeContext): void;
  /**
   * Called when this session turns the workflow on after load — the user ran
   * `/Coworkflow:start`, or the project auto-enables and the session had not
   * been switched off. A module uses it to register the feature commands that
   * only exist while the workflow is loaded (`/Comodels`, `/Coworkflow:lanes`).
   * Must be idempotent: it runs once per session at most, and also at load when
   * the workflow is already on.
   */
  onSessionActivate?(host: PiRuntimeHost, runtime: RuntimeContext): void;
  /**
   * Control surfaces that stay usable while the workflow layer is off — the
   * settings panel and the workflow commands themselves.
   */
  alwaysActive?: boolean;
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read an asset that sits next to the module that uses it, so a module can be
 * moved or deleted without touching a central asset table.
 */
export function moduleAsset(moduleUrl: string, relative: string): string | null {
  try {
    return readFileSync(fileURLToPath(new URL(relative, moduleUrl)), "utf-8");
  } catch {
    return null;
  }
}

export function createContext(options: {
  root: string;
  prefix: string;
  dry: boolean;
  flags?: Record<string, boolean | number | undefined>;
  report(status: Status, message: string): void;
}): ModuleContext {
  return {
    root: options.root,
    prefix: options.prefix,
    dry: options.dry,
    options: options.flags ?? {},
    report: options.report,
    read: readText,
    write(path, body, writeOptions) {
      const current = readText(path);
      if (current === body) return "ok";
      const status: Status = current === null ? "created" : "updated";
      if (!options.dry) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
        if (writeOptions?.mode !== undefined) chmodSync(path, writeOptions.mode);
      }
      return status;
    },
  };
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

/**
 * A file-only context for code that needs `read`/`write` outside an install
 * run — a runtime command editing project settings, for example. Never dry:
 * the caller is an explicit user action.
 */
export function fileContext(root: string): ModuleContext {
  return createContext({ root, prefix: "", dry: false, report: () => {} });
}

/** Minimal host surface. Declared here so the package needs no Pi types. */
export type RuntimeEventHandler = (event: any, ctx: any) => any;

export interface PiRuntimeHost {
  on?(event: string, handler: RuntimeEventHandler): unknown;
  registerCommand?(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: any) => Promise<void> | void;
    },
  ): void;
  sendMessage?(message: { customType: string; content: string; display?: boolean }): void;
  /**
   * Queue a user-role message, which starts a turn. Used to hand the model a
   * follow-up instruction it must act on (e.g. re-dispatch a failed lane)
   * without the user typing anything.
   */
  sendUserMessage?(message: { content: string }): void;
  /** The session's display name; a child's is `<agent>: <task excerpt>`. */
  getSessionName?(): string | undefined;
  /** Model and thinking control; all session-scoped. */
  setModel?(model: unknown): Promise<boolean>;
  setThinkingLevel?(level: string): void;
  getThinkingLevel?(): string | undefined;
}

/** What a module needs to know about the session it is activating in. */
export interface RuntimeContext {
  /** True in a dispatched child (pi-subagents), false in the session the user drives. */
  isChild: boolean;
  /**
   * Whether the workflow layer is on for this session. Mutable: the project
   * switch sets it at load, `/workflow-session` changes it, and every hook
   * reads it at call time.
   */
  enabled: boolean;
  /** Cwd at extension load; hooks should prefer their own `ctx.cwd`. */
  cwd: string;
  /** Session id, when the host exposes one. */
  sessionId: string | null;
  /** Parent session id, set only in a child. */
  parentSessionId: string | null;
  /**
   * Why this session is (not) running the layer, in the user's words.
   *
   * `/reload` re-loads extensions but not the session switch, so "not loaded"
   * after a reload is expected rather than a broken install; a refusal that
   * cannot tell the two apart sends the user looking for a bug.
   */
  loadState: "child" | "off" | "auto" | "started";
  /**
   * Re-read the session switch from disk.
   *
   * `/reload` and session switches race with cached state: the flag is written by
   * one process invocation and read by the next hook. Re-resolving on demand
   * (rather than trusting the value captured at load) makes the switch
   * self-healing instead of depending on exactly which event fired when.
   */
  refresh(): void;
  /**
   * Project configuration and init, exposed by the orchestrator so a panel can
   * flip switches and run maintenance without importing the orchestrator.
   */
  control: WorkflowControl;
}

/**
 * The control surface a panel uses: read the project's state, change it, and run
 * the same operations the slash commands run.
 */
export interface WorkflowControl {
  /** Whether the project has been initialized (`.pi/Coworkflow.json` exists). */
  initialized(): boolean;
  /** Module id → switch, for every module the build knows about. */
  switches(): Record<string, boolean>;
  moduleIds(): string[];
  autoEnable(): boolean;
  prefix(): string;
  /** Read-only lines describing the project, for the settings panel. */
  facts(): string[];
  /** Persist a module switch and apply or remove that module's artifacts. */
  setSwitch(id: string, on: boolean): string;
  setAutoEnable(on: boolean): string;
  setPrefix(prefix: string): string;
  /**
   * Concurrent async subagent runs this project allows, or null for no project
   * limit. pi-subagents has no project-level override for its own capacity key,
   * so this number is enforced by the `capacity` module.
   */
  subagentConcurrency(): number | null;
  setSubagentConcurrency(value: number | null): string;
  /** Why this session is (not) loaded: `off`, `auto`, `started`, or `child`. */
  loadState(): RuntimeContext["loadState"];
  /** Run the full init/refresh pass, as `/Coworkflow:init` does. */
  init(args: string): string;
}

/** Render one module's report block. */
export function renderModule(
  module: WorkflowModule,
  steps: { status: Status; message: string }[],
): string {
  const lines = steps.map((step) => `  ${MARK[step.status]} ${step.message}`);
  return [`[${module.id}] ${module.title}`, ...lines].join("\n");
}
