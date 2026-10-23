# Reuse pi-subagents orchestration contracts

## Goal
Coworkflow is a Trellis adapter over pi-subagents, not a second child runner. The user approved the design and explicitly authorized task creation and execution on 2026-10-20.

## Requirements
- Provide an executable implementation → independent review path using native workflows, stable keys, missions and explicit acceptance/output contracts. Starting a process is not evidence that the task was delivered.
- Preserve Trellis task ownership, project-local settings, task worktree isolation, fresh child contexts and human/parent authority over final acceptance and integration.
- Consume public upstream status/cost/completion interfaces rather than reconstructing child lifecycle from private temp directories. Preserve project concurrency limits as a narrow policy where upstream lacks a project override; never silently discard them.
- Remove the tool-count admonition. Passive internal status must not inject a user message. Do not enable watchdog, goal reminders, automatic retry or global settings writes.
- Fix child prompt injection across repeated runs, including generic agents, without deleting unrelated project requirements. Honor module switches, session changes, reload and shutdown.
- Preserve /Comodels layout and keyboard behavior (Tab switches parent/child; arrows switch columns; all thinking levels visible). Preserve meaningful usage display; missing upstream data must be visibly unknown/incomplete, not false zero.
- Preserve existing lane artifacts and provide correct per-child handoff visibility. Store only Trellis-to-native identity links, not a competing lifecycle database.
- Do not modify pi-subagents, Trellis CLI-owned assets, user global config, unrelated processes or unrelated project WIP.

## Acceptance
1. Public RPC requests are correlated, bounded, cleaned up and capability-checked. Missing/incompatible upstream support gives actionable diagnostics, not duplicate installs or silent guesses.
2. The registered workflow uses implement and review steps, fails on a negative or malformed review/implementation verdict, and exposes native mission/run/artifact references. Workflow completion is not automatic acceptance, merge or publication.
3. Real event-hook tests cover repeated child startup, generic child guidance, preservation of project instructions, module off/on and session replacement. No division-of-work user-message injection remains.
4. Consumer tests cover unknown status/cost, direct and multi-child completion attribution, pending/terminal distinctions, reservation release and configured concurrency boundaries.
5. Tests use actual production adapters/handlers, not manual ledger binding. Typecheck and focused suite pass; one bounded live public-interface smoke validates loader/registration without launching real coding in the main checkout.
6. README and a focused integration spec describe ownership, supported capabilities, failure modes and migration. Existing UI behavior is not refactored.

## Out of scope
Autonomous replanning, blanket automatic retries, default watchdog/goal mode, new runner/scheduler, changing user models, repository-wide cleanup, new panel design.
