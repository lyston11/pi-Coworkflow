/**
 * Contract tests for pi-Coworkflow.
 *
 * The manual harness (`scripts/verify.ts`) drives the real extension against a
 * real project; this file covers the parts that broke silently, which are exactly
 * the parts that mirror somebody else's format:
 *
 *   - async admission excludes foreground and management calls;
 *   - `after_start` is removed from `.trellis/config.yaml` even after `trellis
 *     update` reformats it (`modules/worktree`);
 *   - a module that fails is not recorded as on (`extensions/coworkflow.ts`);
 *   - user-level paths follow Pi's own agent directory (`core/agentdir.ts`);
 *   - a child's system prompt is built idempotently: repeated runs, generic
 *     agents, an off module, and a session replacement all keep exactly one
 *     injected block and keep the project's own instructions
 *     (`modules/subagent-context`, `core/trellis.ts`);
 *   - the division-of-work counter and its nudge are gone, not disabled
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

// ── async admission classification ────────────────────────────────────

test("capacity: only async execution counts, never management or foreground", async () => {
  const { startsAsyncRun } = await import("../core/capacity.ts");
  assert.equal(startsAsyncRun({}), true);
  assert.equal(startsAsyncRun({ async: true }), true);
  assert.equal(startsAsyncRun({ async: false }), false);
  assert.equal(startsAsyncRun({ action: "status" }), false);
  assert.equal(startsAsyncRun({ action: "lane.recordMerge" }), false);
  assert.equal(startsAsyncRun({ action: "resume" }), true);
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

// ── core/trellis.ts: stripping only what this package wrote ───────────

test("trellis: only the managed region leaves the project's own instructions", async () => {
  const { stripManagedRegion, stripOwnInjection } = (await import(here("../core/trellis.ts"))) as typeof import(
    "../core/trellis.ts"
  );

  const file = [
    "# Project Guide",
    "",
    "Run `npm test`; the build is `npm run build`.",
    "",
    "<!-- pi-Coworkflow:start -->",
    "## 工作流约束（pi-Coworkflow 受管区）",
    "### 核心分工：主会话只做脑子，执行全部交出去",
    "主会话只派单，不执行。阈值：≥12 次工具调用。",
    "<!-- pi-Coworkflow:end -->",
    "",
    "## 代码约定",
    "",
    "缩进两个空格。",
  ].join("\n");

  const stripped = stripManagedRegion(file);
  assert.doesNotMatch(stripped, /pi-Coworkflow:start/, "the region goes");
  assert.doesNotMatch(stripped, /主会话只派单/, "the parent-duty policy goes with it");
  assert.match(stripped, /npm test/, "the project's own build instructions stay");
  assert.match(stripped, /缩进两个空格/, "the project's own conventions stay");

  // A prompt this package already extended must not be extended twice.
  const injected = ["BASE", "<!-- pi-Coworkflow:subagent-context -->", "## block", "<!-- pi-Coworkflow:subagent-context:end -->"].join("\n\n");
  assert.equal(stripOwnInjection(injected), "BASE");
  assert.equal(stripOwnInjection("BASE"), "BASE");
});

// ── modules/subagent-context: child prompt lifecycle ──────────────────

interface ChildHarness {
  run(event: Record<string, unknown>): Record<string, unknown> | undefined;
  runtime: Record<string, unknown>;
  moduleOff(value: boolean): void;
  close(runtime?: Record<string, unknown>): void;
}

async function childHarness(options: {
  root: string;
  sessionName?: string;
  enabled?: boolean;
  moduleOn?: boolean;
  parentSessionId?: string | null;
}): Promise<ChildHarness> {
  const module = (await import(here("../modules/subagent-context/index.ts"))) as typeof import(
    "../modules/subagent-context/index.ts"
  );
  const handlers: ((event: any, ctx: any) => any)[] = [];
  let moduleOn = options.moduleOn ?? true;
  const host = {
    on(_event: string, handler: (event: any, ctx: any) => any) {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      };
    },
    // Read at call time, exactly as the real host does after a rename.
    getSessionName: () => options.sessionName,
  };
  const runtime: Record<string, unknown> = {
    isChild: true,
    enabled: options.enabled ?? true,
    cwd: options.root,
    sessionId: "child-session",
    parentSessionId: options.parentSessionId ?? null,
    sessionEpoch: 1,
    refresh: () => {},
    control: { moduleEnabled: () => moduleOn },
  };
  module.subagentContextModule.activate?.(host as never, runtime as never);
  return {
    run(event) {
      let result: Record<string, unknown> | undefined;
      for (const handler of handlers) {
        const produced = handler({ type: "before_agent_start", messageType: "user", ...event }, { cwd: options.root });
        if (produced !== undefined) result = produced as Record<string, unknown>;
      }
      return result;
    },
    runtime,
    moduleOff(value: boolean) {
      moduleOn = value;
    },
    close(override) {
      const closing = override ?? runtime;
      module.subagentContextModule.onSessionEnd?.(host as never, closing as never);
    },
  };
}

/** A project with a manifest task and both instruction files. */
async function tempChildProject(): Promise<string> {
  const root = tempProject();
  const task = join(root, ".trellis", "tasks", "10-20-demo");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "prd.md"), "# Requirements\n\nDo the thing.\n");
  mkdirSync(join(root, ".pi", "Coworkflow"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "Coworkflow", "subagent-AGENTS.md"),
    "# 子 agent 工作约定\n\n只做派单的那一件工作。\n",
  );
  return root;
}

