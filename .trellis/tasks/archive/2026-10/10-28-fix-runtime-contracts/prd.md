# Fix runtime contracts

## Scope
Implement all seven findings from ../archive/2026-10/10-28-audit-runtime-contracts/review.md. Keep the five configurable kinds and model settings, optional delegation, and parent acceptance. No scheduler, upstream package changes, or directory symlink replacement.

## Acceptance
- Project AGENTS custom rules reach children while Coworkflow parent duties are removed.
- Each launch binds task identity and validates its working directory; a later task switch cannot redirect queued work or use stale placement.
- Child task / explicit none binding survives follow-ups and session restore. Invalid task references stop task-related execution.
- Existing worktrees on another branch are never adopted by task start.
- Session shutdown preserves worktrees when child occupancy cannot be proven clear.
- Only real task records within project tasks are valid references.
- Equivalent declared file paths overlap, escaping paths are refused, and mixed undeclared/declared writers are warned.
- Focused regressions, type-check and a real local Pi injection probe pass; no remote model routing retest.

## Specs
.trellis/spec/frontend/subagents-integration.md; .trellis/spec/frontend/agent-kinds.md.
