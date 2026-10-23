# Stage A handoff — runtime contract owner

Baseline: `658708e`. Worktree: `/Users/lyston/PycharmProjects/wt-10-20-subagents-native-bridge`
(branch `feat/10-20-subagents-native-bridge`). No commit, no push; main untouched.

## What changed

### 1. Division counting and its nudge are deleted (not disabled)

`modules/agents/index.ts`
- `watchDivisionOfWork`, `NUDGE_MIN_TOOL_CALLS`, `NUDGE_MIN_FILES`, `WRITE_TOOLS`, `PATH_RE`, `pathsIn()`
  removed. `agentsModule` has **no `activate`** any more; the module is install-only.
- Title no longer advertises a measurement.
- No `sendMessage`/`sendUserMessage` call remains in this package's runtime for passive status.

`modules/agents/assets/main-AGENTS.region.md`
- The "≥12 次工具调用 / ≥4 个文件" threshold paragraph and the "`agents` 模块会数这个" claim are gone.
- Replaced with judgement-based guidance, plus two new bullets required by the design: named
  workflows express multi-stage work; a single bounded child is fine for one step, and child count /
  parallelism follow upstream capacity + the project's concurrency ceiling.
- The `<project_instructions>` bullet now says **only the managed region** is stripped, not the whole
  container, and "其它 agent 默认不注入" is corrected to "gets the child guide, minus role context".

### 2. Child prompt injection: idempotent, generic-safe, region-scoped

`core/trellis.ts`
- New sentinels: `MANAGED_REGION_START/END` (shared with the agents module — single owner for the
  agent-region contract), `CHILD_BLOCK_START/END`.
- New `stripManagedRegion(text)`: removes only the region between the sentinels. `AGENTS.md` outside
  the region (build commands, conventions, Trellis block) survives.
- New `stripManagedRegionFromPrompt(prompt)`: same, per `<project_instructions>` container; an emptied
  container is dropped whole, an untouched container is returned byte-identical.
- New `stripOwnInjection(prompt)`: removes a prior child block, including legacy blocks written
  without the end sentinel (block was always appended last, so the tail is taken).
- `stripProjectInstructions` **deleted** (it removed project instructions wholesale). `renderInjection`
  **deleted** (the block is now built by its owner, `modules/subagent-context`).

`modules/subagent-context/index.ts` — rewritten around Pi's documented hook contract
(`docs/extensions.md`; `before_agent_start` is re-rendered from `event.systemPromptOptions` after each
handler):
- Builds the prompt from **structured options**: `contextFiles` are region-stripped in place,
  the child block goes into one named section `pi_coworkflow_child`. Pi re-renders and diffs sections,
  so run *n* replaces run *n-1*'s block instead of appending. It returns `undefined` (no forced prompt)
  on that path.
- Fallback path for a host without `systemPromptOptions`: strip own block + region from the rendered
  string, then append. Also idempotent.
- **Detection reads the inherited prompt, not the raw one.** The block itself names `trellis-implement`
  and `Active task: …`, so previously a generic child's 2nd run could promote itself to a role. Fixed and
  regression-tested.
- **Every child gets the guide**: project guide when present, otherwise a built-in `GENERIC_GUIDE`
  floor. Unknown role ≠ empty prompt.
- **Task resolution is tri-state**: `task | invalid | none`. The parent's Trellis pointer is used only
  for `none` (and only for `implement`/`check`). An explicit reference that does not resolve to an
  existing directory is reported in the block as invalid with "do not guess", never rebound to the
  parent's task. Existence is checked with `statSync`, because `resolveTaskDir` resolves lexically.
- Gating is at **event time** on both switches: `runtime.enabled` and
  `runtime.control.moduleEnabled("subagent-context")`.
- Registration is per-host (`WeakMap`), `onSessionEnd(host)` unsubscribes it.

`modules/agents/assets/subagent-AGENTS.md`
- Corrected: the managed region is stripped, project content outside it still applies to the child.

### 3. Module gates and session lifecycle (`extensions/coworkflow.ts`, `core/module.ts`)

`core/module.ts`
- `WorkflowModule.onSessionEnd?(host, runtime)` — idempotent per-session teardown.
- `PiRuntimeHost.on` now returns `Unsubscribe | void`.
- `PiRuntimeHost.events?: ExtensionEvents` (`emit` / `on` → unsubscribe) = Pi's shared `pi.events`
  bus. **This is the surface Stage B must use**; it is declared and unused here on purpose.
- `RuntimeContext.sessionEpoch: number` — bumped by the orchestrator on every `session_start` before
  any dependent hook runs.
- `WorkflowControl.moduleEnabled(id)` — the project switch, read live.
- `sendUserMessage` stays declared but documented as never called by this package.

`extensions/coworkflow.ts`
- `ensureRuntime()` replaces the load-time loop. It is the single registration path, called at load,
  from `refreshSession()` (every command), from `session_start`, and from
  `WorkflowControl.setSwitch(id, true)`. Gate = module switch from config **and** project adoption
  (`alwaysActive` modules still register in an uninititialized project so the panels can explain
  themselves). Previously registration checked adoption only, so a module the project switched
  **off** kept a live hook while its artifacts were removed.
