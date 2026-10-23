# Stage A workflow report — runtime contract owner

Task: `.trellis/tasks/10-20-subagents-native-bridge`, Stage A only.
Worktree: `/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge` (branch `feat/10-20-subagents-native-bridge`, baseline `658708e`).
Canonical handoff: `.trellis/tasks/10-20-subagents-native-bridge/A-handoff.md`.

## Result

Stage A delivered: the division counter/nudge is deleted, child prompt injection is idempotent and
generic-safe, module gates and session lifecycle are consistent. No commit, no push, main untouched,
upstream packages untouched, no real-project init/disable run.

## Changed files (11)

| file | change |
|---|---|
| `modules/agents/index.ts` | `watchDivisionOfWork` + threshold constants + path scanning removed; module is install-only (no `activate`) |
| `modules/agents/assets/main-AGENTS.region.md` | threshold instruction and "the agents module counts this" claim removed; named-workflow and single-bounded-child guidance added; strip scope and non-role-agent behaviour corrected |
| `modules/agents/assets/subagent-AGENTS.md` | corrected: only the managed region is stripped; project content outside it still applies |
| `core/trellis.ts` | new sentinels + `stripManagedRegion` / `stripManagedRegionFromPrompt` / `stripOwnInjection`; deleted `stripProjectInstructions` and `renderInjection` |
| `modules/subagent-context/index.ts` | rewritten: structured-option injection into one replaceable section, idempotent string fallback, generic-child guide floor, tri-state task resolution (invalid never rebound), live two-switch gating, per-host unsubscribe on session end |
| `core/module.ts` | `onSessionEnd`, `Unsubscribe` return from `on`, `PiRuntimeHost.events`, `RuntimeContext.sessionEpoch`, `WorkflowControl.moduleEnabled` |
| `extensions/coworkflow.ts` | single registration path `ensureRuntime()` gated on module switch + adoption; `endSession()` on `session_shutdown`; `session_start` updates epoch/identity first; `setSwitch` applies in-session; report distinguishes "not initialized" vs "switched off" |
| `modules/capacity/index.ts` | gate reads `moduleEnabled("capacity")` at event time |
| `modules/lane-worktree/index.ts` | recording reads `moduleEnabled("lane-worktree")` at event time |
| `scripts/test.ts` | 3 obsolete nudge tests removed; 12 new contract/lifecycle tests added; one dynamic import made instance-unique |
| `README.md` | measurement section, module table, stripping table, unknown-agent row, multi-stage bullets, test coverage updated |

## Checks actually run

- `npx tsc --noEmit` → no errors (`npm run typecheck`).
- `npm test` → 21 tests / 21 pass / 0 fail.
- Manual smoke via `scripts/verify.ts` against **throwaway temp repos only**: `Coworkflow:init`,
  `Coworkflow:status`, `child-inject` (role with task, role without task, generic agent, invalid
  reference), `subagent-call` (reported `user-role messages: 0`), `lane-record`, `settings`, `panel`.
- Real-project read-only check: `child-inject` against this worktree resolved the real task and
  injected the role context; no write to any live project.

## Remaining risks

1. `capacity` / `lane-worktree` still count from pi-subagents' private run records — Stage C owns that
   migration; this stage only made their module gates live.
2. `scripts/verify.ts` inherits `PI_SUBAGENT_CHILD` / `PI_SESSION_ID` from the caller's shell; a
   child-shell invocation behaves as that child. Tests isolate themselves; manual runs need `env -u`.
3. `modules/panel/models.ts` usage aggregation untouched by design (Stage C).
4. `alwaysActive` panels still register in an uninitialized project so they can refuse with a reason —
   preserved behaviour, not a new decision.
