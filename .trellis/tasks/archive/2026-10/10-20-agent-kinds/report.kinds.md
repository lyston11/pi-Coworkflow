# Stage 1 report — kinds, config shape, registration contract

Task: `.trellis/tasks/10-20-agent-kinds` · worktree `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds` · Stage 1 only
(`core/config.ts` shape + `modules/agent-kinds/{defaults,registration,assets/*}`).

## Mechanism used, and why

**The documented event `pi-subagents:runtime-agent-register:v1`, invoked through the installed
package's public `./agents` export (`registerAgentViaEvents`)** — not the direct
`registerRuntimeAgent` call.

- Discovery is shared with the workflow resource, not copied: `core/subagents-workflow.ts`'s
  `exportEntry()` now accepts the `./agents` subpath and its private `loadExport()` is exported as
  `loadSubagentsExport()`. Both consumers resolve "where is the installed owner" through one code path
  (`exportEntry` → `exports["./agents"]` → file URL import), so no second discovery copy exists.
- Why the event rather than the direct export: a direct `registerAgent` writes into the owner's global
  registry **whether or not any pi-subagents extension is loaded in this process**. If none is, the
  entry is inert (nothing merges it into an agent list) while this package would report the kind as
  available. The event makes the owner write `request.result` itself, so "no listener" is a fact we can
  report — `pi-subagents is not installed, not ready, or does not support runtime agent event
  registration` — instead of a silent no-op. Requirement 6 (honest degradation) is only satisfiable
  through the event door.
- `./agents` is imported only for the constant and the wrapper, from the installed package directory —
  the same small documented subpath the workflow resource uses. No second runtime is loaded.
- Verified against the installed owner (0.79.1): `registerAgentViaEvents` + its listener rejects names
  colliding with the 14-name builtin table (`worker`, `reviewer`, …) and with existing runtime agents,
  returns a working `dispose()`, and re-registering after `dispose()` succeeds.

## Files

New:

- `modules/agent-kinds/defaults.ts` — built-in kind table (`executor`→implement role, on, limit 3;
  `auditor`→check role, off, limit 1), `agentNameFor`/`kindOf` (`cw-` prefix), `resolveKinds`,
  `unshippedKinds`, `kindSystemPrompt`.
- `modules/agent-kinds/registration.ts` — contract loading (`loadRuntimeAgentContract`), the
  one-disposable-per-kind reconcile (`createKindRegistry`), per-host registry
  (`kindRegistryFor`/`disposeKindRegistrations`).
- `modules/agent-kinds/assets/executor.md`, `modules/agent-kinds/assets/auditor.md` — system prompts as
  editable assets, read through the existing `moduleAsset()` helper (same as the child guide).
- `modules/agent-kinds/index.ts` — module definition: `activate`/`onRuntimeChange` register,
  `onSessionEnd` disposes, `runtimeStatus` reports registered/failed/disabled/unshipped kinds or the
  exact contract failure. Exports `syncAgentKinds()` (awaitable, used by the test) and
  `kindRegistrationPlan()` (the desired set, so a test drives the production plan incl. assets).
- `scripts/agent-kinds.test.ts` — 12 focused tests (see below).

Modified:

- `core/config.ts` — `WorkflowConfig.agentKinds?: Record<string, AgentKindConfig>`, `AgentKindConfig`,
  `KIND_PREFIX`, `ResolvedAgentKind`, and `parseAgentKinds()` validation: unknown kinds preserved (not
  dropped), non-object entries and non-positive/non-integer limits dropped so the built-in default
  applies, whitespace-padded keys rejected.
- `core/subagents-workflow.ts` — `SubagentsSubpath` type + `exportEntry` accepts `./agents`;
  `loadExport` renamed/exported as `loadSubagentsExport` (call sites updated). Behaviour unchanged.
- `modules/index.ts` — `agentKindsModule` added to `MODULES` (after `subagent-context`, before
  `lane-worktree`), so init writes the `agent-kinds` switch like any other module.
- `extensions/coworkflow.ts` — the init write now carries `agentKinds` through unchanged when the config
  already had it. Without this, every `/Coworkflow:init` would silently retract the project's kind
  policies (including kinds this build does not ship), since init rebuilds the file from scratch.
- `package.json` — `scripts/agent-kinds.test.ts` added to `npm test`.
- `scripts/switch-default.test.ts` — one assertion widened: the "newly added module" test hard-coded
  `existing + 2` modules and now compares against the live `MODULES.length`, which is what it meant
  ("the map is complete"). No behavioural assertion changed.

## Registration semantics