- `endSession()` on `session_shutdown` (quit / reload / new / resume / fork): calls `onSessionEnd` on
  every module that has it and drops those ids from `runtimeActive` so the next session re-registers.
  Modules without `onSessionEnd` keep their registration (one ledger per host is deliberate).
- `session_start` updates `sessionEpoch` **first**, then session id + cwd, then re-resolves and
  registers, so identity is correct before any dependent hook runs.
- The factory clears `runtimeActive` / `sessionActivated` / `runtimeErrors`, since a fresh factory call
  is a fresh extension runtime.
- `setSwitch` returns `（本会话已生效）` for an on-switch instead of "restart the session"; off needs no
  teardown because every hook reads the switch live.
- `runtimeReport()` now distinguishes "project not initialized" from "module switched off".

`modules/capacity/index.ts`, `modules/lane-worktree/index.ts`
- Both read `runtime.control.moduleEnabled(<own id>)` at event time, so switching the module off in the
  settings panel actually stops the gate / the lane recording even though the listener stays attached.

`README.md` — the measurement section, the `agents` module row, the stripping table, the
unknown-agent row, the multi-stage bullets and the test-coverage paragraph are updated to the new
behaviour (stripping is region-scoped, generic children get the guide, no counter).

## API surface changes Stage B/C must know

```ts
// core/module.ts
interface WorkflowModule { onSessionEnd?(host, runtime): void }        // new
interface PiRuntimeHost {
  on(event, handler): Unsubscribe | void                               // return type widened
  events?: { emit(channel: string, data: unknown): void;
             on(channel: string, handler: (data: unknown) => void): Unsubscribe }  // new
  sendUserMessage?                                                     // declared, never used by us
}
interface RuntimeContext { sessionEpoch: number }                      // new
interface WorkflowControl { moduleEnabled(id: string): boolean }       // new
```

```ts
// core/trellis.ts
+ MANAGED_REGION_START / MANAGED_REGION_END / CHILD_BLOCK_START / CHILD_BLOCK_END
+ stripManagedRegion(text): string
+ stripManagedRegionFromPrompt(prompt): string
+ stripOwnInjection(prompt): string
- stripProjectInstructions(prompt)      // deleted with the whole-container strip
- renderInjection(role, ref, ctx, guide) // deleted; modules/subagent-context owns its block
```

```ts
// modules/subagent-context/index.ts
+ SECTION = "pi_coworkflow_child"
+ TaskResolution = { kind: "task" | "invalid" | "none" }
+ taskReference(...), resolveChildTask(root, sessionName, ...texts)
  detectRole(...), detectTaskDir(...)   // detectTaskDir removed; resolveChildTask replaces it
```

Notes for Stage B:
- Register the workflow resource and the RPC client on `host.events`; nothing in this stage caches a
  session-scoped host object, and `runtime.sessionEpoch` is the "another session started" signal.
- Any resource/disposer a module acquires must be released in `onSessionEnd`, and `activate` must stay
  idempotent because `ensureRuntime()` can call it after load.
- Do not reintroduce a passive custom message with `display: true` outside an explicit command
  response, and never call `sendUserMessage` for status.

## Verification (all in this worktree)

```
npm run typecheck   → tsc --noEmit, no errors
npm test            → 21 tests, 21 pass, 0 fail
```

New/rewritten tests in `scripts/test.ts` (obsolete nudge tests removed):
- `trellis: only the managed region leaves the project's own instructions`
- `subagent-context: repeated runs add one block, not one per run`
- `subagent-context: a generic child still gets guidance, and keeps the project's instructions`
- `subagent-context: a project without its own guide still gets the floor`
- `subagent-context: an invalid task reference is reported, never rebound to the parent`
- `subagent-context: the module switch and the session switch are both live`
- `subagent-context: a host without structured options gets an idempotent prompt` (incl. the
  generic-child-does-not-self-promote regression)
- `subagent-context: a finished session releases its hook`
- `agents: the division measurement and its nudge are gone`
- `lifecycle: a child injects, and a finished session releases the hook` (real extension factory)
- `lifecycle: a project that switched the module off registers nothing`
- `lifecycle: turning the layer on registers hooks without a reload`

Manual smoke (`scripts/verify.ts` against throwaway temp repos only, never a real project init):
init/status/child-inject (role, generic, invalid ref)/subagent-call (0 user-role messages)/lane-record/
settings panel/panel — all as expected.

## Residual risks / open items for later stages

1. `capacity` and `lane-worktree` still read pi-subagents' private run records
   (`core/pi-subagents.ts`, `core/capacity.ts`) for counting. That is Stage C's migration to native
   status/cost; this stage only made their module gates live.
2. `scripts/verify.ts` and `scripts/test.ts` share one process env; a shell that already has
   `PI_SUBAGENT_CHILD` / `PI_SESSION_ID` set makes the harness behave as that child. The tests are
   isolated (they set/restore what they need); the manual smoke above used `env -u …`. Worth pinning
   in a Stage C harness cleanup, not a product bug.
3. `modules/panel/models.ts` still has its own `refresh()` and usage aggregation; untouched here by
   design (Stage C owns the usage migration).
4. Instance-level `alwaysActive` in an uninitialized project is preserved behaviour, not a new
   decision: `/Coworkflow:settings` in a non-adopted project still exists in order to refuse.
