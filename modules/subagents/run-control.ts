/**
 * Interrupting a run this session started: `stop` and `steer`.
 *
 * The point of this file is a distinction the owner documents and a caller is
 * tempted to collapse: a successful `stop` reply means *the request was accepted*
 * (`state: "stopping"`), never that the run terminated. So every report here is
 * two facts, printed as two facts:
 *
 *   - what pi-subagents acknowledged, in its own words;
 *   - what a follow-up public `status` read says now — or that it could not say.
 *
 * Nothing here prints "已停止". A stop that failed, timed out, was refused, or
 * could not be sent leaves the run's state unconfirmed, which is what the report
 * says. And nothing here invents a capability: when the installed owner does not
 * advertise `stop`/`steer`, the request is not sent at all.
 */

import type { PiRuntimeHost, RuntimeContext } from "../../core/module.ts";
import { attachSubagents, type NativeActivity } from "../../core/subagents-client.ts";

/** One control attempt: whether it was accepted, and the lines to show. */
export interface RunControlReport {
  /** True only when the owner acknowledged the request. Never "the run is over". */
  accepted: boolean;
  lines: string[];
}

/** What the public projection says about one run right now. */
type RunState =
  | { kind: "known"; state: string }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

function stateOf(activity: NativeActivity, runId: string): RunState {
  if (activity.kind === "unknown") return { kind: "unknown", reason: activity.reason };
  const run = activity.runs.find((entry) => entry.id === runId);
  if (run === undefined) return { kind: "absent" };
  return { kind: "known", state: run.state };
}

/** `running（还在运行）` — the owner's state plus what it means for a stop request. */
function describeState(state: string): string {
  switch (state) {
    case "running":
      return "running（还在运行）";
    case "queued":
      return "queued（还在排队，尚未开始）";
    case "stopping":
      return "stopping（停止请求进行中，不等于已终止）";
    case "stopped":
      return "stopped（pi-subagents 报告的状态；终止仍需进程终止证据）";
    case "paused":
      return "paused（已暂停，未终止）";
    case "rejected":
      return "rejected（未被接受执行）";
    default:
      return state;
  }
}

function bridgeFor(host: PiRuntimeHost, runtime: RuntimeContext) {
  return attachSubagents(host, { epoch: runtime.sessionEpoch, events: host.events });
}

/**
 * Ask pi-subagents to stop one run, then read the public state once.
 *
 * The second read exists so "accepted" and "terminated" are visually distinct in
 * the output: the first line is the acknowledgement, the second is what the
 * owner's own projection says afterwards. When that read is unavailable or the run
 * is no longer listed, the report says so instead of implying termination.
 */
export async function requestStop(
  host: PiRuntimeHost,
  runtime: RuntimeContext,
  runId: string,
): Promise<RunControlReport> {
  const bridge = bridgeFor(host, runtime);
  const epoch = runtime.sessionEpoch;
  const reply = await bridge.client.stop({ id: runId });
  if (!reply.ok) {
    // A missing capability is not a failed stop: nothing was sent, and saying so
    // keeps a reader from looking for a run that was never asked to stop.
    if (reply.reason === "unavailable") return { accepted: false, lines: [reply.message] };
    return {
      accepted: false,
      lines: [
        `停止请求没有成功：${reply.message}`,
        "run 是否仍在运行未确认：本扩展不把失败的停止请求当成「已停止」，也不会自动重试。",
      ],
    };
  }
  if (runtime.sessionEpoch !== epoch) {
    return {
      accepted: true,
      lines: [
        `pi-subagents 已接受停止 run ${runId} 的请求（state: ${reply.data.state}）。`,
        "但本会话已被替换：停止之后的状态无法在当前会话确认，请在新的会话里用 `subagent({ action: \"status\", id })` 复核。",
      ],
    };
  }

  const lines = [
    `pi-subagents 已接受停止 run ${runId} 的请求（state: ${reply.data.state}${
      reply.data.previousState ? `，请求前状态: ${reply.data.previousState}` : ""
    }${reply.data.childId ? `，child: ${reply.data.childId}` : ""}）。`,
    "这是「请求已被接受」，不是「run 已经结束」：终止要由 status 与进程终止证据确认。",
  ];
  // One bounded follow-up read, not a poll loop: this command is a report, and a
  // timer here would be a scheduler nobody asked for.
  const after = stateOf(await bridge.observe(), runId);
  if (after.kind === "known") {
    lines.push(`停止后的公开状态: ${describeState(after.state)}。`);
    if (after.state === "running" || after.state === "queued" || after.state === "stopping") {
      lines.push("停止尚未生效：稍后用 `subagent({ action: \"status\", id })` 或 /Coworkflow:lanes 重读，直到状态与进程终止证据都显示结束。");
    }
  } else if (after.kind === "absent") {
    lines.push("停止后的公开状态里已经没有这个 run：可能已经结束，但缺少终止证据，请用 `subagent({ action: \"status\", id })` 复核后再当作已结束。");
  } else {
    lines.push(`停止后的公开状态无法读取：${after.reason}`);
    lines.push("终止仍未确认。");
  }
  return { accepted: true, lines };
}

/**
 * Deliver instructions to a running run without killing it.
 *
 * The instructions travel as data in the RPC params: no shell, no code, no
 * interpolation — `message` is the owner's own documented field for it.
 */
export async function requestSteer(
  host: PiRuntimeHost,
  runtime: RuntimeContext,
  runId: string,
  message: string,
): Promise<RunControlReport> {
  const bridge = bridgeFor(host, runtime);
  const reply = await bridge.client.steer({ id: runId, message });
  if (!reply.ok) {
    if (reply.reason === "unavailable") return { accepted: false, lines: [reply.message] };
    return {
      accepted: false,
      lines: [
        `指令没有送达：${reply.message}`,
        "run 没有被停止（steer 只追加指令），是否收到这些指令未确认。",
      ],
    };
  }
  const delivery = reply.data.deliveryStatus;
  return {
    accepted: true,
    lines: [
      `已把指令交给 pi-subagents（run ${runId}${delivery ? `，deliveryStatus: ${delivery}` : ""}）。`,
      "steer 只追加指令，不杀进程：run 继续运行。",
      delivery === "queued"
        ? "指令还在队列里，子 agent 尚未读到：它会在下一步取到，不是已经执行。"
        : "指令已送达该子 agent。",
      ...(reply.data.text ? [reply.data.text] : []),
    ],
  };
}
