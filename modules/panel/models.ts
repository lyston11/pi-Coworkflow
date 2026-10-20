/**
 * `/Comodels` — the model, thinking-level and usage table.
 *
 * Two tabs, because the two scopes have different owners:
 *
 *   主会话     applied through `pi.setModel` / `pi.setThinkingLevel`, which Pi
 *              documents as session-scoped — nothing is written to disk.
 *   子 agent   written to this project's `.pi/settings.json`
 *              (`subagents.defaultModel` / `defaultProvider` / `defaultThinking`),
 *              which pi-subagents resolves with project settings taking
 *              precedence over the user's.
 *
 * The usage column is read from what Pi and pi-subagents already wrote
 * (`core/usage.ts`): the session's own assistant messages, plus the run
 * metadata of the children this session dispatched. Only tokens spent after the
 * session loaded Coworkflow are counted — the rest was not produced by the layer.
 */

import { join } from "node:path";
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
import type { ModuleContext, PiRuntimeHost, RuntimeContext } from "../../core/module.ts";
import { fileContext } from "../../core/module.ts";
import { configRoot, readConfig } from "../../core/config.ts";
import { sessionEnabledSince, setSessionFlag } from "../../core/trellis.ts";
import {
  collectChildModelDailyUsage,
  collectModelDailyUsage,
  formatTokens,
  type DailySeries,
} from "../../core/usage.ts";
import {
  FALLBACK_KEYS,
  HISTORY_DAYS,
  INHERIT_MODEL_LABEL,
  INHERIT_THINKING_LABEL,
  MAX_VISIBLE,
  PROJECT_SETTINGS,
  SUBAGENT_KEYS,
  modelRows,
  thinkingRows,
  type Focus,
  type PanelKeybindings,
  type PanelModel,
  type PanelRow,
  type PanelSnapshot,
  type PanelTheme,
  type Tab,
  type ThinkingLevelName,
} from "./shared.ts";

export interface PanelPort {
  snapshot(): PanelSnapshot;
  /**
   * The model the cursor is on and the active tab, pushed by the panel before it
   * asks for a snapshot. The panel owns the cursor; the port owns the data, and
   * the history window has to be computed for the model under the cursor.
   */
  setCursorContext?(tab: Tab, model: string): void;
  applySessionModel(model: PanelModel): Promise<string>;
  applySessionThinking(level: ThinkingLevelName): string;
  applySubagentModel(model: PanelModel | null): string;
  applySubagentThinking(level: ThinkingLevelName | null): string;
  close(): void;
  requestRender(): void;
}

/** The session id Pi exposes on the command context, falling back to env. */
function sessionIdOf(ctx: any, runtime: RuntimeContext): string | null {
  const fromCtx = ctx?.sessionManager?.getSessionId?.();
  if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  return runtime.sessionId;
}

