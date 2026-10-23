# Execution plan

## Stage A — runtime contract owner
Files: modules/agents/index.ts and its two assets; modules/subagent-context/index.ts; core/trellis.ts; core/module.ts; extensions/coworkflow.ts; focused scripts/runtime-contract.test.ts. Remove counting/nudges, fix child prompt lifecycle and targeted stripping, implement consistent module/session gating with cleanup hooks. Preserve setup behavior and UI key semantics. Read existing test fixtures; keep old tests compatible or update only directly obsolete nudge assertions. Run focused tests/typecheck. Record A-handoff.md with public interface changes.

## Stage B — public bridge/workflow owner (after A)
Files: new core/subagents-client.ts and core/subagents-workflow.ts (or equally small named equivalents), modules/subagents/index.ts, core/module.ts, package.json if required, scripts/upstream-bridge.test.ts, minimal extensions/coworkflow.ts wiring. Implement public RPC lifecycle/capabilities; register namespaced workflow + child extension requirement; /Coworkflow:run resolves real task/worktree and uses native mission/workflow/acceptance. No duplicate runtime or automatic retry. Test request cleanup, session isolation, unavailable support, resource argument validation, negative review and no-spawn validation failures. Record B-handoff.md with consumer API.

## Stage C — consumer migration owner (after B)
Files: core/capacity.ts, core/ledger.ts, core/pi-subagents.ts, core/usage.ts, modules/capacity/index.ts, modules/lane-worktree/index.ts, extensions/coworkflow.ts, modules/panel/models.ts/shared.ts/settings.ts only data adapters, scripts/test.ts and verify.ts, README.md. Replace private run scans and unused ledger with native observations; preserve project concurrency at direct + Coworkflow RPC launch boundaries; task-to-mission linkage and per-child lanes; consume native cost while preserving chart and uncertainty. Delete dead replaced code, not required behavior. Update npm test to execute focused suites and original regression. Record C-handoff.md.

## Stage D — independent check (after C)
Read-only trellis-check; inspect only task delta/affected files and named upstream public docs, not recursive node_modules/events dumps. Validate real production handlers and repeat prompt/new-session lifecycle, bridge protocol, workflow error behavior, capacity release and UI regressions. Execute npm run typecheck and npm test once; minimal verify fixtures in temp roots, never init/disable against real main. Report blockers with file/line, reproduction and evidence. Do not claim acceptance from mocked manual bindings. A bounded native public-interface smoke must not launch implementation against main.

## Parent integration/finish
Audit reports against PRD, resolve any blockers with bounded follow-up, write focused .trellis/spec integration contract, preserve existing source baseline, commit coherent code batches on task branch. Integrate only after drift/cleanliness checks and serialize integration. Archive after safe merge, remove clean merged worktree and branch; otherwise report retained reason explicitly. No remote push.

## Checks and stop conditions
- Existing npm run typecheck; npm test (expanded focused fixtures).
- Stop on dependency/runtime launch failure, unsupported public API with no safe implementation, main drift, or scope expansion; contact parent. Never silently fall back to CLI launches.
- Child must produce changed-file list, checks with outcomes, residual risks, and exact handoff path. Tools/files in legacy baseline are not this stage's work.
- No agent may modify main or upstream packages, recursively read unrelated node_modules, or run real-project init/disable as a test.