test("subagent-context: repeated runs add one block, not one per run", async () => {
  const root = await tempChildProject();
  const harness = await childHarness({ root, sessionName: "trellis-implement: demo" });
  try {
    // The host keeps one `systemPromptOptions` per run and re-renders from it.
    const event = {
      prompt: "Task: Active task: .trellis/tasks/10-20-demo",
      systemPrompt: "BASE PROMPT",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    };

    for (let run = 0; run < 3; run += 1) {
      harness.run(event);
      const block = event.systemPromptOptions.sections.pi_coworkflow_child ?? "";
      assert.equal(
        block.split("<!-- pi-Coworkflow:subagent-context -->").length - 1,
        1,
        `run ${run + 1} must leave exactly one injected block`,
      );
      assert.match(block, /Active task: \.trellis\/tasks\/10-20-demo/, "the task survives every run");
      assert.match(block, /只做派单的那一件工作/, "the project guide is present every run");
    }
    assert.equal(harness.run(event) === undefined, true, "editing the options is not a forced prompt");
  } finally {
    harness.close();
  }
});

test("subagent-context: a generic child still gets guidance, and keeps the project's instructions", async () => {
  const root = await tempChildProject();
  const harness = await childHarness({ root, sessionName: "worker: tidy the README" });
  try {
    const event = {
      prompt: "Tidy the README",
      systemPrompt: "BASE",
      systemPromptOptions: {
        contextFiles: [
          {
            path: join(root, "AGENTS.md"),
            content: [
              "# Agent Guide",
              "",
              "Build with `npm run build`.",
              "",
              "### 核心分工：主会话只做脑子",
              "<!-- pi-Coworkflow:start -->",
              "主会话负责规划、派单、审计、合并。",
              "<!-- pi-Coworkflow:end -->",
              "",
              "## 提交规范",
              "",
              "小步提交。",
            ].join("\n"),
          },
        ],
        sections: {} as Record<string, string>,
      },
    };

    harness.run(event);
    const block = event.systemPromptOptions.sections.pi_coworkflow_child ?? "";
    assert.match(block, /子 agent 工作约定/, "an unknown role still receives the child guide");
    assert.match(block, /只做派单的那一件工作/, "the project's own child guide is used when it has one");
    assert.match(block, /你是被派发的子 agent/, "and the boundary always applies");

    const kept = event.systemPromptOptions.contextFiles as { content: string }[];
    assert.equal(kept.length, 1, "the project file itself is preserved");
    const content = kept[0]?.content ?? "";
    assert.doesNotMatch(content, /主会话负责规划/, "the parent-duty region is gone");
    assert.match(content, /npm run build/, "the project's build instructions stay");
    assert.match(content, /小步提交/, "the project's conventions stay");
  } finally {
    harness.close();
  }
});

