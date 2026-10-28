# Implementation

Single coherent change; the main session implements it directly (no fanout needed, the files are one contract).

1. `modules/agent-kinds/defaults.ts`: add `planner` and `worker` entries and correct the table comment from "one per role" to purpose-based kinds sharing three roles.
2. New assets `modules/agent-kinds/assets/planner.md` (role: research) and `worker.md` (role: implement) with advisory/bounded-work boundaries.
3. `.pi/Coworkflow.json`: add `agentKinds` entries with the five model pins and keep existing enabled/ceiling values.
4. `modules/agents/assets/main-AGENTS.region.md`: replace the three-row kind table with the five purposes, role column, and the "kinds may share a role" rule; keep the availability/refusal sections intact.
5. `README.md` and `.trellis/spec/frontend/subagents-integration.md`: same correction in prose; spec gains the purpose-vs-role contract and the project model mapping.
6. Tests: update exact expectations in `scripts/agent-kinds.test.ts` (names, role list, defaults, registry count) and `scripts/agent-kinds-surface.test.ts` (role list); add assertions that the two new assets parse, declare their roles, and that two kinds share a role without a second injection path.
7. Render the project copies with the existing renderer, then run the targeted suites for kinds/panel/fanout/template.
8. Review against this PRD, commit in the task worktree, fast-forward into `main`, archive the task and remove the merged worktree/branch. Do not push.
