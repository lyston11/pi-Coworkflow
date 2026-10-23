# Stage 4 — read-only check of the task delta from `b79870f`

Scope: `git diff` of the working tree in `/Users/lyston/PycharmProjects/wt-10-20-runtime-hardening`
against `b79870f` (16 modified + 2 new files, +665/−71), reviewed against `prd.md` acceptance 1–6.
Nothing was edited. Verification was done by driving production functions and the real extension
factory (`controlSurface()`, registered command handlers, real event dispatch) with a `git` shim on
`PATH` that logs every invocation and then `exec`s `/usr/bin/git`, so "no subprocess" and
"delegates to real git" are both measured on the production path, not asserted about a stub.

Environment of the probes: Node v24.21.0, `git version 2.50.1 (Apple Git-155)`, macOS.

---

## BLOCKERS

### BLOCKER-1 — the resolver does not resolve a linked worktree to its main checkout; `--absolute-git-common-dir` is not a git option, and the new test passes only because it stubs it

- `core/config.ts:141` — `git(dir, ["rev-parse", "--absolute-git-common-dir"])`
- `core/trellis.ts:83` — the same call in `mainCheckout()` (pre-existing, unchanged by this task, and the source the new code copied)
- `scripts/config-root.test.ts:45` and `:159` — the fakes answer that flag with an absolute path

`git rev-parse` does not have an `--absolute-git-common-dir` option; it echoes unknown `--`-prefixed
arguments back on stdout with **exit 0** (the documented form is
`--path-format=absolute --git-common-dir`). So `probeGit` classifies the echo as `{kind:"ok"}`,
`isAbsolute("--absolute-git-common-dir")` is false, `basename(...)` is not `.git`, and
`resolveConfigRootAt` returns `dir` — the **toplevel itself**. Consequence, measured with real git
(`createConfigRootResolver().resolve(<linked worktree>)`):

```
worktree cwd            : …/repo/task tree
new resolver(worktree)  : {"kind":"resolved","root":"…/repo/task tree"}   ← should be …/repo
old configRoot(worktree): …/repo/task tree                                (identical, pre-existing)
```

Two things follow, and both contradict text this delta ships:

1. `core/config.ts:126-135` (the doc comment above `resolveConfigRootAt`) and `design.md` §1 state
   "Resolved through the main checkout, so a lane or task worktree … still finds the project's
   config", and `implement.md` Stage 1 says "a lane/worktree session resolves its own main checkout".
   With this git it resolves the worktree. A session whose cwd is a task/lane worktree therefore
   reads the **worktree's committed** config: uncommitted switch changes in the main checkout are
   invisible, and a worktree that has no `.pi/Coworkflow.json` (the normal case — `.pi/` is untracked
   in this repository, `git ls-files .pi` is empty) reads **no config at all**, i.e. the whole layer
   is inert in that worktree.
2. `configRootNote()` (`core/config.ts:200-204`) reports the main-checkout case only when
   `cwd !== root`; because the root equals the cwd here, `/Coworkflow:status` prints no note and the
   wrong answer is silent — the exact failure mode PRD §1 is about.

**Not a regression**: `b79870f`'s `configRoot(cwd) = mainCheckout(repoRoot(cwd))` produces the
identical wrong value on this git, so no delivered behaviour changed. But the delta (a) newly states
the property in code comments and in `design.md`, (b) newly *tests* it — and only against a fake git
that answers a flag the real tool ignores (`scripts/config-root.test.ts:45`, `:159`; the
`countingGit` test asserts `linked → main`, which real git cannot produce). That is precisely a test
that passes because it stubs the thing under test.

Fix, if the parent wants it now: drop the nonexistent flag and use the supported spelling in both
places —

```ts
const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const absolute = isAbsolute(common.out) ? common.out : join(dir, common.out);
```

(verified working on this git: `git -C <worktree> rev-parse --path-format=absolute --git-common-dir`
→ `…/repo/.git`), and make the production-path test exercise that spelling instead of a fake that
accepts the broken one. Because this changes only an inherited line, deferring it is defensible; ship
it or the doc comment and test are wrong.

