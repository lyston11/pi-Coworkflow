# 执行计划

1. 收集模板：把当前主检出里已验证的资产复制进 `templates/trellis/`（`dot-trellis/`、`dot-pi/`、`dot-agents/`），排除 `tasks/`、`spec/`、`workspace/`、`.template-hashes.json`。
2. 写 `planTemplate` / `writePlanned` / `migrateLegacy`，接进 `modules/trellis/index.ts` 的 init 流程；删掉对外部 `trellis` 生成器的调用与版本比较报错。
3. `probeOptionalCli`：`trellis` 不在 PATH 时报告一行可选能力缺失。
4. `package.json#files` 加 `templates/`。
5. 测试（新增文件 `scripts/trellis-template.test.ts`）：golden、幂等、用户数据保护、迁移、无 CLI 五条。
6. 跑 `npm test` + `npx tsc --noEmit`。不提交。

## 上下文

- `.trellis/spec/frontend/subagents-integration.md`（「Retiring the trellis-* role agents」一节，本次把它从「覆盖补丁」改为「模板即真相」）
- `.trellis/spec/frontend/agent-kinds.md`
- 父任务 `.trellis/tasks/10-23-own-trellis/prd.md`
