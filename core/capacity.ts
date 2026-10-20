/** Project admission classification. Native observations/reservations live in subagents-client. */

/** Only execution/revival occupies async capacity; management and foreground calls do not. */
export function startsAsyncRun(input: Record<string, unknown>): boolean {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (action && action !== "resume" && action !== "append-step") return false;
  return input.async !== false;
}
