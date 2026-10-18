/**
 * Module: the session panels.
 *
 *   `/Coworkflow:settings`  the project's Coworkflow settings: module switches,
 *                           whether a new session loads the layer by itself, the
 *                           worktree prefix, Trellis paradigm alignment. In an
 *                           uninitialized project it offers to initialize it,
 *                           because that is the one thing that must happen
 *                           before anything else works.
 *   `/Comodels`             the model panel: the session's model and thinking
 *                           level, and the project's defaults for dispatched
 *                           children, plus token usage.
 *
 * `/Coworkflow:settings` is always available (it is how a project gets
 * configured), while `/Comodels` only exists once this session has loaded
 * Coworkflow — `/Coworkflow:start`, or the project's `autoEnable`. Before
 * that a session is plain Pi: native `/model`, the user's own subagent
 * configuration, no Trellis injection, no Coworkflow panel.
 *
 * Model control is split by scope: the session tab applies through
 * `pi.setModel` / `pi.setThinkingLevel` (Pi documents those as session-scoped,
 * never written to a settings file), and the subagent tab writes the *project's*
 * `.pi/settings.json` (`subagents.defaultModel` / `defaultProvider` /
 * `defaultThinking`), which pi-subagents resolves with project settings taking
 * precedence over the user's. Nothing global is written.
 *
 * Everything around both panels follows what already exists rather than a new
 * convention:
 *
 *   - the lists are built like `pi-subagents`' `SelectorComponent`
 *     (`src/slash/selector.js`): pi-tui primitives, a search field, a bounded
 *     window with an `(n/total)` indicator, `→ ` cursor, `[provider]` badge and
 *     a `✓` on what is currently in effect;
 *   - thinking levels are the ones the effective model actually supports, using
 *     the same rules as `getSupportedThinkingLevels`
 *     (`pi-subagents/src/shared/model-info.js`);
 *   - the inherit rows use the same meaning as that picker's
 *     `Default / inherit session model` and `Default / inherit session thinking`,
 *     and selecting one deletes the key.
 *
 * Pi's loader aliases the host packages for every extension, so importing
 * `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` here is the
 * supported path, not a dependency on a sibling install.
 */

import { join } from "node:path";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, HStack, Input, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type {
  ModuleContext,
  PiRuntimeHost,
  RuntimeContext,
  WorkflowControl,
  WorkflowModule,
} from "../../core/module.ts";
import { fileContext } from "../../core/module.ts";
import { configRoot, readConfig } from "../../core/config.ts";
import { setSessionFlag } from "../../core/trellis.ts";
import {
  collectChildUsage,
  collectSessionUsage,
  emptyUsage,
  formatUsage,
  isZeroUsage,
  topEntries,
  type UsageTotals,
} from "../../core/usage.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const PROJECT_SETTINGS = join(".pi", "settings.json");
const SUBAGENT_KEYS = ["defaultModel", "defaultProvider", "defaultThinking"] as const;
const MAX_VISIBLE = 10;
const INHERIT_MODEL_LABEL = "(默认 / 继承主会话模型)";
const INHERIT_THINKING_LABEL = "(默认 / 继承主会话思考)";

export interface PanelModel {
  provider: string;
  id: string;
  name: string;
  available: boolean;
  /** Present for models from the live registry; used for thinking levels. */
  raw?: any;
}

export interface PanelSnapshot {
  models: PanelModel[];
  sessionModel: string;
  sessionThinking: string;
  subagentModel: string;
  subagentThinking: string;
  /** The model whose thinking levels the subagent tab should offer. */
  subagentEffectiveModel: PanelModel | undefined;
  sessionEffectiveModel: PanelModel | undefined;
  usage: PanelUsage;
}

/** Token accounting, split the way the panel shows it. */
export interface PanelUsage {
  /** This session's main-session models, biggest consumer first. */
  sessionByModel: [string, UsageTotals][];
  sessionTotal: UsageTotals;
  /** Children dispatched by this session, biggest first. */
  childrenByAgent: [string, UsageTotals][];
  childRuns: number;
  childTotal: UsageTotals;
  /** Every child run recorded in this project's artifact directories. */
  projectChildRuns: number;
  projectChildTotal: UsageTotals;
}

export interface PanelPort {
  snapshot(): PanelSnapshot;
  applySessionModel(model: PanelModel): Promise<string>;
  applySessionThinking(level: ThinkingLevelName): string;
  applySubagentModel(model: PanelModel | null): string;
  applySubagentThinking(level: ThinkingLevelName | null): string;
  close(): void;
  requestRender(): void;
}

