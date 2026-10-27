# Coworkflow × pi-subagents integration contract

## Ownership and paths

- Trellis owns task requirements, task identity, parent approval, and the task's verified integration worktree.
- pi-subagents owns execution, native workflow child keys, missions, async attempts, public status/cost, session history attribution when possible, completion delivery, and upstream capacity.
- Coworkflow owns a bounded public RPC adapter, project-scoped admission at this extension's launch boundaries, role context, module gates, task-to-native identity/artifact links, and a session-local pending-work queue. It does not own execution, persistent scheduling, retries, or native lifecycle records.
- `core/subagents-client.ts` is the single RPC v1 DTO decoder for ping, activity, cost, admission, and correlated replies. `core/pi-subagents.ts` owns structured completion/result/artifact projections. Consumers use these projections; they do not reinterpret raw messages or private runner files.
- `core/subagents-workflow.ts` registers `coworkflow.implement-review` **and** `coworkflow.fanout` in one pass and stores only verified task/native mission/run IDs, explicitly returned artifact references, and the two timestamps the overlap measurement needs. Existing `.trellis/.runtime/lanes/` pointers remain readable; new observers do not manufacture identities from prose, filenames, array order, or “only pending” assumptions.

## Default execution policy: single session first

The main session plans, implements, validates and accepts work directly by default, including non-trivial changes. Delegation is optional when a bounded deliverable, independent planning advice, separable research or risk-driven review justifies duplicated context, handoff and integration cost. Neither elapsed time, tool counts nor serial execution triggers a duty to delegate. There is no mandatory planner/implementer/reviewer chain.

Models, prompts and kinds remain configurable; no model identifiers, required roles or automatic routing engine encode this policy. A child may propose options and evidence within an advisory assignment; final decisions remain parent-owned. Long duration alone does not justify a cheaper model.

When delegation is selected, preserve async execution, admission, context boundaries, write scopes, worktree safety and status/stop. Parent writes are outside the queue's `files` enforcement: never overlap a child's occupied paths. In a shared worktree only the parent stages/commits, after the relevant writers stop. Final acceptance inspects real outputs and evidence, adding checks only when missing or invalidated by integration. Native completion wakes the parent; do not poll or manufacture work while waiting.

Policy has two sources that must agree: `modules/agents/assets/` and `templates/trellis/dot-trellis/workflow.md`. Pi injects the parsed phase step (2.1 first), with `in_progress-inline` as fallback; both must allow direct implementation and optional review. Update template sources and render the project copies, not just AGENTS or a fallback string. Other platforms keep their existing dispatch modes.

`scripts/trellis-template.test.ts` exercises rendered parent/child instructions, real `get_context.py --mode phase --platform pi --step 2.1/2.2` output, inline routing/fallback and preserved safety text. These assert guidance delivery, not model quality or token savings.

## Task validation and native workflow

`/Coworkflow:run [focus]` resolves only the currently prepared Trellis task. Before a pure, I/O-free workflow resolver is called, the host verifies canonical task/main/worktree paths, `task.json`, real Git linked-worktree membership, and the recorded task branch. Main checkout aliases, unrelated repositories, ordinary directories, stale task references and branch mismatch are rejected. Resolver arguments cannot supply arbitrary paths or scripts.

Required child guidance registration succeeds before the workflow becomes executable. The workflow has stable `implement` then `review` steps, fresh contexts, one verified `cwd`, `worktree: false` for both children, and no per-child async. The enclosing spawn is async. Implementation's structured completion/acceptance must be semantically valid before review; review must return a valid pass verdict with no blocking findings. Missing, malformed, negative, or contradictory verdicts fail. Native receipt/run/artifact references go to the parent. A successful workflow run is not final task acceptance, approval to merge, or publication.

The task worktree is mandatory even when a workflow script could execute elsewhere. Unavailable or unsupported host validation is a hard, actionable refusal; do not silently launch through a different runner.

## Independent children (`coworkflow.fanout`) and the serial-dispatch measurement

