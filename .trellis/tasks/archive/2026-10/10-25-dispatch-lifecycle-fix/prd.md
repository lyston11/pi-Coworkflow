# Dispatch queue lifecycle and host wiring

Repair modules/dispatch/index.ts and scripts/dispatch-queue.test.ts (a separate dispatch host test file is allowed; package.json only if needed to register it). Read parent design/implement at ../10-25-dispatch-integration.

Requirements: only positively successful completion releases needs; paused/stopped/failed and unknown notices never count as completed; duplicate/out-of-epoch events are harmless. Reject dependency cycles/self-cycles atomically. Any correlated completion can prompt fresh admission of queued work, including external runs, without inventing available capacity. Dispatch disabled/stop/session changes must prevent automatic starts, including after awaits. Capture old epoch work safely.

RPC spawn must honor the existing shared project capacity bridge, not only kind ceilings. Reuse bridge.admit/trackAlias/bind/hold/release/releaseRun conventions in modules/subagents/index.ts. Handle ambiguous RPC outcomes conservatively without retrying or claiming no process was started. No new runner, timer, disk ledger or general abstraction. Unknown fleet stays fail-closed.

Drive dispatchModule.activate with a realistic fake host/public RPC contract in regressions, not only injected createDispatchQueue. Cover paused/stopped notify and success, module disable completion, foreign completion wake, cycle, async epoch race, finite total capacity and ambiguous spawn. Existing client implementation is out of scope unless a blocking public seam issue is proven; request parent guidance rather than duplicating it. Run affected suites and typecheck. Report exact assertions and limitations.
