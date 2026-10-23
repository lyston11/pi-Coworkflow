# Observability before a stop — implementer report

Task: `.trellis/tasks/10-20-agent-kinds`. Base commit `bf9146a` (kinds registration, per-kind gate,
panel section, stop/steer/interrupt) left untouched. Branch `wt-10-20-agent-kinds`, no commit performed.

## The gap, restated in the terms it was fixed in

A stop is only as good as the decision behind it. Before this change the parent could see *that* a child
was running, and nothing more: `NativeRun` carried only `id/state/label/agent/model/startedAt`, the goal
of a dispatch was never stored, and the fleet DTO the owner already publishes was not read at all. So the
only options were to guess or wait out the timeout.

What the public contract actually supports, and what this change now surfaces:

| Fact | Attributable to a run? | Source |
|---|---|---|
| state, agent, model, `startedAt` | yes — `asyncSnapshot.runs[].id` is a real run id | `status` v1 |
| elapsed | yes, derived from `startedAt` at render time | same |
| goal of a dispatch | yes, **only** from our own dispatch record | `tool_call` task text |
| token totals | **no** — fleet window only, bounded, may be short | `fleet.entries[].tokens` |
| live per-tool narration | **no** — `currentAction` exists only in the external-runs display API; `pi.events` is process-local | documented gap, not faked |

## 1. `core/subagents-client.ts` — decoding what the DTO documents

New, all exported and driven by tests:

- `FleetEntry` / `FleetTokens` — the row shape the installed owner actually builds
  (`src/extension/rpc.d.ts:44`, verified against `src/extension/rpc.js`): opaque `key`, `agent`, optional
  `role`, `model`, `effort`, `goal`, safe `startedAt`, `{ input, output, total }` tokens.
- `decodeFleetWindow(data): FleetWindowKnown | null` — strictness kept identical to the rest of the file:
  a row missing `key`/`agent`/`startedAt`, a non-text metadata field, or an unreadable `tokens` object is
  a **protocol failure for the whole payload** (`null`), not a half-trusted row. Unknown *extra* fields
  are ignored, so a newer owner adding one does not break the decoder (tested).
- `gaps: string[]` — why the window's sum is a lower bound: `omitted > 0`, a row without usage, the
  snapshot's `byteLimitExceeded`, or `entries.length + omitted !== totalActive`. Empty means complete.
  `tokens` is `null` (unknown) when no row carried usage and the window is non-empty; a zero-row window
  whose counters agree is a real zero.
- `FleetWindow` = `{ kind: "known", ... } | { kind: "unknown", reason }` — unknown is a first-class result.
- `decodeFleetAgentCounts` now **delegates** to `decodeFleetWindow`, so the per-kind gate and the display
  cannot disagree about what the window says. Its behaviour is unchanged (all gate tests still pass).
- `elapsedLabel(startedAt, now)` — pure; `undefined` for an absent start or a start in the future
  (a clock we cannot use), never `0s`.
- `formatRunSummary(activity, fleet, now)` — the bounded panel summary: per-run `agent [state] · elapsed ·
  model · run <id8>` (max 8 lines, remainder counted), then tokens either "fleet 窗口完整" or
  "不完整 —— <reason>；…只是下界". Both halves degrade to `未知（reason）`.
- `SubagentsClient.fleetWindow()` — capability-checked (needs `status` + `fleetStatus: {version: 1}`),
  bounded, session-closed-aware. `SubagentsBridge.fleet()` reads it under the same serialization as
  `observe()`, caches it as `fleetView()` for cache-only rendering, and clears it on `dispose()`.

No run/async/tool id was added to fleet data and there is no join between a fleet key and a run id
anywhere in the tree — pinned by a test that asserts the decoded row's key set is exactly
`agent/key/startedAt/tokens` even when the payload carries `runId`/`asyncId`.

## 2. What a recorded run can show, from attributable sources

`NativeRunLink` (`core/subagents-workflow.ts`) gained two optional fields, both **our own record** of what
we sent, taken at `tool_call` time — the only moment the caller's own choice is observable:

- `agent` — the agent name from the dispatch input.
- `goal` — the task text, with the `Active task: …` routing line dropped, flattened to one line, capped at
  120 chars with a visible `…`. A dispatch whose text contains nothing but the routing line stores **no**
  goal (absence, not an empty string).

