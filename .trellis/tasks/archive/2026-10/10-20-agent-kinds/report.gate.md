# Stage 2 report — the per-kind gate

Task: `.trellis/tasks/10-20-agent-kinds` · worktree `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds` · Stage 2 only
(`modules/agent-kinds/index.ts` gate + the exported per-agent count in `core/subagents-client.ts`).
`modules/capacity/index.ts` untouched, as the plan required.

## What the gate does

`modules/agent-kinds/index.ts` now registers one `tool_call` listener from `activate` and decides there:

1. `event.toolName !== "subagent"` → return (`undefined`). No read, no block.
2. session switch off, project switch off, or `runtime.isChild` → return.
3. `decodeKindDispatch(event.input)` → `null` for everything that is not a kind dispatch → return.
4. kind **disabled** → block, reason names the kinds that are genuinely available (see below).
5. kind **enabled but not in the owner's accepted list** (contract unavailable, collision, missing asset) → block, with the exact reason; it also awaits a registration pass still in flight instead of deciding on an empty snapshot.
6. kind **at/over `maxConcurrent`** → block, reason names the limit and the current occupancy.
7. otherwise → return, dispatch unchanged.

`decodeKindDispatch` is exported so the exclusions are asserted directly, not only through the hook:

- `action` other than `resume`/`append-step` → not a dispatch. In those calls `agent` is a management *target*; gating them would let a limit block a `stop`, i.e. refuse the operation that frees the slot.
- an agent that is not a `cw-` name → not ours (`worker`, `trellis-implement`, another extension's agent).
- a `cw-` name this package does not ship (`cw-unknown`) → not ours; the owner stays the authority on whether it exists.

### The count comes from the owner, not from a ledger

`core/subagents-client.ts` gained two exports and one bridge method — no new state:

- `decodeFleetAgentCounts(data)` — counts `fleet.entries[].agent` from the public fleet DTO. It validates `version`, `totalActive`, `omitted`, and each entry's `key`/`agent`/`startedAt`; anything else is `null`.
- `SubagentsClient.agentActivity()` — `ping` → require `status` and `fleetStatus` capability → `status` → decode. Missing capability, failed/garbled reply, or `omitted > 0` (the projection is a bounded window, `MAX_FLEET_ENTRIES` 16 upstream) is `{kind: "unknown", reason}`. Never a zero.
- `SubagentsBridge.agentCount(agent)` — reads through the bridge's existing serialized queue, so the per-kind check and the capacity check share one client and one read order instead of racing two.

`capacity` and its `decideAdmission` are unchanged; the bridge is only *attached* (it already was, by `capacity`), and this module disposes it on `onSessionEnd` only if it was the one that attached it.

### Both gates, and which reason wins

Both are ordinary `tool_call` handlers, so the host runs them in registration order and stops at the first `block`. `agent-kinds` is registered before `capacity` in `MODULES`, and the gate's check is the narrower one (one kind, not the whole project), so a call that violates both reads the per-kind reason — the more specific, more actionable one. A call that violates only the project-wide limit still reads capacity's reason, because admission is not bypassed: the per-kind gate does not admit *for* capacity, it just does not block. Verified by driving both modules on one host (test "the project-wide limit and the per-kind limit both hold").

### Unknown is not zero — the three cases that refuse

| situation | result |
|---|---|
| `ping.capabilities.fleetStatus` absent | refuse, reason says the capability is missing |
| fleet DTO malformed | refuse, reason says it is not a decodable `entries/totalActive/omitted` |
| `omitted > 0` (bounded window overflow) | refuse, reason names the number of runs the window does not describe |

## Registration/lifecycle changes made to support the gate

- `State` gained `listeners` and `attached`. `activate` installs `tool_call` at most once per host (a second `activate` in one session adds no listener) and installs it even while the layer is off — a hook cannot be added retroactively by an event that already fired; the hook reads both switches itself. `onSessionEnd` removes the listener, disposes the bridge it attached, and keeps the existing registry disposal. Tested: session end → 0 hooks, re-activate → exactly 1.
- A dispatch arriving before the first registration pass lands awaits that pass (`state.pending`) rather than deciding on `snapshot === null`, then re-reads. A policy toggle that happens *during* the public read is re-read after the await, so the number in force at decision time is the one enforced.
- The reason text for a disabled kind lists only kinds the owner actually accepted (`snapshot.registered ∩ enabled`). An enabled-but-unregistered kind is never named as available — that is the same "silent no-op" failure mode requirement 6 exists to prevent.

## Files changed

- `modules/agent-kinds/index.ts` — module header section on the gate; `decodeKindDispatch`, `KindDispatch`, the four refusal builders, `availableKinds`, `gate()`; `activate`/`onSessionEnd` hook wiring; `State.listeners`/`State.attached`.
- `core/subagents-client.ts` — `decodeFleetAgentCounts`, `FleetAgentCounts`, `NativeAgentCounts`, `SubagentsClient.agentActivity()`, `SubagentsBridge.agentCount()`.
- `scripts/agent-kinds.test.ts` — fake `pi` gained an RPC responder (`ping`/`status`) so the tests drive the real public count path; new harness `gateHarness()` that calls `agentKindsModule.activate` and `capacityModule.activate` on one host; 9 new tests.
- `package.json` — unchanged in this stage (the test file was already listed).

## Verification (commands actually run, in this worktree)

```
./node_modules/.bin/tsc --noEmit   → clean (no output)
npm test                           → tests 120, pass 120, fail 0 (~11.9s)
node --experimental-strip-types --test scripts/agent-kinds.test.ts → 21 pass, 0 fail
```

The 9 new tests, each driving the production `tool_call` hook (not the decoder alone), against the installed owner's real registration:

1. **decoder** — a kind dispatch decodes; `resume`/`append-step` decode; `worker`, `trellis-implement`, `cw-unknown`, `action: status`, `action: stop`, `action: create`, empty agent, `{}`, `null`, a string and an array do not.
2. **disabled refusal** — `cw-auditor` (built-in default off) blocked; reason contains `关闭了 kind auditor（cw-auditor）`, `当前可用的 kind：cw-executor`, `没有启动任何子进程`; **zero RPC requests** — the refusal costs nothing.
3. **occupancy** — 1 of 2 admits, 2 of 2 refuses with `并发上限是 2` / `当前已有 2 个在运行`; other agents in the fleet do not consume a kind slot; 0 of ours admits.
4. **unknown refuses** — three separate owners (no `fleetStatus`, malformed DTO, `omitted: 2`), zero runs live, all three refuse with `无法确认现在有几个在运行`, never `当前已有 0 个`.
5. **enabled-but-unregistered refuses** — host with no event bus: blocked with `没有被注册到 pi-subagents` + the bus reason.
6. **non-kind untouched** — with a kind *at* its limit, nine non-kind/management inputs all return `undefined` and produce **no additional RPC request**.
7. **both gates** — per-kind refuses while the project limit has room; the project limit refuses while the kind has room (`本项目（Coworkflow）的子 agent 并发上限是 1`, not the per-kind text); both-blocking yields the per-kind reason; both-admitting passes.
8. **gates of the gate** — module switch off / session switch off ⇒ no block; back on ⇒ blocks again with no reload; `isChild` ⇒ no block.
9. **lifecycle** — one hook after activate, still one after a second activate, zero after `onSessionEnd`, one after re-activate, kind re-registered.

The pre-existing 12 stage-1 tests and the whole suite (capacity-lanes, upstream-bridge, runtime-lifecycle, usage, config-root, switch-default) stay green.

## Known limits (deliberate, per design)

- **No reservation of its own.** The count is only what the owner's fleet reports. Two kind dispatches issued in the same assistant turn can both pass the per-kind gate before either appears in the fleet — the design forbids a local ledger, and upstream's own fanout limits remain the backstop. The project-wide gate has a reservation for exactly this reason and is unaffected.
- **The status line does not yet print limits.** `/Coworkflow:status` reports registered/disabled/failed/unshipped kinds (stage 1) and every refusal carries the live limit; adding the limit beside each registered kind is panel/status work (stage 3), and I did not put a half-version of it in.
- **Nothing here decides which kind gets a task.** Requirement 3 is refusal, not routing.

## Not done (Stage 3+)

Panel section (enabled + limit rows with Space/Left/Right/Enter), `runtimeStatus` limit display, role mapping in `subagent-context`, lane kind labelling, `subagents` module agent-name wiring, README/spec updates. Stage 1's open question also still stands for the parent: `agent-kinds` now **can refuse work**, so per `modules/index.ts` it should declare `newSwitchDefault: "off"` — I did not flip it (it changes what an existing config means and would gate acceptance item 1 behind an init flag), and `scripts/switch-default.test.ts` currently asserts that no module declares a default, so flipping it also requires changing that assertion on purpose.
