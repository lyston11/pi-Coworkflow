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

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, Spacer, Text, matchesKey } from "@earendil-works/pi-tui";
import type { PiRuntimeHost, RuntimeContext, WorkflowControl } from "../../core/module.ts";
import { refreshUsage } from "../../core/usage.ts";
import { existingSubagentsBridge } from "../../core/subagents-client.ts";
import { FALLBACK_KEYS, type PanelKeybindings, type PanelTheme } from "./shared.ts";

/**
 * A settings row: a label, its current value, and what Enter does.
 *
 * `toggle` and `adjust` are the two extra gestures a value that is more than a
 * switch needs (a kind is on/off *and* has a limit): Space toggles, ←→ steps the
 * number, Enter does what the row's own label says it does. Rows that declare
 * neither keep exactly the old behaviour — Enter only.
 */
export interface SettingRow {
  label: string;
  value: string;
  detail?: string;
  /** Section header rows are not selectable. */
  header?: boolean;
  /** Read-only rows are shown but do nothing on Enter. */
  readOnly?: boolean;
  act?: () => string | Promise<string>;
  /** Space: flip a boolean without leaving the row. */
  toggle?: () => string | Promise<string>;
  /** ←→: step a bounded number by `delta`. */
  adjust?: (delta: number) => string | Promise<string>;
}

/**
 * What the settings panel needs from its owner: the current rows, how to close,
 * and what to do after an action changed the project.
 */
export interface SettingsPanelIo {
  rows(): SettingRow[];
  close(): void;
  /** Rebuild the rows and show `status` as the result of the last action. */
  changed(status: string): void;
}

/**
 * The project settings panel. Rows come from the control surface, so the panel
 * shows the same state the slash commands report and writes through the same
 * code path.
 */
export class SettingsPanel extends Container {
  private readonly io: SettingsPanelIo;
  private readonly theme: PanelTheme;
  private readonly tui: { requestRender?(): void };
  private readonly keybindings: PanelKeybindings | undefined;
  private rows: SettingRow[] = [];
  private cursor = 0;
  /** One row action at a time; see `run()` for why a second gesture is dropped. */
  private inflight = false;
  private status = "";
  private readonly listContainer = new Container();
  private readonly statusText = new Text("", 0, 0);

