#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pi-coworkflow` — the terminal entry to this package.
 *
 * Deliberately standalone: it needs no Pi session, no extension host and no running process. Any
 * agent that can run a shell command can therefore DIY this project's subagent kinds, which is the
 * point of the port — a definition lives in a file, and a file is something a terminal can write.
 *
 * **A kind is a markdown file, not a shell string.** Each kind's prompt is its own document; the
 * natural workflow is `scaffold` → edit the file with whatever editor the agent already has →
 * `set <kind> --from <file>` → `check`. `set k=v` stays for one-field tweaks and is not the main
 * road, because a system prompt typed as a quoted argument loses its formatting, its line breaks
 * and its reviewability.
 *
 * Two rules it inherits from the port it writes to:
 *
 *   - **It is not a second implementation.** Reads and writes go through
 *     `modules/agent-kinds/definitions.ts`, the same reader and the same validating writer the
 *     `/Coworkflow:kind` command uses, so the CLI cannot accept something the session would refuse.
 *     `set --from` writes the bytes the author wrote, after validating exactly those bytes.
 *   - **An agent reads exit codes, not prose.** A refusal exits non-zero and says why on stderr;
 *     `--json` gives a machine-readable answer on stdout. Nothing here prints a success line for
 *     work that did not happen.
 *
 * Usage:
 *   pi-coworkflow kind list                 [--project <dir>] [--json]
 *   pi-coworkflow kind show <kind>          [--json]
 *   pi-coworkflow kind export <kind> [--out <file>]   effective definition as markdown
 *   pi-coworkflow kind scaffold <kind> [--force]      starter file to edit
 *   pi-coworkflow kind set <kind> --from <file.md>    apply a whole definition file
 *   pi-coworkflow kind set <kind> key=value…          change individual fields
 *   pi-coworkflow kind check [<kind>]                 validate, write nothing
 *   pi-coworkflow kind remove <kind>
 *   pi-coworkflow kind path [<kind>]
 *   pi-coworkflow --help | --version
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SESSION_FLAGS_FILE, sessionFlagEntry, sessionKeys, setSessionFlag } from "../core/trellis.ts";
import { join, resolve as resolvePath } from "node:path";

import { readConfig } from "../core/config.ts";
import { mainCheckout } from "../core/trellis.ts";
import {
  DEFINITIONS_REL,
  definitionsDir,
  parseDefinition,
  readKindDefinitions,
  renderDefinition,
  writeDefinitionFile,
  writeKindDefinition,
} from "../modules/agent-kinds/definitions.ts";
import { kindSystemPrompt, resolveKinds } from "../modules/agent-kinds/defaults.ts";

const VERSION = "0.1.0";
const MODULE_URL = import.meta.url.replace(/\/scripts\/cli\.ts$/, "/modules/agent-kinds/index.ts");

/** The keys `set k=v` accepts. The file is the full form; these are the shortcuts. */
const WRITABLE = [
  "label",
  "agent",
  "role",
  "context",
  "description",
  "model",
  "thinking",
  "maxConcurrent",
  "enabled",
  "prompt",
] as const;

interface Options {
  /** The project the command acts on; already resolved to its main checkout. */
  root: string;
  project: string;
  json: boolean;
  from?: string;
  out?: string;
  force: boolean;
  /** The session a `session` command acts on: an id, or a session file path. */
  session: string;
  rest: string[];
}

function parseArgs(argv: string[]): Options {
  let project = process.cwd();
  let json = false;
  let from: string | undefined;
  let out: string | undefined;
  let force = false;
  let session = "";
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (name: string): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Usage(`${name} 需要一个值`);
      i += 1;
      return next;
    };
    if (arg === "--project" || arg === "-p") project = value(arg);
    else if (arg === "--json") json = true;
    else if (arg === "--from") from = value(arg);
    else if (arg === "--out" || arg === "-o") out = value(arg);
    else if (arg === "--force") force = true;
    else if (arg === "--session" || arg === "-s") session = value(arg);
    else rest.push(arg);
  }
  const resolved = resolvePath(project);
  return { root: projectRoot(resolved), project: resolved, json, from, out, force, session, rest };
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

type KindView = {
  kind: string;
  agent: string;
  label: string;
  role: string | null;
  context: "role" | "task";
  enabled: boolean;
  maxConcurrent: number;
  model?: string;
  thinking?: string;
  source: string;
  chosen: Record<string, boolean>;
  description: string;
};

