/**
 * `/Coworkflow:settings` — the project's Coworkflow configuration as a panel.
 *
 * Rows come from the control surface (`WorkflowControl`), so the panel shows
 * exactly the state the slash commands report and writes through the same code
 * path: flipping a module switch here does what `--enable` / `--disable` does,
 * including taking back the artifacts of a module that was just turned off.
 *
 * The panel is always available — it is how a project gets configured — and in an
 * uninitialized project it offers to run the init instead of showing rows for a
 * config that does not exist yet.
 */

import type { PiRuntimeHost, RuntimeContext, WorkflowControl } from "../../core/module.ts";
import { refreshUsage } from "../../core/usage.ts";
import { existingSubagentsBridge } from "../../core/subagents-client.ts";
import type { PanelKeybindings, PanelTheme } from "./shared.ts";

/**
 * A settings row: a label, its current value, and what Enter does.
 *
 * `toggle` adds the one gesture a switch needs (Space, without leaving the row).
 * There is deliberately no ←→ stepping: in this panel ←→ moves the cursor between
 * the 设置项 and 当前值 columns, exactly as it does in `/Comodels`, so a value that
 * needs editing opens its own editor on Enter.
 */
export interface SettingRow {
  label: string;
  value: string;
  detail?: string;
  /**
   * Which tab this row belongs to. The tab name *is* the grouping, so there are no
   * header rows inside a table — a header that duplicates the tab it sits under was
   * one of the reasons the first table read as a wall of headings.
   */
  section?: string;
  /** A sentence rather than a value: rendered full width, never truncated into a cell. */
  prose?: boolean;
  /** Read-only rows are shown but do nothing on Enter. */
  readOnly?: boolean;
  act?: () => string | Promise<string>;
  /** Space: flip a boolean without leaving the row. */
  toggle?: () => string | Promise<string>;
  /**
   * Enter edits the value **inside the panel**.
   *
   * Asking the host for a dialog (`ui.input`) while this component is open nests one
   * dialog inside another; on this host the panel did not come back afterwards and the
   * command then appeared to do nothing at all. Editing in place keeps the panel the only
   * dialog, and validation lives in `commit`, so a bad answer is a status line rather than
   * a closed panel.
   */
  editor?: {
    /** What the edit line starts with, e.g. the current value. */
    current: string;
    /** Shown next to the editor, so the accepted range is visible while typing. */
    placeholder: string;
    /** Commit one answer; returns the status line. */
    commit(value: string): string | Promise<string>;
  };
}

/**
 * Register `/Coworkflow:settings`. Always available: it is how a project gets
 * configured, and it offers to initialize a project that has not been adopted
 * yet.
 */
/** A positive integer answer, or the reason it is not one. Every numeric row shares it. */
function positiveInt(
  raw: string,
  what: string,
  bound: { min: number; max?: number },
  commit: (value: number | null) => string | Promise<string>,
): string | Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return commit(null);
  const parsed = Number(trimmed);
  const range = bound.max === undefined ? `≥ ${bound.min}` : `${bound.min}–${bound.max}`;
  if (!Number.isInteger(parsed) || parsed < bound.min || (bound.max !== undefined && parsed > bound.max)) {
    return `${what}需要 ${range} 的整数（留空 = 默认）：${trimmed}`;
  }
  return commit(parsed);
}

/**
 * Register `/Coworkflow:settings`. Always available: it is how a project gets
 * configured, and it offers to initialize a project that has not been adopted
 * yet.
 */
/**
 * The settings rows, built from the control surface so the panel and the slash
 * commands always agree about what is on.
 */
