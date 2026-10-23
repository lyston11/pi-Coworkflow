# The kind port — user-defined subagents

Follow-up to `archive/2026-10/10-20-agent-kinds` and `10-22-kind-models`. Today the three kinds are
whatever this package ships: their roles, prompts, labels, agent names and defaults are compiled in,
and a project can only tune `enabled` / `maxConcurrent` / `model` / `thinking`. Nothing can add a
kind, rename one, or change what a kind is for.

This is the point of the modular design: the kind set should be a **project's** decision, expressed
through a documented port that anyone — including an agent — can write to.

## The port

A project-level definition directory, one file per kind:

```
.pi/Coworkflow/agents/<kind>.md
```

Frontmatter declares the kind; the body is the system prompt injected into the child, i.e. the kind's
职能:

```markdown
---
label: 执行者                     # panel label
agent: cw-executor                # agent name; default cw-<kind>
role: implement                   # Trellis context role: implement | check | research | none
description: 按派单做完一件已定义的工作并报告事实
model: provider/id                # optional default
thinking: high                    # optional default
maxConcurrent: 5                  # optional default
enabled: true                     # optional default
---

<the system prompt this kind's children receive>
```

The format is deliberately the same shape as upstream's `.pi/agents/*.md`, so it is already familiar
and a file can be adapted by hand.

## What it can do

| The user wants | How |
|---|---|
| change what a shipped kind is for | a file named after it; the body replaces its prompt, frontmatter overrides its label/role/description |
| add a kind | a file with a new name |
| rename the agent | `agent:` — must start with `cw-` and be unique across kinds |
| change a kind's defaults | `model` / `thinking` / `maxConcurrent` / `enabled` in frontmatter |
| remove a kind | delete the file (a shipped kind then reverts to its built-in definition; a custom one disappears) |

## Precedence

Two layers, and which one wins is not negotiable:

1. **Definition** (file, else the shipped asset) — what the kind *is*: prompt, label, role, agent
   name, and its defaults.
2. **Project config** (`agentKinds.<kind>` in `.pi/Coworkflow.json`) — what the project *chose*:
   enabled, maxConcurrent, model, thinking. Written by the panels. **Always wins over a definition's
   default**, because it is an explicit choice.

So a definition's `model:` is a default the panel then shows as inherited-from-definition, and the
moment a user sets a model in the panel the config wins. Reports must distinguish the two, exactly as
module switches distinguish 默认 from 选过.

## Hot reload

Definitions are read wherever the kind set is resolved — session activation and every reconcile. A
`/reload` therefore picks up an edited file with no restart, and the DIY command re-syncs immediately
after writing, so an agent that edits a definition sees the effect in the same session.

## Failure discipline (non-negotiable, from this package's own history)

- A malformed file, an unusable agent name, a duplicate agent name, or a missing prompt body fails
  **that kind only**, with the reason reported by `/Coworkflow:status` and the panel. Every other
  kind keeps working.
- A kind whose file is bad is **not registered** and **cannot be dispatched** — a name that cannot
  start is never reported as available.
- An unreadable directory is "no definitions", not an error that takes the layer down.
- A definition may not claim a name outside the `cw-` namespace, and may not collide with another
  kind's agent or with a configured project agent. Renaming into a collision fails that kind with
  the collision named.

## DIY surface

- `/Coworkflow:kind` — list the resolved kinds with their source (file vs shipped), and
  `add` / `set` / `remove` a definition. Writes are validated before they touch the file, and the
  command re-syncs so the effect is immediate. This is what an agent calls.
- A public request on the event bus (`coworkflow:kind-define:v1`) that writes the **same** file and
  re-syncs, so another extension or program uses one source of truth rather than an in-memory
  side channel. A kind that exists only in memory would vanish on `/reload`, which is the opposite
  of what this feature promises.

## Acceptance

1. A project file named `executor.md` overrides the shipped executor's prompt, label and role, and
   children of that kind receive the new prompt (verified from the child's own injected context).
2. A file for a new kind registers a new agent, appears as its own `/Comodels` page, gets its own
   gate and its own concurrency limit, and its children get the declared role's Trellis context.
3. `agent:` renames the agent, and the gate, the role mapping, the panel and the report all follow
   the new name.
4. `/reload` picks up an edited definition with no restart; `/Coworkflow:kind set` does it in-session.
5. A malformed file fails only that kind, is reported with its reason, and leaves the others working;
   the broken kind cannot be dispatched.
6. The project config still wins over a definition default, and the report says which is in force.
7. Deleting a custom kind's file removes the agent; deleting an override for a shipped kind restores
   the shipped definition.
8. `npm run typecheck` clean and `npm test` green, with the regressions driven through the real
   extension and the installed owner.

## Out of scope

User-level (`~/.pi/agent/...`) definitions, per-kind worktree/context/skills, upstream
`agentOverrides`, and changing pi-subagents.
