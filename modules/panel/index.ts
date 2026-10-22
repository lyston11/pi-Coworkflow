/**
 * Module: the session panels.
 *
 * Two panels with two audiences, so they live in two files and this one only
 * decides when each exists:
 *
 *   `settings.ts`  `/Coworkflow:settings` — module switches, whether a new session
 *                  loads the layer by itself, the worktree prefix, Trellis
 *                  paradigm alignment. Always available: it is how a project
 *                  gets configured, and in an uninitialized project it offers to
 *                  initialize it.
 *   `models.ts`    `/Comodels` — the session's model and thinking level, the
 *                  project's defaults for dispatched children, one page per kind,
 *                  and token usage. Only once this session loaded Coworkflow.
 *
 * `/Coworkflow:start`, or the project's `autoEnable`, is what loads the layer.
 * Before that a session is plain Pi: native `/model`, the user's own subagent
 * configuration, no Trellis injection, no Coworkflow panel.
 *
 * Model control is split by scope: the session page applies through
 * `pi.setModel` / `pi.setThinkingLevel` (Pi documents those as session-scoped,
 * never written to a settings file), the subagent page writes the *project's*
 * `.pi/settings.json` (`subagents.defaultModel` / `defaultProvider` /
 * `defaultThinking`), which pi-subagents resolves with project settings taking
 * precedence over the user's, and each further page writes one kind's
 * `agentKinds.<kind>.model` / `.thinking` through `setAgentKind`, which persists
 * the config and re-registers that agent. Nothing global is written.
 *
 * The page list is computed from the project's kinds, never declared: it is exactly
 * what `control.agentKinds()` resolves, which is one entry per kind this package
 * *ships* with the project's policy applied. Shipping a new kind adds its page with
 * no panel change; a kind the project declares without an asset behind it gets no page
 * (there is no agent behind it) and is reported by `/Coworkflow:status` instead. The
 * model precedence is the one the documentation states — kind model →
 * `subagents.defaultModel` → Pi's default.
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

export { THINKING_LEVELS, supportedThinkingLevels, modelRows, thinkingRows } from "./shared.ts";
export {
  DEFAULT_PAGE_LABEL,
  SESSION_PAGE_LABEL,
  kindForTab,
  kindStateLabel,
  kindTab,
  kindsLayerNote,
  modelForRef,
  modelRefOf,
  nextTab,
  panelPages,
  registryKeyOf,
  resolveTab,
  stripThinkingSuffix,
} from "./shared.ts";
export type {
  PanelKindSnapshot,
  PanelModel,
  PanelPage,
  PanelRow,
  PanelSnapshot,
  PanelTheme,
  PanelKeybindings,
  Tab,
  ThinkingLevelName,
} from "./shared.ts";

import type { PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { registerModelPanel } from "./models.ts";
import { registerSettingsPanel } from "./settings.ts";

export const panelModule: WorkflowModule = {
  id: "panel",
  title: "会话内面板（Coworkflow 设置 / 模型）",
  alwaysActive: true,

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    // Children have no interactive UI and must never open a panel.
    if (runtime.isChild || !host.registerCommand) return;
    registerSettingsPanel(host, runtime, () => runtime);
    registerModelPanel(host, runtime);
  },

  /**
   * `/Comodels` exists whenever Coworkflow is installed in this project, even
   * before the session loads it. Pi's slash-command list is fuzzy-matched, so an
   * unregistered `/Comodels` offers `/model` as the closest match and a user
   * asking for this panel would silently get Pi's own model configuration; the
   * command therefore registers early and refuses with a reason instead.
   */
  onSessionActivate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild || !host.registerCommand) return;
    registerModelPanel(host, runtime);
  },

};
