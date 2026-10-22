/**
 * The model panel component (`/Comodels`).
 *
 * Split out from `models.ts` so the host UI packages are imported only when a panel is
 * actually opened: Pi resolves them through loader aliases, and a top-level import in
 * the module that registers the command meant one unaliased host package took the whole
 * extension down at import time — no commands, no injection, no gates, and nothing
 * printed to say why.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Key,
  Spacer,
  Text,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  FALLBACK_KEYS,
  HISTORY_DAYS,
  type Focus,
  PROJECT_SETTINGS,
  INHERIT_MODEL_LABEL,
  INHERIT_THINKING_LABEL,
  MAX_VISIBLE,
  type PanelKeybindings,
  type PanelModel,
  type PanelPage,
  type PanelRow,
  type PanelSnapshot,
  type PanelTheme,
  type Tab,
  type ThinkingLevelName,
  kindForTab,
  kindStateLabel,
  kindsLayerNote,
  modelRows,
  nextTab,
  panelPages,
  registryKeyOf,
  resolveTab,
  supportedThinkingLevels,
  thinkingRows,
} from "./shared.ts";
import { formatTokens, type DailySeries } from "../../core/usage.ts";
import { CONFIG_REL } from "../../core/config.ts";
import type { PanelPort } from "./models.ts";

/**
 * The model panel: tabs on top (主会话 / 子 agent（默认） / one per kind), three
 * columns below — 模型 | 思考等级 | 用量.
 */
export class ModelPanel extends Container {
  private readonly port: PanelPort;
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings | undefined;
  private readonly tui: { requestRender?(): void };

  private tab: Tab = "session";
  private focus: Focus = "model";
  private readonly index: Record<string, number> = {};
  private query = "";
  private status = "";

  private readonly body = new Container();
  private readonly searchInput = new Input();
  /** Last width handed to render(), so the table can size its columns. */
  private width: number | undefined;
  /**
   * Snapshot cache for one render pass.
   *
   * Snapshots project cached history in memory. No RPC or file reads occur in
   * rendering; opening the panel refreshes the data at its command boundary.
   */
  private cached: PanelSnapshot | undefined;
  private readonly statusText = new Text("", 0, 0);

  constructor(
    port: PanelPort,
    theme: PanelTheme,
    tui: { requestRender?(): void },
    keybindings?: PanelKeybindings,
  ) {
    super();
    this.port = port;
    this.theme = theme;
    this.tui = tui;
    this.keybindings = keybindings;

    const border = () => new DynamicBorder((str: string) => theme.fg("border", str));
    this.addChild(border());
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.addChild(new Spacer(1));
    this.addChild(this.statusText);
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          "↑↓ 移动 · ←→ 切换 模型/思考 列 · Tab 切换页面 · Enter 应用 · Esc 关闭 · 直接输入可搜索",
        ),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(border());

