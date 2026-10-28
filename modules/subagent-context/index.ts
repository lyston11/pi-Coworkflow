/**
 * Module: role-scoped Trellis context for dispatched children.
 *
 * A child launched with `context: "fresh"` inherits nothing, so it must be told
 * what task it belongs to and handed exactly the context its role needs — the
 * upstream Trellis sub-agent design, minus the cold `pi --mode json -p
 * --no-session` subprocess and the blocked main session.
 *
 * Where the facts come from, in order:
 *
 *   role  — the `role:` frontmatter of the kind the child was dispatched as, read
 *           from that kind's definition file (or the shipped asset standing in for
 *           it). A `<!-- trellis-agent: <role> -->` marker in the agent definition
 *           or dispatch prompt is accepted as well — but only when no kind claims
 *           the name: a kind that declared `role: none` has answered, and a marker
 *           must not overrule its own definition. **The session name is not the
 *           source of a role**: only the kind behind that name is, so `trellis-check`
 *           gets the generic child treatment instead of someone else's context.
 *   task  — the `Active task: <path>` line of the dispatch prompt, which
 *           Trellis's own dispatch protocol already requires. pi-subagents wraps
 *           the prompt, so the line arrives as `Task: Active task: <path>`;
 *           then the task path appearing in the session name; then the parent
 *           session's Trellis pointer, resolved in the main checkout — but only
 *           when the child named no task at all. A task reference that *is*
 *           present and does not resolve is reported as invalid instead of being
 *           replaced by the parent's task, which is how a generic child used to
 *           end up implementing whatever the parent had open. A reference must
 *           have a reference's shape to count: the documented protocol line is
 *           written with a placeholder (`Active task: <任务目录>`), and reading a
 *           placeholder as a real reference used to cancel that fallback.
 *
 * Everything is read from the main checkout, not the child's cwd: a lane
 * worktree only carries whatever was committed, while the task artifacts the
 * parent is still editing live in the main checkout. That is also why the block
 * prints the task's absolute directory next to the protocol's relative reference:
 * a child whose cwd is a worktree cannot open the relative one.
 *
 * ## How the prompt is built
 *
 * `before_agent_start` fires for every run of the session, and Pi re-renders the
 * system prompt from `event.systemPromptOptions` after each handler. So this
 * module edits the *structured* options and lets Pi render and diff them:
 *
 *   - the managed parent-duty region is stripped out of every inherited context
 *     file, leaving the rest of what the project wrote intact (a child still
 *     needs the build commands and the code conventions; it does not need the
 *     parent's planning and merge duties);
 *   - the child block lives in one named section, so a second run replaces it
 *     instead of appending a second copy.
 *
 * Both steps are pure functions of the host's current state, which is what makes
 * repeated runs — and agents this package does not own — idempotent. A host that
 * does not expose `systemPromptOptions` gets the same treatment applied to the
 * rendered prompt string and returned as `systemPrompt`.
 *
 * The guide is appended for **every** child, role or not: an unknown role means
 * "generic child", never "no instructions".
 */

import { moduleAsset, type PiRuntimeHost, type RuntimeContext, type WorkflowModule } from "../../core/module.ts";
import {
  activeTaskDir,
  buildRoleContext,
  readSubagentGuide,
  resolveChildTask,
  type TaskResolution,
  stripManagedRegion,
  stripManagedRegionFromPrompt,
  stripOwnInjection,
  taskRefForDisplay,
  type SubagentRole,
} from "../../core/trellis.ts";
import { resolveKinds } from "../agent-kinds/defaults.ts";
import { readKindDefinitions } from "../agent-kinds/definitions.ts";
import { readConfig } from "../../core/config.ts";
import type { ResolvedAgentKind } from "../../core/config.ts";

const ROLES: SubagentRole[] = ["implement", "check", "research"];
const MARKER_RE = /<!--\s*trellis-agent:\s*(implement|check|research)\s*-->/;
/** The section name Pi renders (and diffs) for this module's contribution. */
export const SECTION = "pi_coworkflow_child";

/**
 * Guidance a child gets even when the project never wrote its own.
 *
 * The project guide is the richer text; this is the floor, so an unknown agent in
 * an adopted project is never left without the boundary that says it does one
 * delegated piece of work and reports it.
 */
const GENERIC_GUIDE = moduleAsset(import.meta.url, "../agents/assets/subagent-AGENTS.md") ?? "";

/** A known role name, or `null`. The only caller is the dispatch-prompt marker. */
function asRole(value: string | undefined): SubagentRole | null {
  if (!value) return null;
  return (ROLES as string[]).includes(value) ? (value as SubagentRole) : null;
}

