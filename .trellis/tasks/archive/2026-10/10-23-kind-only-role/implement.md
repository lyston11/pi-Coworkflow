# 执行计划

1. 读 `modules/agent-kinds/defaults.ts`、`definitions.ts`、`modules/subagent-context/index.ts`，确认 shipped 资产如何进入 `definitions`。
2. 三个资产加 `role:` frontmatter；`defaults.ts` 删 `role` 字段与兜底。
3. 删 `subagent-context` 的名字猜角色路径，保留 marker 与定义文件。
4. 加反向断言（`trellis-check` 名字不再注入 check 上下文），跑 `npm test` + `npx tsc --noEmit`。
5. 不提交；只改上述文件与相关测试。

## 上下文

- `.trellis/spec/frontend/agent-kinds.md`（kind 端口与角色映射的现有描述）
- `.trellis/tasks/10-23-kind-only-surface/prd.md`
