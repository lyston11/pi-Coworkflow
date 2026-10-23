const cwd = "/Users/lyston/PycharmProjects/wt-10-20-agent-kinds";
const model = "buddy2api/deepseek-v4.1-flash";
const intro = `Active task: .trellis/tasks/10-20-agent-kinds
You are the assigned child; implement directly without further delegation. Work ONLY in ${cwd}. The main checkout and the installed pi-subagents package are READ-ONLY. Do not commit, push, or change task lifecycle state.

ANOTHER CHILD IS WRITING core/subagents-workflow.ts, modules/subagents/index.ts and README.md right now. Those are OFF LIMITS. Do not edit them. If you believe they need a change, describe it in your handoff instead.

Read first: .trellis/tasks/10-20-agent-kinds/{prd.md,design.md}, .trellis/spec/frontend/agent-kinds.md, core/subagents-client.ts (formatRunSummary, NativeCostChild.sessionFile, decodeCost), core/usage.ts (the existing bounded child sessionFile reader — reuse its discipline, do not invent a second pattern), modules/panel/settings.ts.

CONTEXT: the docs currently say a parent cannot see live per-tool activity because pi.events does not cross processes. That is true of the event bus, but it is not the end of the story: the public cost reply gives each child an attributable \`sessionFile\`, and this package ALREADY reads those files (bounded, exact absolute pointer, no directory scanning) to build child usage history. The child's own session log is Pi's own format, and its last entries say what the child is doing. So "current action" is obtainable by reading the tail of a file we already legitimately read — it is not a live event stream, and it must be described as a tail read of the child's own session record, never as real-time narration.

IMPLEMENT:
1. New file \`core/child-tail.ts\`. Export a bounded reader: given an absolute \`sessionFile\`, return the child's most recent activity. Requirements:
   - Read only a bounded TAIL (e.g. last 64 KiB via open/read at an offset, reusing the discipline in core/usage.ts: exact absolute path, O_NONBLOCK, stat first, reject non-files, no globbing, no directory listing).
   - Parse JSONL defensively: the file may be mid-append, so drop unparseable lines including a partial final line rather than failing the whole read.
   - Extract, in this order of preference: the last tool invocation (tool name plus a short, safe argument hint — a path or command, never a full prompt or file body, truncated to a small budget), else the last assistant text (truncated), else null.
   - Also return \`turns\` (count of parsed entries) and \`stale\`/nothing-parseable as an explicit absence, not an empty string.
   - Never throw: a permission error, a vanished file, or a malformed log is an explicit "unknown + reason", the same way the rest of this package treats unreadable data.
2. Wire it at the EXISTING refresh boundaries only (the same places usage/status refresh: session start, agent_settled, native completion, panel open). No timers, no polling, no reading from a render or a key handler. Cache the result keyed by runId, and drop entries for runs that are no longer active.
   Attribution must come from the public \`cost\` reply's \`child.runId\` + \`child.sessionFile\` pair — that is a real run id. NEVER join a fleet row to a run id (its key is an opaque display key); this must remain true.
3. Surface it: \`formatRunSummary\` in core/subagents-client.ts gains the current action for a run when the tail reader has one, phrased so the source is unambiguous (e.g. \`正在 <action>（读自子会话日志尾部）\`). When there is no tail, say nothing rather than inventing an empty action. The panel facts block shows the same line. Keep everything bounded — this list must not grow with turns.
4. Update the honest-limits wording: README.md and .trellis/spec/frontend/agent-kinds.md currently say live activity is unobtainable. Replace it with the accurate statement: a live event stream across processes is not available; a bounded tail read of the child's own session file is, when the public cost reply attributes one, and it lags the child by whatever it has flushed.
5. Tests in a focused new file (wire into package.json's test script): a well-formed tail yields the last tool action; a mid-append partial final line is dropped and the previous entry is used; a huge file is only tail-read (assert the read offset/size, not just the result); a missing/unreadable file is an explicit unknown with a reason and throws nothing; the action hint truncates a long argument and never carries a whole file body; no timer or interval is registered; and a fleet key is still never treated as a run id.

Drive production code, not stubs. Run \`npx tsc --noEmit\` (the other child's in-flight files may not compile — ignore errors whose paths are subagents-workflow.ts/subagents/index.ts and say so) and your focused test file. Then save the handoff immediately with the actual output-binding path. If something cannot be done honestly, deliver the honest gap and record it, rather than fabricating a field.`;
const schema = {type:"object", properties:{status:{type:"string",enum:["completed","blocked"]},summary:{type:"string"},handoff:{type:"string"}},required:["status","summary","handoff"]};
const task = intro;
const r = await runs.run("child-tail",{agent:"trellis-implement",model,cwd,context:"fresh",worktree:false,timeoutMs:2400000,checkpointBeforeDeadlineMs:150000,outputSchema:schema,acceptance:{level:"none",reason:"parent runs the full suite and audits the diff"},task});
if(!r.ok || r.structuredOutput?.status!=="completed") throw new Error("child-tail work did not complete: "+r.output);
return {needsParentAcceptance:true,handoff:r.structuredOutput.handoff,summary:r.structuredOutput.summary};