/**
 * The kind a registered agent name belongs to, if any.
 *
 * The name only says *which kind* this is; the role itself is that kind's declaration —
 * the project's definition file when it has one, else the shipped asset — which is why
 * this resolves against the table the caller passed (the live one) instead of a fixed
 * list of names: a definition may rename the agent (`agent: cw-builder`), and a static
 * alternation over the shipped kinds then finds nothing and the child silently loses
 * its context.
 *
 * Two spellings carry the name: the agent segment of the dispatch session name
 * (`cw-executor: <task>`), and the wrapped one the managed region documents
 * (`subagent-cw-executor-<runId>-<i>`). The second is matched as a whole segment,
 * longest agent name first, so `cw-builder-team` cannot be shadowed by `cw-builder`.
 */
function kindOf(agent: string, kinds: readonly ResolvedAgentKind[]): ResolvedAgentKind | undefined {
  const exact = kinds.find((candidate) => candidate.agent === agent);
  if (exact !== undefined) return exact;
  if (!agent) return undefined;
  const names = [...kinds].sort((left, right) => right.agent.length - left.agent.length);
  return names.find((candidate) => candidate.agent !== "" && agent.startsWith(`subagent-${candidate.agent}-`));
}

/**
 * The role this child was dispatched as, or null when it is not a Trellis role.
 *
 * Two sources, both declarations: the kind the child's agent name belongs to (its
 * definition's `role:`), then the marker a prompt or agent definition may carry.
 * `kinds` is the project's resolved kind table when the caller has read it; without
 * it the shipped definitions are the only evidence, because a project definition is
 * exactly what the caller must pass to be seen.
 *
 * A kind that declares `role: none` has answered: its children are generic children,
 * and a marker in an inherited prompt must not hand them someone else's context.
 */
export function detectRole(
  sessionName: string | undefined,
  kinds?: readonly ResolvedAgentKind[],
  ...texts: (string | undefined)[]
): SubagentRole | null {
  const agent = sessionName?.split(":")[0]?.trim() ?? "";
  const kind = kindOf(agent, kinds ?? resolveKinds(null));
  if (kind !== undefined) return kind.role ?? null;

  for (const text of texts) {
    const marker = text ? MARKER_RE.exec(text)?.[1] : undefined;
    const role = asRole(marker);
    if (role) return role;
  }
  return null;
}

export { taskReference, resolveChildTask } from "../../core/trellis.ts";
/** The block this module contributes, for one run of one child. */
interface ChildPrompt {
  /** Shared safety floor plus any distinct project supplement. */
  guide: string;
  role: SubagentRole | null;
  task: TaskResolution;
  /** The task as the child should see it, for the prompt. */
  displayRef: string;
  context: string;
}

/**
 * The task as the child should see it.
 *
 * The protocol's relative reference stays first, exactly as written in `AGENTS.md`; the
 * absolute directory follows it because the child's cwd may be a lane worktree, where a
 * path relative to the main checkout points at a directory that does not exist. Files the
 * child writes there would also land in the worktree instead of the parent-owned task.
 */
function activeTaskLines(ref: string, dir: string): string[] {
  return [
    `Active task: ${ref}`,
    `任务目录（绝对路径：\`${dir}\`；cwd 在 worktree 时也用它读 prd/design/implement）`,
  ];
}

function blockFor(prompt: ChildPrompt): string {
  const { role, task, displayRef } = prompt;
  const lines = [`<!-- pi-Coworkflow:subagent-context -->`];

  if (task.kind === "invalid") {
    // Said plainly, and the model is told not to guess: an unresolved reference
    // is the parent's mistake to fix, not an invitation to pick a task.
    lines.push(
      `> 派单提示词里的任务引用 \`${task.ref}\` 在本项目的 .trellis/tasks 下不存在。`,
      "> 不要猜测或改用其它任务；停止执行并报告这个无效引用。工具调用已阻止。",
      "",
    );
  }

  if (role) {
    lines.push(
      `## Trellis 子任务上下文（role: ${role}）`,
      "",
      ...(task.kind === "task" ? activeTaskLines(displayRef, task.dir) : ["Active task: (none)"]),
      "",
      prompt.context,
      "",
    );
  } else if (task.kind === "task") {
    // No role marker, but the parent named a task: tell the child, without
    // pretending it has an implement/check context it never asked for.
    lines.push(`## Trellis 任务`, "", ...activeTaskLines(displayRef, task.dir), "");
  }

  // The guide goes in for every child — a generic agent included — and after the
  // role context so the task-specific material comes first.
  lines.push("## 子 agent 工作约定（本项目）", "", prompt.guide, "");

  lines.push("<!-- pi-Coworkflow:subagent-context:end -->");
  return lines.join("\n");
}

/**
 * The host's prompt with this package's own contributions removed.
 *
 * Detection runs on this, not on the raw prompt. Our block spells a role (`role: check`)
 * and the dispatch line (`Active task: <任务目录>`), so a second run reading its own output
 * would find a role and a task that the parent never wrote — a generic child would turn
 * into an implement child on its second turn.
 */
