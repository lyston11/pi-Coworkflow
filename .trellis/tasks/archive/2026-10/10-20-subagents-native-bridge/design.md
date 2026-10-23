# Native integration design

Approved direction: user messages 336/338 authorize execution of the previously reviewed thin-adapter plan. This document makes that plan concrete; no new product scope is introduced.

## Ownership
- Trellis owns requirements/specs/task identity and task worktree.
- pi-subagents owns execution, workflow child keys, mission persistence, acceptance gates, retained resume, terminal notices, capacity of its own runner and run/usage observations.
- Coworkflow owns bounded public-API adaptation, project policy, role-context construction, and task → mission/run references. No parallel retry/scheduler/lifecycle store.

## Flow
A loaded parent registers a namespaced workflow resource (coworkflow.implement-review) and a /Coworkflow:run command. The command resolves the current valid Trellis task and its approved isolated worktree, then invokes native async RPC spawn with that resource and an explicit mission title/objective. The resource accepts validated bounded data, expands synchronously to two stable steps (implement, review), uses fresh contexts, explicit structured verdicts/acceptance, and stops on failure. Review receives implementation artifact references and output; final output returns native identities and findings for parent acceptance. No automatic merge, retry, or goal/watchdog enablement. Direct model calls can use the same resource only with valid task/worktree data; the resolver must never do I/O or grant arbitrary shell commands.

A request through the existing subagent tool remains supported. Native custom completion details (subagent-notify/details.runs with workflow children/outputs) identify work; observe once without new prompt messages. Command/RPC-started work receives the same native lifecycle. Store task linkage only after a correlated successful receipt; no invented childKey inference. Legacy lane pointers remain readable. Native completion delivery and parent wake stay upstream-owned.

## Public integration boundary
Use pi.events RPC v1 for ping/status/cost/spawn, discover capabilities, correlate UUID replies, bound timeouts, remove reply listeners on success/error/timeout/shutdown/session change, and never retry spawn after ambiguous timeout. Missing status means unavailable, not zero. Prefer event registration for independently installed packages; for workflow resource and mandatory child-extension registration resolve only the installed package's documented exported subpaths, without loading its main entry or installing a second runtime. Read docs/extension-api.md before using signatures. Pin/advertise the capability floor, not just a guessed semver check.

Expose one small typed client per runtime; no process-global cached session client. Current runtime/control interfaces can be extended minimally. Public reads are cached for synchronous rendering, refreshed at session/agent/completion boundaries or panel open, never by render-time filesystem scans/timers. Native cost includes unresolvedAsyncChildren: preserve uncertainty. RPC cost does not provide daily buckets, so retain parent history aggregation and, only when native cost supplies known child sessionFile references, derive bounded child history from those references. Do not invent model attribution or drop the established chart silently.

Project concurrency is a compatibility policy: upstream lacks a documented project override. Preserve the setting and check public async status plus bounded pending launches, clear reservations on results/lifecycle reset and count no management calls. Native workflow execution/child fanout still uses upstream limits. Apply the same project admission policy to Coworkflow's own RPC spawn; do not claim to police arbitrary other extensions' RPC. Explain this boundary. Fail explicitly when a configured limit cannot be evaluated; do not scan upstream temp directories.

## Runtime fixes
Remove division counting/nudges and its generated instructions; replacing it with another custom message is forbidden. Retain explicit delegation roles, state that named workflows embody multi-stage work, and allow bounded direct children.

Build child system prompt idempotently on every before_agent_start. Strip only this package's managed parent-duty region and prior own injection block, not whole project_instructions containers. Always append generic child guidance; add role-scoped task context when applicable. Explicit invalid task references must not silently attach an unrelated parent task. Unknown role means generic guide, not empty prompt. No-task read-only delegation remains possible.

Module gate behavior must follow project switch + session state at event/command time; passive lane observation can remain adoption-gated only when its module switch is on. Register lifecycle cleanup even when disabled. Session start updates runtime identity before dependent hooks; reset registrations/caches on reload/new session. Commands retained after off must refuse, and reenabling should work without restart where host API permits. Keep always-active setup/settings control available.

## Isolation and rollback
Main checkout contains prior approved AI source edits and unrelated untracked Trellis/Pi scaffolding. Save a byte-for-byte source baseline and seed an isolated task worktree with that source. Do not reset, stash-pop, or overwrite main. Writers run serially in this worktree, never main; they do not push or merge. Integration will compare main to the saved baseline before applying task-only changes, preserve unrecognized files, and stop if it drifted. Keep unmerged/dirty worktree on any failure. Never force cleanup.

## Boundaries
One task because the adapter/consumers constitute one atomic migration; stage-specific ownership is serial, not concurrent writers. No changes to upstream installed files. No unrelated UI, worktree hook/YAML, or trust changes. Goal missions/watchdog remain documented opt-in upstream functions.
