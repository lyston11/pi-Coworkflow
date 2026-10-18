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
 *   role  — the child's session name. pi-subagents names a child
 *           `subagent-<agent>-<runId>-<index>` when the intercom bridge claims
 *           it, and `<agent>: <task excerpt>` otherwise (see
 *           `src/shared/child-session-name.ts` and `subagent-prompt-runtime.ts`,
 *           which prefers the routing name). Both contain the agent name, so
 *           `trellis-implement` identifies the role without asking the model to
 *           write a marker. A `<!-- trellis-agent: <role> -->` marker in the
 *           agent definition or dispatch prompt is accepted as a fallback.
 *   task  — the `Active task: <path>` line of the dispatch prompt, which
 *           Trellis's own dispatch protocol already requires. pi-subagents wraps
 *           the prompt, so the line arrives as `Task: Active task: <path>`;
 *           then the task path appearing in the session name; then the parent
 *           session's Trellis pointer, resolved in the main checkout.
 *
 * Everything is read from the main checkout, not the child's cwd: a lane
 * worktree only carries whatever was committed, while the task artifacts the
 * parent is still editing live in the main checkout.
 *
 * Injection happens once per (role, task) pair and only in a child session.
 * The main session is left untouched — its own Trellis extension already owns
 * that, and this module must not double up on it.
 */

import type { PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import {
  activeTaskDir,
  buildRoleContext,
  mainCheckout,
  readSubagentGuide,
  renderInjection,
  stripProjectInstructions,
  repoRoot,
  resolveTaskDir,
  taskRefForDisplay,
  type SubagentRole,
} from "../../core/trellis.ts";

const ROLES: SubagentRole[] = ["implement", "check", "research"];
/**
 * Match `trellis-<role>` anywhere in the name, including inside
 * `subagent-trellis-check-<runId>-1`, where `-` precedes it.
 */
const AGENT_RE = /(?:^|[^A-Za-z0-9])trellis-(implement|check|research)(?![A-Za-z0-9])/;
const MARKER_RE = /<!--\s*trellis-agent:\s*(implement|check|research)\s*-->/;
/**
 * The task path after `Active task:`, anywhere in the text. It must not be
 * anchored to the line start: pi-subagents wraps the dispatch prompt, so the
 * line arrives as `Task: Active task: .trellis/tasks/<name>`.
 */
const ACTIVE_TASK_RE = /Active task:\s*([^\s`'"\n]+)/;
const TASK_PATH_RE = /\.trellis\/tasks\/[A-Za-z0-9._-]+/;

function asRole(value: string | undefined): SubagentRole | null {
  if (!value) return null;
  return (ROLES as string[]).includes(value) ? (value as SubagentRole) : null;
}

/** The role this child was dispatched as, or null when it is not a Trellis role. */
export function detectRole(
  sessionName: string | undefined,
  ...texts: (string | undefined)[]
): SubagentRole | null {
  const agent = sessionName?.split(":")[0]?.trim();
  const fromAgent = asRole(agent) ?? asRole(AGENT_RE.exec(agent ?? "")?.[1]);
  if (fromAgent) return fromAgent;

  for (const text of texts) {
    const marker = text ? MARKER_RE.exec(text)?.[1] : undefined;
    const role = asRole(marker);
    if (role) return role;
  }
  return null;
}

/** The task directory this child should work on, resolved against `root`. */
export function detectTaskDir(
  root: string,
  sessionName: string | undefined,
  ...texts: (string | undefined)[]
): string | null {
  for (const text of texts) {
    const ref = text ? ACTIVE_TASK_RE.exec(text)?.[1] : undefined;
    if (!ref) continue;
    const resolved = resolveTaskDir(root, ref.replace(/[`'"]/g, ""));
    if (resolved) return resolved;
  }
  const fromName = TASK_PATH_RE.exec(sessionName ?? "")?.[0];
  if (fromName) {
    const resolved = resolveTaskDir(root, fromName);
    if (resolved) return resolved;
  }
  return null;
}

export const subagentContextModule: WorkflowModule = {
  id: "subagent-context",
  title: "子会话的 Trellis 上下文注入（按角色子集）",

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (!runtime.isChild || !host.on) return;

    const injected = new Set<string>();

    host.on("before_agent_start", (event: any, ctx: any) => {
      if (!runtime.enabled) return undefined;

      const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : runtime.cwd;
      // Read from the main checkout: a lane worktree only holds committed state.
      const root = mainCheckout(repoRoot(cwd));
      const sessionName = host.getSessionName?.();
      const role = detectRole(sessionName, event?.prompt, event?.systemPrompt);
      const guide = readSubagentGuide(root);

      // Separation is enforced for *every* child of an adopted project, not only
      // for the three Trellis roles: a custom agent that inherits the project
      // AGENTS.md would otherwise plan and audit duties it does not have. The
      // rule lives here rather than in agent frontmatter so it keeps holding for
      // agents this package does not own, and applies to nothing outside a
      // project that ran `/Coworkflow:init`.
      const current = stripProjectInstructions(
        typeof event?.systemPrompt === "string" ? event.systemPrompt : "",
      );

      if (!role) {
        // Not a Trellis role: only the separation rule applies. Replacing the
        // prompt is required because a hook cannot mutate it in place.
        return current === (event?.systemPrompt ?? "") ? undefined : { systemPrompt: current };
      }

      const taskDir =
        detectTaskDir(root, sessionName, event?.prompt, event?.systemPrompt) ??
        activeTaskDir(root, runtime.parentSessionId);
      if (role !== "research" && !taskDir) {
        return current === (event?.systemPrompt ?? "") ? undefined : { systemPrompt: current };
      }

      const taskRef = taskDir ? taskRefForDisplay(root, taskDir) : "";
      const key = `${role}::${taskRef}`;
      if (injected.has(key)) {
        return current === (event?.systemPrompt ?? "") ? undefined : { systemPrompt: current };
      }

      const context = buildRoleContext(root, taskDir, role);
      if (!context && !guide) {
        return current === (event?.systemPrompt ?? "") ? undefined : { systemPrompt: current };
      }
      injected.add(key);

      const block = renderInjection(role, taskRef, context, guide);
      return { systemPrompt: [current, block].filter(Boolean).join("\n\n") };
    });
  },
};
