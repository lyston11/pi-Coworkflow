/** Project async admission over the shared public bridge. No lifecycle ledger. */
import type { PiRuntimeHost, RuntimeContext, Unsubscribe, WorkflowModule } from "../../core/module.ts";
import { startsAsyncRun } from "../../core/capacity.ts";
import { attachSubagents, existingSubagentsBridge } from "../../core/subagents-client.ts";
import { decodeNativeResult, decodeNativeCompletions, readUserConfig } from "../../core/pi-subagents.ts";

interface State {
  runtime: RuntimeContext;
  closed: boolean;
  listeners: Map<string, Unsubscribe | void>;
}
const STATES = new WeakMap<PiRuntimeHost, State>();

export const capacityModule: WorkflowModule = {
  id: "capacity",
  title: "子 agent 并发（项目上限；复用公开 status）",
  activate(host, runtime) {
    if (runtime.isChild || !host.on) return;
    let state = STATES.get(host);
    if (!state) {
      state = { runtime, closed: false, listeners: new Map() };
      STATES.set(host, state);
    }
    state.runtime = runtime;
    state.closed = false;
    const current = state;
    const listen = (name: string, handler: (event: any, ctx: any) => any) => {
      if (!current.listeners.has(name)) current.listeners.set(name, host.on!(name, handler));
    };
    const enabled = () => !current.closed && !current.runtime.isChild && current.runtime.enabled &&
      current.runtime.control.moduleEnabled("capacity");
    listen("tool_call", async (event) => {
      if (event?.toolName !== "subagent" || !enabled()) return;
      const input = event.input;
      if (!input || typeof input !== "object" || !startsAsyncRun(input)) return;
      const rt = current.runtime;
      const limit = rt.control.subagentConcurrency();
      if (limit === null) return;
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return { block: true, reason: "无法关联 toolCallId，不能安全保留本项目并发名额。" };
      const epoch = rt.sessionEpoch;
      const bridge = attachSubagents(host, { epoch, events: host.events });
      const admission = await bridge.admit(id, limit);
      if (current.closed || current.runtime.sessionEpoch !== epoch) {
        bridge.release(id);
        return { block: true, reason: "会话已更换，未启动子进程。" };
      }
      if (!enabled()) { bridge.release(id); return; }
      if (!admission.admit) return { block: true, reason: admission.reason };
      // Direct calls retain their originating toolCallId as a public status alias.
      bridge.trackAlias(id, id);
    });
    listen("tool_result", (event) => {
      if (event?.toolName !== "subagent" || current.closed) return;
      // Always settle an existing reservation, even if the switch changed mid-call.
      const bridge = existingSubagentsBridge(host);
      if (!bridge || bridge.epoch !== current.runtime.sessionEpoch) return;
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const result = decodeNativeResult(event.details);
      if (result) bridge.bind(id, result.runId);
      else if (event.isError === true) bridge.release(id);
    });
    listen("message_end", (event) => {
      if (!enabled()) return;
      const bridge = existingSubagentsBridge(host);
      for (const completion of decodeNativeCompletions(event?.message)) bridge?.releaseRun(completion.runId);
    });
  },
  onSessionEnd(host) {
    const state = STATES.get(host);
    if (!state) return;
    state.closed = true;
    for (const [name, off] of state.listeners) {
      if (typeof off === "function") { off(); state.listeners.delete(name); }
    }
    existingSubagentsBridge(host)?.dispose();
  },
  apply(ctx) {
    const limit = readUserConfig()?.maxActiveAsyncRunsPerSession;
    ctx.report("ok", `项目并发通过公开 status 检查 direct async tool 与 /Coworkflow:run；上游自身上限${limit === undefined ? "不限" : `为 ${limit}`}，不改全局配置。其他扩展自行发起的 RPC 不受本项目 gate 管理。`);
  },
  remove(ctx) { ctx.report("ok", "本项目并发拦截已关闭；pi-subagents 的上限保持不变"); },
};
