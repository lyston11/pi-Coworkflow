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
  /**
   * The exact reference this row stands for, when it is **not** a model in the live
   * registry.
   *
   * A kind may store a model id the session's registry does not hold (a model the
   * project is not currently scoped to, or a tag such as `ollama/llama3:latest`). Such
   * a value still needs a row of its own — marked current, so the cursor seeds on what
   * the project actually stored — but it must never be written back as if the panel had
   * chosen it, so the row carries the stored string here and the writer refuses it.
   */
  ref?: string;
  /**
   * The exact string this row writes back, when that differs from `provider/id`.
   *
   * The row that stands for a kind's stored pin carries the pin verbatim: pressing
   * `Enter` on it without moving the cursor must write back what was already there, not
   * a normalised form of it — `ollama/llama3:latest` is a model id, and rewriting it to
   * `ollama/llama3` would be a setting the user never made.
   */
  writeRef?: string;
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
   * The project's subagent kinds, in table order, each with its own model page.
   *
   * The page list is computed from this array and nothing else. The array is what
   * `control.agentKinds()` resolves — one entry per kind this package **ships**, with
   * the project's policy applied — so the panel holds no kind list of its own: shipping
   * a kind adds its page with no panel change, and a kind the project declares without
   * an asset behind it gets no page (it is reported by `/Coworkflow:status` instead).
   */
  kinds: PanelKindSnapshot[];
  /**
   * Whether this session can register kinds at all (`agent-kinds` switched on).
   *
   * Off means nothing is registered, so a kind page's write only changes the stored
   * policy. The page says so rather than accepting a write that reads as applied.
   */
  kindsActive: boolean;
  /**
   * 7-day sliding window for the model the cursor is on, and for the model
   * actually in effect, so the table row and the footer agree.
   */
  history: {
    selectedModel: string;
    selected: DailySeries;
    /** Public native cost summary, not attributed to the selected model. */
    costSummary?: string;
    /** Epoch ms this session loaded Coworkflow; usage before it is excluded. */
    since?: number;
  };
}

/**
 * One kind's page payload: its policy as the project stored it, plus the model its
 * thinking levels come from.
 *
 * `model` and `thinking` are the *stored* strings (empty for inherit) rather than a
 * resolved value, because that is what the page writes back: choosing the inherit
 * row clears the key, and anything else would be a setting nobody made.
 */
export interface PanelKindSnapshot {
  /** The kind as the project spells it, e.g. `executor`. */
  kind: string;
  /** How the project names it (`执行者`). */
  label: string;
  /** The registered agent name: `cw-<kind>`. */
  agent: string;
  /** Whether the project has this kind switched on. */
  enabled: boolean;
  /** The model this kind pins (`provider/id`, a bare id, or either with `:level`); `""` for inherit. */
  model: string;
  /** The thinking level this kind pins; `""` for inherit. */
  thinking: string;
  /**
   * The model whose thinking levels this page offers: the kind's own pin resolved
   * against the live registry, else the model it would inherit, else the session's.
   *
   * A pin the registry cannot resolve stays `undefined` here — deliberately **not**
   * the inherited model. Substituting that one would present the inherited model as
   * the kind's own, mark its row as current, and one untouched `Enter` would then
   * write it over the pin the project stored.
   */
  effectiveModel: PanelModel | undefined;
}

/**
 * Which page owns the cursor.
 *
 * `session` and `subagent` are the two scopes that always exist; every further page
 * is one project kind, named by a template literal so a kind the project gains
 * needs no type change here.
 */
export type Tab = "session" | "subagent" | `kind:${string}`;
export type Focus = "model" | "thinking";

/** The page names, in the order they appear: 主会话, 子 agent（默认）, then one per kind. */
export const SESSION_PAGE_LABEL = "主会话";
export const DEFAULT_PAGE_LABEL = "子 agent（默认）";

/** One page of the panel: what Tab cycles through and the tab bar renders. */
export interface PanelPage {
  tab: Tab;
  label: string;
  /** Appended in parentheses when the page is not usable as it stands (a kind that is off). */
  note?: string;
}

/** The tab key for a kind page. */
export function kindTab(kind: string): Tab {
  return `kind:${kind}`;
}

/** The kind a tab names, or `null` for the two scope pages. */
export function kindOfTab(tab: Tab): string | null {
  return tab.startsWith("kind:") ? tab.slice("kind:".length) : null;
}

/**
 * The panel's pages, computed from the snapshot rather than declared.
 *
 * A disabled kind keeps its page and says it is off: its model is still stored, and
 * switching the kind back on must apply what the project already chose instead of
 * looking like a setting that was never made.
 */
export function panelPages(snapshot: PanelSnapshot): PanelPage[] {
  return [
    { tab: "session", label: SESSION_PAGE_LABEL },
    { tab: "subagent", label: DEFAULT_PAGE_LABEL },
    ...snapshot.kinds.map((entry) => ({
      tab: kindTab(entry.kind),
      label: `${entry.label} ${entry.agent}`,
      // A kind that is off keeps its page and says so; with the module off nothing is
      // registered at all, which is a different fact and reads differently.
      ...(entry.enabled && snapshot.kindsActive
        ? {}
        : { note: snapshot.kindsActive ? "已关闭" : "本会话未启用" }),
    })),
  ];
}

