/**
 * Module: the subagent layer — reuse what is installed, install per project.
 *
 * This package does not ship a subagent runtime. `pi-subagents` is the runtime,
 * and this module's whole job is to make sure the project has one and to point
 * it at the project rather than at the user's machine:
 *
 *   1. **Reuse.** If `pi-subagents` is declared in the user's settings, in the
 *      project's settings, or present in Pi's npm directory, the module reports
 *      where it came from and version, and installs nothing. A user who already
 *      has the extension keeps exactly one copy.
 *   2. **Install per project.** Only when it is missing everywhere does the
 *      module declare it in the project's own `.pi/settings.json`, so the
 *      dependency belongs to the project and disappears with it. Nothing is
 *      written to the user's settings.
 *   3. **Anchor discovery to the repository root.** Trellis worktrees are
 *      linked Git worktrees; `subagents.projectRootResolution: "git-root"` keeps
 *      project agent discovery on the repository instead of an incidental
 *      nested `.pi` inside a worktree.
 *
 * The launch-context default is deliberately *not* written anywhere. With no
 * global preference, `pi-subagents` already defaults to `fresh`, which is what a
 * Trellis role needs; the module only reports when the user's own config sets
 * `fork`, because that would silently hand a Trellis child the parent's prompt
 * instead of its role context.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ModuleContext, WorkflowModule } from "../../core/module.ts";

const PROJECT_SETTINGS = join(".pi", "settings.json");
const USER_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");
const USER_SUBAGENT_CONFIG = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  "subagent",
  "config.json",
);
const NPM_SUBAGENTS = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");
const PACKAGE = "pi-subagents";
/** Settings spec for an npm source, in the form `pi install` itself writes. */
const PACKAGE_SPEC = `npm:${PACKAGE}`;
const ROOT_RESOLUTION_KEY = "projectRootResolution";
const ROOT_RESOLUTION_VALUE = "git-root";

interface JsonObject {
  [key: string]: unknown;
}

function readObject(ctx: ModuleContext, path: string): JsonObject | null {
  const raw = ctx.read(path);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as JsonObject;
  } catch {
    ctx.report("warn", `${path} 不是合法的 JSON 对象，未改动`);
    return null;
  }
}

