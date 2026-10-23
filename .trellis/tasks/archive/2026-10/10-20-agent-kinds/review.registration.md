# Check — registration and honest degradation (PRD 1, 2, 6)

Task: `.trellis/tasks/10-20-agent-kinds` · reviewed tree `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds`
Read-only review. No source file was edited. Installed `pi-subagents` 0.79.1 was read, never modified.

## Verdict

**Cannot pass as-is: 1 blocker.** Registration itself is honest and well built — (a)–(d) and (f) are all
confirmed by driving the production path against the installed owner, and the degradation surface (e)
holds in every shape I could construct. The blocker is one case the design names explicitly and the
implementation does not handle: **a configured agent that holds a kind's name**.

The blocker is exactly the failure this package shipped once already: the panel and `/Coworkflow:status`
say `已注册` / `已注册到 pi-subagents` while the owner throws on every dispatch — including dispatches
that are not kinds at all.

---

## (a) An enabled `cw-` kind is registered and appears in the agent list — CONFIRMED

`modules/agent-kinds/index.ts:305-345` (`schedule`) → `:323` `registry.reconcile(...)` →
`modules/agent-kinds/registration.ts:209` `contract.register(...)` → installed owner's
`registerAgentViaEvents` (`pi-subagents/src/api/agents.js:2` → `src/agents/runtime-agent-events.js`) →
owner's own listener → `registerRuntimeAgent` (`src/agents/runtime-agent-registry.js:325`).

Drove it with the owner's **real** event listener (`registerRuntimeAgentEventListener`, imported from
the installed package) and its real registry view:

```
(a) registered list: [ 'cw-executor', 'cw-auditor' ]
(a) status: [ '  = agent-kinds: cw-executor（kind executor）已注册',
              '  = agent-kinds: cw-auditor（kind auditor）已注册' ]
(a') agent list offered to the model: [ 'worker', 'cw-executor', 'cw-auditor' ]
(a') cw-executor prompt length / mode: 620 replace  desc: Coworkflow 执行者：按派单做完一件已定义的工作并报告事实
```

The agent-list line is the owner's own `mergeRuntimeAgents(pi, discovered)` — i.e. the list the model
actually gets, not our report. Command: `node --experimental-strip-types /tmp/kindprobe/probe.mjs`,
`probe3.mjs`.

## (b) Toggling twice leaves no duplicate and no collision error — CONFIRMED

`registration.ts:195-215`: an unchanged definition keeps the live handle (`:200-203`), a changed one
disposes before re-registering (`:206-209`). Driven through the production `syncAgentKinds`, reading the
owner's list after each toggle:

```
(b) after off: [ 'cw-auditor' ]   after on again: [ 'cw-auditor', 'cw-executor' ]
(b) failures: []
(b) after 2 more toggles: [ 'cw-auditor', 'cw-executor' ]
```

