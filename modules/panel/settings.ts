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
import { Container, Input, Key, Spacer, Text, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PiRuntimeHost, RuntimeContext, WorkflowControl } from "../../core/module.ts";
import { refreshUsage } from "../../core/usage.ts";
import { existingSubagentsBridge } from "../../core/subagents-client.ts";
import { FALLBACK_KEYS, type PanelKeybindings, type PanelTheme } from "./shared.ts";

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
 * The project settings panel.
 *
 * Rows come from the control surface, so the panel shows the same state the slash
 * commands report and writes through the same code path.
 *
 * Laid out and driven like `/Comodels`: a tab bar, a table with a rule under the
 * header, ←→ to move between the live columns, ↑↓ to move within a column, Enter to
 * apply, Esc to close, typing to filter.
 *
 * One tab per concern rather than one long list with headings. A heading inside a
 * table duplicates the tab it sits under, mixes read-only prose with editable rows,
 * and — because the narrow label column cannot hold a sentence — truncates exactly
 * the part that explains what went wrong.
 */
export class SettingsPanel extends Container {
  private readonly io: SettingsPanelIo;
  private readonly theme: PanelTheme;
  private readonly tui: { requestRender?(): void };
  private readonly keybindings: PanelKeybindings | undefined;
  private all: SettingRow[] = [];
  private rows: SettingRow[] = [];
  private tab: string = "";
  private focus: SettingsFocus = "item";
  private cursor = 0;
  private query = "";
  /** One row action at a time; see `run()` for why a second gesture is dropped. */
  private inflight = false;
  private status = "";
  private width: number | undefined;
  private readonly body = new Container();
  private readonly statusText = new Text("", 0, 0);
  private readonly searchInput = new Input();

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
    this.addChild(new Text(theme.fg("accent", theme.bold ? theme.bold("Coworkflow 设置") : "Coworkflow 设置"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(this.statusText);
    this.addChild(
      new Text(
        theme.fg("muted", "↑↓ 移动 · ←→ 切换列 · Tab/⇧Tab 换页 · Enter 修改 · Space 开关 · Esc 关闭 · 直接输入可筛选"),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(border());

    this.searchInput.focused = true;
    this.searchInput.onSubmit = () => this.applyRow();
    this.adopt(io.rows());
  }

  /** Rows currently shown in the active tab, for tests. */
  currentRows(): SettingRow[] {
    return this.rows;
  }

  /** The row the cursor is on, for tests: a key gesture has to land on a row. */
  selectedRow(): SettingRow | undefined {
    return this.rows[this.cursor];
  }

  /** Which tab and column currently own the cursor, for tests. */
  viewState(): { tab: string; focus: SettingsFocus; tabs: string[] } {
    return { tab: this.tab, focus: this.focus, tabs: this.tabNames() };
  }

  /** Tab / Shift-Tab: cycle pages. Shift-Tab also arrives as ESC [ Z on some terminals. */
  private shiftTab(data: string): boolean {
    if (matchesKey(data, "shift+tab")) return true;
    return data === "\x1b[Z";
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

  /** Tabs in a fixed order, so a keystroke count never changes what a tab means. */
  private tabNames(): string[] {
    const order = ["模块", "会话", "子 agent", "维护", "状态"];
    const present = new Set(this.all.map((row) => row.section ?? ""));
    return order.filter((name) => present.has(name));
  }

  private adopt(rows: SettingRow[]): void {
    this.all = rows;
    const names = this.tabNames();
    if (!names.includes(this.tab)) this.tab = names[0] ?? "";
    this.rebuild();
  }

  private source(): SettingRow[] {
    return this.all.filter((row) => (row.section ?? "") === this.tab);
  }

  /** Apply the filter and keep the cursor on a selectable row. */
  private rebuild(): void {
    const source = this.source();
    const editable = source.filter((row) => !row.readOnly);
    if (this.query.trim() !== "" && editable.length > 0) {
      const hits = new Set(
        fuzzyFilter(editable, this.query.trim(), (row) => `${row.label} ${row.value} ${row.detail ?? ""}`).map(
          (row) => row,
        ),
      );
      this.rows = source.filter((row) => row.readOnly || hits.has(row));
    } else {
      this.rows = source;
    }
    const selectable = this.selectable();
    if (!selectable.includes(this.cursor)) this.cursor = selectable[0] ?? 0;
    this.updateBody();
  }

  private selectable(): number[] {
    // A prose row is a sentence, not a setting: the cursor skips it rather than
    // stopping on something Enter cannot do anything with.
    return this.rows.map((row, index) => (row.prose ? -1 : index)).filter((index) => index >= 0);
  }

  // ── table geometry, the same discipline as the model panel ──────────

  /** A cell padded/truncated to an exact display width, before it is coloured. */
  private cell(text: string, width: number): string {
    return truncateToWidth(text, width, "…", true);
  }

  private paint(text: string, color: string | null): string {
    return color ? this.theme.fg(color, text) : text;
  }

  private columnWidths(width: number): { item: number; value: number; detail: number } {
    const SEP = 3; // " │ "
    const total = Math.max(60, width - 2 - SEP * 2);
    const value = Math.min(24, Math.max(12, Math.floor(total * 0.2)));
    const item = Math.min(30, Math.max(16, Math.floor(total * 0.26)));
    return { item, value, detail: Math.max(10, total - item - value) };
  }

  private tableRule(widths: { item: number; value: number; detail: number }): Text {
    const bar = (w: number) => "─".repeat(w);
    return new Text(this.theme.fg("dim", `  ${bar(widths.item)}─┼─${bar(widths.value)}─┼─${bar(widths.detail)}`), 0, 0);
  }

  private tabBar(): Text {
    const theme = this.theme;
    const names = this.tabNames();
    const line = names
      .map((name) => {
        if (name === this.tab) {
          const text = `[${name}]`;
          return theme.fg("accent", theme.bold ? theme.bold(text) : text);
        }
        return theme.fg("muted", ` ${name} `);
      })
      .join(" ");
    return new Text(line, 0, 0);
  }

  private updateBody(): void {
    const theme = this.theme;
    const width = this.width ?? 100;
    const widths = this.columnWidths(width);
    const sep = theme.fg("dim", " │ ");
    const onStatus = this.tab === "状态";
    this.body.clear();
    this.body.addChild(this.tabBar());

    // The 状态 tab reports facts, not settings: its values are sentences, so it gets
    // 项 │ 值 and lets the value column take the width the 说明 column would have had.
    const valueWidth = onStatus ? widths.value + widths.detail + 3 : widths.value;
    const itemHeader = this.paint(this.cell("设置项", widths.item), this.focus === "item" ? "accent" : "muted");
    const valueHeader = this.paint(this.cell(onStatus ? "值" : "当前值", valueWidth), this.focus === "value" ? "accent" : "muted");
    const header = onStatus
      ? `  ${itemHeader}${sep}${valueHeader}`
      : `  ${itemHeader}${sep}${valueHeader}${sep}${this.paint(this.cell("说明", widths.detail), "muted")}`;
    this.body.addChild(new Text(header, 0, 0));
    this.body.addChild(
      onStatus
        ? new Text(theme.fg("dim", `  ${"─".repeat(widths.item)}─┼─${"─".repeat(valueWidth)}`), 0, 0)
        : this.tableRule(widths),
    );

    if (this.rows.length === 0) {
      this.body.addChild(
        new Text(theme.fg("muted", this.query ? `  （没有匹配 “${this.query}” 的设置项）` : "  （本节没有内容）"), 0, 0),
      );
    }
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i]!;
      if (row.prose) {
        // Full width, wrapped by the terminal rather than truncated: the reason a kind
        // failed to register is the whole point of the line.
        this.body.addChild(new Text(theme.fg("muted", `  ${row.value || row.label}`), 0, 0));
        continue;
      }
      const selected = i === this.cursor;
      const pointer = selected ? theme.fg("accent", "→ ") : "  ";
      const labelCell = this.paint(
        this.cell(row.label, widths.item),
        selected && this.focus === "item" ? "accent" : selected ? "text" : null,
      );
      const valueCell = this.paint(
        this.cell(row.value, valueWidth),
        row.readOnly ? "muted" : selected && this.focus === "value" ? "accent" : "success",
      );
      if (onStatus) {
        this.body.addChild(new Text(`${pointer}${labelCell}${sep}${valueCell}`, 0, 0));
      } else {
        const detail = this.cell(row.detail ?? "", widths.detail);
        this.body.addChild(new Text(`${pointer}${labelCell}${sep}${valueCell}${sep}${this.paint(detail, "dim")}`, 0, 0));
      }
    }
    this.statusText.setText(this.status ? theme.fg("success", this.status) : "");
  }

  render(width: number): string[] {
    this.width = width;
    this.updateBody();
    return super.render(width);
  }

  private move(delta: number): void {
    const selectable = this.selectable();
    if (selectable.length === 0) return;
    const position = selectable.indexOf(this.cursor);
    this.cursor = selectable[(position + delta + selectable.length) % selectable.length]!;
    this.updateBody();
    this.tui?.requestRender?.();
  }

  private cycleTab(delta: number): void {
    const names = this.tabNames();
    if (names.length === 0) return;
    const position = Math.max(0, names.indexOf(this.tab));
    this.tab = names[(position + delta + names.length) % names.length]!;
    this.query = "";
    this.searchInput.setValue("");
    this.cursor = 0;
    this.rebuild();
    this.refresh();
  }

  private refresh(): void {
    this.updateBody();
    this.tui?.requestRender?.();
  }

  /** Enter: do what this row's label says, whatever column the cursor is in. */
  private applyRow(): void {
    const row = this.rows[this.cursor];
    if (!row || row.readOnly || row.prose) return;
    const action = row.act ?? row.toggle;
    if (action) this.run(action);
  }

  handleInput(data: string): void {
    if (this.matches(data, "cancel")) {
      this.io.close();
      return;
    }
    if (this.shiftTab(data)) return this.cycleTab(-1);
    if (matchesKey(data, Key.tab)) return this.cycleTab(1);
    // ←→ switch which column owns the cursor: 设置项 / 当前值. Matched before the
    // search field sees them, because `Input` treats cursorLeft/Right as its own.
    if (matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
      this.focus = this.focus === "item" ? "value" : "item";
      this.searchInput.focused = this.focus === "item";
      this.refresh();
      return;
    }
    if (this.matches(data, "up")) return this.move(-1);
    if (this.matches(data, "down")) return this.move(1);
    if (this.matches(data, "confirm")) {
      this.applyRow();
      return;
    }
    const row = this.rows[this.cursor];
    if (row && !row.readOnly && row.toggle && matchesKey(data, Key.space)) {
      return this.run(row.toggle);
    }
    // Typing filters, on the same column the model panel filters from.
    if (this.tab === "状态" || this.focus !== "item") return;
    this.searchInput.handleInput(data);
    this.query = this.searchInput.getValue();
    this.rebuild();
    this.refresh();
  }

  /**
   * Run one row action and hand its outcome back to the owner.
   *
   * The row actions write the project config and reconcile the live session, so
   * a failure must surface as the panel's status line — not as a rejected promise
   * or as a row that looks applied but is not.
   *
   * One action at a time. A row gesture is built from the snapshot that rendered
   * the row, so two gestures delivered inside one tick both started from the same
   * stale value and the second silently overwrote the first. A policy editor that
   * appears to work while doing less is the exact failure this module exists to
   * remove, so an action arriving while another is in flight is dropped rather than
   * queued: the row is re-read after every action, so the queued gesture would apply
   * to a value the user never saw.
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
    this.status = status;
    this.adopt(this.io.rows());
    this.refresh();
  }
}

type SettingsFocus = "item" | "value";

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
    act: () => editPrefix(control, commandCtx),
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
    act: () => editProjectLimit(control, commandCtx, limit),
  });

  const kinds = control.agentKinds();
  const status = control.agentKindStatus();
  // The layer's own switch, read from the same place the 模块 tab reads it: the row
  // must not infer "is the gate running" from the absence of report lines, because
  // with the module off at load the report is empty.
  const layerOn = switches["agent-kinds"] !== false;
  for (const entry of kinds) {
    const registered = status.some((line) => line.includes(entry.agent) && line.includes("已注册"));
    const failed = status.some((line) => line.includes(`${entry.kind} 注册失败`));
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
            ? "已注册到 pi-subagents"
            : failed
              ? "注册失败（原因见 状态 tab）"
              : "已启用；注册状态见 状态 tab",
      toggle: () => control.setAgentKind(entry.kind, { enabled: !entry.enabled }),
      act: () => editKindLimit(control, commandCtx, entry.kind, entry.maxConcurrent),
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
/** Ask for a number; empty clears it. Used for the project concurrency limit. */
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
      "Coworkflow 设置面板：模块开关、会话、子 agent 类型与并发上限、维护；分页显示，未初始化时可从这里初始化本项目",
    handler: async (_args: string, commandCtx: any) => {
      const runtime = registration.runtime;
      runtime.refresh();
      const epoch = runtime.sessionEpoch;
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

const settingsPanelRegistered = new WeakMap<object, { runtime: RuntimeContext }>();
