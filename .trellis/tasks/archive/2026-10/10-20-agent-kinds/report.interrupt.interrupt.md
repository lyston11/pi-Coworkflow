# Implement report — interrupting a run (`stop` / `steer` / `interrupt`)

Task: `.trellis/tasks/10-20-agent-kinds` (child: implement). Worktree: `/Users/lyston/PycharmProjects/wt-10-20-agent-kinds`.

## What I delivered

### 1. `core/subagents-client.ts` — the three public control wrappers

Added next to `status()`/`cost()`, same shape and same discipline:

- `stop(params)` → `Result<StopReceipt>` where `StopReceipt` is
  `{ accepted: true; state: string; runId: string | null; previousState?; childId?; asyncDir?; text }`.
  The doc comment states explicitly that a successful stop is an **accepted request**, not a
  terminated run, and that termination needs a subsequent `status` read plus process-terminal
  evidence. No `ambiguous` alias is ever produced (the spawn retry discipline deliberately does not
  apply), so a failed stop is never reported as a timeout that implies the run died.
- `steer(params)` → `Result<SteerReceipt>` (`accepted`, `deliveryStatus`, `requestId`, `state`, `text`).
  Instructions travel as `params.message`, untouched.
- `interrupt(params)` → `Result<InterruptReceipt>` (`accepted`, `text`).

Shared discipline in all three, via a new private `advertises(method)` helper:

- capability-checked against `ping.methods` **before** emitting; an unadvertised method (or an explicit
  `capabilities[method] === false`) returns `reason: "unavailable"` with a message naming the method and
  the methods the owner does advertise — nothing is sent;
- the reply is validated like `status()` does; an unreadable reply is `reason: "protocol"`, never success;
- the owner's own `error.code` / `error.message` is preserved (`reason: "refused"`), unchanged.

New decoders (exported, like `decodeCost`): `decodeStopReceipt`, `decodeSteerReceipt`,
`decodeInterruptReceipt`.

### 2. `modules/subagents/run-control.ts` (new) — the shared report layer

`requestStop(host, runtime, runId)` and `requestSteer(host, runtime, runId, message)` build the session
bridge, call the wrapper, and then print **two facts as two facts**:

