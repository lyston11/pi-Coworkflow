# Per-kind models in `/Comodels`

Follow-up to `archive/2026-10/10-20-agent-kinds`. Today every kind inherits one subagent model
(`subagents.defaultModel`). A project that dispatches an executor, an auditor and a researcher
usually wants different models for them — a cheap one for mechanical work, a strong one for
review — and there is no way to say so.

## What upstream already provides (verified, do not re-derive)

- A runtime agent definition accepts `model` and `thinking`; both are validated at registration
  (`src/agents/runtime-agent-registry.js:154`, `:183`, `:215-216`).
- A bare model id prefers the current provider, then a unique registry match; a trailing
  `:level` on `model` pins the thinking level (`docs/agents.md:426-427`).
- `subagents.agentOverrides.<agent>.model` exists for discovered agents. It is **not** the
  mechanism to use here: our kinds are runtime-registered, so the definition itself is the
  authoritative place and it also keeps the project config as the single source.

## Requirements

1. **Per-kind model and thinking level** in the project config: `agentKinds.<kind>.model`
   (string, `provider/id` or bare id) and `agentKinds.<kind>.thinking` (a thinking level name).
   Absent means inherit. Both are validated on read; a malformed value is dropped rather than
   handed to upstream (which would fail the registration and take the kind down with it).
2. **Applied at registration.** `modules/agent-kinds/registration.ts` passes them into the
   runtime agent definition, so an existing reconcile path (config change → `syncAgentKinds`)
   makes a change take effect in a loaded session without a restart. A kind whose model cannot
   be resolved must fail **that kind only**, with the reason reported, exactly as a name
   collision does today.
3. **`/Comodels` pages follow the kinds.** The page list is 主会话, 子 agent（默认）, then one
   page per configured kind — derived from the registry, not hardcoded. Adding a kind adds a
   page; removing one removes it. A disabled kind keeps its page and says it is off.
4. **Each kind page edits that kind**: model column and thinking column, applying through the
   project config, with a row showing whether the kind inherits or pins. The default page keeps
   writing `subagents.defaultModel` / `defaultProvider` / `defaultThinking` for agents that are
   not kinds (the workflows fall back to `trellis-implement` when no kind is registered).
5. **Thinking levels follow the effective model.** A kind that pins a model lists that model's
   levels; a kind that inherits lists the session model's levels — the same rule the default
   page already uses, applied per kind.
6. **`/Coworkflow:status` reports each kind's model**, or that it inherits, so the panel and the
   report cannot disagree.
7. Tests drive production functions: tab list follows configured kinds (add, remove, disabled);
   applying a kind model writes the config and re-registers the agent with that model; clearing
   returns to inherit; a malformed stored model is dropped; thinking levels come from the kind's
   own model when it pins one.
8. README and `.trellis/spec/frontend/agent-kinds.md` document the per-kind model and the
   precedence: kind model → `subagents.defaultModel` → Pi's default.

## Acceptance

- `npm run typecheck` clean and `npm test` green.
- A project with three kinds shows 主会话 + 默认 + three kind pages, and each kind's model can be
  set and cleared independently.
- No hardcoded kind list in the panel: the pages are computed from the registry/config.

## Out of scope

Per-kind worktree/context/skills settings, model *lists* per provider, upstream's
`agentOverrides`, the settings panel (`/Coworkflow:settings`), and any change to pi-subagents.
