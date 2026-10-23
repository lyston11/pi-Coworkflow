# Re-check — per-kind models (10-22-kind-models), after `report.fix.fix-blockers.md`

Read-only check of `/Users/lyston/PycharmProjects/wt-10-22-kind-models`. Nothing edited, committed,
pushed or merged; no task-lifecycle state changed; the main checkout, the installed pi-subagents
(0.80.0) and pi-subagents' files were read only; `/Coworkflow:init` was not run against a real
project. Every result below was driven through production code — the real extension
(`extensions/coworkflow.ts` default export + `controlSurface()`), the real registered `/Comodels` and
`/Coworkflow:settings` commands, the real `syncAgentKinds`, and the **installed** pi-subagents as the
registration owner — against temp projects under `$TMPDIR`. Probe scripts live outside the repo
(`/tmp/recheck/probe*.ts`).

## Verdict

**Both blockers B1 and B2 from `report.review.md` are genuinely closed, and the five items the
dispatch named are all satisfied on the model column.** The four limitations L1–L4 are closed,
L1 with a deliberate layer split that I verified end to end.

**One blocker remains, on the thinking column of a kind page** — the same data-loss class B1 was
about, on the other column of the page this task added: a stored `thinking` level that the page
cannot offer is not marked current anywhere, the cursor seeds on the inherit row, and one `Enter`
with no cursor movement deletes the stored level from `.pi/Coworkflow.json` and from the live
registration. Reproduced entirely through the panel. Details below (BLOCKER 1).

One minor inconsistency (READ/WRITE PROVIDER ASYMMETRY) and four practical limitations follow.

```
npx tsc --noEmit   → exit 0
npm test           → tests 229, pass 229, fail 0, skipped 0, duration 11717.99 ms
```

---

## BLOCKER 1 — a kind page's `Enter` on the thinking column deletes a stored level it never showed

`modules/panel/shared.ts:407-415`

```ts
const rows: PanelRow[] = supportedThinkingLevels(model).map((level) => ({
  label: level,
  current: level === current,        // 409 — no row is current when `current` is not offered
  thinking: level,
}));
if (tab === "session") return rows;
return [{ label: INHERIT_THINKING_LABEL, detail: "…", current: current === "", thinking: null }, …rows];
```

`modules/panel/models-panel.ts:178-189` seeds the cursor on the **first row marked `current`, else
row 0** (the inherit row); `models-panel.ts:240` (`const level = row.thinking ?? null`) then passes
`null` to `applyKindThinking` (`models-panel.ts:249` → `models.ts:297-301` →
`extensions/coworkflow.ts:1028`, `if (patch.thinking === null) delete next.thinking`).

The model column got the single-current treatment in this pass (`shared.ts:352-389`: one row, the
stored pin gets its own row when unresolved). The thinking column did not — including for the case
this pass explicitly created, `effectiveModel: undefined` for an unresolvable pin (`models.ts:177-179`),
where the offered set is the generic list (`shared.ts:271`, everything but `max`). So
`agentKinds.<kind>.thinking = "max"` — a value `isThinkingLevel` accepts (`core/config.ts:400`) — has
no row at all.

### Reproduction A — reachable entirely through the panel, two ordinary steps

Project: `agentKinds.auditor` with no model and no thinking. Session model `a/strong` (plain
reasoning model, no `thinkingLevelMap`); scoped models `a/strong`, `a/cheap` (`reasoning: false`).

```
/Comodels → Tab×3 → kind:auditor
  → (thinking column) ↓… to `high`, Enter        →  config: {"enabled":true,"thinking":"high"}
  ← (model column)    ↓… to `Cheap`, Enter       →  config: {"enabled":true,"model":"a/cheap","thinking":"high"}
reopen /Comodels → Tab×3 → kind:auditor → →
  header:  当前：a/cheap · high · 固定 a/cheap
  rows:      (默认 / 继承主会话思考)  |  off
  rows marked current: 0
  cursor:   → ○ (默认 / 继承主会话思考)
  Enter  (no cursor movement)
  config:   {"enabled":true,"model":"a/cheap"}          ← `thinking:"high"` is gone
  live:     cw-auditor thinking = undefined
```

### Reproduction B — a stored pin outside the registry plus any level the generic set omits

Project: `agentKinds.auditor = { enabled: true, model: "typo/nope", thinking: "max" }`; session model
has a plain `thinkingLevelMap` without `max`.

