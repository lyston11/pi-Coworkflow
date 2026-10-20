import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PiRuntimeHost, RuntimeContext } from "../core/module.ts";
import { collectUsageHistory, disposeUsage, formatNativeCost, refreshUsage, usageSnapshot } from "../core/usage.ts";
import { existingSubagentsBridge } from "../core/subagents-client.ts";
import { registerModelPanel, type ModelPanel } from "../modules/panel/models.ts";
import coworkflow, { controlSurface } from "../extensions/coworkflow.ts";

const totals = (input = 0) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: input ? 1 : 0 });
const entry = (input: number, model = "m", timestamp = new Date().toISOString()) => ({
  type: "message", timestamp, message: { role: "assistant", provider: "p", model, usage: totals(input) },
});
function report(children: { sessionFile?: string; input?: number }[] = [], unresolved = 0, parent = 0) {
  const rows = children.map((child, i) => ({ label: `child-${i}`, agent: "worker", runId: `run-${i}`,
    ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}), usage: totals(child.input ?? 10) }));
  const childTotal = rows.reduce((sum, child) => ({ ...sum, input: sum.input + child.usage.input,
    turns: sum.turns + child.usage.turns }), totals());
  return { version: 1, parent: totals(parent), children: rows, childTotal,
    total: { ...childTotal, input: childTotal.input + parent, turns: childTotal.turns + (parent ? 1 : 0) },
    unresolvedAsyncChildren: unresolved };
}
function bus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const requests: Record<string, any>[] = [];
  const held: Record<string, any>[] = [];
  let data: unknown = report();
  let supported = true;
  let hold = false;
  const emit = (name: string, value: unknown) => { for (const fn of listeners.get(name) ?? []) fn(value); };
  const reply = (request: Record<string, any>, value: unknown) => emit(`subagents:rpc:v1:reply:${request.requestId}`,
    { version: 1, requestId: request.requestId, success: true, data: value });
  return {
    requests, held,
    set(value: unknown) { data = value; },
    support(value: boolean) { supported = value; },
    hold(value: boolean) { hold = value; },
    reply,
    count() { return requests.filter((request) => request.method === "cost").length; },
    listeners() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); },
    emit(name: string, value: unknown) {
      if (name !== "subagents:rpc:v1:request") return emit(name, value);
      const request = value as Record<string, any>;
      requests.push(request);
      if (request.method === "cost" && hold) { held.push(request); return; }
      const valueAtRequest = request.method === "ping" ? {
        version: 1, methods: ["status", "cost"], capabilities: { cost: supported ? { version: 1 } : null, fleetStatus: { version: 1 } },
        events: {}, session: { sessionId: "session" },
      } : request.method === "status" ? { fleet: { version: 1, totalActive: 0, omitted: 0, entries: [], topLevelAsyncCapacity: { used: 0, limit: null } } } : data;
      queueMicrotask(() => reply(request, valueAtRequest));
    },
    on(name: string, fn: (data: unknown) => void) {
      const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set);
      return () => { set.delete(fn); if (!set.size) listeners.delete(name); };
    },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-usage-"));
  mkdirSync(join(root, ".trellis"));
  const events = bus();
  const host: PiRuntimeHost = { events };
  let enabled = true;
  const runtime = { cwd: root, enabled: true, isChild: false, sessionEpoch: 1, sessionId: "session", parentSessionId: null, loadState: "auto",
    control: { moduleEnabled: () => enabled, initialized: () => true, switches: () => ({}), moduleIds: () => [],
      autoEnable: () => true, prefix: () => "wt-", facts: () => [], setSwitch: () => "", setAutoEnable: () => "",
      setPrefix: () => "", subagentConcurrency: () => null, setSubagentConcurrency: () => "", loadState: () => "auto",
      init: () => "" }, refresh() {} } as RuntimeContext;
  const ctx = { sessionManager: { getSessionId: () => runtime.sessionId!, getEntries: () => [entry(20)] } };
  return { root, events, host, runtime, ctx, moduleEnabled(value: boolean) { enabled = value; },
    close() { disposeUsage(host); existingSubagentsBridge(host)?.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

// Production adapter + public RPC fixtures. No manual ledger bindings or private artifact roots.
test("usage: native totals stay distinct from exact-model daily history; deduplicate public pointers", async () => {
  const f = fixture();
  try {
    const file = join(f.root, "child.jsonl");
    const now = new Date(); const old = new Date(now); old.setDate(old.getDate() - 2);
    writeFileSync(file, [entry(100), entry(50, "other"), entry(7, "m", old.toISOString())].map((value) => JSON.stringify(value)).join("\n"));
    f.events.set(report([{ sessionFile: file }, { sessionFile: file }], 0, 20));
    await refreshUsage(f.host, f.runtime, f.ctx);
    const state = usageSnapshot(f.host, f.runtime);
    assert.equal(state.cost.kind, "known");
    assert.equal(collectUsageHistory(state, "p/m", 7, now).total, 127);
    assert.equal(collectUsageHistory(state, "p/other", 7, now).total, 50);
    assert.equal(collectUsageHistory(state, "other-provider/m", 7, now).total, 0);
    assert.equal(collectUsageHistory({ ...state, since: now.getTime() - 60_000 }, "p/m", 7, now).total, 120);
    assert.equal(collectUsageHistory(state, "p/m", 7, now).incomplete, false);
    assert.match(formatNativeCost(state.cost), /in 40/);
    rmSync(file);
    assert.equal(collectUsageHistory(usageSnapshot(f.host, f.runtime), "p/m", 7, now).total, 127, "render uses cached entries");
    assert.equal(f.events.count(), 1);
  } finally { f.close(); }
});

test("usage: unresolved, missing, malformed and bounded-out histories remain visibly incomplete", async () => {
  const f = fixture();
  try {
    const invalid = join(f.root, "invalid.jsonl");
    writeFileSync(invalid, JSON.stringify(entry(5)) + '\n{"incomplete":');
    const big = join(f.root, "big.jsonl"); writeFileSync(big, ""); truncateSync(big, 9 * 1024 * 1024);
    const unknownModel = join(f.root, "unknown-model.jsonl");
    writeFileSync(unknownModel, JSON.stringify({ ...entry(90), message: { ...entry(90).message, provider: undefined } }));
    f.events.set(report([{}, { sessionFile: "/missing/coworkflow-session.jsonl" }, { sessionFile: invalid },
      { sessionFile: big }, { sessionFile: unknownModel }], 2));
    await refreshUsage(f.host, f.runtime, f.ctx);
    const state = usageSnapshot(f.host, f.runtime);
    const chart = collectUsageHistory(state, "p/m", 7);
    assert.equal(chart.total, 25);
    assert.equal(chart.incomplete, true);
    assert.match(chart.reason!, /sessionFile/);
    assert.match(chart.reason!, /无法读取/);
    assert.match(chart.reason!, /无效/);
    assert.match(chart.reason!, /预算/);
    assert.match(chart.reason!, /未猜测归属/);
    assert.match(formatNativeCost(state.cost), /≥.*不完整.*2 个/);
    const unknown = collectUsageHistory(state, "p/no-data", 7);
    assert.equal(unknown.unavailable, true, "missing history is not a zero-use day");
  } finally { f.close(); }
});

test("usage: unsupported/malformed cost preserves parent chart and never displays complete zero", async () => {
  for (const supported of [false, true]) {
    const f = fixture();
    try {
      f.events.support(supported); f.events.set({ version: 99 });
      await refreshUsage(f.host, f.runtime, f.ctx);
      const state = usageSnapshot(f.host, f.runtime);
      assert.equal(state.cost.kind, "unknown");
      assert.match(formatNativeCost(state.cost), /未知/);
      assert.equal(collectUsageHistory(state, "p/m", 7).total, 20);
      assert.equal(collectUsageHistory(state, "p/m", 7).incomplete, true);
      assert.equal(collectUsageHistory(state, "p/absent", 7).unavailable, true);
      await refreshUsage(f.host, f.runtime, { sessionManager: { getEntries: () => [entry(5, "m", "not-a-date")] } });
      const malformedParent = collectUsageHistory(usageSnapshot(f.host, f.runtime), "p/m", 7);
      assert.equal(malformedParent.incomplete, true);
      assert.match(malformedParent.reason!, /主会话记录缺少模型或时间/);
    } finally { f.close(); }
  }
});

test("usage: pending old epoch/disposal cannot publish; module off/on refreshes without polling", async () => {
  const f = fixture();
  try {
    f.events.hold(true);
    const pending = refreshUsage(f.host, f.runtime, f.ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.events.held.length, 1);
    f.runtime.sessionEpoch += 1; f.runtime.sessionId = "replacement";
    f.events.hold(false); f.events.set(report([], 0, 30));
    await refreshUsage(f.host, f.runtime, f.ctx);
    f.events.reply(f.events.held[0]!, report([], 0, 999)); await pending;
    assert.match(formatNativeCost(usageSnapshot(f.host, f.runtime).cost), /in 30/);
    f.events.hold(true);
    const ending = refreshUsage(f.host, f.runtime, f.ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    disposeUsage(f.host);
    f.events.reply(f.events.held.at(-1)!, report([], 0, 999)); await ending;
    assert.equal(usageSnapshot(f.host, f.runtime).cost.kind, "unknown");
    f.moduleEnabled(false); const count = f.events.count();
    await refreshUsage(f.host, f.runtime, f.ctx); assert.equal(f.events.count(), count);
    f.moduleEnabled(true); f.events.hold(false);
    await refreshUsage(f.host, f.runtime, f.ctx);
    assert.equal(f.events.count(), count + 1);
    assert.equal(f.events.listeners(), 0);
  } finally { f.close(); }
});

test("Comodels: production open caches data; Tab/columns/full thinking list and chart selection survive", async () => {
  const f = fixture();
  try {
    const file = join(f.root, "child.jsonl"); writeFileSync(file, JSON.stringify(entry(100)));
    f.events.set(report([{ sessionFile: file }]));
    const commands = new Map<string, any>();
    f.host.registerCommand = (name, spec) => { commands.set(name, spec); };
    f.host.getThinkingLevel = () => "medium";
    registerModelPanel(f.host, f.runtime);
    let panel: ModelPanel | undefined;
    const commandCtx = { ...f.ctx, cwd: f.root, mode: "tui", model: { provider: "p", id: "m" },
      scopedModels: [{ model: { provider: "p", id: "m" } }, { model: { provider: "p", id: "other" } }],
      ui: { custom(factory: any) { panel = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, undefined, () => {}); } } };
    await commands.get("Comodels").handler("", commandCtx);
    assert.ok(panel);
    const before = panel.render(160).join("\n");
    assert.match(before, /120/); assert.match(before, /minimal/); assert.match(before, /xhigh/);
    rmSync(file);
    const count = f.events.count();
    panel.handleInput("\x1b[B");
    assert.doesNotMatch(panel.render(160).join("\n"), /120/);
    panel.handleInput("\x1b[A");
    assert.match(panel.render(160).join("\n"), /120/);
    panel.handleInput("\t");
    assert.ok(panel.currentRows()[0]!.label.includes("继承主会话模型"));
    panel.handleInput("\x1b[C");
    assert.ok(panel.currentRows().some((row) => row.thinking === "xhigh"));
    panel.handleInput("\x1b[D");
    assert.ok(panel.currentRows()[0]!.label.includes("继承主会话模型"));
    assert.equal(f.events.count(), count, "keys and renders perform no RPC/history reads");
    await commands.get("Comodels").handler("", commandCtx);
    assert.match(panel!.render(160).join("\n"), /不完整/, "next open refreshes missing pointer");
  } finally { f.close(); }
});

test("extension: real session/settled/native-completion/open hooks refresh facts, off/shutdown stay quiet", async () => {
  const f = fixture();
  const originalCwd = process.cwd();
  const env = { PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, TRELLIS_SUBAGENT_CHILD: process.env.TRELLIS_SUBAGENT_CHILD };
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const commands = new Map<string, any>();
  const messages: unknown[] = [];
  try {
    mkdirSync(join(f.root, ".pi"));
    const modules = Object.fromEntries(["trellis", "worktree", "agents", "subagents", "subagent-context", "lane-worktree", "capacity"].map((id) => [id, false]));
    writeFileSync(join(f.root, ".pi", "Coworkflow.json"), JSON.stringify({ version: 1, autoEnable: true, modules: { ...modules, panel: true } }));
    process.chdir(f.root); delete process.env.PI_SUBAGENT_CHILD; delete process.env.TRELLIS_SUBAGENT_CHILD;
    f.host.on = (name, fn) => { handlers.set(name, [...handlers.get(name) ?? [], fn]); };
    f.host.registerCommand = (name, spec) => { commands.set(name, spec); };
    f.host.sendMessage = (message) => { messages.push(message); };
    coworkflow(f.host);
    const ctx = { ...f.ctx, cwd: f.root, mode: "tui", ui: { custom() {} } };
    const emit = async (name: string, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
    f.events.set(report([], 1, 10));
    await emit("session_start");
    assert.equal(f.events.count(), 1);
    assert.match(controlSurface().facts().join("\n"), /不完整/);
    f.events.set(report([], 0, 40));
    await emit("agent_settled"); assert.equal(f.events.count(), 2);
    assert.match(controlSurface().facts().join("\n"), /in 40/);
    await emit("message_end", { message: { customType: "subagent-notify", details: { runs: [{ runId: "known-child", status: "completed" }] } } });
    assert.equal(f.events.count(), 3);
    await emit("message_end", { message: { role: "assistant", content: "done" } }); assert.equal(f.events.count(), 3);
    await commands.get("Coworkflow:settings").handler("", ctx); assert.equal(f.events.count(), 4);
    assert.equal(messages.length, 0, "passive cost refresh sends no messages");
    await commands.get("Coworkflow:start").handler("off", ctx);
    await emit("agent_settled"); assert.equal(f.events.count(), 4);
    assert.match(controlSurface().facts().join("\n"), /用量未知/);
    await commands.get("Coworkflow:start").handler("", ctx);
    await emit("agent_settled"); assert.equal(f.events.count(), 5);
    await emit("session_shutdown");
    await emit("agent_settled"); assert.equal(f.events.count(), 5);
    f.runtime.sessionId = "new-session";
    await emit("session_start"); assert.equal(f.events.count(), 6);
    await emit("session_shutdown");
    assert.equal(f.events.listeners(), 0);
  } finally {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.close();
  }
});
