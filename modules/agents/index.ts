/**
 * Module: the two instruction files, and the rule that a child sees only one.
 *
 * There are two audiences and they need different instructions:
 *
 *   `AGENTS.md`            the session the user drives — planning, dispatch,
 *                          audit, merge. Written by the agent to its own repo.
 *   `.pi/Coworkflow/subagent-AGENTS.md`
 *                          a dispatched child — do the one task, report, never
 *                          manage tasks or merge.
 *
 * A child must not receive both: the project file tells it to plan and audit,
 * which it must not do. Two mechanisms could deliver it, so this module closes
 * both:
 *
 * The enforcement lives in `subagent-context`, not in agent frontmatter: it
 * strips inherited project instructions from a child's system prompt before
 * adding the child guide. Doing it there keeps the rule independent of which
 * agent was dispatched (including agents this package does not own), and it
 * only runs in a project that ran `/Coworkflow:init`.
 *
 * Placement note: the child guide lives under `.pi/Coworkflow/` rather than
 * `.trellis/`. It is this package's artifact, not Trellis's, and `trellis
 * update` must not see it as something to reconcile.
 *
 * ## The runtime half
 *
 * A policy that lives only in a file is a suggestion, and this one was read as
 * exactly that: a loaded session read the region, did the work itself, and
 * dispatched nobody. Files cannot enforce a division of labour, so the module also
 * measures it. In a main session it counts the tool calls it sees and, once the
 * work has clearly crossed the region's own threshold — enough calls, enough
 * distinct files, no child dispatched — it puts one line into the prompt naming
 * the rule and the exact call to make. Once per session, and only while the
 * workflow is loaded for that session.
 *
 * That is deliberately a nudge rather than a block: the region itself says the
 * main session may do work that is too small to be worth delegating, and the
 * threshold is the same judgement written down.
 */

import { join } from "node:path";
import type { ModuleContext, PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { moduleAsset } from "../../core/module.ts";

const REGION_START = "<!-- pi-Coworkflow:start -->";
const REGION_END = "<!-- pi-Coworkflow:end -->";
/** Child-facing instructions. Owned by this package, not by Trellis. */
export const SUBAGENT_GUIDE_REL = join(".pi", "Coworkflow", "subagent-AGENTS.md");

/** Headings a project that predates this package already wrote by hand. */
const LEGACY_HEADINGS = /^#{2,3}\s*(并行任务与 Git 隔离|子 agent 派单)/m;

function regionText(ctx: ModuleContext): string | null {
  const template = moduleAsset(import.meta.url, "./assets/main-AGENTS.region.md");
  if (template === null) {
    ctx.report("error", "资产缺失：modules/agents/assets/main-AGENTS.region.md");
    return null;
  }
  return [
    REGION_START,
    template.replaceAll("{{worktreePrefix}}", ctx.prefix).trim(),
    REGION_END,
  ].join("\n");
}

/** Remove the sentinel region, leaving the rest of the file untouched. */
function stripRegion(current: string): string | null {
  const start = current.indexOf(REGION_START);
  const end = current.indexOf(REGION_END);
  if (start === -1 || end <= start) return null;
  const before = current.slice(0, start).replace(/\s*$/, "");
  const after = current.slice(end + REGION_END.length).replace(/^\s*/, "");
  const next = [before, after].filter(Boolean).join("\n\n");
  return next ? `${next}\n` : "";
}

function writeChildGuide(ctx: ModuleContext): void {
  const guide = moduleAsset(import.meta.url, "./assets/subagent-AGENTS.md");
  if (guide === null) {
    ctx.report("error", "资产缺失：modules/agents/assets/subagent-AGENTS.md");
    return;
  }
  const target = join(ctx.root, SUBAGENT_GUIDE_REL);
  const status = ctx.write(target, guide);
  ctx.report(
    status,
    status === "ok"
      ? `${SUBAGENT_GUIDE_REL} 已是最新（子 agent 专用，与项目 AGENTS.md 不共存）`
      : `${SUBAGENT_GUIDE_REL}（子 agent 专用约定；注入时会把继承来的项目 AGENTS.md 剥掉）`,
  );
}

/**
 * What "too big to do yourself" means, in the terms the region uses.
 *
 * Both numbers are calls, not minutes: a session that has made 12 tool calls
 * across 4 files is doing implementation work, and implementation work is what a
 * child exists for. Below either number the region's own exception ("小到不值得
 * 派单") applies and the nudge stays silent.
 */
const NUDGE_MIN_TOOL_CALLS = 12;
const NUDGE_MIN_FILES = 4;

/** Tools that mutate the repository, as opposed to reading or reporting. */
const WRITE_TOOLS = new Set(["write", "edit", "bash", "codemode"]);

/** A path-shaped token in a tool call, for counting distinct files touched. */
const PATH_RE = /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|md|json|yaml|yml|toml|css|scss|html|sql|sh)\b/g;

/**
 * A path-shaped token in a tool call, for counting distinct files touched.
 *
 * Matched against the call's *arguments*, not its serialized form: a
 * `write`/`edit` whose body happens to contain `foo.ts` in a comment is not a
 * file being changed, and counting those is how the threshold went off on a
 * session that had touched far fewer files than it claimed.
 */
