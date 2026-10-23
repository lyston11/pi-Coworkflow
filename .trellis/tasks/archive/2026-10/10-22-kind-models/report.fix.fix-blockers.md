# Fix — the two blockers and four limitations from `report.review.md`

Worktree `/Users/lyston/PycharmProjects/wt-10-22-kind-models`. Nothing committed, pushed or merged; no
task-lifecycle state touched; pi-subagents and the main checkout were read only. `/Coworkflow:init`
was not run against any real project (the only `.pi/` files touched are the temp fixtures the tests
create under `$TMPDIR`).

## Verdict

All six items are closed in code, and each one has a test that drives production code — the real
extension's `/Comodels` command, the real `controlSurface()`, the installed pi-subagents as the
registration owner, and the config file on disk.

```
npx tsc --noEmit   → exit 0
npm test           → tests 229, pass 229, fail 0, skipped 0, duration 11.98s
```

(`npm test` was 224 before this change; the 5 new cases are in `scripts/agent-kind-panel.test.ts`.)

---

## B1 — `Enter` on a kind page overwrote the stored model

All three causes are fixed. Each is load-bearing, so each is listed with the test that would fail if
it came back.

### (a) `shared.ts` stripped any `:word` suffix → `ollama/llama3:latest`, `openrouter/x:free`

New `stripThinkingSuffix(ref)` strips a suffix only when it is a member of the existing
`THINKING_LEVELS` list (no second list), which is the rule upstream's `splitKnownThinkingSuffix`
follows. `modelForRef` uses it.

`ollama/llama3:latest` now resolves to the model with id `llama3:latest`; the old code cut it to
`ollama/llama3`, matched nothing, and fell through to `?? inherited`.

Test: `panel: a pin the registry cannot resolve stays unresolved and keeps its own current row`
asserts `stripThinkingSuffix` for `:latest`, `:free`, `:high`, `:max` and no suffix, and that
`modelForRef(["ollama/llama3:latest"])` finds it.
End-to-end: `Comodels: a pin whose id carries a non-level colon suffix resolves and survives Enter
untouched`.

### (b) `models.ts` fell back to the inherited model for a pinned-but-unresolved pin

```ts
effectiveModel: entry.model
  ? modelForRef(models, entry.model, provider || sessionProvider)   // no `?? inherited`
  : inherited,
```

`PanelKindSnapshot.effectiveModel` is now `undefined` for that case and the page says so
(`kindStateLabel` → `固定 <id>（不在当前模型注册表中）`). The inherited model is never substituted
anywhere a value could be written back.

Because `effectiveModel` is now empty there, `modelRows` gives the stored pin a row of its own —
`<id>（不在模型注册表）`, marked current, carrying the stored string — so the cursor seeds on the pin
rather than on the inherit row. That row is the only thing standing between "unresolved" and "one
`Enter` clears a model the user never touched", so it is tested directly.

Test: `Comodels: Enter with the cursor untouched writes back the stored pin, never the inherited
model` (pin `anthropic/claude-opus-4`, outside `scopedModels`) asserts exactly one `✓`, that it is on
the pin's row, that `Enter` leaves `.pi/Coworkflow.json` and the owner's registry both at
`anthropic/claude-opus-4`, and that the panel says it refused.

### (c) `shared.ts:273` double-marked rows

```ts
current: key === stored || isPin,
```

where `isPin` is the row of the model the stored pin *resolves to* (a bare id or `:level` form is
keyed on no row). `effective` no longer marks anything on its own; the stored value is authoritative.
A kind with a resolvable pin now seeds the cursor on the pinned row and `Enter` writes back the same
value — including verbatim: the pin's row carries `writeRef` (`PanelModel.writeRef`) so
`ollama/llama3:latest` is not normalised to `ollama/llama3` on an untouched `Enter`.

Test: same two cases above; both assert `rows.filter(r => r.current).length === 1` and that the
stored string on disk is byte-identical after `Enter`.

### Fourth limitation, closed in `modelForRef` while I was there

The bare-id branch took the first match. It now follows upstream's `findModelInfo`: exact
`provider/id`, then an id match preferring the given provider, then a match **only when exactly one
model has that id** — ambiguity returns `undefined`.

Test: `panel: a pin the registry cannot resolve…` asserts `modelForRef([a/twin, b/twin], "twin")` is
`undefined`, that `preferredProvider: "b"` settles it, and that a single match still resolves.

---

## L1 — an unknown-but-well-formed model id was only caught at launch

