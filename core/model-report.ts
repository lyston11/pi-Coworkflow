/**
 * Which model a subagent actually runs on, and whether the project's choice survived.
 *
 * This exists because it did not, silently. A project declared
 * `subagents.defaultModel: "cline-pass/deepseek-v4.1-flash-1017"`; the children ran on the
 * *parent's* model instead, four of them failed with a connection error without executing a
 * single command, and nothing in this package said so. The declared value never resolved — a
 * provider prefix that does not exist in the registry simply falls back, which is
 * indistinguishable from "the project never chose anything" unless someone asks.
 *
 * So the report states three different things separately, because collapsing them is how a wrong
 * answer gets published:
 *
 *   - **declared** — what the settings file says, and which file;
 *   - **effective** — what a child will actually use, after the fallback;
 *   - **verified** — whether the declared value was found in the model registry. A host that
 *     cannot answer says so; it never becomes "not found".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelRef {
  provider: string;
  id: string;
}

/** One model the host knows about. */
export interface AvailableModel {
  provider: string;
  id: string;
  /** Whether credentials for its provider are configured. Absent when the host cannot tell. */
  authenticated?: boolean;
}

export type DeclaredModelSource = string;

export interface DeclaredModel {
  /** The raw string from the settings file. */
  raw: string;
  /** Which settings file it came from. */
  source: DeclaredModelSource;
  /** The resolved provider, when the string could be split into one. */
  provider?: string;
  /** The resolved model id. */
  id?: string;
  /** Why the string could not be split, when it could not. */
  malformed?: string;
}

/**
 * Split a declared default into provider and id.
 *
 * `provider/model` is the fully-qualified form Pi accepts. A bare id is legal too, and then the
 * provider is the separate `defaultProvider` setting — the two spellings are not interchangeable,
 * and a provider prefix that differs from the real provider name (`clinepass` vs `cline-pass`) is
 * exactly the mistake that should be caught here rather than at the provider.
 */
export function parseDeclaredModel(defaultModel: string, defaultProvider?: string): Pick<DeclaredModel, "provider" | "id" | "malformed"> {
  const raw = defaultModel.trim();
  if (raw === "") return { malformed: "defaultModel 是空字符串" };
  const slash = raw.indexOf("/");
  if (slash < 0) {
    if (defaultProvider === undefined || defaultProvider.trim() === "") {
      return { id: raw, malformed: `裸模型 id "${raw}" 没有配 defaultProvider，无法确定 provider` };
    }
    return { provider: defaultProvider.trim(), id: raw };
  }
  const provider = raw.slice(0, slash).trim();
  const id = raw.slice(slash + 1).trim();
  if (provider === "" || id === "") return { malformed: `"${raw}" 的 provider 或模型 id 为空` };
  // A second slash means the id itself contains one; that is legal, so only the first splits.
  return { provider, id };
}

export type Verification = "resolved" | "unresolved" | "unverifiable" | "unauthenticated";

export interface ModelCheck {
  declared: DeclaredModel | null;
  verification: Verification;
  /** The model a child will actually run on when the declaration does not apply. */
  effective: ModelRef | null;
  /** Closest available ids, for an unresolved declaration. */
  suggestions: string[];
}

/**
 * Check a project's declared subagent model against what the host actually has.
 *
 * `available` being absent is not evidence of anything: a host that cannot enumerate models cannot
 * say a model is missing either. That distinction is the whole reason this returns four states.
 */
