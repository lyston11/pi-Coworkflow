/**
 * Module: task worktree isolation.
 *
 * The mechanism half of "one task = one branch + one worktree". It writes the
 * `after_start` hook that `task.py start` runs, and registers it in
 * `.trellis/config.yaml`, so isolation happens whether or not the model
 * remembers to do it. The policy half lives in the `agents` module.
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

/** The marker line that owns the registration, so removal never guesses. */
const HOOK_MARKER = "# pi-Coworkflow: task hooks";

/**
 * The registration this module appends.
 *
 * The marker line is what makes removal reliable: matching the whole block by
 * string breaks as soon as anything reformats `config.yaml` — and `trellis
 * update` does exactly that — which used to leave the hook running while the
 * module reported itself off.
 */
const HOOK_BLOCK = [
  "",
  HOOK_MARKER,
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
  if (current.includes(HOOK_CMD)) {
    ctx.report("ok", "config.yaml 已注册 after_start → auto_worktree.py");
    return;
  }
  if (/^hooks:/m.test(current)) {
    ctx.report(
      "warn",
      "config.yaml 已有 hooks: 段但没有 auto_worktree 的 after_start 项，请手工合并（未改动文件）",
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
  const next = removeHookEntry(current);
  if (next === null) {
    ctx.report(
      current.includes(HOOK_CMD) ? "warn" : "ok",
      current.includes(HOOK_CMD)
        ? "after_start 里仍有 auto_worktree 项，但不是本模块写入的位置，未改动；请手工移除"
        : "config.yaml 里没有本模块注册的钩子",
    );
    return;
  }
  ctx.report(
    ctx.write(target, next),
    "已从 config.yaml 移除 after_start 注册（任务不再自动隔离）",
  );
}

/**
 * Remove this module's `after_start` entry, whatever the surrounding formatting.
 *
 * Works on lines rather than on one exact block: a human (or another tool)
 * reformats `config.yaml`, and a string match against the block this module wrote
 * stops matching the moment it does — which left the hook running while the
 * module reported itself off. The marker line identifies the registration; the command
 * line identifies the entry; an emptied `after_start:` key and an emptied
 * `hooks:` section are removed with it, because an empty key is not valid for
 * Trellis. Returns null when the entry is not where this module put it, so a
 * hand-written registration is reported instead of silently rewritten.
 */
function removeHookEntry(current: string): string | null {
  const lines = current.split("\n");
  const entryIndex = lines.findIndex((line) => line.trim() === `- "${HOOK_CMD}"`);
  if (entryIndex === -1) return null;
  const markerIndex = lines.findIndex((line) => line.trim() === HOOK_MARKER);
  const kept = lines.filter((_, index) => index !== entryIndex && index !== markerIndex);

  const indentOf = (line: string | undefined): number => (line ? line.length - line.trimStart().length : 0);
  const isKey = (line: string): boolean => /^\s*[A-Za-z_][A-Za-z0-9_]*:\s*(#.*)?$/.test(line);
  /**
   * Whether a key line has no children left.
   *
   * Children are the lines after it up to the first line at the same or lower
   * indent — not "everything after it", which is what an earlier version did: it
   * scanned to the end of the file, so a deeper-indented key in a *later* section
   * (`channel.worker_guard.max_live_workers`) made `after_start:` look non-empty and
   * the removal left `hooks:` / `after_start:` behind with nothing under them.
   */
  const isEmptyKey = (index: number): boolean => {
    const line = kept[index] ?? "";
    if (!isKey(line)) return false;
    const indent = indentOf(line);
    for (const next of kept.slice(index + 1)) {
      if (next.trim() === "") continue;
      // A comment belongs to whichever block it sits in; it is not a child.
      if (next.trim().startsWith("#")) continue;
      if (indentOf(next) <= indent) return true;
      return false;
    }
    return true;
  };

  // `after_start:` with no entries, then `hooks:` with no keys.
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    if (!isEmptyKey(index)) continue;
    const name = (kept[index] ?? "").trim().replace(/:.*$/, "");
    if (name !== "after_start" && name !== "hooks") continue;
    kept.splice(index, 1);
    if (name === "hooks") {
      // The section title comment the registration added above the header, then
      // the rule lines under it. Leaving them behind leaves `# Task hooks (added by
      // pi-Coworkflow)` dangling over nothing, which is what a disabled module used
      // to leave in the file.
      while (kept.length > 0) {
        const last = (kept[kept.length - 1] ?? "").trim();
        if (last === "") {
          kept.pop();
          continue;
        }
        if (/^#[-=]*$/.test(last) || /^#.*pi-Coworkflow/.test(last)) {
          kept.pop();
          continue;
        }
        break;
      }
    }
  }

  // Collapse the blank line the removal can leave behind, so the file reads as if
  // the module had never been installed.
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`;
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