Once the parent chooses the named workflow for independent delegated work, it runs as one fanout, not as a loop of awaits. `coworkflow.fanout` remains an optional way to run N independent children: `args.tasks` is 1–8 `{ kind, task }` objects with no other per-task fields (an optional `focus` carries one shared instruction), validation mirrors `resolveImplementReview` (bounded count, non-empty bounded task, unknown fields rejected, no caller-supplied paths, and `agent` specifically rejected), child keys come from the array position (`task-1`…) so two children may be the same kind doing different work, and every child runs `context: "fresh"`, `worktree: false`, with its own `acceptance` and `outputSchema` so no child's verdict can stand in for another's.

A task names a **kind**, never an agent: `executor` / `auditor` / `researcher` are the same kinds `/Coworkflow:settings` exposes, resolved through `agentNameFor` in `modules/agent-kinds/defaults.ts` — one mapping, so a fanout child is exactly the agent a direct kind dispatch would run. A name this package does not ship is rejected with the available kinds listed. The resolver stays pure: the host resolves the project's kind policy in memory (`fanoutPolicyFor`, which reads `resolveKinds` plus the owner's accepted registrations) and passes it in, so a task whose kind is disabled, unregistered, or whose policy could not be read **fails as that task** with the `tool_call` gate's own wording (`disabledKindMessage` / `unregisteredKindMessage` — one vocabulary, not two) and is never started, while its siblings still run.

The script starts every child before awaiting any of them (`runs.run` inside one `map`, then `Promise.all`); that concurrency is the resource's entire reason to exist and a loop of `await`s in its place would be the defect it replaces. A child's rejection becomes that task's outcome rather than cancelling its siblings: the result is `{ status: "completed" | "partial", acceptance: "parent-owned", note, results: [{ key, agent, ok, status, summary, handoff, runId, outputReference, error }] }`. Only *all* tasks failing is fail-closed. A green fanout is completed execution, never accepted work: the parent audits every child, merges, and cleans up.

Both names register in the same function and flow (`registerImplementReviewWorkflow`); one session either has the pair or reports why it has neither, and the returned handle disposes both with the same replace/dispose semantics as before. No second registration path exists, and no workflow path writes a message into the conversation.

Dispatch overlap is descriptive evidence, not a requirement to parallelize or a score of execution quality. This layer measures observed timing, not whether the parent should have delegated. Each recorded task↔run link stores `startedAt` (stable across later updates of the same link, which is why `recordedAt` cannot serve) and `settledAt` (written only from an observed structured native completion). `dispatchOverlap` reads one session's links and classifies: crossing intervals are parallel; a complete interval crossing nothing is serial; missing timestamps, still-running runs and backwards clocks are **unresolved** and are never folded into the serial count. `/Coworkflow:status` renders it as one stored line (`派单重叠: 3 次并行、5 次串行（本次会话）`), read at render time, never as a message. `/Coworkflow:lanes` may reuse the same measurement.

The conversation-injected reminder this replaces was removed and must not return: a custom message reaches the model as a **user turn**, so it disrupts and rewrites the very work it describes.

## What is governed

Three launch points, one admission function. A direct `subagent` dispatch of a kind, a `coworkflow.fanout` batch, and a `coworkflow.dispatch` work unit all ask `admitOne()` — the only place a kind's switch, registration and live ceiling are read. `admitOne` is exported by `modules/agent-kinds/index.ts`; no other code path counts occupancy or re-reads the policy for a launch. The `coworkflow.fanout` resolver still refuses a batch that alone exceeds a ceiling, and the gate refuses one that does not fit what is already running, but both decisions come from the same function so a batch and a single dispatch cannot disagree about what "disabled" or "full" means.

What is **not** governed, stated rather than implied:

- **A script's own children.** `workflow: true` (the script in that reply's code block) and a `workflow` string containing `/` (a script file) start children through the owner's `runs.run`/`runs.all`/`runs.lanes` inside the workflow sandbox. No `tool_call` of ours is in that path, so those launches are neither counted nor blocked. The gate refuses the two shapes it can identify — `workflow: true`, and a script file whose text (bounded read) contains a launch call — with a reason that says the launch skips admission and names `coworkflow.dispatch`. A named resource (`parallel`, another extension's workflow) is not a script and is judged by its arguments; `parallel` remains admitted per kind. An unreadable script file is unknown, not evidence, and passes through.
- **Other processes and third-party extensions.** Anything launched outside this session's `tool_call` — another extension's own code, a shell, a separate Pi process — never reaches this extension.
- **Upstream RPC called directly.** `subagents:rpc:v1` `spawn` is public and callable by anyone; this package's admission runs at its own launch boundaries, not inside the owner. It is not global capacity authority and does not claim to be.

## Public capability floor and failure handling

Use documented `subagents:rpc:v1` with UUID-correlated requests for `ping`, `status`, `spawn`, and `cost`; verify protocol version, advertised method and capability shape, and versioned fleet/status projections. Session-local async completion events provide attribution when supported. Workflow-resource and required-child-extension registration use only their documented package exports, without loading the package main runtime or installing another copy. Capability floor is detected from live public advertisements and exported API availability, not inferred from semver alone.

The control methods `stop`, `steer` and `interrupt` are optional per call rather than part of this floor: each is checked against the live advertisement before use and degrades to an explicit refusal, never to a silent no-op.

RPC waits are bounded and clean reply listeners on completion, failure, timeout, shutdown and session replacement. A spawn timeout can be ambiguous after emission; keep its `rpc-spawn-<requestId>` recovery alias and never reissue the spawn. Do not enable retries, goal mode, watchdogs, reminders, or automatic recovery scheduling. Missing or malformed observations are unknown/incomplete, not a successful zero. Do not scan private temp directories or run artifact names to reconstruct state.

## Cost/history semantics

A valid public `cost` v1 reply supplies parent, per-child totals, aggregate totals, and `unresolvedAsyncChildren`; unresolved child counts make the aggregate a lower bound. The native total is session-scoped and may be shown as a separate panel/settings fact, not attributed to an individual model or day.

For the existing model/day chart, preserve parent Pi session entries, local-day windows, provider/model matching, and the enable-time cutoff. Read child model/day records only from exact absolute `children[].sessionFile` references supplied by native cost. Validate the referenced JSONL records' model, timestamp and usage; never infer dates from file mtimes or infer model attribution from native aggregates. Reads are bounded (128 unique session paths, 8 MiB per file, 32 MiB total). Missing pointers, malformed/partial entries, read errors, unsupported cost and unresolved async children preserve any known lower bound and explicitly mark the display incomplete/unavailable; never render missing data as a complete zero.

Refresh only at session start, `agent_settled`, structured native completion, and panel-open boundaries. Render, selection changes and key input are cache-only; no timers, polling, render-time RPC or filesystem scans. Observations are tied to host/runtime/session/epoch. Disable, shutdown, reload and replacement invalidate state, and stale in-flight results cannot publish into a later session.

## Interrupting a run (`stop` / `steer` / `interrupt`)

The main session must be able to interrupt a child it started, at will, through the owner's public control methods — never by signalling a process or reading runner files. `core/subagents-client.ts` wraps `stop`, `steer` and `interrupt` next to `status`/`cost`, under the same rules: the method is checked against `ping.methods` first and an unadvertised method is refused with a plain reason and **no request emitted**; a malformed reply is a `protocol` failure, not a success; the owner's own error `code` and `message` are preserved.

`stop`'s semantics are modelled honestly in its return type. A successful reply is an acceptance receipt (`{ accepted: true, state: "stopping" }`), never evidence that the run terminated; the type and its doc comment say termination needs a subsequent `status` read plus process-terminal evidence. A failed stop is not reported as a timeout that implies the run died, and it carries no `ambiguous` recovery alias — the spawn retry discipline does not apply. `steer` carries instructions as data in `params.message`; no shell, code or interpolation is involved, and `deliveryStatus: "queued"` is a successful acknowledgement reported as queued rather than delivered.