/**
 * The model panel: tabs on top (主会话 / 子 agent), three columns below —
 * 模型 | 思考等级 | 用量.
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
   * A snapshot reads every session entry and every subagent artifact, and one
   * keystroke used to ask for it five times (sync, body, and each panel that
   * wanted rows), which is what made the arrow keys feel sluggish. The cache is
   * dropped when input arrives or a value is applied, so it never serves stale
   * numbers.
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
          "↑↓ 移动 · ←→ 切换 模型/思考 列 · Tab 切换 主会话/子 agent · Enter 应用 · Esc 关闭 · 直接输入可搜索",
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
    const rows = this.focus === "model" ? modelRows(snapshot, this.tab) : modelRows(snapshot, this.tab);
    const row = rows[this.focus === "model" ? this.cursor(snapshot) : this.cursorOf(snapshot, "model")];
    const model = row?.model;
    this.port.setCursorContext?.(this.tab, model ? `${model.provider}/${model.id}` : "");
  }

  /** Rows currently rendered in the focused column, for tests. */
  currentRows(): PanelRow[] {
    return this.activeRows(this.snapshot());
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
      this.status = this.port.applySubagentModel(row.model ?? null);
      this.refresh();
      return;
    }

    const level = row.thinking ?? null;
    this.status =
      this.tab === "session"
        ? level === null
          ? "主会话思考等级不能清空"
          : this.port.applySessionThinking(level)
        : this.port.applySubagentThinking(level);
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

    // Tab switches the scope tab (主会话 / 子 agent), from either column. ←→
    // must be matched here rather than left to the search field: `Input` treats
    // cursorLeft/cursorRight as its own and would swallow them, which is exactly
    // why key-driven switching has to happen before the search input sees them.
    if (matchesKey(data, Key.tab)) {
      this.tab = this.tab === "session" ? "subagent" : "session";
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

  private tabBar(snapshot: PanelSnapshot): Container {
    const theme = this.theme;
    const header = new Container();
    const tabLine = (["session", "subagent"] as Tab[])
      .map((tab) => {
        const label = tab === "session" ? "主会话" : "子 agent";
        return this.tab === tab ? theme.fg("accent", `[${label}]`) : theme.fg("muted", ` ${label} `);
      })
      .join(" ");
    header.addChild(
      new Text(
        `${tabLine}  ${theme.fg(
          "muted",
          this.tab === "session" ? "本会话" : `本项目 ${PROJECT_SETTINGS}`,
        )}`,
        0,
        0,
      ),
    );
    header.addChild(
      new Text(
        theme.fg(
          "muted",
          this.tab === "session"
            ? `当前：${snapshot.sessionModel || "(未设置)"} · ${snapshot.sessionThinking || "(未设置)"}`
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
    if (series.days.length === 0) {
      const blank = Array.from({ length: rows }, () => "");
      blank[0] = this.paint(this.cell("—", width), "dim");
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
    const total = `${formatTokens(series.total)}`;
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
    this.body.addChild(new Text(this.theme.fg("muted", this.currentModelLine(snapshot)), 0, 0));
    this.statusText.setText(this.status ? this.theme.fg("success", this.status) : "");
  }

  /** One line summarising what is in effect, right under the table. */
  private currentModelLine(snapshot: PanelSnapshot): string {
    return this.tab === "session"
      ? `当前生效：${snapshot.sessionModel || "(未设置)"} · 思考 ${snapshot.sessionThinking || "(未设置)"} · 仅本会话`
      : `当前生效：${snapshot.subagentModel || INHERIT_MODEL_LABEL} · 思考 ${snapshot.subagentThinking || INHERIT_THINKING_LABEL} · 本项目`;
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
export function panelModels(ctx: any): PanelModel[] {
  const scoped: any[] = Array.isArray(ctx?.scopedModels) ? ctx.scopedModels : [];
  const registry = ctx?.modelRegistry;
  const source: any[] =
    scoped.length > 0
      ? scoped.map((entry) => entry?.model).filter(Boolean)
      : typeof registry?.getAvailable === "function"
        ? registry.getAvailable()
        : [];

  const models: PanelModel[] = source.map((model) => ({
    provider: String(model?.provider ?? "?"),
    id: String(model?.id ?? "?"),
    name: String(model?.name ?? ""),
    available:
      typeof registry?.hasConfiguredAuth === "function" ? Boolean(registry.hasConfiguredAuth(model)) : true,
    raw: model,
  }));
  const currentProvider = String(ctx?.model?.provider ?? "");
  const currentId = String(ctx?.model?.id ?? "");

  return models.sort((a, b) => {
    const aCurrent = a.provider === currentProvider && a.id === currentId;
    const bCurrent = b.provider === currentProvider && b.id === currentId;
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

function readJson(path: string, read: (path: string) => string | null): Record<string, unknown> {
  const raw = read(path);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function subagentSettings(ctx: ModuleContext): Record<string, unknown> {
  const settings = readJson(join(ctx.root, PROJECT_SETTINGS), ctx.read);
  const subagents = settings.subagents;
  return subagents !== null && typeof subagents === "object" && !Array.isArray(subagents)
    ? { ...(subagents as Record<string, unknown>) }
    : {};
}

/** Write one `subagents.*` key (or remove it when `value` is null). */
/**
 * Which project the panel is editing, and which session asked.
 *
 * Model choices are per project (`.pi/settings.json` → `subagents.*`) while the
 * session switch lives elsewhere, so a subagent setting is written here and the
 * current session is re-flagged so `/reload` keeps the layer on.
 */
let activePanelContext: { root: string; sessionId: string | null } | null = null;

/** Remember the project/session a panel is editing; called when it opens. */
export function setPanelContext(root: string, sessionId: string | null): void {
  activePanelContext = { root, sessionId };
}

export function writeSubagentSetting(
  ctx: ModuleContext,
  key: (typeof SUBAGENT_KEYS)[number],
  value: string | null,
): void {
  const path = join(ctx.root, PROJECT_SETTINGS);
  const settings = readJson(path, ctx.read);
  const subagents = subagentSettings(ctx);
  if (value === null) delete subagents[key];
  else subagents[key] = value;
  if (Object.keys(subagents).length === 0) delete settings.subagents;
  else settings.subagents = subagents;
  ctx.write(path, `${JSON.stringify(settings, null, 2)}\n`);

  // Writing through the panel means this session is using Coworkflow, so stamp
  // the session switch again: `/reload` drops it otherwise, and the user's next
  // `/Comodels` would refuse the very settings they just changed.
  const session = activePanelContext;
  if (session && session.sessionId) {
    setSessionFlag(session.root, session.sessionId, true);
  }
}

function createPort(
  ctx: ModuleContext,
  host: PiRuntimeHost,
  commandCtx: any,
  tui: { requestRender?(): void },
  done: () => void,
): PanelPort {
  // Pushed by the panel before each snapshot, so `history` can resolve the
  // model under the cursor rather than only the one in effect.
  let cursorTab: Tab = "session";
  let cursorModel = "";
  const selectedModel = (): string => cursorModel;
  const selectedTab = (): Tab => cursorTab;

  const findModel = (provider: string, id: string): PanelModel | undefined =>
    panelModels(commandCtx).find((model) => model.provider === provider && model.id === id);

  /**
   * Where pi-subagents writes run metadata. The session directory is the
   * default (`artifacts: "session"`), and project mode puts the same files
   * under `<cwd>/.pi/subagents/artifacts/`.
   */
  const artifactDirs = (cwd: string): string[] => {
    const dirs: string[] = [];
    const sessionDir = commandCtx?.sessionManager?.getSessionDir?.();
    if (typeof sessionDir === "string" && sessionDir) dirs.push(join(sessionDir, "subagent-artifacts"));
    dirs.push(join(cwd, ".pi", "subagents", "artifacts"));
    return dirs;
  };

  /**
   * The 7-day window for one model: session usage by day, plus child runs that
   * used the same model. Children are attributed by the model recorded in their
   * run metadata, so the bar reflects what that model actually consumed.
   */
  const enabledSince = (cwd: string): number | undefined => {
    const id = commandCtx?.sessionManager?.getSessionId?.();
    return sessionEnabledSince(configRoot(cwd), typeof id === "string" ? id : null);
  };

  const historyFor = (cwd: string, model: string): DailySeries => {
    if (!model) {
      return { days: [], total: 0, peak: 0 };
    }
    const entries = commandCtx?.sessionManager?.getEntries?.();
    const sessionId = commandCtx?.sessionManager?.getSessionId?.();
    // Only tokens spent while Coworkflow was loaded count: that is the layer's
    // own consumption, and counting earlier turns would inflate every number.
    const since = enabledSince(cwd);
    const series = Array.isArray(entries)
      ? collectModelDailyUsage(entries, model, HISTORY_DAYS, new Date(), since)
      : { days: [], total: 0, peak: 0 };
    const childSeries = collectChildModelDailyUsage(
      artifactDirs(cwd),
      model,
      HISTORY_DAYS,
      typeof sessionId === "string" ? sessionId : null,
      new Date(),
      since,
    );
    // Merge both sources per day so one bar covers everything that model spent.
    const days = series.days.map((day, index) => {
      const other = childSeries.days[index];
      return {
        day: day.day,
        input: day.input + (other?.input ?? 0),
        output: day.output + (other?.output ?? 0),
        cacheRead: day.cacheRead + (other?.cacheRead ?? 0),
        cacheWrite: day.cacheWrite + (other?.cacheWrite ?? 0),
      };
    });
    const total = days.reduce(
      (sum, day) => sum + day.input + day.output + day.cacheRead + day.cacheWrite,
      0,
    );
    const peak = days.reduce(
      (max, day) => Math.max(max, day.input + day.output + day.cacheRead + day.cacheWrite),
      0,
    );
    return { days, total, peak };
  };

  const history = (cwd: string) => {
    // Only the model under the cursor is charted, so only its series is built.
    // Building a second series for the model in effect doubled the per-keystroke
    // cost for data the panel never rendered.
    const selected = selectedModel();
    const since = enabledSince(cwd);
    return {
      selectedModel: selected,
      selected: historyFor(cwd, selected),
      ...(since !== undefined ? { since } : {}),
    };
  };

  const snapshot = (): PanelSnapshot => {
    const settings = subagentSettings(ctx);
    const modelId = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
    const sessionModel = commandCtx?.model
      ? {
          provider: String(commandCtx.model.provider),
          id: String(commandCtx.model.id),
          name: String(commandCtx.model.name ?? ""),
          available: true,
          raw: commandCtx.model,
        }
      : undefined;
    return {
      models: panelModels(commandCtx),
      sessionModel: sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "",
      sessionThinking: String(host.getThinkingLevel?.() ?? commandCtx?.thinkingLevel ?? ""),
      subagentModel: modelId ? (provider ? `${provider}/${modelId}` : modelId) : "",
      subagentThinking: typeof settings.defaultThinking === "string" ? settings.defaultThinking : "",
      sessionEffectiveModel: sessionModel,
      // A subagent without its own model runs on the parent's, so its thinking
      // levels are the parent model's levels.
      subagentEffectiveModel:
        (modelId ? findModel(provider, modelId) : undefined) ??
        findModel(String(commandCtx?.model?.provider ?? ""), String(commandCtx?.model?.id ?? "")) ??
        sessionModel,
      history: history(
        typeof commandCtx?.cwd === "string" && commandCtx.cwd ? commandCtx.cwd : ctx.root,
      ),
    };
  };

  return {
    setCursorContext(tab: Tab, model: string) {
      cursorTab = tab;
      cursorModel = model;
    },
    snapshot,
    async applySessionModel(model: PanelModel): Promise<string> {
      const found = commandCtx?.modelRegistry?.find?.(model.provider, model.id) ?? model.raw;
      if (!found) return `找不到模型 ${model.provider}/${model.id}`;
      const ok = await host.setModel?.(found);
      return ok === false
        ? `${model.provider}/${model.id} 未配置凭据，未切换`
        : `主会话模型 → ${model.provider}/${model.id}（仅本会话）`;
    },
    applySessionThinking(level: ThinkingLevelName): string {
      host.setThinkingLevel?.(level);
      return `主会话思考等级 → ${level}（仅本会话）`;
    },
    applySubagentModel(model: PanelModel | null): string {
      if (model === null) {
        writeSubagentSetting(ctx, "defaultModel", null);
        writeSubagentSetting(ctx, "defaultProvider", null);
        return "子 agent 模型 → 继承主会话";
      }
      writeSubagentSetting(ctx, "defaultModel", model.id);
      writeSubagentSetting(ctx, "defaultProvider", model.provider);
      return `子 agent 模型 → ${model.provider}/${model.id}（本项目）`;
    },
    applySubagentThinking(level: ThinkingLevelName | null): string {
      writeSubagentSetting(ctx, "defaultThinking", level);
      return level === null ? "子 agent 思考等级 → 默认" : `子 agent 思考等级 → ${level}（本项目）`;
    },
    close: done,
    requestRender: () => tui?.requestRender?.(),
  };
}

/** Register `/Comodels`; idempotent, since a session may activate twice. */
export function registerModelPanel(host: PiRuntimeHost, runtime: RuntimeContext): void {
  if (modelPanelRegistered) return;
  modelPanelRegistered = true;

  const open = async (commandCtx: any): Promise<void> => {
    // The switch may have been flipped a moment ago (`/Coworkflow:start` in this
    // session, or a settings write that re-stamps it), so re-read before refusing.
    runtime.refresh();
    // Registered once the session loads Coworkflow; if the session then runs
    // `/Coworkflow:start off`, the command stays but refuses, so a stopped
    // session is plain Pi again.
    if (!runtime.enabled) {
      // `/reload` re-loads extensions but not the session switch, so "not loaded"
      // here is expected rather than a broken install. Say which it is.
      const initialized = readConfig(configRoot(runtime.cwd)) !== null;
      const message = !initialized
        ? "本项目未初始化：先运行 /Coworkflow:init"
        : "本会话未加载 Coworkflow（/reload 之后需要重新加载）：运行 /Coworkflow:start";
      commandCtx?.ui?.notify?.(message, "warning");
      try {
        host.sendMessage?.({ customType: "pi-Coworkflow", content: message, display: true });
        if (commandCtx?.mode !== "tui") console.error(message);
      } catch {
        // Nothing else to fall back to.
      }
      return;
    }
    if (commandCtx?.mode !== "tui" || typeof commandCtx?.ui?.custom !== "function") {
      // `notify` is a no-op outside the TUI, so say it in the transcript too.
      const message = "模型面板需要交互式 TUI 会话（在 pi 的 TUI 里运行 /Comodels）";
      commandCtx?.ui?.notify?.(message, "warning");
      try {
        host.sendMessage?.({ customType: "pi-Coworkflow", content: message, display: true });
        if (commandCtx?.mode !== "tui") console.error(message);
      } catch {
        // Nothing else to fall back to.
      }
      return;
    }
    const cwd = typeof commandCtx?.cwd === "string" && commandCtx.cwd ? commandCtx.cwd : runtime.cwd;
    const context = fileContext(cwd);
    setPanelContext(context.root, sessionIdOf(commandCtx, runtime));

    await commandCtx.ui.custom(
      (tui: any, theme: PanelTheme, keybindings: PanelKeybindings, done: (value: unknown) => void) => {
        const port = createPort(context, host, commandCtx, tui, () => done(undefined));
        return new ModelPanel(port, theme, tui, keybindings);
      },
    );
  };

  host.registerCommand?.("Comodels", {
    description:
      "模型面板：主会话（本会话）与子 agent（本项目）的模型、思考等级与 token 用量，复用 /model 的模型列表",
    handler: (_args: string, commandCtx: any) => open(commandCtx),
  });
}

let modelPanelRegistered = false;