```
rows:    (默认 / 继承主会话思考) | off | minimal | low | medium | high | xhigh
current: 0
Enter (no movement) → {"enabled":true,"model":"typo/nope"}     ← `thinking:"max"` is gone
```

Same with `model = "a/cheap"` (`reasoning:false`) + `thinking:"high"`: the offered set is `[off]`,
nothing is current, `Enter` → `{"enabled":true,"model":"a/cheap"}`.
Control: with `thinking:"high"` on a model whose set *does* contain it, one row is marked current,
the cursor seeds on it, and `Enter` writes the same value back — so the mechanism is the missing
`current` row, not the writer.

### Status of the class

The `thinkingRows` shape is inherited from HEAD (the default page does the same thing with
`subagents.defaultThinking`; verified on a clean `git archive HEAD` tree: `defaultThinking:"max"` →
rows `(默认…) | off…xhigh`, current 0, one untouched `Enter` → `{"defaultModel":"cheap","defaultProvider":"a"}`).
What is new is that this task **adds a page per kind**, its own PRD req. 4 asks that page to edit the
thinking column, and the fix's own written invariant — spec `#### 一页只有一个当前值`, and the fix
report's "(c) `shared.ts:273` double-marked rows / exactly one row is current" — is claimed to hold
per page but does not hold for the thinking column, in exactly the way B1 did for the model column.
No test covers it (`scripts/agent-kind-panel.test.ts` only asserts the inherit row is current while
inheriting, `:354`).

Suggested direction (not applied): mirror what the model column now does — treat the *stored* value
as authoritative, give a stored level that the page does not offer a row of its own (marked current,
labelled as not available for this model, carrying that level back verbatim), and never let `null`
be written by a row the user did not move to. Failing that, disable the thinking column's apply when
no row is current, and say why.

---

## MINOR 1 — the header says the pin resolves, the writer says it does not (read/write provider asymmetry)

`modules/panel/models.ts:178` resolves the pin with `provider || sessionProvider` (the project's
`subagents.defaultProvider` first), while `modules/panel/models.ts:283` resolves the same reference at
write time with the **session** provider only. A bare-id pin that is ambiguous across providers
therefore reads as resolved and writes as unresolvable.

```
project: agentKinds.auditor.model = "twin"; .pi/settings.json subagents.defaultProvider = "b"
session provider "c"; scoped models c/session-model, a/twin, b/twin
panel:  rows  (默认…) | Session | Twin A | *Twin B      (single current, cursor on the pin)
header: 当前：twin · … · 固定 twin                       (no "不在当前模型注册表中")
Enter:  模型 twin 不在当前模型注册表中，未写入（配置未改动；…）
config: unchanged; stored model still "twin"              (no data loss)
```

Harmless on data (nothing is written, nothing is lost) but the two lines disagree about one fact, and
a pin the page presents as current cannot be re-applied without first re-spelling it. One provider
argument — `provider || sessionProvider` — in both places would make them agree. Not a blocker.

---

## Verified OK (driven, not read)

