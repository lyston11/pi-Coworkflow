# Review 2 — user-facing surface (PRD §5) and harness honesty

Reviewed snapshot: **9083af5** (fixed). The tracked tree was clean when I started and was
modified under me mid-review (`core/subagents-client.ts`, `core/subagents-workflow.ts`,
`modules/agent-kinds/defaults.ts` — a third `researcher` kind — `modules/subagent-context/index.ts`,
`scripts/agent-kinds.test.ts`), so **every finding below was reproduced against a clean
`git archive 9083af5` export in `/tmp/snap9083`**, driven through production code with a fake
`pi` host (`events` bus, `on`, `registerCommand`, session_start), not by reading assertions.
Anything the writer's in-flight work may already touch is called out explicitly.

Verdict: **blockers** — one dishonest row and one internal lost-update in the panel; the
rest of (a)–(f) confirm.

---

## (a) Panel rows + existing keys — CONFIRMED, with one latency regression

**Rows.** `buildSettingRows` (modules/panel/settings.ts:307–347) emits a `子 agent 类型` header,
one row per resolved kind labelled `${label} ${agent}` with value `[x]/[ ] 开 · 上限 N`
(exactly the shape acceptance 3 asks for), the module's own status lines as read-only rows,
and `（本构建没有内置 kind）` when the table is empty. Verified by opening the real
`/Coworkflow:settings` command handler in a temp project and reading `panel.currentRows()`:
`执行者 cw-executor | [x] 开 · 上限 3`. Row order before it (模块 / 会话 / 子 agent 并发) and
after it (维护 / 状态) is unchanged; the diff adds a section and touches no existing row.

**Existing keys.** `SettingRow.toggle`/`adjust` are optional (settings.ts:35–39) and
`handleInput` only consults them when a row declares them (settings.ts:163–171), so the
pre-existing Enter-only rows keep byte-identical behaviour. The settings panel never had
Tab/Left-Right column switching — that is `/Comodels` (`ModelPanel.handleInput`,
models.ts:247–295), which this task does not touch; `scripts/usage.test.ts` (passes at
9083af5) still drives `\t`, `\x1b[C`, `\x1b[D` and the full thinking list
(`minimal`…`xhigh`) through the production panel, and `historyBlock`/`tableBody` still render
all levels (`thinkingRowsAll`, models.ts:424–472). **No key or layout regression on either panel.**

### FINDING 1 (medium, new in this task) — both panels block 20 s before rendering when the owner does not answer RPC
`registerSettingsPanel`'s handler now awaits `refreshUsage(...)` and
`existingSubagentsBridge(host)?.observe()` (settings.ts:405–406) before showing the panel;
`/Comodels` runs the same `refreshUsage` at its open boundary. Each RPC has a 10 s timeout
(`REQUEST_TIMEOUT_MS`, subagents-client.ts:44) and they are serial, so a session whose event
bus exists but whose owner never replies makes **both** commands take ~20 s to open.

Measured (same host, same temp project, only the git ref changing):

| command | 658708e (baseline) | 9083af5 |
|---|---|---|
| `/Comodels` open | 34 ms | 19 708 ms |
| `/Coworkflow:settings` open | 50 ms | 20 008 ms |

Reproduction: `loadExtension` with an `events` bus and no RPC responder, then
`await commands.get("Coworkflow:settings").handler("", {ui:{custom(){}}})`. Instrumenting the
handler shows `refreshUsage` 19 702 ms → `observe` 10 002 ms → `settleAgentKinds` 3 ms.
The existing tests do not catch this because the degradation test loads **without** `events`
(no bus ⇒ no wait) and the panel test loads with a *fake owner* that answers instantly.
(The 20 s is the honest cost of "unknown is not zero", but the panel's *availability* should
not depend on it: `settleAgentKinds()` alone answers the kind question, and it already
awaits the registration pass.)

---

## (b) No restart needed — CONFIRMED. **FINDING 2 (blocker-class): two key presses in one tick are a lost update.**