`applyKindModel` (the panel's writer) now resolves the chosen reference against the live registry
before calling `setAgentKind`. If it does not resolve it returns
`模型 <id> 不在当前模型注册表中，未写入（配置未改动；选中「继承」可清除该 kind 的固定模型）` and
never reaches `setAgentKind`, so `.pi/Coworkflow.json` is not touched. The inherit row (`model ===
null`) skips the check entirely, so clearing a pin always works.

The layer split is deliberate and documented: `setAgentKind` keeps its shape-only validation (it is a
pure config writer with no model registry — the gate, the status report and children all decode
through it), and the existence check lives in the panel, which is the only place that holds the
registry and the place a user types the id.

Test: the last case of `Comodels: with agent-kinds off …` stores `typo/does-not-exist` through the
control surface, reopens the panel, presses `Enter` with the cursor untouched, and asserts the
refusal message plus a **byte-identical** `.pi/Coworkflow.json`.

## L2 — kind pages accepted writes with the module off

`PanelSnapshot.kindsActive` is new (`runtime.enabled && control.moduleEnabled("agent-kinds")` — the
same two gates `syncAgentKinds` reads). When false:

- the page note reads `本会话未启用` instead of `已关闭` (a different fact: off means "not
  registered", disabled means "this kind is off");
- `kindsLayerNote()` renders `本会话未启用 agent-kinds，未注册任何 kind（写入只改配置）` in the page
  header and the "当前生效" line.

Test: `Comodels: with agent-kinds off …` asserts the note, the header text, and that the owner's
registry is empty.

## L3 — `models-panel.ts:405` named the wrong file for a kind page

`scope` for a kind page now renders `本项目 .pi/Coworkflow.json · agentKinds.<kind>` (from
`CONFIG_REL`, not a literal). The session page still says 本会话; the default page still says
`.pi/settings.json`.

Test: same case asserts the rendered header matches `\.pi/Coworkflow\.json · agentKinds\.auditor` and
does **not** match `\.pi/settings\.json`.

---

## Docs — the "adding a kind adds a page" claim

The page list is `control.agentKinds()` → `resolveKinds` → `BUILTIN_KINDS`, so it is derived from the
**shipped** kind table. That is correct — a kind needs a prompt asset and a Trellis role mapping — but
the claim was wrong. Corrected in all four places, with the same wording:

- `README.md` (`/Comodels` section): pages follow the shipped table, the panel holds no kind list,
  shipping a kind adds its page with no panel change, a declared-but-unshipped kind keeps no page and
  is reported by `/Coworkflow:status`.
- `.trellis/spec/frontend/agent-kinds.md`: same, plus a new subsection **一页只有一个当前值** with the
  three-case table (inherit / resolvable pin / unresolvable pin) and the resolution rules (known-level
  suffix only, ambiguous bare id is unresolved), and the write-time/read-time validation table split
  by layer.
- `prd.md` requirement 3 and the acceptance bullet: "one page per **shipped** kind … shipping a new
  kind adds its page with no panel change … a declared-but-unshipped kind keeps no page and stays
  reported by the status line". The acceptance bullet keeps "no hardcoded kind list", now phrased
  against `control.agentKinds()`.
- `design.md`: the Panel pages paragraph and a new **One current row per page** section.

## Tests added (`scripts/agent-kind-panel.test.ts`, 5 → 9 cases)

| test | what it proves |
|---|---|
| `panel: the page list follows …` (extended) | layer-off note is `本会话未启用`, and `kindsLayerNote` is empty when active |
| `panel: a pin the registry cannot resolve …` | suffix rule, ambiguity rule, single `✓`, pin row carries `ref`/`writeRef` |
| `Comodels: the page list equals what control.agentKinds() resolves …` | **the source, not a snapshot**: `panel.pages()` tab/label lists are built from `loaded.control.agentKinds()`; the unshipped `reviewer` gets no page; disabled `researcher` keeps its page with note `已关闭`; deleting the whole `agentKinds` block does not change the shipped page list |
| `Comodels: Enter with the cursor untouched …` (pin outside scope) | the review's first B1 reproduction, asserted on disk + owner registry |
| `Comodels: a pin whose id carries a non-level colon suffix …` | the review's second B1 reproduction (`ollama/llama3:latest`) |
| `Comodels: with agent-kinds off …` | L2 state, L3 label, L1 refusal with an untouched config |

The page-list test drives the real extension (`default(host)` + `controlSurface()` from the same
module instance as the registered `/Comodels` command), so it fails if the panel ever keeps a list of
its own.

## Files changed (this pass only)

- `modules/panel/shared.ts` — `stripThinkingSuffix`, `modelForRef` (known-level + ambiguity),
  `modelRefOf`, `registryKeyOf`, `PanelModel.ref`/`writeRef`, `PanelSnapshot.kindsActive`,
  `kindsLayerNote`, single-current `modelRows` + the unresolved-pin row, `kindStateLabel`,
  `panelPages` note, `kindStateLabel` doc.
- `modules/panel/models.ts` — `kindsActive()`, `effectiveModel` no longer falls back to `inherited`,
  `applyKindModel` refuses an unresolvable id before writing.
- `modules/panel/models-panel.ts` — kind-page scope label uses `CONFIG_REL`, layer note in the header
  and the 当前生效 line, cursor context uses `registryKeyOf` (a row standing for an unknown pin has no
  usage to attribute).
- `modules/panel/index.ts` — re-exports; header comment corrected.
- `scripts/agent-kind-panel.test.ts` — 4 new cases, 2 extended.
- `README.md`, `.trellis/spec/frontend/agent-kinds.md`, `prd.md`, `design.md` — wording.

No change to `core/config.ts`, `core/module.ts`, `extensions/coworkflow.ts`,
`modules/agent-kinds/*`, the kind gate, the settings panel or `scripts/verify.ts` in this pass.

## Not done / limitations that remain

- **`setAgentKind` still accepts an unknown-but-well-formed id** when called directly (not through the
  panel). It has no registry by design; the refusal lives in the panel. A programmatic caller can
  therefore still store a typo, which then fails that kind at launch — the read-time decoder cannot
  help because the value is well-formed. Closing this fully would mean threading a model registry into
  the control surface; out of scope here and stated in the spec's layer table.
- **A kind page's usage column** shows nothing for a row that stands for an unknown pin (the cursor
  context is `""`), which is correct but silent — no "no usage for an unknown model" message.
- The stored-pin row's label is the raw id (`anthropic/claude-opus-4（不在模型注册表）`), not the
  registry's display name; there is none to use.
- `scripts/verify.ts`'s panel probe builds a snapshot with `kinds: []`; it does not exercise a kind
  page. Unchanged, and its assertions still pass.
