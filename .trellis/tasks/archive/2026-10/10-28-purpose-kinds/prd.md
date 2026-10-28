# Purpose-based subagent kinds

## Goal

A kind is how a project configures *one purpose* of delegated work, including the model its children run on. The shipped set currently mirrors Trellis roles one-to-one (executor/auditor/researcher), so "cheap mechanical work" and "expensive planning advice" cannot each pin a model. Add purpose-based kinds without changing the role mechanism.

## Requirements

- Ship two additional kinds: `planner` (advisory only, role `research`) and `worker` (bounded, independently checkable work, role `implement`). Several kinds may share one Trellis role; the role decides injected context, the kind decides purpose and model.
- Each kind keeps a single markdown definition asset; the shipped default set becomes executor, planner, auditor, researcher, worker, all enabled with the shipped concurrency default.
- `planner` may propose options, evidence and tradeoffs, but does not edit code and does not decide for the parent.
- `worker` implements only a bounded, independently verifiable task; duration alone is not a reason to use it, and it must not widen scope.
- Record the project's model mapping in `.pi/Coworkflow.json` `agentKinds` only — no model ids in code, prompts or templates:
  - executor → `cpa/gpt-6.1-terra`
  - planner → `cpa/gpt-6-astra`
  - auditor → `cpa/gpt-6.1-sol`
  - researcher → `buddy2api/deepseek-v4.1-flash`
  - worker → `buddy2api/deepseek-v4.1-flash`
- Update rendered parent guidance, README and the integration spec so the kind list is described by purpose, and state that kinds may share a role.
- No new runtime mechanism, no per-role kind limit, no automatic model routing, no change to the `subagents.defaultModel` resolution added earlier.

## Acceptance Criteria

- [x] `BUILTIN_KINDS` contains the five kinds; each asset exists, parses, and declares its role in frontmatter.
- [x] `kindRole` returns implement/research/check/research/implement for them, and role injection still works per role, not per kind name.
- [x] The project config pins the five models and the panel/status surfaces report them without a second policy source.
- [x] Existing per-kind admission, registration, dispatch and model-refusal behaviour is unchanged and covered.
- [x] Rendered AGENTS/README/spec describe purposes and shared roles; template render stays byte-identical to the repository.
- [x] Targeted tests pass; changes are committed, integrated into local `main`, and this task's worktree/branch are cleaned up.

## Non-goals

No change to Trellis workflow phases, no new roles, no model benchmarking, no user-global settings, no changes to unrelated dispatch bugs.
