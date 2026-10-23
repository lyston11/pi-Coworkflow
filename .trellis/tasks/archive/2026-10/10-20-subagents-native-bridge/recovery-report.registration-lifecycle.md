# Recovery report — B1 registration/lifecycle

Scope: only the B1 block of `recovery-audit.md`. No B2, no C. Worktree
`/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge`; main checkout and the
installed pi-subagents package are untouched; no `git commit`/`push`/`merge`, no task
status change, no real-project init.

Authoritative stage handoff: `.trellis/tasks/10-20-subagents-native-bridge/B1-handoff.md`.

## Audit item → resolution

| # | Audit finding | Resolution | Where |
|---|---|---|---|
| 1 | `reportRegistrations` calls `sendMessage` for passive error, violating the PRD | Deleted. Failure is stored on the registration set and rendered by `runtimeStatus()` into `/Coworkflow:status`. `sendMessage` now only answers explicit commands (`init`, `status`, `run`); `sendUserMessage` still never called. | `modules/subagents/index.ts` |
| 2 | `ensureRegistrations` uses module-global state; `current.sessionId === sessionId` compares a value to itself; same-session callers see a partial set | Replaced by `HOSTS: WeakMap<host, HostState>` + `RegistrationSet{generation, wantsChildren, done}`. Each build holds its own token and re-checks `state.current === token && state.generation === token.generation` after every `await`, disposing whatever it obtained if it lost. Concurrent same-session callers get the same `done` promise. | same |
| 3 | `activate` captures the epoch-0 bridge; primes retain a disposed/stale bridge | `bridgeFor(host, runtime)` resolves `runtime.sessionEpoch` at call time; observers and the command both use it. Handlers re-check both gates at fire time. | same |
| 4 | Child requirement registered even when the session is disabled / `subagent-context` off | `schedule` gates on `runtime.enabled && moduleEnabled("subagents")` and builds the child requirement only when `moduleEnabled("subagent-context")`; `wantsChildren` is part of the set identity, so flipping the switch rebuilds rather than keeping the old answer. | same |
| 5 | Off must withdraw resources; re-enable must restore without reload | New `WorkflowModule.onRuntimeChange` is called from `refreshSession`, `session_start` (after identity update), `/Coworkflow:start`, and `WorkflowControl.setSwitch`. `subagentsModule.onRuntimeChange` → `schedule` → `withdraw()` or rebuild. | `core/module.ts`, `extensions/coworkflow.ts`, `modules/subagents/index.ts` |
| 6 | Real `pi.on` may return `void`; A's `subagent-context` deleted its registration and re-added a new permanent handler each session, retaining the old callbacks | `REGISTRATIONS` is now `host → { runtime, off }`. `activate` on a known host refreshes `runtime` and adds no handler; `onSessionEnd` keeps the entry when `off === null`. A's handler body untouched. `subagents` tracks `permanentListener` and does not re-attach observers after a session it could not clean up. | `modules/subagent-context/index.ts`, `modules/subagents/index.ts` |
| 7 | Session/identity ordering | `session_start` already moved the epoch first (A). B1 adds `notifyRuntimeChange()` **after** epoch/sessionId/cwd/load-state/`ensureRuntime`/`activateSession`, so registration always uses the new id. | `extensions/coworkflow.ts` |
| 8 | Incidental assumption that `tool_call` cannot be async | Not introduced anywhere in B1; the reconciliation is a promise but no gate depends on it being synchronous, and `admitSync` is left for C1 to replace. | — |

## Host API actually relied on (read, not guessed)

- `docs/extensions.md:59,98,236,265` — `pi.on()` returns an unsubscribe function; start
  long-lived resources from `session_start`; close from an idempotent `session_shutdown`;
  `ctx.sessionManager` is the session-scoped handle.
- `dist/core/extensions/types.d.ts:1187-1190` — `on("session_start" | "session_shutdown"
  | …, handler): () => void`.
- `dist/core/extensions/loader.js:213` — the unsubscribe is composed at registration time;
  it is not guaranteed to exist for every host implementation, which is why both shapes
  are handled.
- `pi-subagents/src/workflows/workflow-resources.d.ts` — `registerWorkflowResource`
  is session-scoped, the extension owns `dispose()`, and the resource is only reachable
  through `resolveWorkflowResource(name, args, sessionId)`.
- `pi-subagents/src/shared/required-child-extensions.d.ts` —
  `registerRequiredChildExtensions({sessionId, extensions, requireForAllRunners})`,
  resolved back via `resolveRequiredChildExtensions(sessionId)`.

## Checks run

```
npm run typecheck   → passed (tsc --noEmit, no output)
npm test            → 61 tests, 61 pass, 0 fail
```

Files added to the suite: `scripts/runtime-lifecycle.test.ts` (11 tests, all executed
against the real extension factory + real modules, temp roots, both `on` shapes,
`void`-returning host included, no child launches).

Unsatisfied requirements in this stage: none in the B1 list. Everything else in
`recovery-audit.md` (B2 protocol/workflow validation, C1/C2 consumer migration) is
untouched and still open, as instructed.

Residual risk worth knowing, not a defect: on a host whose `on` returns `void`, the
subagents observers and the child injector remain attached for that host's lifetime;
both are gate-checked per event, so the cost is a no-op call, not a behaviour leak.
