# Execution and acceptance

- Parallel read-only audits completed: outputs 80298506-f5dc-4528-b60d-64237fef26bb and 182b263b-a7b4-460e-92a7-16e93fa35359 under the session subagent-artifacts directory.
- Fresh SDK host probe confirmed coworkflow.dispatch is registered and active; no registration repair is warranted.
- Implement the two scoped child tasks in their own worktrees. Child reports must distinguish code evidence, host-test evidence and actual child execution.
- Integrate reviewed commits into this task's integration worktree. Run typecheck and affected suites; use one SDK integration probe against the current package to exercise background RPC dispatch, capacity waiting, context, completion and dependent continuation.
- Update relevant specs and task evidence, merge through the main session, archive, then remove only clean merged worktrees and branches.

Continuation on 2026-10-25: recovered Pi session `01a16783-4168-71e9-a4ab-bb92202b8adb` and both completed implementation lanes. The integration worktree moved to `/private/tmp/wt-10-25-dispatch-integration` to fit this session's writable roots. This Codex session has no Pi `subagent` tool, so the parent performed the final audit, the two-line closed-gate reporting fix, and the reusable native verification harness. Prior implementation work was reused, not repeated.

Native verification now lives in `scripts/verify-dispatch.mjs` (`npm run verify:dispatch`). It isolates the Pi agent directory, loads the build under test, launches actual detached children through public RPC, and uses a local deterministic provider to inspect final system messages. This replaces the non-repeatable scratch probe while preserving real lifecycle and worktree execution. External model behavior is not part of this mechanical acceptance test.