test("subagent-context: a project without its own guide still gets the floor", async () => {
  // No `.pi/Coworkflow/subagent-AGENTS.md`: an unknown agent must not end up with
  // an empty instruction set just because the project never wrote one.
  const root = tempProject();
  const harness = await childHarness({ root, sessionName: "reviewer: look at this diff" });
  try {
    const event = {
      prompt: "Review the diff",
      systemPrompt: "BASE",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    };
    harness.run(event);
    const block = event.systemPromptOptions.sections.pi_coworkflow_child ?? "";
    assert.match(block, /不要扩大范围/, "the built-in floor applies");
    assert.doesNotMatch(block, /Active task:/, "and no task is invented");
  } finally {
    harness.close();
  }
});

test("subagent-context: an invalid task reference is reported, never rebound to the parent", async () => {
  const root = await tempChildProject();
  // The parent session points at a real task; the child names a missing one.
  const { setSessionFlag } = (await import(here("../core/trellis.ts"))) as typeof import("../core/trellis.ts");
  setSessionFlag(root, "parent-session", true);
  mkdirSync(join(root, ".trellis", ".runtime", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".trellis", ".runtime", "sessions", "pi_parent-session.json"),
    JSON.stringify({ current_task: ".trellis/tasks/10-20-demo" }),
  );

  const harness = await childHarness({ root, sessionName: "trellis-implement: typo", parentSessionId: "parent-session" });
  try {
    const event = {
      prompt: "Active task: .trellis/tasks/does-not-exist",
      systemPrompt: "BASE",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    };
    harness.run(event);
    const block = event.systemPromptOptions.sections.pi_coworkflow_child ?? "";
    assert.match(block, /does-not-exist/, "the bad reference is named");
    assert.doesNotMatch(block, /Active task: \.trellis\/tasks\/10-20-demo/, "the parent's task is not substituted");
    assert.match(block, /不要猜测或改用其它任务/, "and the child is told not to guess");
  } finally {
    harness.close();
  }
});

test("subagent-context: the module switch and the session switch are both live", async () => {
  const root = await tempChildProject();
  const harness = await childHarness({ root, sessionName: "trellis-check: demo" });
  const event = () => ({
    prompt: "Active task: .trellis/tasks/10-20-demo",
    systemPrompt: "BASE",
    systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
  });
  try {
    const on = event();
    harness.run(on);
    assert.ok(on.systemPromptOptions.sections.pi_coworkflow_child, "on by default");

    // Project switch off: no injection, without re-registering anything.
    harness.moduleOff(false);
    const off = event();
    harness.run(off);
    assert.deepEqual(off.systemPromptOptions.sections, {}, "a switched-off module injects nothing");

    // Back on in the same session: works again with no reload.
    harness.moduleOff(true);
    const again = event();
    harness.run(again);
    assert.ok(again.systemPromptOptions.sections.pi_coworkflow_child, "re-enabling needs no restart");

    // Session switch off: same, through `runtime.enabled`.
    harness.runtime.enabled = false;
    const stopped = event();
    harness.run(stopped);
    assert.deepEqual(stopped.systemPromptOptions.sections, {}, "a session that stopped loading injects nothing");

    harness.runtime.enabled = true;
    const restarted = event();
    harness.run(restarted);
    assert.ok(restarted.systemPromptOptions.sections.pi_coworkflow_child, "and resumes without a reload");
  } finally {
    harness.close();
  }
});

