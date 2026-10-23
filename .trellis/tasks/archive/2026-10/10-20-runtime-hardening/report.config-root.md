# Stage 1 — configuration root resolved once per runtime

## What changed

`core/config.ts` now owns a resolver, and the orchestrator creates exactly one per extension runtime.

- `GitAnswer` = `ok | no-repo | failed`. The probe keeps stderr (`stdio` pipe) and classifies git's own
  message, so "not a repo" and "git could not answer" stop being the same `null`. `LC_ALL=C` is forced
  because that classification reads a localized string.
- `ConfigRootResolution` = `resolved | no-repo | unresolved`. Only `unresolved` is a `null` root; a
  project outside a repository still resolves to its own directory, which is the honest answer it
  always was.
- `createConfigRootResolver({ epoch, runGit })` memoises on `(resolve(cwd), epoch)`. `epoch` is read
  live, so the orchestrator's `session_start` increment invalidates by key rather than by event; a cwd
  change does the same. `invalidate()` is called explicitly on `session_start`.
- `runGit` is injectable and only a test passes it; production uses the real `execFileSync` runner.
- `readConfigAt(resolver, cwd)` reads a config through the resolver and returns `null` for an
  unresolvable root — no cwd fallback anywhere on that path.

`RuntimeContext.configRoots` carries the resolver into every module; `WorkflowControl` gained
`configRoot()` and `configRootNote()` for the panels.

## Call sites moved off per-event git

| before | after |
| --- | --- |
| `resolveLoadState()` → `configRoot(cwd)` (every command, every `before_agent_start`) | `runtime.configRoots.root(cwd)`; unresolved ⇒ inert `off` |
| `ensureRuntime` / `activateSession` / `runtimeReport` / `moduleEnabled` | `readConfigAt(...)` |
| `createControl().rootOf()` and 8 control methods | resolver, each method handling `null` explicitly |
| `modules/lane-worktree` `enabled()` + 5 handlers | one `configRootOf(state)` helper |
| `modules/subagent-context` `buildPrompt` (`before_agent_start` per run) | resolver, unresolved ⇒ no injection |
| `modules/subagents` `schedule()` + `/Coworkflow:run` | resolver, unresolved ⇒ withdraw / refuse |
| `core/usage.ts` `refreshUsage` | resolver; unresolved ⇒ no `since` rather than reading a guessed root's flags |
| `modules/panel/models.ts` `initialized()` | `readConfigAt` |

`configRoot()` itself is deleted so nothing can drift back to the uncached form.

## Visibility of the failure

- `/Coworkflow:status` (which is `runSetup --dry-run`) returns early with an explicit block when the
  root is unresolved: no module list, no switch summary, nothing written. Previously `gitRoot()`
  fell back to `cwd` and the report described a directory nothing had confirmed.
- The `[runtime]` block prints `配置根: <path>` when resolved and
  `! 配置根无法解析（reason）` when not.
- `panel` `facts()` prints `配置: 无法解析配置根…` instead of a path, and every mutating control
  method (`setSwitch`, `setAutoEnable`, `setPrefix`, `setSubagentConcurrency`) refuses with the reason.
- `/Coworkflow:start`, `/Coworkflow:lanes` and `/Coworkflow:run` refuse with a reason instead of
  acting on a guessed root. `usageSnapshot` no longer dates the attribution window from a directory
  this session is not running in.

## Tests — `scripts/config-root.test.ts` (5, all registered in `npm test`)

1. Injected runner: one resolve = 2 git calls; 10 more reads = 0; epoch bump re-resolves; cwd change
   re-resolves to the new worktree's own checkout; a trailing slash is the same key.
2. Injected failure: `unresolved`, `root() === null`, `readConfigAt` reads nothing **even though the
   directory has a valid `.pi/Coworkflow.json`**, and the note carries git's reason.
3. `no-repo` resolves to the directory and is distinguished from failure.
4. Production path: a `git` shell script on `PATH` + the real extension. After load, 20 further gate
   evaluations (`moduleEnabled`, `switches`, `initialized`, `configRoot`) spawn zero processes.
5. Production path with git broken before the runtime resolves: `configRoot() === null`,
   `initialized() === false`, every switch `false`, `setSwitch` refuses, and `Coworkflow:status`
   renders the unresolved block without presenting the cwd as the config.

The existing suite was updated only where it constructs a `RuntimeContext` literal (it now needs
`configRoots`); assertions were unchanged.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 91 tests, 91 pass, 0 fail.
- Manual: `scripts/verify.ts <tmp> Coworkflow:init` then `Coworkflow:status` on a real temp repo —
  `[runtime] = 配置根: /private/tmp/…`; the temp project and its `trust.json` entry were removed after.

This worktree has no `node_modules` of its own; `node_modules` is a gitignored symlink to the main
checkout's, which is what makes `tsc`/`node --test` resolvable here. Nothing tracked depends on it.

## Notes / residual risk

- The resolver holds one memo entry. A session that alternates between two cwds in one turn would
  re-resolve each switch; that is the deliberate trade (a time-based cache is stale after a rename and
  still spawns on expiry) and does not happen on the gate path, which uses `runtime.cwd`.
- `runSetup` still uses `gitRoot()` for the root it *installs into* once the resolver has confirmed the
  answer; that is one spawn per explicit `/Coworkflow:init`, not per event, and changing it is outside
  this stage.
- `mainCheckout`/`repoRoot` remain exported: `planRun` still uses them for its own worktree-membership
  validation, which is not on the gate path.
