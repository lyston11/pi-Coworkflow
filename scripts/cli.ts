#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pi-coworkflow` — the terminal entry to this package.
 *
 * Deliberately standalone: it needs no Pi session, no extension host and no running process. Any
 * agent that can run a shell command can therefore DIY this project's subagent kinds, which is the
 * point of the port — a definition lives in a file, and a file is something a terminal can write.
 *
 * Two rules it inherits from the port it writes to:
 *
 *   - **It is not a second implementation.** Reads and writes go through
 *     `modules/agent-kinds/definitions.ts`, the same reader and the same validating writer the
 *     `/Coworkflow:kind` command uses, so the CLI cannot accept something the session would refuse.
 *   - **An agent reads exit codes, not prose.** A refusal exits non-zero and says why on stderr;
 *     `--json` gives a machine-readable answer on stdout. Nothing here prints a success line for
 *     work that did not happen.
 *
 * Usage:
 *   pi-coworkflow kind list   [--project <dir>] [--json]
 *   pi-coworkflow kind show   <kind> [--project <dir>] [--json]
 *   pi-coworkflow kind set    <kind> key=value… [--project <dir>] [--json]
 *   pi-coworkflow kind remove <kind> [--project <dir>] [--json]
 *   pi-coworkflow kind path   [--project <dir>]
 *   pi-coworkflow --help | --version
 */

import { existsSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { readConfig } from "../core/config.ts";
import { mainCheckout } from "../core/trellis.ts";
import {
  DEFINITIONS_REL,
  definitionsDir,
  readKindDefinitions,
  writeKindDefinition,
} from "../modules/agent-kinds/definitions.ts";
import { resolveKinds } from "../modules/agent-kinds/defaults.ts";

const VERSION = "0.1.0";

/** The keys `set` accepts, and the shape each one takes. */
const WRITABLE = [
  "label",
  "agent",
  "role",
  "description",
  "model",
  "thinking",
  "maxConcurrent",
  "enabled",
  "prompt",
] as const;

interface Options {
  project: string;
  json: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Options {
  let project = process.cwd();
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--project" || arg === "-p") {
      const value = argv[i + 1];
      if (value === undefined) throw new Usage("--project 需要一个目录");
      project = value;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else {
      rest.push(arg);
    }
  }
  return { project: resolvePath(project), json, rest };
}

class Usage extends Error {}

/**
 * The project a command acts on.
 *
 * `mainCheckout` rather than the directory as given: a task worktree only carries committed
 * files, so a definition written there would be invisible to every gate that reads the main
 * checkout's `.pi/`. This is the same resolution the extension uses, for the same reason.
 */
function projectRoot(dir: string): string {
  if (!existsSync(dir)) throw new Usage(`目录不存在：${dir}`);
  return mainCheckout(dir);
}

function kindsView(root: string): unknown[] {
  const definitions = readKindDefinitions(root).definitions;
  return resolveKinds(readConfig(root), definitions).map((entry) => ({
    kind: entry.kind,
    agent: entry.agent,
    label: entry.label,
    role: entry.role,
    enabled: entry.enabled,
    maxConcurrent: entry.maxConcurrent,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
    source: entry.source,
    chosen: entry.chosen ?? {},
    definition: entry.source === "file" ? join(DEFINITIONS_REL, `${entry.kind}.md`) : null,
  }));
}

function print(value: unknown, json: boolean, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
}

/** `set` takes `key=value` pairs; the shapes are validated by the writer, not guessed here. */
function patchFrom(pairs: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Usage(`无法解析 ${JSON.stringify(pair)}：需要 key=value`);
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (!(WRITABLE as readonly string[]).includes(key)) {
      throw new Usage(`未知字段 ${key}；可用：${WRITABLE.join("、")}`);
    }
    if (key === "maxConcurrent") patch[key] = Number(value);
    else if (key === "enabled") patch[key] = value === "true";
    else patch[key] = value;
  }
  if (Object.keys(patch).length === 0) throw new Usage("没有要改的字段");
  return patch;
}

