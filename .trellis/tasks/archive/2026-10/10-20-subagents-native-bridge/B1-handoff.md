# Stage B1 handoff — lifecycle fixes

Worktree: `/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge` (branch
`feat/10-20-subagents-native-bridge`). No commit, no push, no task-state change, main
checkout untouched. Resumed from the timed-out bridge code (B2 partially written) and
repaired only the lifecycle layer from `recovery-audit.md` B1. Nothing was restarted.

## What changed

### 1. Passive message removed; status is stored and read on demand

`modules/subagents/index.ts`
- `reportRegistrations()` is deleted. A registration failure used to call
  `host.sendMessage({ customType: "pi-Coworkflow", display: true })` from a lifecycle
  hook — a message that starts a turn for a fact the model never asked for.
- It is now stored on the host's registration set (`failure`) and rendered by the new
  `WorkflowModule.runtimeStatus(host)`, which `/Coworkflow:status` appends to its
  `[runtime]` block. The explicit `/Coworkflow:run` command still answers in words,
  because that answer *is* the command's response.
- Grep result: `sendMessage` now appears only in the `/Coworkflow:init`,
  `/Coworkflow:status` and `/Coworkflow:run` command handlers. `sendUserMessage` is
  still never called anywhere in the package.

### 2. Per-host registration state instead of module globals

`modules/subagents/index.ts`
- Module-level `registrations` / `registrationsInFlight` / `sessionHookHost` /
  `sessionCleanups` / `runCommandRegistered` are gone. State lives in
  `HOSTS: WeakMap<PiRuntimeHost, HostState>`:
  `generation`, `current: RegistrationSet | null`, `listeners`, `observersAttached`,
  `permanentListener`, `runCommandRegistered`.
- A `RegistrationSet` carries `sessionId`, `generation`, `wantsChildren`, the two
  handles, `failure`, and `done: Promise<void>`.
- `withdraw(state)` disposes both handles, nulls them, and bumps `generation`. Every
  in-flight build holds its own token and checks `state.current === token &&
  state.generation === token.generation` after each `await`; a build that lost that
  race disposes whatever it just obtained. That is the "late completion after
  disposal/replacement" guard — the old `current.sessionId === sessionId` compared a
  value to itself and could never fail.
- `schedule(state, runtime, explicitSessionId?)` is the single reconciliation entry
  point: it reads both live gates (`runtime.enabled`, `moduleEnabled("subagents")`),
  compares with the current set (including `wantsChildren`), and either withdraws,
  returns the existing/in-flight `done`, or builds a new set. Same-session concurrent
  callers await the same promise instead of observing a half-built set.
- `/Coworkflow:run` awaits `schedule(...)` with the session id from its own command
  context and then reads `state.current`; it never builds a registry of its own and
  never falls back to a script/CLI launch.

### 3. Load-time epoch staleness removed

`modules/subagents/index.ts`
- `activate` no longer captures a bridge at load. `bridgeFor(host, runtime)` is read at
  call time from `runtime.sessionEpoch`, so the observer listeners and the command use
  the session's current client. The old code primed observations through a bridge
  frozen at epoch 0 while the orchestrator's first `session_start` moved the epoch to
  1, so the primed bridge was already disposed.
- Observation handlers (`agent_end`, and `tool_result` for `tool_name === "subagent"`)
  re-check both gates at fire time, so an unremovable listener is inert rather than
  stale.

### 4. Live off/on withdraws and reinstates the upstream registrations

New `WorkflowModule.onRuntimeChange(host, runtime)` in `core/module.ts`; called by
`extensions/coworkflow.ts` from:

- `refreshSession()` (top of every command and every turn) — unconditional, because
  reconciliation is a comparison, so a switch written by another window reaches this
  session between two `session_start` events;
- `session_start`, **after** `sessionEpoch`/`sessionId`/`cwd` are updated;
- `/Coworkflow:start` after the switch flips;
- `WorkflowControl.setSwitch(id, on)` after the project switch is written.

`subagentsModule.onRuntimeChange` → `schedule`, so:

- `/Coworkflow:start off`, or `subagents` switched off in `/Coworkflow:settings`,
  **disposes** the workflow resource and the child requirement for this session;
- turning either back on **re-registers** them in the same session, no reload;
- `subagent-context` off ⇒ **no** mandatory child requirement (it used to be
  registered unconditionally, which made a project that switched the child guide off
  still refuse any runner that could not load our extension). The declared field
  `wantsChildren` makes flipping that switch rebuild the set instead of keeping the
  old answer.

`onSessionEnd` withdraws the set (not just disposes handles, so a late build disowns
itself), releases the module's own listeners, and disposes the session's RPC bridge.

### 5. `pi.on` returning `void` (real Pi shape) handled everywhere

