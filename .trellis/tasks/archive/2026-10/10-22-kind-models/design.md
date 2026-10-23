# Design — per-kind models

## Where the model lives

`agentKinds.<kind>.model` and `.thinking` in `.pi/Coworkflow.json`, next to the kind's other
policy. Not `subagents.agentOverrides`, and not the launch call:

- our kinds are **runtime-registered**, so the definition is the authoritative place; upstream
  validates `model`/`thinking` at registration and would refuse a bad value loudly;
- a launch-level model would only apply to dispatches this package makes, while the definition
  applies to every dispatch of that kind, including a hand-written `subagent({ agent:
  "cw-executor" })`;
- one source means the panel, `/Coworkflow:status` and the gate all read the same field.

Precedence, highest first: **kind model → `subagents.defaultModel` → Pi's default.** A kind with
no model inherits, which is what an absent field means.

## Validation

`parseAgentKinds` accepts a model only as a non-empty string with no control characters and a
bounded length, and a thinking level only as a member of the known level set. Anything else is
**dropped, not passed on**: upstream fails a launch on an unusable model, so a stored typo would
take the kind down with it and the failure would surface as "dispatch refused" rather than "that
model id is wrong".

## Why the definition signature must include them

`createKindRegistry` reconciles by comparing each kind's `signature()`; an identical definition
keeps the live registration. `model`/`thinking` must be part of that comparison, or changing a
kind's model would be treated as "unchanged" and the agent would keep the old model — a panel that
writes a setting the session does not use is exactly the failure this module exists to remove.

## Panel pages

`/Comodels` pages are computed, never hardcoded:

```
主会话                    session model + thinking, applied through pi.setModel
子 agent（默认）           subagents.defaultModel / defaultProvider / defaultThinking
执行者 cw-executor         agentKinds.executor.model / .thinking
审计者 cw-auditor          …
调研者 cw-researcher       …
```

The page list comes from `control.agentKinds()`, so a kind the project adds appears and one it
removes disappears. A disabled kind keeps its page and says so — its model is still stored and
would apply the moment it is switched on again.

`Tab` becomes `"session" | "subagent" | \`kind:${string}\``; `modelRows`/`thinkingRows` take the
resolved tab plus the kind entry. Thinking levels follow the **effective** model for that page: a
kind that pins a model lists that model's levels; a kind that inherits lists the session model's,
which is the rule the default page already uses.

## Reporting

`/Coworkflow:status` gains one line per kind: `cw-executor（kind executor）已注册 · 模型
provider/id` or `· 继承默认`. The panel and the report read the same resolved field, so they
cannot disagree.

## Out of scope

Per-kind `defaultProvider` as a separate field (a bare id already resolves against the current
provider first, and a pinned model carries its provider), per-kind worktree/context/skills, and
upstream `agentOverrides`.