### BLOCKER-2 (low, report-only, but it is a false statement the task added) — `/Coworkflow:status` labels a non-repository directory as "（主 checkout）"

- `extensions/coworkflow.ts:415-417`

```ts
: [`  = 配置根: ${rootResolution.root}${configRootNote(rootResolution, runtime.cwd) === null ? "" : "（主 checkout）"}`];
```

`configRootNote()` is non-null for **two** kinds: `no-repo` ("按当前目录读取") and `resolved` with
`cwd !== root`. The line therefore appends "（主 checkout）" to a `no-repo` answer. Measured in a temp
directory that is not a repository:

```
= 配置根: /var/…/probe5-…（主 checkout）      ← no .git anywhere; it is not a main checkout
```

Consequence is cosmetic (the correct path is printed), but the suffix asserts a fact the resolver just
said is untrue, in the one line whose purpose is to make this state distinguishable. Cheap fix: build
the line from `configRootNote()` itself, or gate the suffix on `rootResolution.kind === "resolved"`.

---

## Acceptance, item by item (probed, not assumed)

1. **No `git` per gate evaluation; repeated read reuses the resolution — met.**
   - `control.moduleEnabled("panel")` ×20, `control.switches()` ×20, `control.facts()` ×30 in one
     session: **0** git spawns after the first resolution (was 180 for 30× three calls on
     `b79870f`).
   - A non-`subagent` `tool_call`: **0** spawns (was 4 — `lane-worktree.enabled()` used to call
     `configRoot` on every `tool_call`).
   - `before_agent_start` ×2 in a prepared task: **7** spawns each, down from **19** on `b79870f`.
     Limitation, stated honestly: the remaining 7 are not config reads — they are
     `planRun()`'s own validation (`rev-parse --show-toplevel` ×2, `--path-format=absolute
     --git-common-dir` ×2, `worktree list --porcelain -z`, `symbolic-ref HEAD`) run by
     `modules/subagents/index.ts:430` on every reconciliation, before the "already the right set"
     short-circuit. That is `b79870f` behaviour and out of this PRD's scope; the *configuration-root*
     path is fully cached. If PRD 1's "no git subprocess per gate evaluation" is read as
     "`before_agent_start` spawns nothing", this delta does not reach it — flag for the parent, do not
     silently reframe it.
2. **Cache cannot leak across sessions or worktrees — met.** Epoch bump re-resolves (2 calls),
   `cwd` change re-resolves and returns the new worktree's root, a trailing slash is a distinct
   spelling normalised by `resolvePath`, two different linked worktrees in one resolver never trade
   answers, and a second extension factory call gets its own resolver (`scripts/config-root.test.ts`
   "a git failure surfaces as unresolved…" drives exactly that boundary: the first runtime keeps its
   answer, the replacement resolves `null`). No process-global state: `createConfigRootResolver` is
   called at `extensions/coworkflow.ts:198` and `:945`, both per runtime.
3. **Unresolvable root is surfaced and reads nothing — met.** With a `git` that always fails:
   `control.configRoot() === null`, `initialized() === false`, `moduleEnabled("panel") === false`,
   every switch `false`, `setSwitch` refuses without writing, `/Coworkflow:status` prints
   "配置根无法解析 … 不列出模块开关", `/Coworkflow:start` refuses, and a project that *is*
   initialized in that very directory is not read (`readConfigAt` → `null`, verified in
   `scripts/config-root.test.ts` and reproduced by probe). `no-repo` stays a distinct third answer
   that legitimately resolves to the directory. Practical limitation worth knowing: the memo has no
   TTL, so a *same-session* retry cannot recover — `/Coworkflow:init`'s own advice ("git 恢复后重试
   /Coworkflow:init") is not actionable until `session_start`/`/reload` bumps the epoch. Measured:
   after git recovered, `init` still refused and `configRoot()` stayed `null` until a new
   `session_start`. Acceptable for a transient failure (and the design forbids a time-based cache),
   but the message over-promises.
4. **Lanes exit block — met, all four cases, and read-only.** Driven through the registered
   `Coworkflow:lanes` handler on a real repo + linked worktree:
   - unmerged, clean → `尚未合并进 main（还领先 1 个提交）`, `不提供清理命令: 前提未满足 —— 分支 feat/x 未合并进 main（领先 1 个提交）`, no `worktree remove`, no `branch -d`;
   - merged, dirty → `已合并进 main（领先 0 个提交）`, `工作树状态: 1 处未提交改动`, no command;
   - merged, clean → exactly `git -C '<main>' worktree remove '<worktree>'` and `git -C '<main>' branch -d '<feat/x>'`;
   - worktree gone → `未满足前提 —— … 不存在或不是目录`, no command.
   `--force` and `-D` appear nowhere in the module (the only occurrences in the repo are the AGENTS.md
   prose and the test's negative assertion). A `for-each-ref` / `worktree list --porcelain` /
   `status --porcelain` fingerprint of the main checkout is byte-identical before and after both a
   successful and a failing render. `planRun` remains the only validator; `gitProbe` only reads, and a
   git failure reads "无法判定" rather than merged.
5. **New-switch default — met.** `resolveSwitch` gives `defaulted/off` for an absent gate,
   `defaulted/on` for an absent observation module, and `chosen` for any explicit boolean in either
   direction. **No module in `MODULES` declares `newSwitchDefault`** (asserted in the test and
   confirmed), so the effective switch of every current module is unchanged: 0 differences against the
   old `modules[id] !== false` rule across 3×8 samples. Round trip through the real `/Coworkflow:init`
   on a temp project: a config naming only today's modules gains `probe-gate=false`,
   `probe-observe=true`; a second run rewrites the identical map and the report stops marking them
   `（默认）`.
6. **No regression to native RPC/workflow/usage/lane artifacts, panel layout or keys — met.**
   `core/subagents-client.ts`, `core/subagents-workflow.ts` and `modules/panel/settings.ts` are
   untouched; `modules/panel/models.ts` changes one line in the "not loaded" message path
   (`readConfigAt`) with no layout, column, key or tab change; `core/usage.ts` changes only the
   `since` source; `modules/subagents/index.ts` changes only where `root` comes from (and withdraws the
   session registrations instead of registering against a guessed root). `mergePlan`'s output is
   unchanged (the `quote` helper was hoisted verbatim). The full suite is green, including the
   upstream-bridge/lane/usage/panel tests that pin `b79870f`'s behaviour.

---

## Verification run once

- `npm run typecheck` → `tsc --noEmit`, clean (no diagnostics).
- `npm test` → `ℹ tests 98 / ℹ pass 98 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0`, 11.6 s.
  (12 of those are new: 5 in `scripts/config-root.test.ts`, 6 in `scripts/switch-default.test.ts`,
  1 in `scripts/capacity-lanes.test.ts`.)

## Other findings (non-blocking)

- `extensions/coworkflow.ts:482` — `runSetup` still takes its write target from `gitRoot(cwd)`
  (which falls back to `cwd`) instead of `resolution.root`. Today the two agree *because* of
  BLOCKER-1; once the common-dir flag is fixed, `/Coworkflow:init` run from inside a linked worktree
  would write the config into the worktree while every gate reads the main checkout. Fix them
  together.
- `scripts/switch-default.test.ts:145` — the harness pushes its two probe modules into the shared
  `MODULES` array, and the file calls it twice, so the registry ends up with duplicates. Harmless
  (each test file is its own process, and assertions are regex-based), but the registry is mutated by
  a test that later asserts "no module declares a default" over that same array.
- `extensions/coworkflow.ts:421-424` — `runtimeReport()` calls `readConfigAt(...)` inside the
  per-module loop; it is a file read (not git) per module, so it is only a small waste, but the
  comment above the loop promises the difference between "off" and "never chosen" is *reported*, and
  that read could be hoisted once.

## Residual risk of this review

Probes used a `PATH`-shim git and Node 24 on macOS; the git-option finding (BLOCKER-1) is
version-specific in principle — `--absolute-git-common-dir` is not in `git-rev-parse(1)` here, so any
git that also treats it as an unknown argument will echo it the same way. No repository outside the
task worktree and temp directories was touched; nothing was committed, merged, archived or removed.
