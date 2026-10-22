/**
 * Verification harness for pi-Coworkflow.
 *
 * Drives the real extension with a fake host so both layers run for real —
 * install modules write files, runtime modules hook the fake session — without
 * a TUI.
 *
 * Usage:
 *   node scripts/verify.ts <project-dir> Coworkflow:init [args]
 *   node scripts/verify.ts <project-dir> Coworkflow:status [args]
 *   node scripts/verify.ts <project-dir> Coworkflow:start [on|off|status]
 *   node scripts/verify.ts <project-dir> Coworkflow:lanes
 *   node scripts/verify.ts <project-dir> commands
 *   node scripts/verify.ts <project-dir> config
 *   node scripts/verify.ts <project-dir> settings [DOWN|UP|ENTER|LEFT|RIGHT|SPACE …]
 *   node scripts/verify.ts <project-dir> panel
 *   node scripts/verify.ts <project-dir> child-inject "<dispatch prompt>"
 *   node scripts/verify.ts <project-dir> lane-record <handoff.json>
 *   node scripts/verify.ts <project-dir> session-start [reason]
 *   node scripts/verify.ts <project-dir> subagent-call <agent> <task>
 *
 * The dispatch-retry scenario is gone on purpose: that retry was removed, and a
 * harness that can still drive it would be describing behaviour this package no
 * longer has.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type CommandOptions = {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type RuntimeEventHandler = (event: unknown, ctx: unknown) => unknown;

interface PanelLike {
  render(width: number): string[];
  handleInput(data: string): void;
}

/** Resolve a package file relative to this script, so the harness is portable. */
const here = (rel: string): string => new URL(rel, import.meta.url).pathname;

const [projectDirArg, command, ...rest] = process.argv.slice(2);
const projectDir = projectDirArg ?? process.cwd();

// The extension resolves the project config and cwd from the process, exactly
// as it does inside Pi, so the harness must stand in the project directory.
process.chdir(projectDir);

// Environment must be set before the extension module is evaluated: it reads
// the child markers and the parent session id at load time.
if (command === "child-inject") {
  process.env.PI_SUBAGENT_CHILD = "1";
  // pi-subagents publishes the parent as a session *file* path, which is what the
  // real child has to resolve back to a session id. Using an id here would hide a
  // key-space mismatch — exactly the bug this harness exists to catch.
  process.env.PI_SUBAGENT_PARENT_SESSION =
    process.env.PI_VERIFY_PARENT_SESSION ??
    `${process.env.HOME}/.pi/agent/sessions/--verify--/2026-01-01T00-00-00-000Z_parent-session-1.jsonl`;
}

const commands = new Map<string, CommandOptions>();
const handlers = new Map<string, RuntimeEventHandler[]>();
const printed: string[] = [];
/**
 * Messages the extension queued as user-role turns (`sendUserMessage`).
 *
 * Nothing should appear here: the layer reports to the transcript, never into the
 * conversation. `subagent-call` prints it so a regression that starts talking to
 * the model as a user is visible instead of silent.
 */
const userMessages: string[] = [];

const host = {
  registerCommand(name: string, options: CommandOptions) {
    commands.set(name, options);
  },
  on(event: string, handler: RuntimeEventHandler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return () => {};
  },
  sendMessage(message: { content: string }) {
    printed.push(message.content);
  },
  sendUserMessage(message: { content: string }) {
    userMessages.push(message.content);
  },
  getSessionName: () => process.env.PI_VERIFY_SESSION_NAME,
};

const mod = (await import("../extensions/coworkflow.ts")) as {
  default: (api: unknown) => void;
  controlSurface: () => unknown;
};
mod.default(host);
// The panels take their state from the real control surface, not a stand-in.
(globalThis as { __coworkflowControl?: unknown }).__coworkflowControl = mod.controlSurface();

