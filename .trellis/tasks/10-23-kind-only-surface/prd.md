# Kind-only Trellis surface

## Goal

本项目的 Trellis 工作面只讲 kind：`trellis-implement` / `trellis-check` / `trellis-research` 不再存在于 agent 列表，`role` 不再是模型要理解的第二套身份，只是 kind 定义文件里的一个注入档位。

## 前提（已核实）

- `trellis` 是全局 CLI（`@mindfoldhq/trellis@0.6.17`），本仓没有它的源码副本；`.trellis/` 与 `.pi/agents/` 是安装产物，**属于本项目文件**。
- 本包 init 跑 `trellis update -s`（`--skip-all`：跳过所有已改文件），因此就地修改的 `.trellis/workflow.md` **不会被覆盖**。
- 已删除的文件不在 `-s` 的保护范围：`trellis update` 会重新生成 `.pi/agents/trellis-*.md`。所以「删除」必须有幂等守卫，不能只删一次。

## 需求

- R1 `.pi/agents/trellis-{implement,check,research}.md` 在本项目里不存在，且每次 init / `trellis update` 之后仍然不存在（守卫可重入、可报告、不进循环报错）。
- R2 `.trellis/workflow.md` 的 Pi 分支只以 kind 为操作对象：派单写 kind / `cw-*`，Pi 的 inline「自己实现」步骤改为派给执行类 kind；非 Pi 平台块保持原样。
- R3 `role` 只有一份真相：kind 定义文件（`.pi/Coworkflow/agents/<kind>.md` 的 frontmatter，shipped 资产同格式）。`BUILTIN_KINDS[].role` 与 `subagent-context` 里按 `trellis-<role>` 名字猜角色的路径删除。
- R4 注入行为不退化：`implement` / `check` / `research` 三种上下文仍由 kind 的 role 决定注入，`role: none` 仍不注入；已有测试全绿。
- R5 不引入向对话注入消息、不引入守护进程、不改其它平台（Claude Code / Codex / Cursor …）的分支语义。

## 不做

- 不改全局 npm 包，不做 `trellis update` 的 fork。
- 不删除 `.agents/skills/trellis-*`（那是 skill，不是 agent；且工作流仍引用它们）。
- 不改 `.pi/extensions/trellis/`（Trellis 自己的 Pi 扩展，仍在用）。

## 子任务

| 子任务 | 交付物 |
|---|---|
| `10-23-kind-only-workflow` | workflow.md 的 Pi 分支 kind-only + `.pi/agents/trellis-*` 的幂等删除守卫 |
| `10-23-kind-only-role` | role 去重：定义文件唯一真相 + 删掉名字猜角色 |

## 验收

- [x] 实跑 `subagent({ action: "list" })`：`trellis-*` 已不在列表，只剩 `cw-executor` / `cw-auditor` / `cw-researcher`。
- [x] `.trellis/workflow.md` 的 Pi 块只讲 kind / `cw-*`；非 Pi 8 个块的 digest 与改动前一致（测试钉住）。
- [x] `modules/subagent-context` 不再按 `trellis-<role>` 名字猜角色（`AGENT_RE` / `asRole(agent)` 路径已删）。
- [x] `npm test` 278/278；`tsc --noEmit` 干净。
- [x] spec 已同步（`agent-kinds.md`、`subagents-integration.md` 新增「Retiring the trellis-* role agents」）。
