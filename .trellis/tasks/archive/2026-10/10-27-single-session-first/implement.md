# Implementation

Ownership: main session implements this single coherent prompt contract. No execution fanout is needed; separate writers would need to coordinate the same instructions.

1. Activate the task and use its linked worktree.
2. Edit instruction assets, Pi workflow detail/fallback/routing, README and the integration spec.
3. Extend `scripts/trellis-template.test.ts` using existing render/context helpers and the real Python phase extractor.
4. Regenerate project-owned rendered copies with the existing renderer; preserve local config and task records.
5. Run `node --test scripts/trellis-template.test.ts` once, fix only relevant failures. No model calls or full-suite reruns are needed for this text-policy change.
6. Review the diff against PRD, commit the worktree changes, integrate serially into main, archive the task and remove its clean merged worktree/branch. Do not push unless requested.

The user approved the implementation scope before task creation and requested continuous delivery. No additional product decision is outstanding.
