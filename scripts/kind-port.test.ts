/**
 * The kind port: project definitions in `.pi/Coworkflow/agents/<kind>.md`.
 *
 * These drive the production readers and resolvers rather than asserting on rendered text: what
 * matters is which kinds the session would register, with which agent name, role and prompt, and
 * that a bad file fails only itself.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readConfig } from "../core/config.ts";
import {
  DEFINITIONS_REL,
  definitionsDir,
  parseDefinition,
  parseFrontmatter,
  readKindDefinitions,
  renderDefinition,
  splitDefinition,
  writeKindDefinition,
} from "../modules/agent-kinds/definitions.ts";
import { kindRole, resolveKinds } from "../modules/agent-kinds/defaults.ts";

function project(files: Record<string, string> = {}, config: unknown = { version: 1, modules: {} }): string {
  const root = mkdtempSync(join(tmpdir(), "coworkflow-kindport-"));
  mkdirSync(join(root, ".pi", "Coworkflow", "agents"), { recursive: true });
  writeFileSync(join(root, ".pi", "Coworkflow.json"), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(definitionsDir(root), name), text);
  }
  return root;
}

const definition = (front: string, body = "系统提示词。"): string => `---\n${front}\n---\n\n${body}\n`;

test("kind port: frontmatter is a flat map, and a malformed line is refused by name", () => {
  assert.deepEqual(parseFrontmatter("label: 执行者\n# 注释\nrole: implement\n"), {
    label: "执行者",
    role: "implement",
  });
  assert.deepEqual(parseFrontmatter('label: "带 空格"\n'), { label: "带 空格" });
  assert.deepEqual(parseFrontmatter("label 没有冒号\n"), { reason: "无法解析的 frontmatter 行：label 没有冒号" });
  assert.deepEqual(parseFrontmatter("label:\n"), { reason: "frontmatter 的 label 没有值" });

  assert.deepEqual(splitDefinition("没有 frontmatter\n"), { reason: "缺少 frontmatter（文件必须以 --- 开头）" });
  assert.deepEqual(splitDefinition("---\nlabel: x\n"), { reason: "frontmatter 没有结束的 ---" });
});

test("kind port: a definition declares what a kind is, and each malformed field fails alone", () => {
  const ok = parseDefinition(
    "executor",
    definition("label: 建造者\nrole: none\nmaxConcurrent: 2\nenabled: false\nthinking: high", "你是建造者。"),
  );
  assert.ok("definition" in ok);
  assert.equal(ok.definition.label, "建造者");
  assert.equal(ok.definition.role, "none");
  assert.equal(ok.definition.maxConcurrent, 2);
  assert.equal(ok.definition.enabled, false);
  assert.equal(ok.definition.prompt, "你是建造者。");

  const cases: [string, string, RegExp][] = [
    ["unknown key", definition("label: x\ntypo: 1"), /不认识的 frontmatter 键：typo/],
    ["bad role", definition("role: nope"), /role 只能是/],
    ["bad agent name", definition("agent: executor"), /agent 必须形如 cw-<kind>/],
    ["bad thinking", definition("thinking: turbo"), /thinking 不是已知等级/],
    ["bad limit", definition("maxConcurrent: 0"), /maxConcurrent 需要 ≥ 1/],
    ["bad enabled", definition("enabled: yes"), /enabled 只能是 true 或 false/],
    ["bad model", definition("model: ' bad'"), /model 不可用/],
    ["empty body", definition("label: x", ""), /正文为空/],
  ];
  for (const [what, text, expected] of cases) {
    const parsed = parseDefinition("executor", text);
    assert.ok("reason" in parsed, `${what} must be refused`);
    assert.match(parsed.reason, expected, what);
  }
});

test("kind port: a definition overrides a shipped kind, and a new file adds a kind", () => {
  const root = project({
    "executor.md": definition("label: 建造者\nrole: none\nthinking: high\nmaxConcurrent: 2", "项目自己的执行者。"),
    "reviewer.md": definition("label: 复核者\nagent: cw-reviewer\nrole: check", "只读复核。"),
  });
  try {
    const read = readKindDefinitions(root);
    assert.deepEqual([...read.definitions.keys()].sort(), ["executor", "reviewer"]);
    assert.deepEqual(read.failures, []);

    const kinds = resolveKinds(readConfig(root), read.definitions);
    const executor = kinds.find((entry) => entry.kind === "executor");
    assert.equal(executor?.label, "建造者", "the project's label replaces the shipped one");
    assert.equal(executor?.role, null, "role: none means not a Trellis role");
    assert.equal(executor?.thinking, "high");
    assert.equal(executor?.maxConcurrent, 2);
    assert.equal(executor?.source, "file");
    assert.equal(executor?.promptFromFile, "项目自己的执行者。");

    const reviewer = kinds.find((entry) => entry.kind === "reviewer");
    assert.ok(reviewer, "a definition for a kind this package does not ship adds it");
    assert.equal(reviewer.agent, "cw-reviewer", "and its agent name is the one the file declares");
    assert.equal(reviewer.role, "check");
    assert.equal(reviewer.source, "file");
    // The shipped kinds the project did not touch are untouched.
    assert.equal(kinds.find((entry) => entry.kind === "auditor")?.source, "shipped");
    assert.equal(kindRole("reviewer", read.definitions), "check");
    assert.equal(kindRole("executor", read.definitions), null, "role: none resolves to no role");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kind port: the project config wins over a definition's default, and the report says which", () => {
  const root = project(
    { "executor.md": definition("maxConcurrent: 2\nmodel: p/from-file\nthinking: low") },
    { version: 1, modules: {}, agentKinds: { executor: { maxConcurrent: 9, model: "p/from-config" } } },
  );
  try {
    const read = readKindDefinitions(root);
    const executor = resolveKinds(readConfig(root), read.definitions).find((entry) => entry.kind === "executor");
    assert.equal(executor?.maxConcurrent, 9, "the project's choice wins");
    assert.equal(executor?.chosen?.maxConcurrent, true, "and is reported as chosen");
    assert.equal(executor?.model, "p/from-config");
    assert.equal(executor?.chosen?.model, true);
    // A field the project did not choose keeps the definition's default, and says so.
    assert.equal(executor?.thinking, "low");
    assert.equal(executor?.chosen?.thinking, false, "a definition default is not a project choice");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kind port: a broken file fails only that kind, and an unreadable directory is no definitions", () => {
  const root = project({
    "executor.md": definition("label: 建造者"),
    "broken.md": "---\nlabel: 坏的\nrole: nope\n---\n\nx\n",
  });
  try {
    const read = readKindDefinitions(root);
    assert.deepEqual([...read.definitions.keys()], ["executor"], "the usable definition still loads");
    assert.equal(read.failures.length, 1);
    assert.equal(read.failures[0]?.kind, "broken");
    assert.match(read.failures[0]!.reason, /role 只能是/);
    const kinds = resolveKinds(readConfig(root), read.definitions);
    assert.ok(kinds.some((entry) => entry.kind === "executor"), "and the other kinds keep working");
    assert.equal(kinds.some((entry) => entry.kind === "broken"), false, "the broken kind is not a kind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // No directory at all: "no definitions", not an error.
  const bare = mkdtempSync(join(tmpdir(), "coworkflow-kindport-bare-"));
  try {
    assert.deepEqual(readKindDefinitions(bare), { definitions: new Map(), failures: [] });
    assert.deepEqual(readKindDefinitions(null), { definitions: new Map(), failures: [] });
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("kind port: the writer validates before it writes, and a rejected value leaves no file", () => {
  const root = project();
  try {
    const written = writeKindDefinition(root, "builder", {
      label: "建造者",
      role: "research",
      context: "task",
      prompt: "按派单实现。",
    });
    assert.ok(written.ok, JSON.stringify(written));
    const path = join(definitionsDir(root), "builder.md");
    assert.match(readFileSync(path, "utf-8"), /role: research/);
    assert.match(readFileSync(path, "utf-8"), /context: task/);
    // Round trip: what was written parses back to the same definition.
    const parsed = parseDefinition("builder", readFileSync(path, "utf-8"));
    assert.ok("definition" in parsed);
    assert.equal(parsed.definition.label, "建造者");
    assert.equal(parsed.definition.context, "task");
    const badContext = writeKindDefinition(root, "builder", { context: "nope" as never }, parsed.definition);
    assert.equal(badContext.ok, false);

    // A rejected value must not create or modify anything.
    const before = readFileSync(path, "utf-8");
    const refused = writeKindDefinition(root, "builder", { role: "nope" as never }, parsed.definition);
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /role 只能是/);
    assert.equal(readFileSync(path, "utf-8"), before, "the file is byte-identical after a refusal");

    // A kind id outside the slug alphabet is refused before any path is built.
    const bad = writeKindDefinition(root, "../escape", { prompt: "x" });
    assert.equal(bad.ok, false);
    assert.match((bad as { reason: string }).reason, /kind 名必须是/);

    // renderDefinition is the inverse of the parser for a full definition.
    const full = parseDefinition("builder", renderDefinition({ ...parsed.definition, agent: "cw-builder" }));
    assert.ok("definition" in full);
    assert.equal(full.definition.agent, "cw-builder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kind port: the definitions directory is the one the documentation names", () => {
  assert.equal(DEFINITIONS_REL, join(".pi", "Coworkflow", "agents"));
  const root = project();
  try {
    assert.equal(definitionsDir(root), join(root, DEFINITIONS_REL));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The programmatic door: another extension writes a definition through the same writer.
 *
 * A client that already speaks the owner's RPC convention should not have to learn a second
 * envelope, and a port that answered `ok` for a kind nothing registered would be the
 * dishonest-degradation failure this package has shipped twice.
 */
