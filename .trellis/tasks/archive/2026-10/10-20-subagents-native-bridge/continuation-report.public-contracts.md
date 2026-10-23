# B2 public-contracts handoff

Status: **completed for the assigned B2 boundary**. A/B1 were preserved. Consumer migration and final independent acceptance remain pending.

This file is the authoritative handoff for this run, replacing the earlier requested `B-handoff.md` destination as directed by the dispatch output override. Worktree: `/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge`. No commit, push, merge, task lifecycle change, main-checkout source edit, upstream-package edit, or real-project init test was performed. The only main-checkout write is this explicitly authorized shared task artifact.

## Changed files

- `core/subagents-client.ts`: strict public protocol/DTO decoding; native top-level capacity; closed-client guards and cleanup; ambiguous-spawn correlation and conservative reservations.
- `core/subagents-workflow.ts`: resolver bound to host-prepared context; explicit child isolation overrides, acceptance, semantic result validation; bounded public-export lookup.
- `modules/subagents/index.ts`: canonical Git/task plan checks, preparation outside the resolver, direct-tool refresh, prerequisite registration ordering, command reservation handling.
- `scripts/upstream-bridge.test.ts`: production-shaped payloads, real temporary Git worktrees, production command/registration tests, failure and boundary regressions.
- `scripts/runtime-lifecycle.test.ts`: only `workflowRegistered()` changed, with supervisor approval. It recognizes the exact package-owned “no prepared task/worktree context” refusal as registered-but-not-executable. Unknown resource/other resolver errors still mean false. Existing off/shutdown/session-replacement assertions remain intact.
- `.trellis/tasks/10-20-subagents-native-bridge/continuation-report.public-contracts.md`: this report.

The pre-B2 versions of the five source/test files were saved under `/var/folders/8c/t8htn7h14t777qd1hclgyj940000gn/T/coworkflow-b2-baseline-v1m1ssay` before editing. Other preexisting dirty/untracked source files were not edited.

## Delivered behavior

### RPC and observations

- Ping requires protocol v1, string methods, and object capabilities/events/session. Boolean capabilities require `true`; supported versioned capabilities require version 1. Null, zero, missing, malformed, and unsupported-version capability values do not count as support.
- Reply envelopes are correlated by UUID. Malformed correlated envelopes fail as protocol errors. `events.on` failures settle without emitting; timers and listeners are cleared on success, refusal, failure, timeout, and disposal. A late async continuation cannot refill a closed client's ping or bridge activity cache.
- Cost requires version 1, complete nonnegative numeric usage fields, a valid children array, and a nonnegative integer unresolved count. Malformed child rows are rejected, not filtered away. Child and overall aggregates must agree, allowing floating-point tolerance for cost. `unresolvedAsyncChildren > 0` remains `incomplete: true`, a lower bound.
- Activity prefers capability-checked `fleet.topLevelAsyncCapacity.used`. It never substitutes `fleet.totalActive` or opaque fleet keys. A complete, validated v1 async snapshot is the compatibility fallback; missing/malformed/truncated snapshots without a valid top-level counter produce `unknown`.
- Snapshot validation checks kind/version, timestamp, cap fields, omitted fields, top-level node kinds/states/identity, duplicate IDs and root count. Only queued/running roots count in the fallback. When the native counter is valid, bounded or missing detail does not invalidate that authoritative count.
- A spawn is never retried. Timeout, malformed receipt/envelope, emit failure after emission, or disposal after emission preserves `rpc-spawn-<requestId>` for recovery. Definitive refusal remains a refusal.
- Reservations no longer expire into free capacity. Ambiguous launches retain their alias; observations perform public targeted status lookups and release a reservation only once a correlated run is represented in the validated native snapshot. Missing/expired recovery evidence never proves that execution did not start. Session disposal clears the session-local reservations.

### Task/worktree and resource binding

