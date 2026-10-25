# Trellis dispatch integration review and repair

## Goal

Review the actual chain from bundled Trellis task context through dynamic kind resolution, child context injection, admission, queued dispatch and parent acceptance. Repair demonstrated defects without another runner or unrelated refactors.

## Requirements

- Use the extension's bundled Trellis as the source of workflow guidance; preserve task records, worktree isolation and dynamic kind definitions.
- Resolve task context consistently for direct children and RPC/queued children, including linked worktrees. Never silently inject an unrelated current task.
- Validate dispatch integration against the installed upstream public API: tool registration, async spawn receipt, completion payload, failure states and session lifetime.
- Queue only while admission capacity is exhausted; release dependencies only on confirmed success; stopping/disabling/changing sessions must not trigger new launches from stale work.
- Surface concrete remaining limitations honestly. Keep parent approval of results separate from child process completion.
- Scope fixes to evidence-backed behavior gaps. Do not alter global settings or upstream installations.

## Acceptance

- [x] Review findings identify reachable triggers, exact code/API evidence and minimal fixes.
- [x] Accepted fixes have affected-path regressions, including production wiring rather than only fake queue logic.
- [x] A real Pi session verifies background dispatch and required task context; see verification.md for the local provider boundary.
- [x] Typecheck and all 335 tests pass; parent reviewed the integrated diff.
- [x] Task artifacts/spec reflect final contracts; all three branches are integrated into main and clean worktrees removed.

## Execution boundary

Initial reviewers are read-only and parallel: one owns Trellis/kind/context resolution, one owns dispatch/owner-RPC/completion lifecycle. Parent owns host registration, synthesis, contracts, integration and acceptance. Implementation owners will be assigned after confirmed findings.
