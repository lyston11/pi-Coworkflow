/**
 * Which model a subagent actually runs on.
 *
 * This is not a cosmetic line. A project declared `subagents.defaultModel:
 * "cline-pass/deepseek-v4.1-flash-1017"`, the children ran on the *parent's* model instead, four of
 * them died with a connection error without executing a single command — and nothing said so. A
 * declared value that does not resolve falls back silently, which is indistinguishable from "the
 * project never chose anything".
 *
 * So the four states are pinned apart: **declared**, **effective**, and whether the declaration was
 * verified. A host that cannot enumerate models gets "unverifiable", never "not found" — the same
 * distinction this package had to learn about tool availability.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkSubagentModel,
  formatSubagentModelLine,
  parseDeclaredModel,
  readDeclaredSubagentModel,
} from "../core/model-report.ts";

const SESSION = { provider: "buddy2api", id: "deepseek-v4.1-flash" };
const AVAILABLE = [
  { provider: "clinepass", id: "cline-pass/deepseek-v4.1-flash-1017", authenticated: true },
  { provider: "buddy2api", id: "deepseek-v4.1-flash", authenticated: true },
];

function project(settings: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-model-")));
  mkdirSync(join(root, ".pi"), { recursive: true });
  if (settings !== undefined) writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify(settings));
  return root;
}

test("model: a qualified string splits once, and the rest belongs to the id", () => {
  assert.deepEqual(parseDeclaredModel("clinepass/cline-pass/deepseek-v4.1-flash-1017"), {
    provider: "clinepass",
    id: "cline-pass/deepseek-v4.1-flash-1017",
  });
  // A bare id needs the separate provider setting; without it the declaration is unusable.
  assert.deepEqual(parseDeclaredModel("deepseek-v4.1-flash", "clinepass"), {
    provider: "clinepass",
    id: "deepseek-v4.1-flash",
  });
  assert.match(parseDeclaredModel("deepseek-v4.1-flash").malformed ?? "", /没有配 defaultProvider/);
  assert.match(parseDeclaredModel("  ").malformed ?? "", /空字符串/);
  assert.match(parseDeclaredModel("/x").malformed ?? "", /provider 或模型 id 为空/);
});

test("model: the project's settings win over the user's, and the source is reported", () => {
  const root = project({ subagents: { defaultModel: "clinepass/cline-pass/deepseek-v4.1-flash-1017", defaultProvider: "clinepass" } });
  try {
    const declared = readDeclaredSubagentModel(root);
    assert.equal(declared?.provider, "clinepass");
    assert.equal(declared?.id, "cline-pass/deepseek-v4.1-flash-1017");
    assert.match(declared?.source ?? "", /\.pi\/settings\.json$/, "the report names the file it read");

    // No project value: the user's file is the fallback, and is named as such.
    const bare = project({});
    try {
      const fromUser = readDeclaredSubagentModel(bare, { userSettings: join(root, ".pi", "settings.json") });
      assert.equal(fromUser?.provider, "clinepass");
      assert.match(fromUser?.source ?? "", new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the user file, not the project's");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }

    // Nothing declared anywhere: absent, not an empty declaration.
    const none = project({});
    try {
      assert.equal(readDeclaredSubagentModel(none, { userSettings: null }), null);
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model: an unresolvable declaration is reported as a silent fallback", () => {
  // The exact reported failure: the declared provider prefix is not one the registry has.
  const declared = { raw: "cline-pass/deepseek-v4.1-flash-1017", source: ".pi/settings.json", provider: "cline-pass", id: "deepseek-v4.1-flash-1017" };
  const check = checkSubagentModel({ declared, available: AVAILABLE, sessionModel: SESSION });
  assert.equal(check.verification, "unresolved");
  assert.deepEqual(check.effective, SESSION, "the child runs on the parent's model, and the check says so");
  const line = formatSubagentModelLine(check);
  assert.match(line, /解析不到/);
  assert.match(line, /静默回退到主会话模型（buddy2api\/deepseek-v4.1-flash）/);
  assert.match(line, /本项目等于没配/, "it says the consequence, not just the fact");
  assert.ok(line.includes("clinepass/cline-pass/deepseek-v4.1-flash-1017"), `it offers what does exist: ${line}`);
});

test("model: resolved, unauthenticated, and unverifiable are three different answers", () => {
  const declared = { raw: "clinepass/cline-pass/deepseek-v4.1-flash-1017", source: ".pi/settings.json", provider: "clinepass", id: "cline-pass/deepseek-v4.1-flash-1017" };

  const resolved = checkSubagentModel({ declared, available: AVAILABLE, sessionModel: SESSION });
  assert.equal(resolved.verification, "resolved");
  assert.deepEqual(resolved.effective, { provider: "clinepass", id: "cline-pass/deepseek-v4.1-flash-1017" }, "the child runs on the declared model");
  assert.match(formatSubagentModelLine(resolved), /已在模型注册表里找到且凭据可用/);

  // Present but without credentials: the child would start and fail on the call, which reads like
  // "the model does not exist" to whoever sees the log afterwards.
  const noAuth = checkSubagentModel({
    declared,
    available: [{ ...AVAILABLE[0]!, authenticated: false }],
    sessionModel: SESSION,
  });
  assert.equal(noAuth.verification, "unauthenticated");
  assert.match(formatSubagentModelLine(noAuth), /没有可用凭据/);

  // No registry: cannot be asked. Never becomes "unresolved" — that would be a diagnosis invented
  // from a missing answer.
  const cannotTell = checkSubagentModel({ declared, available: undefined, sessionModel: SESSION });
  assert.equal(cannotTell.verification, "unverifiable");
  const line = formatSubagentModelLine(cannotTell);
  assert.match(line, /无法确认/);
  // The conditional consequence may be explained, but the diagnosis must not be asserted: "本项目
  // 等于没配" is what a *proven* miss says, and an unasked host cannot prove anything.
  assert.doesNotMatch(line, /本项目等于没配/, "cannot-tell must not be reported as a proven miss");
});

test("model: no declaration means the child follows the session, and the line says that", () => {
  const check = checkSubagentModel({ declared: null, available: AVAILABLE, sessionModel: SESSION });
  assert.equal(check.declared, null);
  assert.deepEqual(check.effective, SESSION);
  const line = formatSubagentModelLine(check);
  assert.match(line, /未声明/);
  assert.match(line, /跟随主会话（buddy2api\/deepseek-v4.1-flash）/);
});