function kindsView(root: string): KindView[] {
  const definitions = readKindDefinitions(root).definitions;
  return resolveKinds(readConfig(root), definitions).map((entry) => ({
    kind: entry.kind,
    agent: entry.agent,
    label: entry.label,
    role: entry.role ?? null,
    context: entry.context ?? "role",
    enabled: entry.enabled,
    maxConcurrent: entry.maxConcurrent,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
    source: entry.source ?? "shipped",
    chosen: (entry.chosen ?? {}) as Record<string, boolean>,
    description: entry.description ?? "",
  }));
}

function print(value: unknown, json: boolean, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
}

function fail(json: boolean, code: string, message: string, exit: number): number {
  process.stderr.write(`${message}\n`);
  print({ ok: false, error: { code, message } }, json, () => "");
  return exit;
}

/** `set k=v` takes pairs; the shapes are validated by the writer, not guessed here. */
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

/**
 * The effective definition as markdown: a project file if there is one, otherwise what the package
 * ships — rendered so it can be edited and handed back through `set --from`.
 */
function effectiveDefinition(root: string, kind: string): { text: string; source: string } | null {
  const view = kindsView(root).find((entry) => entry.kind === kind);
  if (view === undefined) return null;
  const file = readKindDefinitions(root).definitions.get(kind);
  if (file !== undefined) return { text: renderDefinition(file), source: "file" };
  const shipped = kindSystemPrompt(MODULE_URL, kind);
  if (shipped === null) return null;
  return {
    text: renderDefinition({
      kind,
      label: view.label,
      role: (view.role ?? "none") as never,
      context: view.context,
      description: view.description,
      prompt: shipped,
    }),
    source: "shipped",
  };
}

/** A starter file: the full frontmatter, every field commented, and a prompt skeleton. */
function scaffoldText(kind: string, label: string, role: string, description: string): string {
  return `---
# 这个 kind 在面板与状态行里的名字
label: ${label}
# agent 名，必须形如 cw-<slug>；删掉这一行就用 cw-${kind}
agent: cw-${kind}
# Trellis 角色：implement | check | research | none
role: ${role}
# 上下文档位：role（按角色）；task（research 增加任务工件与实现清单）
context: role
# 出现在 agent 列表里的说明
description: ${description}
# 以下是可选默认值；面板里选过的值总是优先于这里
# model: provider/id
# thinking: high
# maxConcurrent: 5
# enabled: true
---

# 你是……

<!--
这个文件就是这个 kind 的「subagents.md」：正文会原样成为它的系统提示词。
写清三件事：
  1. 它负责什么、不负责什么；
  2. 交付物是什么形状（改哪些文件 / 产出什么报告）；
  3. 什么情况下要停下来问主会话（contact_supervisor），而不是自己拍板。

改完用 pi-coworkflow kind set ${kind} --from <这个文件> 生效，
或直接在 Pi 里 /reload（定义在每次解析时从磁盘读）。
-->
`;
}