function writeObject(ctx: ModuleContext, path: string, value: JsonObject): void {
  ctx.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Where `pi-subagents` is already available, if anywhere. */
function detect(ctx: ModuleContext): string | null {
  const userSettings = readObject(ctx, USER_SETTINGS);
  if (declaresPackage(userSettings)) return "用户级 settings.json";
  const projectSettings = readObject(ctx, PROJECT_SETTINGS);
  if (declaresPackage(projectSettings)) return "项目级 .pi/settings.json";
  if (ctx.read(join(NPM_SUBAGENTS, "package.json")) !== null) return "Pi 的 npm 目录";
  return null;
}

function declaresPackage(settings: JsonObject | null): boolean {
  if (settings === null) return false;
  const packages = settings.packages;
  if (!Array.isArray(packages)) return false;
  return packages.some((entry) => typeof entry === "string" && packageName(entry) === PACKAGE);
}

function packageName(spec: string): string {
  const withoutPrefix = spec.replace(/^npm:/, "");
  const at = withoutPrefix.lastIndexOf("@");
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
}

function installedVersion(ctx: ModuleContext): string | undefined {
  const raw = ctx.read(join(NPM_SUBAGENTS, "package.json"));
  if (raw === null) return undefined;
  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function reportContextDefault(ctx: ModuleContext): void {
  const raw = ctx.read(USER_SUBAGENT_CONFIG);
  let preference: string | undefined;
  if (raw !== null) {
    try {
      const value = (JSON.parse(raw) as { defaultSubagentContext?: unknown }).defaultSubagentContext;
      if (typeof value === "string") preference = value;
    } catch {
      ctx.report("warn", `${USER_SUBAGENT_CONFIG} 不是合法的 JSON，未改动`);
      return;
    }
  }
  if (preference === "fork") {
    ctx.report(
      "warn",
      `你的 ${USER_SUBAGENT_CONFIG} 设了 defaultSubagentContext: "fork"；Trellis 角色子会话必须显式 context: "fresh"，否则会继承主会话上下文而不是拿到角色上下文（本项目不写这个全局文件）`,
    );
    return;
  }
  ctx.report(
    "ok",
    preference === undefined
      ? "子会话上下文默认 fresh（pi-subagents 自带默认；本项目不写全局配置）"
      : `子会话上下文默认 ${preference}（来自你的全局配置；本项目不写它）`,
  );
}

export const subagentsModule: WorkflowModule = {
  id: "subagents",
  title: "subagent 层（复用已安装的 pi-subagents，缺失时项目级安装）",

  apply(ctx: ModuleContext): void {
    const found = detect(ctx);
    if (found) {
      const version = installedVersion(ctx);
      ctx.report("ok", `复用已安装的 ${PACKAGE}${version ? ` v${version}` : ""}（来自${found}），未安装任何东西`);
    } else if (ctx.dry) {
      ctx.report(
        "created",
        `把 ${PACKAGE_SPEC} 声明到项目 .pi/settings.json 的 packages（项目级安装；Pi 下次启动时拉取，需要项目信任）`,
      );
    } else {
      const settings = readObject(ctx, PROJECT_SETTINGS);
      if (settings === null) return;
      const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
      packages.push(PACKAGE_SPEC);
      settings.packages = packages;
      writeObject(ctx, PROJECT_SETTINGS, settings);
      ctx.report(
        "created",
        `${PACKAGE_SPEC} 声明到项目 .pi/settings.json 的 packages（项目级；Pi 下次启动时拉取，需要项目信任才加载）`,
      );
    }

    const settings = readObject(ctx, PROJECT_SETTINGS);
    if (settings === null) return;
    const subagents =
      settings.subagents !== null && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
        ? { ...(settings.subagents as JsonObject) }
        : {};
    if (subagents[ROOT_RESOLUTION_KEY] === ROOT_RESOLUTION_VALUE) {
      ctx.report("ok", `.pi/settings.json: subagents.${ROOT_RESOLUTION_KEY} = ${ROOT_RESOLUTION_VALUE}`);
    } else {
      subagents[ROOT_RESOLUTION_KEY] = ROOT_RESOLUTION_VALUE;
      settings.subagents = subagents;
      writeObject(ctx, PROJECT_SETTINGS, settings);
      ctx.report(
        "updated",
        `.pi/settings.json: subagents.${ROOT_RESOLUTION_KEY} = ${ROOT_RESOLUTION_VALUE}（worktree 里也按仓库根发现 agent）`,
      );
    }

    reportContextDefault(ctx);
  },

  remove(ctx: ModuleContext): void {
    const settings = readObject(ctx, PROJECT_SETTINGS);
    if (settings === null) return;

    // Drop the package declaration only when the user level still provides it,
    // so switching the module off never leaves the project without a runtime
    // that another project or session may still depend on.
    const userSettings = readObject(ctx, USER_SETTINGS);
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    if (declaresPackage(settings)) {
      if (declaresPackage(userSettings)) {
        settings.packages = packages.filter(
          (entry) => !(typeof entry === "string" && packageName(entry) === PACKAGE),
        );
        writeObject(ctx, PROJECT_SETTINGS, settings);
        ctx.report("updated", `已从项目 settings 移除 ${PACKAGE_SPEC}（用户级仍然提供，不影响其他项目）`);
      } else {
        ctx.report(
          "warn",
          `项目 settings 里的 ${PACKAGE_SPEC} 是唯一来源，保留它；要彻底移除跑 \`pi remove -l ${PACKAGE_SPEC}\``,
        );
      }
    }

    const subagents = settings.subagents;
    if (subagents === null || typeof subagents !== "object" || Array.isArray(subagents)) {
      if (!declaresPackage(settings)) ctx.report("ok", "项目 settings 里没有本模块写入的键");
      return;
    }
    const next = { ...(subagents as JsonObject) };
    delete next[ROOT_RESOLUTION_KEY];
    if (Object.keys(next).length === 0) delete settings.subagents;
    else settings.subagents = next;
    writeObject(ctx, PROJECT_SETTINGS, settings);
    ctx.report("updated", "已移除 .pi/settings.json 的 subagents.projectRootResolution");
  },
};