- `planRun()` canonicalizes real paths, rejects main-checkout aliases, validates the Git repository's common directory, actual linked-worktree membership and the exact branch recorded in `task.json`. Plain directories, subdirectories, unrelated repositories, wrong branches and `.`/`..` task basenames are rejected. A configurable name such as `custom-tree` is accepted; there is no task-name suffix heuristic.
- The host prepares this context during reconciliation and revalidates it before command dispatch and named workflow tool calls. Registration's resolver reads only in-memory session/readiness/context state: no Git, filesystem reads, settings reads, SDK calls, processes, or timers occur in the resolver.
- Public resource args are now `{ taskRef, focus?, implementAgent?, reviewAgent? }`. The taskRef must match the host's prepared active task. `worktree`, `mainCheckout`, `taskTitle`, script and other overrides are rejected. Paths and title come from the verified plan.
- Missing context, changed tasks rechecked at the tool boundary, withdrawn/replaced session state, and unavailable required child guidance cannot yield an executable expansion.
- Required child-extension registration completes before workflow registration. Failure leaves no usable workflow. B1's per-host generation checks, late disposal, module gates, passive failure reporting and shutdown behavior remain in place.

### Workflow and loading

- Both stable children (`implement`, `review`) explicitly use the same verified `cwd`, `worktree: false`, `context: "fresh"`, and omit per-child async so completion is awaited.
- Implementation uses explicit checked acceptance with a structured report, criterion, changed-files/commands-run/residual-risks/no-staged-files evidence. Review uses explicit attested acceptance with a structured report and review-findings/residual-risks/manual-notes evidence. No host shell grant, goal/watchdog, retry, merge or automatic final acceptance was introduced.
- Successful execution alone is insufficient: implementation must say completed, have a nonempty bounded summary and valid changedFiles/residualRisks arrays. Review must say pass, have a nonempty bounded summary and an empty findings array. Review findings are explicitly defined as blockers; contradictory pass-plus-blockers fails. Negative/malformed implementation prevents review from launching.
- Public subpath resolution checks project `.pi/npm/node_modules`, bounded Node project/local search paths, then the known Pi global installation. String and ESM import/node/default exports are supported; unsafe/missing exports fail with diagnostics. An incompatible local installation does not silently load another global owner. Only documented exported subpaths are imported by production code, never the main runtime.

## Exact consumer API for C

From `core/subagents-client.ts`:

```ts
attachSubagents(host, { epoch, events }): SubagentsBridge
existingSubagentsBridge(host): SubagentsBridge | undefined

bridge.client.ping(): Promise<Result<SubagentsPing>>
bridge.client.requireCapabilities(): Promise<{ ok: true; ping } | { ok: false; message }>
bridge.client.status(params?): Promise<Result<Record<string, unknown>>>
bridge.client.cost(): Promise<NativeCost>
bridge.client.observeActivity(): Promise<NativeActivity>
bridge.client.spawn(params): Promise<Result<SpawnReceipt>>
bridge.client.dispose(): void

bridge.observe(): Promise<NativeActivity>
bridge.admit(launchId, limit: number | null): Promise<Admission>
bridge.admitSync(launchId, limit): Admission // legacy cached API; migrate tool gates to awaited admit
bridge.bind(launchId, runId: string | null): void
bridge.hold(launchId, alias): void
bridge.release(launchId): void
bridge.pending(): number
bridge.dispose(): void
```

`NativeActivity` is `{ kind: "known", active, runs, omitted } | { kind: "unknown", reason }`. **`runs` now retains validated top-level terminal and paused nodes as well as active nodes**, allowing reservations to reconcile completed runs. Use `active` for admission; filter queued/running only for an active-run display. `runs` can be empty while authoritative `active` is nonzero. Do not infer IDs from fleet entries or infer completeness from the length of `runs`.

`NativeCost` retains parent/children/childTotal/total, unresolvedAsyncChildren and incomplete on known reports. Unknown reports carry a reason. Missing fields never become zero. Child `sessionFile`, when provided by native cost, remains the supported history pointer.

