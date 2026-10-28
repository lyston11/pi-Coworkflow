# Design

## Behavior gap and ownership

Policy lives in `modules/agents/assets/` and bundled Trellis templates, not in a new scheduler. Context lives in kind definition parsing/resolution and the existing `buildRoleContext`/child injector.

Add optional `context: role | task` metadata to kind frontmatter. Default `role` preserves existing injection. `task` lets a research-role child receive active task artifacts and `implement.jsonl` through the same budgeted builder; `role: none` still disables role context. Planner ships with `context: task`; custom kinds can opt in independently of names. Task artifacts precede optional manifest content for this profile so a long spec cannot displace the question being planned. Research default remains spec-tree-only.

`Active task: (none)` becomes an explicit taskless resolution that prevents parent-pointer fallback. Omitted task retains legacy fallback; invalid paths remain invalid.

## Change boundary

- Definition parser/resolver/types and CLI rendering: preserve the new context metadata, validate unknown values and retain it during exports/edits.
- Context builder/injector: use profile, honor taskless declaration, reuse the shipped child guide as fallback, remove the extra generated boundary.
- Parent/child/kind assets and workflow/check templates: one decision policy, one universal child boundary, short purpose prompts and read-only audit. Render generated project copies with existing writers.
- Existing template/context/kind tests and relevant specs/README: regression coverage and usage contracts.

No model pins, scheduler, execution engine, automatic routing, new roles, unrelated task-lifecycle code or global installation changes. Direct implementation is appropriate because these edits share one prompt/context contract and need a single consistent review.