export function buildSettingRows(control: WorkflowControl, commandCtx: any): SettingRow[] {
  const rows: SettingRow[] = [];
  const switches = control.switches();
  const initialized = control.initialized();

  // ── 模块 ────────────────────────────────────────────────────────────────
  // One line of "what this layer actually does", because a column of bare `on`s
  // told a reader nothing about which switch to reach for.
  const about: Record<string, string> = {
    trellis: "Trellis 本体与项目记录（已有项目只报告，不重写）",
    worktree: "任务隔离机制：after_start 钩子建 <前缀><任务> worktree",
    agents: "AGENTS.md 受管区（主会话）+ 子 agent 工作约定",
    subagents: "复用已装的 pi-subagents，缺失时才项目级安装",
    "subagent-context": "子会话按角色注入 Trellis 上下文（唯一注入路径）",
    "agent-kinds": "把下面选中的 kind 注册成真 agent，并拦截关闭/超限的派单",
    "lane-worktree": "lane 账目、/Coworkflow:lanes 与任务出口检查",
    capacity: "本项目并发上限的第二道门（比 kind 上限更粗）",
    panel: "本面板与 /Comodels（控制面，工作流关闭时也在）",
  };
  for (const id of control.moduleIds()) {
    const on = switches[id] === true;
    rows.push({
      section: "模块",
      label: id,
      value: on ? "on" : "off",
      detail: on ? (about[id] ?? "") : `已关闭：${about[id] ?? "该层不生效"}`,
      act: () => control.setSwitch(id, !on),
    });
  }

  // ── 会话 ────────────────────────────────────────────────────────────────
  const auto = control.autoEnable();
  rows.push({
    section: "会话",
    label: "新会话自动加载",
    value: auto ? "on" : "off",
    detail: auto ? "新会话直接加载 Coworkflow" : "新会话需 /Coworkflow:start",
    act: () => control.setAutoEnable(!auto),
  });
  rows.push({
    section: "会话",
    label: "worktree 前缀",
    value: control.prefix(),
    detail: "任务 worktree 的目录名（../<前缀><任务>）",
    editor: {
      current: control.prefix(),
      placeholder: "任务 worktree 的目录名前缀",
      commit: (value) => control.setPrefix(value.trim()),
    },
  });

  // ── 子 agent ────────────────────────────────────────────────────────────
  // The project ceiling and the per-kind ceilings are one decision seen at two
  // grains, so they share a tab instead of living three sections apart.
  const limit = control.subagentConcurrency();
  rows.push({
    section: "子 agent",
    label: "本项目并发上限",
    value: limit === null ? "不限" : String(limit),
    detail: "同一会话同时活跃的顶层 async run；留空 = 不限（由 Coworkflow 拦截）",
    editor: {
      current: limit === null ? "" : String(limit),
      placeholder: "≥ 1 的整数；留空 = 不限",
      commit: (value) =>
        positiveInt(value, "本项目并发上限", { min: 1 }, (parsed) => control.setSubagentConcurrency(parsed)),
    },
  });

  const budget = control.runBudgetMinutes();
  rows.push({
    section: "子 agent",
    label: "子 agent 运行上限",
    value: budget === null ? "25 分钟（默认）" : `${budget} 分钟`,
    detail: "一次派单的墙上时间上限；接近上限前会要求子 agent 停下交接（留空 = 默认）",
    editor: {
      current: budget === null ? "" : String(budget),
      placeholder: "1–240 分钟；留空 = 内置默认",
      commit: (value) =>
        positiveInt(value, "子 agent 运行上限", { min: 1, max: 240 }, (parsed) =>
          control.setRunBudgetMinutes(parsed),
        ),
    },
  });

  const kinds = control.agentKinds();
  const status = control.agentKindStatus();
  // The layer's own switch, read from the same place the 模块 tab reads it: the row
  // must not infer "is the gate running" from the absence of report lines, because
  // with the module off at load the report is empty.
  const layerOn = switches["agent-kinds"] !== false;
  for (const entry of kinds) {
    const registered = status.some((line) => line.includes(entry.agent) && line.includes("已注册"));
    const failed = status.some((line) => line.includes(`${entry.kind} 无法使用`));
    const layerOff =
      !layerOn || status.some((line) => line.includes("未激活 agent-kinds") || line.includes("本会话未加载或已关闭"));
    rows.push({
      section: "子 agent",
      label: `${entry.label} ${entry.agent}`,
      value: `${entry.enabled ? "[x] 开" : "[ ] 关"} · 上限 ${entry.maxConcurrent}`,
      detail: !entry.enabled
        ? "关闭时该 kind 的派单会被拒绝，其他 agent 不受影响"
        : layerOff
          ? layerOn
            // On in the project but not loaded in this session: pointing at the module
            // switch would send the user to a switch that is already on.
            ? "本项目已开启 agent-kinds，本会话还没加载：kind 不注册、不拦截（用 /Coworkflow:start）"
            : "agent-kinds 本层未启用：kind 不注册、不拦截（在 模块 tab 打开）"
          : registered
            ? `已注册到 pi-subagents${entry.source === "file" ? " · 来自项目定义文件" : ""}`
            : failed
              ? "无法使用（原因见 状态 tab）"
              : "已启用；注册状态见 状态 tab",
      toggle: () => control.setAgentKind(entry.kind, { enabled: !entry.enabled }),
      editor: {
        current: String(entry.maxConcurrent),
        placeholder: "≥ 1 的整数；留空 = 内置默认",
        commit: (value) =>
          positiveInt(value, `kind ${entry.kind} 的并发上限`, { min: 1 }, (parsed) =>
            control.setAgentKind(entry.kind, { maxConcurrent: parsed }),
          ),
      },
    });
  }
  if (kinds.length === 0) {
    rows.push({ section: "子 agent", label: "（本构建没有内置 kind）", value: "", readOnly: true });
  }

  // ── 维护 ────────────────────────────────────────────────────────────────
  rows.push({
    section: "维护",
    label: "重新初始化",
    value: "运行",
    detail: "/Coworkflow:init：刷新受管区与钩子，不重写 Trellis 记录",
    act: () => control.init(""),
  });
  rows.push({
    section: "维护",
    label: "Trellis 范式对齐",
    value: "trellis update -s",
    detail: "升级未被本地改动的 Trellis 文件，保留本地改动与所有任务记录",
    act: () => control.init("--trellis-update"),
  });

  // ── 状态 ────────────────────────────────────────────────────────────────
  const trusted = commandCtx?.isProjectTrusted?.();
  if (trusted !== undefined) {
    rows.push({
      section: "状态",
      label: "项目信任",
      value: trusted ? "已受信任" : "未受信任",
      detail: trusted ? "" : ".pi/ 下的扩展与 agent 不会被加载：角色派单会失败",
      readOnly: true,
    });
  }
  for (const fact of control.facts()) {
    const [label, ...rest] = fact.split(": ");
    rows.push({
      section: "状态",
      label: label ?? fact,
      value: rest.join(": ") || "",
      readOnly: true,
      ...(initialized ? {} : { detail: "本项目未初始化：先 /Coworkflow:init" }),
    });
  }
  // The modules' own lines come last, verbatim, as prose. A kind that did not
  // register must never be shown as available, and the reason is a sentence — putting
  // it in a narrow cell truncated exactly the part that explains the failure.
  for (const line of status) {
    rows.push({ section: "状态", label: "", value: line.trim(), readOnly: true, prose: true });
  }
  return rows;
}

