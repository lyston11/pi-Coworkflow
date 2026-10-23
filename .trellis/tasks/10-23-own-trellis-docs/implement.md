# 执行计划

1. 读 README 的安装/前置章节，定位所有 `trellis init` / `trellis update` 指令。
2. 改写 README 安装流程；加一节「模板与 CLI 的分工」。
3. 改 `modules/agents/assets/main-AGENTS.region.md` 里那句 `trellis update` 对齐说明。
4. 改两处 spec 的因果表述。
5. 跑 `npm test` + `npx tsc --noEmit`。不提交。

## 边界

- 只改这三个文档面（README、受管区资产、两份 spec）。
- 不改 `modules/trellis/index.ts`（渲染实现归另一个 lane）。
- 不改 `.trellis/workflow.md`。