/** The page after `tab`, wrapping — what Tab does, whatever the page count is. */
export function nextTab(snapshot: PanelSnapshot, tab: Tab): Tab {
  const pages = panelPages(snapshot);
  const index = pages.findIndex((page) => page.tab === tab);
  return pages[(index + 1) % pages.length]?.tab ?? "session";
}

/**
 * The page that still exists for `tab`.
 *
 * A kind page whose kind disappeared (its config block was removed between opens, or
 * the panel was opened against a different project) must not leave the cursor on a
 * page with no rows: falling back to the session page is what keeps the panel usable
 * instead of silently empty.
 */
export function resolveTab(snapshot: PanelSnapshot, tab: Tab): Tab {
  return panelPages(snapshot).some((page) => page.tab === tab) ? tab : "session";
}

/** The kind a tab names, when that kind still has a page. */
export function kindForTab(snapshot: PanelSnapshot, tab: Tab): PanelKindSnapshot | undefined {
  const kind = kindOfTab(tab);
  return kind === null ? undefined : snapshot.kinds.find((entry) => entry.kind === kind);
}

/** What an inheriting page falls back to, named so the row is actionable. */
export function inheritModelLabel(snapshot: PanelSnapshot): string {
  return snapshot.subagentModel ? `子 agent 默认模型 ${snapshot.subagentModel}` : "主会话当前模型";
}

/** Whether a kind pins its model or inherits, in the words the page uses. */
export function kindStateLabel(snapshot: PanelSnapshot, entry: PanelKindSnapshot): string {
  if (!entry.model) return `继承（跟随 ${inheritModelLabel(snapshot)}）`;
  // A pin the registry does not hold is named as such instead of being dressed up as
  // the model the kind would inherit: the two are different settings.
  return entry.effectiveModel
    ? `固定 ${entry.model}`
    : `固定 ${entry.model}（不在当前模型注册表中）`;
}

/**
 * Whether this session registers kinds at all, in the words a page uses.
 *
 * Empty when it does, so a page only mentions the layer when there is something to
 * say — with `agent-kinds` off, a kind page's write changes the config and registers
 * nothing, and the page must not look like it applied a dispatch-time setting.
 */
export function kindsLayerNote(snapshot: PanelSnapshot): string {
  return snapshot.kindsActive ? "" : "本会话未启用 agent-kinds，未注册任何 kind（写入只改配置）";
}

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

/**
 * A stored reference without its trailing thinking level.
 *
 * Only a suffix that names a level this package knows is stripped, which is the rule
 * upstream's `splitKnownThinkingSuffix` follows. Stripping any `:word` would cut a
 * real part of a model id — `ollama/llama3:latest`, `openrouter/x:free` — and the pin
 * would then resolve to nothing (or, worse, to a different model with that bare id).
 */
export function stripThinkingSuffix(ref: string): string {
  const colon = ref.lastIndexOf(":");
  if (colon <= 0) return ref;
  const suffix = ref.slice(colon + 1);
  return (THINKING_LEVELS as readonly string[]).includes(suffix) ? ref.slice(0, colon) : ref;
}

/**
 * Resolve a stored model reference to a model in the live registry.
 *
 * A stored value may be `provider/id`, a bare id, or either with a trailing
 * `:level` — the same three forms upstream accepts on a runtime agent definition,
 * so the panel has to understand them or a kind that pins `claude-sonnet-4` would
 * appear to have no model at all. Resolution follows upstream's `findModelInfo`: an
 * exact `provider/id`, then an id match preferring the given provider, then a match
 * only when exactly one model has that id. **Ambiguous is unresolved**, not "the first
 * match": two providers offering the same id means the panel cannot say which model
 * the kind runs on, and guessing would show the wrong thinking levels — or write the
 * wrong provider's model back.
 */
