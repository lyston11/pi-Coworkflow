/**
 * A newly added module's switch, and whether this project ever chose it.
 *
 * `isEnabled()` used to treat only an explicit `false` as off, so a module added
 * by a later version started enabled in *every* existing project. That is right
 * for a layer that observes or records, and wrong for anything that can refuse
 * work: the moment such a module appears in an upgrade it begins policing
 * projects that never opted in.
 *
 * The rule this file pins down:
 *
 *   - an explicit value in the config always wins, in both directions;
 *   - an absent key takes the module's declared `newSwitchDefault`;
 *   - the default for an undeclared module is `"on"`, so no module that exists
 *     today changes its effective switch;
 *   - a report marks a defaulted switch, because `on` alone reads as a decision
 *     this project made and for an absent key nobody made one;
 *   - the init pass still writes the full map, so what it says about a project
 *     is what the next read sees.
 *
 * The production functions are driven directly (`resolveSwitch`, `isEnabled`,
 * `describeSwitches`) and, for the write side, through the real extension's init
 * command on a temp project — not through a reimplementation of them.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_NEW_SWITCH,
  describeSwitches,
  isEnabled,
  resolveSwitch,
  type WorkflowConfig,
} from "../core/config.ts";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

/** A config that names exactly the modules it was given. */
function config(modules: Record<string, boolean>): WorkflowConfig {
  return { version: 1, modules };
}

// ── the rule, in isolation ────────────────────────────────────────────

test("switch default: an absent gate is off, an absent capability is on", () => {
  const written = config({});

  // A gate — a module that can refuse work — is not run in a project that never
  // opted in.
  assert.deepEqual(resolveSwitch(written, "gate", "off"), { on: false, source: "defaulted" });
  // A module that only observes records the default, which is on.
  assert.deepEqual(resolveSwitch(written, "observer", "on"), { on: true, source: "defaulted" });
  // Declaring nothing means today's behaviour, so the default cannot flip a
  // module by omission.
  assert.equal(DEFAULT_NEW_SWITCH, "on");
  assert.deepEqual(resolveSwitch(written, "undeclared"), { on: true, source: "defaulted" });
  assert.equal(isEnabled(written, "undeclared"), true);
});

test("switch default: an explicit value always wins over the declaration", () => {
  // A project that opted a gate *in* keeps it on.
  assert.deepEqual(resolveSwitch(config({ gate: true }), "gate", "off"), { on: true, source: "chosen" });
  assert.equal(isEnabled(config({ gate: true }), "gate", "off"), true);
  // And a project that turned a capability *off* keeps it off.
  assert.deepEqual(resolveSwitch(config({ observer: false }), "observer", "on"), {
    on: false,
    source: "chosen",
  });
  assert.equal(isEnabled(config({ observer: false }), "observer", "on"), false);
});

test("switch default: a report marks a switch the project never chose", () => {
  const declarations = [
    { id: "trellis" },
    { id: "gate", newSwitchDefault: "off" as const },
    { id: "observer" },
  ];

  const fresh = describeSwitches(config({}), declarations);
  assert.match(fresh, /trellis=on（默认）/);
  assert.match(fresh, /gate=off（默认）/);
  assert.match(fresh, /observer=on（默认）/);

  // Every key chosen: the line is a record of decisions, and says nothing else.
  const chosen = describeSwitches(config({ trellis: true, gate: true, observer: false }), declarations);
  assert.equal(chosen, "trellis=on gate=on observer=off");
  assert.doesNotMatch(chosen, /（默认）/, "a chosen switch is not hedged");

  // Mixed: only the untouched key is marked.
  const mixed = describeSwitches(config({ trellis: false, observer: true }), declarations);
  assert.equal(mixed, "trellis=off gate=off（默认） observer=on");
});

test("switch default: no module that exists today changes its effective switch", async () => {
  const { MODULES } = (await import(here("../modules/index.ts"))) as typeof import("../modules/index.ts");
  const ids = MODULES.map((module) => module.id);
  assert.ok(ids.includes("capacity") && ids.includes("trellis"), "the registry is the real one");

  // The old rule, spelled out: only an explicit `false` was off.
  const previous = (written: WorkflowConfig, id: string): boolean => written.modules[id] !== false;
  const samples: WorkflowConfig[] = [
    config({}),
    config(Object.fromEntries(ids.map((id) => [id, true]))),
    config(Object.fromEntries(ids.map((id) => [id, false]))),
    config(Object.fromEntries(ids.map((id) => [id, id !== "capacity"]))),
  ];
  for (const written of samples) {
    for (const module of MODULES) {
      assert.equal(
        isEnabled(written, module.id, module.newSwitchDefault),
        previous(written, module.id),
        `${module.id} must resolve exactly as it did before this change`,
      );
    }
  }

  // Stated, not implied: no module in the registry is a gate that has to start
  // off, and no module declares a default. `capacity` is the module that can
  // refuse a dispatch, and changing it now would change what every existing
  // config means — which this rule is not allowed to do.
  assert.deepEqual(
    MODULES.filter((module) => module.newSwitchDefault !== undefined).map((module) => module.id),
    [],
    "today's modules all keep the default; a future gate declares its own",
  );
});

// ── the write side: the init pass through the real extension ──────────

