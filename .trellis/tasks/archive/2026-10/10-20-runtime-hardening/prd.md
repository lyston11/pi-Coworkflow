# Harden runtime config reads and task exit

Follow-up to `archive/2026-10/10-20-subagents-native-bridge`. Parent design review identified three
independent defects that were deliberately left out of that task. Each is small, verifiable on its own,
and must not change the native-integration behaviour delivered by `b79870f`.

## 1. Main-checkout resolution must not spawn `git` per event (P1)

`configRoot()` → `repoRoot()` + `mainCheckout()` each run `execFileSync("git", …)`; `mainCheckout`
itself shells out twice. `moduleEnabled()` calls `configRoot()` on every gate evaluation, and gates run
on `tool_call` and `before_agent_start`, so one dispatch or one agent turn costs several child
processes. Worse, `runGit()` swallows failure and falls back to the caller's `cwd`, so a transient git
failure silently points the config at the wrong directory and module switches drift with cwd.

Requirement: resolve the configuration root once per session and reuse it. Invalidate on
`sessionEpoch` change (already the contract for session-scoped caches) and when the working directory
changes within the same session. A resolution that cannot be established must be distinguishable from
"resolved to this directory" — runtimes reading the config should see the difference, not a silent
cwd fallback. Cache is per runtime, not process-global, so a lane/worktree session resolves its own
main checkout.

## 2. Task exit has no machine check (P1)

Every rule about finishing a task — merge into main, `task.py archive`, `git worktree remove`,
`git branch -d` — lives only in the AGENTS.md managed region. No code verifies it, so abandoned
worktrees accumulate silently. `task.json` already records `branch` and `worktree_path`, and
`/Coworkflow:lanes` already reads task state.

Requirement: when the lanes command renders, it reports the task's exit state — branch merged into
the base branch (and how many commits ahead it still is), whether the worktree still exists, whether
the worktree has uncommitted changes — and prints the exact cleanup commands only when the safe
preconditions hold. When a precondition fails it states which one and prints no destructive command.
Read-only: it must never merge, archive, remove, or delete anything itself. Do not add a new Git
validator; reuse the existing verified plan/validation helper.

## 3. New modules default on, including new gates (P1)

`isEnabled()` treats only an explicit `false` as off, so a module added by a later version starts
enabled in every existing project. That is right for observations, wrong for anything that can refuse
work: `capacity` blocks a dispatch when its limit is set but the upstream status is unreadable, so a
future gate module would silently begin policing projects that never opted in.

Requirement: separate "a newly added capability starts on" from "a newly added gate starts off".
Module definitions declare what a newly added switch means for them; a project that has never chosen
gets the declared default, while an explicit choice always wins and surviving the round trip is
mandatory. Keep the existing behaviour for the current modules exactly as it is today — this changes
what happens to *future* modules, not to the ones already configured.

## Acceptance

1. Gate evaluation performs no `git` subprocess per event, and a repeated read within one session and
   unchanged cwd reuses the same resolution. A failed resolution is surfaced, not silently replaced by
   the current directory.
2. Cache follows session replacement and cwd change; no cross-session or cross-worktree leakage.
3. `/Coworkflow:lanes` shows exit state for a task and emits cleanup commands only when branch-merged
   and clean-worktree preconditions hold; it emits none when either fails, and it mutates nothing.
4. New-module default is declared per module: a module declaring itself a gate starts off in a project
   that never chose it; existing configured projects are unaffected; an explicit switch always wins.
5. `npm run typecheck` clean and `npm test` green, with focused regression tests for 1–4 driven through
   the production functions, not stubs.

## Out of scope

Any change to native RPC/workflow/usage/lane-artifact behaviour, panel layout or keys, Trellis CLI
assets, upstream packages, global settings, and any automatic merge/archive/cleanup action.
