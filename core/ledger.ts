/**
 * The dispatch ledger: one record of what this session asked a child to do.
 *
 * Two modules needed the same facts about a `subagent` call — what agent, which
 * task, whether it ran in a worktree, and which run it became — and each kept
 * its own `Map<toolCallId, …>` plus its own pair of hooks. That duplication is
 * where the retry bug came from: a failure notification identifies a child by
 * pi-subagents' own run id, while the map was keyed by Pi's tool call id, and the
 * two key spaces never meet. Recording both keys in one place, with the
 * correspondence between them, is the only shape that lets a caller answer
 * "which dispatch does this failure belong to?" at all.
 *
 * One ledger per session: `attachLedger` is idempotent per host, so every module
 * that wants the facts subscribes to the same instance instead of hooking
 * `tool_call` again.
 *
 * Recording happens for every adopted project and is independent of whether the
 * current session loaded the workflow: a lane dispatched from a session that had
 * not run `/Coworkflow:start` still produced artifacts, and leaving it out of the
 * ledger is how the ledger silently under-reports.
 */

import type { PiRuntimeHost, RuntimeContext } from "./module.ts";
import { configRoot, readConfig } from "./config.ts";

export interface Dispatch {
  /** Pi's tool call id — unique per call, stable for its whole lifetime. */
  callId: string;
  agent?: string;
  task?: string;
  worktree?: boolean;
  /** pi-subagents' run id, learned from the tool result. */
  runId?: string;
  /** pi-subagents' child key, learned from a completion notification. */
  childKey?: string;
  /** When the call was admitted, epoch ms. */
  at: number;
  /** True once the tool returned (successfully or not). */
  settled: boolean;
}

export type DispatchListener = (dispatch: Dispatch, event: any, ctx: any) => void;

/** What a `tool_call` handler may return to stop the call. */
export interface BlockDecision {
  block: true;
  reason: string;
}

/**
 * A gate runs *before* a dispatch is recorded and may refuse it.
 *
 * Gates exist for policy, not bookkeeping: a refused call never ran, so it must
 * not appear in the ledger, and the refusal must reach Pi as the handler's return
 * value. Listeners registered with `onDispatch` are for observers that cannot
 * change the outcome.
 */
export type DispatchGate = (
  input: Record<string, unknown>,
  event: any,
  ctx: any,
) => BlockDecision | undefined;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class DispatchLedger {
  private readonly dispatches = new Map<string, Dispatch>();
  private readonly byRunId = new Map<string, string>();
  private readonly onDispatchListeners: DispatchListener[] = [];
  private readonly onResultListeners: DispatchListener[] = [];
  private readonly gates: DispatchGate[] = [];

  onGate(gate: DispatchGate): void {
    this.gates.push(gate);
  }

  /** Run every gate; the first refusal wins. */
  gate(input: Record<string, unknown>, event: any, ctx: any): BlockDecision | undefined {
    for (const gate of this.gates) {
      const decision = gate(input, event, ctx);
      if (decision) return decision;
    }
    return undefined;
  }

  onDispatch(listener: DispatchListener): void {
    this.onDispatchListeners.push(listener);
  }

  onResult(listener: DispatchListener): void {
    this.onResultListeners.push(listener);
  }

  record(callId: string, input: Record<string, unknown>, at = Date.now()): Dispatch {
    const dispatch: Dispatch = {
      callId,
      ...(str(input.agent) ? { agent: str(input.agent) } : {}),
      ...(str(input.task) ? { task: str(input.task) } : {}),
      ...(input.worktree === true ? { worktree: true } : {}),
      at,
      settled: false,
    };
    this.dispatches.set(callId, dispatch);
    return dispatch;
  }

  /** Bind the run pi-subagents created for this call, so a run id can find it. */
  bindRun(callId: string, runId: string): void {
    const dispatch = this.dispatches.get(callId);
    if (!dispatch) return;
    dispatch.runId = runId;
    this.byRunId.set(runId, callId);
  }

  get(callId: string): Dispatch | undefined {
    return this.dispatches.get(callId);
  }

  settle(callId: string): void {
    const dispatch = this.dispatches.get(callId);
    if (dispatch) dispatch.settled = true;
  }

  /**
   * The dispatch a completion notification refers to.
   *
   * The notification carries `childKey` and `childRunId`; a plain dispatch only
   * ever learns its `runId`, so either identifier is tried. Nothing is inferred
   * from "how many dispatches are outstanding" — guessing the target of a failure
   * is how the wrong work gets retried.
   */
  resolve(identifiers: { runId?: string; childKey?: string }): Dispatch | undefined {
    for (const id of [identifiers.runId, identifiers.childKey]) {
      if (!id) continue;
      const callId = this.byRunId.get(id);
      const dispatch = callId ? this.dispatches.get(callId) : undefined;
      if (dispatch) return dispatch;
      for (const candidate of this.dispatches.values()) {
        if (candidate.runId === id || candidate.childKey === id) return candidate;
      }
    }
    return undefined;
  }

  /** Keep the ledger from growing for the life of a long session. */
  prune(keep = 200): void {
    if (this.dispatches.size <= keep) return;
    const settled = [...this.dispatches.values()]
      .filter((dispatch) => dispatch.settled)
      .sort((a, b) => a.at - b.at);
    for (const dispatch of settled.slice(0, this.dispatches.size - keep)) {
      this.dispatches.delete(dispatch.callId);
      if (dispatch.runId) this.byRunId.delete(dispatch.runId);
    }
  }

  /** Called by the recorder only. */
  emitDispatch(dispatch: Dispatch, ctx: any): void {
    for (const listener of this.onDispatchListeners) listener(dispatch, undefined, ctx);
  }

  /** Called by the recorder only. */
  emitResult(dispatch: Dispatch, event: any, ctx: any): void {
    for (const listener of this.onResultListeners) listener(dispatch, event, ctx);
  }
}

