# Dispatch and injection acceptance — 2026-10-25

Recovered session: `01a16783-4168-71e9-a4ab-bb92202b8adb`.
Integrated implementation: context `73ba40e`, lifecycle `d8ca44b`, `80b7cc2`, `90fad57`, parent tightening `80ebdfa`; final reporting fix `5f1c668`, repeatable native verification `dac9b1b`.

## Accepted behavior

- Dynamic and renamed kinds resolve their declared roles from live definitions; `none` is authoritative. Owned launches explicitly become async even if the upstream default is foreground.
- Documentation placeholders cannot shadow the parent task pointer. Real invalid references stay invalid. Linked-worktree children receive the absolute parent artifact path.
- Only explicit success releases dependencies. Cycles fail atomically; stopped/paused/unknown outcomes never count as success.
- RPC dispatch uses the shared project capacity bridge as well as per-kind admission. Ambiguous emissions remain reserved and are never retried.
- Disabling dispatch prevents new launches but does not lose completion evidence. Old-epoch awaited work cannot start in a new session. Foreign completion prompts fresh admission without inventing capacity.
- Tool result lists agree with queue snapshots after dependency cascades and while the launch gate is closed.

## Evidence

`npm run typecheck`: passed. `npm test`: **335 passed, 0 failed, 0 skipped**.
`git diff --check`: passed.

`node --experimental-strip-types scripts/verify-dispatch.mjs`: passed against installed Pi 1.4.0 and pi-subagents. Its npm alias is `npm run verify:dispatch`.

```json
{"passed":true,"children":4,"initialRunning":2,"initialQueued":2,"contextMarkersPerChild":4,"isolatedWorktrees":true,"modelNetworkRequests":0}
```

The probe starts four actual background processes in four linked worktrees. Submission starts two, queues one for capacity and another for its dependency, and native completion automatically advances both. Every child reaches the local provider with all four sentinels in its final normalized system messages: PRD, design, implementation plan and check.jsonl-referenced spec. The test never reads files on behalf of a child to repair missing context. Successful fixture worktrees are removed automatically.

The last regression was first run against unfixed code: closing the gate returned an empty `failed` list although both the predecessor and dependent were failed. The two-line fix returns the existing snapshot lists on that early-return path; the regression now passes.

## Why the earlier probe was inconclusive

The original scratch probe used the user's global agent directory, whose packages included this repository's main checkout, while explicitly requiring the integration worktree extension too. The saved child block lacked the absolute-directory line present in the integrated implementation and used the old generic-role format. The probe therefore did not establish which implementation produced the final block. Isolation removes that ambiguity without modifying global configuration or upstream code.

The local provider checks `context.messages` system messages because Pi normalizes `context.systemPrompt` before provider calls. Child cwd comes from `before_agent_start`'s `ctx.cwd`, since the process cwd can remain the parent project even for a worktree session.

## Design judgment and limits

The division is sound: the parent chooses work units and accepts results; Coworkflow supplies project policy, pending work and task context; pi-subagents owns process execution and delivery. Process completion is still not review acceptance. A pending queue is session-local and is not recovered after a restart. Admission does not govern other extensions' RPC calls or independent processes.

The native test verifies mechanical delivery using a deterministic local provider. It does **not** prove that a real model will always choose delegation or split tasks well. No call-count reminder, extra runner, retry mechanism or global configuration change was added. Duplicate ambient installations remain a configuration concern; this task establishes an isolated acceptance probe rather than a cross-version singleton mechanism.

## Closeout

Fast-forward integrated into main at `dac9b1b`. All three tasks archived through `task.py archive --no-commit`; the three clean, merged task worktrees and branches were removed without force. Failed diagnostic fixture worktrees were also cleaned after confirming no code changes. Existing Pi sessions require `/reload` to load the new code. No remote push was performed in this continuation.
