# Single-session first, optional delegation

## Goal

Make the main session the default end-to-end executor. Delegation is optional assistance, not a required implementation or audit pipeline. The user approved this scope and continuous implementation in the conversation.

## Requirements

- Main session plans, implements, checks and accepts work by default, not only tiny changes.
- Delegate only when independent advice, parallel research, a bounded easy-to-check task, or risk-driven review justifies handoff cost. Long duration alone is insufficient.
- Allow configurable model/agent choices; do not hardcode the example model names, add role requirements, change user model settings or create an automatic routing engine.
- Preserve background dispatch, status/stop, kind admission, context isolation, write-conflict controls, and worktree/merge safety when delegation is used.
- Align shipped parent/child instructions, Pi Trellis phase details and fallback breadcrumbs, README, project spec and generated project copies.

## Acceptance Criteria

- [x] Main-session execution and optional delegation are explicit in rendered AGENTS and the Pi phase 2.1/2.2 guidance.
- [x] The inline fallback and skill routing do not require execute/audit children or parallelism.
- [x] Child guidance permits requested planning/review advice without granting project-level decisions or recursive delegation.
- [x] No model identifiers, new config keys or dispatch runtime changes are introduced.
- [x] Tests exercise the actual get_context.py Pi phase extraction as well as rendered instructions and preserved safety guidance.
- [x] Template/rendered files agree; changes are committed, integrated serially and this task worktree is cleaned after merge.

## Non-goals

No benchmark, model setup, Trellis lifecycle redesign, scheduler replacement, unrelated dispatch bug fixes or changes to other platforms' dispatch modes.