/** Whether a `subagent` call starts a new run rather than reading or managing. */
export function startsNewRun(input: Record<string, unknown>): boolean {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (action && action !== "resume" && action !== "append-step") return false;
  // A foreground call blocks the parent and reserves no async slot in
  // pi-subagents' own accounting, so it is not counted here either.
  if (input.async === false) return false;
  return true;
}

/** Whether this project has adopted the workflow (`.pi/Coworkflow.json` exists). */
export function adopted(root: string): boolean {
  return readConfig(configRoot(root)) !== null;
}

/** The parent session file path, which is what pi-subagents records per run. */
export function sessionFileOf(ctx: any): string | null {
  const file = ctx?.sessionManager?.getSessionFile?.();
  return typeof file === "string" && file ? file : null;
}

/** One ledger per host: attaching twice must not double the recording hooks. */
const LEDGERS = new WeakMap<PiRuntimeHost, DispatchLedger>();

/**
 * The session's ledger, recording `subagent` dispatches on first use.
 *
 * Modules that want the facts subscribe with `ledger.onDispatch` /
 * `ledger.onResult`; none of them needs to register `tool_call` itself.
 */
export function attachLedger(host: PiRuntimeHost, runtime: RuntimeContext): DispatchLedger {
  const existing = LEDGERS.get(host);
  if (existing) return existing;

  const ledger = new DispatchLedger();
  LEDGERS.set(host, ledger);
  if (runtime.isChild || !host.on) return ledger;

  host.on("tool_call", (event: any, ctx: any) => {
    if (event?.toolName !== "subagent") return undefined;
    if (!adopted(runtime.cwd ?? ctx?.cwd ?? "")) return undefined;
    const input: Record<string, unknown> =
      event.input !== null && typeof event.input === "object" ? event.input : {};
    if (!startsNewRun(input)) return undefined;
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!callId) return undefined;
    const refused = ledger.gate(input, event, ctx);
    if (refused) return refused;
    const dispatch = ledger.record(callId, input);
    ledger.prune();
    ledger.emitDispatch(dispatch, ctx);
    return undefined;
  });

  host.on("tool_result", (event: any, ctx: any) => {
    if (event?.toolName !== "subagent") return undefined;
    const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!callId) return undefined;
    const dispatch = ledger.get(callId);
    if (!dispatch) return undefined;
    ledger.settle(callId);
    ledger.emitResult(dispatch, event, ctx);
    return undefined;
  });

  return ledger;
}
