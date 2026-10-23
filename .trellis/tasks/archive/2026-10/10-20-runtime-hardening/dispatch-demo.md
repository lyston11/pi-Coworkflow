Workflow completed with 3 child run(s). Return: {
  "ok": true,
  "children": [
    {
      "key": "task-1",
      "agent": "trellis-check",
      "ok": true,
      "output": "# Probe: does the gate path still spawn git after 80ea47c?\n\nClaim holds. `PATH` shim `git` (logs argv, then `exec /usr/bin/git`) in front of the real binary;\nreal factory `extensions/coworkflow.ts` driven with a stub host (`on`/`registerCommand`/`sendMessage`).\n\nCounts of git spawns, cumulative, one loaded session (isChild=false, cwd = pi-Coworkflow):\n\n| point | 80ea47c | b79870f (baseline, same probe) |\n| --- | --- | --- |\n| after module load | 2 | 4 |\n| + `moduleEnabled('panel')` ×20 | 2 | 44 |\n| + `switches()` ×20 | 2 | 84 |\n| + `facts()` ×30 | 2 | 144 |\n| + `before_agent_start` | 2 | 148 |\n| + 1 non-subagent `tool_call` ×3 handlers | 2 | 152 |\n| + 1 `subagent` `tool_call` ×3 handlers | 2 | 159 |\n\nSo: 2 spawns total, both at load (`rev-parse --show-toplevel`, `rev-parse --path-format=absolute\n--git-common-dir`); **0 after the first resolut… (truncated; full return value and emits: /var/folders/8c/t8htn7h14t777qd1hclgyj940000gn/T/pi-subagents-uid-501/async-subagent-runs/6c791afc-eb98-4409-90c6-2df3a58dd9fd/status.json (workflow.value, workflow.emits)) Trace: 6 event(s).