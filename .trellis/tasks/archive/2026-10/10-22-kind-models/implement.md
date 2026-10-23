# Implement — per-kind models

Two stages, in order, in one worktree. Stage 2 edits the panel and needs stage 1's config field,
so it starts only after stage 1 hands off. A read-only check closes the task.

## Stage 1 — config, resolution, registration

Files: `core/config.ts`, `modules/agent-kinds/defaults.ts`, `modules/agent-kinds/registration.ts`,
`modules/agent-kinds/index.ts`, `core/module.ts` (`setAgentKind` patch type),
`extensions/coworkflow.ts` (the `setAgentKind` implementation only), plus a focused test file.

1. `AgentKindConfig` gains `model?: string`, `thinking?: string`; `parseAgentKinds` validates both
   (see design: drop, never forward a malformed value).
2. `ResolvedAgentKind` carries them; `resolveKinds` passes them through unchanged.
3. `KindDefinition`/`DesiredKind` carry them and `signature()` includes them, so a model change
   re-registers instead of being read as unchanged.
4. `modules/agent-kinds/index.ts` builds the definition with them.
5. `setAgentKind` accepts `model?: string | null` and `thinking?: string | null`; `null` deletes the
   key (back to inherit). Validation lives here so the panel gets a status line, not a throw.
6. `/Coworkflow:status` reports each kind's model or that it inherits.

Tests: a stored malformed model/thinking is dropped; a valid one resolves; changing a model changes
the definition signature (so reconcile re-registers); clearing returns to inherit; the status line
says which.

## Stage 2 — panel pages

Files: `modules/panel/shared.ts`, `modules/panel/models.ts`, `modules/panel/models-panel.ts`,
`modules/panel/index.ts` if needed, plus tests.

1. `Tab` becomes `"session" | "subagent" | \`kind:${string}\``; page names come from
   `control.agentKinds()` — 主会话, 子 agent（默认）, then one per kind labelled `<label> <agent>`.
2. `modelRows`/`thinkingRows` take the resolved tab and the kind entry; a kind page shows the
   kind's model, its thinking levels (from the kind's model when pinned, else the session model),
   and a row that says 继承 vs 固定.
3. Applying on a kind page calls `control.setAgentKind(kind, { model, thinking })`; clearing calls
   it with `null`. The default page keeps writing `subagents.defaultModel/Provider/Thinking`.
4. Tab key cycles all pages; the model/thinking columns behave exactly as they do today on the
   session page (the existing key behaviour must not regress).

Tests: the page list follows configured kinds (three kinds → five pages; removing one → four; a
disabled kind keeps its page); applying a kind model writes the config and re-registers that agent
with that model; clearing returns to inherit; thinking levels on a kind page follow the kind's own
model.

## Stage 3 — read-only check

Drive production code: the tab list, a kind model apply through the real control surface, the
registration signature change, the status line, and the precedence (kind → default → Pi). Report
blockers with file:line, or no blockers plus limitations. Do not fix.

## Boundaries

No change to pi-subagents, to the settings panel (`/Coworkflow:settings`), to the kind gate, or to
the Trellis assets. `npm run typecheck` and `npm test` must be green at each handoff.
