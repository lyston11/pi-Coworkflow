# Dynamic kind context and isolated task paths

Repair modules/subagent-context/index.ts and modules/agent-kinds/index.ts plus affected tests. Read parent design/implement at ../10-25-dispatch-integration.

Requirements: live kind names work with agent:task and supported subagent-agent-run naming (no fixed builtin regex); workflow agent selection uses resolved entry.role (including project overrides); documentation placeholders do not shadow the real parent task pointer, while explicit bad task paths remain invalid; injected task reference is absolute and usable from a linked worktree; owned launches always carry async:true when absent or false. Preserve fresh-context/budget overrides and unrelated agents.

Allowed files: modules/subagent-context/index.ts, modules/agent-kinds/index.ts, scripts/test.ts, scripts/agent-kinds.test.ts, and only directly necessary injection guidance in modules/agents/assets/. Do not change dispatch or public RPC code. Add regressions for every fixed trigger and retain role:none behavior. Run affected suites and typecheck once after edits. Report exact assertion names and unresolved risks.
