# Execution plan

Serial writers in `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds`. Each stage leaves the tree
green; the next starts when the previous one reports. `pi-subagents` is read-only throughout.

## Stage 1 — kinds and the registration contract

Files: `core/config.ts` (the `agentKinds` shape + validation), `modules/agent-kinds/{defaults.ts,registration.ts,assets/*}`, `core/subagents-workflow.ts` only if the "find the installed owner" helper must be shared rather than copied, focused test.

Deliver the kind table with built-in defaults, asset-backed system prompts, and registration through
the installed package's public `./agents` export. Report the exact mechanism used (event contract vs
direct export) and why. Registration must be idempotent, disposables tracked, disposed on session end,
and a name collision must fail that kind only with a readable reason. Test with real registration
against the installed owner where the environment allows it, and cover the unavailable-contract path
explicitly.

## Stage 2 — the per-kind gate

Files: `modules/agent-kinds/index.ts` (module + gate), `core/subagents-client.ts` only for an exported
per-agent count derived from the existing fleet decoder, `modules/capacity/index.ts` untouched,
focused test.

Decode a `subagent` dispatch, refuse disabled kinds and over-limit kinds with reasons that name the
available kinds and the current occupancy respectively, leave every other dispatch untouched. Treat an
undecodable or unavailable fleet reply as refusal, never as "assume fine". Test both gates together
(global + per-kind) and confirm neither masks the other.

## Stage 3 — panel, status, role mapping, lanes

Files: `modules/panel/settings.ts` (+ `shared.ts` if a row helper is needed), `modules/agent-kinds/index.ts`
status lines, `modules/subagent-context/index.ts` role matching, `modules/lane-worktree/index.ts` kind
label, `modules/subagents/index.ts` if the implement/review agent names follow the kinds, plus tests
and `README.md` / `.trellis/spec/frontend/subagents-integration.md`.

Panel section with enabled toggle and limit per kind, applied without restart; status reports
registered kinds or the exact reason none are; kind names resolve to the existing Trellis roles; lanes
show the kind.

## Stage 4 — independent check

Read-only `trellis-check` over the task delta: verify the six PRD acceptance items by driving
production code, in particular that a disabled or over-limit kind is actually refused, that toggling
twice neither duplicates nor collides, that degradation is honest, and that non-kind dispatches are
byte-for-byte unchanged in behaviour. Run `npm run typecheck` and `npm test` once and report the real
summary. Blockers with file/line and reproduction; no fixes.

## Parent finish

Audit against the PRD, resolve blockers with bounded follow-ups, then commit on the task branch, merge
into main, and archive/clean up — using the exit-state check this package now provides, never `--force`.
