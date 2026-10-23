# C2 usage/native-cost handoff

Status: **completed for the assigned Stage C2 boundary**. C1 closure remains authoritative at `finish-report.lane-target.md`; final independent review and parent acceptance/integration are still outstanding.

## Changes

- `core/usage.ts`: removed private run-artifact enumeration and its metadata/date fallback. Added host/session/epoch-bound public-cost observation, boundary-only refresh, cached parent Pi entries, and bounded child JSONL reads only through exact absolute native `sessionFile` pointers. Daily model attribution requires valid provider/model/time/token fields; malformed or missing data is visibly incomplete, never guessed from mtime. Native aggregate totals remain separately labeled because they have no model/day attribution.
- `core/capacity.ts`: removed the last `asyncRunsRoot()` and private temp-scope path helper; retained `startsAsyncRun()`.
- `extensions/coworkflow.ts`: refreshes on session start, `agent_settled`, structured native completion and live settings facts; invalidates on lifecycle/gate changes. Passive refresh sends no user message.
- `modules/panel/{models.ts,shared.ts,settings.ts}`: panel facts/chart use cached native cost/history. Render and keys do no RPC or filesystem work. Existing three-column layout, all thinking levels, Tab session/child switching, and Left/Right column switching remain unchanged.
- `scripts/usage.test.ts`: six production-adapter/real-handler suites cover public cost/history, incomplete and unknown values, bounded/malformed pointers, epoch/disposal, module gates, panel keys/data and extension lifecycle.
- `scripts/verify.ts`, `package.json`: switched verify fixture to public-cost/history semantics and added the focused usage suite to `npm test`.
- `README.md`, `.trellis/spec/frontend/subagents-integration.md`: documented public ownership, verified task/worktree implement→review workflow, missing/incomplete cost, capacity scope and other-extension RPC limitation, explicit parent acceptance, and no automatic retry.

## Verification

- `npm run typecheck` — passed (`tsc --noEmit`).
- `node --experimental-strip-types --test scripts/usage.test.ts` — 6 passed, 0 failed.
- `npm test` — **80 passed, 0 failed, 0 skipped; exit 0** after the final source changes. Final raw output is `/tmp/coworkflow-c2-final-test.log`; typecheck output is `/tmp/coworkflow-c2-final-typecheck.log`. Earlier command-output compression misleadingly summarized some identical runs as “80 passed, 2 failed”; subprocess capture of the actual command exit and raw Node test summary confirms success. No repository/test change was made to hide that output discrepancy.
- `git diff --check` and check for staged files — passed; no staged files.
- Bounded source scan confirms no `asyncRunsRoot`, `PI_SUBAGENTS_TEMP_ROOT`, `*_meta.json`, or `subagent-artifacts` consumer remains in production modules/core.
- No live coding smoke, real-project init/disable, upstream edit, commit or push was performed.

## Files changed in C2

`README.md`, `core/capacity.ts`, `core/usage.ts`, `extensions/coworkflow.ts`, `modules/panel/models.ts`, `modules/panel/settings.ts`, `modules/panel/shared.ts`, `package.json`, `scripts/usage.test.ts`, `scripts/verify.ts`, `.trellis/spec/frontend/subagents-integration.md`.

## Isolation

All source edits were made in `/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge`; the integration spec and this handoff use the authorized shared Trellis artifacts. A/B1/B2/C1 code and the verified lane-target closure were preserved. No main-checkout source, installed upstream package, global setting, task state, branch/history, or unrelated WIP was modified. C2's incoming versions of the touched source/docs were saved at `/var/folders/8c/t8htn7h14t777qd1hclgyj940000gn/T/coworkflow-c2-baseline-7jl82629`.

## Residual limits

Child model/day detail is available only for public native cost rows with readable absolute `sessionFile` pointers. Unavailable/malformed pointers, unsupported cost, unresolved async children or read-budget exhaustion show a lower bound/unknown state. Native cost cannot supply cross-session project totals or assign aggregates to models/days, so neither is synthesized. Panel data stays unchanged while open; the next defined refresh boundary or panel open obtains newer data. Parent final acceptance is not performed here.
