# C1 recovery completion — lane integration target

Status: completed for this assigned repair. Authoritative handoff: `/Users/lyston/PycharmProjects/pi-Coworkflow/.trellis/tasks/10-20-subagents-native-bridge/finish-report.lane-target.md`.

## Recovery and repair

C1's original native run timed out while submitting its final report. Its recovered `C1-handoff.md` records the capacity/lane migration and parent-observed typecheck, 73/73 full tests and corrected temporary verify checks. Those are historical results, not checks rerun by this continuation. A/B1/B2/C1 were preserved; this continuation fixes only the parent's remaining lane-target audit issue.

`/Coworkflow:lanes` now reuses the already-exported `planRun(root, taskRef, taskDir)` to select the task's verified integration worktree. The existing validator checks task.json, canonical paths, repository/worktree membership and task branch. No new Git validator or export was added. The configuration root remains the artifact and cleanup root; it is no longer the patch-application destination.

Handoff/receipt references are resolved against their original project root before reading. Relative patch references are resolved against that same root before constructing `cd '<verified-task-tree>' && git apply --3way '<absolute-original-patch>'`. Changing the command's destination therefore cannot reinterpret the artifact path. Shell quoting is preserved.

When the task target is missing or invalid, the plan shows the validator's prerequisite diagnostic and keeps child identity, patch/output/worktree evidence, merge evidence and cleanup guidance. It emits no git-apply command and never substitutes main or a child's worktree. The commit instruction now names the verified task integration tree. Legacy pointer storage and native identity links are unchanged.

## Files changed in this continuation

- `modules/lane-worktree/index.ts`: verified task integration target, original-root artifact resolution, diagnostic-only application plan when unavailable.
- `scripts/capacity-lanes.test.ts`: targeted production-command regression using a real temporary Git linked worktree. Covers invocation from main; relative handoff/receipt/patch references; missing worktree_path; main as invalid target; branch mismatch; retained child/evidence/cleanup display and unchanged identity links.
- This authorized shared task handoff.

All earlier dirty/untracked work was preserved. No commit, push, merge, task lifecycle change, main-source edit, upstream-package edit, global configuration write, real-project init/disable or UI layout/keyboard change was performed.

## Checks actually run here

- `npm run typecheck` — passed (`tsc --noEmit`).
- `node --experimental-strip-types --test scripts/capacity-lanes.test.ts` — 6 passed, 0 failed, 0 skipped.

The full suite and optional additional verification were intentionally not rerun per this dispatch. No patch was applied and no coding child was launched. No files were staged.

## C2 consumer interfaces and remaining work

The recovered `C1-handoff.md` and `continuation-report.public-contracts.md` retain the fuller contracts. Current interfaces relevant to C2:

- `attachSubagents(host, { epoch, events })` / `existingSubagentsBridge(host)` from `core/subagents-client.ts` provide the session-local bridge. `bridge.activity()` is cached typed `NativeActivity`; `bridge.observe()` refreshes it. Unknown is explicit; do not infer active count or run identity from display rows/fleet keys.
- `bridge.client.cost(): Promise<NativeCost>` owns cost decoding. Known reports retain parent/children/childTotal/total, `unresolvedAsyncChildren`, and `incomplete`; unsupported/malformed reports carry an unknown reason. Public child `sessionFile`, when supplied, is the supported history pointer. Missing observations are never zero.
- Shared launch accounting remains `bridge.admit`, `trackAlias`, `bind`, `hold`, `release`, `releaseRun`; `client.spawn(params, beforeEmit?)` exposes the actual RPC alias before emission. C2 should preserve these and must not introduce another lifecycle reader.
- `core/pi-subagents.ts` owns `decodeNativeResult`, `decodeNativeCompletions`, `readNativeHandoff`, `readNativeWorkflowReceipt`, `mergeNativeChildren`. No consumer should duplicate raw payload decoding or infer child identities.
- `core/subagents-workflow.ts` owns `NativeRunLink`, `recordLaunchLink`, `readTaskLinks`, `readRunLink`; storage remains task/native identity and artifact references only.
- `core/capacity.ts` still temporarily exports `asyncRunsRoot()` solely for the existing usage consumer. C2 should migrate `core/usage.ts` from private run scans to native cost and then remove that obsolete export. Preserve parent history charts and bounded child history only from public sessionFile references, with visibly incomplete/unknown usage and no invented model attribution.
- Complete the assigned usage/panel-data/documentation work, keeping layout and keyboard behavior unchanged. README and the parent-owned focused integration spec should explain supported public capabilities, missing-data behavior, concurrency scope and migration. Final independent review and parent acceptance/integration remain outstanding.

## Residual risks

No known blocker remains in this narrow repair. Generated commands are manual instructions based on validation at render time; external filesystem/branch changes after rendering require rerunning the command. This continuation does not attest completion of C2 or final project acceptance.