const ctx = {
  cwd: projectDir,
  mode: process.env.PI_VERIFY_MODE ?? "tui",
  sessionManager: {
    // `PI_VERIFY_SESSION_ID` lets a test keep the load-time env id empty while
    // still handing Pi a real session id, which is what a `/reload` looks like.
    getSessionId: () => process.env.PI_VERIFY_SESSION_ID ?? process.env.PI_SESSION_ID ?? "verify-session",
    // Parent history may use this path; capacity uses the public current-session RPC.
    getSessionFile: () => process.env.PI_VERIFY_SESSION_FILE,
  },
  ui: {
    notify: (msg: string, type?: string) => console.log(`[notify:${type}] ${msg}`),
    // Input and confirmation are driven by env vars so panel actions that ask a
    // question can be exercised headlessly.
    confirm: async () => process.env.PI_VERIFY_CONFIRM !== "no",
    input: async () => process.env.PI_VERIFY_INPUT,
  },
  isProjectTrusted: () => process.env.PI_VERIFY_TRUSTED !== "no",
};

async function emit(event: string, payload: unknown): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers.get(event) ?? []) {
    results.push(await handler(payload, ctx));
  }
  return results;
}

switch (command) {
  case "Coworkflow:init":
  case "Coworkflow:status":
  case "Coworkflow:start": {
    const selected = commands.get(command);
    if (!selected) throw new Error(`command not registered: ${command}`);
    await selected.handler(rest.join(" "), ctx);
    console.log(printed.join("\n"));
    break;
  }

  case "settings": {
    // The class lives in the lazily imported renderer module, which is where the host
    // UI packages are allowed to be imported; `settings.ts` only registers the command.
    const { buildSettingRows } = (await import(
      here("../modules/panel/settings.ts")
    )) as unknown as {
      buildSettingRows: (control: unknown, ctx: unknown) => unknown[];
    };
    const { SettingsPanel } = (await import(here("../modules/panel/settings-panel.ts"))) as unknown as {
      SettingsPanel: new (
        io: unknown,
        theme: unknown,
        tui: unknown,
        keybindings?: unknown,
      ) => PanelLike;
    };
    const control = (globalThis as { __coworkflowControl?: unknown }).__coworkflowControl;
    if (!control) throw new Error("harness did not capture the control surface");

    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    let panel: PanelLike & { reload(status: string): void };
    const io = {
      rows: () => buildSettingRows(control, ctx),
      close: () => {},
      changed: (status: string) => panel.reload(status),
    };
    panel = new SettingsPanel(io, theme, { requestRender: () => {} }) as unknown as typeof panel;

    // Named keys, so the harness drives the same gestures a user does: the
    // settings panel's Space/←→ act on the row the cursor is on.
    const keyOf = (name: string): string =>
      name === "DOWN" ? "\x1b[B"
      : name === "UP" ? "\x1b[A"
      : name === "ENTER" ? "\r"
      : name === "LEFT" ? "\x1b[D"
      : name === "RIGHT" ? "\x1b[C"
      : name === "SPACE" ? " "
      : name;

    console.log("--- settings (width 76) ---");
    console.log(panel.render(76).join("\n"));
    for (const name of rest) {
      panel.handleInput(keyOf(name));
      await new Promise((resolve) => setTimeout(resolve, 25));
      console.log(`--- after ${name} ---`);
      console.log(panel.render(76).join("\n"));
    }
    break;
  }

  case "child-inject": {
    const prompt = rest.join(" ");
    const results = await emit("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt,
      systemPrompt: "BASE PROMPT",
    });
    const injected = results.find(
      (result): result is { systemPrompt: string } =>
        result !== null &&
        typeof result === "object" &&
        typeof (result as { systemPrompt?: unknown }).systemPrompt === "string",
    );
    if (!injected) {
      console.log("(no injection)");
      break;
    }
    console.log(`--- injected system prompt (${injected.systemPrompt.length} chars) ---`);
    console.log(injected.systemPrompt);
    break;
  }

  case "lane-record": {
    const handoffPath = rest[0] ?? "";
    if (!handoffPath) throw new Error("lane-record needs a handoff manifest path");
    // Create the manifest the recorder will read back, with the shape
    // pi-subagents writes (shared/types.ts: ParallelHandoffManifest).
    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(
      handoffPath,
      JSON.stringify(
        {
          version: 1,
          runId: handoffPath.replace(/\.json$/, "").split("/").pop(),
          mode: "parallel",
          source: "async",
          cwd: projectDir,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          groups: [
            {
              stepIndex: 0,
              baseCommit: "0".repeat(40),
              repoRoot: projectDir,
              children: [
                {
                  index: 0,
                  taskIndex: 0,
                  agent: "trellis-implement",
                  status: "completed",
                  summary: "done",
                  patch: {
                    path: `${projectDir}/.pi/subagents/artifacts/patches/lane-0.patch`,
                    branch: "pi-subagents/lane-0",
                    changed: true,
                    diffStat: "2 files changed, 12 insertions(+), 3 deletions(-)",
                    filesChanged: 2,
                    insertions: 12,
                    deletions: 3,
                  },
                },
              ],
              cleanup: {
                state: "complete",
                pruned: false,
                tasks: [
                  {
                    index: 0,
                    path: `${projectDir}/../lane-0`,
                    branch: "pi-subagents/lane-0",
                    worktreeRemoved: false,
                    branchRemoved: false,
                  },
                ],
              },
            },
          ],
          cleanupEligibility: { state: "terminal-blocked", reason: "merge evidence missing" },
        },
        null,
        2,
      ),
    );

    await emit("tool_call", {
      type: "tool_call",
      toolName: "subagent",
      toolCallId: "call-1",
      input: { agent: "trellis-implement", async: true, worktree: true },
    });
    await emit("tool_result", {
      type: "tool_result",
      toolName: "subagent",
      toolCallId: "call-1",
      input: { agent: "trellis-implement" },
      content: [{ type: "text", text: `child finished\n\nParallel handoff: ${handoffPath}` }],
      details: { runId: handoffPath.replace(/\.json$/, "").split("/").pop(),
        parallelHandoff: { version: 1, path: handoffPath } },
      isError: false,
    });
    console.log("native lane link observed (requires a valid current task)");
    break;
  }

  case "Coworkflow:lanes": {
    const selected = commands.get("Coworkflow:lanes");
    if (!selected) throw new Error("Coworkflow:lanes is not registered (session not started?)");
    await selected.handler(rest.join(" "), ctx);
    console.log(printed.join("\n"));
    break;
  }

  case "panel": {
    // The class lives in the lazily imported renderer module — that split is what keeps a
    // host without the UI packages from losing the whole extension. Importing it from
    // `models.ts` (which only re-exports types) failed with "not a constructor", so this
    // probe had been unrunnable since the split.
    const { ModelPanel } = (await import(
      here("../modules/panel/models-panel.ts")
    )) as unknown as { ModelPanel: new (port: unknown, theme: unknown, tui: unknown) => PanelLike };
    const usageModule = "../core/usage.ts";
    const { collectUsageHistory, formatNativeCost } = (await import(
      here(usageModule)
    )) as typeof import("../core/usage.ts");

    // Pi history stays chartable when native cost is unavailable. Production
    // public RPC and sessionFile ingestion are covered by usage.test.ts.
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "clinepass",
          model: "cline-pass/deepseek-v4.1-flash",
          usage: {
            input: 30000,
            output: 2500,
            cacheRead: 22000,
            cacheWrite: 1000,
            cost: { total: 0.0123 },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "buddy2api",
          model: "glm-5.3-flash",
          usage: { input: 4000, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0009 } },
        },
      },
      { type: "usage", kind: "cache_warm", provider: "clinepass", model: "cline-pass/deepseek-v4.1-flash", usage: { input: 0, output: 0, cacheRead: 6000, cacheWrite: 0, cost: { total: 0.0002 } } },
    ];
    const observation = {
      cost: { kind: "unknown" as const, reason: "verify fixture 未连接原生 cost" },
      parentEntries: entries.map((entry) => ({ ...entry, timestamp: new Date().toISOString() })),
      childEntries: [], historyIssues: ["verify fixture 未连接原生 cost"],
    };

    const calls: string[] = [];
    let closed = false;
    const models = [
      { provider: "clinepass", id: "deepseek-v4.1-flash", name: "DeepSeek Flash", available: true },
      { provider: "clinepass", id: "glm-5.3-flash", name: "GLM Flash", available: true },
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", available: true },
    ];
    const snapshot = {
      models,
      sessionModel: "clinepass/deepseek-v4.1-flash",
      sessionThinking: "medium",
      subagentModel: "",
      subagentThinking: "",
      sessionEffectiveModel: models[0],
      subagentEffectiveModel: models[0],
      // No kinds in this probe: `snapshot.kinds` is what `/Comodels` derives its
      // per-kind pages from, and an empty list leaves the two scope pages.
      kinds: [],
      // The panel charts the model under the cursor, so the snapshot carries one
      // 7-day series rather than a map.
      history: {
        selectedModel: "clinepass/deepseek-v4.1-flash",
        selected: collectUsageHistory(observation, "clinepass/cline-pass/deepseek-v4.1-flash", 7),
        costSummary: formatNativeCost(observation.cost),
      },
    };
    const port = {
      snapshot: () => snapshot,
      applySessionModel: async (model: { provider: string; id: string }) => {
        calls.push(`session.model=${model.provider}/${model.id}`);
        return "主会话模型 → " + model.id;
      },
      applySessionThinking: (level: string) => {
        calls.push(`session.thinking=${level}`);
        return `主会话思考等级 → ${level}`;
      },
      applySubagentModel: (model: { provider: string; id: string } | null) => {
        calls.push(`subagent.model=${model ? `${model.provider}/${model.id}` : "(inherit)"}`);
        return "子 agent 模型已应用";
      },
      applySubagentThinking: (level: string | null) => {
        calls.push(`subagent.thinking=${level ?? "(default)"}`);
        return "子 agent 思考等级已应用";
      },
      close: () => {
        closed = true;
      },
      requestRender: () => {},
    };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const panel = new ModelPanel(port, theme, { requestRender: () => {} });

    const keys: [string, string][] = [
      ["Right → 思考列（光标落在当前值 medium）", "\x1b[C"],
      ["Down → high", "\x1b[B"],
      ["Enter 应用思考", "\r"],
      ["Tab → 子 agent tab（仍停在思考）", "\t"],
      ["Enter → 思考设为默认", "\r"],
      ["Down → off", "\x1b[B"],
      ["Enter 应用子 agent 思考", "\r"],
      ["Left → 模型列（光标落在 继承主会话模型）", "\x1b[D"],
      ["Down → 第一个模型", "\x1b[B"],
      ["Enter 应用子 agent 模型", "\r"],
      ["Tab → 回到主会话 tab", "\t"],
    ];

    const panelWidth = Number(process.env.PI_VERIFY_WIDTH ?? "72");
    console.log(`--- initial render (width ${panelWidth}) ---`);
    console.log(panel.render(panelWidth).join("\n"));
    for (const [label, key] of keys) {
      panel.handleInput(key);
      const status = panel
        .render(panelWidth)
        .map((line: string) => line.trim())
        .find((line: string) => line.includes("→"));
      console.log(`--- after ${label} ---\nstatus: ${status ?? "(无)"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.log("--- calls ---");
    for (const call of calls) console.log(`  ${call}`);
    panel.handleInput("\x1b");
    console.log(`--- closed: ${closed} ---`);
    console.log("--- render at width 24 (truncation) ---");
    for (const line of panel.render(24)) console.log(`|${line}|`);
    break;
  }

  case "session-start": {
    // Emit `session_start` with the given reason and report what the extension
    // decided afterwards: this is the `/reload` path.
    const reason = rest[0] ?? "reload";
    await emit("session_start", { type: "session_start", reason });
    console.log(`reason=${reason} commands=${[...commands.keys()].join(",")}`);
    break;
  }

  case "run": {
    // Invoke any registered command by name, so `/Comodels`'s own refusal path
    // is exercised rather than the harness's.
    // `PI_VERIFY_REASON=reload` emits `session_start` first *in this process*,
    // which is what `/reload` does: a fresh process would only re-test load time.
    const reason = process.env.PI_VERIFY_REASON;
    if (reason) await emit("session_start", { type: "session_start", reason });
    const name = rest[0];
    const selected = name ? commands.get(name) : undefined;
    if (!selected) throw new Error(`command not registered: ${name ?? "(none)"}`);
    await selected.handler(rest.slice(1).join(" "), ctx);
    console.log(printed.join("\n"));
    break;
  }

  case "commands": {
    // `commands --continue` runs the session activation first, so the feature
    // commands a loaded session registers can be listed in the same process.
    if (rest.includes("--continue")) {
      const cont = commands.get("Coworkflow:start");
      if (!cont) throw new Error("Coworkflow:start is not registered");
      await cont.handler("", ctx);
    }
    console.log([...commands.keys()].join(", "));
    break;
  }

  case "subagent-call": {
    // Drives the real `tool_call` handlers with a subagent call, so the
    // capacity gate is exercised rather than described. `;;` separates several
    // calls in one process, which is what the same-turn reservation covers.
    const calls = rest.join(" ").split(";;").filter(Boolean);
    let index = 0;
    for (const raw of calls) {
      // `!<shell>` can change the temporary project settings between calls.
      if (raw.startsWith("!")) {
        execSync(raw.slice(1), { cwd: projectDir, stdio: "inherit" });
        continue;
      }
      index += 1;
      const input = JSON.parse(raw) as Record<string, unknown>;
      const toolCallId = `call-cap-${index}`;
      const results = await emit("tool_call", {
        type: "tool_call",
        toolName: "subagent",
        toolCallId,
        input,
      });
      const verdicts = results.filter((result) => result !== undefined);
      if (verdicts.length === 0) {
        console.log(`${toolCallId}: allowed`);
        // Without a result event the call stays reserved, exactly as it does
        // while a real dispatch is in flight.
        if (process.env.PI_VERIFY_RELEASE === "yes") {
          await emit("tool_result", {
            type: "tool_result",
            toolName: "subagent",
            toolCallId,
            input,
            content: [{ type: "text", text: "ok" }],
            details: {},
            isError: true, // This harness launched nothing; an explicit failure frees the slot.
          });
        }
        continue;
      }
    for (const verdict of verdicts) {
        const record = verdict as { block?: boolean; reason?: string };
        console.log(
          record.block === true ? `${toolCallId}: BLOCKED: ${record.reason}` : `${toolCallId}: ${JSON.stringify(verdict)}`,
        );
      }
    }
    // A gate that refuses must not have talked to the model: the layer reports to
    // the transcript, never as a user-role turn.
    console.log(`user-role messages: ${userMessages.length} (expected 0)`);
    break;
  }

  case "config": {
    const path = join(projectDir, ".pi", "Coworkflow.json");    try {
      console.log(readFileSync(path, "utf-8").trim());
    } catch {
      console.log(`(no config at ${path})`);
    }
    break;
  }

  default:
    console.error(
      `unknown command: ${command}; have ${[...commands.keys()].join(", ")}, child-inject, lane-record, settings, panel`,
    );
    process.exit(2);
}