interface InitHarness {
  /** Run `/Coworkflow:init` (or `:status`) and return its report. */
  init(args: string): string;
  /** The written switch map, read back from disk. */
  stored(): Record<string, boolean>;
  close(): void;
}

/**
 * Load the extension over a temp project, with two probe modules in the
 * registry: an observation module and a gate module that declares `"off"`.
 *
 * The registry is read when the extension module is evaluated (`ALL_IDS`), so the
 * probes go in first and a fresh import sees them.
 */
async function loadInitHarness(root: string, opts: { writeConfig?: object | null } = {}): Promise<InitHarness> {
  const registry = (await import(here("../modules/index.ts"))) as typeof import("../modules/index.ts");
  registry.MODULES.push(
    { id: "probe-observe", title: "probe: observation", apply(ctx) { ctx.report("ok", "probe observe"); } },
    {
      id: "probe-gate",
      title: "probe: gate",
      // The classification is what the code does: this probe refuses work.
      newSwitchDefault: "off",
      apply(ctx) {
        ctx.report("ok", "probe gate");
      },
    },
  );

  if (opts.writeConfig !== null) {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "Coworkflow.json"),
      JSON.stringify(opts.writeConfig ?? { version: 1, autoEnable: false, modules: {} }, null, 2),
    );
  }

  const saved = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR };
  process.chdir(root);
  process.env.PI_CODING_AGENT_DIR = join(root, ".agent");
  try {
    const loaded = (await import(`${here("../extensions/coworkflow.ts")}?switch-${Math.random()}`)) as {
      default: (host: unknown) => void;
      controlSurface: () => { init(args: string): string };
    };
    const control = loaded.controlSurface();
    loaded.default({ registerCommand() {}, on() {}, sendMessage() {} });
    return {
      init: (args) => loaded.controlSurface().init(args),
      stored() {
        const parsed = JSON.parse(readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8")) as {
          modules: Record<string, boolean>;
        };
        return parsed.modules;
      },
      close() {
        void control;
        process.chdir(saved.cwd);
        if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
      },
    };
  } catch (error) {
    process.chdir(saved.cwd);
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    throw error;
  }
}

test("switch default: a project that never chose starts an observation and skips a gate", async () => {
  // A config written by an earlier version: it names the modules that existed
  // then, and says nothing about the two probes.
  const root = mkdtempSync(join(tmpdir(), "coworkflow-switch-"));
  const modules = Object.fromEntries(
    ["trellis", "worktree", "agents", "subagents", "subagent-context", "lane-worktree", "capacity", "panel"].map(
      (id) => [id, true],
    ),
  );
  const harness = await loadInitHarness(root, { writeConfig: { version: 1, autoEnable: false, modules } });
  try {
    const report = harness.init("");
    const written = harness.stored();

    assert.equal(written["probe-observe"], true, "a newly added capability starts on");
    assert.equal(written["probe-gate"], false, "a newly added gate does not start policing the project");
    for (const id of Object.keys(modules)) {
      assert.equal(written[id], true, `${id} keeps the value the project had chosen`);
    }
    // The map is still complete: an init pass records every module it knows.
    assert.equal(Object.keys(written).length, modules ? Object.keys(modules).length + 2 : 0);

    // And the report says which of those was never chosen. `on` alone would read
    // as consent this project did not give.
    assert.match(report, /probe-observe=on（默认）/);
    assert.match(report, /probe-gate=off（默认）/);
    assert.match(report, /trellis=on\b(?!（默认）)/);

    // Round trip: what was written is what the next read sees, unchanged.
    const again = harness.init("");
    assert.deepEqual(harness.stored(), written, "a second run rewrites the same switches");
    assert.match(again, /probe-gate=off\b(?!（默认）)/, "now it is a recorded value, not a default");
    assert.doesNotMatch(again, /probe-gate=off（默认）/);
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("switch default: --enable persists over a gate's default, and --disable over a capability's", async () => {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-switch-persist-"));
  const harness = await loadInitHarness(root, { writeConfig: null });
  try {
    // An uninitialized project has named nothing either, so the same rule applies:
    // there is one rule, and no "first install installs everything" exception to
    // keep in step with it. One `--enable` is how a gate gets chosen.
    harness.init("");
    const installed = harness.stored();
    assert.equal(installed["probe-gate"], false, "a gate is opted into, not assumed");
    assert.equal(installed["probe-observe"], true);

    // A project that opts the gate in keeps it on across later runs.
    harness.init("--enable probe-gate");
    assert.equal(harness.stored()["probe-gate"], true);
    const kept = harness.init("");
    assert.equal(harness.stored()["probe-gate"], true, "round trip preserves the explicit on");
    assert.doesNotMatch(kept, /probe-gate=on（默认）/, "and it reads as chosen, because it was");

    // And a project that turns a capability off keeps it off: an explicit value
    // always wins, in both directions.
    harness.init("--disable probe-observe");
    assert.equal(harness.stored()["probe-observe"], false);
    const off = harness.init("");
    assert.equal(harness.stored()["probe-observe"], false, "round trip preserves the explicit off");
    assert.doesNotMatch(off, /probe-observe=off（默认）/, "and it reads as chosen, because it was");
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
