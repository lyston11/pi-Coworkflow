# 执行计划：受管区改为运行时能力 + 分工规则

## 步骤

1. 读 `modules/agents/assets/main-AGENTS.region.md` 全文，标记要改的四处：类型表、`trellis-*` 断言、核心分工段、缺失的两条规则。
2. 按 `design.md` 改写；保留文件里已经正确的部分（派单提示词首行 `Active task:`、`context: "fresh"`、预算写法、审计边界、Trellis 角色注入说明）。
3. 检查渲染：`modules/agents/index.ts` 里的占位符（`{{kindLimit}}` 等）是否仍被使用；若某占位符随段落删除而不再出现，同步删除渲染逻辑与对应测试断言。
4. 跑受影响测试（`npm test`）与 `npx tsc --noEmit`。

## 边界

- 只改 `modules/agents/assets/main-AGENTS.region.md`，必要时 `modules/agents/index.ts`。
- 不改 `AGENTS.md`（那是渲染产物，由 `/Coworkflow:init` 重写；本次不跑 init）。
- 不改 `.trellis/`、`.pi/extensions/trellis/`。
- 不提交。

## 上下文

- 规格：`.trellis/spec/frontend/agent-kinds.md`（「三种约束」「类型是注册 + 门禁」）
- 集成契约：`.trellis/spec/frontend/subagents-integration.md`（「Agent kinds」）
- 基础环境：`/Users/lyston/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md`（只读，确认没有任何注入对话的接口被使用）

## 完成定义

- 四处改动齐备，`npm test` 与 `tsc` 通过，报告改动段落与保留段落清单。
