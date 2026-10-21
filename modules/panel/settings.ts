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
  /** Section header rows are not selectable. */
  header?: boolean;
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
 * Laid out and driven like `/Comodels`: a tab bar, a three-column table with a rule
 * under the header, ←→ to move between the two live columns, ↑↓ to move within a
 * column, Enter to apply, Esc to close, and typing to filter. Two tabs split what is
 * *writable* (the project's configuration) from what is only *reported* (the modules'
 * own status lines), because mixing read-only prose into an editable list made every
 * row look like something you could change.
 */
export class SettingsPanel extends Container {
  private readonly io: SettingsPanelIo;
  private readonly theme: PanelTheme;
  private readonly tui: { requestRender?(): void };
  private readonly keybindings: PanelKeybindings | undefined;
  private all: SettingRow[] = [];
  private rows: SettingRow[] = [];
  private tab: SettingsTab = "project";
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
        theme.fg("muted", "↑↓ 移动 · ←→ 切换 设置项/当前值 列 · Tab 切换 项目/状态 · Enter 修改 · Space 开关 · Esc 关闭 · 直接输入可筛选"),
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
  viewState(): { tab: SettingsTab; focus: SettingsFocus } {
    return { tab: this.tab, focus: this.focus };
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

  /**
   * Split the owner's rows into the two tabs and put the cursor on something real.
   *
   * The owner emits one list with section headers; the `状态` header marks where the
   * read-only report begins. Splitting there rather than by `readOnly` keeps the
   * intent in one place: everything after that header was never editable.
   */
  private adopt(rows: SettingRow[]): void {
    this.all = rows;
    const statusAt = rows.findIndex((row) => row.header === true && row.label.trim() === "状态");
    const project = statusAt < 0 ? rows : rows.slice(0, statusAt);
    const reported = statusAt < 0 ? [] : rows.slice(statusAt);
    this.projectRows = project;
    this.statusRows = reported;
    this.rebuild();
  }

  private projectRows: SettingRow[] = [];
  private statusRows: SettingRow[] = [];

  private source(): SettingRow[] {
    return this.tab === "project" ? this.projectRows : this.statusRows;
  }

  /** Apply the filter and keep the cursor on a selectable row. */
  private rebuild(): void {
    const source = this.source();
    if (this.tab === "project" && this.query.trim() !== "") {
      const hits = new Set(
        fuzzyFilter(source.filter((row) => !row.header).map((row, index) => ({ row, index })),
          this.query.trim(),
          (entry) => entry.row.label).map((entry) => entry.index),
      );
      this.rows = source.filter((row, index) => !row.header && hits.has(index));
    } else {
      this.rows = source;
    }
    const selectable = this.selectable();
    if (!selectable.includes(this.cursor)) this.cursor = selectable[0] ?? 0;
    this.updateBody();
  }

  private selectable(): number[] {
    return this.rows.map((row, index) => (row.header ? -1 : index)).filter((index) => index >= 0);
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
    const value = Math.min(26, Math.max(14, Math.floor(total * 0.22)));
    const item = Math.min(34, Math.max(18, Math.floor(total * 0.28)));
    return { item, value, detail: Math.max(10, total - item - value) };
  }

  private tableRule(widths: { item: number; value: number; detail: number }): Text {
    const bar = (w: number) => "─".repeat(w);
    return new Text(
      this.theme.fg("dim", `  ${bar(widths.item)}─┼─${bar(widths.value)}─┼─${bar(widths.detail)}`),
      0,
      0,
    );
  }

  private tabBar(): Text {
    const theme = this.theme;
    const cell = (label: string, id: SettingsTab) =>
      this.tab === id
        ? theme.fg("accent", theme.bold ? theme.bold(`[${label}]`) : `[${label}]`)
        : theme.fg("muted", ` ${label} `);
    return new Text(`${cell("项目", "project")}  ${cell("状态", "status")}`, 0, 0);
  }

  private updateBody(): void {
    const theme = this.theme;
    const width = this.width ?? 100;
    const widths = this.columnWidths(width);
    const sep = theme.fg("dim", " │ ");
    this.body.clear();
    this.body.addChild(this.tabBar());
    const itemHeader = this.paint(this.cell("设置项", widths.item), this.focus === "item" ? "accent" : "muted");
    const valueHeader = this.paint(this.cell("当前值", widths.value), this.focus === "value" ? "accent" : "muted");
    this.body.addChild(new Text(`  ${itemHeader}${sep}${valueHeader}${sep}${this.paint(this.cell("说明", widths.detail), "muted")}`, 0, 0));
    this.body.addChild(this.tableRule(widths));

    if (this.rows.length === 0) {
      this.body.addChild(new Text(theme.fg("muted", this.query ? `  （没有匹配 “${this.query}” 的设置项）` : "  （本节没有内容）"), 0, 0));
    }
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i]!;
      if (row.header) {
        // A section separator spans the table instead of becoming a cell, so the
        // grouping survives the table layout without a fourth column.
        // Measured in display columns, not characters: a CJK section name is two
        // columns per character, and using `.length` made the rule overflow onto a
        // second line.
        const lead = `  ── ${row.label} `;
        const tail = Math.max(0, widths.item + widths.value + widths.detail + 8 - visibleWidth(lead));
        this.body.addChild(new Text(theme.fg("accent", `  ── ${row.label} ${"─".repeat(tail)}`), 0, 0));
        continue;
      }
      const selected = i === this.cursor;
      const pointer = selected ? theme.fg("accent", "→ ") : "  ";
      const label = this.cell(row.label, widths.item);
      const value = this.cell(row.value, widths.value);
      const detail = this.cell(row.detail ?? "", widths.detail);
      // The cursor colour follows the column that owns it, the way the model panel's
      // header does: which column a keystroke will act on is visible, not implied.
      const labelCell = this.paint(label, selected && this.focus === "item" ? "accent" : selected ? "text" : null);
      const valueCell = this.paint(value, row.readOnly ? "muted" : selected && this.focus === "value" ? "accent" : "success");
      this.body.addChild(new Text(`${pointer}${labelCell}${sep}${valueCell}${sep}${this.paint(detail, "dim")}`, 0, 0));
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

  private refresh(): void {
    this.updateBody();
    this.tui?.requestRender?.();
  }

  /** Enter: do what this row's label says, whatever column the cursor is in. */
  private applyRow(): void {
    const row = this.rows[this.cursor];
    if (!row || row.readOnly) return;
    const action = row.act ?? row.toggle;
    if (action) this.run(action);
  }

  handleInput(data: string): void {
    if (this.matches(data, "cancel")) {
      this.io.close();
      return;
    }
    // Tab switches the scope tab (项目 / 状态), from either column.
    if (matchesKey(data, Key.tab)) {
      this.tab = this.tab === "project" ? "status" : "project";
      this.query = "";
      this.searchInput.setValue("");
      this.cursor = 0;
      this.rebuild();
      this.refresh();
      return;
    }
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
    if (this.tab !== "project" || this.focus !== "item") return;
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
   * the row, so two gestures delivered inside one tick — a held Space, two quick
   * Enters — both started from the same stale value and the second silently
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
    this.status = status;
    this.adopt(this.io.rows());
    this.refresh();
  }
}

type SettingsTab = "project" | "status";
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
      act: () => editKindLimit(control, commandCtx, entry.kind, entry.maxConcurrent),
    });
  }
  if (kinds.length === 0) {
    rows.push({ label: "（本构建没有内置 kind）", value: "", readOnly: true });
  }
  // The module's own lines, verbatim, on the read-only tab: a kind that did not
  // register must never be shown as available, and the reason is the only
  // actionable thing here. The leading status glyph is kept in the label rather
  // than rendered as a value, because these are sentences, not settings.
  rows.push({ label: "状态", value: "", header: true });
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
