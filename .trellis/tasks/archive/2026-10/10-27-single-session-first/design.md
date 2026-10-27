# Design

The behavior is prompt policy, not a missing runtime dispatcher. `modules/agents/assets/main-AGENTS.region.md` currently mandates delegation. `templates/trellis/dot-trellis/workflow.md` repeats it in Pi/inline phase details, routing and fallback. The Pi extension asks `get_context.py --mode phase --platform pi --step 2.1` first and only then uses the inline fallback, so changing AGENTS alone is insufficient.

## Contract

Default: main session implements and validates. Optional: a bounded child provides advice or a verifiable deliverable; main session owns final decisions. Parallelism requires genuine independent work and sufficient benefit, not a justification for working serially. Models remain project/user configuration. No automatic model selection and no runtime policy additions.

## Change boundary

- Parent asset: replace mandatory split/parallel/pipeline policy; make safety and dispatch mechanics conditional on actual delegation.
- Child asset: allow requested advisory/review scope while retaining no lifecycle changes, no merge/push and no nested delegation.
- Workflow template: change only Pi/inline instructions and shared explanatory text needed for them; preserve other platform modes.
- README and integration spec: document the new default and optional workflows without parallelism targets.
- Template tests: assert rendered instructions, actual Pi step extraction and fallback, and retained safety.
- Regenerate AGENTS and workflow using existing renderers, not manual divergent edits.

No changes to runtime APIs, model precedence, config defaults, installation ownership or worktree algorithms. Reverting this task commit restores the old policy.
