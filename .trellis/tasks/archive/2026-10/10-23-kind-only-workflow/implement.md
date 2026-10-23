# 执行计划

1. 读 `modules/trellis/index.ts` 的对齐流程，确认 init 与 `trellis update -s` 的调用点。
2. 加 `retireRoleAgents(root)`（纯文件操作，返回报告），接到 `trellis update -s` 成功之后，并接一条 `ctx.report`。
3. 改 `.trellis/workflow.md`：只在 `[codex-inline, Pi, …]` 块内替换（见 design.md 第 1-4 类）。
4. 测试：`scripts/` 下新增守卫与块边界断言；跑 `npm test`、`npx tsc --noEmit`。
5. 不提交、不改其它平台块、不改 `.pi/extensions/trellis/`。

## 上下文

- `.trellis/spec/frontend/subagents-integration.md`（所有权与 kind 契约）
- `.trellis/tasks/10-23-kind-only-surface/prd.md`（父任务验收）