Also confirmed: a changed definition re-registers to exactly one entry; `dispose()` withdraws; an empty
desired set withdraws what is no longer wanted (`probe.mjs`, `probe12.mjs` #1).

## (c) `dispose()` runs on session end and the kind disappears — CONFIRMED

`modules/agent-kinds/index.ts:499-521` bumps the generation, drops the `tool_call` hook, disposes the
bridge and calls `kindRegistryFor(host).dispose()`.

```
(c) after onSessionEnd, owner list: []
(c) status after end: [ '  - agent-kinds: 本会话未加载或已关闭，未注册任何 kind' ]
(c) after re-activation: [ 'cw-executor', 'cw-auditor' ]
```

Two extra facts I checked because a stale registration here is the dishonest-degradation bug:

- **a late landing disowns itself** (session ends while the contract import is in flight):
  `probe7.mjs` → `after end+await, owner list: []`. Correct.
- **hook release is exact**: `activate` twice → 1 `tool_call` listener; `onSessionEnd` → 0;
  re-`activate` → 1 (`probe8.mjs` #2). `index.ts:486-492` guards with `state.listeners`.

## (d) A child session cannot register agents — CONFIRMED

`index.ts:290` (`wanted = !runtime.isChild && …`) and `:302-308` (records `skipped: "child"`).

```
(d) child owner list: []
(d) child status: [ '  - agent-kinds: 这是子会话：kind 只在主会话注册，本会话不注册也不拦截派单' ]
```

## (e) Contract unavailable ⇒ nothing registered, panel + status say why, dispatch REFUSED — CONFIRMED (4 shapes)

| shape | registered | status says | `cw-executor` dispatch |
|---|---|---|---|
| host has no `events` bus | none | `x … 宿主没有暴露进程内事件总线（pi.events）…` + `未注册任何 kind；声明过的 kind 派单会被拒绝` | **REFUSED** (`…没有被注册到 pi-subagents：宿主没有暴露进程内事件总线…这次后台派单被拦下，没有启动任何子进程。`) |
| bus present, no owner listening | none | `x agent-kinds: executor 注册失败：pi-subagents is not installed, not ready, or does not support runtime agent event registration.` | **REFUSED** (same wording) |
| installed owner with `./agents` but no `registerAgentViaEvents` | none | `x … ./agents 没有导出 registerAgentViaEvents；请升级 pi-subagents…` | REFUSED (same guard) |
| enabled kind whose asset is missing | that kind only | `x agent-kinds: auditor 注册失败：本包缺少该 kind 的系统提示资产…` | **REFUSED**, and the other kind still registers |
| healthy, fleet replies | 1 | `= … 已注册` | **ADMITTED** |

Panel, rendered from the module's own lines via the production `buildSettingRows`:

```
(e5) {"label":"执行者 cw-executor","value":"[x] 开 · 上限 3","detail":"注册失败（原因见下方状态行）"}
     {"label":"x agent-kinds: executor 注册失败：pi-subagents is not installed, not ready, or does not support …"}
```

and **non-kind dispatches are untouched** in the degraded state:

```
A dispatch trellis-implement: ADMITTED (unchanged)
A dispatch worker:           ADMITTED (unchanged)
```

Commands: `probe6.mjs` (shapes A/B/C), `probe2.mjs` (e4), `probe18.mjs` (missing asset),
`probe3.mjs` (panel rows). The refusal wording also states that nothing was started, which matters for
the model's next move.

## (f) Prompts come from assets, not hardcoded strings — CONFIRMED (including editability)

`defaults.ts:141-146` reads `moduleAsset(moduleUrl, "./assets/<kind>.md")`; `index.ts:277` puts that text
into the registration definition; `index.ts:268-275` refuses the kind instead of registering an empty
prompt when the asset is missing.

```
(f) prompt === asset bytes: true  len: 620
(f) registration definitions come from assets: true
(f) a module url with no assets -> {"desired":[],"missingAssets":["executor"]}
```

Editability was driven, not assumed: a copy of the module with `assets/executor.md` replaced by
`EDITED BY THE PROJECT` registered exactly that text (`probe8.mjs` #1). No prompt string exists in
TypeScript (`grep -rn "你是本项目的" --include=*.ts .` → no hits).

## (g) A name colliding with a builtin fails only that kind, with a readable reason — PARTIALLY CONFIRMED

- **builtin name (e.g. `worker`)**: confirmed against the owner's own `assertNoBuiltinCollision`
  (`runtime-agent-registry.js:275,333`):
  `Runtime agent 'worker' collides with builtin agent 'worker'.` — and `cw-executor` still registered
  (`probe2.mjs` (g)).
- **another runtime agent's name**: confirmed, `Runtime agent 'cw-executor' collides with runtime agent
  'cw-executor' on name or alias 'cw-executor'.` (`probe12.mjs` #1).
- **a project agent file holding the name** — the case `design.md:89` names — **is broken**. See B1.

---

## B1 — BLOCKER: a project agent named `cw-<kind>` makes the panel claim availability while *every*
## subagent dispatch in the session fails

**Reproduction** (`/tmp/kindprobe/probe16.mjs`, `probe17.mjs`):

```
project: .pi/Coworkflow.json  { modules: { "agent-kinds": true } }
         .pi/agents/cw-executor.md  (name: cw-executor, "project owned")
module off -> runtime agents: []            | dispatch-path discovery: fast path, agents: worker,cw-executor
module on  -> runtime agents: ["cw-executor"] | dispatch-path discovery: THROWS:
             Runtime agent 'cw-executor' collides with configured agent 'cw-executor' on name or alias 'cw-executor'.
status:  [ '  = agent-kinds: cw-executor（kind executor）已注册',
           '  - agent-kinds: auditor 已关闭（不注册；派单会被拒绝）' ]
panel:   {"label":"执行者 cw-executor","value":"[x] 开 · 上限 3","detail":"已注册到 pi-subagents"}
```

**Why.** The registration-time check the owner performs
(`runtime-agent-registry.js:333,338`) validates only *builtin* and *runtime* collisions. A configured
(project/user) agent is checked later, at **discovery** time, by `assertNoConfiguredCollision`
(`runtime-agent-registry.js:365-375`) called from `mergeRuntimeAgents` (`:391`) — which **throws** rather
than dropping the entry. And the dispatch path enters that merge whenever *any* runtime agent is
registered (`src/extension/index.js:397-410`, `if (listRuntimeAgentConfigs(pi).length === 0)` fast path
is skipped). The throw is on `deps.discoverAgents(...)` at
`src/runs/foreground/subagent-executor.js:7014`, which is **not inside a `try`** (verified by brace
tracking: the only `try` blocks enclosing depth-1 of `execute` open at 4801 and 6254 and both close
long before 7014). So:

1. **every** dispatch in the session fails, not just the colliding kind — a plain `worker` or
   `trellis-implement` dispatch is broken, which contradicts PRD 7 / "Non-kind dispatches are
   unchanged" (`probe16.mjs` fails the `worker` discovery; `probe17.mjs` shows the module being *off*
   makes the identical project work);
2. `runtimeStatus` (`index.ts:526`) and `panel/settings.ts:316,324` do **not** notice: both read
   `snapshot.registered` / the `已注册` line, which only means "the owner accepted the name". They report
   `已注册到 pi-subagents` while nothing can launch — the precise "gate or panel that reports itself
   active while enforcing nothing" failure this review was asked to hunt;
3. the gate then names the broken kind as available in another kind's refusal
   (`availableKinds`, `index.ts:193-206`: `当前可用的 kind：cw-executor`), telling the model to route
   work to an agent whose dispatch cannot start;
4. `design.md:89` says this case must be "registration fails for that kind only, reported, other kinds
   unaffected". It is neither.

Note the reach is wider than one file: the owner scans `.pi/agents`, `.agents` **walking upward** and
the user dirs (`~/.pi/agent/agents`, `~/.agents`), so a stray `cw-executor.md` in a parent directory or
in the user's home trips the same path.

**Bounded fix directions** (implementation choice belongs to the author; I did not edit):
- Pre-empt the configured-agent collision before registering — the public `./agents` export does not
  expose `mergeRuntimeAgents`, so this has to be a check on the agent directories the owner scans
  (file basename / `name:` frontmatter against `builtinAgentNames()`), reported as **that kind's**
  failure with the same shape as a builtin collision;
- or make the honesty independent of the cause: treat "the owner's discovery contains a configured agent
  with our name" as a contract-level failure (`snapshot.contractFailure`-like), so nothing is registered,
  the panel says why, and the gate refuses the kinds — never `已注册`;
- whichever is chosen, add a regression test with a real `.pi/agents/cw-executor.md` in a temp project
  asserting (i) the colliding kind is reported as failed, (ii) no kind is reported `已注册`, and
  (iii) a non-kind dispatch is still admitted. Today no test creates a configured colliding agent —
  `scripts/agent-kinds.test.ts:337` and `scripts/agent-kinds-surface.test.ts:366` both simulate the
  collision with `owner.registerAgent(...)` (a *runtime* collision), which is a different check.

## B2 — Status line contradicts itself when enabled kinds exist but failed to register

`modules/agent-kinds/index.ts:552`:

```ts
if (lines.length === 0) lines.push(`  - agent-kinds: 没有启用的 kind，未注册任何 agent`);
```

Observed under a bus with no owner listening, where `executor` **is** enabled and deliberately failed:

```
'  - agent-kinds: 没有启用的 kind，未注册任何 agent',
'  x agent-kinds: executor 注册失败：pi-subagents is not installed, not ready, or does not support …'
```

The first line is false and sends a reader after the wrong cause (a project policy problem instead of an
unavailable contract). It fires whenever `registered` is empty — including the contract-unavailable
`failures` path and the missing-asset path. Fix: emit it only when there are genuinely no enabled kinds
(`snapshot.disabled` covers every kind), otherwise let `failures` speak. `probe6.mjs` B, `probe2.mjs` (e3).

## B3 — After the module is switched off mid-session, the panel row stops saying the gate is off

`modules/panel/settings.ts:317-329`. Detail precedence is
`!enabled → registered → failed → status.length === 0 → generic`. In the "off after on" state the status
is a single non-empty line (`本会话未加载或已关闭，未注册任何 kind`), so the row takes the generic branch:

```
module on  -> {"label":"执行者 cw-executor","value":"[x] 开 · 上限 3","detail":"已注册到 pi-subagents"}
module off -> {"label":"执行者 cw-executor","value":"[x] 开 · 上限 3","detail":"已启用；注册状态见下方状态行"}
status: [ '  - agent-kinds: 本会话未加载或已关闭，未注册任何 kind' ]
```

The never-activated case is correct (`probe15.mjs`: `agent-kinds 本层未启用：kind 不注册，也不拦截派单`).
The "off after on" case loses that sentence and keeps `[x] 开`, so the row reads as "on and pending"
while nothing is registered and `tool_call` returns early (`index.ts:368`), i.e. no gating at all.
`probe12.mjs` #2. Fix: branch on the module-off status line rather than on `status.length === 0`.

## B4 — Residual risk: the registry believes its own registration, not the owner's list

`registration.ts:163-235` trusts `held`; a reconcile whose signature is unchanged returns `ok` without
touching the owner (`:200-203`). If the owner clears its registry out of band
(`src/extension/index.js:904` `clearRuntimeAgentsForPi(pi)`, e.g. pi-subagents reloaded alone) without
our `onSessionEnd` running, our next pass does nothing:

```
after out-of-band clear + reconcile, owner: []  status: [ '  = agent-kinds: cw-executor（kind executor）已注册', … ]
```

`dispose()` on the stale handle is a harmless no-op upstream (`runtime-agent-registry.js:344-356`), so the
state is recoverable — but until something forces a real re-registration, status claims `已注册` for a
kind the owner's list does not contain, and the gate would admit it into an "unknown agent" failure.
Requires the owner to clear without a session end we see, so I rate it low, not blocking; the cheap
hardening is to drop trust on a generation bump and verify liveness by re-registering after any
`onSessionEnd`, which the current code already does — the gap is only the "owner replaced its runtime
under us" path.

## Confirmed-correct details worth keeping

- `core/config.ts:60,64,297-341`: `agentKinds` decodes to `Record<string, {enabled?, maxConcurrent?}>`,
  unreadable fields dropped (a `0`/`2.5`/`"yes"` limit falls back to the built-in default rather than
  becoming "refuse everything" or "no limit"), unknown keys **preserved** and reported as
  `unshipped` instead of silently deleted. Verified round-trip: a single-kind panel write does not
  disturb the other kinds' stored values (`probe13.mjs`).
- `core/subagents-workflow.ts:472,474,514`: `./agents` joined the one `exportEntry`/`loadSubagentsExport`
  discovery path — no second copy of "where is the installed owner". Read from the installed manifest
  (`exports["./agents"]` → `src/api/agents.js`), imported by file URL.
- `index.ts:305-345`: a registration pass that lands after its generation moved calls `registry.dispose()`
  and returns, so a session that ended mid-import leaves nothing behind.
- `registration.ts:241,259`: registry keyed by host (not a module variable), so a second session in one
  process cannot have the first one's `dispose()` withdraw its kinds.

## Verification actually run

```
npm run typecheck                                             → clean (no output)
node --experimental-strip-types --test scripts/agent-kinds.test.ts         → 21/21 pass
node --experimental-strip-types --test scripts/agent-kinds-surface.test.ts → 11/11 pass
node --experimental-strip-types /tmp/kindprobe/probe{,2,3,4,5,6,7,8,9,12,13,15,16,17,18}.mjs
```

The probes drive `syncAgentKinds` / `agentKindsModule.activate|onSessionEnd|runtimeStatus`,
`createKindRegistry`, `loadRuntimeAgentContract`, `kindRegistrationPlan`, `buildSettingRows` and the
production `tool_call` hook — against the **installed** owner's real `registerAgentViaEvents` listener
and real `listRuntimeAgentConfigs` / `mergeRuntimeAgents`. No stub registry was used for any claim above.

Not done, deliberately: no full `npm test` (three concurrent runs are waste), no edits, no commit.