Read from the installed host: `docs/extensions.md` ("`pi.on()` returns a function that
unsubscribes that registration") and `dist/core/extensions/types.d.ts`
(`on(event, handler): () => void`), plus `dist/core/extensions/loader.js` where the
unsubscribe is built. The declared contract is a disposer, but the module no longer
depends on it:

- `modules/subagents/index.ts`: `track(state, unsubscribe)` pushes a function or sets
  `permanentListener`. `releaseListeners()` processes whatever it can and then sets
  `observersAttached = permanentListener`, so a permanent listener is **not**
  re-attached next session (that would double every observation) and is harmless
  (gate-checked).
- `modules/subagent-context/index.ts`: `REGISTRATIONS` now maps host →
  `{ runtime, off }`. `activate` on an already-registered host **updates the runtime
  reference and adds nothing** — this is what makes repeated activation (a second
  `/Coworkflow:start`, or re-activation after a session the host could not clean up)
  use the live runtime instead of the captured one, without a duplicate handler.
  `onSessionEnd` with `off === null` deliberately keeps the entry: deleting it would
  attach a second permanent handler next session. Stage A's handler body was not
  rewritten; only the registration record around it changed.
- New `PiRuntimeHost.on` return type `Unsubscribe | void` was already in `core/module.ts`
  from A; B1 is what actually honours it.

### 6. Minimal shared API for later stages

```ts
// modules/subagents/index.ts
+ subagentsModule.onRuntimeChange(host, runtime): void      // gates moved
+ subagentsModule.runtimeStatus(host): string[] | null      // stored, read on demand
+ syncSubagentsRuntime(host, runtime): Promise<void>        // awaitable reconciliation
+ subagentsRuntimeSettled(host): Promise<void>              // this host's in-flight build
+ resetSubagentsRuntime(host): void                         // now host-scoped, not process-global

// core/module.ts
+ WorkflowModule.onRuntimeChange?(host, runtime): void
+ WorkflowModule.runtimeStatus?(host): string[] | null
```

No state machine, no new module, no scheduler: `schedule` is a comparison plus a
dispose, and `onRuntimeChange` is the only new hook.

## Exact host API relied on

| Call | Contract used | Source |
|---|---|---|
| `pi.on(event, handler)` | may return the unsubscribe **or** `void`; both handled | docs/extensions.md; dist/core/extensions/types.d.ts:1187-1190; loader.js:213 |
| `pi.on("session_start", (event, ctx))` | `ctx.sessionManager.getSessionId()` is the registration point; fires on startup, reload, new/resume/fork after identity change | docs/extensions.md:59,236 |
| `pi.on("session_shutdown", …)` | fires for quit, `/reload`, session replacement; cleanup must be idempotent | docs/extensions.md:59,265 |
| `registerWorkflowResource({sessionId, definition})` | session-scoped; extension owns `dispose()`; duplicate name in one session throws | pi-subagents src/workflows/workflow-resources.d.ts |
| `registerRequiredChildExtensions({sessionId, extensions, requireForAllRunners})` | session-scoped; `requireForAllRunners: true` refuses non-native runners instead of dropping the extension | pi-subagents src/shared/required-child-extensions.d.ts |

## Verification

```
npm run typecheck   → tsc --noEmit, no errors
npm test            → 61 tests, 61 pass, 0 fail
                      (scripts/test.ts 21, scripts/upstream-bridge.test.ts 29,
                       scripts/runtime-lifecycle.test.ts 11)
```

New file `scripts/runtime-lifecycle.test.ts` (added to `npm test`), all against the
real extension factory and the real modules, temp roots only, no child launches:

| test | what it proves |
|---|---|
| `lifecycle (unsubscribe on/void on): off withdraws the upstream registrations, on reinstates them` | `resolveWorkflowResource(name, args, sessionId)` and `resolveRequiredChildExtensions(sessionId)` are true/1 after `session_start`, false/0 after `/Coworkflow:start off`, true/1 again after `on` — in one session, on both host shapes |
| `lifecycle (…): a replacement session never inherits the old registration` | after `session_shutdown` the old id resolves nothing; the new `session_start` registers for the new id only; a repeated `session_start` stores no failure (no duplicate registration) |
| `lifecycle: the child-side hook is attached once even when the host cannot unsubscribe` | void host: 1 handler; inert while off; still 1 after `session_shutdown` + new session; injects again for the new runtime |
| `lifecycle: a disposable host drops its listeners at session end` | `agent_end` / `before_agent_start` counts drop to 0 |
| `lifecycle: a registration failure is stored for /status, never sent as a message` | pre-holding the workflow name makes the module's own registration fail; `messages` stays empty and `/Coworkflow:status` shows the `x` line |
| `lifecycle: switching subagent-context off drops the mandatory child requirement` | via the real `controlSurface().setSwitch` — 1 → 0 → 1, workflow resource unaffected |
| `lifecycle: a project that switched the subagents module off registers nothing` | 0/0 |
| `subagent-context: activate reuses its listener and reads the live runtime` | void host, double activate ⇒ 1 handler; off ⇒ no section; session end keeps the entry; new activation injects again |

Existing suites still pass unchanged (A's 21 and the bridge's 29), including
`/Coworkflow:run` launching exactly one native spawn.

## Deliberately not done (later stages own these)

- **B2**: `resolveImplementReview` still trusts caller-supplied `worktree`/`mainCheckout`
  (string + suffix check, not realpath/git-worktree membership), the snapshot decoder
  still filters visible nodes without `fleet.topLevelAsyncCapacity.used`, capability
  and cost decoding still defaults malformed values, the subpath resolver still only
  looks in Pi's global npm dir, and the workflow script does not yet pin
  `worktree: false` on both children.
- **C1/C2**: `capacity` / `lane-worktree` / panel usage still read the private run
  records; `admitSync` is still used by the direct-dispatch gate.
- No `git commit`, no push, no task status change, no real-project init/disable test.
- One residual: with a void-returning host the subagents observers and the child
  injector stay attached for the lifetime of that host by design; they are
  gate-checked, so the cost is one no-op call per event, not a behavioural leak.
