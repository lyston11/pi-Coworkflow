# 执行计划：批次准入只作用于本包 kind

## 步骤

1. 读 `modules/agent-kinds/index.ts` 的 `decodeFanoutCall` / `gateFanout` / `refusal` / `unregisteredRefusal`，确认调用链与错误措辞。
2. 改 `gateFanout`：
   - entries 构造时保留 `policy === undefined` 的项（不删除，只是标记为非本包），或直接过滤；
   - 在 `decide()` 之前加一次「无本包项即返回」的快速退出；
   - `decide()` 内跳过 `policy === undefined` 的项；
   - 计数循环跳过非本包项（现有 `if (policy === undefined) continue;` 保留）。
3. 补两例回归：
   - `parallel` 批次只有 `reviewer` / `trellis-check`：返回 `undefined`，且 fleet 未被调用；
   - 混批 `cw-executor` + `reviewer`：`reviewer` 不产生拒绝理由，`cw-executor` 超上限时理由里只有 `cw-executor`。
4. 跑 `npm test`（受影响范围）与 `npx tsc --noEmit`。

## 上下文

- 规格：`.trellis/spec/frontend/agent-kinds.md`（「三种约束，强度不同」与「占用计数来自上游公开投影」两节）
- 集成契约：`.trellis/spec/frontend/subagents-integration.md`（「Agent kinds」一节）
- 主任务 PRD：`.trellis/tasks/10-23-orchestration-contract/prd.md`

## 完成定义

- 代码改动只落在 `modules/agent-kinds/index.ts` 与对应测试文件。
- 不提交、不合并、不改 spec 正文档（spec 更新由父任务在集成后统一做）。
- 报告：改了哪些函数、两条回归的证据、`npm test` 与 `tsc` 的结论。
