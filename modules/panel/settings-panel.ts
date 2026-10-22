/**
 * The settings panel component.
 *
 * Split out from `settings.ts` so the host UI packages are imported **only** when a
 * panel is actually opened. Pi resolves `@earendil-works/pi-tui` through loader
 * aliases; with a top-level import in `settings.ts`, one unaliased host package made
 * the whole extension fail to import — no commands, no injection, no gates, and
 * nothing printed to explain it. Registering the command must not depend on the
 * renderer being importable.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Spacer, Text, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PanelKeybindings, PanelTheme } from "./shared.ts";
import type { SettingRow } from "./settings.ts";

/** What the panel needs from its owner: rows, close, and what to do after a change. */
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
/**
 * The body is padded to a stable height.
 *
 * Pages have very different amounts of content — the 会话 page has two rows, the
 * 模块 page nine — and without padding the panel changes size every time the tab bar
 * is used, which makes the whole box jump under the reader's hands. Padded to the
 * tallest page (bounded, so a long 状态 page cannot push it off screen) the frame
 * stays put and only the contents change.
 */
const MIN_BODY_ROWS = 10;
const MAX_BODY_ROWS = 16;

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
  /** Non-null while a value is being edited in place. */
  private editing: { row: SettingRow; input: Input } | null = null;

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

  /** Row count a page is padded to, so the frame does not resize on a page change. */
  private targetRows(): number {
    const tallest = Math.max(
      MIN_BODY_ROWS,
      ...this.tabNames().map((name) => this.all.filter((row) => (row.section ?? "") === name).length),
    );
    return Math.min(MAX_BODY_ROWS, tallest);
  }

  /** The visible slice of the active page, windowed around the cursor when it is long. */
  private window(): { rows: SettingRow[]; start: number } {
    const limit = this.targetRows();
    if (this.rows.length <= limit) return { rows: this.rows, start: 0 };
    const start = Math.min(
      Math.max(0, this.cursor - Math.floor(limit / 2)),
      Math.max(0, this.rows.length - limit),
    );
    return { rows: this.rows.slice(start, start + limit), start };
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
    const view = this.window();
    let painted = 0;
    for (let offset = 0; offset < view.rows.length; offset += 1) {
      const row = view.rows[offset]!;
      const i = view.start + offset;
      painted += 1;
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
    // Pad to the page's stable height: the frame must not resize when the tab bar is
    // used, and an empty line is cheaper than a panel that jumps.
    // `Text("")` and `Text(" ")` both render zero lines (pi-tui trims), so the pad has
    // to be a Spacer: an "empty" Text silently kept the body short and the frame went
    // on resizing between pages.
    for (let pad = painted; pad < this.targetRows(); pad += 1) {
      this.body.addChild(new Spacer(1));
    }
    if (this.editing) {
      const row = this.editing.row;
      this.statusText.setText(
        theme.fg("accent", `编辑「${row.label}」：`) +
          this.editing.input.render(Math.max(20, width - 24)).join("") +
          theme.fg("muted", `  ${row.editor?.placeholder ?? ""}（Enter 提交 · Esc 取消）`),
      );
    } else {
      this.statusText.setText(this.status ? theme.fg("success", this.status) : "");
    }
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
    if (row.editor) {
      this.beginEdit(row);
      return;
    }
    const action = row.act ?? row.toggle;
    if (action) this.run(action);
  }

  /** Open the in-panel editor on this row. The panel stays the only dialog. */
  private beginEdit(row: SettingRow): void {
    if (this.inflight || !row.editor) return;
    const input = new Input();
    input.setValue(row.editor.current);
    // `setValue` leaves the cursor at the start, so a typed digit would land *before* the
    // current value: editing "6" by typing "0" produced "06". Move to the end, where a
    // person editing a number expects to be.
    input.handleInput("\x1b[F");
    input.focused = true;
    input.onSubmit = () => {
      const value = input.getValue();
      this.editing = null;
      this.searchInput.focused = this.focus === "item";
      void this.run(() => row.editor!.commit(value));
    };
    this.editing = { row, input };
    this.searchInput.focused = false;
    this.refresh();
  }

  private cancelEdit(): void {
    this.editing = null;
    this.searchInput.focused = this.focus === "item";
    this.refresh();
  }

  handleInput(data: string): void {
    // While a value is being edited, the editor owns the keyboard: Esc abandons the
    // edit (not the panel), Enter commits, and nothing else reaches the row cursor.
    if (this.editing) {
      if (this.matches(data, "cancel")) return this.cancelEdit();
      this.editing.input.handleInput(data);
      this.refresh();
      return;
    }
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