/**
 * Register `/Coworkflow:settings`. Always available: it is how a project gets
 * configured, and it offers to initialize a project that has not been adopted
 * yet.
 */
export function registerSettingsPanel(
  host: PiRuntimeHost,
  runtime: RuntimeContext,
  /**
   * The runtime this session is running *now*.
   *
   * The value passed alongside is the one from registration, which a reload replaces; the
   * panel must drive the live session or it configures one that no longer exists. Optional
   * so a host that cannot answer still gets the registration-time runtime.
   */
  live?: () => RuntimeContext,
): void {
  const registered = settingsPanelRegistered.get(host);
  if (registered) { registered.runtime = runtime; registered.live = live; return; }
  const registration = { runtime, live };
  settingsPanelRegistered.set(host, registration);
  host.registerCommand?.(`Coworkflow:settings`, {
    description:
      "Coworkflow 设置面板：模块开关、会话、子 agent 类型与并发上限、维护；分页显示，未初始化时可从这里初始化本项目",
    handler: async (_args: string, commandCtx: any) => {
      // The runtime this session is actually running, not the one captured when the
      // command was registered: after a reload those differ, and driving the stale one
      // reads and writes a session that no longer exists.
      const liveRuntime = registration.live?.() ?? registration.runtime;
      const runtime = liveRuntime;
      runtime.refresh();
      // One refresh at panel-open, bounded. Each public RPC has a 10 s timeout, so
      // awaiting them unbounded made the command take ~20 s to open in a session
      // whose event bus exists but whose owner never answers — for facts that are
      // supplementary to the settings it was opened for. Rendering itself stays
      // cache-only; what is not back in time is labelled as not yet refreshed
      // rather than shown as if it were current.
      const openBudgetMs = 1500;
      let staleNote: string | null = null;
      const pending: Promise<unknown>[] = [refreshUsage(host, runtime, commandCtx)];
      if (runtime.enabled) {
        // The facts block shows a bounded per-run summary, and the fleet window is
        // the only public source of per-run tokens.
        const bridge = existingSubagentsBridge(host);
        pending.push(bridge?.observe() ?? Promise.resolve(), bridge?.fleet() ?? Promise.resolve());
      }
      // The kind section reports whether each kind is really in the owner's agent
      // list, and that answer arrives from a pass that awaits an import.
      pending.push(runtime.control.settleAgentKinds());
      const settledInTime = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), openBudgetMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (!settledInTime) {
        // The reads keep running and land in the cache the panel renders from on the
        // next open; saying so is the difference between stale and wrong.
        staleNote = "公开状态与用量尚未刷新完成（上游未在 1.5 秒内回复），下面的数字可能不是最新的";
      } else {
        staleNote = null;
      }
      const control = runtime.control;
      const say = (text: string): void => {
        try {
          host.sendMessage?.({ customType: "pi-Coworkflow", content: text, display: true });
        } catch {
          // Fall through to the terminal report.
        }
        if (commandCtx?.mode !== "tui") {
          try {
            console.error(text);
          } catch {
            // stderr unavailable.
          }
        }
      };

      if (registration.live !== undefined && registration.live() !== runtime) {
        // Not silent: a command that appears to do nothing is the one failure a user
        // cannot diagnose, and this is a real state — the layer was reloaded underneath.
        say("本会话的 Coworkflow 运行时已被替换（例如 /reload）：请再运行一次本命令。");
        return;
      }
      if (commandCtx?.mode !== "tui" || typeof commandCtx?.ui?.custom !== "function") {
        say(
          control.initialized()
            ? `Coworkflow 设置面板需要交互式 TUI 会话。\n${control.facts().join("\n")}`
            : "本项目未初始化：先运行 /Coworkflow:init",
        );
        return;
      }

      if (!control.initialized()) {
        const go = await commandCtx.ui.confirm?.(
          "初始化本项目？",
          `将在 ${commandCtx.cwd ?? runtime.cwd} 安装 Coworkflow：Trellis + 任务 worktree 钩子 + AGENTS.md 约束 + subagent 层`,
        );
        if (!go) return;
        say(control.init(""));
        return;
      }

      // Loaded here, not at the top of the file: the renderer is optional, the command
      // is not. A host without these exports gets a refused panel, not a dead extension.
      type SettingsCtor = new (...args: any[]) => { reload(status: string): void };
      const loaded = await import("./settings-panel.ts").catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      const Ctor = loaded instanceof Error ? undefined : (loaded.SettingsPanel as SettingsCtor | undefined);
      if (typeof Ctor !== "function") {
        say(`面板不可用：${loaded instanceof Error ? loaded.message : "导出里没有 SettingsPanel"}`);
        return;
      }
      await commandCtx.ui.custom(
        (tui: any, theme: PanelTheme, keybindings: PanelKeybindings, done: (value: unknown) => void) => {
          const panel = new Ctor(
            {
              rows: () => [
                // Said once, at the top, so a number further down is never read as
                // fresher than it is.
                ...(staleNote === null ? [] : [{ label: `! ${staleNote}`, value: "", readOnly: true }]),
                ...buildSettingRows(control, commandCtx),
              ],
              close: () => done(undefined),
              changed: (status: string) => panel.reload(status),
            },
            theme,
            tui,
            keybindings,
          );
          return panel;
        },
      );
    },
  });
}

const settingsPanelRegistered = new WeakMap<
  object,
  { runtime: RuntimeContext; live?: (() => RuntimeContext) | undefined }
>();
