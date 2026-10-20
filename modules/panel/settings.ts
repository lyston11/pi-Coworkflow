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
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { PiRuntimeHost, RuntimeContext, WorkflowControl } from "../../core/module.ts";
import { refreshUsage } from "../../core/usage.ts";
import { existingSubagentsBridge } from "../../core/subagents-client.ts";
import { FALLBACK_KEYS, type PanelKeybindings, type PanelTheme } from "./shared.ts";

/**
 * A settings row: a label, its current value, and what Enter does.
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
    this.addChild(new Text(theme.fg("muted", "↑↓ 移动 · Enter 修改 · Esc 关闭"), 0, 0));
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
    if (this.matches(data, "confirm")) {
      const row = this.rows[this.cursor];
      if (!row?.act || row.readOnly) return;
      void Promise.resolve(row.act()).then(
        (status) => this.io.changed(status),
        (error: unknown) =>
          this.io.changed(`失败：${error instanceof Error ? error.message : String(error)}`),
      );
    }
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
      if (runtime.enabled) await existingSubagentsBridge(host)?.observe();
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
