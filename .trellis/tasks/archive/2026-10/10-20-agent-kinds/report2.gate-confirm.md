# Stage 2 confirmation report — the per-kind gate

Task: `.trellis/tasks/10-20-agent-kinds` · worktree `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds`
Scope: **confirmation pass on Stage 2 only**. No source file was modified by this pass.

## Verdict

**Every behaviour in the assignment holds. Nothing was changed.** The gate in
`modules/agent-kinds/index.ts` and the per-agent count in `core/subagents-client.ts` behave as
specified when the production entry points (`agentKindsModule.activate`, `agentKindsModule.onSessionEnd`,
`syncAgentKinds`, `capacityModule.activate`) are driven directly against the installed owner's real
registration listener and a scripted public RPC.

## How it was confirmed

The existing suite (`scripts/agent-kinds.test.ts`) is green, but re-running somebody else's assertions
proves only that they still pass. So this pass wrote an **independent probe**
(`/tmp/kinds-confirm/probe.ts`, 527 lines, outside the repo) with deliberately different fixtures:

| difference from `scripts/agent-kinds.test.ts` | why it matters |
|---|---|
| two kinds enabled at once (`executor` + `auditor`) instead of defaults | the "available kinds" list is only meaningful when more than one kind is live |
| config rewritten **mid-session** between dispatches | proves the panel's promised no-restart behaviour, not just the initial read |
| config rewritten **inside the `status` reply**, during the public read | drives the gate's re-read-after-count path, which no existing test touches |
| `sessionEpoch` and `moduleEnabled` mutated **inside** the read | drives the post-await staleness guards |
| foreground (`async: false`) dispatches | the decoder's `async` field is wording, not a bypass |
| the owner's own `listRuntimeAgentConfigs(pi)` read back | proves registration happened *in the owner*, not just in our handle map |
| a pre-existing `cw-executor` registered by the project | drives the collision path end to end and the status line for it |
| `maxConcurrent` values of `0 / -1 / 1.5 / "3" / null` | the invalid-limit fallback, absent from the suite |

Each probe asserts the *reason text* the model would read, not merely `block === true`, because a
refusal with the wrong reason is the failure requirement 6 exists to prevent.

```
$ cd /Users/lyston/PycharmProjects/wt-10-20-agent-kinds
$ node --experimental-strip-types /tmp/kinds-confirm/probe.ts
✔ × 23                       (list below)
ALL PROBES PASSED / EXTRA / CONFIG / COLLISION / MID-READ TOGGLE / EPOCH / CHILD
```

## Behaviour by behaviour

### 1. A disabled kind is refused, naming the kinds that really exist
`auditor` off, `executor` on → `subagent({agent:"cw-auditor"})` blocks with
`本项目在 /Coworkflow:settings 的「子 agent 类型」里关闭了 kind auditor（cw-auditor）。当前可用的 kind：cw-executor；…`
and `没有启动任何子进程`. **0 public RPC reads** were made for the refusal (`requests.length === 0`):
a disabled kind costs nothing and cannot be miscounted.
Also confirmed: a *live* toggle to `enabled: false` on disk produces the same refusal with no reload,
and the reason names `cw-auditor` — not `cw-executor`, which the same write had just switched off.

### 2. An over-limit dispatch is refused with the real limit and occupancy; exactly-at-limit refused, one-below admitted
Limit 2, owner fleet `["cw-executor"]` → admitted. Second live run added → refused with
`并发上限是 2，当前已有 2 个在运行（pi-subagents 公开 fleet 状态）`. A foreground call
(`async: false`) with the same occupancy is refused too. Occupancy of *other* agents
(`trellis-implement`, `worker`) does not consume a kind slot: three live runs, one of them ours, is
one of two and admitted.
Lowering `maxConcurrent` from 3 to 1 on disk mid-session → the next dispatch is refused at 1, without
re-registering or reloading.

### 3. An unreadable or unavailable count refuses rather than assuming room
Three independent unreadable states, all refused, all with `无法确认现在有几个在运行` and the limit,
none of them ever rendering `当前已有 0 个`:

| state | reason |
|---|---|
| `ping.capabilities.fleetStatus` absent | `没有通告 fleetStatus 能力，因此没有公开的 per-agent 活跃条目可数` |
| fleet DTO malformed (`entries:[{key:1}]`) | `fleet 投影不是可解析的 entries/totalActive/omitted` |
| `omitted: 3` (bounded window overflow) | `fleet 投影是有界窗口，还有 3 个活跃 run 不在其中` |

The first probe deliberately reports `live.length === 0` — the owner claims nothing is running, and
the gate still refuses, which is the only way to tell "unknown" from "zero".

