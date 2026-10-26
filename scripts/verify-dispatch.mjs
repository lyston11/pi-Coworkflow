/**
 * Native Pi / pi-subagents integration probe, with a local deterministic provider.
 * Runs four real background children in managed worktrees; no model network calls.
 * Requires the installed Pi peer and pi-subagents. Run with `npm run verify:dispatch`.
 * The isolated agent directory prevents ambient packages from loading another build
 * of Coworkflow and overwriting the prompt produced by the build under test.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subagentsPackageDir } from "../core/pi-subagents.ts";
import { planTemplate, writePlanned } from "../modules/trellis/index.ts";

const source = fileURLToPath(new URL("..", import.meta.url));
const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkRoot = dirname(dirname(sdkEntry));
const aiEntry = join(sdkRoot, "node_modules/@earendil-works/pi-ai/dist/index.js");
const ownerRoot = subagentsPackageDir();
const base = realpathSync(mkdtempSync(join(tmpdir(), "coworkflow-native-")));
const fixture = join(base, "project");
const agentDir = join(base, "agent");
const evidenceDir = join(base, "evidence");
const taskDir = join(fixture, ".trellis/tasks/probe");
const originalCwd = process.cwd();
const put = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const git = (...args) => execFileSync("git", ["-C", fixture, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "Probe", GIT_AUTHOR_EMAIL: "probe@example.test",
    GIT_COMMITTER_NAME: "Probe", GIT_COMMITTER_EMAIL: "probe@example.test" },
}).trim();
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
symlinkSync(ownerRoot, join(agentDir, "npm/node_modules/pi-subagents"), "dir");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = sdkRoot;

const providerPath = join(base, "provider.mjs");
put(providerPath, `
import { createAssistantMessageEventStream } from ${JSON.stringify(pathToFileURL(aiEntry).href)};
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
export default function (pi) {
  let sessionCwd;
  pi.on("before_agent_start", (_event, ctx) => { sessionCwd = ctx.cwd; });
  pi.registerProvider("coworkflow-fixture", {
    baseUrl: "http://unused.invalid", apiKey: "local-fixture", api: "coworkflow-fixture",
    models: [{ id: "probe", name: "Local fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const child = process.env.PI_SUBAGENT_CHILD === "1";
      const record = { pid: process.pid, cwd: sessionCwd, name: pi.getSessionName(),
        systemPrompt: JSON.stringify(context.messages.filter(message => message.role === "system")), at: Date.now() };
      if (child) writeFileSync(${JSON.stringify(evidenceDir)} + "/" + randomUUID() + ".json", JSON.stringify(record));
      const message = { role: "assistant", content: [{ type: "text", text: child ? "PROBE_COMPLETED" : "ACK" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      setTimeout(() => { stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end(); }, child ? 1000 : 0);
      return stream;
    },
  });
}
`);
put(join(agentDir, "settings.json"), JSON.stringify({
  packages: [], extensions: [providerPath, join(ownerRoot, "bundle/index.js"), join(source, "extensions/coworkflow.ts")],
  defaultProvider: "coworkflow-fixture", defaultModel: "probe", defaultProjectTrust: "always",
  subagents: { defaultModel: "coworkflow-fixture/probe", defaultThinking: "off", projectRootResolution: "git-root" },
}));
const rendered = writePlanned(fixture, planTemplate({ root: fixture }));
assert.deepEqual(rendered.failed, []);
put(join(fixture, ".pi/Coworkflow.json"), JSON.stringify({ version: 1, autoEnable: true,
  modules: { trellis: true, agents: true, subagents: true, "agent-kinds": true, "subagent-context": true,
    dispatch: true, capacity: true, worktree: false, "lane-worktree": false, panel: false },
  subagentConcurrency: 2, subagentRunBudgetMs: 60000, agentKinds: { probe: { enabled: true, maxConcurrent: 2 } },
}));
put(join(fixture, ".pi/Coworkflow/agents/probe.md"),
  "---\nlabel: Probe\nagent: cw-probe\nrole: check\n---\nRead-only integration probe. Never use tools or start children.\n");
const markers = ["orbit-prd-317", "orbit-design-428", "orbit-plan-539", "orbit-spec-640"];
for (const [file, value] of [["prd.md", markers[0]], ["design.md", markers[1]], ["implement.md", markers[2]]]) {
  put(join(taskDir, file), `# Probe\n${value}\n`);
}
put(join(fixture, ".trellis/spec/probe.md"), `# Check guideline\n${markers[3]}\n`);
put(join(taskDir, "check.jsonl"), JSON.stringify({ file: ".trellis/spec/probe.md", reason: "probe" }) + "\n");
put(join(taskDir, "task.json"), JSON.stringify({ id: "probe", name: "probe", status: "in_progress" }));
put(join(fixture, ".gitignore"), ".pi/\n.trellis/.runtime/\nsessions/\n");
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-qm", "probe fixture");
process.chdir(fixture);

const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await import(pathToFileURL(sdkEntry).href);
let session;
let timer;
let passed = false;
const notices = new Map();
const errors = [];
let done;
const allDone = new Promise(resolve => { done = resolve; });
const capture = pi => {
  pi.on("message_end", event => {
    if (event.message?.customType !== "subagent-notify") return;
    for (const run of event.message.details?.runs ?? []) notices.set(run.runId, run);
    if (notices.size === 4) done();
  });
};
try {
  const settingsManager = SettingsManager.create(fixture, agentDir);
  const loader = new DefaultResourceLoader({ cwd: fixture, agentDir, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [capture], systemPromptOverride: () => "On child notifications, reply ACK without tools." });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const loaded = loader.getExtensions().extensions;
  const entries = loaded.filter(e => e.resolvedPath === join(source, "extensions/coworkflow.ts"));
  assert.equal(entries.length, 1, "exactly the build under test must be loaded");
  ({ session } = await createAgentSession({ cwd: fixture, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.create(fixture, join(fixture, "sessions")) }));
  await session.bindExtensions({ onError: error => errors.push(error) });
  const tools = loaded.flatMap(e => [...e.tools.values()]);
  const tool = tools.find(t => (t.definition ?? t).name === "coworkflow_dispatch");
  assert.ok(tool, "native host registers the queue tool");
  const task = `Active task: ${taskDir}\nRead-only probe: reply PROBE_COMPLETED without tools.`;
  const result = await (tool.definition ?? tool).execute("probe", { worktree: true, tasks: [
    { key: "a", kind: "probe", task }, { key: "b", kind: "probe", task },
    { key: "c", kind: "probe", task }, { key: "d", kind: "probe", task, needs: ["a"] },
  ] });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(result.details.started.length, 2);
  assert.deepEqual(result.details.queued.map(t => [t.key, t.reason]), [["c", "ceiling"], ["d", "dependency"]]);
  await Promise.race([allDone, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("native probe deadline (90s)")), 90000);
  })]);
  clearTimeout(timer);
  assert.ok([...notices.values()].every(run => run.status === "completed"), JSON.stringify([...notices.values()]));
  const evidence = readdirSync(evidenceDir).map(name => JSON.parse(readFileSync(join(evidenceDir, name), "utf8")));
  assert.equal(evidence.length, 4, "each real child reached the model with its final context");
  assert.equal(new Set(evidence.map(e => e.pid)).size, 4, "four distinct child processes");
  assert.equal(new Set(evidence.map(e => e.cwd)).size, 4, "four distinct worktrees");
  for (const child of evidence) {
    assert.notEqual(child.pid, process.pid);
    assert.notEqual(child.cwd, fixture);
    const prompt = typeof child.systemPrompt === "string" ? child.systemPrompt : JSON.stringify(child.systemPrompt);
    for (const marker of markers) assert.ok(prompt.includes(marker), `${child.name}: missing ${marker}`);
    assert.ok(prompt.includes(taskDir), "absolute parent task directory reaches the model");
    assert.ok(prompt.includes("role: check"), "custom wrapped kind receives its declared role");
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, children: evidence.length, initialRunning: 2, initialQueued: 2,
    contextMarkersPerChild: markers.length, isolatedWorktrees: true, modelNetworkRequests: 0 }));
  passed = true;
} finally {
  clearTimeout(timer);
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  process.chdir(originalCwd);
  if (passed) {
    for (const line of git("worktree", "list", "--porcelain").split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      if (path === fixture) continue;
      assert.equal(execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
      git("worktree", "remove", path);
    }
    rmSync(base, { recursive: true });
  } else {
    console.error(`Probe evidence retained: ${base}`);
  }
}
