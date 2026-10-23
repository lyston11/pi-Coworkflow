# Stage 3 — panel, status, role mapping, lanes, and the fixed workflow

Task: `.trellis/tasks/10-20-agent-kinds` · worktree `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds`
Branch `feat/10-20-agent-kinds`. Stage 1 and Stage 2 were already green and were **not** redone.

## Verdict

Every Stage 3 item is implemented and driven through production code. `npm run typecheck` exits 0,
`npm test` is 131/131 with **nothing skipped** (the installed pi-subagents has the public `./agents`
export here, so the registration, collision and panel paths ran against the real owner).

```
$ npx tsc --noEmit     → exit 0, "No errors found"
$ npm test             → tests 131, pass 131, fail 0, cancelled 0, skipped 0, todo 0  (~11.7s)
```

Two independently runnable files cover this stage; both were also run alone:

```
$ node --experimental-strip-types --test scripts/agent-kinds.test.ts          → 21 pass, 0 fail, 0 skipped
$ node --experimental-strip-types --test scripts/agent-kinds-surface.test.ts  → 11 pass, 0 fail, 0 skipped
```

## What changed, and why

### 1. `/Coworkflow:settings` gains the per-kind section

`modules/panel/settings.ts`

- `SettingRow` gains two **optional** gestures: `toggle` (Space) and `adjust(delta)` (←→). A row that
  declares neither behaves exactly as before — Enter only — so every existing row (module switches,
  auto-load, prefix, project limit, maintenance, facts) is untouched.
- One row per kind: `执行者 cw-executor  [x] 开 · 上限 3  <detail>`. Space toggles enablement, ←→ steps
  the limit by 1 (floor 1), Enter asks for a number (empty restores the built-in default). Keys are
  matched with `matchesKey(data, Key.space / Key.left / Key.right)` from `@earendil-works/pi-tui` —
  the same way the model panel matches its own column switch, so the two panels do not invent two
  key conventions.
- Below the rows, the module's own status lines are rendered verbatim (read-only). A kind that did not
  register is therefore never shown as available **in the panel either**, not just in `/status`.
- The panel's own footer line gained `Space 开关 · ←→ 调上限`; nothing else about the layout moved.

### 2. Applying without a restart, and toggling twice

`core/module.ts` + `extensions/coworkflow.ts`

`WorkflowControl` gains four members, implemented on **both** the placeholder control and the real one
(so an early caller gets a defined answer, not a TypeError):

| member | what it does |
|---|---|
| `agentKinds()` | the project's kinds with defaults applied, from the one decoder (`resolveKinds`) |
| `setAgentKind(kind, patch)` | persists one field, leaves the other alone, then **awaits** `syncAgentKinds` |
| `agentKindStatus()` | the module's own status lines |
| `settleAgentKinds()` | awaits the pending reconcile — used by the panel before it builds rows |

`setAgentKind` deliberately **awaits** the reconcile (`await syncAgentKinds(...)`) instead of firing and
forgetting: the panel's status line says `已注册` / `注册失败：…`, and an "applied" message that has not
actually registered the kind is exactly the failure requirement 6 forbids. The settings command handler
awaits `settleAgentKinds()` before opening, so the rows describe the state that exists rather than a pass
still in flight.

Toggling twice is safe for a reason that predates this stage and is now exercised through the panel:
`kindRegistryFor(host).reconcile` disposes before re-registering and leaves an unchanged definition
alone. The new panel test asserts the owner's registry list and the `tool_call` hook count are
unchanged after off→on off→on.

### 3. `/Coworkflow:status` reports registered kinds, or the exact reason

`modules/agent-kinds/index.ts` — `runtimeStatus` now distinguishes **three** "nothing registered" facts
that used to collapse into one sentence:

| state | line |
|---|---|
| child session | `这是子会话：kind 只在主会话注册，本会话不注册也不拦截派单` |
| layer off / session ended | `本会话未加载或已关闭，未注册任何 kind` |
| pass still landing | `注册尚未完成（正在等待 pi-subagents 的运行时 agent 契约），此刻没有任何 kind 可用` |

The first two are recorded on a new `State.skipped` field at the moment the pass decides not to run;
`null` therefore means "a pass was started", which is what makes the pending line honest rather than
guessed. `syncAgentKinds` lost its early `isChild` return for the same reason — a short-circuit could
never record *why*.

### 4. Role mapping — through the existing injection path only

`modules/agent-kinds/defaults.ts` gains `kindRole(kind)`; it is the **one** kind→role table
(`executor → implement`, `auditor → check`), and `BUILTIN_KINDS` gained a `label` (`执行者` / `审计者`)
used by the panel and the lane report.

`modules/subagent-context/index.ts`: `detectRole` gained one extra fallback on the *same* agent-name
matcher chain — `roleOfKind()` resolves `cw-executor` / `cw-auditor` through `kindRole`. No new block,
no new hook, no second injection: `buildPrompt` / `blockFor` / `SECTION` are untouched, so a `cw-*`
child receives the ordinary `Trellis 子任务上下文（role: implement）` section. The test drives the real
`before_agent_start` handler and asserts the injected block is the implement context **and** that there
is exactly one `<!-- pi-Coworkflow:subagent-context -->` block.

