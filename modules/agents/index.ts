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
 *   1. pi-subagents inherits `AGENTS.md` only for agents declaring
 *      `inheritProjectContext: true`. The Trellis role agents declare `false`
 *      (Trellis CLI templates).
 *   2. Whatever an agent declares, `subagent-context` strips inherited project
 *      context out of a child's system prompt before adding the child guide, so
 *      a custom agent that forgot the field cannot get two sets of rules.
 *
 * Placement note: the child guide lives under `.pi/Coworkflow/` rather than
 * `.trellis/`. It is this package's artifact, not Trellis's, and `trellis
 * update` must not see it as something to reconcile.
 */

import { join } from "node:path";
import type { ModuleContext, WorkflowModule } from "../../core/module.ts";
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

export const agentsModule: WorkflowModule = {
  id: "agents",
  title: "指令文件（主会话 AGENTS.md 受管区 + 子 agent 专用约定）",

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