Every report prints the two facts separately: what was acknowledged, then what a single follow-up public `status` read says. An accepted stop whose run is still `running`/`queued`/`stopping` says the stop has not taken effect; a run no longer listed says termination is still unproven. No command prints "已停止" for an accepted request. `/Coworkflow:lanes stop <runId>` accepts only a run id recorded for the current task in `.trellis/.runtime/native-runs.json` (and rejects a link belonging to another session before emitting); the rest of `/Coworkflow:lanes` stays read-only. When the installed owner advertises no `stop`/`steer`, the command says exactly that and sends nothing.

## Observability before a stop

A stop is only as good as the decision to issue it, so the parent's view before deciding is part of the contract, and so is its ceiling.

Attributable per run, from `status` v1 `asyncSnapshot.runs[]` (whose `id` is a real run id): state, agent, model, `startedAt`. Elapsed time is derived from `startedAt` at render time with a caller-supplied clock — no timer, no polling, no render-time RPC or filesystem scan. The goal of a dispatch is shown only from this package's own dispatch record (the task text observed at `tool_call`, with the `Active task:` routing line dropped, flattened to one line, and truncated with a visible ellipsis); it is never presented as the runner's `goal`.

Fleet-level token totals come from the bounded public fleet window. That window reports `omitted`, and a row may carry no usage or the reply may be cut at the owner's byte limit; in each case the sum is a lower bound and must be labelled incomplete with the specific reason. A window that cannot be read is unknown, never a complete zero.

The fleet DTO's `key` is an opaque display key and the DTO exposes no run, async or tool id. Fleet data therefore enriches display only: no code path joins a fleet key to a run id, and none may start doing so — that join does not exist upstream, and inventing it would attribute one run's work to another.

Live per-tool narration is unavailable: `currentAction`-style detail exists only in the external-runs display API, not in RPC `status`, and `pi.events` is process-local and does not cross into child processes. That gap is documented as a gap; it is not simulated from partial data.

## Project capacity scope

The configured Coworkflow project ceiling remains an additive compatibility policy because upstream does not document a project override. At direct `subagent` async tool and Coworkflow-owned RPC spawn boundaries, admission uses the public native top-level async counter plus local pending launches, after exact public alias correlation. Unknown count with an active configured limit refuses to launch instead of counting unknown as zero. Management operations and foreground non-async calls do not reserve an async slot; upstream remains the owner of workflow child fanout and its own runner limits.

`coworkflow.fanout` and the owner's `parallel` remain all-or-nothing batches. `coworkflow.dispatch` accepts a plan and waits for admission per unit: it keeps an in-memory, session-scoped queue, while every actual execution belongs to the native owner. Both project and kind ceilings apply before RPC spawn. The existing shared bridge reserves project slots, binds confirmed receipts and retains ambiguous emissions; the queue must not invent capacity from an absent or partial owner view. No timer, automatic retry or persistent scheduler is added.

A dependency is satisfied only by explicit successful completion. Paused, stopped, failed and unclassified notices must never release successors. Reject dependency cycles before changing queue state. Native completion of work outside the queue may prompt a fresh admission pass, but is not itself proof of a free slot. Recheck enablement and epoch after awaited admission; disabling dispatch prevents automatic continuation, and old-epoch callbacks cannot launch into the new session.

This boundary cannot govern other extensions' RPC calls, other processes, or all launchers. It is not global capacity authority. Release reservations only on proven no-launch/terminal completion or validated native reconciliation; ambiguous emissions remain reserved until reconciled or session end. No TTL, retry or private filesystem scan invents a terminal state.

## Agent kinds (typed subagent families)

A kind is a named agent definition plus its project policies (enabled, max concurrent, and optionally its own model and thinking level). Kind registration and admission are separate from queue planning. The queue submits admitted work through the native owner; it does not own child processes, retries or artifact lifetimes.