export function modelForRef(
  models: readonly PanelModel[],
  ref: string,
  preferredProvider = "",
): PanelModel | undefined {
  if (!ref) return undefined;
  const bare = stripThinkingSuffix(ref);
  const exact = models.find((model) => `${model.provider}/${model.id}` === bare);
  if (exact) return exact;
  const matches = models.filter((model) => model.id === bare);
  if (matches.length === 0) return undefined;
  if (preferredProvider) {
    const preferred = matches.find((model) => model.provider === preferredProvider);
    if (preferred) return preferred;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** The reference a row writes back for a model (`provider/id`, or the stored pin). */
export function modelRefOf(model: PanelModel): string {
  return model.writeRef ?? model.ref ?? `${model.provider}/${model.id}`;
}

/**
 * The registry key (`provider/id`) of a row's model, or `""` when the row stands for a
 * stored reference the registry does not hold — usage cannot be attributed to a model
 * that is not in it, and a made-up key would chart somebody else's tokens.
 */
export function registryKeyOf(model: PanelModel | undefined): string {
  return model === undefined || model.ref !== undefined ? "" : `${model.provider}/${model.id}`;
}

export function modelRows(snapshot: PanelSnapshot, tab: Tab): PanelRow[] {
  const kind = kindForTab(snapshot, tab);
  const stored =
    tab === "session" ? snapshot.sessionModel
    : tab === "subagent" ? snapshot.subagentModel
    : kind?.model ?? "";
  // A kind may pin a bare id or a `:level` form, which no row is keyed on, so the row
  // that is in effect is the *resolved* pin. It is derived from the pin itself and
  // never from the inherited model: `effectiveModel` is undefined for a pin the
  // registry does not hold, and substituting the inherited model there would mark the
  // inherited row as the kind's own.
  const pinned = kind?.model && kind.effectiveModel ? kind.effectiveModel : undefined;
  const rows: PanelRow[] = snapshot.models.map((model) => {
    const key = `${model.provider}/${model.id}`;
    const isPin = pinned !== undefined && key === `${pinned.provider}/${pinned.id}`;
    return {
      label: model.name || model.id,
      badge: `[${model.provider}]`,
      detail: model.available ? "" : "(未配置凭据)",
      // Exactly one row is current on every page: the stored value, or — for a kind —
      // the model that stored pin resolves to (a bare id or a `:level` form is keyed on
      // no row). Marking both the stored value *and* the resolved model was what let
      // the cursor seed on the wrong one, and one untouched `Enter` then wrote a model
      // nobody chose.
      current: key === stored || isPin,
      // The pin's own row writes the pin back verbatim: `ollama/llama3:latest` must
      // survive an `Enter` that never moved.
      model: isPin && kind ? { ...model, writeRef: kind.model } : model,
    };
  });
  if (tab === "session") return rows;
  if (kind?.model && pinned === undefined) {
    // The pin is not in the registry. It keeps a row of its own, marked current, so the
    // cursor seeds on the value the project stored: without it the cursor lands on the
    // inherit row and one `Enter` silently clears a model the user never touched.
    rows.unshift({
      label: `${kind.model}（不在模型注册表）`,
      detail: "不在当前模型注册表中，无法写入；要清除请选「继承」那一行",
      current: true,
      model: { provider: "", id: kind.model, name: kind.model, available: false, ref: kind.model },
    });
  }
  const detail =
    tab === "subagent"
      ? "跟随主会话当前模型"
      : `跟随 ${inheritModelLabel(snapshot)}；选中即清除该 kind 的固定模型`;
  return [{ label: INHERIT_MODEL_LABEL, detail, current: stored === "", model: null }, ...rows];
}

export function thinkingRows(snapshot: PanelSnapshot, tab: Tab): PanelRow[] {
  const kind = kindForTab(snapshot, tab);
  // Typed as the level union, not a bare string: the stored value is validated on read
  // (`isThinkingLevel`), so the row this builds carries a real level.
  const current: ThinkingLevelName | "" =
    tab === "session" ? (snapshot.sessionThinking as ThinkingLevelName | "")
    : tab === "subagent" ? (snapshot.subagentThinking as ThinkingLevelName | "")
    : (kind?.thinking as ThinkingLevelName | undefined) ?? "";
  // The levels a page offers belong to the model that page's children would run on:
  // the kind's own pin, else the subagent default it inherits, else the session's —
  // the default page's rule, applied per kind. A pin the registry does not hold leaves
  // `effectiveModel` undefined, and the page then offers the generic set rather than
  // the inherited model's levels, which would misdescribe what the kind pins.
  const model =
    tab === "session" ? snapshot.sessionEffectiveModel
    : tab === "subagent" ? snapshot.subagentEffectiveModel
    : kind?.effectiveModel;
  const rows: PanelRow[] = supportedThinkingLevels(model).map((level) => ({
    label: level,
    current: level === current,
    thinking: level,
  }));
  if (tab === "session") return rows;
  if (current !== "" && !rows.some((row) => row.current)) {
    // The stored level is not one this page can offer — the kind's model changed, or the
    // pin is not in the registry so only the generic set is offered. It keeps a row of its
    // own, marked current, for the same reason the model column does: without it no row is
    // current, the cursor seeds on the inherit row, and one `Enter` with no movement
    // deletes a level the user never touched. Selecting this row writes the same value
    // back, so the page is idempotent under an untouched `Enter`.
    rows.unshift({
      label: `${current}（当前等级）`,
      detail: "当前固定值；本页的模型不提供该等级，选中后仍是它",
      current: true,
      thinking: current,
    });
  }
  const detail =
    tab === "subagent" ? "跟随 agent 自身 / 主会话" : "跟随该 kind 的模型；选中即清除该 kind 的固定等级";
  return [{ label: INHERIT_THINKING_LABEL, detail, current: current === "", thinking: null }, ...rows];
}
