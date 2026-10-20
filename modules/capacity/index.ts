/**
 * Module: project-scoped capacity for dispatched children.
 *
 * pi-subagents caps concurrent async runs with `maxActiveAsyncRunsPerSession`,
 * but that key lives in its own user-level config file and has **no project
 * override** — its settings-file whitelist covers models, thinking, agent
 * overrides and project root resolution only. So a per-project limit cannot be
 * expressed there at all, and writing it into `.pi/settings.json` is silently
 * ignored.
 *
 * This module is the compatibility layer: the number comes from the project
 * (`subagentConcurrency` in `.pi/Coworkflow.json`, set from
 * `/Coworkflow:settings`), and the gate is enforced here as a ledger gate on
 * `tool_call`, by counting the runs pi-subagents itself would count
 * (`core/capacity.ts`). A project that never initialized Coworkflow keeps
 * whatever its user-level configuration says, because nothing here is registered
 * there.
 *
 * What it does *not* do: it never rewrites the user's pi-subagents config, so
 * there is no file to restore, no race between two sessions in different
 * projects, and nothing left behind if Pi crashes. It also does not change
 * pi-subagents' own accounting — `subagent({ action: "status" })` keeps
 * reporting the user-level limit, which is why the settings panel shows both
 * numbers side by side.
 *
 * It also does not retry a failed child. An earlier version did, by guessing the
 * failed dispatch from "the one launch still outstanding" — which was wrong in a
 * way that scaled badly: a failure notification is keyed by pi-subagents' own run
 * id, the guess was keyed by Pi's tool call id, and the fallback therefore fired
 * for *any* failure once one dispatch was outstanding, re-dispatching work that
 * had already finished. Recovery belongs to the model that owns the dispatch and
 * to pi-subagents' own notifications.
 *
 * The count is read from pi-subagents' run directory, which is its state, not its
 * API. `core/pi-subagents.ts` probes that shape; when it does not hold, the gate
 * refuses loudly instead of silently admitting everything.
 */

import type { ModuleContext, PiRuntimeHost, RuntimeContext, WorkflowModule } from "../../core/module.ts";
import { CapacityTracker } from "../../core/capacity.ts";
import { attachLedger, sessionFileOf, type BlockDecision } from "../../core/ledger.ts";
import { probeRunLedger } from "../../core/pi-subagents.ts";

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
    const probe = probeRunLedger();
    if (probe.state === "broken") {
      ctx.report(
        "warn",
        `pi-subagents 的 run 记录缺少 ${probe.missing.join("、")}：本项目上限无法计数，派单会被拦下（见 core/pi-subagents.ts）`,
      );
    }
  },

  activate(host: PiRuntimeHost, runtime: RuntimeContext): void {
    if (runtime.isChild || !host.on) return;

    const tracker = new CapacityTracker();
    // The ledger records each admitted dispatch once per session and runs the
    // gates before recording, so a refused call never enters the ledger.
    attachLedger(host, runtime).onGate((_input, event, ctx): BlockDecision | undefined => {
      if (!runtime.enabled) return undefined;
      const limit = runtime.control.subagentConcurrency();
      if (limit === null) return undefined;

      // A project limit that cannot be counted is worse than no limit: it looks
      // enforced. Probe the contract the count depends on and stand down loudly.
      const probe = probeRunLedger();
      if (probe.state === "broken") {
        return {
          block: true,
          reason: [
            `本项目设了子 agent 并发上限 ${limit}，但读不到 pi-subagents 的 run 记录（status.json 缺 ${probe.missing.join("、")}），无法计数。`,
            "为避免把上限变成一句空话，这次派单被拦下。请在 `/Coworkflow:settings` 里清空「本项目并发上限」（留空 = 不限），或升级 pi-subagents。",
          ].join(""),
        };
      }

      const { runs, pending, total } = tracker.snapshot(sessionFileOf(ctx));
      if (total < limit) {
        // Admit the call and hold its slot until the tool returns, so a second
        // dispatch in the same turn sees it even before its run exists on disk.
        const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
        if (callId) tracker.reserve(callId);
        return undefined;
      }

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
    });

    host.on("tool_result", (event: any) => {
      if (event?.toolName !== "subagent") return undefined;
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (callId) tracker.release(callId);
      return undefined;
    });
  },
};
