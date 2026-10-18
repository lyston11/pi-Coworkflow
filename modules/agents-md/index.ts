/**
 * Module: the AGENTS.md constraint region.
 *
 * The policy half of the workflow: task-isolation rules and the delegation
 * policy, written between sentinel markers so a re-run replaces the text
 * instead of stacking a second copy — and so switching the module off can
 * remove exactly what this package added and nothing else.
 *
 * A project that predates this package already spells the rules out by hand;
 * for those the module refuses to append and says how to migrate, because two
 * copies of the same rules in one file is worse than none.
 */

import { join } from "node:path";
import type { ModuleContext, WorkflowModule } from "../../core/module.ts";
import { moduleAsset } from "../../core/module.ts";

const REGION_START = "<!-- pi-Coworkflow:start -->";
const REGION_END = "<!-- pi-Coworkflow:end -->";
/** Markers written before this package was renamed to pi-Coworkflow. */
const LEGACY_REGION_START = "<!-- pi-trellis-workflow:start -->";
const LEGACY_REGION_END = "<!-- pi-trellis-workflow:end -->";

/** Headings a project that predates this package already wrote by hand. */
const LEGACY_HEADINGS = /^#{2,3}\s*(并行任务与 Git 隔离|子 agent 派单)/m;

function regionText(ctx: ModuleContext): string | null {
  const template = moduleAsset(import.meta.url, "./assets/region.md");
  if (template === null) {
    ctx.report("error", "资产缺失：modules/agents-md/assets/region.md");
    return null;
  }
  return [
    REGION_START,
    template.replaceAll("{{worktreePrefix}}", ctx.prefix).trim(),
    REGION_END,
  ].join("\n");
}

/** The region's bounds, accepting the pre-rename markers as well. */
function findRegion(current: string): { start: number; end: number } | null {
  for (const [startMarker, endMarker] of [
    [REGION_START, REGION_END],
    [LEGACY_REGION_START, LEGACY_REGION_END],
  ] as const) {
    const start = current.indexOf(startMarker);
    const end = current.indexOf(endMarker);
    if (start !== -1 && end > start) return { start, end: end + endMarker.length };
  }
  return null;
}

/** Remove the sentinel region, leaving the rest of the file untouched. */
function stripRegion(current: string): string | null {
  const bounds = findRegion(current);
  if (bounds === null) return null;
  const before = current.slice(0, bounds.start).replace(/\s*$/, "");
  const after = current.slice(bounds.end).replace(/^\s*/, "");
  const next = [before, after].filter(Boolean).join("\n\n");
  return next ? `${next}\n` : "";
}

export const agentsMdModule: WorkflowModule = {
  id: "agents-md",
  title: "AGENTS.md 约束受管区（任务隔离 + 派单策略）",

  apply(ctx: ModuleContext): void {
    const region = regionText(ctx);
    if (region === null) return;

    const target = join(ctx.root, "AGENTS.md");
    const current = ctx.read(target);

    if (current === null) {
      ctx.report(ctx.write(target, `# Agent Guide\n\n${region}\n`), "AGENTS.md（仅工作流受管区）");
      return;
    }

    const bounds = findRegion(current);
    if (bounds !== null) {
      // Replacing in place also migrates a region written with the old
      // markers, so a renamed package never leaves two regions behind.
      const next = current.slice(0, bounds.start) + region + current.slice(bounds.end);
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
      ctx.report(
        ctx.write(target, "# Agent Guide\n"),
        "AGENTS.md 只剩受管区，已重置为空骨架（原内容没有别的东西）",
      );
      return;
    }
    ctx.report(ctx.write(target, next), "AGENTS.md 受管区已移除（其余内容未动）");
  },
};