Registration uses only the installed owner's documented runtime-agent contract — its public `./agents` export and the process-local `pi-subagents:runtime-agent-register:v1` event. The event is used rather than a direct `registerRuntimeAgent` call because a direct call writes into the owner's registry whether or not any owner is loaded in this process; this package would then report a kind as available while nothing merges it into an agent list. No listener therefore means "pi-subagents is not loaded", which is a fact to report, not a registration to keep. Names are namespace-prefixed (`cw-<kind>`) so they cannot collide with the owner's builtin table or a project agent; a collision is that kind's failure and is reported as such, never retried under another name.

The same per-kind admission applies at parent `subagent` calls and queued units before RPC spawn (children neither register their own subtree nor police parent dispatch). It reads project policy from disk; it never kills a run already admitted. Occupancy comes from the public fleet projection (`status` v1 `fleet.entries[].agent`) through `core/subagents-client.ts`. Queue-owned starts provide a conservative local floor while a newly started run is not yet visible. Missing capability, an undecodable or truncated fleet DTO, or a reply after session change all refuse launch: unknown is not zero. Direct or decoded batch dispatches containing no owned agent return before a public read.

That promise holds for **batches too**, and it is a correction rather than a restatement: the batch path (our `coworkflow.fanout` and the owner's own `parallel`) used to look every name up in the kind table item by item and refuse the whole call as "an unregistered kind" when a name was not ours — so an ordinary `parallel` batch of `reviewer` / `trellis-check` tasks was refused by the per-kind gate. A batch entry is ours only when it resolves to a kind of this package; a batch with none of ours returns before `attachSubagents`, because policing agents the ceiling does not cover both refuses work it must not and costs a public round trip per fanout. A mixed batch is judged on its own entries only, and its refusal names only those entries — naming an unrelated agent would read as if that agent were over a ceiling.

The project-wide `subagentConcurrency` ceiling remains a second, coarser gate; both must admit and neither replaces the other. `maxConcurrent` is this package's policy, never a claim about the owner's own limits: its `concurrency`/`maxTasks` are not read, mutated, or presented as ours.

A kind's Trellis role is declared **once**, in its definition's `role:` frontmatter — the project's `.pi/Coworkflow/agents/<kind>.md` when it has one, otherwise the shipped asset that stands in for it (`modules/agent-kinds/assets/*.md`). `kindRole()` reads only that; the shipped kind table carries no role field, because a second declaration of the same fact is how `cw-executor` and its context end up disagreeing. `role: none` and "nothing declared" both mean no role context. `subagent-context` resolves a child's agent name to *which kind* it is, then asks that kind's definition for the role, so a child launched as `cw-executor` receives the existing role injection path — a second injection path keyed on kind is not permitted. The session name identifies a configured agent; role metadata comes from its live definition, including custom names, wrapped names and explicit `role: none`. The fixed `coworkflow.implement-review` workflow selects from enabled, registered kinds using resolved metadata (including project overrides). Injected task references use absolute paths to parent-owned artifacts, so linked-worktree children do not read a stale branch-local copy. Documentation placeholders are not task references; a real but invalid explicit task reference still fails closed. Lane records store the kind observed on the dispatch itself, for `/Coworkflow:lanes` grouping; a non-kind dispatch stores no kind rather than a guessed one.

Deployment honesty is a gate requirement, not a diagnostic: when the contract is unavailable, nothing is registered, `runtimeStatus` and the settings panel state the exact reason, and a dispatch of a declared kind is refused. A kind is never reported as available on the strength of the project's own enablement.

A kind may also carry its own `model` and `thinking` (`agentKinds.<kind>.model` / `.thinking` in `.pi/Coworkflow.json`), which travel inside the runtime agent definition rather than in a launch argument: the definition is the authoritative place for a registered agent and covers every dispatch of that kind, including a hand-written one this package never sees. `subagents.agentOverrides` is deliberately not used — it targets discovered agents, and one config field per fact is the point. Precedence is kind model → `subagents.defaultModel` → Pi's default; absent means inherit. Both fields are part of the reconcile signature, so a change re-registers instead of reading as unchanged. A stored value is validated on read and **dropped** rather than forwarded (upstream refuses an unusable model at registration, which would take the whole kind down); the writer validates and **refuses** instead, so a rejected value never becomes a setting that vanishes on the next read.

## The `trellis-*` role agents: not produced, only migrated away (project-local surface)

This package's project surface speaks kinds only. `trellis-implement` / `trellis-check` / `trellis-research` are not the recommended dispatch targets, and the reason a project this package installed does not have them is upstream of any cleanup: **the templates this package renders do not contain them.** `/Coworkflow:init` writes `.pi/agents/` from this package's own template set, so a freshly installed project never gets a `trellis-*` agent file to begin with. Their absence is a property of the template, not the outcome of a deletion step.

`retireRoleAgents()` therefore serves exactly one case — **migrating an older project**. A project set up before this package owned the surface (by an earlier version of it) may still carry those three files, and they would keep competing with `cw-*` for dispatch. The migration deletes what is there and reports what it removed; in a project whose `.pi/agents/` came from this package's template it finds nothing and says so. That case is why the function is kept rather than deleted.

Rendering is the only writer of this surface. Two sources would leave it half one thing and half another with no run reconciling them, so a refresh is another `/Coworkflow:init` (idempotent, user data untouched).

`.trellis/workflow.md` comes from the same template set. Its Pi guidance defaults to direct main-session implementation/checking; optional dispatch selects configured kinds and returns acceptance to the main session. User data beside it (`tasks/`, `spec/`, `workspace/`) is never overwritten by rendering.

## Scenario: native dispatch and task-context acceptance

### 1. Scope / trigger

Changes to child identity, task routing, completion outcomes or RPC admission require
checks at the host boundary as well as pure queue tests. A successful child receipt
does not prove that the child received its task documents.

### 2. Signatures

- `settleOutcomeOf(payload): "completed" | "failed" | "stopped" | "unknown"`
- `createDispatchQueue(deps, epoch).submit({tasks, worktree?})`
- `resolveChildTask(root, sessionName, ...texts): TaskResolution`
- `npm run verify:dispatch`: installed Pi and pi-subagents, real detached children,
  a local deterministic model provider, no external model requests.

### 3. Contracts

`tasks` has 1–24 `{key?, kind, task, needs?}` units. Only confirmed successful
completion satisfies `needs`. Return `started`, `queued`, `failed` and `unobserved`
separately; state lists agree with `snapshot()` even while dispatch is disabled.
Shutdown or an epoch change invalidates pending work; no implicit restart occurs.

The injector resolves custom/wrapped names from the current kind definitions.
`role: none` wins over inherited markers. An explicit invalid task reference stays
invalid; a documentation placeholder permits parent-pointer fallback. Emit the
absolute artifact directory for children whose cwd is a linked worktree.

The native probe sets `PI_CODING_AGENT_DIR` to a temporary isolated directory and
`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` to its installed SDK root. It loads one
build of Coworkflow. The provider inspects normalized `context.messages` system
messages; `context.systemPrompt` is not available at that provider boundary.
Use the extension event's `ctx.cwd`, not `process.cwd()`, for the child workspace.

### 4. Validation and error matrix

| Condition | Required behavior |
| --- | --- |
| Paused/stopped/failed/unknown completion | Never release dependent work as success |
| Cycle or self-cycle | Reject the submission before changing queue state |
| Gate closes during an await | Stop launches; preserve actual completion/failure evidence |
| Ambiguous spawn receipt | Retain reservation, report `unobserved`, never retry |
| Explicit missing task | Report invalid reference; never use another active task |
| Fixture loads both main and worktree builds | Invalid verification setup; isolate configuration |

### 5. Good / base / bad cases

Good: four children, two slots, capacity and dependency waiting, four distinct
worktrees, four document sentinels in every child's final model request.
Base: an unknown role receives the generic child guide.
Bad: a green subprocess exit without document evidence is called injection success.

### 6. Required tests

`scripts/dispatch-host.test.ts` drives production registration, public RPC events,
capacity, outcome classification and epoch races. `scripts/dispatch-queue.test.ts`
covers atomic cycle rejection and result/snapshot agreement, including closed gates.
`scripts/test.ts` covers role overrides, placeholders, invalid paths and prompt
idempotency. `scripts/verify-dispatch.mjs` observes real processes and final system
messages, asserts the four-child scenario, and removes its clean worktrees on success.

### 7. Wrong vs correct

Wrong: run a worktree extension alongside the user's globally configured main copy,
then interpret whichever injection block was written last as the worktree's result.
Correct: isolate the probe's agent directory, verify the loaded entry, and assert
document contents at the final provider boundary. This validates mechanical delivery;
whether a real model chooses to delegate remains a separate behavioral evaluation.

## Human authority and UI compatibility

Parent/human acceptance and integration remain authoritative. Coworkflow can report a workflow verdict and offer evidence; it never accepts/merges/publishes automatically. Failure is reported; re-dispatch/resume are explicit decisions.

The model panel retains its existing three columns, key gestures and all supported thinking levels. Its page list is computed from the configured kinds — 主会话, 子 agent（默认）, then one page per kind — so adding or removing a kind adds or removes a page, and a disabled kind keeps its page and is marked as off. Tab cycles that computed list; Left/Right still switches model/thinking columns; the session page's behaviour is unchanged. A kind page's thinking levels follow the effective model for that page (the kind's own pin, else the model it inherits). Usage uncertainty is textual within existing areas; this contract does not authorize layout redesign.

The settings panel's existing row builders and key conventions are extended, not replaced: rows gain optional `toggle` (Space) and `adjust` (Left/Right) actions, and every row that declares neither keeps Enter-only behaviour. Per-kind rows sit beside the existing project concurrency row; the global limit and the per-kind limits remain visibly distinct settings.

## Session-level worktree isolation (`session-worktree`)

Every launch path takes its `cwd` from one function, `sessionTree()` in `modules/session-worktree/index.ts`. Resolution order is a three-step ladder, each step answering on its own: the linked worktree the session was started in (that already *is* the isolation unit, so no second tree is nested inside it) → the active Trellis task's worktree, validated by `planRun` (the same four checks `/Coworkflow:run` uses) → a session worktree `../wt-cw-<token>` on branch `cw/<token>`, cut from `origin/HEAD`'s branch (falling back to the checked-out branch).

Two properties are load-bearing:

- **Placement is one decision, not a per-launch flag.** A direct dispatch and a named workflow get `cwd` through `tool_call` injection (pi allows mutating `event.input`, `docs/extensions.md`), and `coworkflow_dispatch` passes it on the RPC `spawn` call. Only calls that start children are placed — `action` calls (`status`, `stop`, `steer`, `validate`, …) launch nothing and are never rewritten, and an explicit `cwd` from the caller is left alone.
- **No silent fallback.** A tree that cannot be established (no repository, `worktree add` failure, a same-named branch or directory that is not this session's) refuses that launch with the reason. Falling back to the shared checkout is the exact failure the module exists to remove, so it is not an option the code takes.

A fresh worktree symlinks `.trellis/{tasks,scripts,workspace,config.yaml,workflow.md}` and `.pi` from the main checkout — the same set and the same reason as `auto_worktree.py`: a linked worktree holds committed files only, and a child that cannot read its PRD, the spec, or the kind definitions is a child working blind. Symlinked, never copied, so there is one record rather than two histories.

One limit of that symlinking is load-bearing and must not be papered over: it only fills paths the checkout does **not** already have. A project that tracks `.pi/` or `.trellis/` gets the committed copy instead, because replacing a tracked path with a symlink makes the worktree unmergeable — `git merge` refuses with `'.pi/settings.json' is beyond a symbolic link`, and `skip-worktree` does not rescue it (verified in a scratch repository, all three variants). The consequence is that the records a child reads by relative path may be the base snapshot while the parent's are live, which is why the subagent model is passed explicitly rather than discovered from the child's directory (next section).

`/Coworkflow:merge` is the only path from a session branch back to the base, and it is deliberately conservative: a dirty tree is refused, zero commits ahead reports nothing to do, the merge is `--no-ff` on the base branch that is actually checked out (a detached HEAD or a different branch is refused rather than switched), a conflict stops the command with the conflicted paths and the `merge --abort` way out, and nothing is pushed or deleted. Session end never removes a worktree whose work is unmerged or uncommitted.

The module declares no `newSwitchDefault`, which means on: unlike `capacity`, which refuses work a project asked for, this one *places* work the project already asks for into the checkout its own rules say it belongs in. `scripts/session-worktree.test.ts` pins the ladder, the dirty-checkout case, idempotent reuse, both refusals, the manifest, `inspectTree`, the merge preconditions and the status line.

## Concurrent writers in one worktree (`coworkflow_dispatch` `files`)

Children of one session share one working tree, so two of them writing the same file is not a merge conflict anyone can resolve later — it is one child silently overwriting another, and Git has nothing to report because no merge happens. The queue's answer splits by what it can actually know:

- **Declared write sets are enforced.** A unit may pass `files` (paths relative to the checkout); `files: []` is a real declaration meaning "writes nothing", which is how a reader/auditor kind runs beside writers. Before a launch, a declared unit waits (`reason: "overlap"`) for any running or unconfirmed unit whose declared paths it intersects, and the completion that follows releases it. `overlapOf` compares by path segment, so a declared directory covers its contents (`src/dispatch` vs `src/dispatch/index.ts`) while a prefix that is not a segment does not (`src/dispatch-extra`).
- **Undeclared units are reported, not guessed at.** An unknown write set stays parallel — refusing or serializing every batch would trade a working feature for a supposition — and instead the result carries `notice`, naming the units that are running without a declaration and why that is a risk. `renderDispatchResult` prints it. Two or more such units is the trigger; one alone is not a shared-writer situation.

The honest limit is the point: enforcement where the queue has knowledge, a stated fact where it does not. `scripts/dispatch-queue.test.ts` pins the overlap queue-and-release, disjoint parallelism, directory coverage, the read-only declaration, and the notice (including that it does not fire for declared units).

`files` is enforced by the queue, so the tool schema that reaches the model has to carry the field — a queue-only field is a check that never runs. `scripts/dispatch-queue.test.ts` asserts both `needs` and `files` are in the registered parameters, because the overlap tests drive `createDispatchQueue` directly and would otherwise keep passing while the production entry point could not declare anything.

## The child's model is resolved by the parent, not by the child

`subagents.defaultModel` / `defaultProvider` live in `.pi/settings.json`, and the owner resolves them from the **child's** working directory. That is not the directory `/Comodels` writes to: the panel writes the main checkout, while children run in a session worktree cut from a commit, so a project setting that was never committed is not in it. The result was silent — children ran on a different model than the panel reported, and nothing said so.

The repair puts the inherited default on the same footing the per-kind pages already had (a kind's model travels inside the registration the parent owns): `childModelFor()` in `modules/agent-kinds/index.ts` reads the declaration through `readDeclaredSubagentModel` from the parent's config root, checks it against the host's live registry, and the launch paths write the result in:

- the `tool_call` gate writes `model` for **every** dispatch, kind or plain agent, and per entry for a batch (`args.tasks`), because `reviewer` and `trellis-check` read the same file;
- `coworkflow_dispatch` resolves it in the tool `execute` and carries it on `DispatchInput.model` → `LaunchRequest.model` → the RPC `spawn`, since an RPC spawn never passes through `tool_call`.

An explicit `model` in the call always wins. A declaration that cannot be resolved (malformed, absent from the registry, provider without credentials) **refuses the dispatch** with the reason instead of launching on a model nobody chose — the silent fallback is the failure being removed, so it cannot be the fallback. A host that cannot enumerate models is not evidence that a model is missing, so it passes through.

Deliberately model-only: the owner also accepts a `:level` suffix, and that suffix wins over an agent definition's own `thinking`, so attaching `subagents.defaultThinking` here would silently override a kind that pinned a level. `scripts/agent-kind-models.test.ts` pins the resolution cases, the refusals, the three launch shapes, and that an explicit model survives.
