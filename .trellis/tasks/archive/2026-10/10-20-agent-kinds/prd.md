# Agent kinds — typed subagent families

Add a module that lets a project define **kinds** of subagent (executor, auditor, …), expose them to
the main session so it can route work by kind, and control **per-kind** enablement and concurrency —
without modifying the installed `pi-subagents` package.

## Why

Today a dispatch is one call with one prompt: the main session decides everything ad hoc, and the
only project-level control is a single global concurrency limit. There is no way to say "this project
uses an executor and an auditor, at most 3 executors at once, and the auditor is currently off", so
that knowledge lives in prose that the model may or may not follow, and nothing enforces it.

`pi-subagents` already separates *which agent* runs from *how it is executed*, and exposes a public
contract for an independent extension to register agents at runtime
(`pi-subagents:runtime-agent-register:v1`, or the `pi-subagents/agents` public export). Typed kinds are
therefore a **registration and gating** problem in this package, not an execution problem.

## What "type" means here, and what it cannot mean

A kind is a named agent definition plus two project policies (enabled, max concurrent). Registering it
means the main session's agent list genuinely contains that kind, so routing to it is a normal
`subagent({ agent: "cw-executor", … })` call.

It is **not** an enum constraint on the main session. The enforceable guarantees are:

- dispatching a **disabled** kind is refused, with a reason naming the kinds that are available;
- dispatching beyond a kind's `maxConcurrent` is refused, with a reason naming current occupancy;
- every other dispatch (a plain `trellis-implement`, another extension's agent) behaves exactly as it
  does today.

Guiding a model toward enabled kinds is prompt guidance; refusing a dispatch is enforcement. This PRD
promises the second and does not pretend the first is the second.

## Requirements

1. **Registration.** For each enabled kind, register a runtime agent whose name is namespace-prefixed
   (`cw-<kind>`) so it cannot collide with a builtin agent (`worker`, `reviewer`, …) or a project
   agent. Keep the returned `dispose()` and re-register on change; disposal must precede
   re-registration, and toggling twice must not leave a duplicate or a stale registration.
2. **Declaration.** Kinds are declared in `.pi/Coworkflow.json` alongside the module switches, with
   absent keys meaning the built-in defaults. A kind's system prompt is an editable asset in this
   package, not a hardcoded string, matching how the child guide is handled today.
3. **Per-kind gate.** On `tool_call`, when the call dispatches one of our kinds: refuse if the kind is
   disabled, refuse if that kind's live running count is at its limit. Use the upstream **public**
   fleet/status data for the count — never a private ledger of our own, and never the child's process
   state.
4. **Global limit still applies.** The existing project-wide concurrency limit is a second, coarser
   gate; both must admit. Neither replaces the other.
5. **Panel.** `/Coworkflow:settings` gains a section listing each kind with its enabled state and its
   limit, using the existing row builders and key conventions. Changing either takes effect in the
   running session without a restart.
6. **Honest degradation.** When the installed `pi-subagents` does not export the runtime-agent
   contract, or advertises no compatible capability: register nothing, say so in the panel and in
   `/Coworkflow:status`, and never report a kind as available. A gate that silently does nothing is
   worse than no gate — that failure mode has already shipped once in this package.
7. **Role mapping.** Kinds map onto the existing Trellis roles where they correspond (executor →
   implement context, auditor → check context) so `subagent-context` keeps one injection path rather
   than gaining a second one keyed on kind.
8. **Lane attribution.** A kind-based dispatch is recorded like any other, with the kind stored so
   `/Coworkflow:lanes` can group by kind.

## Acceptance

1. An enabled kind is dispatchable and appears in the agent list; exceeding its limit is refused with
   the current occupancy in the reason.
2. A disabled kind is refused with a reason that lists the currently available kinds.
3. Changing enabled/limit in `/Coworkflow:settings` takes effect in the loaded session; toggling twice
   produces no duplicate registration and no collision error.
4. The project-wide limit and the per-kind limit are both enforced, independently.
5. `/Coworkflow:lanes` groups or labels records by kind.
6. With the runtime-agent export unavailable, nothing is registered, the panel and status both say
   so, and a dispatch of a declared kind is refused rather than silently started.
7. Non-kind dispatches are unchanged; `npm run typecheck` clean and `npm test` green, with focused
   regression tests driving the production registration and gate paths (not stubs that bypass them).

## Out of scope

Changes to the installed `pi-subagents` package, any scheduler that decides *which* kind gets a task,
modifying Trellis CLI assets, and any automatic retry, merge or cleanup.
