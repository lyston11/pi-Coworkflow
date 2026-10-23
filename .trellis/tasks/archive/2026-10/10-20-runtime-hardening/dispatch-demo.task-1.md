# Probe: does the gate path still spawn git after 80ea47c?

Claim holds. `PATH` shim `git` (logs argv, then `exec /usr/bin/git`) in front of the real binary;
real factory `extensions/coworkflow.ts` driven with a stub host (`on`/`registerCommand`/`sendMessage`).

Counts of git spawns, cumulative, one loaded session (isChild=false, cwd = pi-Coworkflow):

| point | 80ea47c | b79870f (baseline, same probe) |
| --- | --- | --- |
| after module load | 2 | 4 |
| + `moduleEnabled('panel')` ×20 | 2 | 44 |
| + `switches()` ×20 | 2 | 84 |
| + `facts()` ×30 | 2 | 144 |
| + `before_agent_start` | 2 | 148 |
| + 1 non-subagent `tool_call` ×3 handlers | 2 | 152 |
| + 1 `subagent` `tool_call` ×3 handlers | 2 | 159 |

So: 2 spawns total, both at load (`rev-parse --show-toplevel`, `rev-parse --path-format=absolute
--git-common-dir`); **0 after the first resolution**, across 70 control-surface reads and both event
paths. Baseline perframe grows ~2/read (3 spawns pre-`b79870f`); current is flat.

Faked to run it: the Pi host (no real TUI/session), the `git` wrapper, and hand-built `tool_call`
payloads (`read`, then `subagent` with `input.task`) — the 3 registered handlers run, all return
without gating on a real dispatch. No files in the repo touched; probe lives in /tmp/cwprobe.
