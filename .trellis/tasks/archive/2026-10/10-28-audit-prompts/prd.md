# Audit main and subagent prompts

## Goal

Review the main system prompt, child kind prompts, and `AGENTS.md` for contradictions, unnecessary overhead, unsafe delegation, and model-purpose fit. Produce prioritized findings and a minimal correction plan without changing production code.

## Requirements

- Compare the main-session policy with the plain and inline Trellis workflow breadcrumbs.
- Compare the `executor`, `planner`, `auditor`, `researcher`, and `worker` prompts with the generic child guide and role-context injection.
- Check whether each kind receives the context required by its stated purpose.
- Separate blocking contradictions from token-cost and maintainability recommendations.
- Persist evidence and file/line references in `research/prompt-audit.md`.

## Acceptance Criteria

- [x] Findings are prioritized as P1/P2 and include concrete evidence.
- [x] The audit covers the generated workflow, source template, `AGENTS.md` assets, kind prompts, role-context builder, and project model configuration.
- [x] The report distinguishes current strengths from required corrections.
- [x] No production code or prompt asset is changed during the audit.
