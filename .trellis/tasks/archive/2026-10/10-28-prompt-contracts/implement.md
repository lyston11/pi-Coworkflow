# Implementation

1. Update definition metadata and context/task resolution. Preserve public validation, role overrides, custom names and injection limits.
2. Unify workflow branches, read-only check prompt, shared child guide and concise purpose prompts; render from source.
3. Extend existing tests for real extracted instructions, planning/taskless contexts, metadata authoring and repeated injection. Update affected specs.
4. Run the affected tests and TypeScript check once, address failures, inspect diff, commit and integrate serially; archive and remove this task worktree/branch.

## Verification evidence

- Six affected suites: `scripts/test.ts`, `trellis-template.test.ts`, `kind-port.test.ts`, `agent-kinds.test.ts`, `agent-kind-models.test.ts`, `cli.test.ts`: 104 passed. After final assertion/fixture changes, affected subagent-context (14) and template (13) cases reran successfully; counts overlap, not additional tests.
- `node node_modules/typescript/bin/tsc --noEmit` and `git diff --check`: passed after final edits.
- `node scripts/verify-dispatch.mjs`: four real background Pi children in isolated worktrees; three receive four task/spec sentinels, one explicit `(none)` receives none; local deterministic provider, zero model network requests. Failed temporary fixtures were corrected and removed after checking that their children had exited and worktrees had no code changes.
- Shared default child guide is injected once; custom supplements retain the safety floor. Role-none and custom/renamed kind behavior remains covered.
- Seven core prompt assets: roughly 33 KB → 12 KB (~64% reduction); this is text size, not a measured token-cost or model-quality claim.
- Workflow referenced task coordination/PR commands absent from the bundled CLI. Removed those instructions, retained manual coordination and existing queue controls, and added real CLI help assertions. No scheduler or lifecycle implementation was added.
- User model pins and local kind definitions remain unchanged. Production runtime changes need `/reload`; tests validate prompt delivery, not downstream model quality.
- Integration revealed duplicated AGENTS markers: removed markers from the asset (the renderer owns them), repaired the rendered file and passed 2 affected cases including repeated refresh. Commits `f9f3c53` and `4c4fb0e` are integrated into local main; final rendering left no tracked changes.
- Task archived; `wt-10-28-prompt-contracts` and `feat/10-28-prompt-contracts` removed without force. No push performed.
