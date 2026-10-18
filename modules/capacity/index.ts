/**
 * Module: project-scoped capacity for dispatched children.
 *
 * pi-subagents caps concurrent async runs with `maxActiveAsyncRunsPerSession`,
 * but that key lives in its own user-level config file
 * (`~/.pi/agent/extensions/subagent/config.json`) and has **no project
 * override** — its settings-file whitelist covers models, thinking, agent
 * overrides and project root resolution only. So a per-project limit cannot be
 * expressed there at all, and writing it into `.pi/settings.json` is silently
 * ignored (verified: the tool still reports `0/unlimited`).
 *
 * This module is the compatibility layer: the number comes from the project
 * (`subagentConcurrency` in `.pi/Coworkflow.json`, set from
 * `/Coworkflow:settings`), and the gate is enforced here, on `tool_call`, by
 * counting the runs pi-subagents itself would count (`core/capacity.ts`). A
 * project that never initialized Coworkflow keeps whatever its user-level
 * configuration says, because nothing here is registered there.
 *
 * What it does *not* do: it never rewrites the user's pi-subagents config, so
 * there is no file to restore, no race between two sessions in different
 * projects, and nothing left behind if Pi crashes. It also does not change
 * pi-subagents' own accounting — `subagent({ action: "status" })` keeps
 * reporting the user-level limit, which is why the settings panel shows both
 * numbers side by side.
 *
 * It also retries a failed lane once. pi-subagents reports a per-child failure
 * (observed: `Stream error occurred` after ~112 messages) but leaves recovery to
 * the model, which may not notice until it next wakes — and a lane that died
 * mid-flight is the expensive kind of silent loss. The retry re-dispatches the
 * same `agent` + `task` with `context: "fresh"`, once per child; a second failure
 * is reported as-is so the model (or the user) decides. Retries respect the same
 * capacity gate, so a retry never overshoots the project limit.
 */