| # | Claim | Evidence |
|---|---|---|
| 1a | **A pin outside the session's `scopedModels`: `Enter` with no cursor movement leaves config and live registration byte-identical** | `agentKinds.auditor.model = "anthropic/claude-opus-4"`, `scopedModels = [p/strong, p/cheap]`. rows `[' (默认 / 继承主会话模型)', '*anthropic/claude-opus-4（不在模型注册表）', ' Strong', ' Cheap']` — exactly **1** row current, the pin's; inherit row not current. `Enter` → `.pi/Coworkflow.json` byte-identical, owner registry `{"model":"anthropic/claude-opus-4"}` unchanged, status `模型 anthropic/claude-opus-4 不在当前模型注册表中，未写入（配置未改动；选中「继承」可清除该 kind 的固定模型）`. Then `↑ Enter` → key deleted, `cw-auditor` re-registered without `model` |
| 1b | **A pin whose id carries a non-level colon survives `Enter` untouched** | `ollama/llama3:latest` with `ollama/llama3:latest` in scope: rows `[' (默认 / 继承主会话模型)', ' Strong', '*Tagged', ' Cheap']`, 1 current, header `固定 ollama/llama3:latest`; `Enter` → stored `"ollama/llama3:latest"` (verbatim, not normalised), live `"ollama/llama3:latest"`. `openrouter/x:free` likewise. `stripThinkingSuffix` only strips a known level |
| 2 | **A kind with no pin: the inherit row is current and `Enter` on it keeps inherit** | rows `['*(默认 / 继承主会话模型)', ' Strong', ' Cheap']`; `Enter` → `{"enabled":true}` (still no key). Then pick `p/cheap` → key written and re-registered; then `↑↑ Enter` → key deleted. Clearing is reachable in both directions |
| 3 | **An unknown-but-well-formed id is refused at write time, config untouched; clearing still works** | `model:"typo/does-not-exist"` reopened: rows `[' (默认…)', '*typo/does-not-exist（不在模型注册表）', …]`, 1 current; `Enter` → `模型 typo/does-not-exist 不在当前模型注册表中，未写入…`, config **byte-identical**, stored typo not cleared, nothing registered. `↑ Enter` → `{"enabled":true}` |
| 4 | **The page list equals what `control.agentKinds()` resolves — driven through the real control surface, not a snapshot** | config `executor, auditor, researcher(off, model p/cheap), reviewer(unshipped)`. `control.agentKinds()` → `[["executor",true,null],["auditor",true,null],["researcher",false,"p/cheap"]]`; `panel.pages()` → `[["session","主会话"],["subagent","子 agent（默认）"],["kind:executor","执行者 cw-executor"],["kind:auditor","审计者 cw-auditor"],["kind:researcher","调研者 cw-researcher","已关闭"]]`. Unshipped `reviewer` gets no page. Kind page header: `… [审计者 cw-auditor] … 本项目 .pi/Coworkflow.json · agentKinds.auditor`, and no `.pi/settings.json` on that page |
| 4b | **A disabled kind keeps its page, says it is off, and still stores/applies its model** | page note `已关闭`; header `当前：a/cheap · … · 固定 a/cheap · 该 kind 已关闭，模型仍然保留`; picking a model there writes `{"enabled":false,"model":"a/cheap"}` and registers nothing (`["cw-executor","cw-auditor"]` only) |
| 5a | **No regression on the session page** | real host `setModel`/`setThinkingLevel`: `↓ Enter` → `["setModel a/cheap"]`, status `主会话模型 → a/cheap（仅本会话）`; `→ ↓ Enter` → `+ "setThinkingLevel high"`, host thinking `high`; `Esc` closes. Thinking column `off|minimal|low|*medium|high|xhigh` |
| 5b | **No regression on the settings panel** | 29 rows; 子 agent tab `执行者 cw-executor │ [x] 开 · 上限 5 │ 已注册到 pi-subagents`, `调研者 cw-researcher │ [ ] 关 · 上限 5`; 状态 tab shows the new lines (`… 已注册 · 模型 a/cheap · 思考 继承`, `… 已关闭（不注册；派单会被拒绝） · 继承默认 · 思考 继承`). `modules/panel/settings.ts` has no diff |
| 5c | **No regression on the kind gate** | real `tool_call` hook: disabled `cw-researcher` → `{"block":true,"reason":"本项目在 /Coworkflow:settings 的「子 agent 类型」里关闭了 kind researcher（cw-researcher）。当前可用的 kind：cw-executor、cw-auditor；其他 agent 的派单不受影响。…"}`; `trellis-implement` and `toolName:"bash"` pass through. No gate logic in the diff |
| A | **A model change still changes the signature → re-registers; an identical definition does not** | register-call counter: 3 after the first pass → **4** after `setAgentKind({model:"p/cheap"})` (owner holds `p/cheap`) → **4** after re-applying the identical model (no re-registration) → **5** after `{thinking:"low"}` (owner holds `{model:"p/cheap",thinking:"low"}`) |
| B | **Clearing still removes the key and the definition drops it** | `{model:"p/cheap",thinking:"low"}` → `setAgentKind({model:null,thinking:null})` → stored `{"enabled":true}`, owner registry entry has no `model`/`thinking`, status `… 模型 继承，思考 继承（本会话已生效，无需重启）` |
| C | **Precedence kind → `subagents.defaultModel` → Pi default still holds** | through upstream's own `applyRuntimeAgentSettings` + `resolveEffectiveSubagentModel`: pinned kind → `p/cheap`; inheriting kind with project `defaultModel=p/strong` → `strong`; nothing configured → `p/session-model` (parent) |
| L1 | **Malformed values dropped on read, valid kept, definition follows** | `" a/cheap"` + `turbo` → `{enabled:true}`; 211-char id dropped, `thinking:"low"` kept; `a/cheap`/`high` kept. Owner registry mirrors it: `cw-executor` no model/thinking, `cw-auditor` `thinking:"low"`, `cw-researcher` `{model:"a/cheap",thinking:"high"}`. `setAgentKind` refuses the same shapes with a message (`模型 id 不可用：" a/cheap"（…）`, `未知思考等级："turbo"（可用：…）`) |
| L2 | **With `agent-kinds` off the pages say nothing is registered** | page note `本会话未启用`; header carries `本会话未启用 agent-kinds，未注册任何 kind（写入只改配置）`; owner registry empty |
| L3 | **The kind page's scope label names `.pi/Coworkflow.json`** | rendered header matches `.pi/Coworkflow.json · agentKinds.auditor` and not `.pi/settings.json` |
| L4 | **Ambiguity is unresolved, not "first match"** | two providers with id `twin`: rows/resolution pick the preferred provider on read; no preferred provider → unresolved |