/** The theme/keybinding surface the panel uses; Pi's own objects satisfy it. */
export interface PanelTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

export interface PanelKeybindings {
  matches?(data: string, action: string): boolean;
}

type Tab = "session" | "subagent";
type Focus = "model" | "thinking";

export interface PanelRow {
  label: string;
  badge?: string;
  detail?: string;
  current: boolean;
  model?: PanelModel | null;
  thinking?: ThinkingLevelName | null;
}

/**
 * Thinking levels the model supports, mirroring `getSupportedThinkingLevels`
 * from pi-subagents so both pickers offer the same set.
 */
export function supportedThinkingLevels(model: PanelModel | undefined): ThinkingLevelName[] {
  const raw = model?.raw;
  if (!raw) return THINKING_LEVELS.filter((level) => level !== "max");
  if (raw.reasoning === false) return ["off"];
  const map = raw.thinkingLevelMap;
  if (!map) return THINKING_LEVELS.filter((level) => level !== "max");
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** The session id Pi exposes on the command context, falling back to env. */
function sessionIdOf(ctx: any, runtime: RuntimeContext): string | null {
  const fromCtx = ctx?.sessionManager?.getSessionId?.();
  if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  return runtime.sessionId;
}

export function modelRows(snapshot: PanelSnapshot, tab: Tab): PanelRow[] {
  const current = tab === "session" ? snapshot.sessionModel : snapshot.subagentModel;
  const models: PanelRow[] = snapshot.models.map((model) => ({
    label: model.id,
    badge: model.available ? model.provider : `${model.provider} 无凭据`,
    detail: model.name,
    current: current === `${model.provider}/${model.id}`,
    model,
  }));
  if (tab === "session") return models;
  return [
    {
      label: INHERIT_MODEL_LABEL,
      detail: "跟随主会话",
      current: snapshot.subagentModel === "",
      model: null,
    },
    ...models,
  ];
}

export function thinkingRows(snapshot: PanelSnapshot, tab: Tab): PanelRow[] {
  const current = tab === "session" ? snapshot.sessionThinking : snapshot.subagentThinking;
  const levels = supportedThinkingLevels(
    tab === "session" ? snapshot.sessionEffectiveModel : snapshot.subagentEffectiveModel,
  );
  const values: ThinkingLevelName[] = [...levels];
  if (current && !values.includes(current as ThinkingLevelName) && current !== "") {
    values.unshift(current as ThinkingLevelName);
  }
  const rows: PanelRow[] = values.map((level) => ({
    label: level,
    current: current === level,
    thinking: level,
  }));
  if (tab === "session") return rows;
  return [
    { label: INHERIT_THINKING_LABEL, detail: "跟随 agent 自身 / 主会话", current: current === "", thinking: null },
    ...rows,
  ];
}

const FALLBACK_KEYS: Record<string, RegExp> = {
  up: /^\x1b(?:\[|O)A$/,
  down: /^\x1b(?:\[|O)B$/,
  confirm: /^[\r\n]$/,
  cancel: /^\x1b$/,
};

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
          "↑↓ 移动 · Tab 切换 模型/思考 列 · ←→ 切换 主会话/子 agent · Enter 应用 · Esc 关闭 · 直接输入可搜索",
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

  /** Rows currently rendered in the focused column, for tests. */
  currentRows(): PanelRow[] {
    return this.activeRows(this.port.snapshot());
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
    const snapshot = this.port.snapshot();
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
    this.refresh();
  }

  handleInput(data: string): void {
    const snapshot = this.port.snapshot();

    if (this.matches(data, "cancel")) {
      this.port.close();
      return;
    }

    // Tab switches which column owns the cursor, from either column.
    if (matchesKey(data, Key.tab)) {
      this.focus = this.focus === "model" ? "thinking" : "model";
      this.query = "";
      this.searchInput.setValue("");
      this.searchInput.focused = this.focus === "model";
      this.refresh();
      return;
    }

    // ←→ switch the scope tab. These must be matched here rather than left to
    // the search field: `Input` treats cursorLeft/cursorRight as its own and
    // would swallow them, which is exactly why the scope tab never changed.
    if (matchesKey(data, Key.right)) {
      this.tab = "subagent";
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.tab = "session";
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

  /** Column heading, highlighted when that column owns the cursor. */
  private heading(label: string, focused: boolean): string {
    const text = `── ${label} `;
    return focused ? this.theme.fg("accent", text) : this.theme.fg("muted", text);
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
    header.addChild(new Text(tabLine, 0, 0));
    header.addChild(
      new Text(
        theme.fg(
          "muted",
          this.tab === "session"
            ? "作用范围：本会话（不写任何配置文件）"
            : `作用范围：本项目（${PROJECT_SETTINGS} → subagents.*）`,
        ),
        0,
        0,
      ),
    );
    header.addChild(
      new Text(
        theme.fg(
          "muted",
          this.tab === "session"
            ? `当前：模型 ${snapshot.sessionModel || "(未设置)"} · 思考 ${snapshot.sessionThinking || "(未设置)"}`
            : `当前：模型 ${snapshot.subagentModel || INHERIT_MODEL_LABEL} · 思考 ${snapshot.subagentThinking || INHERIT_THINKING_LABEL}`,
        ),
        0,
        0,
      ),
    );
    return header;
  }

  /** The model column: search field plus the model list. */
  private modelColumn(snapshot: PanelSnapshot, rows: PanelRow[], cursor: number): Container {
    const theme = this.theme;
    const column = new Container();
    column.addChild(new Text(this.heading("模型", this.focus === "model"), 0, 0));
    column.addChild(this.searchInput);
    if (rows.length === 0) {
      column.addChild(new Text(theme.fg("muted", "  无匹配模型"), 0, 0));
      return column;
    }
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(MAX_VISIBLE / 2), Math.max(0, rows.length - MAX_VISIBLE)),
    );
    const end = Math.min(start + MAX_VISIBLE, rows.length);
    for (let i = start; i < end; i += 1) {
      const row = rows[i]!;
      const selected = i === cursor;
      const badge = row.badge ? ` ${theme.fg("muted", `[${row.badge}]`)}` : "";
      const check = row.current ? theme.fg("success", " ✓") : "";
      const line = selected
        ? `${theme.fg("accent", "→ ")}${theme.fg("accent", row.label)}${badge}${check}`
        : `  ${row.label}${badge}${check}`;
      column.addChild(new Text(line, 0, 0));
    }
    if (start > 0 || end < rows.length) {
      column.addChild(new Text(theme.fg("muted", `  (${cursor + 1}/${rows.length})`), 0, 0));
    }
    return column;
  }

  /** The thinking column: the levels the effective model actually supports. */
  private thinkingColumn(rows: PanelRow[], cursor: number): Container {
    const theme = this.theme;
    const column = new Container();
    column.addChild(new Text(this.heading("思考等级", this.focus === "thinking"), 0, 0));
    column.addChild(new Spacer(1));
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const selected = this.focus === "thinking" && i === cursor;
      const marker = row.current ? theme.fg("success", "● ") : "○ ";
      const label = selected ? theme.fg("accent", row.label) : row.label;
      column.addChild(new Text(`${selected ? theme.fg("accent", "→ ") : "  "}${marker}${label}`, 0, 0));
    }
    return column;
  }

  /** The usage column: who spent what, for the scope the active tab selects. */
  private usageColumn(snapshot: PanelSnapshot): Container {
    const theme = this.theme;
    const column = new Container();
    column.addChild(new Text(this.heading("用量", false), 0, 0));
    column.addChild(new Spacer(1));
    for (const line of this.usageLines(snapshot.usage)) {
      column.addChild(new Text(line, 0, 0));
    }
    return column;
  }

  private updateBody(): void {
    const snapshot = this.port.snapshot();
    const rows = this.activeRows(snapshot);
    const cursor = this.cursor(snapshot);

    this.body.clear();
    this.body.addChild(new Text(this.theme.fg("accent", "pi-Coworkflow · 模型面板"), 0, 0));
    this.body.addChild(this.tabBar(snapshot));
    this.body.addChild(new Spacer(1));
    this.body.addChild(
      new HStack(
        [
          { component: this.modelColumn(snapshot, this.focus === "model" ? rows : modelRows(snapshot, this.tab), this.focus === "model" ? cursor : this.cursorOf(snapshot, "model")), basis: 0, grow: 3, minSize: 24 },
          { component: this.thinkingColumn(thinkingRows(snapshot, this.tab), this.focus === "thinking" ? cursor : this.cursorOf(snapshot, "thinking")), basis: 0, grow: 1, minSize: 12 },
          { component: this.usageColumn(snapshot), basis: 0, grow: 2, minSize: 20 },
        ],
        { gap: 2 },
      ),
    );
    this.statusText.setText(this.status ? this.theme.fg("success", this.status) : "");
  }

  /** Cursor of a column that does not currently own the focus. */
  private cursorOf(snapshot: PanelSnapshot, column: Focus): number {
    const rows = column === "model" ? modelRows(snapshot, this.tab) : thinkingRows(snapshot, this.tab);
    const stored = this.index[`${this.tab}:${column}`];
    if (stored !== undefined) return Math.max(0, Math.min(stored, Math.max(0, rows.length - 1)));
    const current = rows.findIndex((row) => row.current);
    return current >= 0 ? current : 0;
  }

  /**
   * Token consumption, split by who spent it: the main session's models versus
   * the agents this session dispatched. Both halves come from records Pi and
   * pi-subagents already wrote, so the numbers are observed, not estimated.
   * The active tab's half comes first.
   */
  private usageLines(usage: PanelUsage): string[] {
    const theme = this.theme;
    const muted = (text: string) => theme.fg("muted", text);
    const accent = (text: string) => theme.fg("accent", text);
    // The column is narrow, so a model is named by its last path segment; the
    // full `provider/id` is already visible in the model column.
    const shortName = (id: string): string => id.split("/").pop() ?? id;

    const sessionLines: string[] = [];
    if (isZeroUsage(usage.sessionTotal)) {
      sessionLines.push(muted("主会话  本会话暂无消耗"));
    } else {
      sessionLines.push(accent(`主会话  ${formatUsage(usage.sessionTotal)}`));
      for (const [model, totals] of usage.sessionByModel) {
        sessionLines.push(muted(`  ${shortName(model)}  ${formatUsage(totals, { turns: false })}`));
      }
    }

    const childLines: string[] = [];
    if (usage.childRuns === 0) {
      childLines.push(muted("子 agent  本会话无派单"));
    } else {
      childLines.push(accent(`子 agent  ${usage.childRuns} 次派单  ${formatUsage(usage.childTotal)}`));
      for (const [agent, totals] of usage.childrenByAgent) {
        childLines.push(muted(`  ${shortName(agent)}  ${formatUsage(totals, { turns: false })}`));
      }
    }
    if (usage.projectChildRuns > usage.childRuns) {
      childLines.push(
        muted(`本项目累计  ${usage.projectChildRuns} 次派单  ${formatUsage(usage.projectChildTotal)}`),
      );
    }

    const head = this.tab === "session" ? sessionLines : childLines;
    const tail = this.tab === "session" ? childLines : sessionLines;
    return [...head, "", ...tail];
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

  const usage = (cwd: string): PanelUsage => {
    const sessionId = commandCtx?.sessionManager?.getSessionId?.();
    const entries = commandCtx?.sessionManager?.getEntries?.();
    const session = Array.isArray(entries) ? collectSessionUsage(entries) : { byModel: new Map(), total: emptyUsage() };
    const dirs = artifactDirs(cwd);
    const mine = collectChildUsage(dirs, typeof sessionId === "string" ? sessionId : null);
    const project = collectChildUsage(dirs);
    return {
      sessionByModel: topEntries(session.byModel, 3),
      sessionTotal: session.total,
      childrenByAgent: topEntries(mine.byAgent, 3),
      childRuns: mine.runs,
      childTotal: mine.total,
      projectChildRuns: project.runs,
      projectChildTotal: project.total,
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
      usage: usage(
        typeof commandCtx?.cwd === "string" && commandCtx.cwd ? commandCtx.cwd : ctx.root,
      ),
    };
  };

  return {
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
function buildSettingRows(control: WorkflowControl, commandCtx: any): SettingRow[] {
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

function registerSettingsPanel(host: PiRuntimeHost, runtime: RuntimeContext): void {
  host.registerCommand?.(`Coworkflow:settings`, {
    description:
      "Coworkflow 设置面板：模块开关、新会话是否自动加载、worktree 前缀、Trellis 范式对齐；未初始化时可从这里初始化本项目",
    handler: async (_args: string, commandCtx: any) => {
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

/** Register `/Comodels`; idempotent, since a session may activate twice. */
function registerModelPanel(host: PiRuntimeHost, runtime: RuntimeContext): void {
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

export const panelModule: WorkflowModule = {
  id: "panel",
  title: "会话内面板（Coworkflow 设置 / 模型）",
  alwaysActive: true,

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    // Children have no interactive UI and must never open a panel.
    if (runtime.isChild || !host.registerCommand) return;

    registerSettingsPanel(host, runtime);
    registerModelPanel(host, runtime);
  },

  /**
   * `/Comodels` exists whenever Coworkflow is installed in this project, even
   * before the session loads it. Pi's slash-command list is fuzzy-matched, so an
   * unregistered `/Comodels` offers `/model` as the closest match and a user
   * asking for this panel would silently get Pi's own model config instead; an
   * explicit refusal says what to do.
   */
  onSessionActivate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild || !host.registerCommand) return;
    registerModelPanel(host, runtime);
  },
};
