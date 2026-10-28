/**
 * Project-defined kinds: the port that makes the kind set a project's decision.
 *
 * A file per kind in `.pi/Coworkflow/agents/<kind>.md` — frontmatter declares what the
 * kind *is*, the body is the system prompt its children receive. The shape matches the
 * owner's own `.pi/agents/*.md`, so a definition can be written or adapted by hand.
 *
 * Three rules shape this module, all of them learned from this package's own failures:
 *
 *   - **A bad file fails one kind, never the layer.** Every field is validated here and
 *     a failure is returned as data with a reason, so the other kinds keep working and
 *     the report can say what is wrong. A directory that cannot be read is "no
 *     definitions", not an error.
 *   - **Unknown frontmatter keys are refused.** A typo that silently does nothing is
 *     worse than a refusal, because the user believes they configured something.
 *   - **Nothing is forwarded unvalidated.** Upstream refuses a launch on an unusable
 *     model, so passing a typo through would take the kind down and surface as
 *     "dispatch refused" instead of "that value is wrong".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_KIND_MODEL_LENGTH,
  isKindModel,
  isThinkingLevel,
  type AgentKindConfig,
} from "../../core/config.ts";
import type { SubagentRole } from "../../core/trellis.ts";

/** Where a project's kind definitions live, relative to the configuration root. */
export const DEFINITIONS_REL = join(".pi", "Coworkflow", "agents");

/** Bounded reads: a definitions directory is a handful of small files. */
export const MAX_DEFINITION_FILES = 64;
export const MAX_DEFINITION_BYTES = 32 * 1024;
const MAX_LABEL_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PROMPT_LENGTH = 20_000;

const KIND_ID = /^[a-z0-9][a-z0-9-]*$/;
const AGENT_NAME = /^cw-[a-z0-9][a-z0-9-]*$/;
const ROLES: readonly SubagentRole[] = ["implement", "check", "research"];

/** The keys a definition may declare. Anything else is refused by name. */
const KEYS = ["label", "agent", "role", "context", "description", "model", "thinking", "maxConcurrent", "enabled"] as const;

/** One parsed, validated project definition. */
export interface KindDefinitionFile {
  /** The kind id, from the file name. */
  kind: string;
  /** The agent name this kind registers; absent means `cw-<kind>`. */
  agent?: string;
  label?: string;
  /** `none` means "not a Trellis role": no role context is injected for its children. */
  role?: SubagentRole | "none";
  /** role (default) follows the role; task adds task material for research. */
  context?: "role" | "task";
  description?: string;
  /** Defaults only: the project config wins over these. */
  model?: string;
  thinking?: string;
  maxConcurrent?: number;
  enabled?: boolean;
  /** The system prompt body, always present: a definition with no prompt is refused. */
  prompt: string;
}

export interface DefinitionRead {
  /** Usable definitions, by kind id. */
  definitions: Map<string, KindDefinitionFile>;
  /** Files that could not be used, with the reason the user needs to see. */
  failures: { kind: string; reason: string }[];
}

export function definitionsDir(root: string): string {
  return join(root, DEFINITIONS_REL);
}

/**
 * Read every definition for this project.
 *
 * Never throws: an unreadable directory or file is reported as a failure for that kind,
 * and the caller keeps whatever it had. This runs in the child process too (role
 * resolution needs it), so it stays a bounded directory listing plus small reads.
 */