### 4. An enabled but unregistered kind is refused
Host without an event bus → nothing registers → `cw-executor` blocks with
`没有被注册到 pi-subagents：宿主没有暴露进程内事件总线（pi.events）…`, and `/Coworkflow:status` reports
`x agent-kinds:` with the same reason instead of listing the kind. With the `auditor` also disabled,
the reason says `当前没有可用的 kind` — an unavailable contract never appears as an available kind.
A project-owned `cw-executor` registered *before* our pass → the owner's own collision error
(`Runtime agent 'cw-executor' collides with runtime agent 'cw-executor'…`) is reported for that kind
and the dispatch is refused; `runtimeStatus` shows `x agent-kinds: executor 注册失败：…`.

### 5. Non-kind dispatches and management calls are untouched
With `cw-executor` **at its limit**, nine calls were issued and all returned `undefined`:
`trellis-implement`, `worker`, `reviewer`, `cw-unknown`, `{action:"status"}`, `{action:"stop",agent:"cw-executor"}`,
`{action:"guide",agent:"cw-executor"}`, `{action:"list"}`, `{}`. **0 public reads** for all nine:
the gate returns before counting, so it is not a tax on every dispatch.
With `capacity` also active, a `trellis-implement` dispatch blocked by the project-wide limit carries
**only** capacity's reason (`本项目（Coworkflow）的子 agent 并发上限是 1…`) and no `kind` text: the kind
gate added nothing to a call it does not own.

### 6. Both limits hold, neither masks the other
Both modules active on one host, three states driven:

| state | outcome |
|---|---|
| kind at 1/1, project 0/5 | per-kind reason: `kind executor（cw-executor） 的并发上限是 1` |
| kind 0/1, project 1/1 (a `trellis-implement` running) | capacity reason: `本项目（Coworkflow）的子 agent 并发上限是 1…`, and no per-kind text — the coarse gate still governs a kind |
| both would block | the per-kind reason wins (narrower, registered first) |
| both admit | `undefined`, dispatch passes |

### 7. The gate runs only in the parent session
`runtime.isChild = true` → dispatch admitted as before, and `syncAgentKinds` registered **nothing**
(`kindRegistryFor(host).registered()` is `[]`): a child neither registers agents into its own subtree
nor polices its own dispatches. Session switch off or module switch off → no policing, **no public
read**, and switching back on restores the refusal with no reload.

### 8. Session end releases the hook; re-activation installs exactly one
`activate` twice in one session → `tool_call` hook count stays `1`. `onSessionEnd` → `0`.
`activate` again (epoch 2) → `1`, and exactly one registration (`["cw-executor"]`). The reinstated
gate refuses again for an occupied kind, and the snapshot from the previous session is not inherited
(no stale "available" survives a session end).

### 9. Two timing paths that only production can expose
- **A dispatch racing the registration pass.** A dispatch issued without awaiting `syncAgentKinds`
  (what a session-start dispatch looks like) still returns `undefined` and the kind is registered
  afterwards: the gate awaited the in-flight pass instead of deciding on a null snapshot.
- **A toggle during the public read.** The config rewritten inside the `status` reply → the *same*
  dispatch is refused (`关闭了 kind executor`); lowering the limit inside the read → the lowered limit
  is what the next dispatch is measured against. A reply that lands after `sessionEpoch` moved, or
  after the module was switched off, is refused (`会话已更换或该层已关闭，未启动子进程`) rather than used.

## Notes, not defects

- `maxConcurrent: 0 | -1 | 1.5 | "3" | null` all fall back to the built-in default (3) rather than
  becoming a zero-slot kind. That is `parseAgentKinds` dropping an unreadable field — deliberate, and
  it means a typo cannot silently disable a kind's launcher.
- `resume` / `append-step` are gated like a fresh dispatch (`decodeKindDispatch` treats them as
  work-starting). Disabling a kind therefore stops a resume of it while leaving an in-flight run
  untouched. That is the design's stated reading of "closing a kind stops new work, not work in
  flight", recorded here because the PRD does not spell out the resume case.

## Verification actually run (this worktree)

```
$ npx tsc --noEmit                      → exit 0, no output
$ npm test                              → tests 120 pass 120 fail 0 skipped 0  (11.6s)
$ node --experimental-strip-types \
    scripts/agent-kinds.test.ts         → tests 21 pass 21 fail 0 skipped 0
$ node --experimental-strip-types \
    /tmp/kinds-confirm/probe.ts         → 23 probes, all passed (7 groups)
```

Nothing was skipped: `pi-subagents` with a public `./agents` export is installed here, so the
registration, collision and count paths ran against the real owner rather than a stub.

## Files changed by this pass

**None.** `git status --porcelain` after the pass shows only the pre-existing Stage 1/2 delta
(`core/config.ts`, `core/subagents-client.ts`, `core/subagents-workflow.ts`, `extensions/coworkflow.ts`,
`modules/index.ts`, `package.json`, `scripts/switch-default.test.ts`, plus the new
`modules/agent-kinds/` and `scripts/agent-kinds.test.ts`). The probe lives in `/tmp/kinds-confirm/`
and is not part of the repository; every fixture it created was a temp directory removed on close, and
every owner registration it made was disposed and cleared from the owner's registry.
