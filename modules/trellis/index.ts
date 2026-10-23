/**
 * Module: the Trellis layer.
 *
 * This module owns no Trellis content. Trellis assets are owned by the Trellis
 * CLI and three-way merged through `.trellis/.template-hashes.json`, so the only
 * correct way to add or move them is the CLI itself:
 *
 *   - no `.trellis/` yet  → `trellis init --pi -y` installs the whole platform.
 *   - `.trellis/` present → nothing is written. Existing records — `tasks/`,
 *     `spec/`, `workspace/`, `.developer/`, `.runtime/` — are the project's
 *     history and are never rewritten by this package. `trellis update` is the
 *     command that moves the *paradigm* files (Pi extension, prompts, agent
 *     definitions, workflow docs) to this fork's version, and the CLI prints
 *     which of them are user-modified and preserved.
 *
 * The module therefore reports the alignment state and, when asked with
 * `--trellis-update`, runs the update in its non-destructive mode: files the
 * project has not touched are upgraded, files it has touched are kept, and the
 * modules that run after this one re-apply the edits this package owns.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ModuleContext, WorkflowModule } from "../../core/module.ts";

const TRELLIS_REL = ".trellis";
const PI_EXTENSION_REL = join(".pi", "extensions", "trellis", "index.ts");

function run(
  command: string,
  args: string[],
  cwd: string,
  /**
   * How long this command may block the session.
   *
   * The CLI is not ours: a wrapper that waits on a prompt, a first-run download, or a hook reading
   * stdin would hold this process's event loop forever. Version probes get seconds; `update` gets
   * minutes, because it is legitimately slow and its output is the point.
   */
  timeoutMs = 15_000,
): { code: number; out: string; err: string } {
  const proc = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    code: proc.status ?? 1,
    out: (proc.stdout ?? "").trim(),
    err: (proc.stderr ?? "").trim(),
  };
}

function projectVersion(ctx: ModuleContext): string | null {
  const raw = ctx.read(join(ctx.root, TRELLIS_REL, ".version"));
  return raw ? raw.trim() || null : null;
}

function cliVersion(): string | null {
  const result = run("trellis", ["--version"], process.cwd());
  const match = /(\d+\.\d+\.\d+)/.exec(result.out || result.err);
  return match?.[1] ?? null;
}

/** Report the alignment between the project's Trellis and this fork's CLI. */
function reportAlignment(ctx: ModuleContext, installed: string | null, cli: string | null): void {
  if (installed === null) {
    ctx.report("warn", "`.trellis/.version` 缺失，无法判断项目 Trellis 版本");
  } else if (cli === null) {
    ctx.report("warn", `项目 Trellis ${installed}；找不到 \`trellis\` CLI，无法判断范式是否最新`);
  } else if (installed === cli) {
    ctx.report("ok", `Trellis ${installed}，与本机 CLI 同版本`);
  } else {
    ctx.report(
      "warn",
      `项目 Trellis ${installed} ≠ 本机 CLI ${cli}：范式未对齐。跑 \`trellis update\`（tasks/spec/workspace 等记录会保留），或 \`/Coworkflow:init --trellis-update\``,
    );
  }
}

function ensurePiAssets(ctx: ModuleContext): void {
  if (ctx.read(join(ctx.root, PI_EXTENSION_REL)) !== null) {
    ctx.report("ok", "`.pi/extensions/trellis/` 已就位（Trellis 的 Pi 资产）");
    return;
  }
  ctx.report(
    "warn",
    "缺少 `.pi/extensions/trellis/`：Pi 侧没有 Trellis 扩展，跑 `trellis update` 或 `trellis init --pi` 补齐",
  );
}

function runUpdate(ctx: ModuleContext): void {
  const preview = run("trellis", ["update", "--dry-run"], ctx.root, 180_000);
  if (preview.code !== 0) {
    ctx.report("error", `trellis update --dry-run 失败：${preview.err || preview.out || "未知错误"}`);
    return;
  }
  const summary = (preview.out || preview.err)
    .split("\n")
    .filter((line) => line.trim() && !/^\[Dry run\]/.test(line.trim()))
    .slice(-12)
    .join("\n");
  if (ctx.dry) {
    ctx.report("updated", `预计执行 \`trellis update -s\`；当前差异：\n${summary}`);
    return;
  }

  // `-s` keeps every file the project has modified and upgrades the rest, so
  // the edits this package makes to `config.yaml` / `.pi/settings.json` survive
  // and the modules that run after this one re-apply them regardless.
  const applied = run("trellis", ["update", "-s"], ctx.root, 300_000);
  if (applied.code !== 0) {
    ctx.report("error", `trellis update -s 失败：${applied.err || applied.out || "未知错误"}`);
    return;
  }
  const tail = (applied.out || applied.err).split("\n").slice(-6).join("\n");
  ctx.report("updated", `已跑 \`trellis update -s\`（保留本地改动）\n${tail}`);
}

export const trellisModule: WorkflowModule = {
  id: "trellis",
  title: "改版 Trellis（.trellis/ + .pi/ + .agents/skills/）",

  apply(ctx: ModuleContext): void {
    const hasVersion = ctx.read(join(ctx.root, TRELLIS_REL, ".version")) !== null;
    const hasConfig = ctx.read(join(ctx.root, TRELLIS_REL, "config.yaml")) !== null;

    if (!hasVersion && !hasConfig) {
      if (ctx.dry) {
        ctx.report("created", "trellis init --pi -y（.trellis/、.pi/、.agents/skills/、AGENTS.md）");
        return;
      }
      const result = run("trellis", ["init", "--pi", "-y"], ctx.root, 180_000);
      if (result.code !== 0) {
        ctx.report("error", `trellis init --pi -y 失败：${result.err || result.out || `exit ${result.code}`}`);
        return;
      }
      ctx.report("created", "trellis init --pi -y（.trellis/、.pi/、.agents/skills/、AGENTS.md）");
      return;
    }

    // An existing project: its records are history, not templates. Report what
    // is there, align the paradigm only when asked.
    ctx.report(
      "ok",
      "已有 Trellis 项目：tasks/ spec/ workspace/ .runtime/ 等记录原样保留，本模块不重写任何 Trellis 内容",
    );
    if (!hasVersion) {
      ctx.report("warn", "`.trellis/` 存在但没有 `.version`：安装不完整，跑 `trellis init --pi` 或 `trellis update` 修复");
    }
    reportAlignment(ctx, projectVersion(ctx), cliVersion());
    ensurePiAssets(ctx);
    if (ctx.options?.trellisUpdate === true) runUpdate(ctx);
    else {
      ctx.report(
        "ok",
        "范式对齐由 `trellis update` 负责（本包只加自己的那一层）；--trellis-update 可让本命令代跑 `trellis update -s`",
      );
    }
  },
};
