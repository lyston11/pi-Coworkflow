# Admission authority and dispatch defaults

## Goal

准入只有一个权威 `admitOne()`；直接派单缺的机械参数由扩展补齐。

## 需求

- R1 在 `modules/agent-kinds/index.ts` 导出 `admitOne(host, state, runtime, {kind, count})`，返回 `AdmitResult`（见父任务契约）。它按顺序判定：会话/layer 关闭 → disabled → 未注册 → 计数未知 → 超上限，与现有单派单路径措辞一致（消息构造仍留在 index.ts 的 refusal 函数里）。
- R2 `gate()`（直接派单）与 `gateFanout()`（批次）都改为调用 `admitOne`，**删掉两处重复的 fleet 读取与判定**；批次仍保持"全或无"，但把 count 交给 `admitOne`。
- R3 导出 `applyDispatchDefaults(input, policy, config)`：`input.async = true`（并入现有 `forceBackground`）、`input.options` 缺失时创建、补 `context: "fresh"`、`timeoutMs: config.subagentRunBudgetMs ?? 既有默认`、`checkpointBeforeDeadlineMs: checkpointFor(timeoutMs)`。**任何已存在的显式值都不覆盖。**
- R4 `gate` 准入通过后调用 `applyDispatchDefaults`，并把补齐的字段数计入 state（报告用）。
- R5 测试：
  - 同一 kind、同一状态下，直接派单与批次给出同一 failure code（参数化）；
  - 缺字段被补齐且 `input.options` 被创建；
  - 显式 `context: "fork"`、显式 `timeoutMs` 不被覆盖；
  - 既有 287 条不回归。

## 不做

- 不改 `modules/dispatch/`（另一 lane）。
- 不改受管区与 spec（另一 lane）。

## 交付

提交 `e71f887`。`admitOne` + `applyDispatchDefaults` 已导出，gate 与批次共用；`agentKindsState(host)` 提供给 `modules/dispatch`，准入仍只有一份。测试：三路准入一致、默认补齐、显式值不覆盖。
