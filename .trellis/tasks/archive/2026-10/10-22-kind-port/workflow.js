const cwd = "/Users/lyston/PycharmProjects/wt-10-22-kind-port";
const dir = ".trellis/tasks/10-22-kind-port";
const model = "buddy2api/deepseek-v4.1-flash";
const intro = `Active task: ${dir}\nYou are the assigned child; implement directly without further delegation. Work ONLY in ${cwd}. The main checkout and the installed pi-subagents package are READ-ONLY: never edit them. Do not commit, push, merge, or change task lifecycle state, and do not run /Coworkflow:init against any real project. Read prd.md, design.md and implement.md first, then only the exact files and direct callers involved — do not crawl node_modules.\n\nRun \`npx tsc --noEmit\` and \`npm test\` before handing off and report the real numbers. Save a short handoff as soon as the checks pass; do not spend the remaining budget on optional extra verification. If something is genuinely blocked, report it rather than claiming success.\n`;
const schema = {type:"object", properties:{status:{type:"string",enum:["completed","blocked"]},summary:{type:"string"},handoff:{type:"string"}},required:["status","summary","handoff"]};
const options = {agent:"trellis-implement",model,cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:180000,outputSchema:schema,acceptance:{level:"none",reason:"parent runs the full suite and audits the diff"}};
const a = await runs.run("definitions",{...options,task:intro+`
Stage A only, per implement.md: a project can define kinds in .pi/Coworkflow/agents/<kind>.md and the resolved kind table becomes the single source everything downstream reads.

New modules/agent-kinds/definitions.ts: locate .pi/Coworkflow/agents/, read *.md (bounded count and size, sorted, no recursion), parse a small YAML-subset frontmatter (key: value, comments, quoted strings) plus the body, validate every field per design.md, and return either a definition or a failure with a reason. Unknown frontmatter keys are rejected: a typo that silently does nothing is worse than a refusal. No new dependency.

Then make resolution read it: resolveKinds(config, definitions) with per-kind source (file | shipped) and per-field provenance (project config vs definition default), keeping the shipped table as the fallback definition and DEFAULT_MAX_CONCURRENT as the last default. The gate and registration must cover custom kinds, not just shipped ones. modules/subagent-context/index.ts must resolve a kind's role from the table so a custom kind's agent name maps to its declared role and role: none injects no role context — that code runs in the CHILD process, so it reads config + definitions there, stays cheap, and never throws. extensions/coworkflow.ts control.agentKinds() returns the resolved table.

Failure isolation is the point of this stage: a malformed file, an unusable or duplicate agent name, a name outside the cw- namespace, a bad model/thinking/maxConcurrent, or an empty prompt body fails THAT KIND ONLY with the reason reported; every other kind keeps working; an unreadable directory is "no definitions" rather than an error; and a kind that failed cannot be dispatched, using the same wording the disabled/unregistered refusals already use.

Tests in a focused file wired into package.json, driving production functions: an override changes prompt/label/role; a new kind appears; agent: renames; each malformed-field case fails only that kind; duplicate agent name fails it; role: none injects no role context; an unreadable directory yields no definitions and no failure.


Finish by calling structured_output with status (completed | blocked), summary, and handoff — the ACTUAL path the native output binding used, never an invented one.`});
if(!a.ok || a.structuredOutput?.status!=="completed") throw new Error("Stage A did not complete: "+a.output);
const b = await runs.run("diy-surface",{...options,task:intro+`
Read the Stage A handoff at ${a.structuredOutput.handoff} first — do not redo it.

Stage B only, per implement.md: the surface anyone — including an agent — uses to define kinds.

1. /Coworkflow:kind with subcommands: list (id, agent, role, source file/shipped, on/off, limit, model), show <kind>, set <kind> key=value … (validated, writes the definition file, re-syncs, reports what changed), remove <kind> (deletes a definition file, and refuses to delete anything outside the definitions directory). Creating a new id is set on an unknown id. Every write validates BEFORE touching the file, so a rejected value leaves the file byte-identical.
2. A public event-bus request coworkflow:kind-define:v1 that writes the SAME file through the SAME writer and re-syncs. Capability-checked like the other public surfaces; a malformed payload is a refusal, never a partial write. Do not add an in-memory-only registration path: a kind that exists only in memory disappears on /reload, which is the opposite of this feature's promise.
3. /Coworkflow:status reports each kind's source, and for a failed kind its reason.

Tests: set writes a valid file and the agent is registered without a restart; a rejected value leaves the file untouched; remove deletes only inside the definitions directory and refuses otherwise; the RPC writes the same file the command does and refuses a malformed payload.


Finish by calling structured_output with status (completed | blocked), summary, and handoff — the ACTUAL path the native output binding used, never an invented one.`});
if(!b.ok || b.structuredOutput?.status!=="completed") throw new Error("Stage B did not complete: "+b.output);
const c = await runs.run("surfaces",{...options,task:intro+`
Read the Stage B handoff at ${b.structuredOutput.handoff} first — Stages A and B are done and must not be redone.

Stage C only, per implement.md:
1. /Comodels and /Coworkflow:settings show a resolved CUSTOM kind (its own page and its own row) and a FAILED kind (a row naming the reason rather than a missing row — a silently absent kind is indistinguishable from one never defined). Both panels already compute from control.agentKinds(); make sure the resolved table reaches them and that nothing in the panel assumes the shipped three.
2. scripts/verify.ts gains a probe that renders the model panel with a custom kind configured, so the harness can drive this without a TUI.
3. README and .trellis/spec/frontend/agent-kinds.md: the port, the file format with a copyable example, precedence (definition = what a kind IS, project config = what the project CHOSE and always wins), hot reload on /reload plus the command, failure isolation, and the DIY command/RPC.

Run the full suite. Report the real numbers.


Finish by calling structured_output with status (completed | blocked), summary, and handoff — the ACTUAL path the native output binding used, never an invented one.`});
if(!c.ok || c.structuredOutput?.status!=="completed") throw new Error("Stage C did not complete: "+c.output);
const review = await runs.run("review",{agent:"trellis-check",model,cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:180000,outputSchema:{type:"object",properties:{verdict:{type:"string",enum:["no-blockers","blockers"]},summary:{type:"string"},blockers:{type:"array",items:{type:"string"}}},required:["verdict","summary","blockers"]},task:intro+`
READ ONLY final check. Handoffs: ${a.structuredOutput.handoff} (A), ${b.structuredOutput.handoff} (B), ${c.structuredOutput.handoff} (C). Do not edit anything, do not commit.

Drive PRODUCTION code — the real extension, the real control surface, the installed owner as registration owner, temp projects under $TMPDIR:
1. A project file named executor.md overrides the shipped executor: the registered agent's description/prompt change, and a child's injected context carries the NEW prompt and the declared role. Verify from what the child would actually receive, not from our own copy of the table.
2. A file for a new kind registers a new agent, gets its own /Comodels page and its own /Coworkflow:settings row, its own gate refusal when disabled, its own concurrency limit, and its children get the declared role's Trellis context. A custom kind with role: none gets no role injection.
3. agent: renames the agent and the gate, role mapping, panel and report all follow the new name.
4. An edited definition is picked up by re-activation (the /reload path) and by /Coworkflow:kind set, with no restart.
5. Each malformed case fails only that kind, is reported with its reason, and the broken kind is refused at dispatch; the other kinds still work.
6. The project config still wins over a definition default, and the report distinguishes chosen from defaulted.
7. Deleting a custom kind's file removes the agent; deleting an override restores the shipped definition.
8. The RPC and the command write the same file and leave it byte-identical when a value is rejected.
Run \`npx tsc --noEmit\` and \`npm test\` once and report the real summary. Finish by calling structured_output with verdict (no-blockers | blockers), summary, and blockers (each with file:line and reproduction; empty array when verdict is no-blockers). Parent owns acceptance, integration and cleanup.
`});
if(!review.ok) throw new Error("Final check failed; worktree preserved. "+review.output);
return {taskDir:dir,cwd,needsParentAcceptance:true,results:[{key:"definitions",runId:a.runId,handoff:a.structuredOutput.handoff},{key:"diy-surface",runId:b.runId,handoff:b.structuredOutput.handoff},{key:"surfaces",runId:c.runId,handoff:c.structuredOutput.handoff},{key:"review",runId:review.runId,verdict:review.structuredOutput?.verdict,summary:review.structuredOutput?.summary,blockers:review.structuredOutput?.blockers}]};
