# Parent recovery note — C1 draft, not native completion

Native run 9a03e687 remains FAILED (30-minute deadline). The following was recovered from the final write tool arguments; that write did not finish and no structured acceptance was produced. The transcript records typecheck + npm test 73/73 passing and successful corrected temp verify before timeout; no code edits followed those checks. Parent inspected capacity admission, bridge reservation handling and lane rendering.

A remaining audit issue must be fixed before accepting the C1 boundary: mergePlan uses the configuration root as its git-apply destination, so invoking /Coworkflow:lanes from main can advise applying code into main. Reuse existing verified task/worktree planning to point at the task integration tree, and omit actionable apply commands with a precise reason when no verified target exists. Keep artifact and child identities unchanged. Add only a focused regression for this behavior. A short dedicated continuation owns this repair and final C1 report; do not rerun all of C1.

The old queued follow-up was never consumed; the direct supervisor reply was consumed and the worker resumed, as its subsequent edits/tests show. No pending supervisor requests remain.

---

# C1 capacity and lanes handoff

Status: **completed for the assigned C1 boundary**. Authoritative report for this run: `.trellis/tasks/10-20-subagents-native-bridge/continuation-report.capacity-and-lanes.md`. The dispatch's final output override replaces the earlier requested `C1-handoff.md` filename.

Worktree: `/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge`. A/B1/B2 retained. No commit, push, merge, task-state change, main-checkout source edit, upstream-package edit, global configuration write, or real-project init/disable test. This shared task report is the only authorized write through the main-checkout artifact path.

## Changed files

- `core/capacity.ts`: removed private run enumeration, process probes, timestamp matching and CapacityTracker. Exports async-launch classification. Temporarily retains `asyncRunsRoot()` solely for the separately assigned C2 usage migration.
- `core/ledger.ts`: deleted the unused DispatchLedger and its recording/gate hooks.
- `core/pi-subagents.ts`: removed private run-ledger probing. Added the single public result/completion and referenced-artifact decoding boundary, with exact child identity joins.
- `core/subagents-client.ts`: serializes async public observation/admission, correlates reservations through public aliases before reading authoritative capacity, adds cached activity and exact completion release. Provides a spawn pre-emission alias callback. Preserves B2 validation, failure/timeout ambiguity and no-retry behavior.
- `core/subagents-workflow.ts`: minimally extends existing NativeRunLink with optional workflow/worktree and artifact references; adds exact readRunLink lookup. Uses B2's existing project-wide identity map.
- `modules/capacity/index.ts`: production async tool_call admission, structured tool_result binding/error release, terminal-notice release, event-time gates and per-host void-safe lifecycle.
- `modules/lane-worktree/index.ts`: production direct-result/native-notification observers, identity-only persistence, bounded public status refresh and per-child artifact display. Reads the original `.trellis/.runtime/lanes/<task>/*.json` pointers unchanged. Preserves evidence/merge guidance.
- `modules/subagents/index.ts`: own `/Coworkflow:run` honors the capacity switch and correlates its reservation with the real RPC request alias before emission.
- `extensions/coworkflow.ts`: settings facts read cached native activity and render unknown explicitly instead of private scans/false zero. No panel layout/keyboard changes.
- `scripts/test.ts`: removes obsolete manually-bound ledger tests; retains classification regression, with actual handler coverage in the new suite.
- `scripts/capacity-lanes.test.ts`: five production-handler/command regressions, using public RPC fixtures and temporary projects/worktrees.
- `scripts/verify.ts`: lane fixture now supplies structured native identity and parallelHandoff reference; explicit no-launch fixture failures release reservations.
- `package.json`: includes the new C1 suite in `npm test`.
- This report.

## Delivered behavior

### Shared project admission

Both direct async `subagent` calls and `/Coworkflow:run` use the same per-host/session bridge and awaited `admit`. Configured capacity with unknown public state refuses with a diagnostic. Foreground calls and management actions consume no project async reservation. `resume` and `append-step` remain execution classifications; no automatic retries are introduced.

Admissions/public observations are serialized. A direct launch uses its documented toolCallId status alias. An RPC launch receives `rpc-spawn-<actual-requestId>` before emission, so a native owner that appears before the spawn receipt is not counted again as an uncorrelated pending launch. Alias resolution precedes the subsequent public capacity read, allowing the authoritative top-level counter to account for a resolved owner even when its display node is omitted from the bounded snapshot. No fleet display key is interpreted as a run ID.

Successful results bind reservations to exact native run IDs; explicit no-launch errors release them. Valid structured terminal completion notices release the matching bound owner. Running or malformed completion rows do not free capacity. Ambiguous launches retain their native alias until public evidence resolves them or the session ends; no TTL invents a free slot. Switching the capacity module off does not suppress cleanup of a reservation already created. New session epochs/disposal clear old reservations and RPC listeners.

The project gate covers direct tools and this extension's own RPC command. It does not claim cross-process authority or control over arbitrary other extensions' RPC requests.

### Lanes and identity ownership

The persistent map remains `.trellis/.runtime/native-runs.json`, written only after a correlated receipt. Entries contain task/native mission/run identity and optional artifact references, never status, task prose, child lifecycle histories, patches or scheduler state.

The lane observer associates direct toolCallId → task transiently, then records the confirmed native run. Structured `subagent-notify.details.runs` updates only already-known native links. It never extracts identity or artifact paths from notification prose, never derives run IDs from filenames, and never attaches an unknown completion to the only outstanding task. Explicit invalid task references do not fall back to the active task.

