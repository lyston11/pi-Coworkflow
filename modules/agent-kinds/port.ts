/**
 * The kind port's programmatic side.
 *
 * A project definition file is the port's source of truth; this is the documented way for
 * another extension or program to *write* one without hand-editing frontmatter. It goes through
 * the same writer the `/Coworkflow:kind` command uses, on purpose: an in-memory registration
 * would disappear on `/reload` — the opposite of what this port promises — and would make "what
 * is this kind" answerable in two places that can disagree.
 *
 * The envelope mirrors the owner's own RPC convention (`<channel>:request` with replies on
 * `<channel>:reply:<requestId>`) so a client that already speaks one speaks both.
 */

import type { ExtensionEvents, PiRuntimeHost, RuntimeContext, WorkflowControl } from "../../core/module.ts";
import { readKindDefinitions } from "./definitions.ts";
import { resolveKinds } from "./defaults.ts";
import { readConfig } from "../../core/config.ts";

export const KIND_PORT_CHANNEL = "coworkflow:kind:v1";
export const KIND_PORT_REQUEST = `${KIND_PORT_CHANNEL}:request`;
export const KIND_PORT_REPLY_PREFIX = `${KIND_PORT_CHANNEL}:reply:`;
export const KIND_PORT_VERSION = 1;

/** The methods a client may call. Anything else is refused by name. */
export const KIND_PORT_METHODS = ["list", "show", "define", "remove"] as const;

export interface KindPortRequest {
  version: number;
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
  source?: { extension?: string };
}

export interface KindPortReply {
  version: number;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** One kind as the port reports it: what the session would actually use. */
function kindView(control: WorkflowControl, root: string | null): unknown[] {
  const definitions = root === null ? new Map() : readKindDefinitions(root).definitions;
  return resolveKinds(root === null ? null : readConfig(root), definitions).map((entry) => ({
    kind: entry.kind,
    agent: entry.agent,
    label: entry.label,
    role: entry.role,
    context: entry.context,
    enabled: entry.enabled,
    maxConcurrent: entry.maxConcurrent,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
    source: entry.source,
    chosen: entry.chosen ?? {},
  }));
}

/**
 * Register the request listener for this host.
 *
 * Returns an unsubscribe so a session end can release it; a listener that outlives its session
 * would answer for a project the caller is no longer in.
 */
export function registerKindPort(
  host: PiRuntimeHost,
  runtime: RuntimeContext,
  control: WorkflowControl,
): () => void {
  const events: ExtensionEvents | undefined = host.events;
  if (events === undefined) return () => {};
  return events.on(KIND_PORT_REQUEST, (raw: unknown) => {
    const request = raw as KindPortRequest | null;
    if (request === null || typeof request !== "object") return;
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    if (!requestId) return;
    const reply = (body: Omit<KindPortReply, "version" | "requestId">): void => {
      try {
        events.emit(`${KIND_PORT_REPLY_PREFIX}${requestId}`, {
          version: KIND_PORT_VERSION,
          requestId,
          ...body,
        } satisfies KindPortReply);
      } catch {
        // A reply that cannot be sent must not take the caller's request down with it.
      }
    };
    const refuse = (code: string, message: string): void => reply({ ok: false, error: { code, message } });

    if (request.version !== KIND_PORT_VERSION) {
      return refuse("unsupported_version", `本端口只支持 version ${KIND_PORT_VERSION}：${String(request.version)}`);
    }
    if (!(KIND_PORT_METHODS as readonly string[]).includes(request.method)) {
      return refuse("unsupported_method", `未知方法 ${String(request.method)}；可用：${KIND_PORT_METHODS.join("、")}`);
    }
    // The layer has to be live in this session: a port that writes definitions while the
    // kinds are not registered would report a success nothing acts on.
    if (runtime.isChild) return refuse("child_session", "子会话不注册 kind，也不接受定义写入");
    if (!runtime.enabled || !control.moduleEnabled("agent-kinds")) {
      return refuse("module_off", "本会话的 agent-kinds 模块未加载或已关闭");
    }
    const root = control.configRoot();
    if (root === null) return refuse("no_root", "无法确定本项目的配置根");

    void (async () => {
      try {
        const params = (request.params ?? {}) as Record<string, unknown>;
        if (request.method === "list") return reply({ ok: true, result: { kinds: kindView(control, root) } });
        const kind = typeof params.kind === "string" ? params.kind.trim() : "";
        if (!kind) return refuse("invalid_params", "缺少 kind");
        if (request.method === "show") {
          const found = (kindView(control, root) as { kind: string }[]).find((entry) => entry.kind === kind);
          return found === undefined
            ? refuse("unknown_kind", `没有 kind ${kind}`)
            : reply({ ok: true, result: found });
        }
        if (request.method === "remove") {
          const message = await control.removeKind(kind);
          return reply({ ok: true, result: { message } });
        }
        // `define`: the payload is the definition's fields, and the writer validates it before
        // anything touches the disk, so a rejected value cannot leave a half-written file.
        const patch: Record<string, unknown> = {};
        for (const key of ["label", "agent", "role", "context", "description", "model", "thinking", "maxConcurrent", "enabled", "prompt"]) {
          if (params[key] !== undefined) patch[key] = params[key];
        }
        if (Object.keys(patch).length === 0) return refuse("invalid_params", "define 需要至少一个字段");
        const message = await control.defineKind(kind, patch);
        return reply({ ok: true, result: { message } });
      } catch (error) {
        refuse("failed", error instanceof Error ? error.message : String(error));
      }
    })();
  });
}
