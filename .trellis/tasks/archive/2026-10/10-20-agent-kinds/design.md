# Design

## Where kinds live

A kind is project configuration plus a package asset, not a new execution path:

```
.pi/Coworkflow.json
  "agentKinds": {
    "executor": { "enabled": true,  "maxConcurrent": 3 },
    "auditor":  { "enabled": false, "maxConcurrent": 1 }
  }

modules/agent-kinds/
  index.ts                     module definition: register, gate, panel rows, status
  registration.ts              the pi-subagents runtime-agent contract (load, register, dispose)
  defaults.ts                  built-in kind table + asset loading
  assets/executor.md           system prompt per built-in kind
  assets/auditor.md
```

`core/config.ts` owns the shape so the panel, the gate and the setup report read one decoder:
`agentKinds?: Record<string, { enabled?: boolean; maxConcurrent?: number }>` with validation
(positive integer limits, unknown keys preserved).

## Registration

Loading the contract mirrors `core/subagents-workflow.ts`: resolve the installed package directory,
read `exports["./agents"]`, import it by file URL, and use `registerAgentViaEvents` (or `registerRuntimeAgent`
directly when the owner export exposes it). This keeps one discovery path for "find the installed
owner", rather than a second copy in a new module.

Two facts from the installed owner that shape the design:

- names must not collide with builtins (13 names, including `worker`, `reviewer`, `delegate`), hence the
  `cw-` prefix;
- registration is a **process-local event** handled by the owner in this Pi process, and it returns a
  `dispose()`. So the module keeps a `Map<kind, Disposable>`, disposes before re-registering, and
  disposes everything on `onSessionEnd`.

The gate runs in the parent session only (`runtime.isChild` false): a kind's system prompt is
irrelevant inside a child, and a child registering agents would leak into its own subtree.

## The gate

`tool_call` handler, same shape as `modules/capacity/index.ts`:

```
event.toolName === "subagent"
  → decode the dispatch: agent name, action, async
  → if the agent name is not one of our kinds: return (unchanged behaviour)
  → kind disabled            → block with "本项目关闭了 <kind>，可用：…"
  → live count(kind) ≥ limit → block with "已达上限 N（当前 M 个运行中）"
  → else return
```

The live count comes from the **public** fleet projection (`entries[].agent`), which the client in
`core/subagents-client.ts` already decodes for capacity. Adding a per-agent count reuses that decoder;
it does not add a ledger. A fleet reply that cannot be decoded is treated exactly like an unavailable
capability (requirement 6): refuse, do not guess "probably fine".

Ordering with `capacity`: both handlers are `tool_call` gates. Per-kind admission runs first because it
is the narrower, cheaper check, and because its refusal message is more specific. Both must pass.

## Deferring a decision to the owner

`maxConcurrent` is our policy, not a claim about the owner's own limits. The owner's `concurrency` /
`maxTasks` remain its business; we never mutate them and never present ours as theirs.

## Panel and status

`/Coworkflow:settings` gains one section. Rows are built with the existing helpers, one row per kind:
`[x] 执行者 cw-executor   上限 3`. Left/Right adjusts the limit, Space toggles enabled, Enter applies —
matching the panel's stated key conventions. `/Coworkflow:status` reports the registered kinds and,
when registration is unavailable, the exact reason instead of a list of kinds that do not exist.

## Interaction with the existing modules

- `subagent-context`: `cw-executor` maps to the implement role, `cw-auditor` to check, so the existing
  injection path serves them; the role-matching regex must accept these names.
- `lane-worktree`: records a dispatch as today, plus the kind, so lanes can group by it.
- `subagents` module's `coworkflow.implement-review`: the two agent names become configurable to the
  kind names, so the fixed workflow respects the same switches.
- `capacity`: unchanged; its global limit stays a separate gate.

## Failure modes to design for

- contract missing → nothing registered, panel/status say why, declared kinds refuse dispatch;
- name collision (a project already has a `cw-executor` agent file) → registration fails for that kind
  only, reported, other kinds unaffected;
- toggle during an in-flight dispatch → the gate re-reads state at call time; an already-admitted run
  is not killed, matching how module switches behave elsewhere;
- session replacement → dispose on `session_end`, re-register on the next activation.

## Verification

Focused tests through production paths: registration + dispose + re-register (no duplicates, no
collision), gate refusals for disabled and over-limit kinds with the reason text, both gates ordering,
unavailable-contract degradation, panel row rendering and key handling, and role mapping. Plus the
existing suite. A stubbed registration that bypasses the real contract does not count as coverage for
requirement 6.