function inheritedPrompt(event: any): string {
  const raw = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
  return stripOwnInjection(stripManagedRegionFromPrompt(raw));
}

/** Everything this module needs to know about one run, read fresh each time. */
function readChildPrompt(
  root: string,
  sessionName: string | undefined,
  event: any,
  runtime: RuntimeContext,
  host: PiRuntimeHost,
  ctx: any,
): ChildPrompt {
  const inherited = inheritedPrompt(event);
  // The project's table, so a custom or renamed kind resolves to the role it declared.
  const kinds = resolveKinds(readConfig(root), readKindDefinitions(root).definitions);
  const kind = kindOf(sessionName?.split(":")[0]?.trim() ?? "", kinds);
  const role = detectRole(sessionName, kinds, event?.prompt, inherited);
  const key = `${runtime.sessionId}:${runtime.sessionEpoch}`;
  let binding = BINDINGS.get(host);
  if (binding?.key !== key) binding = undefined;
  const branch = ctx?.sessionManager?.getBranch?.();
  if (Array.isArray(branch)) {
    const saved = branch.filter((entry: any) => entry.type === "custom" && entry.customType === TASK_BINDING).at(-1)?.data;
    binding = saved?.root === root && typeof saved.ref === "string" ? { key, ref: saved.ref } : undefined;
  }
  let task = binding
    ? resolveChildTask(root, undefined, `Active task: ${binding.ref}`)
    : resolveChildTask(root, sessionName, event?.prompt, inherited);

  if (task.kind === "none" && !task.explicit && role && (role !== "research" || kind?.context === "task")) {
    // The child named no task: the parent's pointer is the only remaining
    // evidence, and a Trellis role without one has nothing to work from.
    const parentTask = activeTaskDir(root, runtime.parentSessionId);
    if (parentTask) {
      task = { kind: "task", dir: parentTask, ref: taskRefForDisplay(root, parentTask) };
    }
  }

  if (!binding) {
    const ref = task.kind === "task" ? task.dir : task.kind === "invalid" ? task.ref : "(none)";
    binding = { key, ref };
    host.appendEntry?.(TASK_BINDING, { root, ref });
  }
  BINDINGS.set(host, binding);
  // A follow-up cannot move this process to another task/worktree. Start a new
  // child for that; in particular a borrowed parent pointer cannot change it.
  const requested = resolveChildTask(root, undefined, event?.prompt);
  if (!(requested.kind === "none" && !requested.explicit) &&
      (requested.kind === "task" ? requested.dir : requested.kind === "invalid" ? requested.ref : "(none)") !== binding.ref) {
    task = { kind: "invalid", ref: "任务绑定与本次指令不一致；请新建子会话" };
  }
  INVALID.set(host, task.kind === "invalid" ? task.ref : null);
  const displayRef =
    task.kind === "task"
      ? taskRefForDisplay(root, task.dir)
      : task.kind === "invalid"
        ? task.ref
        : "";
  const context =
    role === null ? "" : buildRoleContext(root, task.kind === "task" ? task.dir : null, role, kind?.context);

  const supplement = readSubagentGuide(root)?.trim();
  const guide = supplement && supplement !== GENERIC_GUIDE.trim()
    ? `${GENERIC_GUIDE.trim()}\n\n${supplement}` : GENERIC_GUIDE;
  return {
    guide,
    role,
    task,
    displayRef,
    context,
  };
}

/**
 * Strip this package's parent-duty region out of the host's context files.
 *
 * `contextFiles` is the structured form of what Pi renders as
 * `<project_instructions>`; editing it here keeps Pi's own rendering and diffing
 * in charge, and limits the change to the region this package wrote.
 */
function stripInherited(options: any): void {
  const files = options?.contextFiles;
  if (!Array.isArray(files) || files.length === 0) return;
  const kept: unknown[] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") {
      kept.push(file);
      continue;
    }
    const record = file as { path?: unknown; content?: unknown };
    if (typeof record.content !== "string") {
      kept.push(file);
      continue;
    }
    const next = stripManagedRegion(record.content);
    // A file that held nothing but the region carries no instruction any more.
    if (!next) continue;
    kept.push(next === record.content ? file : { ...record, content: next });
  }
  options.contextFiles = kept;
}

