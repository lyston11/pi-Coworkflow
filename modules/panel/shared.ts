/**
 * The types and pure helpers the two panels share.
 *
 * A panel is a view: it renders rows and reports what the user chose. Everything
 * that decides *what* a row means — which thinking levels a model supports, what
 * the current selection is — is a pure function over a snapshot, so it can be
 * tested without a TUI and reused by both panels.
 *
 * The panels themselves are split by audience, because they share nothing but
 * these types:
 *
 *   `settings.ts`  the project's configuration (`/Coworkflow:settings`)
 *   `models.ts`    the model/thinking/usage table (`/Comodels`)
 *   `index.ts`     the module: which command is registered when
 */

import { join } from "node:path";
import type { DailySeries } from "../../core/usage.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const PROJECT_SETTINGS = join(".pi", "settings.json");
export const SUBAGENT_KEYS = ["defaultModel", "defaultProvider", "defaultThinking"] as const;
export const MAX_VISIBLE = 10;
/** Sliding window for the usage bar chart, in local days. */
export const HISTORY_DAYS = 7;
export const INHERIT_MODEL_LABEL = "(默认 / 继承主会话模型)";
export const INHERIT_THINKING_LABEL = "(默认 / 继承主会话思考)";

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
  /**
   * 7-day sliding window for the model the cursor is on, and for the model
   * actually in effect, so the table row and the footer agree.
   */
  history: {
    selectedModel: string;
    selected: DailySeries;
    /** Epoch ms this session loaded Coworkflow; usage before it is excluded. */
    since?: number;
  };
}

export type Tab = "session" | "subagent";
export type Focus = "model" | "thinking";

export interface PanelRow {
  label: string;
  badge?: string;
  detail?: string;
  current: boolean;
  model?: PanelModel | null;
  thinking?: ThinkingLevelName | null;
}

/** The theme/keybinding surface the panels use; Pi's own objects satisfy it. */
export interface PanelTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

export interface PanelKeybindings {
  matches?(data: string, action: string): boolean;
}

export const FALLBACK_KEYS: Record<string, RegExp> = {
  up: /^\x1b(?:\[|O)A$/,
  down: /^\x1b(?:\[|O)B$/,
  confirm: /^[\r\n]$/,
  cancel: /^\x1b$/,
};

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

export function modelRows(snapshot: PanelSnapshot, tab: Tab): PanelRow[] {
  const current = tab === "session" ? snapshot.sessionModel : snapshot.subagentModel;
  const rows: PanelRow[] = snapshot.models.map((model) => {
    const key = `${model.provider}/${model.id}`;
    return {
      label: model.name || model.id,
      badge: `[${model.provider}]`,
      detail: model.available ? "" : "(未配置凭据)",
      current: key === current,
      model,
    };
  });
  if (tab === "session") return rows;
  return [
    { label: INHERIT_MODEL_LABEL, detail: "跟随主会话当前模型", current: current === "", model: null },
    ...rows,
  ];
}

export function thinkingRows(snapshot: PanelSnapshot, tab: Tab): PanelRow[] {
  const current = tab === "session" ? snapshot.sessionThinking : snapshot.subagentThinking;
  const model = tab === "session" ? snapshot.sessionEffectiveModel : snapshot.subagentEffectiveModel;
  const rows: PanelRow[] = supportedThinkingLevels(model).map((level) => ({
    label: level,
    current: level === current,
    thinking: level,
  }));
  if (tab === "session") return rows;
  return [
    { label: INHERIT_THINKING_LABEL, detail: "跟随 agent 自身 / 主会话", current: current === "", thinking: null },
    ...rows,
  ];
}