function runKind(options: Options): number {
  const root = projectRoot(options.project);
  const sub = options.rest[1] ?? "list";
  const kind = options.rest[2];
  const kinds = kindsView(root) as { kind: string; agent: string; label: string; source: string }[];
  const failures = readKindDefinitions(root).failures;

  if (sub === "path") {
    print({ dir: definitionsDir(root), rel: DEFINITIONS_REL }, options.json, () => definitionsDir(root));
    return 0;
  }

  if (sub === "list") {
    if (options.json) {
      print({ project: root, dir: definitionsDir(root), kinds, failures }, true, () => "");
      return failures.length === 0 ? 0 : 0;
    }
    const lines = [`kind 一览（${DEFINITIONS_REL}/<kind>.md 可自定义）：`];
    for (const entry of kinds) {
      lines.push(
        `  ${entry.kind} → ${entry.agent} · ${entry.label} · ${entry.source === "file" ? "项目定义" : "本包随附"}`,
      );
    }
    for (const failure of failures) lines.push(`  ! ${failure.kind}：${failure.reason}`);
    lines.push("", `用法：pi-coworkflow kind set <kind> ${WRITABLE.map((key) => `${key}=…`).join(" ")}`);
    print({ kinds, failures }, false, () => lines.join("\n"));
    return 0;
  }

  if (sub === "show") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind show <kind>");
    const entry = kinds.find((candidate) => candidate.kind === kind) as Record<string, unknown> | undefined;
    const definition = readKindDefinitions(root).definitions.get(kind);
    if (entry === undefined) {
      const failure = failures.find((candidate) => candidate.kind === kind);
      const reason = failure === undefined ? `没有 kind ${kind}` : `kind ${kind} 的定义无法使用：${failure.reason}`;
      process.stderr.write(`${reason}\n`);
      print({ ok: false, error: { code: failure === undefined ? "unknown_kind" : "invalid_definition", message: reason } }, options.json, () => "");
      return 2;
    }
    print(
      { ...entry, prompt: definition?.prompt ?? null },
      options.json,
      () =>
        [
          `kind ${entry.kind}`,
          `  agent: ${entry.agent}`,
          `  label: ${entry.label}`,
          `  role: ${entry.role ?? "none"}`,
          `  enabled: ${entry.enabled}${(entry.chosen as Record<string, boolean>)?.enabled === true ? "（项目选择）" : "（默认）"}`,
          `  maxConcurrent: ${entry.maxConcurrent}${(entry.chosen as Record<string, boolean>)?.maxConcurrent === true ? "（项目选择）" : "（默认）"}`,
          `  model: ${entry.model ?? "继承"}`,
          `  thinking: ${entry.thinking ?? "继承"}`,
          `  来源: ${entry.source === "file" ? `${DEFINITIONS_REL}/${entry.kind}.md` : "本包随附"}`,
          "",
          definition === undefined ? "（没有项目定义文件）" : `提示词：\n${definition.prompt}`,
        ].join("\n"),
    );
    return 0;
  }

  if (sub === "remove") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind remove <kind>");
    const path = join(definitionsDir(root), `${kind}.md`);
    // Only a file inside the definitions directory: this command deletes, and a path built from
    // an argument is exactly where that goes wrong.
    if (!path.startsWith(`${definitionsDir(root)}/`) || !existsSync(path)) {
      const message = `${kind} 没有项目定义文件（随附的 kind 只能关掉，不能删除）`;
      process.stderr.write(`${message}\n`);
      print({ ok: false, error: { code: "no_definition", message } }, options.json, () => "");
      return 2;
    }
    rmSync(path);
    const after = kindsView(root) as { kind: string }[];
    const message = after.some((entry) => entry.kind === kind)
      ? `${kind} 的项目定义已删除，回到本包随附的定义`
      : `${kind} 的项目定义已删除，该 kind 不再存在`;
    print({ ok: true, kind, message }, options.json, () => message);
    return 0;
  }

  if (sub === "set") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind set <kind> key=value…");
    const patch = patchFrom(options.rest.slice(3));
    const existing = readKindDefinitions(root).definitions.get(kind);
    const written = writeKindDefinition(root, kind, patch as never, existing);
    if (!written.ok) {
      // The writer validated and refused: the file is byte-identical and nothing was registered.
      process.stderr.write(`${kind} 未写入：${written.reason}\n`);
      print({ ok: false, error: { code: "rejected", message: written.reason } }, options.json, () => "");
      return 1;
    }
    const entry = (kindsView(root) as Record<string, unknown>[]).find((candidate) => candidate.kind === kind);
    print(
      { ok: true, kind, path: written.path, resolved: entry ?? null },
      options.json,
      () => `${kind} 已写入 ${written.path}（${entry === undefined ? "但当前无法解析" : `agent ${entry.agent}，${
        entry.enabled ? "on" : "off"
      }`}）`,
    );
    return 0;
  }

  throw new Usage(`未知子命令 ${sub}；可用：list / show / set / remove / path`);
}

const HELP = `pi-coworkflow ${VERSION} — 自定义本项目的子 agent 类型（kind）

用法：
  pi-coworkflow kind list             列出全部 kind（随附 + 项目定义）
  pi-coworkflow kind show <kind>      看一个 kind 的最终解析结果与提示词
  pi-coworkflow kind set <kind> k=v…  写/改一个定义文件（先校验，拒绝则不落盘）
  pi-coworkflow kind remove <kind>    删除一个项目定义文件
  pi-coworkflow kind path             打印定义目录

字段（set）：${WRITABLE.join("、")}
  role 取 implement | check | research | none
  enabled 取 true | false；maxConcurrent 取 ≥1 的整数

选项：
  -p, --project <dir>  作用于哪个项目（默认当前目录；worktree 会自动解析到主检出）
      --json           机器可读输出（stdout），适合 agent 调用
  -h, --help           这段说明

退出码：0 成功；1 值被拒绝（文件未改动）；2 用法/找不到；3 内部错误

定义文件格式（${DEFINITIONS_REL}/<kind>.md）：
  ---
  label: 建造者
  agent: cw-builder        # 必须 cw- 开头，默认 cw-<kind>
  role: implement
  description: 按派单实现一处改动
  model: provider/id       # 可选默认值
  thinking: high           # 可选默认值
  maxConcurrent: 5         # 可选默认值
  enabled: true            # 可选默认值
  ---

  你是这个项目自己的执行者：按派单做完一件已定义的工作，然后报告事实。
`;

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const options = parseArgs(argv);
  const group = options.rest[0];
  if (group !== "kind") {
    throw new Usage(`未知命令 ${group ?? "(空)"}；目前支持 kind（用 --help 看用法）`);
  }
  return runKind(options);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Usage) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`内部错误：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  }
}