export function checkSubagentModel(options: {
  declared: DeclaredModel | null;
  available: readonly AvailableModel[] | undefined;
  sessionModel: ModelRef | null;
}): ModelCheck {
  const { declared, available, sessionModel } = options;
  if (declared === null) {
    return { declared: null, verification: "unverifiable", effective: sessionModel, suggestions: [] };
  }
  if (declared.malformed !== undefined || declared.provider === undefined || declared.id === undefined) {
    return { declared, verification: "unresolved", effective: sessionModel, suggestions: [] };
  }
  if (available === undefined) {
    return { declared, verification: "unverifiable", effective: sessionModel, suggestions: [] };
  }
  const exact = available.find(
    (entry) => entry.provider === declared.provider && entry.id === declared.id,
  );
  if (exact !== undefined) {
    // Present but unusable is its own answer: a child would start and fail on auth, which looks
    // exactly like "the model does not exist" to whoever reads the log afterwards.
    if (exact.authenticated === false) {
      return { declared, verification: "unauthenticated", effective: sessionModel, suggestions: [] };
    }
    // A resolved declaration is the effective model: the child runs on it, not on the parent's.
    return {
      declared,
      verification: "resolved",
      effective: { provider: declared.provider, id: declared.id },
      suggestions: [],
    };
  }
  const tail = declared.id.split("/").pop() ?? declared.id;
  const suggestions = available
    .filter((entry) => entry.id.includes(tail) || tail.includes(entry.id))
    .slice(0, 3)
    .map((entry) => `${entry.provider}/${entry.id}`);
  return { declared, verification: "unresolved", effective: sessionModel, suggestions };
}

/**
 * Read the project's declared subagent model, project first, then the user's settings.
 *
 * Project beats user: a project that took the trouble to say which model its children use should
 * not be overruled by a global default. The source string is returned so the report can name it.
 */
export function readDeclaredSubagentModel(
  root: string | null,
  options: { userSettings?: string | null } = {},
): DeclaredModel | null {
  const candidates: { path: string; text: string | null }[] = [];
  if (root !== null) {
    candidates.push({ path: join(root, ".pi", "settings.json"), text: readText(join(root, ".pi", "settings.json")) });
  }
  if (options.userSettings !== undefined) {
    candidates.push({ path: options.userSettings ?? "", text: options.userSettings === null ? null : readText(options.userSettings) });
  }
  for (const candidate of candidates) {
    if (candidate.text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.text);
    } catch {
      continue;
    }
    const block = parsed !== null && typeof parsed === "object" ? (parsed as { subagents?: unknown }).subagents : undefined;
    if (block === null || typeof block !== "object") continue;
    const defaultModel = (block as { defaultModel?: unknown }).defaultModel;
    if (typeof defaultModel !== "string" || defaultModel.trim() === "") continue;
    const defaultProvider = (block as { defaultProvider?: unknown }).defaultProvider;
    return {
      raw: defaultModel,
      source: candidate.path,
      ...parseDeclaredModel(defaultModel, typeof defaultProvider === "string" ? defaultProvider : undefined),
    };
  }
  return null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

const ref = (model: ModelRef | null): string =>
  model === null ? "主会话的模型" : `${model.provider}/${model.id}`;

/**
 * The line `/Coworkflow:status` renders for the subagent model.
 *
 * Every branch names its evidence, because "which model will my children run on" is a question a
 * wrong answer is worse than no answer for — the whole point of the fallback being silent was that
 * nobody could tell.
 */
export function formatSubagentModelLine(check: ModelCheck): string {
  const { declared, verification, effective, suggestions } = check;
  if (declared === null) {
    return `子 agent 模型：未声明，跟随主会话（${ref(effective)}）`;
  }
  const who = `${declared.provider ?? "?"}/${declared.id ?? declared.raw}`;
  switch (verification) {
    case "resolved":
      return `子 agent 模型：${who}（声明于 ${declared.source}，已在模型注册表里找到且凭据可用）`;
    case "unauthenticated":
      return `子 agent 模型：${who} 在模型注册表里，但该 provider 没有可用凭据——子 agent 起来后会在调用时失败，看起来像模型不存在`;
    case "unverifiable":
      return `子 agent 模型：声明了 ${who}（来自 ${declared.source}），但宿主没有提供模型注册表，无法确认它是否解析得到；解析不到时子 agent 会静默回退到主会话模型（${ref(effective)}）`;
    case "unresolved": {
      const why = declared.malformed ?? "在模型注册表里找不到这个 provider/model";
      const hint = suggestions.length > 0 ? `；注册表里相近的有：${suggestions.join("、")}` : "";
      return `子 agent 模型：声明的 ${who} 解析不到（${why}）——子 agent 会静默回退到主会话模型（${ref(effective)}），本项目等于没配${hint}`;
    }
  }
}