function pathsIn(input: unknown, into: Set<string>): void {
  if (input === null || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  // Only the fields that name a target, in the order the tools use them.
  for (const key of ["path", "file_path", "filePath", "file", "files", "target"]) {
    const value = record[key];
    if (typeof value === "string") {
      for (const match of value.matchAll(PATH_RE)) into.add(match[0]);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          for (const match of entry.matchAll(PATH_RE)) into.add(match[0]);
        }
      }
    }
  }
}

/**
 * Count the main session's own work, and report it where it belongs.
 *
 * Runs in the main session only: a child is *supposed* to do the work, so the
 * measurement means nothing there.
 *
 * Where the report goes matters as much as what it says. An earlier version
 * returned it from `before_agent_start`, and Pi delivers a handler's returned
 * message as a **user-role message** at the head of the run — so the middle of a
 * debugging session suddenly contained a wall of bold text attributed to the user,
 * rewriting the task and declaring work "越界". It read as a prompt injection and
 * interrupted the run far more than it helped. The measurement is still real, but
 * it is now reported the way every other Coworkflow status is: as a display-only
 * `custom_message` entry, which renders in the transcript and is not part of the
 * conversation the model continues from.
 *
 * Deliberately *not* counted: management calls (`subagent({ action: "status" })`)
 * are dispatches in spirit, and a session that has dispatched once has answered the
 * question this metric asks.
 */
export function watchDivisionOfWork(host: PiRuntimeHost, runtime: RuntimeContext): void {
  if (!host.on) return;

  let toolCalls = 0;
  let writeCalls = 0;
  let dispatches = 0;
  const files = new Set<string>();
  let reported = false;

  const report = (): void => {
    if (reported) return;
    reported = true;
    const line = [
      `分工：本会话已自行执行 ${toolCalls} 次工具调用、直接改动了 ${files.size} 个文件（其中 ${writeCalls} 次写操作），尚未派发任何子 agent。`,
      "受管区的界线是 ≥12 次工具调用且 ≥4 个文件时应当派单。若剩余工作有可独立验证的边界，用 `subagent({ agent, async: true, context: \"fresh\", task: \"Active task: …\" })` 交出去。",
    ].join("\n");
    try {
      host.sendMessage?.({ customType: "pi-Coworkflow", content: line, display: true });
    } catch {
      // A report that cannot be delivered must not break the tool call that triggered it.
    }
  };

  host.on("tool_call", (event: any) => {
    if (!runtime.enabled) return undefined;
    const name = typeof event?.toolName === "string" ? event.toolName : "";
    if (name === "subagent") {
      dispatches += 1;
      return undefined;
    }
    toolCalls += 1;
    if (!WRITE_TOOLS.has(name)) return undefined;
    writeCalls += 1;
    pathsIn(event?.input, files);
    // Report at the crossing rather than on the next model turn: a tool call is
    // the moment the work becomes implementable-by-a-child, and reporting here
    // keeps it out of the prompt entirely.
    if (dispatches === 0 && toolCalls >= NUDGE_MIN_TOOL_CALLS && files.size >= NUDGE_MIN_FILES) {
      report();
    }
    return undefined;
  });
}

export const agentsModule: WorkflowModule = {
  id: "agents",
  title: "指令文件（主会话 AGENTS.md 受管区 + 子 agent 专用约定）与分工测量",

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    // Only the main session is measured: a child doing the work is the design.
    if (runtime.isChild) return;
    watchDivisionOfWork(host, runtime);
  },

  apply(ctx: ModuleContext): void {
    writeChildGuide(ctx);

    const region = regionText(ctx);
    if (region === null) return;

    const target = join(ctx.root, "AGENTS.md");
    const current = ctx.read(target);

    if (current === null) {
      ctx.report(ctx.write(target, `# Agent Guide\n\n${region}\n`), "AGENTS.md（仅工作流受管区）");
      return;
    }

    const start = current.indexOf(REGION_START);
    const end = current.indexOf(REGION_END);
    if (start !== -1 && end > start) {
      const next =
        current.slice(0, start) + region + current.slice(end + REGION_END.length);
      const status = ctx.write(target, next);
      ctx.report(status, status === "ok" ? "AGENTS.md 受管区已是最新" : "AGENTS.md 受管区");
      return;
    }

    if (LEGACY_HEADINGS.test(current)) {
      ctx.report(
        "warn",
        "AGENTS.md 已有等价的手写章节（并行隔离 / 子 agent 派单），未追加受管区；要迁移请先删掉旧章节再重跑",
      );
      return;
    }

    ctx.report(
      ctx.write(target, `${current.replace(/\s*$/, "")}\n\n${region}\n`),
      "AGENTS.md 追加工作流受管区",
    );
  },

  remove(ctx: ModuleContext): void {
    const guide = join(ctx.root, SUBAGENT_GUIDE_REL);
    if (ctx.read(guide) !== null) {
      ctx.remove(guide);
      ctx.report("updated", `${SUBAGENT_GUIDE_REL} 已移除`);
    }

    const target = join(ctx.root, "AGENTS.md");
    const current = ctx.read(target);
    if (current === null) {
      ctx.report("ok", "没有 AGENTS.md，无需清理");
      return;
    }
    const next = stripRegion(current);
    if (next === null) {
      ctx.report("ok", "AGENTS.md 里没有本包的受管区");
      return;
    }
    if (!next) {
      ctx.report(ctx.write(target, "# Agent Guide\n"), "AGENTS.md 只剩受管区，已重置为空骨架");
      return;
    }
    ctx.report(ctx.write(target, next), "AGENTS.md 受管区已移除（其余内容未动）");
  },
};