## 3. `modules/lane-worktree/index.ts` — the per-run line

Per run, in this order and only when known:
`- run <id> · <agent> [<state>] · 已运行 <elapsed> · kind <label>`, then `目标（本包派单记录）: …`.

- `agent` prefers the runner's snapshot; when only our record has it, it is labelled
  `（本包派单记录）`, so a reader can tell the two sources apart. Neither present → the segment is absent
  (no `?`).
- `elapsed` only from the snapshot's `startedAt`; absent otherwise (no `已运行 0s`).
- `state` still falls back to `未知` explicitly.
- `MAX_DISPLAY` discipline unchanged; goals are truncated, so a wide fanout or a long task text cannot
  flood the report.

## 4. Panel facts path

`extensions/coworkflow.ts` `facts()` now emits `formatRunSummary(activity, bridge.fleetView(), Date.now())`
between the active-run count and the native cost line, and `modules/panel/settings.ts` refreshes the fleet
window once at panel-open (next to the existing `observe()`), so render stays cache-only. A test asserts
that rendering `facts()` repeatedly adds zero RPC requests.

## 5. Documentation

- `README.md` — new section "决定要不要中断之前，父会话能看见什么": a fact-by-fact table (attributable
  yes / fleet-only / unavailable), the rule that fleet enriches display and never attributes a run, the
  incompleteness rule for token sums, and an explicit statement that live per-tool narration is
  unavailable because `pi.events` does not cross processes. `/Coworkflow:lanes` row in the command table
  updated.
- `.trellis/spec/frontend/subagents-integration.md` — new "Observability before a stop" section stating
  the same contract normatively (including "no code path joins a fleet key to a run id, and none may
  start doing so").

## 6. Tests — `scripts/observability.test.ts` (new, wired into `npm test`)

14 tests, all through production paths:

- fleet decoding of every documented field; unknown extra fields tolerated; 7 distinct malformed-row
  cases each `null`; envelope version/counter failures `null`.
- `omitted > 0`, a usage-less row, and `byteLimitExceeded` each produce a gap and a lower bound; no-row
  usage → `tokens: null`; agreeing empty window → real zero with no gaps.
- `decodeFleetAgentCounts` delegates (gate and display cannot drift).
- a fleet key is never a run id (key set assertion).
- `elapsedLabel` for s/m/h/mixed, plus `undefined` for absent and future start, plus purity.
- `formatRunSummary`: attributable per-run line, complete vs incomplete token wording, unknown
  activity/fleet, absent `startedAt` → `已运行 未知`, empty run list, 8-line bound.
- `SubagentsClient.fleetWindow()` over a fake bus: known window, malformed reply → `unknown`, missing
  `fleetStatus` capability → `unknown` naming the capability.
- panel `facts()`: real per-run line, `不完整` + `下界`, and no RPC on repeated render.
- lanes: goal stored by the production `tool_call`/`tool_result` handlers and labelled as our record;
  400-char goal truncated with `…`; a routing-only dispatch stores no goal and no agent, and its line
  shows neither, while still printing `[未知]`.

Two existing assertions were relaxed from `run <id> \[state\]` to `run <id>[^\n]*\[state\]` because the
line now carries the agent before the state (`agent-kinds-surface.test.ts:609-610`,
`capacity-lanes.test.ts:166`). Semantics unchanged.

## Verification actually run

```
npx tsc --noEmit                     → No errors found
node --experimental-strip-types --test scripts/observability.test.ts
                                     → tests 14, pass 14, fail 0
npm test (full suite)                → tests 163, pass 163, fail 0
```

`npm test` was run twice after the focused file was green (identical results: 163 pass, 0 fail). The new
file contributes 14 of those. No file was reverted, no commit/push/merge performed, `pi-subagents`
untouched.

## Honest remaining gaps

- Fleet data enriches display only. There is no way to attribute a fleet row to a run, so a per-run token
  figure cannot be shown — only a windowed sum with an incompleteness marker. That is by design, not an
  oversight.
- Live per-tool/per-file narration remains unavailable (external-runs display API only; `pi.events` is
  process-local). Documented as a gap in both README and the spec; not simulated.
