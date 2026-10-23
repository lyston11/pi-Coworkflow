# Check: per-module switch default (80ea47c)

**Verdict: claim holds. No blocker.** Read-only; no code touched, nothing committed.

Rule read: `core/config.ts:resolveSwitch` — `typeof stored === "boolean"` → chosen, else `declared === "on"`,
default `DEFAULT_NEW_SWITCH = "on"`. `isEnabled` = `config !== null && resolveSwitch(...).on`.
`modules/index.ts` declares no `newSwitchDefault` on any of the 8 modules (docs it as intentionally `"on"`).

Comparison run (node --experimental-strip-types against the real production functions, old rule
`config.modules[id] !== false` vs `isEnabled(config, id, m.newSwitchDefault)`):

| config | modules | effective diffs |
|---|---|---|
| real `.pi/Coworkflow.json` (all 8 keys explicit) | 8 | `[]` — all `chosen` |
| `{version:1, modules:{}}` (none chosen) | 8 | `[]` — all `defaulted`, all on |

Both directions of the "explicit wins" rule also hold: `{future-gate:true}` vs declared `off` → on/chosen;
`{trellis:false}` vs declared `on` → off/chosen. `describeSwitches`/status/init mark `defaulted` separately
(`（默认）`, "该模块声明默认关闭，本项目未选择"), so no report implies consent.

Hypothetical gate (`{id:"future-gate", newSwitchDefault:"off"}`) added to a project that never chose it:
`{on:false, source:"defaulted"}` — off in both the real config and the empty config. Control: the same
`capacity` key absent reads `on` with today's declaration and would read `off` if it declared `"off"`
(`resolveSwitch({...modules:{}}, "capacity", "off") → {on:false, defaulted}`), so the mechanism is live, not inert.

Verification: `npx tsc --noEmit` clean; `npm test` 99/99 pass, incl. `scripts/switch-default.test.ts`.

Residual risk (not a blocker): the rule is declaration-driven only — the 8 current modules must keep
omitting `newSwitchDefault`; adding `"off"` to an existing id would change what an existing config means.