    this.searchInput.focused = true;
    this.searchInput.onSubmit = () => this.apply();
    this.updateBody();
  }

  render(width: number): string[] {
    this.width = width;
    this.updateBody();
    return super.render(width);
  }

  /**
   * Tell the port which model the cursor is on before asking for data, so the
   * usage chart follows the selection instead of always showing the model in
   * effect.
   */
  private syncCursorContext(): void {
    const snapshot = this.snapshot();
    const rows = modelRows(snapshot, this.tab);
    const row = rows[this.focus === "model" ? this.cursor(snapshot) : this.cursorOf(snapshot, "model")];
    // The registry key, not a fabricated one: a row standing for a stored pin the
    // registry does not hold has no tokens to attribute, and `/provider/id` would chart
    // whatever model happens to share that spelling.
    this.port.setCursorContext?.(this.tab, registryKeyOf(row?.model ?? undefined));
    this.cached = undefined;
  }

  /** Rows currently rendered in the focused column, for tests. */
  currentRows(): PanelRow[] {
    return this.activeRows(this.snapshot());
  }

  /**
   * The pages the tab bar is built from, for tests.
   *
   * The list is computed from the snapshot's kinds — which is what
   * `control.agentKinds()` resolves — so asserting on it is asserting that no scope
   * list is hardcoded: a kind this package ships gets its page without this file
   * changing.
   */
  pages(): PanelPage[] {
    return panelPages(this.snapshot());
  }

  /** Which page currently owns the cursor, for tests. */
  currentTab(): Tab {
    return this.tab;
  }

  private key(): string {
    return `${this.tab}:${this.focus}`;
  }

  private matches(data: string, action: "up" | "down" | "confirm" | "cancel"): boolean {
    const kb = this.keybindings;
    if (kb?.matches) return kb.matches(data, `tui.select.${action}`);
    return FALLBACK_KEYS[action]?.test(data) ?? false;
  }

  private activeRows(snapshot: PanelSnapshot): PanelRow[] {
    const rows = this.focus === "model" ? modelRows(snapshot, this.tab) : thinkingRows(snapshot, this.tab);
    if (this.focus !== "model" || !this.query.trim()) return rows;
    return fuzzyFilter(rows, this.query, (row) => `${row.label} ${row.badge ?? ""} ${row.detail ?? ""}`);
  }

  private cursor(snapshot: PanelSnapshot): number {
    const rows = this.activeRows(snapshot);
    if (rows.length === 0) return 0;
    const stored = this.index[this.key()];
    if (stored === undefined) {
      const current = rows.findIndex((row) => row.current);
      const initial = current >= 0 ? current : 0;
      this.index[this.key()] = initial;
      return initial;
    }
    return Math.max(0, Math.min(stored, rows.length - 1));
  }

  private setCursor(snapshot: PanelSnapshot, next: number): void {
    const rows = this.activeRows(snapshot);
    this.index[this.key()] = Math.max(0, Math.min(next, Math.max(0, rows.length - 1)));
  }

  private apply(): void {
    const snapshot = this.snapshot();
    const rows = this.activeRows(snapshot);
    const row = rows[this.cursor(snapshot)];
    if (!row) return;
    const kind = kindForTab(snapshot, this.tab);

    if (this.focus === "model") {
      if (this.tab === "session") {
        const model = row.model;
        if (!model) return;
        void this.port
          .applySessionModel(model)
          .then((status) => {
            this.status = status;
            this.refresh();
          })
          .catch((error: unknown) => {
            this.status = `应用失败：${error instanceof Error ? error.message : String(error)}`;
            this.refresh();
          });
        return;
      }
      if (kind) {
        // Through the kind's own writer: it validates, persists the config key and
        // re-registers the agent, so the panel reports the registration outcome
        // instead of echoing the choice it just made.
        void this.port
          .applyKindModel(kind.kind, row.model ?? null)
          .then((status) => {
            this.status = status;
            this.refresh();
          })
          .catch((error: unknown) => {
            this.status = `应用失败：${error instanceof Error ? error.message : String(error)}`;
            this.refresh();
          });
        return;
      }
      this.status = this.port.applySubagentModel(row.model ?? null);
      this.refresh();
      return;
    }

    const level = row.thinking ?? null;
    if (this.tab === "session") {
      this.status = level === null ? "主会话思考等级不能清空" : this.port.applySessionThinking(level);
      this.cached = undefined;
      this.refresh();
      return;
    }
    if (kind) {
      void this.port
        .applyKindThinking(kind.kind, level)
        .then((status) => {
          this.status = status;
          this.refresh();
        })
        .catch((error: unknown) => {
          this.status = `应用失败：${error instanceof Error ? error.message : String(error)}`;
          this.refresh();
        });
      return;
    }
    this.status = this.port.applySubagentThinking(level);
    this.cached = undefined;
    this.refresh();
  }

  handleInput(data: string): void {
    this.cached = undefined;
    const snapshot = this.snapshot();

    if (this.matches(data, "cancel")) {
      this.port.close();
      return;
    }

    // Tab cycles every page, from either column: the two scopes, then one per kind.
    // ←→ must be matched here rather than left to the search field: `Input` treats
    // cursorLeft/cursorRight as its own and would swallow them, which is exactly
    // why key-driven switching has to happen before the search input sees them.
    if (matchesKey(data, Key.tab)) {
      this.tab = nextTab(snapshot, this.tab);
      this.refresh();
      return;
    }

    // ←→ switch which column owns the cursor: 模型 / 思考等级.
    if (matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
      this.focus = this.focus === "model" ? "thinking" : "model";
      this.query = "";
      this.searchInput.setValue("");
      this.searchInput.focused = this.focus === "model";
      this.refresh();
      return;
    }

    if (this.matches(data, "up")) {
      this.setCursor(snapshot, this.cursor(snapshot) - 1);
      this.refresh();
      return;
    }
    if (this.matches(data, "down")) {
      this.setCursor(snapshot, this.cursor(snapshot) + 1);
      this.refresh();
      return;
    }
    if (this.matches(data, "confirm")) {
      this.apply();
      return;
    }

    if (this.focus !== "model") return;
    this.searchInput.handleInput(data);
    this.query = this.searchInput.getValue();
    this.refresh();
  }

  private refresh(): void {
    this.updateBody();
    this.tui?.requestRender?.();
  }

  /** The current snapshot, computed at most once per render pass. */
  private snapshot(): PanelSnapshot {
    this.cached ??= this.port.snapshot();
    return this.cached;
  }

  /**
   * A table cell, padded/truncated to an exact display width.
   *
   * Padding has to happen on the *visible* text: colouring a cell before padding
   * makes `truncateToWidth` count escape sequences and the columns drift apart,
   * which is what made the earlier table look ragged.
   */
  private cell(text: string, width: number): string {
    return truncateToWidth(text, width, "…", true);
  }

  /** Colour applied after the cell has been padded to its column width. */
  private paint(text: string, color: string | null): string {
    return color ? this.theme.fg(color, text) : text;
  }

  /**
   * Column widths for the table.
   *
   * The model name gets a fixed share rather than `grow`, because the panel was
   * spending most of its width on model ids while the usage numbers wrapped into
   * three lines. Everything is computed from the terminal width so the table fits
   * on one screen at 100 columns and expands gracefully above that.
   */
  private columnWidths(width: number): { model: number; thinking: number; usage: number } {
    const SEP = 3; // " │ "
    const MARGIN = 2;
    const total = Math.max(60, width - MARGIN - SEP * 2);
    const thinking = Math.min(18, Math.max(12, Math.floor(total * 0.16)));
    // The usage column carries a bar plus numbers, so it gets the largest share;
    // the model id is truncated instead of being allowed to eat the row.
    const usage = Math.min(64, Math.max(26, Math.floor(total * 0.5)));
    // Cap the model column: an id longer than ~44 columns is truncated anyway, and
    // the extra width is more useful to the numbers.
    const model = Math.min(46, Math.max(18, total - thinking - usage));
    const slack = Math.max(0, total - thinking - usage - model);
    return { model, thinking, usage: usage + slack };
  }

  /** Horizontal rule spanning the table, so the columns read as a table. */
  private tableRule(widths: { model: number; thinking: number; usage: number }): string {
    const theme = this.theme;
    // The data rows join cells with " │ " (3 columns), so the rule has to carry a
    // dash on each side of the junction to land its ┼ under the same column.
    const bar = (w: number) => "─".repeat(w);
    return theme.fg(
      "dim",
      `  ${bar(widths.model)}─┼─${bar(widths.thinking)}─┼─${bar(widths.usage)}`,
    );
  }

  /** Header row: 模型 | 思考等级 | 用量 */
  private tableHeader(widths: { model: number; thinking: number; usage: number }): string {
    const theme = this.theme;
    const sep = theme.fg("dim", " │ ");
    const model = this.paint(this.cell("模型", widths.model), this.focus === "model" ? "accent" : "muted");
    const thinking = this.paint(
      this.cell("思考等级", widths.thinking),
      this.focus === "thinking" ? "accent" : "muted",
    );
    const usage = this.paint(this.cell("用量", widths.usage), "muted");
    return `  ${model}${sep}${thinking}${sep}${usage}`;
  }

  /**
   * The page bar: every page the snapshot defines, in order, with the current one
   * bracketed.
   *
   * Built from `panelPages`, so a kind this package ships appears and one removed from
   * the shipped table disappears — a hardcoded 主会话/子 agent pair was exactly what made
   * a per-kind model unrepresentable in this panel.
   */
  private tabBar(snapshot: PanelSnapshot): Container {
    const theme = this.theme;
    const header = new Container();
    const pages = panelPages(snapshot);
    const tabLine = pages
      .map((page) => {
        const text = page.note ? `${page.label}（${page.note}）` : page.label;
        return this.tab === page.tab ? theme.fg("accent", `[${text}]`) : theme.fg("muted", ` ${text} `);
      })
      .join(" ");
    const kind = kindForTab(snapshot, this.tab);
    // Where the page's `Enter` actually writes. A kind page writes
    // `.pi/Coworkflow.json` (`agentKinds.<kind>`), not the subagents settings file — the
    // panel is where a user learns where a setting lives.
    const scope =
      this.tab === "session" ? "本会话"
      : kind ? `本项目 ${CONFIG_REL} · agentKinds.${kind.kind}`
      : `本项目 ${PROJECT_SETTINGS}`;
    const layer = kindsLayerNote(snapshot);
    header.addChild(new Text(`${tabLine}  ${theme.fg("muted", scope)}${layer ? `  ${theme.fg("warning", layer)}` : ""}`, 0, 0));
    header.addChild(
      new Text(
        theme.fg(
          "muted",
          this.tab === "session"
            ? `当前：${snapshot.sessionModel || "(未设置)"} · ${snapshot.sessionThinking || "(未设置)"}`
            : kind
              ? `当前：${kind.model || INHERIT_MODEL_LABEL} · ${kind.thinking || INHERIT_THINKING_LABEL} · ${kindStateLabel(snapshot, kind)}${kind.enabled ? "" : " · 该 kind 已关闭，模型仍然保留"}`
              : `当前：${snapshot.subagentModel || INHERIT_MODEL_LABEL} · ${snapshot.subagentThinking || INHERIT_THINKING_LABEL}`,
        ),
        0,
        0,
      ),
    );
    return header;
  }

  /**
   * The table body: one row per model, so the thinking levels and the usage of a
   * model sit on the same line as the model instead of in separate columns.
   *
   * The focused column's rows are the selectable ones; the other column still
   * renders (with its own current value) so the row reads as a record.
   */
  private tableBody(snapshot: PanelSnapshot, width: number): string[] {
    const theme = this.theme;
    const widths = this.columnWidths(width);
    const lines: string[] = [this.tableHeader(widths), this.tableRule(widths)];

    const modelRowsAll = modelRows(snapshot, this.tab);
    const filtered =
      this.focus === "model" && this.query.trim()
        ? fuzzyFilter(modelRowsAll, this.query, (row) => `${row.label} ${row.badge ?? ""} ${row.detail ?? ""}`)
        : modelRowsAll;
    const modelCursor = this.focus === "model" ? this.cursor(snapshot) : this.cursorOf(snapshot, "model");
    const thinkingRowsAll = thinkingRows(snapshot, this.tab);
    const thinkingCursor =
      this.focus === "thinking" ? this.cursor(snapshot) : this.cursorOf(snapshot, "thinking");
    const thinkingActive = this.focus === "thinking";

    const start = Math.max(
      0,
      Math.min(modelCursor - Math.floor(MAX_VISIBLE / 2), Math.max(0, filtered.length - MAX_VISIBLE)),
    );
    const end = Math.min(start + MAX_VISIBLE, filtered.length);
    // Both columns are lists: models on the left, thinking levels in the middle.
    // The middle one always shows every level it offers — before this it showed a
    // single value per model row and expanded into the full list only once it owned
    // the cursor, so half the panel read as "there is exactly one thinking level".
    const lineCount = Math.min(MAX_VISIBLE, Math.max(end - start, thinkingRowsAll.length));
    const sep = theme.fg("dim", " │ ");

    // The chart fills the usage column beside the table, starting on the second
    // line so it never crowds the first row under the header.
    const chart = this.historyBlock(snapshot.history.selected, Math.max(3, lineCount - 1), widths.usage);

    for (let line = 0; line < lineCount; line += 1) {
      const index = start + line;
      const row = filtered[index];

      // Every cell is padded as plain text, then coloured. Padding a coloured
      // string would count escape bytes as width and misalign the columns.
      let mark = "  ";
      let modelCell = this.cell("", widths.model);
      if (row) {
        const selected = this.focus === "model" && index === modelCursor;
        if (selected) mark = theme.fg("accent", "→ ");
        const check = row.current ? "✓ " : "  ";
        const badge = row.badge ? ` [${row.badge}]` : "";
        modelCell = this.paint(
          this.cell(`${check}${row.label}${badge}`, widths.model),
          selected ? "accent" : null,
        );
      }

      // The thinking column is always its own list, one level per line, so the whole
      // set of choices is visible whether or not it owns the cursor; `●` marks what
      // is in effect and `→` appears only while the column is being driven.
      let thinkingCell = this.cell("", widths.thinking);
      const level = thinkingRowsAll[line];
      if (level) {
        const selected = thinkingActive && line === thinkingCursor;
        const pointer = selected ? theme.fg("accent", "→ ") : "  ";
        const dot = level.current ? theme.fg("success", "●") : "○";
        const text = this.cell(`${pointer}${dot} ${level.label}`, widths.thinking);
        thinkingCell = selected ? theme.fg("accent", text) : this.paint(text, level.current ? "success" : null);
      }

      const usageCell = chart[line - 1] ?? this.cell("", widths.usage);
      lines.push(`${mark}${modelCell}${sep}${thinkingCell}${sep}${usageCell}`);
    }

    if (filtered.length === 0) lines.push(`  ${theme.fg("muted", "无匹配模型")}`);
    if (start > 0 || end < filtered.length) {
      lines.push(`  ${theme.fg("muted", `(${modelCursor + 1}/${filtered.length})`)}`);
    }
    return lines;
  }

  /**
   * One usage cell: a proportional bar, then the numbers.
   *
   * `in`/`out` are what the model actually billed; the bar scales on their sum
   * (plus cache, which dominates for these providers) so a model that used ten
   * times the tokens visibly has a ten-times-longer bar.
   */
  /**
   * The 7-day chart as a block of `height` lines: one column per day, bars growing
   * upward, weekday labels on the bottom line.
   *
   * It is multi-line because the usage column is as tall as the model list — a
   * single row of block glyphs wasted that space and could not show a spike.
   */
  private historyBlock(series: DailySeries, height: number, width: number): string[] {
    const theme = this.theme;
    const rows = Math.max(3, height);
    const barRows = rows - 1; // the last line is the day axis
    if (series.unavailable || series.days.length === 0) {
      const blank = Array.from({ length: rows }, () => "");
      blank[0] = this.paint(this.cell(series.unavailable ? "未知 / 不完整" : "—", width), "dim");
      return blank;
    }

    // Day columns: as wide as the usage column allows, at least 2, at most 3.
    const dayCount = series.days.length;
    const colWidth = Math.max(2, Math.min(3, Math.floor(width / dayCount)));
    const heights = series.days.map((day) => {
      const spent = day.input + day.output + day.cacheRead + day.cacheWrite;
      if (spent === 0 || series.peak === 0) return 0;
      return Math.max(1, Math.round((spent / series.peak) * barRows));
    });

    const lines: string[] = [];
    for (let row = 0; row < barRows; row += 1) {
      // row 0 is the top of the chart; a day is filled while its bar reaches it.
      const level = barRows - row;
      const cells = heights.map((h) =>
        h >= level ? theme.fg("accent", "█".repeat(colWidth)) : " ".repeat(colWidth),
      );
      lines.push(this.cell(` ${cells.join("")}`, width));
    }

    // Axis: weekday of each day, then the window total on the right.
    const axis = series.days
      .map((day) => {
        const label = this.weekdayLabel(day.day);
        return label.padEnd(colWidth, " ");
      })
      .join("");
    const total = `${series.incomplete ? "≥" : ""}${formatTokens(series.total)}${series.incomplete ? " 不完整" : ""}`;
    const axisText = this.cell(` ${axis} ${total}`, width);
    lines.push(theme.fg("dim", axisText));
    return lines;
  }

  /** `一`..`日` for a local `YYYY-MM-DD`. */
  private weekdayLabel(day: string): string {
    const date = new Date(`${day}T00:00:00`);
    if (Number.isNaN(date.getTime())) return " ";
    return "日一二三四五六"[date.getDay()] ?? " ";
  }

  private updateBody(): void {
    // A page whose kind is gone — the block was removed from the config while this
    // panel was open — must not render as an empty table: fall back to the session
    // page, which always exists.
    this.tab = resolveTab(this.snapshot(), this.tab);
    // Push the cursor's model first: the snapshot's 7-day window is computed for
    // it, so asking before syncing would chart the previously selected model.
    this.syncCursorContext();
    const snapshot = this.snapshot();
    const width = this.width ?? 100;

    this.body.clear();
    this.body.addChild(new Text(this.theme.fg("accent", "pi-Coworkflow · 模型面板"), 0, 0));
    this.body.addChild(this.tabBar(snapshot));
    this.body.addChild(new Spacer(1));
    this.body.addChild(this.searchInput);
    for (const line of this.tableBody(snapshot, width)) {
      this.body.addChild(new Text(line, 0, 0));
    }
    this.body.addChild(new Spacer(1));
    this.body.addChild(new Text(this.theme.fg("muted", [this.currentModelLine(snapshot), snapshot.history.costSummary,
      snapshot.history.selected.reason ? `图表不完整：${snapshot.history.selected.reason}` : ""].filter(Boolean).join(" · ")), 0, 0));
    this.statusText.setText(this.status ? this.theme.fg("success", this.status) : "");
  }

  /** One line summarising what is in effect, right under the table. */
  private currentModelLine(snapshot: PanelSnapshot): string {
    const kind = kindForTab(snapshot, this.tab);
    if (this.tab === "session") {
      return `当前生效：${snapshot.sessionModel || "(未设置)"} · 思考 ${snapshot.sessionThinking || "(未设置)"} · 仅本会话`;
    }
    if (kind) {
      // Reads the same field the status report does, so the two cannot disagree
      // about what this kind runs on.
      const layer = kindsLayerNote(snapshot);
      return `当前生效：${kind.model || INHERIT_MODEL_LABEL} · 思考 ${kind.thinking || INHERIT_THINKING_LABEL} · ${
        kind.enabled ? "本项目" : "本项目（该 kind 已关闭，模型仍然保留）"}${layer ? ` · ${layer}` : ""}`;
    }
    return `当前生效：${snapshot.subagentModel || INHERIT_MODEL_LABEL} · 思考 ${snapshot.subagentThinking || INHERIT_THINKING_LABEL} · 本项目`;
  }

  /** Cursor of a column that does not currently own the focus. */
  private cursorOf(snapshot: PanelSnapshot, column: Focus): number {
    const rows = column === "model" ? modelRows(snapshot, this.tab) : thinkingRows(snapshot, this.tab);
    const stored = this.index[`${this.tab}:${column}`];
    if (stored !== undefined) return Math.max(0, Math.min(stored, Math.max(0, rows.length - 1)));
    const current = rows.findIndex((row) => row.current);
    return current >= 0 ? current : 0;
  }

}

/** The list of models the panel offers, mirroring what `/model` shows. */
