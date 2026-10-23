# Execution plan

Serial writers in `/Users/lyston/PycharmProjects/wt-10-20-runtime-hardening`. Each stage leaves the
tree green; the next stage starts only after the previous one reports.

## Stage 1 — config-root resolver (files: core/trellis.ts, core/config.ts, core/module.ts, extensions/coworkflow.ts, focused test)

Add the resolving seam with an explicit unresolved state. Wire `RuntimeContext` to it, replace module
call sites that recompute `configRoot(cwd)` per event, resolve once on `session_start`, invalidate on
epoch and cwd change. Report unresolved state in `/Coworkflow:status`. Test: repeated read within one
session does not re-run git; epoch bump and cwd change re-resolve; git failure yields unresolved, not
the cwd fallback.

## Stage 2 — task exit state (files: modules/lane-worktree/index.ts, its test)

Reuse `planRun`; add the read-only exit block and the precondition logic. Test merged/clean (commands
printed), unmerged (ahead count, no commands), dirty worktree (no commands), missing worktree (states
it), and that the command mutates nothing.

## Stage 3 — new-switch default (files: core/config.ts, core/module.ts, module definitions as needed, setup report, focused test)

Declare `newSwitchDefault` on the module contract with `"on"` as the default so nothing current moves.
Make `isEnabled` consult it only for absent keys. Keep the init pass writing the full map. Test: absent
gate module → off, absent observation module → on, explicit false → off, explicit true → on, and a
written config round-trips unchanged.

## Stage 4 — independent check

Read-only `trellis-check` over the task delta: verify no per-event git subprocess remains on the gate
path, the cache cannot leak across sessions or worktrees, the exit block prints nothing destructive on a
failed precondition, and no current module's effective switch changed. Run typecheck and the full suite
once. Report blockers with file/line and reproduction.

## Parent finish

Audit against the PRD, resolve blockers with bounded follow-up, commit on the task branch, merge into
main after confirming no drift, then archive and remove the worktree and branch — with the same safety
preconditions this task adds a check for. Report cleanup honestly; never force.
