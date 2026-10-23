const cwd = "/Users/lyston/PycharmProjects/wt-10-22-kind-models";
const dir = ".trellis/tasks/10-22-kind-models";
const model = "buddy2api/deepseek-v4.1-flash";
const intro = `Active task: ${dir}\nYou are the assigned child; implement directly without further delegation. Work ONLY in ${cwd}. The main checkout and the installed pi-subagents package are READ-ONLY. Do not commit, push, merge, or change task lifecycle state. Do not run /Coworkflow:init against any real project. Read prd.md, design.md, implement.md and then the review report .trellis/tasks/10-22-kind-models/report.review.md — it is the specification for this job. Read only the files it names plus their direct callers; do not crawl node_modules.\n\nRun \`npx tsc --noEmit\` and \`npm test\` before handing off and report the real numbers. Save the handoff immediately after the checks pass; do not spend the remaining budget on optional extra verification. If something is genuinely blocked, report it rather than claiming success. The native output binding is authoritative: return its ACTUAL path in structured handoff.\n`;
const schema = {type:"object", properties:{status:{type:"string",enum:["completed","blocked"]},summary:{type:"string"},handoff:{type:"string"}},required:["status","summary","handoff"]};
const options = {agent:"trellis-implement",model,cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:180000,outputSchema:schema,acceptance:{level:"none",reason:"parent runs the full suite and audits the diff"}};
const s1 = await runs.run("fix-blockers",{...options,task:intro+`
Fix exactly the two blockers plus the four limitations the review reports. Nothing else.

B1 — on a kind page, Enter with the cursor untouched silently replaced the kind's stored model. Three causes, all three must go:
(a) modules/panel/shared.ts:245 strips ANY \`:word\` suffix, so \`ollama/llama3:latest\` and \`openrouter/x:free\` fail to resolve. Strip only a KNOWN thinking-level suffix, reusing the existing level check rather than adding a second list.
(b) modules/panel/models.ts:161-163 falls back to the INHERITED model as \`effectiveModel\` when a pin cannot be resolved, so the inherited model is presented as the kind's and the row for it is marked current. A pinned-but-unresolved model must stay unresolved: leave effectiveModel undefined for that case and say the model is not in the registry. Do not silently substitute the inherited model anywhere the value could be written back.
(c) shared.ts:273 \`current: key === current || (current !== "" && key === effective)\` double-marks rows. Mark the stored value as current; mark a row via \`effective\` only when there is no stored value. After this, a kind with a pin must seed the cursor on the PINNED row, and Enter without moving must write back the same value it started with — prove that with a test, including the unresolvable-pin case.

Also close the fourth limitation while you are in modelForRef: a bare id that matches more than one provider is ambiguous, not "the first match" — treat it as unresolved (upstream's own resolver returns undefined on ambiguity).

L1 — an unknown-but-well-formed model id is only caught at launch. The panel is where the user types it, and it has the model registry: refuse to write a model the registry cannot resolve, with a message naming the id and saying it is not in the current model registry, and do not touch the config in that case. Keep it possible to clear a pin (the inherit row must still work).

L2 — with the agent-kinds module off, the kind pages still accept writes. Show that state on the page (the layer is off in this session, so nothing is registered) so a write is not silently meaningless.

L3 — modules/panel/models-panel.ts:405 names \`.pi/settings.json\` for a kind page; a kind page writes \`.pi/Coworkflow.json\`. Fix the label.

Docs: the PRD acceptance and README/spec claim "adding a kind adds a page, removing one removes it", but the page list is derived from the shipped kind table, which is correct — a kind needs an asset this package ships. State the truth precisely in README and .trellis/spec/frontend/agent-kinds.md and correct the PRD wording: one page per SHIPPED kind, the panel holds no kind list of its own, and shipping a new kind adds its page with no panel change. A declared-but-unshipped kind keeps no page and stays reported by the status line.

Tests: add the case the review says is missing — drive the REAL control surface and assert the page list equals what control.agentKinds() resolves (so the test proves the source, not a hand-built snapshot), that a disabled kind keeps its page and says it is off, and the B1 reproductions from the review: a pin outside the session's model scope, and a pin whose id carries a non-level colon suffix, each with Enter-and-no-movement leaving the stored value unchanged.
`});
if(!s1.ok || s1.structuredOutput?.status!=="completed") throw new Error("Fix stage did not complete: "+s1.output);
const review = await runs.run("recheck",{agent:"trellis-check",model,cwd,context:"fresh",worktree:false,timeoutMs:1500000,checkpointBeforeDeadlineMs:180000,task:intro+`
READ ONLY re-check. The fix handoff is at ${s1.structuredOutput.handoff}. Do not edit anything, do not commit.

Re-drive the two blockers the previous review reproduced, through the real extension and the installed owner:
1. A kind pinned to a model outside the session's model scope: open its page, press Enter with no cursor movement, and assert the stored value and the live registration are UNCHANGED. Do the same for a pin whose id contains a colon that is not a thinking level (ollama/llama3:latest, openrouter/x:free). Report the actual rows and the actual stored value.
2. A kind with no pin: the inherit row must be the current one, and Enter there must still clear/keep inherit — the fix must not have made the inherit action unreachable.
3. An unknown-but-well-formed model id must be REFUSED at write time with the config untouched, while clearing a pin still works.
4. The page list must equal what control.agentKinds() resolves when driven through the real control surface, not a hand-built snapshot; a disabled kind keeps its page and says it is off; the kind page's scope label names .pi/Coworkflow.json.
5. No regression on the session page keys, the settings panel, or the kind gate.
Then re-confirm the three things the previous review already verified that this fix could plausibly have broken: a model change still changes the signature so the agent re-registers; clearing still removes the key; precedence kind -> default -> Pi still holds.
Run \`npx tsc --noEmit\` and \`npm test\` once and report the real summary. Save a bounded report: BLOCKERS with file:line and reproduction, or no blockers plus practical limitations. Parent owns acceptance, integration and cleanup.
`});
if(!review.ok) throw new Error("Re-check failed; worktree preserved. "+review.output);
return {taskDir:dir,cwd,needsParentAcceptance:true,results:[{key:"fix-blockers",runId:s1.runId,handoff:s1.structuredOutput.handoff},{key:"recheck",runId:review.runId,output:review.output}]};
