/**
 * Shared contract for workflow modules.
 *
 * A module owns one layer of the workflow and nothing else: it writes its own
 * files, registers its own hooks, and reports what it did. The orchestrator in
 * `extensions/coworkflow.ts` only sequences modules and renders their reports, so
 * adding, removing, or switching off a layer never touches the others.
 *
 * Modules never import Pi types: the surface they need from the host is tiny,
 * and declaring it here keeps every module self-contained and typecheckable
 * without Pi installed. The Trellis Pi extension takes the same approach.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigRootResolver, ResolvedAgentKind, SwitchDefault } from "./config.ts";

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
  /** Delete a file this package owns. A no-op when it is already gone. */
  remove(path: string): Status;
}

export interface WorkflowModule {
  /** Stable id: `--enable` / `--disable`, the config's switch map, and reports. */
  id: string;
  /** One-line description rendered as the module's report header. */
  title: string;
  /**
   * What an *absent* switch key means for this module in a project that has
   * never chosen for it — that is, a project whose config was written before
   * this module existed. `"on"` (the default) for a module that only observes,
   * records, or adds a capability: it starts working by itself, the way every
   * module added so far did.
   *
   * A module that can *refuse* work declares `"off"`: a dispatch gate, an
   * admission limit, a validator. An upgrade must never silently begin policing
   * a project that never opted in, so the answer is taken from what the code
   * does, not from the module's name. An explicit value in the project's config
   * always wins over this declaration in both directions.
   */
  newSwitchDefault?: SwitchDefault;
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
   * with `runtime.isChild` telling the module which side it is on, and again when
   * a session that started with the layer off turns it on (`ensureRuntime`).
   *
   * Two gate levels, and a module states which one it uses:
   *
   *   session  hooks that act on the model's behaviour (injection, dispatch
   *            gates, feature commands) must read `runtime.enabled` at event
   *            time — never capture it — so `/Coworkflow:start off` really does
   *            return the session to plain Pi, and turning it back on works
   *            without a restart. `runtime.refresh()` re-reads the switch;
   *            `runtime.sessionEpoch` changes when the host starts another
   *            session, so a module with cached state resets on it.
   *   project  hooks that only *record* what happened (the lane ledger) gate on
   *            the project being adopted instead: a dispatch from a session that
   *            never loaded the layer still produced artifacts, and dropping it
   *            would make the record under-report.
   *
   * `activate` must be idempotent for its own registrations, because a session
   * can turn the layer on after load. Register the cleanup it needs even while
   * the layer is off: a hook that never fires still owns a listener, and
   * `onSessionEnd` is the only place to release whatever `activate` acquired.
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
   * Re-read both live gates (`runtime.enabled` and the project's module switch)
   * and make this module's runtime registrations match them. Idempotent.
   *
   * The orchestrator calls it after it updates session identity on
   * `session_start`, when the session switch flips, and when a project module
   * switch is written — so a module that owns session-scoped resources which the
   * upstream package registers *per session* (a workflow resource, a required
   * child extension) can withdraw them when the layer goes off and reinstate them
   * when it comes back on, with no reload and no timer.
   */
  onRuntimeChange?(host: PiRuntimeHost, runtime: RuntimeContext): void;
  /**
   * Idempotent cleanup for everything `activate` acquired, called when the host
   * ends this session: quit, `/reload`, or a session replacement (`new`,
   * `resume`, `fork`). It must not throw, must tolerate being called twice, and
   * must leave nothing behind that would act on the *next* session.
   */
  onSessionEnd?(host: PiRuntimeHost, runtime: RuntimeContext): void;
  /**
   * Lines describing this module's runtime state, for `/Coworkflow:status`.
   *
   * A passive state is stored here and read on demand: it never becomes a
   * message of its own, because a status line that arrives as a user message
   * starts a turn and rewrites the run it was meant to describe.
   */
  runtimeStatus?(host: PiRuntimeHost): string[] | null;
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
    remove(path) {
      if (readText(path) === null) return "ok";
      if (!options.dry) rmSync(path, { force: true });
      return "updated";
    },
  };
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
/** What `pi.on` returns: dropping one registration, which lifecycle cleanup uses. */
export type Unsubscribe = () => void;

