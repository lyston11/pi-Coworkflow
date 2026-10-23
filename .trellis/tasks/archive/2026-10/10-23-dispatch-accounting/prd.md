# Make dispatch measurable and the decision auditable

## Goal

Every dispatch this package observes gets a real interval (settle from completion or tool_result), workflow children are counted instead of invisible, and the decision facts (calls vs dispatches, last dispatch age, authoritative tool availability) are reported where they are read. No conversation injection.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