export function readKindDefinitions(root: string | null): DefinitionRead {
  const definitions = new Map<string, KindDefinitionFile>();
  const failures: { kind: string; reason: string }[] = [];
  if (root === null) return { definitions, failures };
  const dir = definitionsDir(root);
  let names: string[];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { definitions, failures };
    names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    // A directory we cannot list is "no definitions", not a broken layer.
    return { definitions, failures };
  }
  if (names.length > MAX_DEFINITION_FILES) {
    failures.push({
      kind: "(目录)",
      reason: `${DEFINITIONS_REL} 里的定义文件超过 ${MAX_DEFINITION_FILES} 个；多余的没有被读取`,
    });
    names = names.slice(0, MAX_DEFINITION_FILES);
  }
  for (const name of names) {
    const kind = name.slice(0, -".md".length);
    if (!KIND_ID.test(kind)) {
      failures.push({ kind, reason: `kind 名必须是 [a-z0-9-]：${name}` });
      continue;
    }
    const path = join(dir, name);
    let raw: string;
    try {
      if (!statSync(path).isFile()) {
        failures.push({ kind, reason: "不是普通文件" });
        continue;
      }
      if (statSync(path).size > MAX_DEFINITION_BYTES) {
        failures.push({ kind, reason: `文件超过 ${MAX_DEFINITION_BYTES} 字节；没有读取` });
        continue;
      }
      raw = readFileSync(path, "utf-8");
    } catch (error) {
      failures.push({ kind, reason: `无法读取：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const parsed = parseDefinition(kind, raw);
    if ("reason" in parsed) failures.push({ kind, reason: parsed.reason });
    else definitions.set(kind, parsed.definition);
  }
  return { definitions, failures };
}

/** Split `---` frontmatter from the body. Exported for the tests that drive it directly. */
export function splitDefinition(raw: string): { front: string; body: string } | { reason: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { reason: "缺少 frontmatter（文件必须以 --- 开头）" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { reason: "frontmatter 没有结束的 ---" };
  const afterEnd = text.indexOf("\n", end + 1);
  return {
    front: text.slice(text.indexOf("\n") + 1, end),
    body: afterEnd === -1 ? "" : text.slice(afterEnd + 1),
  };
}

/**
 * The frontmatter subset: `key: value`, `#` comments, optional surrounding quotes.
 *
 * Deliberately not a YAML dependency: the format is a flat map of short scalars, and a
 * real parser would accept far more than this port documents, which is how a definition
 * ends up relying on something the next reader cannot reproduce.
 */
export function parseFrontmatter(front: string): Record<string, string> | { reason: string } {
  const out: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at <= 0) return { reason: `无法解析的 frontmatter 行：${trimmed}` };
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === "" || value === "") return { reason: `frontmatter 的 ${key || "?"} 没有值` };
    out[key] = value;
  }
  return out;
}

/** Validate one definition file into a usable kind, or a reason it cannot be used. */
export function parseDefinition(kind: string, raw: string): { definition: KindDefinitionFile } | { reason: string } {
  const split = splitDefinition(raw);
  if ("reason" in split) return split;
  const front = parseFrontmatter(split.front);
  if ("reason" in front) return { reason: front.reason };
  const unknown = Object.keys(front).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return { reason: `不认识的 frontmatter 键：${unknown.join("、")}（可用：${KEYS.join("、")}）` };
  }
  const body = split.body.trim();
  if (body === "") return { reason: "正文为空：这个 kind 没有系统提示词" };
  if (body.length > MAX_PROMPT_LENGTH) return { reason: `提示词超过 ${MAX_PROMPT_LENGTH} 字符` };

  const definition: KindDefinitionFile = { kind, prompt: body };

  if (front.agent !== undefined) {
    if (!AGENT_NAME.test(front.agent)) return { reason: `agent 必须形如 cw-<kind>：${front.agent}` };
    definition.agent = front.agent;
  }
  if (front.label !== undefined) {
    if (front.label.length > MAX_LABEL_LENGTH) return { reason: `label 超过 ${MAX_LABEL_LENGTH} 字符` };
    definition.label = front.label;
  }
  if (front.description !== undefined) {
    if (front.description.length > MAX_DESCRIPTION_LENGTH) {
      return { reason: `description 超过 ${MAX_DESCRIPTION_LENGTH} 字符` };
    }
    definition.description = front.description;
  }
  if (front.role !== undefined) {
    if (front.role !== "none" && !(ROLES as readonly string[]).includes(front.role)) {
      return { reason: `role 只能是 ${ROLES.join(" / ")} 或 none：${front.role}` };
    }
    definition.role = front.role === "none" ? "none" : (front.role as SubagentRole);
  }
  if (front.context !== undefined) {
    if (front.context !== "role" && front.context !== "task") {
      return { reason: `context 只能是 role / task：${front.context}` };
    }
    definition.context = front.context;
  }
  if (front.model !== undefined) {
    if (!isKindModel(front.model) || front.model.length > MAX_KIND_MODEL_LENGTH) {
      return { reason: `model 不可用：${front.model}` };
    }
    definition.model = front.model;
  }
  if (front.thinking !== undefined) {
    if (!isThinkingLevel(front.thinking)) return { reason: `thinking 不是已知等级：${front.thinking}` };
    definition.thinking = front.thinking;
  }
  if (front.maxConcurrent !== undefined) {
    const value = Number(front.maxConcurrent);
    if (!Number.isInteger(value) || value < 1) return { reason: `maxConcurrent 需要 ≥ 1 的整数：${front.maxConcurrent}` };
    definition.maxConcurrent = value;
  }
  if (front.enabled !== undefined) {
    if (front.enabled !== "true" && front.enabled !== "false") {
      return { reason: `enabled 只能是 true 或 false：${front.enabled}` };
    }
    definition.enabled = front.enabled === "true";
  }
  return { definition };
}

