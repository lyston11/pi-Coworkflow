# Design

Kinds are already the project's unit of per-purpose configuration: `agentKinds.<kind>` carries enabled/maxConcurrent/model/thinking, registration reads it, and the panel writes it. What is missing is a purpose-level vocabulary: the shipped table is one kind per Trellis role, so the only way to give cheap mechanical work a cheap model is to also give it a role-shaped prompt.

## Contract

- **Role** = which Trellis context a child receives (`implement` / `check` / `research`). Declared once, in the kind definition's frontmatter.
- **Kind** = one purpose with its own prompt, enablement, ceiling and model. Multiple kinds may map to the same role; role injection stays keyed on the role, so no second injection path is introduced.
- `planner` → `research` role, advisory boundary: options, evidence, tradeoffs, no code edits, no final decision.
- `worker` → `implement` role, bounded-work boundary: only an independently checkable unit, no scope widening, duration alone is not a justification.
- The shipped default for every kind stays "enabled, default ceiling"; model pins live only in the project config.

## Consequences

- `builtinAgentNames()` and the registered set grow from 3 to 5; tests that pin those exact arrays or counts are updated rather than loosened.
- The panel page list grows automatically because it is computed from `control.agentKinds()`; no panel code changes.
- `cw-executor` semantics are unchanged, so existing project configs and dispatches keep working.
- Docs must stop saying "one kind per role" and instead say roles are three while kinds are purposes that may share them.

## Boundary

No change to `core/subagents-client.ts`, the dispatch queue, admission, worktree placement, or model resolution precedence. Reverting the commit restores the three-kind table.