### 5. Lane attribution

`core/subagents-workflow.ts` — `NativeRunLink` gains `kind?: string`.

`modules/lane-worktree/index.ts` records it from the **dispatch** at `tool_call` time (the only moment
the caller's own agent choice is observable) via `kindOf(input.agent)`, and passes it to
`recordLaunchLink`. A non-kind dispatch stores no kind at all — an absent field, not `"unknown"`, because
"this was a builtin agent" is a fact and not a gap.

`/Coworkflow:lanes` gained two things: a `按 kind 分组: 执行者（executor） ×1 · 非 kind 派单 ×1 · 审计者（auditor） ×1`
line, and `· kind 执行者（executor）` on each run line that has one. Grouping is a pure function of the
recorded links, so `legacy` pointers (no kind) are counted as `非 kind 派单` rather than attributed.

### 6. `coworkflow.implement-review` follows the same switches

`modules/agent-kinds/index.ts` — `kindWorkflowAgents(host, kinds)` returns the step agents the fixed
workflow should run, taking a kind **only when it is enabled *and* present in the owner's registry**
(reading `kindRegistryFor(host).registered()`, i.e. what actually registered, not what the config says).
An enabled-but-unregistered kind is skipped on purpose: handing it to the workflow would fail the launch
with `Unknown agent`, which is a worse answer than the built-in pair.

`core/subagents-workflow.ts` — `PreparedWorkflowContext` gains optional `implementAgent` /
`reviewAgent`, and `resolveImplementReview` uses them as *defaults*: an explicit
`args.implementAgent` / `args.reviewAgent` still wins, and a prepared name goes through the same
`AGENT_RE` / length / equality checks as a caller-supplied one (asserted in the test with
`"cw executor; rm -rf /"`).

`modules/subagents/index.ts` — a small `withKindAgents(host, root, plan)` wraps every `RunPlan` the module
hands to `resolve` (`schedule`, and both places in the run command that set `registered.prepared`). The
run command also awaits `syncAgentKinds` before the spawn, so one toggle cannot leave the workflow using
the previous pair. `schedule()` gained a `host` parameter (it needed the registry); all three call sites
were updated.

### 7. Config shape

`core/config.ts` — `ResolvedAgentKind` gains `label`. `parseAgentKinds` and the write path were not
changed: unknown kinds are still preserved, unreadable fields still fall back to the built-in default,
and `setAgentKind` keeps an absent field intact (`{ ...previous }`), so toggling `enabled` never resets
`maxConcurrent` to its default and vice versa (`null` explicitly restores the default).

`extensions/coworkflow.ts` — an `agentKinds` block was already preserved across `/Coworkflow:init`
(Stage 1); `setAgentKind` writes through `writeConfig` the same way `setSubagentConcurrency` does.

### 8. Docs

- `README.md`: command table (settings / lanes), the module table (`agent-kinds` row, `subagent-context`
  role row), a new **子 agent 类型（agent kinds）** section (config shape, why the event contract,
  what the gate guarantees vs. what is only prompt guidance, role mapping, workflow following, toggling),
  the settings-panel key table (`Space` / `←→`), a panel excerpt, the `subagent-context` role-source
  row, the `lane-worktree` attribution and grouping lines, and the directory tree.
- `.trellis/spec/frontend/subagents-integration.md`: new **Agent kinds** section (ownership,
  registration mechanism and why not `registerRuntimeAgent`, parent-session-only gate, count from the
  public fleet projection with "unknown is not zero", both limits, one kind→role table, lane attribution,
  honest degradation) plus a short addition to the UI-compatibility paragraph.

**One caveat about that spec file.** `.trellis/` is **untracked** in this repository (the git index has
two `.trellis` paths and neither is the spec tree), and this worktree only carries `.trellis/tasks/`.
The spec therefore exists only in the main checkout, which is read-only for me. I wrote the updated copy
to `.trellis/spec/frontend/subagents-integration.md` **inside this worktree** (a fresh untracked file,
copied from the main checkout and then extended), so the parent can move it into place. If the intended
home is the main checkout's untracked spec tree, that is a parent action.

## Verification actually run

| command | result |
|---|---|
| `npx tsc --noEmit` | exit 0, no output |
| `npm test` | tests 131 · pass 131 · fail 0 · skipped 0 |
| `node --experimental-strip-types --test scripts/agent-kinds.test.ts` | 21 pass |
| `node --experimental-strip-types --test scripts/agent-kinds-surface.test.ts` | 11 pass |
| `node scripts/verify.ts <tmp> settings DOWN… SPACE` | row flipped, `agentKinds.executor.enabled: false` written |
| `node scripts/verify.ts <tmp> settings DOWN… RIGHT` | limit stepped, `agentKinds.auditor.maxConcurrent: 3` written |
| `node scripts/verify.ts <tmp> settings` (no bus) | panel shows `x agent-kinds: 宿主没有暴露进程内事件总线…`, no kind as registered |
| `node scripts/verify.ts <tmp> Coworkflow:status` | `x agent-kinds: …事件总线…` + `未注册任何 kind…会被拒绝` |
| `PI_SUBAGENT_CHILD=1 … Coworkflow:status` | `agent-kinds: 这是子会话：kind 只在主会话注册…` |

The last three were run with the extension loaded in a temp project through the shipped harness, with
`PI_SUBAGENT_CHILD` unset/inherited as appropriate — the worktree's own environment has
`PI_SUBAGENT_CHILD=1` set, which is why every harness call is spelled out above.

## New tests (`scripts/agent-kinds-surface.test.ts`, 11)

All drive production entry points; the registration is the installed owner's own `registerAgent` behind
its own event listener, so a second-toggle collision would be caught by the owner rather than by an
assertion written to match this package.

1. **panel: Space toggles a kind, ←→ steps its limit, and neither needs a restart** — loads the real
   extension in a temp project, opens the real `SettingsPanel` over the real `controlSurface()`, focuses
   the `cw-auditor` row with real Down keys, presses `" "` and asserts the **config file** contains
   `enabled: true` and the **owner's registry** contains `cw-auditor`; presses Right/Left and asserts the
   resolved limit; then toggles twice and asserts the registry and the `tool_call` hook count are
   unchanged and no `注册失败` line appeared.
2. **status: a colliding kind is reported as failed, and only that kind is affected** — a pre-existing
   `cw-auditor` registered by the project; enabling it via `setAgentKind` returns `注册失败 …
   collides with runtime agent 'cw-auditor'` and `cw-executor` is still reported as registered.
3. **workflow agents: a kind stands in for a step only when it is enabled and registered** — `{}` before
   registration, `{ implementAgent: "cw-executor" }` after, `{}` again after disposal, and only the
   enabled-and-live kind replaces its step.
4. **workflow: a prepared context hands its kind agents to the resolver; public args still win** — script
   text contains `agent: "cw-executor"`, the unset step keeps `trellis-check`, an explicit arg wins, and
   an injected prepared name is validated (`"cw executor; rm -rf /"` → error).
5. **roles: a kind's agent name resolves to the same Trellis role as a trellis-\* agent** — both session
   name shapes (`cw-executor: …`, `subagent-cw-executor-run-1-0`), the existing `trellis-*` names still
   work, `worker` / `cw-unknown` get none, and the mapping equals `BUILTIN_KINDS[].role`.
6. **roles: the injected block for a cw-\* child is the implement/check context, not a second block** —
   real `before_agent_start`, asserts `role: implement`, the manifest's spec content, exactly one block.
7. **lanes: the dispatch's kind is stored on the link, and a non-kind dispatch stores none** (pure).
8. **lanes: kind attribution comes from the dispatch, read at tool_call time** — production `tool_call`
   + `tool_result` hooks, three dispatches, exact `[runId, kind]` triples.
9. **lanes: /Coworkflow:lanes groups the task's runs by the recorded kind** — runs the real command and
   asserts the grouping line and the per-run `· kind 执行者（executor）`, and that the non-kind run has
   no `kind`.
10. **panel and status: no compatible contract means no kind is shown as registered, with the reason** —
    host without `events`; the panel detail does not say `已注册到 pi-subagents`, the exact reason is a
    read-only row, and the real gate refuses the declared kind.
11. **status: registered kinds are reported by agent name; declared-but-unshipped kinds are named**.

## Changes to existing files (all additive in behaviour)

- `scripts/agent-kinds.test.ts`: the local `desired()` fixture now includes `label` (type only).
- `scripts/usage.test.ts`: the control stub gained the four new members (type only).
- `scripts/verify.ts`: `settings` accepts `LEFT` / `RIGHT` / `SPACE` so the harness can press the new
  gestures; `UP`/`DOWN`/`ENTER` unchanged.
- `package.json`: `test` runs the new file too.

## Notes, not defects

- **`setAgentKind` is async by contract** (`string | Promise<string>`), because applying means
  re-registering. `SettingsPanel.run()` already awaited `Promise.resolve(action())`, so both forms work;
  the panel test asserts the status line, not the return shape.
- **`maxConcurrent: 0 / -1 / 1.5` are rejected before writing** (`setAgentKind` validates), and an
  unreadable value already on disk still falls back to the built-in default through `parseAgentKinds`.
  A zero-slot kind is therefore not reachable from the panel.
- **A `cw-` name this package does not ship** (`cw-unknown`) is not a kind, is not gated, and stores no
  kind on the lane link — the owner remains the authority on whether such an agent exists.
- **`settleAgentKinds` is awaited by the settings command only.** `/Coworkflow:status` does not await it
  (it is documented as a read-only report, and making its handler async broke two existing tests that
  call it synchronously); it reports `注册尚未完成` instead, which is the honest answer for that
  boundary. The panel — where the rows claim `已注册` — does await.
