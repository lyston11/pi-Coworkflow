/**
 * What a child was doing, read from the tail of its own session log.
 *
 * A parent cannot watch a child's tools live: `pi.events` is in-process, so a
 * child's activity never crosses back to the parent. That limit is real, and this
 * file does not pretend otherwise. But the public `cost` reply attributes a
 * `sessionFile` to every child it can read, and this package already reads those
 * exact files — bounded, by absolute pointer, never by scanning a directory — to
 * build child usage history. The last records in that file are what the child has
 * written so far, so a bounded *tail read* answers "what was it doing" without
 * inventing an event stream. It is described that way everywhere it surfaces:
 * `正在 …（读自子会话日志尾部）`, not "live activity".
 *
 * The rules, all of which the tests pin:
 *
 *   - **Bounded.** At most 64 KiB of tail per file, at most 16 runs per refresh.
 *     `open` + `read` at an offset, `O_NONBLOCK`, `stat` first, ordinary files
 *     only — the same discipline `core/usage.ts` uses for the same files.
 *   - **Defensive about a file being appended to.** A JSONL line can be half
 *     written, so unparseable lines are dropped (including the partial first line
 *     of a tail read and a partial final line) instead of failing the read.
 *   - **Attributed, never joined.** An action is keyed by `cost.children[].runId`,
 *     a real run id. A fleet row's `key` is an opaque display key and is never
 *     treated as a run id here or anywhere downstream.
 *   - **Never a guess.** A permission error, a vanished file, a path that is not a
 *     regular file, or a tail with nothing parseable is an explicit absence with a
 *     reason — never an empty string that reads as "idle".
 *   - **Never polled.** Reads happen at the boundaries usage already refreshes at
 *     (session start, `agent_settled`, native completion, panel open); rendering
 *     reads a cache. There is no timer in this file.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RuntimeContext } from "./module.ts";
import type { NativeCost } from "./subagents-client.ts";

/** Tail budget per file. A child's last records are what "now" means, not its history. */
export const MAX_TAIL_BYTES = 64 * 1024;
/** Runs per refresh: the panel's run list is bounded to 8, so this is slack, not a ceiling to grow. */
export const MAX_TAIL_RUNS = 16;
/** A hint is a path or a command fragment, never a prompt or a file body. */
export const MAX_HINT_CHARS = 60;
const MAX_TEXT_CHARS = 80;
const MAX_TOOL_NAME_CHARS = 64;

/** The last thing a child wrote that says what it was doing. */
export type ChildTailAction =
  | { kind: "tool"; tool: string; hint?: string }
  | { kind: "text"; text: string };

/**
 * A readable tail.
 *
 * `action: null` is an explicit absence (nothing parseable in the tail), which is
 * different from an empty action string and from an unreadable file.
 */
export interface ChildTailRead {
  kind: "known";
  action: ChildTailAction | null;
  /** Parsed entries inside the bounded tail — not the run's total turn count. */
  turns: number;
  /** Lines dropped as unparseable (a half-written append, a partial head of the tail). */
  dropped: number;
  /** Bytes read, and the offset they were read from; a test asserts the read is a tail. */
  bytes: number;
  offset: number;
  note?: string;
}

export type ChildTail = ChildTailRead | { kind: "unknown"; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** One line, control characters gone, truncated with an ellipsis. */
function flatten(value: string, budget: number): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= budget ? flat : `${flat.slice(0, budget)}…`;
}

/**
 * Argument keys safe to show.
 *
 * A whitelist, not "the first string argument": `edit`/`write` carry the file body
 * and `subagent` carries a whole prompt in `task`, so showing an arbitrary argument
 * would leak a file or a prompt into a one-line panel row.
 */
const HINT_KEYS = ["command", "file_path", "filePath", "path", "pattern", "glob", "query", "url"] as const;