/** The kind's declared defaults, as an `AgentKindConfig` shape for the shared resolvers. */
export function definitionDefaults(definition: KindDefinitionFile | undefined): AgentKindConfig {
  if (definition === undefined) return {};
  return {
    ...(definition.enabled === undefined ? {} : { enabled: definition.enabled }),
    ...(definition.maxConcurrent === undefined ? {} : { maxConcurrent: definition.maxConcurrent }),
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.thinking === undefined ? {} : { thinking: definition.thinking }),
  };
}

/**
 * Write one definition file, validated before anything touches the disk.
 *
 * The command and the public RPC both come through here, so "what a definition is" has one
 * implementation and a rejected value cannot leave a half-written file behind.
 */
export function writeKindDefinition(
  root: string,
  kind: string,
  patch: Partial<Omit<KindDefinitionFile, "kind">>,
  existing?: KindDefinitionFile,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!KIND_ID.test(kind)) return { ok: false, reason: `kind 名必须是 [a-z0-9-]：${kind}` };
  // Field by field, so "the patch said nothing" and "the patch said something" stay
  // distinguishable: a patch that omits a key keeps what the file already had, and a patch
  // that sets a key replaces it. `null` is not used to mean "remove" here — clearing a value
  // is `set` with an empty answer, which the caller turns into an absent key.
  const merged: KindDefinitionFile = {
    kind,
    prompt: patch.prompt ?? existing?.prompt ?? "",
  };
  const take = (key: keyof Omit<KindDefinitionFile, "kind" | "prompt">): void => {
    const value = patch[key] ?? existing?.[key];
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  };
  take("agent");
  take("label");
  take("description");
  take("role");
  take("context");
  take("model");
  take("thinking");
  take("maxConcurrent");
  take("enabled");
  const text = renderDefinition(merged);
  const parsed = parseDefinition(kind, text);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  const dir = definitionsDir(root);
  const path = join(dir, `${kind}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text);
  } catch (error) {
    return { ok: false, reason: `无法写入：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, path };
}

/**
 * Write a definition file verbatim, after validating it.
 *
 * The authoring path: an agent writes or edits a real markdown file with its normal tools and hands
 * it over, so comments, key order and formatting survive. Validating the exact bytes that land (and
 * not a re-render of them) is the point — a definition the reader would refuse must not be written,
 * and a definition that is written must be the one the author wrote.
 */
export function writeDefinitionFile(
  root: string,
  kind: string,
  text: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!KIND_ID.test(kind)) return { ok: false, reason: `kind 名必须是 [a-z0-9-]：${kind}` };
  if (text.length > MAX_DEFINITION_BYTES) {
    return { ok: false, reason: `文件超过 ${MAX_DEFINITION_BYTES} 字节` };
  }
  const parsed = parseDefinition(kind, text);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  const dir = definitionsDir(root);
  const path = join(dir, `${kind}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text);
  } catch (error) {
    return { ok: false, reason: `无法写入：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, path };
}

/** Render a definition back to its file form. */
export function renderDefinition(definition: KindDefinitionFile): string {
  const lines = ["---"];
  if (definition.label !== undefined) lines.push(`label: ${definition.label}`);
  if (definition.agent !== undefined) lines.push(`agent: ${definition.agent}`);
  if (definition.role !== undefined) lines.push(`role: ${definition.role}`);
  if (definition.context !== undefined) lines.push(`context: ${definition.context}`);
  if (definition.description !== undefined) lines.push(`description: ${definition.description}`);
  if (definition.model !== undefined) lines.push(`model: ${definition.model}`);
  if (definition.thinking !== undefined) lines.push(`thinking: ${definition.thinking}`);
  if (definition.maxConcurrent !== undefined) lines.push(`maxConcurrent: ${definition.maxConcurrent}`);
  if (definition.enabled !== undefined) lines.push(`enabled: ${definition.enabled}`);
  lines.push("---", "", definition.prompt, "");
  return lines.join("\n");
}