## Practical limitations (no fix needed, parent should know)

1. **`setAgentKind` called directly still accepts an unknown-but-well-formed id.** Verified:
   `setAgentKind("auditor",{model:"typo/does-not-exist"})` → `… 模型 typo/does-not-exist …` written and
   registered. Deliberate and documented (the control surface has no model registry; the refusal lives
   in the panel, where the registry and the typing happen). Matches what the fix report states.
2. **The stored-pin row's own `detail` over-promises.** `shared.ts:380` reads
   `不在当前模型注册表中，无法写入；选中即清除该 kind 的固定模型`, but selecting that row and pressing
   `Enter` does **not** clear it — it is refused (`… 未写入（配置未改动；选中「继承」可清除…）`).
   The row's standing is correct (current, unwritable); its subtitle describes the inherit row's
   action. Cosmetic; two different lines in the same UI say opposite things about one keypress.
3. **A kind page's usage column shows nothing for a row standing for an unknown pin** (cursor context
   `registryKeyOf` → `""`). Correct and silent, as the fix report says.
4. **`scripts/verify.ts`'s `panel` probe cannot run — at HEAD either.** `ModelPanel is not a
   constructor`: `verify.ts:305` imports it from `modules/panel/models.ts`, which only lazily imports
   the class from `models-panel.ts`. Confirmed identical failure on a clean `git archive HEAD` tree,
   so it is pre-existing and the `kinds: []` line added in this pass is unreachable; the fix report's
   "its assertions still pass" is not reproducible by any command (`tsc` accepts it because the import
   is cast).

## One acceptance decision the parent owns

`prd.md` req. 3 and its acceptance bullet were **rewritten** in this pass from "one page per
**configured** kind — adding a kind adds a page; removing one removes it" to "one page per
**shipped** kind — the list is exactly what `control.agentKinds()` resolves". The code side is right
(`agentKinds()` → `resolveKinds` → `BUILTIN_KINDS`, so the pages can only follow the shipped table:
deleting the whole `agentKinds` block leaves the same five pages, and an unshipped `reviewer` gets no
page, both verified). The review said either the code or the claim must move; the claim moved, and
that is a requirements change, not only a docs change. `README.md`,
`.trellis/spec/frontend/agent-kinds.md`, `design.md` and the PRD all now state the shipped-table
reading consistently, so the project is self-consistent — but "a configured kind adds a page" is no
longer promised, and the remaining semantic gap (a project cannot add a kind without shipping an
asset) is now documented rather than implemented.

## Commands run — once each, in the worktree

```
npx tsc --noEmit   → exit 0 ("TypeScript: No errors found")
npm test           → tests 229, pass 229, fail 0, cancelled 0, skipped 0, todo 0, duration 11717.985916 ms
```

Worktree clean of my edits: `git status --porcelain` shows the same 19 entries before and after this
re-check (`15` modified tracked files, `+932/−80`; the two new test files and `.pi/`/`.trellis/` were
already untracked when I started). Nothing staged. Probe scripts are in `/tmp/recheck/`, outside the
repo.

## Not reviewed / out of scope

`modules/panel/settings.ts` (diff-free, exercised only for "still builds its rows"), the lane/usage
paths, the Trellis assets, and `modules/agent-kinds/assets/`. pi-subagents was imported, never written.
