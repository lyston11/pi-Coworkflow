# Review — per-kind models (10-22-kind-models)

Read-only check of the task delta in `/Users/lyston/PycharmProjects/wt-10-22-kind-models`.
Everything below was driven through production code: the real extension (`extensions/coworkflow.ts`
default export + `controlSurface()`), the real `syncAgentKinds`, and the **installed** pi-subagents
(`registerAgent` + its own `listRuntimeAgentConfigs` / `applyRuntimeAgentSettings` /
`model-resolution`), against temp projects. Nothing was edited or committed.

## Verdict

The config/registration half is solid and the failure the design worried about (a model change
reading as "unchanged") is genuinely fixed. The panel half has a **destructive** defect: on a kind
page, one `Enter` with the cursor untouched can silently replace the kind's stored model with a
different one. That, plus the page list not actually following the config, are the blockers.

---

## BLOCKERS

### B1 — a kind page's `Enter` can overwrite the stored model without the user moving the cursor

`modules/panel/shared.ts:273`

```ts
current: key === current || (current !== "" && key === effective),
```

`models-panel.ts:172-183` (`cursor()`) seeds the cursor on the **first** row marked `current`, and
`apply()` writes whatever row the cursor is on. On a kind page `current` is the stored string and
`effective` is the *resolved* model — and when the pin cannot be resolved, `models.ts:161-163`
substitutes the **inherited** model as `effectiveModel`:

```ts
effectiveModel: entry.model
  ? modelForRef(models, entry.model, provider || sessionProvider) ?? inherited
  : inherited,
```

Reproduction (real extension, real owner; pinned model deliberately outside the session's
`scopedModels`, which is the ordinary case for a kind pinned to a model the user is not currently on):

```
config:  agentKinds.auditor.model = "anthropic/claude-opus-4"   (not in scopedModels)
panel:   Tab×3 → kind:auditor
header:  当前：anthropic/claude-opus-4 · … · 固定 anthropic/claude-opus-4
rows:    ["(默认 / 继承主会话模型)", "Strong*"]        ← the *inherited* model is marked current
Enter (no cursor movement at all)
stored:  {"enabled":true,"model":"p/strong"}          ← the pin is gone
live:    cw-auditor model = p/strong
status:  auditor（cw-auditor）→ on，上限 5，模型 p/strong，思考 继承
```

Same with a resolvable-but-not-`provider/id`-shaped pin, where **two** rows end up marked current
and the cursor picks the wrong one:

```
config:  agentKinds.auditor.model = "ollama/llama3:latest"   (model is in scopedModels)
rows:    ["(默认 / 继承主会话模型)", "Strong*", "Llama 3*"]   ← two currents
Enter →  stored becomes "p/strong", live registration p/strong
```

Why `ollama/llama3:latest` does not resolve — `modules/panel/shared.ts:245`:

```ts
const bare = ref.replace(/:([a-z]+)$/, "");
```

That strips **any** `:word` suffix, while upstream strips only a *known thinking level*
(`splitKnownThinkingSuffix`). So `ollama/llama3:latest` → `ollama/llama3` (no match) → `undefined`
→ `?? inherited` → the session model is presented as the kind's model. `openrouter/x:free` behaves
the same. Verified directly:

```
ref                     resolved  rowsMarkedCurrent        thinkingLevels
ollama/llama3:latest    null      ["Strong","Llama 3"]     session model's levels
openrouter/x:free       null      ["Strong","Free"]        session model's levels
p/strong                strong    ["Strong"]               ok
p/strong:high           strong    ["Strong"]               ok
typo/x                  null      ["Strong"]               ← claims Strong while storing typo/x
```

Impact: (a) a setting the user never made is written and persisted to `.pi/Coworkflow.json` and to
the live registration — the exact "panel writes a setting the session does not use / did not ask
for" failure class this task exists to remove, now with data loss; (b) PRD req. 6 fails for those
ids because the thinking column lists the inherited model's levels while the header says 固定.

Suggested direction (not applied — this is a read-only check): resolve with a *known-level* suffix
only (reuse the `THINKING_LEVELS` check `core/config.ts` already imports), do **not** fall back to
`inherited` for a pinned-but-unresolved model (leave `effectiveModel` undefined and say the model is
not in the registry), and stop marking a row current via `effective` when it would double-mark.

### B2 — the page list follows the built-in kind table, not the project config

PRD req. 3 / acceptance: "derived from the registry, not hardcoded. Adding a kind adds a page;
removing one removes it." `control.agentKinds()` → `resolveKinds` → `BUILTIN_KINDS.map`
(`modules/agent-kinds/defaults.ts:184`, `extensions/coworkflow.ts:994-997`), so the pages are always
exactly the three shipped kinds. Driven end to end:

```
H) config: executor+auditor+researcher → pages: 主会话 子 agent（默认） 执行者 审计者 调研者
   delete agentKinds.executor from .pi/Coworkflow.json
   control.agentKinds() → ["executor","auditor","researcher"]   (unchanged)
   pages                → 执行者 cw-executor still present
5b) config with NO agentKinds block at all → still 5 pages
P) config declares reviewer (not shipped) + executor off
   pages → 主会话 默认 执行者（已关闭） 审计者 调研者   ← no reviewer page, executor page not removed
   unshippedKinds(config) → ["reviewer"]  (the status line knows; the panel has no page)
```