  constructor(
    io: SettingsPanelIo,
    theme: PanelTheme,
    tui: { requestRender?(): void },
    keybindings?: PanelKeybindings,
  ) {
    super();
    this.io = io;
    this.theme = theme;
    this.tui = tui;
    this.keybindings = keybindings;

    const border = () => new DynamicBorder((str: string) => theme.fg("border", str));
    this.addChild(border());
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("accent", theme.bold ? theme.bold("Coworkflow 设置") : "Coworkflow 设置"), 0, 0),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(this.statusText);
    this.addChild(new Text(theme.fg("muted", "↑↓ 移动 · Enter 修改 · Space 开关 · ←→ 调上限 · Esc 关闭"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(border());

    this.rows = io.rows();
    const first = this.rows.findIndex((row) => !row.header);
    this.cursor = first >= 0 ? first : 0;
    this.updateList();
  }

  /** Rows currently shown, for tests. */
  currentRows(): SettingRow[] {
    return this.rows;
  }

  /** The row the cursor is on, for tests: a key gesture has to land on a row. */
  selectedRow(): SettingRow | undefined {
    return this.rows[this.cursor];
  }

  private matches(data: string, action: "up" | "down" | "confirm" | "cancel"): boolean {
    const kb = this.keybindings;
    if (kb?.matches) return kb.matches(data, `tui.select.${action}`);
    const fallback: Record<string, RegExp> = {
      up: /^\x1b(?:\[|O)A$/,
      down: /^\x1b(?:\[|O)B$/,
      confirm: /^[\r\n]$/,
      cancel: /^\x1b$/,
    };
    return fallback[action]?.test(data) ?? false;
  }

  private updateList(): void {
    const theme = this.theme;
    this.listContainer.clear();
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i]!;
      if (row.header) {
        this.listContainer.addChild(new Text(theme.fg("accent", `── ${row.label} `), 0, 0));
        continue;
      }
      const selected = i === this.cursor;
      const cursor = selected ? theme.fg("accent", "→ ") : "  ";
      const label = selected ? theme.fg("accent", row.label) : row.label;
      const value = row.readOnly ? theme.fg("muted", row.value) : theme.fg("success", row.value);
      const detail = row.detail ? ` ${theme.fg("dim", row.detail)}` : "";
      this.listContainer.addChild(new Text(`${cursor}${label}  ${value}${detail}`, 0, 0));
    }
    this.statusText.setText(this.status ? theme.fg("success", this.status) : "");
  }

  private move(delta: number): void {
    const selectable = this.rows
      .map((row, index) => (row.header ? -1 : index))
      .filter((index) => index >= 0);
    if (selectable.length === 0) return;
    const position = selectable.indexOf(this.cursor);
    const next = selectable[(position + delta + selectable.length) % selectable.length]!;
    this.cursor = next;
    this.updateList();
    this.tui?.requestRender?.();
  }

  handleInput(data: string): void {
    if (this.matches(data, "cancel")) {
      this.io.close();
      return;
    }
    if (this.matches(data, "up")) return this.move(-1);
    if (this.matches(data, "down")) return this.move(1);
    const row = this.rows[this.cursor];
    if (row && !row.header && !row.readOnly) {
      // Matched the way the model panel matches its own column switch, because
      // these keys are per-row gestures rather than list navigation.
      if (row.toggle && matchesKey(data, Key.space)) return this.run(row.toggle);
      if (row.adjust && matchesKey(data, Key.left)) return this.run(() => row.adjust!(-1));
      if (row.adjust && matchesKey(data, Key.right)) return this.run(() => row.adjust!(1));
    }
    if (this.matches(data, "confirm")) {
      if (!row?.act || row.readOnly) return;
      this.run(row.act);
    }
  }

  /**
   * Run one row action and hand its outcome back to the owner.
   *
   * The row actions write the project config and reconcile the live session, so
   * a failure must surface as the panel's status line — not as a rejected promise
   * or as a row that looks applied but is not.
   *
   * One action at a time. A row gesture is built from the snapshot that rendered
   * the row, so two gestures delivered inside one tick — a held Space, two quick
   * Right presses — both started from the same stale value and the second silently
   * overwrote the first: Right,Right on a limit of 3 produced 4, and Space,Space on
   * a disabled kind left it enabled. A policy editor that appears to work while
   * doing less is the exact failure this module exists to remove, so an action
   * arriving while another is in flight is dropped rather than queued: the row is
   * re-read after every action, so the queued gesture would apply to a value the
   * user never saw.
   */
  private run(action: () => string | Promise<string>): void {
    if (this.inflight) return;
    this.inflight = true;
    void Promise.resolve()
      .then(action)
      .then(
        (status) => this.io.changed(status),
        (error: unknown) =>
          this.io.changed(`失败：${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        this.inflight = false;
      });
  }

  /** Re-read the rows from the owner, keeping the cursor on a selectable row. */
  reload(status: string): void {
    this.rows = this.io.rows();
    this.status = status;
    if (this.rows[this.cursor]?.header) {
      const next = this.rows.findIndex((row, index) => index > this.cursor && !row.header);
      const fallback = this.rows.findIndex((row) => !row.header);
      this.cursor = next >= 0 ? next : fallback >= 0 ? fallback : 0;
    }
    this.updateList();
    this.tui?.requestRender?.();
  }

}
/**
 * Register `/Coworkflow:settings`. Always available: it is how a project gets
 * configured, and it offers to initialize a project that has not been adopted
 * yet.
 */
/** Ask for a number; empty clears it. Used for the project concurrency limit. */
async function editProjectLimit(
  control: WorkflowControl,
  commandCtx: any,
  current: number | null,
): Promise<string> {
  const value = await commandCtx?.ui?.input?.(
    "本项目子 agent 并发上限（留空 = 不限）",
    current === null ? "" : String(current),
  );
  if (value === undefined) return "未修改";
  const trimmed = value.trim();
  if (!trimmed) return control.setSubagentConcurrency(null);
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return `并发上限需要 ≥ 1 的整数（留空 = 不限）：${trimmed}`;
  }
  return control.setSubagentConcurrency(parsed);
}

/** Ask for one kind's limit; an empty answer restores the built-in default. */
async function editKindLimit(
  control: WorkflowControl,
  commandCtx: any,
  kind: string,
  current: number,
): Promise<string> {
  const value = await commandCtx?.ui?.input?.(
    `kind ${kind} 的并发上限（≥ 1；留空 = 内置默认）`,
    String(current),
  );
  if (value === undefined) return "未修改";
  const trimmed = value.trim();
  if (!trimmed) return control.setAgentKind(kind, { maxConcurrent: null });
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return `并发上限需要 ≥ 1 的整数（留空 = 内置默认）：${trimmed}`;
  }
  return control.setAgentKind(kind, { maxConcurrent: parsed });
}

async function editPrefix(control: WorkflowControl, commandCtx: any): Promise<string> {
  const value = await commandCtx?.ui?.input?.("worktree 目录前缀", control.prefix());
  if (value === undefined) return "未修改";
  return control.setPrefix(value.trim());
}

/**
 * The settings rows, built from the control surface so the panel and the slash
 * commands always agree about what is on.
 */
export function buildSettingRows(control: WorkflowControl, commandCtx: any): SettingRow[] {
  const rows: SettingRow[] = [];
  const switches = control.switches();
  const initialized = control.initialized();

  rows.push({ label: "模块", value: "", header: true });
  for (const id of control.moduleIds()) {
    const on = switches[id] === true;
    rows.push({
      label: id,
      value: on ? "on" : "off",
      detail: on ? "" : "关闭时该层不生效",
      act: () => control.setSwitch(id, !on),
    });
  }

  rows.push({ label: "会话", value: "", header: true });
  const auto = control.autoEnable();
  rows.push({
    label: "新会话自动加载",
    value: auto ? "on" : "off",
    detail: auto ? "新会话直接加载 Coworkflow" : `新会话需 /Coworkflow:start`,
    act: () => control.setAutoEnable(!auto),
  });
  rows.push({
    label: "worktree 前缀",
    value: control.prefix(),
    detail: "任务 worktree 的目录名（../<前缀><任务>）",
    act: () => editPrefix(control, commandCtx),
  });

  // pi-subagents' capacity keys live in its own user-level config file with no
  // project override, so the project's number is Coworkflow's own setting and is
  // enforced by the `capacity` module.
  rows.push({ label: "子 agent 并发", value: "", header: true });
  const limit = control.subagentConcurrency();
  rows.push({
    label: "本项目并发上限",
    value: limit === null ? "不限" : String(limit),
    detail: "同一会话同时活跃的顶层 async run；留空 = 不限（本项目；由 Coworkflow 拦截）",
    act: () => editProjectLimit(control, commandCtx, limit),
  });

  // Per-kind policy. One row per kind, because the two facts a kind has — is it
  // usable at all, and how many of it may run — belong to the same decision and a
  // user changing one is usually looking at the other.
  rows.push({ label: "子 agent 类型", value: "", header: true });
  const kinds = control.agentKinds();
  const status = control.agentKindStatus();
  // The layer's own switch, read from the same place the module row above reads it.
  // The row must not have to infer "is the gate running" from the absence of report
  // lines: with the module off at load the report is empty, and the row then claimed
  // "enabled, see the status line below" with no line below and no gate at all.
  const layerOn = control.switches()["agent-kinds"] !== false;
  for (const entry of kinds) {
    // What this kind's availability actually is, from the module's own report —
    // never from the project's enablement, which says nothing about the agent list.
    const registered = status.some((line) => line.includes(entry.agent) && line.includes("已注册"));
    const failed = status.some((line) => line.includes(`${entry.kind} 注册失败`));
    const layerOff = !layerOn || status.some((line) => line.includes("未激活 agent-kinds") || line.includes("本会话未加载或已关闭"));
    rows.push({
      label: `${entry.label} ${entry.agent}`,
      value: `${entry.enabled ? "[x]" : "[ ]"} 开 · 上限 ${entry.maxConcurrent}`,
      detail: !entry.enabled
        ? "关闭时该 kind 的派单会被拒绝，其他 agent 不受影响"
        : layerOff
          ? layerOn
            // On in the project but not loaded in this session: the fix is `/Coworkflow:start`,
            // and pointing at the module switch would send the user to a switch that is already on.
            ? "agent-kinds 在本项目已开启，但本会话还没加载它：kind 不注册，也不拦截派单（用 /Coworkflow:start）"
            : "agent-kinds 本层未启用：kind 不注册，也不拦截派单（在上面的模块开关里打开）"
          : registered
            ? "已注册到 pi-subagents"
            : failed
              ? "注册失败（原因见下方状态行）"
              : "已启用；注册状态见下方状态行",
      toggle: () => control.setAgentKind(entry.kind, { enabled: !entry.enabled }),
      adjust: (delta) =>
        control.setAgentKind(entry.kind, { maxConcurrent: Math.max(1, entry.maxConcurrent + delta) }),
      act: () => editKindLimit(control, commandCtx, entry.kind, entry.maxConcurrent),
    });
  }
  if (kinds.length === 0) {
    rows.push({ label: "（本构建没有内置 kind）", value: "", readOnly: true });
  }
  // The module's own lines, verbatim: a kind that did not register must never be
  // shown as available, and the reason is the only actionable thing here. The
  // leading status glyph is kept in the label rather than rendered as a value,
  // because these are sentences, not settings.
  for (const line of status) {
    rows.push({ label: line.trim(), value: "", readOnly: true });
  }

  rows.push({ label: "维护", value: "", header: true });
  rows.push({
    label: "重新初始化",
    value: "运行",
    detail: "= /Coworkflow:init（刷新受管区与钩子，不重写 Trellis 记录）",
    act: () => control.init(""),
  });
  rows.push({
    label: "Trellis 范式对齐",
    value: "trellis update -s",
    detail: "升级未被本地改动的 Trellis 文件，保留本地改动与所有任务记录",
    act: () => control.init("--trellis-update"),
  });

  rows.push({ label: "状态", value: "", header: true });
  const trusted = commandCtx?.isProjectTrusted?.();
  if (trusted !== undefined) {
    rows.push({
      label: "项目信任",
      value: trusted ? "已受信任" : "未受信任",
      detail: trusted ? "" : ".pi/ 下的扩展与 agent 不会被加载：角色派单会失败",
      readOnly: true,
    });
  }
  for (const fact of control.facts()) {
    const [label, ...rest] = fact.split(": ");
    rows.push({
      label: label ?? fact,
      value: rest.join(": ") || "",
      readOnly: true,
      ...(initialized ? {} : { detail: "本项目未初始化：先 /Coworkflow:init" }),
    });
  }
  return rows;
}

/**
 * Register `/Coworkflow:settings`. Always available: it is how a project gets
 * configured, and it offers to initialize a project that has not been adopted
 * yet.
 */
export function registerSettingsPanel(host: PiRuntimeHost, runtime: RuntimeContext): void {
  const registered = settingsPanelRegistered.get(host);
  if (registered) { registered.runtime = runtime; return; }
  const registration = { runtime };
  settingsPanelRegistered.set(host, registration);
  host.registerCommand?.(`Coworkflow:settings`, {
    description:
      "Coworkflow 设置面板：模块开关、新会话是否自动加载、worktree 前缀、Trellis 范式对齐；未初始化时可从这里初始化本项目",
    handler: async (_args: string, commandCtx: any) => {
      const runtime = registration.runtime;
      runtime.refresh();
      const epoch = runtime.sessionEpoch;
      await refreshUsage(host, runtime, commandCtx);
      if (runtime.enabled) {
        // The facts block shows a bounded per-run summary, and the fleet window is
        // the only public source of per-run tokens. One read at panel-open, like
        // every other refresh boundary: rendering itself stays cache-only.
        const bridge = existingSubagentsBridge(host);
        await bridge?.observe();
        await bridge?.fleet();
      }
      // The kind section reports whether each kind is really in the owner's agent
      // list, and that answer arrives from a pass that awaits an import. Awaiting
      // it here is the difference between "registered" and "not loaded yet".
      await runtime.control.settleAgentKinds();
      if (epoch !== runtime.sessionEpoch || registration.runtime !== runtime) return;
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

      await commandCtx.ui.custom(
        (tui: any, theme: PanelTheme, keybindings: PanelKeybindings, done: (value: unknown) => void) => {
          const panel: SettingsPanel = new SettingsPanel(
            {
              rows: () => buildSettingRows(control, commandCtx),
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

const settingsPanelRegistered = new WeakMap<object, { runtime: RuntimeContext }>();