function hintFrom(raw: unknown): string | undefined {
  let args = raw;
  if (typeof args === "string") {
    // A serialized argument blob is parsed for its keys; if it is not JSON it is
    // skipped rather than shown, because it may be the whole prompt.
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  const record = asRecord(args);
  if (record === null) return undefined;
  for (const key of HINT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return flatten(value, MAX_HINT_CHARS);
  }
  return undefined;
}

const TOOL_CALL_TYPES = new Set(["toolCall", "tool_call", "toolUse", "tool_use"]);

function toolAction(item: Record<string, unknown>): ChildTailAction | null {
  const name = asText(item.name) ?? asText(item.toolName);
  if (name === undefined) return null;
  const tool = flatten(name, MAX_TOOL_NAME_CHARS);
  if (!tool) return null;
  const hint = hintFrom(item.arguments ?? item.input ?? item.args);
  return hint === undefined ? { kind: "tool", tool } : { kind: "tool", tool, hint };
}

/** Content items of an assistant message entry, or null for any other record. */
function assistantContent(entry: unknown): unknown[] | null {
  const row = asRecord(entry);
  if (row === null || row.type !== "message") return null;
  const message = asRecord(row.message);
  if (message === null || message.role !== "assistant") return null;
  if (Array.isArray(message.content)) return message.content;
  return typeof message.content === "string" ? [message.content] : null;
}

function lastText(content: unknown[]): string | undefined {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const item = content[index];
    if (typeof item === "string") {
      if (item.trim()) return item;
      continue;
    }
    const record = asRecord(item);
    if (record === null || record.type !== "text") continue;
    const text = asText(record.text);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * The last tool invocation, else the last assistant text, else nothing.
 *
 * Tool invocations win over later prose because a tool call is the more specific
 * answer to "what is it doing"; the prose pass exists for a child that has finished
 * its last tool and is now writing.
 */
function latestAction(entries: unknown[]): ChildTailAction | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const content = assistantContent(entries[index]);
    if (content === null) continue;
    for (let item = content.length - 1; item >= 0; item -= 1) {
      const record = asRecord(content[item]);
      if (record === null || !TOOL_CALL_TYPES.has(String(record.type))) continue;
      const action = toolAction(record);
      if (action !== null) return action;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const content = assistantContent(entries[index]);
    if (content === null) continue;
    const text = lastText(content);
    if (text !== undefined) return { kind: "text", text: flatten(text, MAX_TEXT_CHARS) };
  }
  return null;
}

/**
 * Read the tail of one child session log.
 *
 * Never throws: every failure is `{ kind: "unknown", reason }`, the same way the
 * rest of this package treats data it cannot read. `budget` is a parameter so a
 * test can assert the read is bounded by an offset rather than by luck.
 */
export async function readChildTail(path: unknown, budget = MAX_TAIL_BYTES): Promise<ChildTail> {
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) {
    return { kind: "unknown", reason: "子会话日志没有可用的绝对路径" };
  }
  const limit = Math.max(1, Math.min(MAX_TAIL_BYTES, Math.floor(budget)));
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { kind: "unknown", reason: "无法打开子会话日志（不存在或不可读）" };
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return { kind: "unknown", reason: "子会话日志不是普通文件" };
    const size = stat.size;
    const offset = Math.max(0, size - limit);
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(buffer, read, length - read, offset + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    let body = buffer.subarray(0, read).toString("utf8");
    const droppedHead = offset > 0;
    if (droppedHead) {
      // The first line of a tail read almost always starts mid-record.
      const newline = body.indexOf("\n");
      body = newline === -1 ? "" : body.slice(newline + 1);
    }
    const entries: unknown[] = [];
    let dropped = droppedHead ? 1 : 0;
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A child appends while we read: a partial line is expected, not an error.
        dropped += 1;
      }
    }
    const action = latestAction(entries);
    const read0: ChildTailRead = {
      kind: "known",
      action,
      turns: entries.length,
      dropped,
      bytes: read,
      offset,
    };
    if (action === null) {
      read0.note = entries.length === 0
        ? "子会话日志尾部没有可解析的记录"
        : "子会话日志尾部没有工具调用或助手文本";
    }
    return read0;
  } catch {
    return { kind: "unknown", reason: "读取子会话日志失败" };
  } finally {
    await file.close().catch(() => {});
  }
}

/** The one-line label a panel row shows for an action. */
export function formatChildAction(action: ChildTailAction): string {
  if (action.kind === "text") return `输出「${action.text}」`;
  return action.hint === undefined ? action.tool : `${action.tool} ${action.hint}`;
}

interface TailState {
  runtime: RuntimeContext;
  epoch: number;
  sessionId: string | null;
  actions: Map<string, string>;
  /** The refresh generation that published these actions. */
  generation: number;
}

let generation = 0;
const states = new WeakMap<object, TailState>();
/** The generation a host was disposed at, so an in-flight refresh cannot republish. */
const disposals = new WeakMap<object, number>();

/**
 * The cached action per run id, for synchronous rendering.
 *
 * Empty when nothing has been read for this session: a render must not start a
 * read, and "no action" must not become "an empty action".
 */
export function childTailActions(host: object, runtime: RuntimeContext): Map<string, string> {
  const state = states.get(host);
  if (!runtime.enabled || state === undefined || state.runtime !== runtime ||
      state.epoch !== runtime.sessionEpoch || state.sessionId !== runtime.sessionId) {
    return new Map();
  }
  return state.actions;
}

export function disposeChildTails(host: object): void {
  states.delete(host);
  disposals.set(host, ++generation);
}

/**
 * Refresh the cached actions from one public `cost` reply.
 *
 * Attribution is `child.runId` + `child.sessionFile`, both from the reply: no
 * fleet row is involved, and a child without an absolute `sessionFile` contributes
 * nothing rather than a guessed path. The map is replaced, not merged, so a run
 * that is no longer in the reply loses its action instead of lingering as if it
 * were still doing something.
 */
export async function refreshChildTails(host: object, runtime: RuntimeContext, cost: NativeCost): Promise<void> {
  if (runtime.isChild || !runtime.enabled) {
    disposeChildTails(host);
    return;
  }
  // Published only after the reads finish: a render that runs mid-refresh keeps the
  // previous actions instead of seeing a half-built map, and a refresh that a later
  // session superseded cannot overwrite it.
  const mine = ++generation;
  const epoch = runtime.sessionEpoch;
  const sessionId = runtime.sessionId;
  const actions = new Map<string, string>();
  if (cost.kind === "known") {
    const read = new Map<string, ChildTail>();
    for (const child of cost.children.slice(0, MAX_TAIL_RUNS)) {
      const runId = child.runId;
      const path = child.sessionFile;
      if (runId === undefined || path === undefined || !isAbsolute(path)) continue;
      let tail = read.get(path);
      if (tail === undefined) {
        tail = await readChildTail(path);
        read.set(path, tail);
      }
      if (tail.kind !== "known" || tail.action === null) continue;
      actions.set(runId, formatChildAction(tail.action));
    }
  }
  if (!runtime.enabled || runtime.sessionEpoch !== epoch || runtime.sessionId !== sessionId) return;
  if ((disposals.get(host) ?? 0) >= mine) return;
  const existing = states.get(host);
  if (existing !== undefined && existing.generation > mine) return;
  states.set(host, { runtime, epoch, sessionId, actions, generation: mine });
}