/**
 * Pi's shared extension event bus (`pi.events`), reduced to what is used here.
 *
 * It is a plain string-keyed channel with no request/response of its own, so a
 * caller that needs a reply carries the reply channel in its own payload. That is
 * how pi-subagents publishes its RPC surface, and talking to it means using this
 * bus rather than reading its private files. `on` returns the unsubscribe for
 * that single listener, which session cleanup must call.
 */
export interface ExtensionEvents {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): Unsubscribe;
}

export interface PiRuntimeHost {
  on?(event: string, handler: RuntimeEventHandler): Unsubscribe | void;
  /** Shared bus between extensions; absent when the host does not expose one. */
  events?: ExtensionEvents;
  registerCommand?(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: any) => Promise<void> | void;
    },
  ): void;
  sendMessage?(message: { customType: string; content: string; display?: boolean }): void;
  /**
   * Queue a user-role message, which starts a turn.
   *
   * Declared because a host may expose it, and this package deliberately never
   * calls it: a status line that arrives as the user's own words reads as a
   * prompt injection and rewrites the run it was meant to describe. Explicit
   * command reports use `sendMessage` with `display: true`; that flag controls
   * transcript visibility, not exclusion from model context. Passive status
   * must stay out of messages.
   */
  sendUserMessage?(message: { content: string }): void;
  /** The session's display name; a child's is `<agent>: <task excerpt>`. */
  getSessionName?(): string | undefined;
  /** Native session metadata, excluded from model messages. */
  appendEntry?<T = unknown>(customType: string, data?: T): void;
  /**
   * The tools declared to the model right now, by name.
   *
   * Declared because this package must not tell a session to dispatch when the
   * `subagent` tool is not there to dispatch with: pi-subagents missing, not yet
   * loaded, or a project Pi will not trust all produce a session where the managed
   * region says "执行全部交出去" and the model has nothing to hand work to. That is
   * worse than saying nothing — it produced a session that apologised for breaking a
   * rule it could not have followed.
   */
  getActiveTools?(): string[];
  /** Every configured tool, active or not, with its exposure. */
  getAllTools?(): Array<{ name?: string; exposure?: string }>;
  /**
   * Set the tools declared to the model.
   *
   * Used for one narrow repair: a session resumed from history that predates pi-subagents
   * gets its old tool list back, so a configured `subagent` tool is present but not
   * active. Declaring it again is what the project already asked for by enabling the
   * module; without it the only remedy is a CLI flag on every launch.
   */
  setActiveTools?(names: string[]): void;
  /** Model and thinking control; all session-scoped. */
  setModel?(model: unknown): Promise<boolean>;
  setThinkingLevel?(level: string): void;
  getThinkingLevel?(): string | undefined;
  /**
   * Register a model-callable tool for this session.
   *
   * Declared minimally — a name, a description, a JSON Schema for the parameters and an
   * `execute` — because that is all this package uses. Registering the same name again
   * replaces the earlier registration, which is what makes activation idempotent.
   */
  registerTool?(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: unknown,
      signal?: unknown,
      onUpdate?: unknown,
      ctx?: unknown,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    }>;
  }): void;
}

