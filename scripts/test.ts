/**
 * Contract tests for pi-Coworkflow.
 *
 * The manual harness (`scripts/verify.ts`) drives the real extension against a
 * real project; this file covers the parts that broke silently, which are exactly
 * the parts that mirror somebody else's format:
 *
 *   - a dispatch's run id and a failure notification's child id are two key
 *     spaces, and the ledger is the only place they meet (`core/ledger.ts`);
 *   - `after_start` is removed from `.trellis/config.yaml` even after `trellis
 *     update` reformats it (`modules/worktree`);
 *   - a module that fails is not recorded as on (`extensions/coworkflow.ts`);
 *   - user-level paths follow Pi's own agent directory (`core/agentdir.ts`);
 *   - the division-of-work measurement fires once, and only when it should
 *     (`modules/agents`).
 *
 * Every test runs in a temp directory: nothing here touches the project.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-test-"));
  mkdirSync(join(root, ".trellis"), { recursive: true });
  mkdirSync(join(root, ".pi"), { recursive: true });
  return root;
}

// ── core/ledger.ts ────────────────────────────────────────────────────

test("ledger: a dispatch resolves from its run id, and nothing is guessed", async () => {
  const { DispatchLedger } = (await import(here("../core/ledger.ts"))) as typeof import("../core/ledger.ts");

  const ledger = new DispatchLedger();
  ledger.record("call-1", { agent: "trellis-implement", task: "Active task: .trellis/tasks/a" });
  ledger.record("call-2", { agent: "trellis-check", task: "Active task: .trellis/tasks/b" });
  ledger.bindRun("call-1", "run-1");

  assert.equal(ledger.resolve({ runId: "run-1" })?.agent, "trellis-implement");
  // A run id the ledger never saw is unknown, not "the only outstanding launch".
  assert.equal(ledger.resolve({ runId: "run-unknown" }), undefined);
  assert.equal(ledger.resolve({ childKey: "child-unknown" }), undefined);
});

test("ledger: a refusal from a gate keeps the call out of the record", async () => {
  const { DispatchLedger } = (await import(here("../core/ledger.ts"))) as typeof import("../core/ledger.ts");

  const ledger = new DispatchLedger();
  ledger.onGate(() => ({ block: true, reason: "over the limit" }));

  const decision = ledger.gate({}, { toolName: "subagent" }, {});
  assert.equal(decision?.block, true);
  assert.equal(ledger.get("call-1"), undefined);
});

test("ledger: only a new run counts, never a management call", async () => {
  const { startsNewRun } = (await import(here("../core/ledger.ts"))) as typeof import("../core/ledger.ts");

  assert.equal(startsNewRun({}), true);
  assert.equal(startsNewRun({ async: true }), true);
  assert.equal(startsNewRun({ async: false }), false);
  assert.equal(startsNewRun({ action: "status" }), false);
  assert.equal(startsNewRun({ action: "lane.recordMerge" }), false);
  assert.equal(startsNewRun({ action: "resume" }), true);
});

// ── modules/worktree ──────────────────────────────────────────────────

test("worktree: after_start is removed after config.yaml is reformatted", async () => {
  const { worktreeModule } = (await import(here("../modules/worktree/index.ts"))) as typeof import(
    "../modules/worktree/index.ts"
  );
  const root = tempProject();
  const configPath = join(root, ".trellis", "config.yaml");
  writeFileSync(configPath, "version: 1\n");

  const applied: string[] = [];
  const context = {
    root,
    prefix: "wt-",
    dry: false,
    options: {},
    report: (status: string, message: string) => applied.push(`${status}:${message}`),
    read: (path: string) => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    write: (path: string, body: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return "updated";
    },
    remove: () => "ok",
  };

  worktreeModule.apply?.(context as never);
  assert.match(readFileSync(configPath, "utf-8"), /after_start/);

  // `trellis update` reformats: indentation and blank lines change, the entry stays.
  const reformatted = readFileSync(configPath, "utf-8")
    .replace("hooks:\n", "hooks:\n\n")
    .replace("  after_start:\n", "  after_start:\n\n");
  writeFileSync(configPath, reformatted);

  worktreeModule.remove?.(context as never);
  const after = readFileSync(configPath, "utf-8");
  assert.doesNotMatch(after, /auto_worktree/, "the hook entry must be gone");
  assert.doesNotMatch(after, /after_start/, "an emptied after_start key is not valid Trellis config");
  assert.doesNotMatch(after, /^hooks:/m, "an emptied hooks section is removed with it");
  assert.doesNotMatch(
    after,
    /pi-Coworkflow/,
    "the marker the module added goes with it, leaving no dangling heading",
  );
});

test("worktree: a following section's deeper keys do not block the removal", async () => {
  const { worktreeModule } = (await import(here("../modules/worktree/index.ts"))) as typeof import(
    "../modules/worktree/index.ts"
  );
  const root = tempProject();
  const configPath = join(root, ".trellis", "config.yaml");
  const original = [
    "version: 1",
    "",
    "# pi-Coworkflow: task hooks",
    "hooks:",
    "  after_start:",
    '    - "python3 .trellis/scripts/hooks/auto_worktree.py"',
    "",
    "#-------------------------------------------------------------------------------",
    "# Channel worker OOM guard",
    "#-------------------------------------------------------------------------------",
    "channel:",
    "  worker_guard:",
    "    max_live_workers: 6",
    "",
  ].join("\n");
  writeFileSync(configPath, original);

  const context = {
    root,
    prefix: "wt-",
    dry: false,
    report: () => {},
    read: (path: string) => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    write: (path: string, body: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return "updated";
    },
    remove: () => "ok",
  };

  worktreeModule.remove?.(context as never);
  const after = readFileSync(configPath, "utf-8");
  // `channel.worker_guard.max_live_workers` is indented deeper than `after_start:`,
  // and an emptiness check that scanned to end-of-file used to treat it as a child
  // of the hook section — so nothing was removed at all.
  assert.doesNotMatch(after, /after_start/, "the emptied after_start key must go");
  assert.doesNotMatch(after, /^hooks:/m, "the emptied hooks section must go");
  assert.match(after, /max_live_workers: 6/, "the following section is untouched");
  assert.doesNotMatch(after, /\n{3,}/, "no extra blank lines are left behind");
});

test("worktree: a hand-written after_start entry is reported, not rewritten", async () => {
  const { worktreeModule } = (await import(here("../modules/worktree/index.ts"))) as typeof import(
    "../modules/worktree/index.ts"
  );
  const root = tempProject();
  const configPath = join(root, ".trellis", "config.yaml");
  const original = "version: 1\nhooks:\n  after_start:\n    - \"make setup\"\n";
  writeFileSync(configPath, original);

  const reports: string[] = [];
  worktreeModule.remove?.({
    root,
    prefix: "wt-",
    dry: false,
    report: (status: string, message: string) => reports.push(`${status}:${message}`),
    read: (path: string) => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return null;
      }
    },
    write: (path: string, body: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      return "updated";
    },
    remove: () => "ok",
  } as never);

  assert.equal(readFileSync(configPath, "utf-8"), original, "someone else's entry is left alone");
  assert.ok(reports.some((line) => line.startsWith("ok:")), reports.join("\n"));
});

// ── core/agentdir.ts ──────────────────────────────────────────────────

test("agentdir: PI_CODING_AGENT_DIR and PI_CONFIG_DIR are honoured", async () => {
  const { agentDir } = (await import(here("../core/agentdir.ts"))) as typeof import("../core/agentdir.ts");
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_CONFIG_DIR };
  try {
    process.env.PI_CODING_AGENT_DIR = "/tmp/agent-explicit";
    assert.equal(agentDir(), "/tmp/agent-explicit");

    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CONFIG_DIR = ".config/pi";
    assert.match(agentDir(), /\.config\/pi\/agent$/);
  } finally {
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.dir;
    if (saved.config === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = saved.config;
  }
});

// ── modules/agents: the division-of-work measurement ──────────────────

test("agents: the nudge stays silent below the threshold", async () => {
  const { watchDivisionOfWork } = (await import(here("../modules/agents/index.ts"))) as typeof import(
    "../modules/agents/index.ts"
  );

  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const host = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, handler);
    },
  };
  watchDivisionOfWork(host as never, { enabled: true } as never);

  for (let i = 0; i < 3; i += 1) {
    handlers.get("tool_call")?.({ toolName: "bash", input: { command: `cat a${i}.ts` } }, {});
  }
  assert.equal(handlers.get("before_agent_start")?.({ messageType: "user" }, {}), undefined);
});

test("agents: the report fires once, out of band, after enough un-delegated work", async () => {
  const { watchDivisionOfWork } = (await import(here("../modules/agents/index.ts"))) as typeof import(
    "../modules/agents/index.ts"
  );

  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const printed: string[] = [];
  const host = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, handler);
    },
    sendMessage(message: { content: string }) {
      printed.push(message.content);
    },
  };
  watchDivisionOfWork(host as never, { enabled: true } as never);

  for (let i = 0; i < 14; i += 1) {
    handlers.get("tool_call")?.(
      { toolName: i % 2 === 0 ? "edit" : "write", input: { path: `src/file${i % 5}.ts` } },
      {},
    );
  }

  assert.equal(printed.length, 1, "exactly one report per session");
  assert.match(printed[0] ?? "", /尚未派发任何子 agent/);
  // The report must never become part of the conversation the model continues.
  assert.equal(handlers.get("before_agent_start"), undefined, "no prompt injection");
});

test("agents: a dispatched child silences the report", async () => {
  const { watchDivisionOfWork } = (await import(here("../modules/agents/index.ts"))) as typeof import(
    "../modules/agents/index.ts"
  );

  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const printed: string[] = [];
  const host = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, handler);
    },
    sendMessage(message: { content: string }) {
      printed.push(message.content);
    },
  };
  watchDivisionOfWork(host as never, { enabled: true } as never);

  handlers.get("tool_call")?.({ toolName: "subagent", input: { agent: "worker" } }, {});
  for (let i = 0; i < 20; i += 1) {
    handlers.get("tool_call")?.({ toolName: "edit", input: { path: `src/file${i % 6}.ts` } }, {});
  }
  assert.deepEqual(printed, []);
});

test("trellis: a session file path resolves to the id it contains", async () => {
  const { sessionIdFromFile, sessionKeys } = (await import(here("../core/trellis.ts"))) as typeof import(
    "../core/trellis.ts"
  );

  const file =
    "/Users/x/.pi/agent/sessions/--Users-x-proj--/2026-10-18T15-27-23-012Z_01a14f9f-eb83-75f4-b91f-b57ae19d2f6b.jsonl";
  assert.equal(sessionIdFromFile(file), "01a14f9f-eb83-75f4-b91f-b57ae19d2f6b");
  assert.equal(sessionIdFromFile("01a14f9f-eb83-75f4-b91f-b57ae19d2f6b"), null);
  assert.deepEqual(
    sessionKeys(file).sort(),
    ["01a14f9f-eb83-75f4-b91f-b57ae19d2f6b", file].sort(),
    "both spellings resolve, so a child reading the parent's path finds the flag",
  );
});

// ── extensions/coworkflow.ts: a failed module is not recorded as on ───

test("init: a module that reports an error is recorded as off", async () => {
  const root = tempProject();
  const saved = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR };
  process.chdir(root);
  // Keep the trust store out of the real one.
  process.env.PI_CODING_AGENT_DIR = join(root, ".agent");
  try {
    // The registry is read when the extension module is evaluated, so the probe
    // has to be in it first — that is also why the import is dynamic here.
    const registry = (await import(here("../modules/index.ts"))) as typeof import("../modules/index.ts");
    registry.MODULES.push({
      id: "probe-fail",
      title: "probe",
      apply(ctx: { report(status: string, message: string): void }) {
        ctx.report("error", "injected failure");
      },
    });

    const { default: extension, controlSurface } = (await import(here("../extensions/coworkflow.ts"))) as {
      default: (host: unknown) => void;
      controlSurface: () => { init(args: string): string };
    };
    extension({ registerCommand() {}, on() {}, sendMessage() {} });

    const disabled = [
      "trellis",
      "worktree",
      "agents",
      "subagents",
      "subagent-context",
      "lane-worktree",
      "capacity",
      "panel",
    ]
      .map((id) => `--disable ${id}`)
      .join(" ");
    const output = controlSurface().init(disabled);
    assert.match(output, /injected failure/);

    const config = JSON.parse(readFileSync(join(root, ".pi", "Coworkflow.json"), "utf-8")) as {
      modules: Record<string, boolean>;
    };
    assert.equal(config.modules["probe-fail"], false, "a module that failed must not read as installed");
    assert.equal(config.modules.trellis, false, "a disabled module stays off");
  } finally {
    process.chdir(saved.cwd);
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  }
});