`Result` failures carry reason/message, optional upstream code, and optional `ambiguous: { alias }`. Transport successes may include requestId for recovery bookkeeping; it is **not a run ID**. For dispatch: await `admit`; on confirmed receipt call `bind`; on ambiguous failure call `hold` and surface the alias; call `release` only for a proven no-launch/failure/cancellation. `bind(null)` no longer frees a reservation. `release` is an explicit caller assertion, not a timeout mechanism. Dispose the old bridge on session replacement.

`status()` is the transport wrapper for targeted public status; activity and cost consumers should use the typed projections above, not independently reimplement their decoders. Exports `decodeAsyncSnapshot`, `decodeTopLevelCapacity`, `decodeCost`, `decodePing`, `hasCapability` own those shapes.

From `core/subagents-workflow.ts` / `modules/subagents/index.ts`:

```ts
interface PreparedWorkflowContext { taskRef; worktree; mainCheckout; title? }
resolveImplementReview(args, prepared?): { script } | { error } // pure, no default authority
registerImplementReviewWorkflow(sessionId, { projectRoot?, context?: () => PreparedWorkflowContext | null }?)
registerChildExtensionRequirement(sessionId, extensionPath, projectRoot?)
exportEntry("./workflow-resources" | "./required-child-extensions", projectRoot?)
planRun(root, taskDirRef, taskDir): verified plan | { ok: false, message }
```

The registration functions return `{ ok: true, registration: { dispose() } } | { ok: false, message }`. A registration without a prepared-context provider is intentionally not executable. `syncSubagentsRuntime`, `subagentsRuntimeSettled`, `resetSubagentsRuntime`, B1 lifecycle hooks, and task/native identity-link functions retain their existing interfaces. Native link storage remains identity-only and is written only after a correlated successful launch receipt.

## Verification actually run

- `npm run typecheck` — passed (`tsc --noEmit`).
- `node --experimental-strip-types --test scripts/upstream-bridge.test.ts scripts/runtime-lifecycle.test.ts` — **49 passed, 0 failed, 0 skipped** in the final run (38 bridge, 11 B1 lifecycle).
- `git diff --cached --name-only` — empty; no staged files.

The final focused run includes the installed pi-subagents 0.79.1 registration/resolution/disposal smoke and mandatory child-extension registration smoke. Tests use the actual production client, bridge, extension command, registration handlers and resolver. The successful command test constructs a real temporary Git linked worktree and resolves through the installed owner's registry; no manual production binding is used. Its stale/direct-call and spoofed-path checks go through those same handlers. Tests also cover capacity overflow, complete fallback versus unknown snapshot, strict cost/ping capabilities, throwing listener registration, async close, ambiguous spawn paths and retained reservation recovery.

The original Stage A suite and repository-wide `npm test` were not rerun: this dispatch requested B2 plus affected regressions, and Stage A/B1 implementation was already accepted. B1's affected lifecycle suite was run because registration readiness changed. No live coding child was launched. Native workflow script execution/negative verdicts were exercised with bounded fake child results; this is not a claim that a full live mission or the owner's tool-level script validator was executed.

## Remaining uncertainty / unsatisfied wider task requirements

- C1/C2 consumer migrations are still required: direct-dispatch admission must await fresh public observations; lane/completion correlation and usage/chart consumers still need their assigned migration. This run did not edit those consumers, README, or integration spec.
- Public resource resolution is I/O-free and binds to the last host-verified snapshot. Commands and model tool calls revalidate first. Another trusted extension using RPC outside these boundaries must arrange host reconciliation; concurrent filesystem mutation after validation is a normal check/use race, not sandboxed by registration. No arbitrary-extension RPC policing is claimed.
- Ambiguous evidence that never becomes recoverable can conservatively hold a session slot until explicit proven release or session disposal. This is intentional rather than silently oversubscribing. No cross-process reservation authority or lifecycle persistence was added.
- The native fleet counter is feature-detected from the audited installed public reply. Builds without it need a complete valid async snapshot; otherwise admission under a configured limit fails unknown.
- No native coding workload, final independent review, parent acceptance, merge, task archival or integration into main was performed. Workflow completion remains parent-owned acceptance.

No known blocker remains within the assigned B2 boundary.
