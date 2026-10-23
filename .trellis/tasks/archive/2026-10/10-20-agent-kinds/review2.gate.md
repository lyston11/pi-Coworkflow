# Review 2 — per-kind gate (PRD 3, 4) and the interrupt control path

Snapshot reviewed: `9083af5`, extracted read-only to `/tmp/r2/snap` (`git archive 9083af5`).
The working tree moved to `afb0677` mid-review; every probe below was re-run against the
`9083af5` snapshot (and, where noted, against `HEAD`'s `core/subagents-client.ts` +
`9083af5`'s `modules/` to check whether a later commit changes the answer).

How I drove it: a throwaway harness in `/tmp/r2` (outside the repo) that wires the **production**
`agentKindsModule.activate` + `syncAgentKinds` to a fake `pi.events` bus carrying
(i) the **installed** pi-subagents 0.79.1 owner's own registration listener
(`~/.pi/agent/npm/node_modules/pi-subagents/src/api/agents.js` → `registerAgentViaEvents`),
(ii) `subagents:rpc:v1` `ping`/`status` replies shaped exactly like `src/extension/rpc.js`
`buildFleetStatus` (`{version:1, entries:[{key,agent,startedAt,tokens}], totalActive, omitted,
topLevelAsyncCapacity}`). Real `readConfig` from a temp project root, real gate hook, real bridge,
real `requestStop`/`requestSteer`. Scripts: `/tmp/r2/{gate,a,b,c,d,e,f,h,i,j,k,l,m,n,o,p,q,r,s,t}.mjs`.
Nothing in the repo or in the installed package was modified.

Verification run inside the snapshot: `node --experimental-strip-types --test
scripts/agent-kinds.test.ts` → 22/22 pass. `node_modules/.bin/tsc --noEmit` in the worktree → clean.
(The full suite was not run, per instructions.)

---

## Confirmed working

**(a) A disabled kind is refused, and the refusal costs nothing — CONFIRMED**
`modules/agent-kinds/index.ts:364` (`gate`) → `:405`/`decide` → `disabledRefusal` (`:208`).
Driven: `{agent:"cw-auditor", task:"x"}` with built-in defaults ⇒
`本项目在 … 关闭了 kind auditor（cw-auditor）。当前可用的 kind：cw-executor；… 这次后台派单被拦下，没有启动任何子进程。`
and `h.requests.length === 0` — no public read, no bridge, refused before counting. Swapping which
kind is disabled swaps the named available kind correctly (`cw-auditor` when only auditor is on).
`availableKinds` (`:198`) requires *registered* (owner-accepted), not merely `enabled`, so an
enabled-but-unregistered kind is correctly omitted (`当前没有可用的 kind` when the only other kind
failed to register).

**(b) Over-limit is refused with the real limit and occupancy; exactly-at-limit refuses — CONFIRMED
(static case only; see B1 for the burst case)**
Driven with `maxConcurrent: 2`: 1 live `cw-executor` ⇒ admitted; 2 live ⇒
`并发上限是 2，当前已有 2 个在运行（pi-subagents 公开 fleet 状态）`; one live + two other agents ⇒
admitted (other agents do not consume a kind slot). `>=` is at `index.ts:427`. Raising the limit in
`.pi/Coworkflow.json` to 5 with 3 live admits with no restart; disabling the same kind on disk
refuses on the next call (`policyOf()` re-reads per call, `index.ts:373`).

**(c) Unknown / unavailable / truncated counts refuse instead of assuming room — CONFIRMED**
`core/subagents-client.ts:857` `agentActivity` → `:876` `omitted > 0` ⇒ `unknown`. Driven, all six
refused with a reason that says it could not count and never prints `当前已有 0 个`:
`fleetStatus` capability absent; `omitted: 1`; `omitted: 2`; `omitted: 1` while our kind is at 0;
malformed `entries` (`[{key:1}]`); `fleet.version: 2`; no `fleet` at all; and a `status` RPC that
fails outright (`{success:false}`) ⇒ `unknown` ⇒ refuse. This is the requirement's hardest case done
right: a non-zero `omitted` is treated as unknown, not as a partial count that still fits.

**(d) An enabled-but-unregistered kind is refused — CONFIRMED**
Driven with no `host.events` (contract unreachable) ⇒ refused at `index.ts:405`, reason names the
contract failure and states that admitting would start nothing. Also driven with **no explicit
`syncAgentKinds` call** (dispatch immediately after `activate`, pass still in flight): `await
state.pending` (`:398`) makes the gate wait, so a registerable kind is admitted *and* an
unregisterable one is refused — the gate never judges against a snapshot from before the pass.

**(e) Non-kind dispatches and management calls are untouched — CONFIRMED (single-agent shape only;
see B2 for `tasks`/`chain`)**
With `cw-executor` parked at its limit 1 so any leakage would show, all of
`{agent:"trellis-implement"}`, `{agent:"worker"}`, `{agent:"cw-unknown"}`, `{action:"status"}`,
`{action:"stop", agent:"cw-executor"}`, `{action:"steer", agent:"cw-executor", message}`, `{action:"resume", id}`,
`{action:"list"}`, `{}`, `{agent:"cw-executor", action:"status"}` returned `undefined` and issued
**zero** RPC requests. `decodeKindDispatch` (`:162`) excludes non-`resume`/`append-step` actions
before touching `agent`, which is what keeps a limit from blocking the `stop` that would free the slot.

**(f) Both gates hold and neither masks the other — CONFIRMED**
`capacityModule.activate` + kind gate on the same host: per-kind blocks while
`subagentConcurrency()` has room (per-kind reason wins); global blocks while the kind has room
(`本项目（Coworkflow）的子 agent 并发上限是 1，当前已有 1 个活跃 async run`); both blocking yields the
narrower per-kind reason only (no masking, no double counting — both read the same shared bridge).

**(g) Parent-only, one hook, released on session end, re-installed once — CONFIRMED**
`hooks("tool_call") === 1` after `activate`, still 1 after a second `activate`; child (`isChild`)
untouched; module off untouched; session off untouched; back on refuses again with no reload;
`onSessionEnd` ⇒ 0 hooks and status reports `本会话未加载或已关闭，未注册任何 kind`; re-activation at
`sessionEpoch: 2` ⇒ exactly 1 hook, one registration (`cw-executor`), and the gate enforces again.

**(h) Control path: capability before emission, acceptance ≠ termination, malformed ⇒ protocol — CONFIRMED**
`core/subagents-client.ts:753` `advertises` runs before `send` in `stop` (`:784`), `steer` (`:808`),
`interrupt` (`:832`). Driven: `stop`/`steer`/`interrupt` with `ping.methods` lacking the method, and
with `capabilities[method] === false`, both ⇒ `{ok:false, reason:"unavailable"}` with **0** requests
emitted. Malformed replies — `stop:{}`, `stop:{message}` (no `state`), `steer:{}`,
`steer:{details:{}}`, `interrupt:{}`, `interrupt:{details:{mode:"management"}}` — are all
`reason:"protocol"`, never success. `requestStop` on `{state:"stopping", previousState:"running"}`
reports `已接受停止…的请求（state: stopping）` + `这是「请求已被接受」，不是「run 已经结束」`;
`已停止` never appears in the output (asserted by substring on the joined lines).
`/Coworkflow:lanes stop` refuses a foreign/unknown id locally with 0 RPC requests
(`modules/lane-worktree/index.ts:222` path, driven through the real command handler).
`steer` carries the message only as data (`params: {id, message}`), no interpolation.

---

## Blockers

### B1 (blocker, PRD 3 + acceptance 1) — the per-kind limit has no reservation, so a burst of dispatches all pass

`modules/agent-kinds/index.ts:411-427` reads the count and returns, keeping no reservation; the
count comes from `bridge.agentCount` → `core/subagents-client.ts:1080`, which is a bare public read
over the same serialized queue `admit()` uses — but `admit()` (`:1052`) is what *reserves*
(`settle` → `reservations.set(launchId, {})`, `:1130`). The kind gate never calls `admit`/`hold`.

Driven (`/tmp/r2/e.mjs`, `/tmp/r2/f.mjs`), kind `maxConcurrent: 1`, owner reporting **zero** live runs:
```
race: limit 1, live 0, three concurrent dispatches
  call 1: ADMITTED
  call 2: ADMITTED
  call 3: ADMITTED
  admitted count: 3 of 3, limit was 1     (3 status reads issued — it did count, three times, and
                                           each time the answer was legitimately "0")
sequential: dispatch 1 ADMITTED, 2 ADMITTED, 3 ADMITTED
```
The same window exists sequentially, not only concurrently: a `subagent` child does not appear in
`fleet.entries` until the tool call has actually started it, so every dispatch issued before the
owner lists the first child is admitted. Control: the **project-wide** gate on the same harness
reserves correctly — 2 concurrent non-kind dispatches with `subagentConcurrency: 1` ⇒ 1 admitted,
1 refused. So this is the kind gate alone, and it is exactly the shipped-once failure mode in its
milder form: the gate *is* running and *does* count, but its counting window makes
`maxConcurrent: 1` admit three simultaneous executors. Once the owner lists them, it refuses
(`dispatch #2 … REFUSED … 当前已有 1 个在运行`), so the guarantee is "eventually enforced", not
"never exceeded".

Direction (not applied — read-only): give the kind gate a reservation keyed on the same
`toolCallId` the capacity gate uses, through the existing bridge (`admit`-style slot per kind, or a
`reserveKind(kind, launchId)` that `settle`/`release` already models), and release it on
`tool_result` the way `capacity` does. Anything less re-counts a window that cannot contain the
launch it is about to admit.

### B2 (blocker, PRD 3 + acceptance 2) — `tasks` / `chain` dispatches of a kind bypass the gate completely

`decodeKindDispatch` (`:162`) only reads the single-agent shape (`call.agent`). A dispatch whose
agents live in `tasks[]` or `chain[]` (including `chain[].parallel[]`) decodes to `null` and returns
before any check. Driven (`/tmp/r2/j.mjs`), kind limit 1, live 0:
```
tasks x4 (limit 1, live 0):            UNTOUCHED — gate never saw it
tasks with count:4:                    UNTOUCHED — gate never saw it
chain of two executor steps:           UNTOUCHED — gate never saw it
chain parallel of two:                 UNTOUCHED — gate never saw it
public reads during all fanouts: 0
```
And the disabled case, which is the PRD's first promise:
```
disabled kind via tasks: [{agent:"cw-auditor"}]  -> UNTOUCHED — gate admitted it
chain [cw-executor, disabled cw-auditor]         -> UNTOUCHED
```
while `/Coworkflow:status` on the same host says `auditor 已关闭（不注册；派单会被拒绝）`. That
sentence is false on this path: the disabled kind is launched.

Scope note, so the parent can weigh it: top-level `tasks`/`chain` reach the executor only when the
installed owner runs with `disabledFeatures: ["workflow-scripts"]`
(`docs/configuration.md` §"Chain and tasks without workflow scripts";
`src/extension/public-execution.js:131` gates on `structuredWorkflows`). The **default** owner config
rejects them and routes orchestration through `workflow: true` scripts, where the child agents are
chosen by the script and are likewise invisible to this gate. Either way, "a kind dispatch is
refused when disabled / over its limit" does not hold for every shape the owner accepts, and
nothing in the package's own report qualifies it. Minimum honest fix: decode the fanout shapes for
the *disabled* check at least (it needs no count), or state in `/Coworkflow:status` and the README
that the kind gate covers single-agent dispatches only.

---

## Lower-severity findings

### M1 (medium) — `run-control` reports a run as *gone* when it merely cannot list runs

`core/subagents-client.ts:894`: `if (capacity !== null) return { kind: "known", active: capacity,
runs: snapshot?.runs ?? [], omitted: snapshot?.omitted ?? 0 }`. `fleetStatus` (the top-level counter)
is advertised independently of `asyncStatusSnapshot` (the per-run list). When the counter exists and
the list does not — no `asyncStatusSnapshot` capability, or a payload `decodeAsyncSnapshot` rejects
(one row missing `label` is enough, `:190-200`) — `observeActivity` returns `known` with `runs: []`,
and `modules/subagents/run-control.ts:34` `stateOf` turns "not in an empty list" into
`{kind:"absent"}` (`:117`). Driven (`/tmp/r2/k.mjs`, `/tmp/r2/r.mjs`), both variants:
```
pi-subagents 已接受停止 run run-1 的请求（state: stopping，请求前状态: running）。
这是「请求已被接受」，不是「run 已经结束」：…
停止后的公开状态里已经没有这个 run：可能已经结束，但缺少终止证据，…
```
State at that moment was `stop`-accepted, i.e. `stopping`. It never claims termination (the hedge is
there, and `已停止` never prints), so this is not the "reports terminated" bug — but
`已经没有这个 run` is a claim about a run the projection simply cannot enumerate, and it is the same
class of defect the task exists to remove: a `known` that is really `unknown`. Fix direction: make
`observeActivity` return `unknown` when `capacity !== null` but no *valid* per-run projection
accompanies it (`runs` are needed by `stateOf`), or have `stateOf` treat "empty run list" as
`unknown` rather than `absent`.

### M2 (medium) — `interrupt` is production code with no production caller

`core/subagents-client.ts:832` is implemented, capability-checked and covered by
`scripts/run-control.test.ts`, but nothing in `modules/` calls it: `modules/subagents/index.ts`
registers only `/Coworkflow:stop` (`:709`) and `/Coworkflow:steer` (`:706`, `:726`), and
`modules/lane-worktree/index.ts:222` uses `requestStop`. So the "interrupt control path" reviewed
here is unreachable from any command or tool — the wrapper's honesty is real, the capability is
inert. Either wire it (e.g. a `--interrupt` mode on `/Coworkflow:stop`, which is what the owner's
`interrupt` action is for) or drop it; keeping an unreachable path that the README's control section
implies exists is the reporting-vs-reality gap this task is about.

### L1 (low) — the count decoder trusts `omitted` without cross-checking `totalActive`

`decodeFleetAgentCounts` (`:228`) returns `omitted` verbatim; `agentActivity` refuses only on
`omitted > 0`. Driven (`/tmp/r2/j.mjs`) with `{entries:[{…cw-executor…}], totalActive:5, omitted:0}`
⇒ **admitted**, counted as "1 of 2" while five runs are live. Upstream computes
`omitted = max(0, totalActive - entries.length)` (`src/extension/rpc.js:200`), so this needs a
non-upstream payload to trigger — I am reporting it as hardening, not a live bug. Note the *later*
commit `afb0677` adds exactly this check to a new `decodeFleetWindow` (`gaps: "窗口行数与活跃计数不一致"`),
which the panel path uses, but `agentActivity` still returns `omitted` and the gate still refuses
only on `omitted > 0`, so the mismatch does not reach the gate at HEAD either.
Relatedly: `availableKinds` (`:198`) lists enabled-and-registered kinds without regard to their
current occupancy, so the disabled-kind refusal can read `当前可用的 kind：cw-executor` while
`cw-executor` is itself at 1/1 and would be refused (driven: `/tmp/r2/n.mjs`). Wording only.

### L2 (low, informational) — `append-step` is decoded as a kind dispatch but is removed upstream

`index.ts:167` treats `resume`/`append-step` as work-starting. `resume` is right (it starts work).
`append-step` was removed from the public tool
(`src/extension/public-execution.js:150`: "Legacy append-step control was removed …"), so that
branch is dead and harmless — but it means a refusal can be produced for a shape the owner would
have rejected anyway (driven: `/tmp/r2/p.mjs`).

---

## Already fixed by a later commit?

Checked `git diff 9083af5 HEAD` for the reviewed files: `modules/agent-kinds/index.ts`,
`modules/subagents/run-control.ts` and `modules/capacity/index.ts` are unchanged; `agent-kinds/`
only gains a `researcher` kind and `defaults.ts` entries; `core/subagents-client.ts` gains
`decodeFleetWindow`/`fleetWindow`/`formatRunSummary` for the panel and **rewrites**
`decodeFleetAgentCounts` on top of `decodeFleetWindow`. I re-ran B1, B2 and M1 against
`HEAD`'s `core/subagents-client.ts` with `9083af5`'s modules: identical results — none of the
findings above is fixed by `afb0677`. L1's underlying cross-check exists only in the new panel
decoder, not on the gate's path.
