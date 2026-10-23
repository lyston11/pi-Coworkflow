# Design — the kind port

## One resolved table

Everything downstream must read **one** resolved kind table, built in this order per kind id:

```
id set   = shipped kind ids ∪ ids with a project definition file ∪ ids in agentKinds config
per id   = definition file if present, else the shipped asset
           (a config-only id with no file and no shipped asset stays "declared, not shipped":
            preserved, reported, never registered — the existing behaviour)
policy   = agentKinds.<id> if it set the field, else the definition's default, else the built-in default
```

`resolveKinds(config)` becomes `resolveKinds(config, definitions)` and returns, per kind: `kind`,
`label`, `agent`, `role`, `description`, `prompt`, `enabled`, `maxConcurrent`, `model`, `thinking`,
plus **`source`** (`file` | `shipped`) and, per policy field, whether the value came from the project
config or the definition. Reports need that distinction; a single value cannot express "on because
the project chose it" vs "on because the file defaults it".

Callers that must follow the table instead of the shipped list:

| Caller | Why |
|---|---|
| `modules/agent-kinds/index.ts` | registration, the gate, per-kind limits, status lines |
| `modules/subagent-context/index.ts` | role detection in the **child** process — a custom kind's agent name must map to its declared role, and the current regex is built from the shipped list |
| `extensions/coworkflow.ts` | `control.agentKinds()` feeds both panels |
| `modules/panel/*` | pages and rows |
| `core/config.ts` | `agentKinds` may now name any kind, not only shipped ones (it already preserves unknown ids) |

## The definition file

`.pi/Coworkflow/agents/<kind>.md`, `<kind>` a slug (`[a-z0-9][a-z0-9-]*`, length-bounded). Frontmatter
is a small YAML subset parsed by the package's own reader — **no new dependency**, and a malformed
frontmatter is a per-kind failure, not a crash. Unknown frontmatter keys are rejected (a typo that
silently does nothing is worse than a refusal).

Rules, each with its failure mode:

| Field | Rule | On violation |
|---|---|---|
| `agent` | must match `cw-<slug>`, unique across kinds, must not equal a configured project/user agent name | that kind fails, reason names the collision |
| `role` | one of `implement`/`check`/`research`, or `none` | that kind fails |
| `label`, `description` | non-empty, length-bounded | that kind fails |
| `model`, `thinking` | the same validators the config already uses | that kind fails (do not forward to upstream) |
| `maxConcurrent`, `enabled` | same validators as the config | that kind fails |
| body | non-empty after trimming | that kind fails: a kind with no prompt would inherit the shipped one silently |

`role: none` means "not a Trellis role": the child gets no role context injection, and the agent name
is not treated as one of the role names.

## Why the file is the only source of truth

The RPC and the command both **write the file**, then re-sync. An in-memory registration would
disappear on `/reload` — the exact promise this feature makes — and would make "what is this kind"
answerable in two places that can disagree.

## Hot reload

`/reload` re-runs module activation, which resolves the table from disk. The DIY command writes the
file and calls the same reconcile, so both paths converge on one function. Nothing caches the
definitions across a session epoch; a definition read is bounded and cheap (a small directory).

## Failure isolation

`definitions.ts` returns, per id: a parsed definition or a `failure` with a reason. The kind registry
receives only the usable ones and receives the failures as status lines, so a broken file cannot take
down the kinds that are fine. The gate must refuse a kind with a failure using the same wording the
"disabled"/"unregistered" paths already use, because from the caller's side "cannot start" is one
fact.

## Panels

`/Comodels` pages and `/Coworkflow:settings` kind rows already compute from `control.agentKinds()`;
once that returns the resolved table, a custom kind gets a page and a row with no panel change. A
kind that failed to load gets a row that says so rather than disappearing — a silently absent kind
is indistinguishable from one that was never defined.

## Out of scope

User-level definitions, watching the directory for changes (no polling: the reload boundary and the
command are the two refresh points), and per-kind anything other than what the table already carries.
