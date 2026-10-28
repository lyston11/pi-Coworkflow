# Unify prompt and agent delegation contracts

## Goal

Resolve all six prompt-audit findings while keeping main-session-first delivery and configurable kinds/models. Authorized by the user to implement, verify and deliver continuously.

## Requirements

- All supported workflow branches and breadcrumbs default to direct parent implementation/checking; delegation stays optional.
- Check/auditor children report findings without fixing files; the parent applies repairs and owns final acceptance.
- A definition-level context profile gives planning children task artifacts and curated implementation context through the existing injector; research remains lightweight by default. No kind-name routing table.
- Explicit `Active task: (none)` skips parent task inheritance; missing references retain compatibility fallback and invalid references remain reported. Bounded taskless jobs need no new Trellis task.
- Universal child boundaries have one shared source; kind prompts describe purpose, limits and deliverables. Shorten parent guidance without removing async, admission, write isolation, Git safety, or cleanup requirements.
- Worker eligibility requires known inputs, output, write scope and independent verification; ambiguous diagnosis and architecture decisions stay with parent/executor.
- Preserve existing project models and custom kind definitions.

## Acceptance Criteria

- [x] Real phase extraction on representative/all supported platforms yields direct-first implementation and checking, plus optional read-only audit.
- [x] Planner and renamed custom kinds receive the configured profile, task sentinels, manifests and bounded context; researcher remains spec-tree-only.
- [x] Explicit none, absent task, invalid task and repeated injection have regression coverage.
- [x] Rendered instructions and source templates agree; universal child boundaries are not appended twice.
- [x] Type check and affected tests pass.
- [x] Changes committed (`f9f3c53`, `4c4fb0e`), integrated into local main and task worktree/branch removed; not pushed.
