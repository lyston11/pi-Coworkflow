# Design

Shared task parsing/validation belongs in core/trellis.ts, consumed by launch placement and child injection. Parent launch text carries the resolved reference so queued work is stable. Revalidate task/worktree at launch instead of caching decisions across task changes. Respect explicit cwd only if compatible with the task and repository. Native per-launch isolation remains supported.

Child binding is retained in native session custom entries (and an in-memory fallback for lightweight hosts), not a second task ledger. Only explicit task instructions may replace a binding. Invalid binding stops tool execution; launch boundaries reject it before spawn.

Runtime kind definitions explicitly inherit project context, without enabling all skills. Existing managed-region stripping remains authoritative.

Task hook verifies branch equality before reuse. Shutdown cannot safely prove native occupancy synchronously, so it releases bookkeeping but retains worktrees for explicit parent cleanup. No polling or new runner.

Dispatch file declarations normalize relative path segments and reject absolute/escaping paths atomically. Root covers the full tree; files: [] remains read-only. Unknown scopes stay parallel with accurate warning coverage.

Expected changes: core/trellis.ts and core/module.ts; modules/agent-kinds, subagent-context, session-worktree, dispatch, worktree; affected tests/native probe; corresponding rendered assets and integration spec.
