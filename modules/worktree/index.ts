/**
 * Module: task worktree isolation.
 *
 * The mechanism half of "one task = one branch + one worktree". It writes the
 * `after_start` hook that `task.py start` runs, and registers it in
 * `.trellis/config.yaml`, so isolation happens whether or not the model
 * remembers to do it. The policy half lives in the `agents-md` module.
 *
 * Switching the module off removes the registration — that is what makes tasks
 * stop being isolated — and leaves the hook script and Trellis's own files in
 * place. An existing hook's prefix wins over the default: rewriting it would
 * break every worktree path the project already spells out in its own docs.
 */

import { join } from "node:path";
import type { ModuleContext, WorkflowModule } from "../../core/module.ts";
import { moduleAsset, readText } from "../../core/module.ts";

const HOOK_REL = join(".trellis", "scripts", "hooks", "auto_worktree.py");
const HOOK_CMD = "python3 .trellis/scripts/hooks/auto_worktree.py";
const CONFIG_REL = join(".trellis", "config.yaml");
const PREFIX_LINE = /^WORKTREE_DIR_PREFIX = .*$/m;

/** The registration block this module appends, used to add and to remove it. */
const HOOK_BLOCK = [
  "",
  "#-------------------------------------------------------------------------------",
  "# Task hooks (added by pi-Coworkflow)",
  "#-------------------------------------------------------------------------------",
  "hooks:",
  "  after_start:",
  `    - "${HOOK_CMD}"`,
  "",
].join("\n");

/** The prefix an already-installed hook uses, if any. */
export function installedPrefix(root: string): string | null {
  const hook = readText(join(root, HOOK_REL));
  const match = hook?.match(/^WORKTREE_DIR_PREFIX = "([^"]*)"$/m);
  return match?.[1] || null;
}

function writeHook(ctx: ModuleContext): void {
  const template = moduleAsset(import.meta.url, "./assets/auto_worktree.py");
  if (template === null) {
    ctx.report("error", "资产缺失：modules/worktree/assets/auto_worktree.py");
    return;
  }
  const body = template.replace(
    PREFIX_LINE,
    `WORKTREE_DIR_PREFIX = ${JSON.stringify(ctx.prefix)}`,
  );
  const status = ctx.write(join(ctx.root, HOOK_REL), body, { mode: 0o755 });
  ctx.report(status, `${HOOK_REL}（worktree 前缀 ${ctx.prefix}）`);
}

function registerHook(ctx: ModuleContext): void {
  const target = join(ctx.root, CONFIG_REL);
  const current = ctx.read(target);
  if (current === null) {
    ctx.report("warn", "没有 .trellis/config.yaml，跳过 after_start 钩子注册");
    return;
  }
  if (/^hooks:/m.test(current)) {
    ctx.report(
      current.includes(HOOK_CMD) ? "ok" : "warn",
      current.includes(HOOK_CMD)
        ? "config.yaml 已注册 after_start → auto_worktree.py"
        : "config.yaml 已有 hooks: 段但没有 auto_worktree 的 after_start 项，请手工合并（未改动文件）",
    );
    return;
  }
  const status = ctx.write(target, `${current.replace(/\s*$/, "")}\n${HOOK_BLOCK}`);
  ctx.report(status, "config.yaml 注册 after_start → auto_worktree.py");
}

function unregisterHook(ctx: ModuleContext): void {
  const target = join(ctx.root, CONFIG_REL);
  const current = ctx.read(target);
  if (current === null) {
    ctx.report("ok", "没有 .trellis/config.yaml，无需清理");
    return;
  }
  if (!current.includes(HOOK_BLOCK)) {
    ctx.report(
      current.includes(HOOK_CMD) ? "warn" : "ok",
      current.includes(HOOK_CMD)
        ? "after_start 项存在但不是本模块写入的块，未改动；请手工移除"
        : "config.yaml 里没有本模块注册的钩子",
    );
    return;
  }
  ctx.report(
    ctx.write(target, current.replace(HOOK_BLOCK, "")),
    "已从 config.yaml 移除 after_start 注册（任务不再自动隔离）",
  );
}

export const worktreeModule: WorkflowModule = {
  id: "worktree",
  title: "任务 worktree 隔离（after_start 钩子）",

  apply(ctx: ModuleContext): void {
    writeHook(ctx);
    registerHook(ctx);
  },

  remove(ctx: ModuleContext): void {
    unregisterHook(ctx);
    ctx.report("ok", `${HOOK_REL} 保留（Trellis 自己的文件；不需要可手工删）`);
  },
};