**No restart.** In one process: row at `[ ] 开 · 上限 1` → Space → config on disk says
`"enabled": true`, the owner's registry gains `cw-auditor`, the row reads `[x] 开`, the status
line reads `本会话已生效，无需重启`. `/Coworkflow:start on` in a session that was never
loaded also flips the row from `本层未启用` to `注册失败（原因见下方状态行）` and makes the
gate live (0 → 1 refusals) with no reload. Confirmed for both directions.

**No duplicate registration / no collision.** Three off→on cycles of the module switch through
`control.setSwitch`: `tool_call` handlers 4 → 4 → 4 → 4, `Coworkflow:settings` registered once,
no duplicate `registerCommand` name, and after the cycles a disabled kind is still refused
exactly once with the correct reason. Double-toggling a kind (spaced out) leaves exactly one
`cw-auditor` registration and no `注册失败` line, matching `createKindRegistry.reconcile`'s
dispose-before-register + unchanged-signature rules (registration.ts:270–310).

**FINDING 2.** Two gestures delivered before the first `setAgentKind` resolves are both built
from the *same* stale row closure, so the second silently overwrites the first instead of
building on it:

```
limit before: 3
panel: Right, Right   (no wait between)   → limit after: 4   (expected 5)
auditor: off, Space, Space (no wait)      → enabled: true    (expected off)
```

Cause: `toggle: () => control.setAgentKind(entry.kind, { enabled: !entry.enabled })` and
`adjust: (delta) => ... Math.max(1, entry.maxConcurrent + delta)` (settings.ts:335–337) capture
`entry` from the render that preceded the first press; `SettingsPanel.run` fires them
concurrently (settings.ts:176–190) and rows only reload in `io.changed`. A held Space key or two
fast arrows therefore reads as one change — the row is a *policy editor*, so "appearing to work
while doing less" is the failure family this task exists to remove. Fix direction (bounded):
serialize row actions in the panel (an in-flight guard that drops or queues), or read the live
policy at action time rather than from the row snapshot.
Not covered by `agent-kinds-surface.test.ts`, which always `await`s `press()` between keys.

---

## (c) Role mapping through the existing path only — CONFIRMED

`KIND_AGENT_RE = /(?:^|[^A-Za-z0-9])cw-(executor|auditor)(?![A-Za-z0-9])/`
(subagent-context/index.ts:82) feeds `roleOfKind` → `kindRole` (defaults.ts:88 — the single
kind→role table) from `detectRole`'s existing `fromAgent` chain (index.ts:122–134). `cw-executor`
→ `implement`, `cw-auditor` → `check`; `cw-unknown` → `null`; `worker` → `null`.
The block is still emitted by the one `blockFor` into the one named section
(`pi_coworkflow_child`), and the regression test that drives the real `before_agent_start`
handler counts the delimiter once ("one block, not two"). No second injection path exists.

---

## (d) `/Coworkflow:lanes` groups by kind — CONFIRMED

`tool_call` records `kindOf(input.agent)` on the transient target (lane-worktree/index.ts:139)
and on the persisted link (index.ts:161); the report emits
`按 kind 分组: 执行者（executor） ×1 · 非 kind 派单 ×1 · 审计者（auditor） ×1` plus
`· kind 执行者（executor）` per run line, and a non-kind run carries no kind at all
(index.ts:248–267). Confirmed by test 12/12 and by reading the production builder;
`kindLabel` falls back to the bare kind for a name this build does not ship.

---

## (e) `/Coworkflow:status` honesty — CONFIRMED for the two cases that matter, **FINDING 3 for the module-off-at-load case**

- *Enabled kinds failed to register*: `没有已注册的 kind（启用的 kind 都未能注册，原因见下）`
  followed by the owner's own sentence — never "no enabled kinds" (index.ts:551–560). Confirmed
  with a real `executor` failure.
- *Contract unavailable*: `x agent-kinds: <reason>` + `未注册任何 kind；声明过的 kind 派单会被拒绝`.
- *Never names an undispatchable kind*: `availableKinds` filters to
  `snapshot.registered` (index.ts:222–228); with nothing registered the refusal reads
  `当前没有可用的 kind；其他 agent 的派单不受影响`. Confirmed by driving the gate.
