# Trellis surface speaks kinds

## Goal

`.trellis/workflow.md` 的 Pi 分支只以 kind 为操作对象；`.pi/agents/trellis-*.md` 在本项目不存在，且 `trellis update` 之后仍然不存在。

## 需求

- R1 删除 `.pi/agents/trellis-{implement,check,research}.md`，并在本包 init 的 Trellis 对齐路径里加一个幂等守卫，重复执行不报错、不重建、有报告。
- R2 改写 `.trellis/workflow.md` 中**仅 Pi / codex-inline 块**的派单与实现步骤：
  - 「Spawn the implement sub-agent: Agent type `trellis-implement`」类 → 派给执行类 kind（`cw-executor`，可用名以 `/Coworkflow:status` 为准）；
  - Pi 的 inline 步骤（自己读规范 / 自己实现 / 自己跑检查）→ 派单 + 主会话验收；
  - 通用总则里点名 `trellis-implement` / `trellis-check` / `trellis-research` 的句子，若其语义属于 Pi 之外的多平台通用段，**保留**，不越界改。
- R3 其它平台块（Claude Code / Codex / Cursor / Gemini / Kiro / 等）一个字节都不改。
- R4 幂等：守卫与改写重复执行结果一致（同一份文件第二次运行后 diff 为空）。
- R5 不改 `.pi/extensions/trellis/`、不改 `.agents/skills/trellis-*`。

## 验收

- [ ] `ls .pi/agents` 无 `trellis-*`；跑两次守卫仍无、且不报错。
- [ ] `.trellis/workflow.md` 的 `[codex-inline, Pi, …]` 块只提到 kind / `cw-*`。
- [ ] 非 Pi 平台块：`git diff` 显示零改动（用测试断言块内文本未变）。
- [ ] `npm test`、`tsc` 干净。