function buildPrompt(
  runtime: RuntimeContext,
  host: PiRuntimeHost,
  event: any,
  ctx: any,
): { systemPrompt?: string } | undefined {
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd;
  // Read from the main checkout: a lane worktree only holds committed state. The
  // runtime's resolver answers this from cache, so a per-run `before_agent_start`
  // does not spawn `git`, and an answer git could not establish is `null` rather
  // than "whichever directory this run started in".
  const root = runtime.configRoots.root(cwd);
  if (root === null) return undefined;
  // Read at call time: a child is renamed after dispatch, so a name captured at
  // load would be stale by the first run.
  const sessionName = host.getSessionName?.();
  const prompt = readChildPrompt(root, sessionName, event, runtime, host, ctx);
  const block = blockFor(prompt);

  const options = event?.systemPromptOptions;
  if (options !== null && typeof options === "object") {
    // Structured path: Pi re-renders from these options after every handler, and
    // the section is replaced, so a repeat run cannot accumulate copies.
    stripInherited(options);
    const sections = options.sections;
    if (sections !== null && typeof sections === "object") {
      sections[SECTION] = block;
    } else {
      options.sections = { [SECTION]: block };
    }
    // Guard against a host that ignores custom sections but still honours a
    // forced prompt: options and the returned prompt must not disagree.
    return undefined;
  }

  const current = inheritedPrompt(event);
  return { systemPrompt: [current, block].filter(Boolean).join("\n\n") };
}

/**
 * One subscription per host, reused across the sessions that host serves.
 *
 * Keyed by host rather than kept in a single variable: a host that is still alive
 * keeps its own registration, and cleanup can only ever drop the one that belongs
 * to the session ending. The record carries the runtime the handler reads, so a
 * handler that cannot be unsubscribed still answers for the *current* session
 * instead of the one it was attached in.
 */
interface HostInjection {
  /** Refreshed by `activate` on every session: the handler reads it per run. */
  runtime: RuntimeContext;
  /** The host's own unsubscribe, when it returned one. */
  off: (() => void) | null;
}

const REGISTRATIONS = new WeakMap<PiRuntimeHost, HostInjection>();
const TASK_BINDING = "coworkflow-task-binding";
const BINDINGS = new WeakMap<PiRuntimeHost, { key: string; ref: string }>();
const INVALID = new WeakMap<PiRuntimeHost, string | null>();

export const subagentContextModule: WorkflowModule = {
  id: "subagent-context",
  title: "子会话的 Trellis 上下文注入（按角色子集）",

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (!runtime.isChild || !host.on) return;
    const existing = REGISTRATIONS.get(host);
    if (existing !== undefined) {
      // The listener is already attached — either it could not be removed, or the
      // orchestrator re-activated the module in the same session. Point it at the
      // runtime that is live now and add nothing, so a repeated start cannot
      // inject the same block twice.
      existing.runtime = runtime;
      return;
    }
    const entry: HostInjection = { runtime, off: null };
    REGISTRATIONS.set(host, entry);
    const stopInvalid = host.on("tool_call", () => {
      if (!entry.runtime.enabled || !entry.runtime.control.moduleEnabled("subagent-context")) return;
      const invalid = INVALID.get(host);
      if (invalid) return { block: true, reason: `无效任务绑定：${invalid}。请主会话修正派单。` };
    });
    const unsubscribe = host.on("before_agent_start", (event: any, ctx: any) => {
      // Both gates are read at event time, not captured: a session that runs
      // `/Coworkflow:start off` stops injecting, a project that switches the
      // module off stops injecting, and turning either back on needs no reload.
      const live = entry.runtime;
      if (!live.enabled) return undefined;
      if (!live.control.moduleEnabled("subagent-context")) return undefined;
      try {
        return buildPrompt(live, host, event, ctx);
      } catch {
        // An injector failure must not break the run it was decorating.
        return undefined;
      }
    });
    // `pi.on` documents an unsubscribe, and the host in front of us may still
    // return nothing. When it does, the subscription is permanent by necessity:
    // the record stays and the handler above stays inert while the gates are off.
    entry.off = typeof unsubscribe === "function" && typeof stopInvalid === "function"
      ? () => { unsubscribe(); stopInvalid(); } : null;
  },

  /**
   * Drop the subscription at the end of the session that owns it.
   *
   * A listener left behind would keep injecting one child's Trellis context into
   * whatever runs in this runtime next — the case is a `/reload` or a session
   * replacement, both of which fire `session_shutdown`.
   *
   * A host that gave no unsubscribe keeps its entry on purpose: deleting it would
   * make the next session attach a second permanent handler, and every run would
   * then be built twice. The handler reads the gates of the runtime `activate`
   * last handed it, so an unremovable subscription is inert, not stale.
   */
  onSessionEnd(host: PiRuntimeHost): void {
    BINDINGS.delete(host);
    INVALID.delete(host);
    const entry = REGISTRATIONS.get(host);
    if (entry === undefined) return;
    if (entry.off === null) return;
    REGISTRATIONS.delete(host);
    const off = entry.off;
    entry.off = null;
    try {
      off();
    } catch {
      // A listener the host already dropped is not a failure to report.
    }
  },
};
