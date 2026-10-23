const cwd = "/Users/lyston/PycharmProjects/wt-10-22-kind-models";
const dir = ".trellis/tasks/10-22-kind-models";
const model = "buddy2api/deepseek-v4.1-flash";
const intro = `Active task: ${dir}\nYou are the assigned child; implement directly without further delegation. Work ONLY in ${cwd}. The main checkout and the installed pi-subagents package (/Users/lyston/.pi/agent/npm/node_modules/pi-subagents) are READ-ONLY: never edit them. Do not commit, push, merge, change task lifecycle state, or run /Coworkflow:init against any real project. Read prd.md, design.md and implement.md first, then only the exact files and direct callers involved. Do not crawl node_modules. Preserve every existing behaviour (kind gate, settings panel, workflows, usage, lanes).\n\nRun \`npx tsc --noEmit\` and \`npm test\` before handing off, and report the real numbers. Save a short handoff immediately after the checks pass; do not spend the remaining budget on optional extra verification. If something is genuinely blocked, report it instead of claiming success. The native output binding is authoritative: return its ACTUAL path in structured handoff.\n`;
const schema = {type:"object", properties:{status:{type:"string",enum:["completed","blocked"]},summary:{type:"string"},handoff:{type:"string"}},required:["status","summary","handoff"]};
const options = {agent:"trellis-implement",model,cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:180000,outputSchema:schema,acceptance:{level:"none",reason:"parent runs the full suite and audits the diff"}};
const s1 = await runs.run("plumbing",{...options,task:intro+`
Stage 1 only, per implement.md: a kind's model and thinking level become project config and reach the runtime agent definition.

1. core/config.ts: AgentKindConfig gains model?: string and thinking?: string. parseAgentKinds validates both and DROPS a malformed value rather than forwarding it — upstream fails a launch on an unusable model, so a stored typo would take the whole kind down and surface as "dispatch refused" instead of "that model id is wrong". A model is a non-empty string with no control characters, length-bounded; a thinking level is a member of the known set (read the set from the module that already owns it; do not invent a second list).
2. modules/agent-kinds/defaults.ts: ResolvedAgentKind carries model/thinking and resolveKinds passes them through.
3. modules/agent-kinds/registration.ts: KindDefinition and DesiredKind carry model/thinking, and signature() MUST include them — reconcile compares signatures, so a model change that is not in the signature is read as "unchanged" and the agent keeps the old model. That would be a panel writing a setting the session does not use.
4. modules/agent-kinds/index.ts: build the definition with them.
5. core/module.ts setAgentKind patch type + the implementation in extensions/coworkflow.ts: accept model?: string | null and thinking?: string | null, null deletes the key (back to inherit), and validation returns a message rather than throwing.
6. /Coworkflow:status: one line per kind that names its model, or says it inherits.

Focused tests in an existing or new scripts/*.test.ts wired into package.json: malformed stored model/thinking dropped; valid values resolve; a model change alters the definition signature so reconcile re-registers; clearing returns to inherit; the status line distinguishes pinned from inherited.
`});
if(!s1.ok || s1.structuredOutput?.status!=="completed") throw new Error("Stage 1 did not complete: "+s1.output);
const s2 = await runs.run("panel-pages",{...options,task:intro+`
Read the Stage 1 handoff at ${s1.structuredOutput.handoff} first — do not redo it.

Stage 2 only, per implement.md and design.md "Panel pages": /Comodels stops being a hardcoded 主会话/子agent pair.

1. modules/panel/shared.ts: Tab becomes "session" | "subagent" | \`kind:\${string}\`; modelRows/thinkingRows take the resolved tab and the kind entry.
2. The page list is COMPUTED from control.agentKinds(): 主会话, 子 agent（默认）, then one page per kind labelled \`<label> <agent>\` (e.g. 执行者 cw-executor). Adding a kind adds a page, removing one removes it; a disabled kind keeps its page and says it is off (its stored model still applies the moment it is switched on).
3. A kind page shows that kind's model and its thinking levels: the kind's own model's levels when it pins one, otherwise the session model's — the rule the default page already uses, applied per kind. It also states 继承 vs 固定.
4. Applying on a kind page calls control.setAgentKind(kind, { model, thinking }); clearing calls it with null. The default page keeps writing subagents.defaultModel/defaultProvider/defaultThinking unchanged.
5. The existing key behaviour on the session page must not regress (↑↓ within a column, ←→ between the 模型/思考 columns, Tab between pages, Space/Enter to apply, Esc to close, typing to filter).

Focused tests: the page list follows configured kinds (three kinds -> five pages; removing one -> four; a disabled kind keeps its page); applying a kind model writes the config and re-registers that agent with that model; clearing returns to inherit; thinking levels on a kind page follow the kind's own model.
`});
if(!s2.ok || s2.structuredOutput?.status!=="completed") throw new Error("Stage 2 did not complete: "+s2.output);
const review = await runs.run("review",{agent:"trellis-check",model,cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:180000,task:intro+`
READ ONLY final check of this task's delta. Handoffs: ${s1.structuredOutput.handoff} (stage 1), ${s2.structuredOutput.handoff} (stage 2). Do not edit anything, do not commit.

Verify by driving PRODUCTION code, not by reading test assertions:
1. A malformed stored model or thinking level is dropped, and a valid one reaches the registered agent definition. Check the definition the owner actually holds, not our own copy.
2. Changing a kind's model changes the reconcile signature, so the agent is re-registered rather than left with the old model. This is the failure that would make the panel a lie; prove it end to end.
3. Clearing a kind's model returns it to inherit, and the definition then carries no model.
4. Precedence holds: kind model beats subagents.defaultModel beats Pi's default.
5. The /Comodels page list is computed, not hardcoded: with three kinds configured there are five pages; remove a kind from the config and its page disappears; a disabled kind keeps its page and says it is off.
6. A kind page's thinking levels follow the kind's own model when it pins one, and the session model's when it inherits.
7. The existing panel key behaviour on the session page still works, and the settings panel and the kind gate are unchanged.
Run \`npx tsc --noEmit\` and \`npm test\` once and report the real summary. Read only the files the design names plus their direct callers; do not crawl node_modules. Save a bounded report: BLOCKERS with file:line and reproduction, or no blockers plus practical limitations. The parent owns acceptance, integration and cleanup.
`});
if(!review.ok) throw new Error("Final check failed; worktree preserved. "+review.output);
return {taskDir:dir,cwd,needsParentAcceptance:true,results:[{key:"plumbing",runId:s1.runId,handoff:s1.structuredOutput.handoff},{key:"panel-pages",runId:s2.runId,handoff:s2.structuredOutput.handoff},{key:"review",runId:review.runId,output:review.output}]};