import type { ModuleContext, PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { CapacityTracker, startsNewRun } from "../../core/capacity.ts";

/** The parent session file path, which is what pi-subagents records per run. */
function sessionFileOf(ctx: any): string | null {
  const file = ctx?.sessionManager?.getSessionFile?.();
  return typeof file === "string" && file ? file : null;
}

/**
 * The one admitted launch that has not been retried yet.
 *
 * pi-subagents' child-failure notification identifies the child by its own run
 * id, not by the parent's tool call id, and it does not echo the task text. When
 * exactly one admitted launch is outstanding, that launch is unambiguous; with
 * several outstanding, guessing would re-dispatch the wrong work, so nothing is
 * retried and the notification says so.
 */
function singleUnretriedLaunch(
  launches: Map<string, { agent?: string; task?: string; worktree?: boolean }>,
  retried: Set<string>,
): { agent?: string; task?: string; worktree?: boolean } | undefined {
  const candidates = [...launches.entries()].filter(([id]) => !retried.has(id));
  return candidates.length === 1 ? candidates[0]?.[1] : undefined;
}

export const capacityModule: WorkflowModule = {
  id: "capacity",
  title: "子 agent 并发上限（项目级兼容层）",

  apply(ctx: ModuleContext): void {
    const limit = ctx.options?.subagentConcurrency;
    ctx.report(
      "ok",
      typeof limit === "number"
        ? `本项目上限 ${limit}：由本扩展在派单时拦截，不写 pi-subagents 的配置文件`
        : "本项目未设上限：不拦截派单，pi-subagents 自己的（用户级）配置照旧生效",
    );
  },

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild || !host.on) return;

    const tracker = new CapacityTracker();
    // What each admitted child was asked to do, so a failure can be re-dispatched
    // with the same words. Keyed by tool call id first, then by child run id.
    const launches = new Map<string, { agent?: string; task?: string; worktree?: boolean }>();

    const notify = (pi: PiRuntimeHost, message: string): void => {
      try {
        pi.sendMessage?.({ customType: "pi-Coworkflow", content: message, display: true });
      } catch {
        // Notification is best effort; the ledger still records the failure.
      }
    };

    host.on("tool_call", (event: any, ctx: any) => {
      if (!runtime.enabled) return undefined;
      if (event?.toolName !== "subagent") return undefined;

      const input: Record<string, unknown> =
        event.input !== null && typeof event.input === "object" ? event.input : {};
      if (!startsNewRun(input)) return undefined;

      const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      // Record what was asked for before any gate can return: the retry path needs
      // it whether or not this project sets a limit, and an unset limit is the
      // common case.
      if (callId) {
        launches.set(callId, {
          agent: typeof input.agent === "string" ? input.agent : undefined,
          task: typeof input.task === "string" ? input.task : undefined,
          worktree: input.worktree === true,
        });
      }

      const limit = runtime.control.subagentConcurrency();
      if (limit === null) return undefined;
      const { runs, pending, total } = tracker.snapshot(sessionFileOf(ctx));
      if (total >= limit) {
        const running = runs
          .map((run) => `${run.agent ?? "?"}(${run.runId.slice(0, 8)}, ${run.state})`)
          .join("、");
        return {
          block: true,
          reason: [
            `本项目（Coworkflow）的子 agent 并发上限是 ${limit}，当前已有 ${total} 个活跃 async run${pending > 0 ? `（其中 ${pending} 个是本轮刚派出的）` : ""}${running ? `：${running}` : ""}。`,
            "这次派单被拦下，没有启动任何子进程。请先让其中一个结束（`bg_wait` 等待，或用 `subagent({ action: \"status\" })` 查看进度），再重新派单；",
            "也可以让用户在 `/Coworkflow:settings` 里把「子 agent 并发上限」调高（留空 = 不限）。",
          ].join(""),
        };
      }

      // Admit the call and hold its slot until the tool returns, so a second
      // dispatch in the same turn sees it even before its run exists on disk.
      if (callId) tracker.reserve(callId);
      return undefined;
    });

    host.on("tool_result", (event: any) => {
      if (event?.toolName !== "subagent") return undefined;
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (callId) tracker.release(callId);
      return undefined;
    });

    // ── One retry for a failed lane ────────────────────────────────────
    // pi-subagents announces a failed child as a `custom_message` entry
    // (`customType: "subagent-incremental-child-notify"`, `details.outcome ===
    // "failed"`). Pi surfaces those entries through `message_start` /
    // `message_end`, not through an event named "message", so that is where this
    // listens. The recovery itself is left to the model by pi-subagents, which is
    // exactly the gap: a lane that died at message 112 may not be noticed until
    // the model next wakes. It is re-dispatched here, once per child.
    const retried = new Set<string>();
    const onChildFailure = (message: any): void => {
      if (!runtime.enabled) return;
      if (message?.customType !== "subagent-incremental-child-notify") return;
      const details = message?.details;
      if (details?.outcome !== "failed") return;

      const childRunId = String(details?.childRunId ?? details?.runId ?? "");
      const key = childRunId || String(details?.childKey ?? "unknown");
      if (retried.has(key)) return;
      retried.add(key);

      const launch = childRunId ? launches.get(childRunId) : undefined;
      const single = launch ?? singleUnretriedLaunch(launches, retried);
      // A launch recorded for a *tool call* is a different key space than the
      // child run id in the notification; when exactly one launch is outstanding
      // the mapping is unambiguous, which `singleUnretriedLaunch` handles.
      const why = String(details?.error ?? message?.content ?? "").slice(0, 140);

      if (!single?.task || !single.agent) {
        notify(
          host,
          `lane 失败（${key.slice(0, 8)}：${why}），但没记录到 agent/task，无法自动重派。用 subagent({ action: "status", id: "${key}" }) 查看，或手工重派。`,
        );
        return;
      }

      notify(
        host,
        `lane 失败（${single.agent} / ${key.slice(0, 8)}：${why}），已自动重派一次（同 agent、同 task、context: fresh）。`,
      );
      try {
        host.sendUserMessage?.({
          content: [
            "Automatic retry of a failed lane (Coworkflow). The previous child failed at the transport layer, not on the task itself.",
            "Re-dispatch exactly this work now with `subagent`, then report the outcome; do not change scope:",
            "",
            `agent: ${single.agent}`,
            `task: ${single.task}`,
            'context: "fresh"',
            single.worktree ? "worktree: true" : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      } catch {
        // A retry that cannot be delivered must not break the notification path.
      }
    };

    host.on("message_end", (event: any) => {
      onChildFailure(event?.message);
      return undefined;
    });
    host.on("message_start", (event: any) => {
      onChildFailure(event?.message);
      return undefined;
    });
  },
};
