# Stage 3 — per-module default for a newly added switch

## What changed

### `core/config.ts` — the rule

- `SwitchDefault = "on" | "off"` and `DEFAULT_NEW_SWITCH = "on"`.
- `SwitchDeclaration { id, newSwitchDefault? }` — a *structural* shape (`WorkflowModule`
  satisfies it) so `config.ts` keeps not importing `module.ts`, which imports it.
- `resolveSwitch(config, id, declared?) → { on, source: "chosen" | "defaulted" }` — the one
  implementation of the rule. An explicit boolean in `config.modules[id]` is `chosen`;
  an absent key is `defaulted` and takes `declared`.
- `isEnabled(config, id, declared?)` now delegates to `resolveSwitch`. Same signature shape as
  before for the two-argument call, so no caller that could not supply a declaration changed.
- `describeSwitches(config, declarations)` takes declarations instead of a resolved
  `Record<string, boolean>` — a boolean map cannot express "on because chosen" vs "on because
  defaulted", and that difference is the whole point of the change. A defaulted switch is
  suffixed `（默认）`.

### `core/module.ts` — the declaration

`WorkflowModule.newSwitchDefault?: SwitchDefault`, absent = `"on"`. The doc comment states the
classification criterion as *what the code does*, not the module's name.

### `extensions/coworkflow.ts` — every gate reads the declaration

`isEnabled(...)` gained `module.newSwitchDefault` at all five production call sites
(`ensureRuntime`, `activateSession`, `switchedOff` detection, `control.switches`,
`control.moduleEnabled` via `findModule(id)`), so a hook and the panel cannot disagree about an
absent key. `runtimeReport()` additionally distinguishes the two "not registered" cases:
`本项目把该模块关掉了` (chosen) vs `该模块声明默认关闭，本项目未选择` (defaulted).

The init pass (`runSetup`) resolves every module through `resolveSwitch` and keeps a parallel
`chosen` map, so the report line is built from what was chosen. The written map remains complete
(`writeConfig` still records every id and every value), which is what makes a second run print the
same switches as *chosen* — the round trip asserted in the test.

**No "first install" exception.** A project with no config has named nothing, which is the same
case as an absent key; keeping one rule means the default and the install path cannot drift apart.
Today this is a no-op (every current module defaults `"on"`, so an uninitialized project still
installs the whole layer), and it is the correct behaviour for a future gate.

### `modules/index.ts`, `README.md`

The registry documents the classification and states explicitly that **no module today declares
`newSwitchDefault`**: `capacity` is the module that *can* refuse a dispatch (`block: true` when the
limit is set and the upstream status is unreadable), so it would declare `"off"` if it were added
now — but reclassifying it would change what an existing config means, which the PRD forbids. The
README bullet that said "显式 `false` 才是关闭" and the "加一个模块" checklist now state the rule and
when a new module must declare `"off"`.

### `scripts/switch-default.test.ts` (new, in `npm test`)

Six tests through the production functions:

1. absent gate → off; absent capability → on; undeclared → on (`DEFAULT_NEW_SWITCH`);
2. explicit `true` beats a `"off"` declaration, explicit `false` beats `"on"`;
3. `describeSwitches` marks defaulted switches only, and prints nothing extra when everything was
   chosen;
4. **no current module's effective switch changed** — the pre-change rule
   (`modules[id] !== false`) is compared against `isEnabled` for every registry module across four
   sample configs, and the test asserts the set of modules declaring a default is empty;
5. a config written by an earlier version, loaded through the real extension: a probe observation
   module starts on, a probe gate module declaring `"off"` starts off, the eight real modules keep
   their chosen values, the written map is still complete, the report marks the two defaults, and the
   second run reads them back as chosen (round trip);
6. `--enable` on a gate and `--disable` on a capability both persist and read as chosen afterwards.

## Verification

- `npm run typecheck` — clean.
- `npm test` — **98/98** (92 before + 6 new).
- `node --experimental-strip-types --test scripts/switch-default.test.ts` — 6/6.
- Spot check on a dry run over a config naming only `trellis` + `panel`:
  `开关: trellis=on worktree=on（默认） agents=on（默认） … panel=on` — one line, and it never claims
  a decision the project did not make.

## Notes

- Stages 1 and 2 untouched: no change to `core/trellis.ts`, the resolver, `modules/lane-worktree`,
  or `b79870f`'s native RPC/workflow/usage/lane behavior, panel layout or keys.
- `capacity` is deliberately left at the default. The change is what happens to *future* modules.
