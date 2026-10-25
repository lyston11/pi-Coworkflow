# Repair contracts

## Confirmed defects and bounded decisions

1. Native paused/stopped notices and unknown completion payloads must never satisfy needs. Only explicit successful completion releases a dependency. Both event routes share this classifier; duplicate events are idempotent.
2. Validate self/cyclic dependencies before mutating the queue. An external run completion must trigger fresh admission for waiting work, without treating that foreign run as proof of success or a free slot.
3. Queued launches must honor current dispatch/session/module gates after awaited reads and across lifecycle changes. In-flight old-epoch callbacks cannot mutate or launch into a new session.
4. RPC spawn bypasses tool hooks. Therefore dispatch must also use the existing shared project-capacity bridge (reservation, bind, ambiguous alias hold, terminal release), not only per-kind admission. Unknown spawn outcomes must not be retried or represented as definitely unstarted.
5. Custom kind names, including supported wrapped session names, resolve from live kind definitions. Workflow kind selection uses the resolved role metadata, including overrides. Omitted async is forced true for owned agents regardless of upstream defaults.
6. Active-task parsing ignores documentation placeholders but preserves fail-closed behavior for a real, explicitly invalid task reference. Task context shows an absolute artifact directory so a linked-worktree child reads the parent-owned documents correctly.

## Scope

Two implementation lanes use separate linked worktrees. Context lane owns subagent-context, agent-kinds, their tests and injection guidance. Lifecycle lane owns dispatch and its host-level regressions. Parent owns integration, current template refresh, spec, and real SDK verification. Do not modify upstream or global installations.

Do not build timer-based reconciliation or persistent scheduling. Lost terminal observations are investigated through public lifecycle evidence; no speculative second ledger. Unknown fleet reads remain fail-closed and explicit. Process completion still does not mean parent acceptance.