function runKind(options: Options): number {
  const root = options.root;
  const sub = options.rest[1] ?? "list";
  const kind = options.rest[2];

  if (sub === "path") {
    const dir = definitionsDir(root);
    if (kind === undefined) {
      print({ dir, rel: DEFINITIONS_REL }, options.json, () => dir);
    } else {
      const path = join(dir, `${kind}.md`);
      print({ kind, path, exists: existsSync(path) }, options.json, () => path);
    }
    return 0;
  }

  if (sub === "list") {
    const kinds = kindsView(root);
    const failures = readKindDefinitions(root).failures;
    if (options.json) {
      print({ project: root, dir: definitionsDir(root), kinds, failures }, true, () => "");
      return 0;
    }
    const lines = [`kind 一览（${DEFINITIONS_REL}/<kind>.md 可自定义，一个 kind 一个 markdown）：`];
    for (const entry of kinds) {
      lines.push(
        `  ${entry.kind.padEnd(11)} → ${entry.agent.padEnd(15)} · ${entry.label} · 角色 ${entry.role ?? "none"} · ${
          entry.enabled ? "on" : "off"
        } · 上限 ${entry.maxConcurrent} · ${entry.source === "file" ? "项目定义" : "本包随附"}`,
      );
    }
    for (const failure of failures) lines.push(`  ! ${failure.kind}：${failure.reason}`);
    lines.push(
      "",
      "常用：",
      "  pi-coworkflow kind scaffold <kind>              生成一个可以编辑的定义文件",
      "  pi-coworkflow kind export <kind> --out <file>   把生效定义导出成 markdown",
      "  pi-coworkflow kind set <kind> --from <file.md>  用文件覆盖定义（先校验）",
      "  pi-coworkflow kind check                        校验全部定义，不写任何东西",
    );
    print({ kinds, failures }, false, () => lines.join("\n"));
    return 0;
  }

  if (sub === "show") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind show <kind>");
    const view = kindsView(root).find((candidate) => candidate.kind === kind);
    const definition = readKindDefinitions(root).definitions.get(kind);
    if (view === undefined) {
      const failure = readKindDefinitions(root).failures.find((candidate) => candidate.kind === kind);
      return fail(
        options.json,
        failure === undefined ? "unknown_kind" : "invalid_definition",
        failure === undefined ? `没有 kind ${kind}` : `kind ${kind} 的定义无法使用：${failure.reason}`,
        2,
      );
    }
    print(
      { ...view, prompt: definition?.prompt ?? null },
      options.json,
      () =>
        [
          `kind ${view.kind}`,
          `  agent: ${view.agent}`,
          `  label: ${view.label}`,
          `  role: ${view.role ?? "none"}`,
          `  context: ${view.context}`,
          `  description: ${view.description}`,
          `  enabled: ${view.enabled}${view.chosen.enabled ? "（项目选择）" : "（默认）"}`,
          `  maxConcurrent: ${view.maxConcurrent}${view.chosen.maxConcurrent ? "（项目选择）" : "（默认）"}`,
          `  model: ${view.model ?? "继承"}${view.chosen.model ? "（项目选择）" : ""}`,
          `  thinking: ${view.thinking ?? "继承"}${view.chosen.thinking ? "（项目选择）" : ""}`,
          `  来源: ${view.source === "file" ? `${DEFINITIONS_REL}/${view.kind}.md` : "本包随附"}`,
          "",
          definition === undefined
            ? `（没有项目定义文件；用 kind export ${view.kind} --out <file> 拿到随附提示词再改）`
            : `提示词：\n${definition.prompt}`,
        ].join("\n"),
    );
    return 0;
  }

  if (sub === "export") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind export <kind> [--out <file>]");
    const effective = effectiveDefinition(root, kind);
    if (effective === null) {
      return fail(options.json, "unknown_kind", `没有 kind ${kind}`, 2);
    }
    if (options.out === undefined) {
      // Markdown goes to stdout unchanged: it IS the artifact, not a description of it.
      process.stdout.write(effective.text);
      if (options.json) print({ ok: true, kind, source: effective.source }, true, () => "");
      return 0;
    }
    try {
      writeFileSync(options.out, effective.text);
    } catch (error) {
      return fail(options.json, "write_failed", `无法写入 ${options.out}：${error instanceof Error ? error.message : String(error)}`, 3);
    }
    const message = `${kind} 的生效定义已导出到 ${options.out}（来源：${effective.source === "file" ? "项目定义" : "本包随附"}）`;
    print({ ok: true, kind, out: options.out, source: effective.source }, options.json, () => message);
    return 0;
  }

  if (sub === "scaffold") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind scaffold <kind> [--force]");
    const path = join(definitionsDir(root), `${kind}.md`);
    if (existsSync(path) && !options.force) {
      return fail(
        options.json,
        "exists",
        `${path} 已存在；用 --force 覆盖，或直接用 kind export ${kind} 查看现有内容`,
        2,
      );
    }
    const known = kindsView(root).find((entry) => entry.kind === kind);
    const text = scaffoldText(
      kind,
      known?.label ?? kind,
      known?.role ?? "implement",
      known?.description ?? `${kind}：说明它做什么`,
    );
    const written = writeDefinitionFile(root, kind, text);
    if (!written.ok) return fail(options.json, "rejected", `${kind} 未写入：${written.reason}`, 1);
    const message = `已生成 ${written.path}；编辑它，然后 pi-coworkflow kind set ${kind} --from ${written.path}`;
    print({ ok: true, kind, path: written.path }, options.json, () => message);
    return 0;
  }

  if (sub === "check") {
    const targets = kind === undefined ? null : kind;
    const read = readKindDefinitions(root);
    const failures = read.failures.filter((entry) => targets === null || entry.kind === targets);
    if (targets !== null && !read.failures.some((entry) => entry.kind === targets) && !read.definitions.has(targets)) {
      return fail(options.json, targets === null ? "unknown_kind" : "no_definition", `没有 kind ${targets} 的项目定义文件`, 2);
    }
    const ok = failures.length === 0;
    print(
      { ok, checked: [...read.definitions.keys()], failures },
      options.json,
      () =>
        ok
          ? `定义文件全部可用（${read.definitions.size} 个）：${[...read.definitions.keys()].join("、") || "（无）"}`
          : ["定义文件有问题：", ...failures.map((entry) => `  ${entry.kind}：${entry.reason}`)].join("\n"),
    );
    return ok ? 0 : 1;
  }

  if (sub === "remove") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind remove <kind>");
    const path = join(definitionsDir(root), `${kind}.md`);
    // Only a file inside the definitions directory: this command deletes, and a path built from
    // an argument is exactly where that goes wrong.
    if (!path.startsWith(`${definitionsDir(root)}/`) || !existsSync(path)) {
      return fail(options.json, "no_definition", `${kind} 没有项目定义文件（随附的 kind 只能关掉，不能删除）`, 2);
    }
    rmSync(path);
    const message = kindsView(root).some((entry) => entry.kind === kind)
      ? `${kind} 的项目定义已删除，回到本包随附的定义`
      : `${kind} 的项目定义已删除，该 kind 不再存在`;
    print({ ok: true, kind, message }, options.json, () => message);
    return 0;
  }

  if (sub === "set") {
    if (kind === undefined) throw new Usage("用法：pi-coworkflow kind set <kind> --from <file.md> | key=value…");

    // The authoring path: a whole definition file, validated as written and written as validated.
    if (options.from !== undefined) {
      const pairs = options.rest.slice(3);
      if (pairs.length > 0) throw new Usage("--from 与 key=value 不能同时使用");
      let text: string;
      try {
        text = readFileSync(options.from, "utf-8");
      } catch (error) {
        return fail(options.json, "unreadable", `无法读取 ${options.from}：${error instanceof Error ? error.message : String(error)}`, 2);
      }
      const written = writeDefinitionFile(root, kind, text);
      if (!written.ok) return fail(options.json, "rejected", `${kind} 未写入：${written.reason}`, 1);
      const entry = kindsView(root).find((candidate) => candidate.kind === kind);
      const message = `${kind} 已按 ${options.from} 写入 ${written.path}（${entry === undefined ? "但当前无法解析" : `agent ${entry.agent}，${entry.enabled ? "on" : "off"}`}）`;
      print({ ok: true, kind, path: written.path, from: options.from, resolved: entry ?? null }, options.json, () => message);
      return 0;
    }

    const patch = patchFrom(options.rest.slice(3));
    if (patch.prompt !== undefined) {
      process.stderr.write(
        "提示：用 prompt=… 传入系统提示词会丢掉换行与格式。做这类改动请用文件：" +
          `pi-coworkflow kind export ${kind} --out <file> → 编辑 → pi-coworkflow kind set ${kind} --from <file>\n`,
      );
    }
    const existing = readKindDefinitions(root).definitions.get(kind);
    const written = writeKindDefinition(root, kind, patch as never, existing);
    if (!written.ok) return fail(options.json, "rejected", `${kind} 未写入：${written.reason}`, 1);
    const entry = kindsView(root).find((candidate) => candidate.kind === kind);
    print(
      { ok: true, kind, path: written.path, resolved: entry ?? null },
      options.json,
      () => `${kind} 已写入 ${written.path}（${entry === undefined ? "但当前无法解析" : `agent ${entry.agent}，${entry.enabled ? "on" : "off"}`}）`,
    );
    return 0;
  }

  throw new Usage(`未知子命令 ${sub}；可用：list / show / export / scaffold / set / check / remove / path`);
}

