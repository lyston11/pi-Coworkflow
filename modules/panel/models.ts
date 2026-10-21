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
 * The usage column consumes cached public cost and Pi history (`core/usage.ts`).
 * Model/day attribution uses only session records, including child sessionFile
 * pointers supplied by native cost. The chart keeps its since-enable window.
 */

import { join } from "node:path";
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
import { readConfigAt } from "../../core/config.ts";
import { setSessionFlag } from "../../core/trellis.ts";
import {
  collectUsageHistory,
  formatNativeCost,
  formatTokens,
  refreshUsage,
  usageSnapshot,
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

function createPort(
  ctx: ModuleContext,
  host: PiRuntimeHost,
  commandCtx: any,
  runtime: RuntimeContext,
  tui: { requestRender?(): void },
  done: () => void,
): PanelPort {
  // Pushed by the panel before each snapshot, so `history` can resolve the
  // model under the cursor rather than only the one in effect.
  let cursorModel = "";
  const selectedModel = (): string => cursorModel;

  const findModel = (provider: string, id: string): PanelModel | undefined =>
    panelModels(commandCtx).find((model) => model.provider === provider && model.id === id);

  // Open/action-time settings reads; a render only projects these values.
  let settings = subagentSettings(ctx);
  const history = () => {
    const observation = usageSnapshot(host, runtime);
    return {
      selectedModel: selectedModel(),
      selected: selectedModel() ? collectUsageHistory(observation, selectedModel(), HISTORY_DAYS)
        : { days: [], total: 0, peak: 0 },
      costSummary: formatNativeCost(observation.cost),
      ...(observation.since !== undefined ? { since: observation.since } : {}),
    };
  };

  const snapshot = (): PanelSnapshot => {
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
      history: history(),
    };
  };

  return {
    setCursorContext(_tab: Tab, model: string) {
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
        settings = subagentSettings(ctx);
        return "子 agent 模型 → 继承主会话";
      }
      writeSubagentSetting(ctx, "defaultModel", model.id);
      writeSubagentSetting(ctx, "defaultProvider", model.provider);
      settings = subagentSettings(ctx);
      return `子 agent 模型 → ${model.provider}/${model.id}（本项目）`;
    },
    applySubagentThinking(level: ThinkingLevelName | null): string {
      writeSubagentSetting(ctx, "defaultThinking", level);
      settings = subagentSettings(ctx);
      return level === null ? "子 agent 思考等级 → 默认" : `子 agent 思考等级 → ${level}（本项目）`;
    },
    close: done,
    requestRender: () => tui?.requestRender?.(),
  };
}

/** Register `/Comodels`; idempotent, since a session may activate twice. */
export function registerModelPanel(host: PiRuntimeHost, runtime: RuntimeContext): void {
  const registered = modelPanelRegistered.get(host);
  if (registered) { registered.runtime = runtime; return; }
  const registration = { runtime };
  modelPanelRegistered.set(host, registration);

  const open = async (commandCtx: any): Promise<void> => {
    const runtime = registration.runtime;
    // The switch may have been flipped a moment ago (`/Coworkflow:start` in this
    // session, or a settings write that re-stamps it), so re-read before refusing.
    runtime.refresh();
    // Registered once the session loads Coworkflow; if the session then runs
    // `/Coworkflow:start off`, the command stays but refuses, so a stopped
    // session is plain Pi again.
    if (!runtime.enabled || !runtime.control.moduleEnabled("panel")) {
      // `/reload` re-loads extensions but not the session switch, so "not loaded"
      // here is expected rather than a broken install. Say which it is.
      // Through the runtime resolver: the panel re-renders often, and this must
      // not spawn `git` per render.
      const initialized = readConfigAt(runtime.configRoots, runtime.cwd) !== null;
      const message = !initialized
        ? "本项目未初始化：先运行 /Coworkflow:init"
        : !runtime.control.moduleEnabled("panel") ? "本项目 panel 模块已关闭"
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
    const epoch = runtime.sessionEpoch;
    await refreshUsage(host, runtime, commandCtx);
    if (epoch !== runtime.sessionEpoch || registration.runtime !== runtime || !runtime.enabled || !runtime.control.moduleEnabled("panel")) return;
    const cwd = typeof commandCtx?.cwd === "string" && commandCtx.cwd ? commandCtx.cwd : runtime.cwd;
    const context = fileContext(cwd);
    setPanelContext(context.root, sessionIdOf(commandCtx, runtime));

    // Loaded here, not at the top of the file: the renderer is optional, the command
    // is not. A host without these exports gets a refused panel, not a dead extension.
    type PanelCtor = new (port: PanelPort, theme: PanelTheme, tui: any, kb?: PanelKeybindings) => unknown;
    const loaded = await import("./models-panel.ts").catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    const Ctor = loaded instanceof Error ? undefined : (loaded.ModelPanel as PanelCtor | undefined);
    if (typeof Ctor !== "function") {
      const reason = loaded instanceof Error ? loaded.message : "导出里没有 ModelPanel";
      const text = `面板不可用：${reason}`;
      if (host.sendMessage) host.sendMessage({ customType: "pi-Coworkflow", content: text, display: true });
      else console.error(text);
      return;
    }
    await commandCtx.ui.custom(
      (tui: any, theme: PanelTheme, keybindings: PanelKeybindings, done: (value: unknown) => void) => {
        const port = createPort(context, host, commandCtx, runtime, tui, () => done(undefined));
        return new Ctor(port, theme, tui, keybindings) as any;
      },
    );
  };

  host.registerCommand?.("Comodels", {
    description:
      "模型面板：主会话（本会话）与子 agent（本项目）的模型、思考等级与 token 用量，复用 /model 的模型列表",
    handler: (_args: string, commandCtx: any) => open(commandCtx),
  });
}

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

const modelPanelRegistered = new WeakMap<object, { runtime: RuntimeContext }>();