test("subagent-context: a host without structured options gets an idempotent prompt", async () => {
  const root = await tempChildProject();
  const harness = await childHarness({ root, sessionName: "trellis-research: survey" });
  try {
    const first = harness.run({ prompt: "Active task: .trellis/tasks/10-20-demo", systemPrompt: "BASE" });
    const prompt = String(first?.systemPrompt ?? "");
    assert.match(prompt, /Active task: \.trellis\/tasks\/10-20-demo/);
    assert.match(prompt, /\.trellis\/spec\//, "research gets the spec tree");

    const second = harness.run({ prompt: "Active task: .trellis/tasks/10-20-demo", systemPrompt: prompt });
    const next = String(second?.systemPrompt ?? "");
    assert.equal(next.split("<!-- pi-Coworkflow:subagent-context -->").length - 1, 1, "still one block");
    assert.equal(next.length <= prompt.length + 8, true, "and not a second copy of it");

    // The block names the roles, so a generic child's second run must not read its
    // own output and promote itself to a Trellis role.
    const generic = await childHarness({ root, sessionName: "worker: tidy the README" });
    try {
      const firstRun = generic.run({ prompt: "Tidy the README", systemPrompt: "BASE" });
      const injectedOnce = String(firstRun?.systemPrompt ?? "");
      assert.doesNotMatch(injectedOnce, /role: implement/, "a generic child gets no role context");
      const rerun = generic.run({ prompt: "Tidy the README", systemPrompt: injectedOnce });
      assert.doesNotMatch(
        String(rerun?.systemPrompt ?? ""),
        /role: implement/,
        "and does not acquire one by reading its own prompt",
      );
    } finally {
      generic.close();
    }
  } finally {
    harness.close();
  }
});

test("subagent-context: a finished session releases its hook", async () => {
  const root = await tempChildProject();
  const harness = await childHarness({ root, sessionName: "trellis-implement: demo" });
  const event = () => ({
    prompt: "Active task: .trellis/tasks/10-20-demo",
    systemPrompt: "BASE",
    systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
  });
  const live = event();
  harness.run(live);
  assert.ok(live.systemPromptOptions.sections.pi_coworkflow_child);

  harness.close();
  const closed = event();
  harness.run(closed);
  assert.deepEqual(closed.systemPromptOptions.sections, {}, "the finished session's hook is gone");

  // The next session in the same runtime attaches again.
  await childHarness({ root, sessionName: "trellis-implement: demo" });
  const next = event();
  harness.run(next);
  assert.deepEqual(next.systemPromptOptions.sections, {}, "the fake host is not shared across sessions");
});

// ── modules/agents: policy is text, not a runtime counter ─────────────

test("agents: the division measurement and its nudge are gone", async () => {
  const module = (await import(here("../modules/agents/index.ts"))) as typeof import("../modules/agents/index.ts");

  assert.equal("watchDivisionOfWork" in module, false, "the counter is deleted, not just disabled");
  assert.equal(module.agentsModule.activate, undefined, "and the module registers no runtime hook");
  assert.doesNotMatch(module.agentsModule.title, /测量/, "the title no longer advertises a measurement");

  const region = readFileSync(here("../modules/agents/assets/main-AGENTS.region.md"), "utf-8");
  assert.doesNotMatch(region, /≥12 次工具调用/, "the threshold instruction is gone from the region");
  assert.doesNotMatch(region, /agents` 模块会数这个/, "and so is the claim that a module counts it");
  assert.match(region, /pi-Coworkflow:start/, "the region keeps its sentinels");
  assert.match(region, /命名的 workflow/, "named workflows are how multi-stage work is expressed");
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

// ── extensions/coworkflow.ts: session lifecycle and module gates ──────

interface LifecycleHarness {
  emit(event: string, payload?: Record<string, unknown>): unknown[];
  host: Record<string, unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  off(): void;
}

/** Load the real extension against a temp project, as Pi would. */
async function loadExtension(options: {
  root: string;
  child?: boolean;
  autoEnable?: boolean;
  modules?: Record<string, boolean>;
}): Promise<LifecycleHarness> {
  const all = [
    "trellis",
    "worktree",
    "agents",
    "subagents",
    "subagent-context",
    "lane-worktree",
    "capacity",
    "panel",
  ];
  const modules: Record<string, boolean> = {};
  for (const id of all) modules[id] = options.modules?.[id] ?? true;
  writeFileSync(
    join(options.root, ".pi", "Coworkflow.json"),
    JSON.stringify({ version: 1, autoEnable: options.autoEnable ?? false, modules }, null, 2),
  );

  const saved = {
    cwd: process.cwd(),
    child: process.env.PI_SUBAGENT_CHILD,
    parent: process.env.PI_SUBAGENT_PARENT_SESSION,
    id: process.env.PI_SESSION_ID,
  };
  process.chdir(options.root);
  if (options.child) {
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_PARENT_SESSION = "/sessions/--x--/2026-01-01T00-00-00-000Z_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
  } else {
    delete process.env.PI_SUBAGENT_CHILD;
  }
  delete process.env.PI_SESSION_ID;

  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const host = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
      };
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, spec);
    },
    sendMessage() {},
    sendUserMessage() {},
    getSessionName: () => (options.child ? "trellis-implement: demo" : undefined),
  };

  const { default: extension } = (await import(here("../extensions/coworkflow.ts"))) as {
    default: (h: unknown) => void;
  };
  extension(host);

  const ctx = {
    cwd: options.root,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/--x--/2026-01-01T00-00-00-000Z_session-1.jsonl",
    },
    ui: { notify: () => {} },
  };

  return {
    host,
    commands,
    emit(event, payload = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(handler({ type: event, ...payload }, ctx));
      }
      return results;
    },
    off() {
      process.chdir(saved.cwd);
      if (saved.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = saved.child;
      if (saved.parent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
      else process.env.PI_SUBAGENT_PARENT_SESSION = saved.parent;
      if (saved.id === undefined) delete process.env.PI_SESSION_ID;
      else process.env.PI_SESSION_ID = saved.id;
    },
  };
}

function injected(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const options = (result as { systemPromptOptions?: { sections?: Record<string, string | undefined> } })
    .systemPromptOptions;
  return options?.sections?.pi_coworkflow_child ?? null;
}

test("lifecycle: a child injects, and a finished session releases the hook", async () => {
  const root = await tempChildProject();
  const loaded = await loadExtension({ root, child: true, autoEnable: true });
  try {
    const event = () => ({
      messageType: "user",
      prompt: "Active task: .trellis/tasks/10-20-demo",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    });
    const first = event();
    loaded.emit("before_agent_start", first);
    assert.ok(injected(first), "the loaded child injects its role context");

    // Quit, `/reload`, and session replacement all arrive as session_shutdown.
    loaded.emit("session_shutdown", { reason: "new", targetSessionFile: "/next.jsonl" });
    const closed = event();
    loaded.emit("before_agent_start", closed);
    assert.equal(injected(closed), null, "nothing from the finished session survives");

    // The next session announces itself and the runtime attaches again.
    loaded.emit("session_start", { reason: "new" });
    const next = event();
    loaded.emit("before_agent_start", next);
    assert.ok(injected(next), "the replacement session gets its own injection");
  } finally {
    loaded.emit("session_shutdown", { reason: "quit" });
    loaded.off();
  }
});

test("lifecycle: a project that switched the module off registers nothing", async () => {
  const root = await tempChildProject();
  const loaded = await loadExtension({
    root,
    child: true,
    autoEnable: true,
    modules: { "subagent-context": false },
  });
  try {
    const event = {
      messageType: "user",
      prompt: "Active task: .trellis/tasks/10-20-demo",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    };
    loaded.emit("before_agent_start", event);
    assert.equal(injected(event), null, "an off module has no hook, not a disabled one");
  } finally {
    loaded.emit("session_shutdown", { reason: "quit" });
    loaded.off();
  }
});

test("lifecycle: turning the layer on registers hooks without a reload", async () => {
  const root = await tempChildProject();
  // The child starts with the layer off: autoEnable is false and no session flag.
  const loaded = await loadExtension({ root, child: true, autoEnable: false });
  try {
    const event = () => ({
      messageType: "user",
      prompt: "Active task: .trellis/tasks/10-20-demo",
      systemPromptOptions: { contextFiles: [], sections: {} as Record<string, string> },
    });
    const before = event();
    loaded.emit("before_agent_start", before);
    assert.equal(injected(before), null, "not loaded yet");

    // Children follow their parent's persisted flag, not a child-local command.
    const { setSessionFlag } = await import("../core/trellis.ts");
    const parentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    assert.equal(setSessionFlag(root, parentId, true), true);

    const after = event();
    loaded.emit("before_agent_start", after);
    assert.ok(injected(after), "enabling the layer uses the same session, no reload");

    // And switching it off again stops injection at event time.
    assert.equal(setSessionFlag(root, parentId, false), true);
    const stopped = event();
    loaded.emit("before_agent_start", stopped);
    assert.equal(injected(stopped), null, "off takes effect immediately");
  } finally {
    loaded.emit("session_shutdown", { reason: "quit" });
    loaded.off();
  }
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

    // A fresh instance, because the module ids are read once when the extension
    // is evaluated: another test in this file may already have loaded it.
    const { default: extension, controlSurface } = (await import(
      `${here("../extensions/coworkflow.ts")}?probe-fail`
    )) as {
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