test("kind port RPC: define writes the file, list reports the resolved table, and bad input is refused", async () => {
  const { registerKindPort, KIND_PORT_REQUEST, KIND_PORT_REPLY_PREFIX } = await import(
    "../modules/agent-kinds/port.ts"
  );
  const root = project();
  const replies = new Map<string, any>();
  const handlers = new Map<string, (data: unknown) => void>();
  const events = {
    emit: (channel: string, data: unknown) => {
      if (channel.startsWith(KIND_PORT_REPLY_PREFIX)) replies.set(channel.slice(KIND_PORT_REPLY_PREFIX.length), data);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
  const control = {
    configRoot: () => root,
    moduleEnabled: () => true,
    defineKind: async (kind: string, patch: Record<string, unknown>) => {
      const { writeKindDefinition } = await import("../modules/agent-kinds/definitions.ts");
      const written = writeKindDefinition(root, kind, patch as never);
      return written.ok ? `${kind} 已写入` : `${kind} 未写入：${written.reason}`;
    },
    removeKind: async (kind: string) => `已删除 ${kind}`,
    agentKinds: () => [],
  } as never;
  const runtime = { isChild: false, enabled: true } as never;
  const off = registerKindPort({ events } as never, runtime, control);
  const call = async (request: Record<string, unknown>): Promise<any> => {
    const requestId = String(request.requestId);
    handlers.get(KIND_PORT_REQUEST)?.({ version: 1, ...request, requestId });
    for (let tick = 0; tick < 200 && !replies.has(requestId); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return replies.get(requestId);
  };

  try {
    // define: the file lands, and a rejected value is a refusal rather than a written file.
    const defined = await call({ requestId: "r1", method: "define", params: { kind: "builder", label: "建造者", prompt: "实现。" } });
    assert.equal(defined.ok, true, JSON.stringify(defined));
    assert.match(readFileSync(join(definitionsDir(root), "builder.md"), "utf-8"), /label: 建造者/);

    const refused = await call({ requestId: "r2", method: "define", params: { kind: "builder", role: "nope" } });
    assert.equal(refused.ok, true, "the writer answers with its own message");
    assert.match(refused.result.message, /未写入/);

    // list reports the resolved table, including the definition's source.
    const listed = await call({ requestId: "r3", method: "list" });
    assert.equal(listed.ok, true);
    const builder = listed.result.kinds.find((entry: { kind: string }) => entry.kind === "builder");
    assert.equal(builder?.source, "file");
    assert.equal(builder?.agent, "cw-builder");

    // show for an unknown kind is an explicit refusal, not an empty result.
    const missing = await call({ requestId: "r4", method: "show", params: { kind: "nope" } });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "unknown_kind");

    // Envelope discipline: unknown method, wrong version, and a missing kind are named.
    assert.equal((await call({ requestId: "r5", method: "drop" })).error.code, "unsupported_method");
    assert.equal(
      (await call({ requestId: "r6", method: "list", version: 99 })).error.code,
      "unsupported_version",
    );
    assert.equal((await call({ requestId: "r7", method: "define", params: {} })).error.code, "invalid_params");

    // A child session and an off module are refusals: the port must not claim success for work
    // nothing will act on.
    const childReplies = new Map<string, any>();
    const childEvents = {
      emit: (channel: string, data: unknown) => childReplies.set(channel, data),
      on: (channel: string, handler: (data: unknown) => void) => {
        handlers.set(channel, handler);
        return () => {};
      },
    };
    registerKindPort({ events: childEvents } as never, { isChild: true, enabled: true } as never, control);
    handlers.get(KIND_PORT_REQUEST)?.({ version: 1, requestId: "r8", method: "list" });
    const childReply = [...childReplies.values()][0] as { error?: { code?: string } };
    assert.equal(childReply?.error?.code, "child_session");
  } finally {
    off();
    rmSync(root, { recursive: true, force: true });
  }
});