- *Declared-but-unshipped* is named as such (`项目声明了 kind X，但本包没有这个 kind 的定义`).

### FINDING 3 (blocker) — with the layer off at load, the kind row claims "enabled, see the status line below" and there is no status line
`agentKindStatus()` returns `agentKindStatus: () => runtimeHost === null ? [] : agentKindsModule.runtimeStatus?.(runtimeHost) ?? []`
(coworkflow.ts:986). When `agent-kinds` is **off in the project config at load**, the module is
never activated, so `STATES.get(host)` is `undefined` and `runtimeStatus` returns `null`
(index.ts:529–531) ⇒ **`[]`**. The panel then has `registered=false, failed=false, layerOff=false`
and falls through to `已启用；注册状态见下方状态行` (settings.ts:334) — while nothing is
registered and no gate is running. Reproduced:

```
config: modules["agent-kinds"] = false, session loaded
agentKindStatus() = []
row 执行者 cw-executor | [x] 开 · 上限 3 | "已启用；注册状态见下方状态行"
tool_call refusals for an enabled kind: 0
```

This is the same defect 9083af5 fixed (`a kind row must not claim a gate that is not running`),
for the *other* trigger: the commit made `layerOff` depend on the report's sentence, and in this
state the report has no sentence at all. `/Coworkflow:status` itself stays honest here — its
generic module line reads `- agent-kinds 未注册（本项目把该模块关掉了）` — so the lie is confined
to the row. Fix direction (bounded): make the row branch on
`control.moduleEnabled("agent-kinds")` / `switches["agent-kinds"]` (both available to
`buildSettingRows` via `control.switches()`) in addition to the report sentence, and have
`runtimeStatus` answer `skipped:"off"` instead of `null` when the module is loaded but gated off.

### FINDING 4 (minor, same trigger) — the "layer off" wording sends the user to a switch that is already on
When the module is **on** but the session is not loaded, the row says
`agent-kinds 本层未启用：…（在上面的模块开关里打开）`, and the panel's module row right above
reads `agent-kinds | on`. The remedy is `/Coworkflow:start`, not the module switch. Two
different causes share one sentence (`本会话未加载或已关闭`, index.ts:542) and the row cannot
tell them apart. Confirmed: session with `autoEnable:false` → row points at the module switch,
which is `on`.

---

## (f) Layer switched off mid-session — CONFIRMED (9083af5 works)

Same process, layer on → `control.setSwitch("agent-kinds", false)` →
row detail becomes `agent-kinds 本层未启用：kind 不注册，也不拦截派单（在上面的模块开关里打开）`,
status becomes `本会话未加载或已关闭，未注册任何 kind`, and the gate refuses nothing (inert, as
designed). The previous `已启用；注册状态见下方状态行` text is gone. Confirmed against the
9083af5 export, i.e. this is the fix working, not a residual finding.

---

## Verification actually run

- `npm run typecheck` at 9083af5 (in the worktree, before the writer moved files) → clean.
- `node --experimental-strip-types --test scripts/agent-kinds-surface.test.ts` at 9083af5
  (in `/tmp/snap9083`) → **12 pass / 0 fail**; `scripts/usage.test.ts` → 6 pass / 0 fail
  (covers Tab / ←→ / full thinking list / chart selection on the untouched model panel).
- Full `npm test` **not** run, per instructions.
- Probes: temp projects loaded through the real extension entry point with a fake `pi`
  `events` bus, driving `buildSettingRows`, the real `SettingsPanel` key handler, the command
  handlers, and the `tool_call` handler chain; each against `/tmp/snap9083` (and `/tmp/snap658`
  for the latency baseline).

## Files this review touched

None in the worktree. Only new files: `/tmp/snap9083`, `/tmp/snap658`, `/tmp/probe-kinds/*`
(throwaway probe harnesses) and this report.
