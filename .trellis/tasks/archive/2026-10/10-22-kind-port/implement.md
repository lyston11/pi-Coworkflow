# Implement — the kind port

Four stages, sequential, one worktree. Each stage ends with `npx tsc --noEmit` and `npm test` green
and a handoff; the next stage reads that handoff instead of redoing the work.

## Stage A — the definition port (core)

New `modules/agent-kinds/definitions.ts`:
- locate `.pi/Coworkflow/agents/`, read `*.md` (bounded, sorted, no recursion);
- parse frontmatter (small YAML subset: `key: value`, comments, quoted strings) and the body;
- validate every field per design.md, returning either a definition or a `failure` with a reason;
- expose `readKindDefinitions(ctx)` → `{ definitions: Map<id, KindDefinition>, failures: {kind, reason}[] }`.

Then make the table resolution read it:
- `modules/agent-kinds/defaults.ts`: `resolveKinds(config, definitions)`; per-kind `source` and
  per-field provenance; keep the shipped table as the fallback definition and keep
  `DEFAULT_MAX_CONCURRENT` as the last default;
- `modules/agent-kinds/registration.ts`: unchanged in shape — it already takes desired kinds with a
  prompt and a name;
- `modules/agent-kinds/index.ts`: plan from the resolved table, gate covers every resolved kind
  (including custom ones), failures reported as status lines, `runtimeStatus` names the source;
- `modules/subagent-context/index.ts`: role detection resolves from the table (a custom kind's agent
  name must map to its declared role; `role: none` maps to no role). This runs in the child, so it
  reads config + definitions there; keep it cheap and never throw.
- `extensions/coworkflow.ts`: `control.agentKinds()` returns the resolved table.

Tests: a file overriding a shipped kind changes its prompt/label/role; a new kind appears; `agent:`
renames; a malformed field fails only that kind; an unreadable directory is "no definitions"; a
duplicate agent name fails that kind; `role: none` injects no role context.

## Stage B — the DIY surface

- `/Coworkflow:kind` — `list` (id, agent, role, source, on/off, limit, model), `show <kind>`,
  `set <kind> key=value …` (validated, writes the file, re-syncs, reports what changed),
  `remove <kind>` (deletes a custom file; refuses to delete anything outside the definitions
  directory). `add <kind>` is `set` on a new id.
- A public event-bus request `coworkflow:kind-define:v1` that writes the same file through the same
  writer and re-syncs. Capability-checked like the other public surfaces; a malformed payload is a
  refusal, never a partial write.
- `/Coworkflow:status` reports each kind's source and, for a failed kind, its reason.

Tests: `set` writes a valid file and the agent is registered without a restart; a rejected value
leaves the file untouched; `remove` deletes only inside the definitions directory; the RPC writes the
same file the command does.

## Stage C — panels and the harness

- `/Comodels` and `/Coworkflow:settings` show a resolved custom kind (page, row) and a **failed** kind
  (a row naming the reason, not a missing row).
- `scripts/verify.ts` gains a probe that renders the panel with a custom kind configured.
- README and `.trellis/spec/frontend/agent-kinds.md`: the port, the file format, precedence, hot
  reload, failure isolation, and the DIY command/RPC.

## Stage D — read-only check

Drive the real extension and the installed owner: override a shipped kind and confirm the child's
injected context carries the new prompt and role; add a custom kind and confirm registration, its own
page, its own gate and limit; rename and confirm the gate/role/panel/report follow; `/reload`
equivalent picks up an edited file; a malformed file fails only itself and cannot be dispatched; the
config still wins over a definition default. Report blockers with file:line, or no blockers plus
limitations.

## Boundaries

Do not change pi-subagents, the Trellis assets, `scripts/test.ts`'s existing suites beyond additions,
or any behaviour delivered by the previous two tasks. No polling, no file watchers: the reload
boundary and the command are the refresh points.