`/Coworkflow:lanes` reads public status and referenced native handoff/workflow receipts. Child joins use exact run IDs or native index coordinates, never array order or a workflow parent's identity as a fabricated child ID. Each child gets its own status, worktree/branch, patch and saved output reference where supplied. A launch receipt is not rendered as terminal success. Missing state is `未知`; absent patches and unreadable/mismatched handoffs are explicit. Durable workflow output references come from the keyed public workflow receipt; unsupported/absent output association is not guessed from notice text or array position.

Legacy pointer files remain in their original `.trellis/.runtime/lanes/<task>/` location, readable and untouched. Existing native cleanup eligibility, recorded merge evidence, diff statistics and manual review/merge/cleanup guidance remain visible. This command performs no merge, patch application or cleanup.

Observers own their module gates. Lane artifact adoption can remain active in an adopted project before `/start`, only with lane-worktree enabled. Retained feature commands refuse while disabled. Per-host registrations tolerate both unsubscribe-returning and void-returning hosts: permanent hooks remain once and are inert after shutdown; activation uses live runtime state. Session changes clear transient observations/call associations.

## Exact API for C2 and the checker

From `core/capacity.ts`:

```ts
startsAsyncRun(input: Record<string, unknown>): boolean
asyncRunsRoot(): string // TEMPORARY: only core/usage.ts still uses it; C2 should remove it with private usage scanning
```

There is no DispatchLedger, attachLedger, CapacityTracker, activeRunsForSession or probeRunLedger anymore.

B2 client API remains available, with these additions/clarifications:

```ts
bridge.activity(): NativeActivity // cached; unknown before an observation, never a synthetic zero
bridge.observe(): Promise<NativeActivity> // serialized, resolves pending aliases then observes native capacity
bridge.admit(launchId, limit): Promise<Admission> // shared by tools and own command
bridge.trackAlias(launchId, alias): void // only correlates an existing reservation; no new unlimited-launch reservation
bridge.bind(launchId, runId): void
bridge.hold(launchId, alias): void // explicitly retains an ambiguous emitted launch
bridge.release(launchId): void // explicit no-launch/failure assertion
bridge.releaseRun(runId): void // exact bound owner completion
bridge.client.spawn(params, beforeEmit?: (alias: string) => void): Promise<Result<SpawnReceipt>>
```

`Admission`'s successful `total` is `number | null`: no configured limit/no observation is not zero. The legacy `admitSync` remains for compatibility with earlier callers/tests, but no production direct-tool gate uses it. `observe`, admission and reserved counts remain session-local, not a persisted lifecycle database.

From `core/pi-subagents.ts`:

```ts
decodeNativeResult(details: unknown): NativeResult | null
decodeNativeCompletions(message: unknown): NativeResult[]
readNativeHandoff(path, runId): NativeHandoff | null
readNativeWorkflowReceipt(path, runId): NativeChild[]
mergeNativeChildren(...groups: NativeChild[][]): NativeChild[]
```

`NativeResult` contains `runId`, optional `missionId/workflowRunId/status/handoffPath/workflowReceiptPath`, and `children`. `NativeChild` carries optional exact `runId`, native `index/stepIndex`, workflowKey, agent/status and its own output/patch/worktree/branch/diff fields. This is the decoding owner; display consumers should not recast raw RPC/custom-message/artifact fields independently.

From `core/subagents-workflow.ts`:

```ts
interface NativeRunLink {
  runId: string;
  missionId?: string;
  taskRef: string;
  worktree?: string;
  workflow?: string;
  handoffPath?: string;
  workflowReceiptPath?: string;
  sessionId?: string;
  recordedAt: string;
}
recordLaunchLink(root, link): void
readTaskLinks(root, taskRef): NativeRunLink[]
readRunLink(root, runId): NativeRunLink | undefined
```

## Verification actually run

- `npm run typecheck` — final pass (`tsc --noEmit`). An intermediate run caught the unavailable taskFromPrompt helper; the lane now reuses the existing production resolveChildTask helper and preserves explicit-invalid behavior.
- `node --experimental-strip-types --test scripts/capacity-lanes.test.ts` — 5 passed, 0 failed.
- `npm test` — **73 passed, 0 failed, 0 skipped**, after the final source/test changes. Includes 19 original/runtime contracts, 38 B2 bridge/workflow, 11 B1 lifecycle, 5 C1 production-handler regressions. Installed upstream registration/resolution/disposal smoke still passes; no live coding child launched.
- Temporary-root verify fixture: `scripts/verify.ts <temp> lane-record <fixture-handoff>` then `Coworkflow:lanes` — passed, persisted native link displayed after a separate invocation with the correct child's patch, native cleanup evidence and manual merge plan.
- Temporary-root verify fixture: `scripts/verify.ts <temp> subagent-call '{"async":true}'` with configured limit 1 and no public bus — passed: BLOCKED with unknown-status diagnostic, 0 user-role messages.
- Initial manual verify attempt failed because the fixture inherited this worker's child environment and used a session pointer without Trellis's `pi_` prefix. Corrected only the temporary invocation environment/pointer, then reran successfully; no production workaround was added.
- `git diff --cached --name-only` — empty; no staged files.

The C1 tests exercise actual registered handlers and the actual `/Coworkflow:run` command. They cover direct and RPC launches sharing capacity before