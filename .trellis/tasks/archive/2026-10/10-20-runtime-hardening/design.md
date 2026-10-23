# Design

One task, three independent fixes, serial writers in the task worktree. The native-integration layer
from `b79870f` is the contract being preserved, not changed.

## 1. Config-root cache

`core/trellis.ts` owns `repoRoot()`/`mainCheckout()`; `core/config.ts` owns `configRoot()`. The cache
belongs next to the resolution, not in the orchestrator, so every caller benefits and no module carries
its own copy.

Shape: a resolver object created per runtime that memoises on `(cwd, epoch)` and returns either a
resolved absolute path or an explicit unresolved reason. The orchestrator creates one alongside
`RuntimeContext`, exposes it through `RuntimeContext` (so modules stop calling `configRoot(cwd)`
directly), and the epoch is already incremented on `session_start`. `cwd` change is detected by
comparing against the key, so a lane/worktree switch resolves its own main checkout.

Failure must be visible: `resolveLoadState()` today cannot tell "git failed" from "not inside a repo".
The resolver returns the difference, and `/Coworkflow:status` reports it.

Rejected: a process-global memo (wrong across sessions and worktrees) and a time-based cache (stale
after a project rename, still spawns on expiry).

## 2. Exit check in `/Coworkflow:lanes`

Reuse `planRun(root, taskRef, taskDir)` in `modules/lane-worktree/index.ts`, which already validates
task.json, canonical paths, linked-worktree membership and the task branch. Add a read-only exit-state
block computed from git reads that are already needed:

- merged: `git merge-base --is-ancestor <branch> <base>` plus `git rev-list --count base..branch`;
- worktree present: the validated `worktree_path` exists and is a registered worktree;
- worktree clean: `git status --porcelain` limited to tracked/untracked-but-not-ignored files.

Only when merged AND clean does it print `git worktree remove …` / `git branch -d …`. Never `--force`,
never `-D`. Everything else prints the failing precondition. The module stays read-only — no merge, no
archive, no removal. This is a report, not a controller, because the human keeps the integration
decision.

## 3. Per-module default for new switches

`core/config.ts` gains a declaration of what an absent key means for that module. `WorkflowModule`
declares `newSwitchDefault: "on" | "off"` (default `"on"`, so current modules are unchanged).
`isEnabled()` becomes: explicit value wins; otherwise the module's declared default. `describeSwitches`
and the init pass must distinguish "on because chosen" from "on because defaulted" so a report never
implies consent that never happened.

Existing configs written by `b79870f` list every module explicitly, so nothing flips on upgrade. The
change only affects keys added later — which is exactly the gate-module risk this closes.

## Boundary

No changes to `core/subagents-client.ts`, `core/subagents-workflow.ts`, `core/usage.ts`, panel layout or
keys, workflow registration, or capacity policy. No automated cleanup action anywhere.

## Verification

Focused tests through production functions: config-root cache (repeat read spawns no git — assert via a
counting seam or by making the resolver's git runner injectable for the test only; failure surfaces),
cache invalidation on epoch and cwd, exit-state rendering for merged/clean, unmerged, dirty, and missing
worktree, and new-switch default (gate module absent → off; observation module absent → on; explicit
false → off; round trip preserved). `npm run typecheck` plus `npm test`.