- **Idempotent.** Reconcile compares each kind's definition signature; an unchanged kind keeps its live
  registration (no dispose/re-add churn), a changed one disposes **before** re-registering. The owner
  refuses a duplicate name, so the second toggle would otherwise throw a collision error — that path is
  covered by a test that toggles twice and asserts one registration, zero failures.
- **Session end.** `onSessionEnd` bumps the generation (a pass still in flight disowns itself instead of
  registering for a dead session) and disposes every handle; it is idempotent and never throws.
- **Gates.** Both are read at call time: `runtime.enabled` (session switch) and
  `control.moduleEnabled("agent-kinds")` (project switch). Off means dispose, not "leave registered".
- **One kind failing does not stop the others.** A collision is reported as that kind's failure with the
  owner's own message; the rest register.
- **Missing asset** → that kind is not registered and is reported, because an agent with an empty prompt
  looks available.
- **Parent only** (`runtime.isChild` false): a child registering agents would leak into its own subtree.

## Verification (commands actually run)

```
./node_modules/.bin/tsc --noEmit     → clean (no output)
npm test                             → tests 111, pass 111, fail 0 (duration ~11.8s)
node --experimental-strip-types --test scripts/agent-kinds.test.ts → 12 pass, 0 fail
```

Note: this worktree had no `node_modules`, so `tsc` was not on PATH. I linked the main checkout's
already-installed `node_modules` (`ln -s`, gitignored) purely to run typecheck; no package was installed
and nothing outside this worktree was written.

The 12 focused tests drive production code, not stubs:

1. `kinds config` — unknown kind preserved + reported as unshipped; `maxConcurrent: 0` dropped; malformed
   entry and padded key rejected; defaults fill the rest.
2. `kinds table` — names are `cw-` prefixed, kinds map to `implement`/`check`, prompts come from assets,
   `kindOf()` returns null for non-kind and unknown-`cw-` names.
3. `contract: the public ./agents export and its event` — real `exportEntry("./agents")` + import, event
   name equals the owner constant.
4. `contract: no event bus means unavailable` — refusal with a reason, not a silent no-op.
5. `contract: a bus with no owner listening is a refusal` — the "pi-subagents not loaded" case.
6. `registration: reconcile is idempotent…` — first register, second register (no collision), changed
   definition re-registers, dispose/restore, empty set withdraws; each step cross-checked against the
   owner's own `listRuntimeAgentConfigs(pi)`.
7. `registration: a name collision fails that kind only` — a squatter holds `cw-auditor`; executor still
   registers; failure reason is the owner's `collides with runtime agent 'cw-auditor'` text.
8. `module: enabled kinds register…session end withdraws…status` — declared-enabled kinds appear in the
   owner's list, session switch off withdraws, on restores, a second reconcile registers nothing twice,
   double `onSessionEnd` leaves the owner's list empty and status says "未加载或已关闭".
9. `module: a disabled kind is not registered…` — default auditor off is reported as `已关闭`, project
   switch withdraws/restores everything.
10. `module: no compatible contract registers nothing and says why` — no bus: nothing registered, status
    reports the reason, never the word 已注册.
11. `degradation: an installed owner without ./agents` — a project-local pi-subagents whose `exports`
    lacks `./agents`: exact reason surfaced, nothing registered.
12. `module: a declared-but-unshipped kind` — preserved, reported as "本包没有这个 kind", not registered.

Tests 3, 5–9, 12 use the installed owner (skipped with a stated reason where it is absent): the event
listener is the owner's real `registerRuntimeAgentEventListener` from the installed package, and
registration goes through the owner's real `registerAgent` — validation, builtin/duplicate collision
checks and `dispose()` are the installed package's, not re-implemented.

## Not done (Stage 2+), and one decision for the parent

- No gate yet: `tool_call` decoding, disabled/over-limit refusals, fleet-based live count. Not started.
- No panel section, no role mapping in `subagent-context`, no lane kind label, no `subagents` module
  agent-name wiring — all Stage 3.
- **Switch classification.** `agent-kinds` currently declares no `newSwitchDefault`, so an existing config
  gets `on` (like every module today). Once Stage 2 adds the refusal gate, this module *can refuse work*,
  which per `modules/index.ts` should declare `"off"`. Flipping it then would change what a config re-inited
  in between recorded, so the decision belongs before Stage 2 lands; I did not flip it unilaterally because
  it also affects whether acceptance item 1 ("an enabled kind is dispatchable") works without an extra
  init flag. Flagging rather than guessing.
- Existing project configs do not carry an `agentKinds` key; built-in defaults apply (executor on,
  auditor off), which is what the panel and the gate will read.
