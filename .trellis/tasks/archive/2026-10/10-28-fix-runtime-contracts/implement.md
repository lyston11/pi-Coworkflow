# Implementation

1. Enter task worktree. Read callers and runtime APIs used by each change.
2. Fix kind inheritance and worktree branch collision; share task resolver; freeze launch identity and validate cwd.
3. Persist child binding across follow-up/restore; reject invalid tasks. Remove unsafe shutdown deletion.
4. Normalize files and mixed writer warnings.
5. Run affected regressions and typecheck; validate final native system prompt with local provider, no external model requests. Sync asset rendering and spec.
6. Commit code and specs, integrate main, archive task and remove clean merged worktree/branch.