The test that is cited as proof (`scripts/agent-kind-panel.test.ts:216`, "one kind fewer is one page
fewer") builds a hand-made `PanelSnapshot` and calls `panelPages` on it — it proves the filter, not
that the *source* list is config-derived. The handoff's "去掉一个→4 页" reproduces only that
hand-built snapshot.

Note this may be a deliberate product decision (kinds are shipped, not user-defined), but it is not
what PRD req. 3 and the acceptance criteria say, and the report/README now claim otherwise
(`.trellis/spec/frontend/agent-kinds.md`, README: "加一个 kind 多一页、删一个少一页"). Either the
code or the claim has to move.

---

## LIMITATIONS (no fix needed, but the parent should know)

1. **A syntactically valid but unknown model is not caught.** `isKindModel` is a shape check only.
   `agentKinds.executor.model = "typo/does-not-exist"` decodes, registers (status: `模型
   typo/does-not-exist`), and only fails at launch — upstream's resolver throws `Unknown subagent
   model 'typo/does-not-exist' in the active Pi model registry.` This contradicts the design's
   stated rationale ("a stored typo would take the kind down… dropping it means the kind keeps
   working") — only *malformed* values are dropped; an unresolvable one still takes that kind's
   dispatch down at launch. PRD req. 2's "a kind whose model cannot be resolved must fail that kind
   only, with the reason reported" is therefore only half-met: it fails that kind, but the reason
   surfaces at dispatch, and the panel simultaneously marks a *different* model as current (B1).
2. **Kind pages exist even when the agent-kinds module is off.** With `modules["agent-kinds"] =
   false`: nothing registered, status says `本会话未加载或已关闭，未注册任何 kind`, yet the panel
   shows three kind pages and accepts writes (returning `…；未注册`). Arguably intended (the panel is
   `alwaysActive`), but the pages then describe kinds that cannot be dispatched.
3. **Kind-page scope label names the wrong file**: `modules/panel/models-panel.ts:405` renders
   `本项目 .pi/settings.json · agentKinds.executor`, while a kind page writes
   `.pi/Coworkflow.json`. Cosmetic, but the panel is the place a user looks to learn where the
   setting lives.
4. `modelForRef`'s bare-id branch has no "unique match" check — it takes the first id match, so a
   bare id present under two providers resolves arbitrarily rather than being rejected as ambiguous.
   (Upstream's `fuzzyResolveModel` returns `undefined` on ambiguity.) No observed misbehaviour with
   the ids tested; noted for completeness.

---

## VERIFIED OK (driven, not read)

| # | Claim | Evidence |
|---|---|---|
| 1 | malformed stored model/thinking dropped, valid one reaches the owner's definition | `" p/cheap"` + `turbo` → decoded `{"enabled":true}`, owner registry entry has no `model`/`thinking`; 201-char id → dropped; `p/cheap`/`low` → owner registry `{"model":"p/cheap","thinking":"low"}` |
| 2 | model change changes the signature → re-registers | register-call counter 3 (first pass) → **3** after re-applying the identical model (no re-registration) → **4** after a model change; owner registry then holds the new model, one entry, no collision |
| 3 | clearing returns to inherit and the definition carries no model | `setAgentKind(kind,{model:null,thinking:null})` → key deleted from `.pi/Coworkflow.json`, owner registry entry `{"name":"cw-executor"}` with no `model`/`thinking` |
| 4 | precedence kind → `subagents.defaultModel` → Pi default | via upstream's own `applyRuntimeAgentSettings` + `resolveEffectiveSubagentModel`: pinned kind `p/cheap`; inheriting kind → `strong` (defaultModel); with `settings.json` removed → `p/session-model` (parent) |
| 6 | status reports pinned vs inherited | `cw-executor（kind executor）已注册 · 模型 p/cheap · 思考 low` / `· 继承默认 · 思考 继承`; a disabled kind: `researcher 已关闭（不注册；派单会被拒绝） · 模型 p/cheap · 思考 low` |
| 6 | thinking levels follow the kind's own model when it pins one | pin `p/cheap` (non-reasoning) on a kind page → levels `[(默认…), "off"]`; cleared → session model's `off…xhigh` again |
| 7 | session page key behaviour unchanged | `↓` moves, `Enter` → `host.setModel("p/cheap")`; `→` switches column, `Enter` → `host.setThinkingLevel("medium")`; `Esc` closes; existing `usage.test.ts` Comodels test still green |
| 7 | settings panel unchanged | `buildSettingRows` → 29 rows, kind rows still `[x] 开 · 上限 5 / 已注册到 pi-subagents`; `modules/panel/settings.ts` has no diff |
| 7 | kind gate unchanged | disabled kind dispatch still blocked with the /Coworkflow:settings message; unknown agent passes through; `git diff` touches no gate logic |
| 8 | docs state the precedence | README + `.trellis/spec/frontend/agent-kinds.md` both state kind model → `subagents.defaultModel` → Pi default, and the two validation directions |

## Commands run (once each, in the worktree)

```
./node_modules/.bin/tsc --noEmit     → exit 0
npm test                             → tests 224, pass 224, fail 0, duration 12.3s
```

(The worktree has no `node_modules` of its own; it carries a symlink to the main checkout's. Not a
repo file — gitignored.)

## Not reviewed / out of scope

`modules/panel/settings.ts`, the kind gate, workflows, lanes, usage and the Trellis assets were
inspected only for "unchanged". pi-subagents was read, never written.