- the acknowledgement (owner's own `state`, `previousState`, `childId`, `message`);
- exactly one follow-up public `status` read via `bridge.observe()`, rendered as
  `running（还在运行）` / `queued（还在排队，尚未开始）` / `stopping（停止请求进行中，不等于已终止）` /
  `paused（已暂停，未终止）` / … ; a run no longer listed says termination is still unproven; an
  unreadable projection says the state could not be read and termination is unconfirmed.

No "已停止" anywhere. No polling loop, no retry, no timer.

### 3. `modules/lane-worktree/index.ts` — `/Coworkflow:lanes stop <runId>`

- New exported `parseLanesArgs(args)`: only a bare `stop` keyword followed by an id is the control form
  (`STOP run-1` also works); everything else stays a free-form task reference, so the read-only forms
  are unchanged. Empty id → usage error; whitespace inside the id → error.
- The stop branch refuses when the run id is **not recorded for this task** in
  `.trellis/.runtime/native-runs.json` (and names the task that does own it when there is one); refuses
  a link recorded for a different session before emitting anything; honours the file's existing gates
  (`enabled(state)` — session switch, child, `lane-worktree` module, resolvable config root).
- Success prints the acceptance receipt, then the follow-up state; `/Coworkflow:lanes` without `stop`
  remains byte-identical read-only output.
- Command description updated to mention the stop form.

### 4. `modules/subagents/index.ts` — `/Coworkflow:stop` and `/Coworkflow:steer`

- New exported `parseControlArgs(args, { instructionsRequired })`: first token is the run id, the rest is
  free text passed as data; empty id and (for steer) empty instructions are refused with a readable
  message before any RPC; 4000-char cap.
- `/Coworkflow:stop <runId> [instructions]`: instructions are delivered as a steer first, then the stop
  is requested; each outcome is reported separately. `/Coworkflow:steer <runId> <instructions>` only
  steers.
- Both are registered with the same lifetime as `/Coworkflow:run` (`onSessionActivate`, withdrawn in
  `onSessionEnd` / `resetSubagentsRuntime` through the new `controlCommandsRegistered` flag), both check
  the session switch and the `subagents` module switch, and both are capability-honest: when the owner
  advertises no `stop`/`steer`, the command says exactly `没有通告 RPC stop 方法 …` and sends nothing.

### 5. Tests — `scripts/run-control.test.ts` (new, wired into `npm test`)

16 tests driving production code (real `SubagentsClient`, real `attachSubagents` bridge, real
`laneWorktreeModule` / `subagentsModule` command handlers) over a fake `pi.events` bus:

- missing capability → refusal with the reason, and **zero** RPC emitted (stop, steer, interrupt);
- stop accepted → `accepted: true`, `state: "stopping"`, no ambiguity alias, exactly one request;
- refused stop → owner's `invalid_state` text preserved, no `ambiguous`;
- malformed reply (`{}`) → `protocol` error for all three;
- steer → instructions byte-for-byte unchanged (shell metacharacters, newlines, quotes), `queued`
  reported as queued;
- `/Coworkflow:lanes stop <runId>` → prints accepted + follow-up `running（还在运行）`, never `已停止`;
- lanes refuses an unrecorded id, another task's id, an empty id, and a switched-off module, emitting
  nothing in each case;
- lanes stop with an owner that advertises no `stop` says exactly that;
- `/Coworkflow:stop` refuses an empty id; with instructions it steers then stops and reports both;
- `/Coworkflow:steer` requires instructions and passes them through unchanged;
- both commands degrade honestly when `stop`/`steer` are unadvertised and when the module is off;
- the two argument decoders.

### 6. Docs

- `README.md`: command table rows for `/Coworkflow:stop` and `/Coworkflow:steer`, the lanes stop form, and
  a new "中断一个 run：stop / steer" section stating the accepted-vs-terminated distinction and the
  capability honesty.
- `.trellis/spec/frontend/subagents-integration.md`: new "Interrupting a run" section, plus a line in the
  capability-floor section saying the three control methods are optional per call and degrade to an
  explicit refusal.

## Verification (commands actually run)

```
npx tsc --noEmit                     → TypeScript: No errors found
node --experimental-strip-types --test scripts/run-control.test.ts          → 16 pass / 0 fail
node --experimental-strip-types --test scripts/capacity-lanes.test.ts       →  7 pass / 0 fail
node --experimental-strip-types --test scripts/agent-kinds-surface.test.ts  → 11 pass / 0 fail
node --experimental-strip-types --test scripts/agent-kinds.test.ts          → 21 pass / 0 fail
node --experimental-strip-types --test scripts/runtime-lifecycle.test.ts    → 17 pass / 0 fail
node --experimental-strip-types --test scripts/upstream-bridge.test.ts      → 38 pass / 0 fail
```

I did not run the full `npm test` (per the dispatch: other children are checking concurrently). I also
did not run `scripts/usage.test.ts`, `scripts/test.ts`, `scripts/config-root.test.ts`,
`scripts/switch-default.test.ts`; none of them touch the files I changed except through shared modules
already covered above.

## Upstream facts confirmed while implementing (read-only)

- `SUBAGENT_RPC_METHODS` = ping, status, manage, spawn, steer, interrupt, stop, resume, cost;
  `ping.capabilities` advertises `stop`, `steer`, `nonRecoveringSteer`, `interrupt`, `resume`, `cost`.
- `stop` returns `{ runId, asyncDir, previousState, state: "stopping", … , message }` — the comment in
  `src/extension/rpc.js` says outright "This is an acceptance receipt, not terminal proof".
- `stop` rejects already-terminal targets (`invalid_state`) and runs not owned by the current session
  (`not_found`) — hence the lanes command's pre-check for a foreign `sessionId` before emitting.
- `steer` returns the ordinary steer action result: `{ text, details: { steering: { deliveryStatus,
  requestId, state } } }`, `deliveryStatus: "queued"` being a normal success.

## Not done / notes

- `interrupt` has a client wrapper and tests but no command: the dispatch named `/Coworkflow:stop` and
  `/Coworkflow:steer` only, and the owner restricts `interrupt` to non-workflow, non-external async runs
  (it says so in its own refusal, which the wrapper passes through).
- The stop follow-up read is exactly one `bridge.observe()` call — no poll loop, by design.
- Nothing here commits, pushes, merges, or changes task lifecycle state.