const HELP = `pi-coworkflow ${VERSION} — 自定义本项目的子 agent 类型（kind）

一个 kind 就是一个 markdown 文件：frontmatter 声明它是什么，正文是它的系统提示词。
文件在 ${DEFINITIONS_REL}/<kind>.md。

用法：
  pi-coworkflow session on  --session <id|路径>  为某个会话启用 Coworkflow（-p 模式必需）
  pi-coworkflow session off --session <id|路径>  关闭该会话的开关

  pi-coworkflow kind list                     列出全部 kind（随附 + 项目定义）
  pi-coworkflow kind show <kind>              看一个 kind 的最终解析结果与提示词
  pi-coworkflow kind export <kind> [--out f]  把生效定义导出成 markdown（随附的也能导）
  pi-coworkflow kind scaffold <kind>          生成一个带注释骨架的定义文件，接着编辑它
  pi-coworkflow kind set <kind> --from <f.md> 用整个文件覆盖定义（校验后按原样写入）
  pi-coworkflow kind set <kind> k=v…          只改个别字段（不适合长提示词）
  pi-coworkflow kind check [<kind>]           校验定义文件，不写任何东西
  pi-coworkflow kind remove <kind>            删除项目定义文件
  pi-coworkflow kind path [<kind>]            打印定义目录 / 某个 kind 的文件路径

推荐流程：
  pi-coworkflow kind scaffold builder
  $EDITOR .pi/Coworkflow/agents/builder.md
  pi-coworkflow kind set builder --from .pi/Coworkflow/agents/builder.md

字段（set k=v）：${WRITABLE.join("、")}
  role 取 implement | check | research | none；context 取 role | task
  enabled 取 true|false；maxConcurrent 取 ≥1 的整数

为什么需要 session 命令：
  pi -p '/Coworkflow:start' 里的斜杠命令不会执行——它被当成提示词发出去，于是第一次派单
  会因为「本会话未启用」被拒。非交互会话要派单，先用这条命令记下开关：
    pi-coworkflow session on --session <会话 id 或会话文件路径>

选项：
  -p, --project <dir>  作用于哪个项目（默认当前目录；worktree 会自动解析到主检出）
  -s, --session <id>   session：会话 id 或会话文件路径（两种写法解析到同一个键）
      --from <file>    set：用这个 markdown 文件覆盖定义
  -o, --out <file>     export：写到文件而不是 stdout
      --force          scaffold：覆盖已存在的文件
      --json           机器可读输出（stdout），适合 agent 调用
  -h, --help           这段说明

退出码：0 成功；1 值被拒绝（文件未改动）；2 用法/找不到；3 内部错误

定义文件：
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

/**
 * The session switch, from a terminal.
 *
 * `/Coworkflow:start` records this flag for the session it runs in, which is exactly what a
 * non-interactive session cannot do: `pi -p '/Coworkflow:start'` sends that text as the prompt, the
 * command never runs, and the very first dispatch is refused because the layer is off. The last
 * session that hit this asked the model to read the flag's file format out of the source and write
 * it by hand — a workaround that should not be the documented interface.
 *
 * So the same writer is exposed here. `--session` takes the id or the session file path; both
 * spellings resolve to the same key, because that mismatch has already cost this package one silent
 * bug (a parent passed a path, the flags were keyed by id, and every child read "no flag").
 */
function runSession(options: Options): number {
  const sub = options.rest[1];
  const session = options.session.trim();
  if (!session) {
    throw new Usage(
      "需要一个会话：--session <会话 id 或会话文件路径>（`pi` 的会话 id 可以在 /Coworkflow:status 或会话文件名里看到）",
    );
  }
  const keys = sessionKeys(session);
  if (keys.length === 0) throw new Usage(`无法从 "${session}" 解析出会话 id`);
  if (sub !== "on" && sub !== "off") {
    throw new Usage(`未知子命令 ${sub ?? "(空)"}；可用：session on / session off`);
  }
  const on = sub === "on";
  let written = 0;
  for (const key of keys) if (setSessionFlag(options.root, key, on)) written += 1;
  const entry = sessionFlagEntry(options.root, keys[0]!);
  print(
    {
      ok: written > 0,
      session: keys[0],
      keys,
      on,
      // `.pi/Coworkflow.json` may not exist: this command records a per-session switch, it does not
      // adopt the project. Saying so here is cheaper than the reader discovering it later.
      adopted: existsSync(join(options.root, ".pi", "Coworkflow.json")),
    },
    options.json,
    () =>
      written === 0
        ? `未能写入会话开关（${SESSION_FLAGS_FILE} 不可写）`
        : `会话 ${keys[0]!.slice(0, 8)} 已${on ? "启用" : "关闭"} Coworkflow` +
          `（记录在 ${SESSION_FLAGS_FILE}）` +
          (on && !existsSync(join(options.root, ".pi", "Coworkflow.json"))
            ? "；注意本项目还没有 .pi/Coworkflow.json——会话开关不等于采用，先用 /Coworkflow:init 采用本项目"
            : ""),
  );
  return written > 0 ? 0 : 1;
}

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
  if (group === "session") return runSession(options);
  if (group !== "kind") {
    throw new Usage(`未知命令 ${group ?? "(空)"}；可用：kind / session（用 --help 看用法）`);
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
