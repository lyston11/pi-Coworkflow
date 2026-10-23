const cwd = "/Users/lyston/PycharmProjects/wt-10-20-agent-kinds";
const COMMIT = "9083af5";
const base = `Active task: .trellis/tasks/10-20-agent-kinds
You are one of TWO read-only reviewers running concurrently. A third child is concurrently WRITING to core/subagents-client.ts, modules/lane-worktree/index.ts and the panel facts path, so the working tree can change under you.

Therefore: read code with \`git show ${COMMIT}:<path>\` for anything you find modified in \`git status\`, and read the working tree directly only for files git reports clean. Review the state as of ${COMMIT}; that is a fixed, complete snapshot (kinds registration, per-kind gate, panel section, stop/steer/interrupt, configured-agent collision fix, panel off-row fix). Note explicitly if you think a finding is already fixed by a later commit.

Work ONLY in ${cwd}. The main checkout and the installed pi-subagents package are READ-ONLY. READ ONLY: do not fix anything, do not edit any file, do not commit. Do not run the full npm test (a writer is active; run at most typecheck plus the one test file you need). Do not crawl node_modules; read only the exact files named plus their direct callers.

Drive PRODUCTION code rather than reading assertions. Explicitly hunt the failure this package shipped once already: a gate or panel that reports itself active while enforcing nothing — and its cousin, a report that names a kind as available when dispatching it cannot start.
`;
const schema = {type:"object", properties:{status:{type:"string",enum:["no-blockers","blockers"]},summary:{type:"string"},findings:{type:"array",items:{type:"string"}}},required:["status","summary","findings"]};
const opts = {agent:"trellis-check",model:"buddy2api/deepseek-v4.1-flash",cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:120000,outputSchema:schema,acceptance:{level:"none",reason:"parent collects and audits the findings itself"}};
const [gate, surface] = await Promise.all([
  runs.run("gate",{...opts,task:base+`
YOUR AREA: the per-kind gate (PRD 3, 4) and the interrupt control path.
Files: modules/agent-kinds/index.ts (the tool_call gate, availableKinds, refusals), core/subagents-client.ts (decodeFleetAgentCounts, agentActivity, agentCount, stop/steer/interrupt wrappers, advertises()), modules/subagents/run-control.ts, modules/lane-worktree/index.ts (only the lanes stop path).

Drive production functions with fabricated but production-shaped tool_call payloads and fleet replies and confirm, each as confirmed or broken with file:line and how you drove it:
(a) a disabled kind is refused, and the reason names only kinds that can actually be dispatched;
(b) over-limit is refused with the real limit and occupancy, exactly-at-limit admitted then refused;
(c) an unknown, unavailable or truncated count (no fleetStatus advertised, the snapshot reports omitted entries, or an unparseable payload) REFUSES rather than assuming room, and specifically that a non-zero omitted entry count is treated as unknown rather than as a partial count that still fits;
(d) an enabled-but-unregistered kind is refused;
(e) non-kind dispatches and management calls (status/steer/stop/resume) are untouched by the kind gate;
(f) the project-wide capacity limit and the per-kind limit both hold and neither masks the other;
(g) the gate runs only in the parent session, session end releases the hook, re-activation installs exactly one;
(h) stop/steer/interrupt are capability-checked BEFORE emitting anything, a successful stop reports ACCEPTED and never claims termination, and a malformed reply is a protocol error rather than success.`}),
  runs.run("surface",{...opts,task:base+`
YOUR AREA: the user-facing surface (PRD 5) and the harness's own honesty.
Files: modules/panel/settings.ts (+ shared.ts), modules/agent-kinds/index.ts (runtimeStatus and the kind rows' data), modules/subagent-context/index.ts (role matching), modules/lane-worktree/index.ts (kind grouping/labels), modules/subagents/index.ts (run-control command registration), extensions/coworkflow.ts (only where it feeds the panel facts).

Confirm, each as confirmed or broken with file:line and how you checked it:
(a) the settings panel renders one row per kind with enabled state and limit, and the EXISTING panel keys still behave as before (layout, the full thinking column, Tab session switch, Left/Right column switch) — a regression there is a blocker;
(b) changing enabled/limit takes effect in an already loaded session with no restart, and toggling twice produces no duplicate command registration and no duplicate agent registration;
(c) cw-executor resolves to the implement Trellis context and cw-auditor to check, through the EXISTING injection path only (no second injection path);
(d) /Coworkflow:lanes labels or groups by kind;
(e) /Coworkflow:status reports registered kinds, or the exact reason none are — never names a kind that cannot be dispatched, and never says there are no enabled kinds when enabled kinds merely failed to register;
(f) a kind row after the layer is switched off mid-session says the layer is off, not enabled-and-pending.`})
]);
const all = [["gate",gate],["surface",surface]];
return {needsParentAcceptance:true, results: all.map(([key,r]) => ({key, ok:r.ok, status:r.structuredOutput?.status ?? "failed", summary:r.structuredOutput?.summary ?? String(r.output).slice(0,300), findings:r.structuredOutput?.findings ?? []}))};
