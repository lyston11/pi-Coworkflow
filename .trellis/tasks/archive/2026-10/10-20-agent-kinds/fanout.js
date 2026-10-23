const cwd = "/Users/lyston/PycharmProjects/wt-10-20-agent-kinds";
const dir = ".trellis/tasks/10-20-agent-kinds";
const model = "buddy2api/deepseek-v4.1-flash";
const intro = `Active task: ${dir}
You are the assigned child; implement directly without further delegation. Work ONLY in ${cwd}. The main checkout and the installed pi-subagents package (/Users/lyston/.pi/agent/npm/node_modules/pi-subagents) are READ-ONLY. Do not commit, push, or change task lifecycle state.

OTHER CHILDREN ARE RUNNING: one is concurrently writing core/subagents-client.ts, modules/lane-worktree/index.ts and the panel facts path. Those three files are OFF LIMITS to you. If you need something from them, read them with \`git show 9083af5:<path>\` and state the dependency in your handoff instead of editing them.

Read first: .trellis/tasks/10-20-agent-kinds/{prd.md,design.md,implement.md}, core/subagents-workflow.ts (the registered implement-review workflow: WORKFLOW_NAME, resolveImplementReview, registerImplementReviewWorkflow), modules/subagents/index.ts (schedule/registration and command registration), core/ledger.ts or wherever a dispatch is recorded, and extensions/coworkflow.ts (runtimeStatus/status lines). Read only those plus their direct callers; no node_modules crawling.

UPSTREAM FACTS (verified, do not re-derive): a trusted extension registers a named workflow through the public pi-subagents/workflow-resources export (registerWorkflowResource), which is exactly what this package already does for coworkflow.implement-review. Inside a workflow script, runs.run(key, opts) starts one child and \`await\`s it; children started inside Promise.all run concurrently. The owner enforces its own run fan-out and concurrency budget.
`;
const schema = {type:"object", properties:{status:{type:"string",enum:["completed","blocked"]},summary:{type:"string"},handoff:{type:"string"}},required:["status","summary","handoff"]};
const task = intro + `
THE DEFECT YOU ARE FIXING (stated by the operator, and demonstrated in this very task directory): the layer has no idea whether a dispatch COULD have been parallel, and gives no signal either way. Evidence lives in .trellis/tasks/10-20-agent-kinds/: workflow.js and workflow2.js await runs.run one after another (serial), while review-parallel.js and review2.js use Promise.all (parallel) — same extension, same capability; the only difference is how the script was written. Serial dispatch of independent work is common, invisible, and slow, and a previous attempt to fix it by injecting a tool-count reminder into the conversation was removed because a custom message reaches the model as a user turn and disrupts the work it describes.

So the fix must be STRUCTURAL and must NOT inject anything into the conversation.

IMPLEMENT THREE THINGS.

1. core/subagents-workflow.ts — register a second named workflow resource, \`coworkflow.fanout\`, next to coworkflow.implement-review. Purpose: make "run N independent children" a workflow you pick, not a script you have to write correctly. Requirements:
   - args: { tasks: Array<{ agent: string; task: string }>, } plus optional bounded extras you judge necessary; validate strictly (1..8 tasks, non-empty agent and task strings, reject unknown fields — follow resolveImplementReview's existing validation style and error wording).
   - each child starts with context "fresh", its own worktree:false, and its own acceptance/outputSchema so one child cannot silently pass for another;
   - the children run CONCURRENTLY (Promise.all over runs.run), not in a loop of awaits — that property is the entire point, and it must be obvious in the code;
   - one child failing must not cancel its siblings: collect per-task outcomes and return { status, results: [{key, ok, summary, handoff}] }. Fail-closed only when every task failed;
   - the return value must say plainly that a green fanout is completed execution, not accepted work: the parent still audits. Reuse the existing wording/pattern from implement-review's \`acceptance: "parent-owned"\`;
   - register it in the same function/flow as the existing workflow so one session either has both or reports why neither does (do not add a second registration path, and keep dispose/replace semantics identical).
2. Record whether dispatches actually overlapped, and report it as a FACT the parent can read — never as a conversation message. The dispatch record already stores when a run was linked; add the minimum needed (e.g. a settled/end timestamp, or the launch time) so overlap can be computed without guessing, then surface ONE line in /Coworkflow:status: e.g. \`派单重叠: 3 次并行、5 次串行（本次会话）\`. Treat "unknown" as unknown when timestamps are missing — never count a missing interval as serial. Do not touch modules/lane-worktree/index.ts or the panel; note in the handoff that the lanes line can pick the same measurement up later.
3. Documentation — README.md and .trellis/spec/frontend/subagents-integration.md: document coworkflow.fanout as the default way to run independent children, state explicitly that independent work dispatched one-at-a-time is a defect this layer measures rather than nags about, and record why the old conversation-injected reminder was removed (a custom message becomes a user turn).

TESTS in a focused file (wire it into package.json's test script if new): fanout validation rejects 0 tasks, >8 tasks, empty agent/task, unknown fields; a 3-task fanout starts all three WITHOUT awaiting sequentially (assert the start order/timing, not just the result); one failing child leaves the others' results intact and marks status accordingly; all-failed is fail-closed; the overlap measurement counts a genuinely concurrent pair as parallel, a strictly sequential pair as serial, and missing timestamps as unknown rather than serial; and no workflow path writes a message into the conversation (assert the host's sendMessage was never called by the workflow itself).

Drive production functions, not stubs of them. Run \`npx tsc --noEmit\` and your focused test file; run the full \`npm test\` once at the end only if it is quick, and report the real numbers. Then save the handoff immediately. The native output binding is authoritative: return its ACTUAL path in structured handoff.`;
const r = await runs.run("fanout",{agent:"trellis-implement",model,cwd,context:"fresh",worktree:false,timeoutMs:2400000,checkpointBeforeDeadlineMs:150000,outputSchema:schema,acceptance:{level:"none",reason:"parent runs the full suite and audits the diff"},task});
if(!r.ok || r.structuredOutput?.status!=="completed") throw new Error("fanout work did not complete: "+r.output);
return {needsParentAcceptance:true,handoff:r.structuredOutput.handoff,summary:r.structuredOutput.summary};