/** What a module needs to know about the session it is activating in. */
export interface RuntimeContext {
  /** True in a dispatched child (pi-subagents), false in the session the user drives. */
  isChild: boolean;
  /**
   * Whether the workflow layer is on for this session. Mutable: the project
   * switch sets it at load, `/Coworkflow:start` changes it, and every hook
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
   * Incremented every time the host announces another session in this runtime
   * (`session_start`: startup, reload, new, resume, fork).
   *
   * A module that caches anything session-scoped records the epoch it built at
   * and rebuilds when the number moves. It is the only signal that arrives
   * *before* the session-scoped hooks of the new session, which is why the
   * orchestrator updates identity and this counter first.
   */
  sessionEpoch: number;
  /**
   * Why this session is (not) running the layer, in the user's words.
   *
   * `/reload` re-loads extensions but not the session switch, so "not loaded"
   * after a reload is expected rather than a broken install; a refusal that
   * cannot tell the two apart sends the user looking for a bug.
   */
  loadState: "child" | "off" | "auto" | "started";
  /**
   * The configuration root for this runtime, resolved once and reused.
   *
   * Modules must read the project config through this instead of calling
   * `configRoot(cwd)` themselves: gates run on every `tool_call` and
   * `before_agent_start`, and the uncached call spawns `git` each time. The
   * resolver is keyed on cwd and `sessionEpoch`, so a session replacement or a
   * lane/worktree switch re-resolves by itself, and an answer it cannot
   * establish is reported as `unresolved` rather than as the current directory.
   */
  configRoots: ConfigRootResolver;
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
  /**
   * The configuration root this runtime resolved, or `null` when it could not.
   *
   * Read from the per-runtime resolver, so a panel or a module asking twice in a
   * turn spawns nothing the second time.
   */
  configRoot(): string | null;
  /** Why the root is what it is, or `null` for the ordinary case. */
  configRootNote(): string | null;
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
  /** Minutes one dispatched child run gets; `null` means the built-in default. */
  runBudgetMinutes(): number | null;
  setRunBudgetMinutes(value: number | null): string;
  setSubagentConcurrency(value: number | null): string;
  /**
   * The project's subagent kinds with every default applied, read from disk.
   *
   * The panel renders these and the gate admits against them, so there is one
   * decoder for "what is this project's kind policy" rather than a panel copy
   * that can disagree with what a dispatch is actually measured against.
   */
  agentKinds(): ResolvedAgentKind[];
  /**
   * Persist one kind's policy; an absent field keeps the current value, and
   * `null` for the limit means "back to the built-in default".
   *
   * `model` and `thinking` follow the same rule with one difference in meaning:
   * `null` there means **inherit** (the key is deleted), because absent is how a
   * kind says it has no model of its own. A malformed value is refused with a
   * message rather than written: the decoder would drop it on the next read, so
   * writing it would only produce a setting the project believes it made.
   *
   * A promise, because applying it means re-registering with the owner: the
   * caller reports what actually happened (`已注册` / `注册失败：…`) instead of a
   * policy it just wrote while the agent list may not contain the kind yet.
   */
  setAgentKind(
    kind: string,
    patch: {
      enabled?: boolean;
      maxConcurrent?: number | null;
      model?: string | null;
      thinking?: string | null;
    },
  ): string | Promise<string>;
  /**
   * Write or update one project kind definition, validating before touching the file.
   *
   * The DIY port's single writer: the command and the public request both come through here,
   * so "what a definition is" has one implementation and a rejected value cannot leave a
   * half-written file behind.
   */
  defineKind(kind: string, patch: Record<string, unknown>): string | Promise<string>;
  /** Delete a project definition file; refuses anything outside the definitions directory. */
  removeKind(kind: string): string | Promise<string>;
  /**
   * The `agent-kinds` module's own status lines: which kinds registered, or the
   * exact reason none did. Empty when the module is not active in this session.
   *
   * The panel shows these instead of computing an availability of its own — a
   * kind that never registered must not appear available anywhere.
   */
  agentKindStatus(): string[];
  /**
   * Wait for the pending kind reconciliation to land.
   *
   * Registration goes through an import of the installed owner's public subpath,
   * so the snapshot that `agentKindStatus` reads is `null` until that pass finishes.
   * A panel opening in that window would show "not loaded" for a loaded session;
   * awaiting here is what makes its rows describe the state that exists now.
   * Resolves immediately when nothing is pending.
   */
  settleAgentKinds(): Promise<void>;
  /** Let the subagent-layer registrations settle, so a report describes finished work. */
  settleSubagents(): Promise<void>;
  /** Why this session is (not) loaded: `off`, `auto`, `started`, or `child`. */
  loadState(): RuntimeContext["loadState"];
  /**
   * Whether the project still has this module switched on, read from
   * `.pi/Coworkflow.json` right now.
   *
   * A hook registered while a module was on cannot be unregistered by switching
   * it off, so a module asks this at event time instead of trusting the fact that
   * it was activated. Both gates are then live: the project switch says whether
   * the layer exists here, `runtime.enabled` says whether this session runs it.
   */
  moduleEnabled(id: string): boolean;
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
