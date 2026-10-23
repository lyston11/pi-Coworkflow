# Parent execution contract and live capabilities

## Goal

主会话收到的执行指引与运行时事实一致：分工说清、可派角色来自当前会话、kind 不可用时有确定行为。

## 背景与已确认缺陷

- 受管区（`modules/agents/assets/main-AGENTS.region.md`）把 kind 表写成静态的「就是这三个」并直接给出 `cw-executor` 等名字。实际可用性取决于本会话是否启用、注册是否成功——本会话在未启用时派单的真实返回是上游 `Unknown agent 'cw-auditor'`，而静态文档仍要求使用它。
- 受管区没有规定「要求的 kind 不可用时怎么办」，于是最近的失败模式是：静默改用 `trellis-*`（绕开项目开关与上限），或者干脆自己动手。
- Trellis 的 Pi 扩展在 `in_progress` 注入的 inline 步骤（自己读规范、自己实现、自己跑检查）与受管区相反。该文件由 Trellis 拥有，本任务**不改写**它。

## 需求

- R1 受管区不得把可派角色写成固定清单；改为「以 `/Coworkflow:status` 的实时列表为准」，并保留 kind 与 Trellis 角色的对应关系（角色映射是稳定的，注册状态不是）。
- R2 受管区必须规定不可用时的行为：报告不可用原因，并把该工作单元保留在主会话（或改派给一个**被允许**的 kind），**不得**静默换成 `trellis-*` 或自己顶替。
- R3 受管区必须写清「开始执行前先确定分工」：判断/契约/验收/集成留主会话；有输入、产物、验收条件的工作单元交给子 agent；小改动可留在主会话但要记录范围。这不是按工具调用次数触发的提醒。
- R4 受管区必须说明 Trellis 的 inline 步骤与本文冲突时以本文为准（分工），同时不要求改写 Trellis 的生成资产。
- R5 渲染器（`modules/agents/index.ts`）对已有占位符的行为不变；已有测试全绿。

## 约束

- 只改 `modules/agents/assets/main-AGENTS.region.md` 与（必要时）`modules/agents/index.ts` 的渲染占位符。
- 不引入对话注入、不引入计数提醒。
- 不改 `.trellis/workflow.md`、`.pi/extensions/trellis/`、`trellis-*` agent 定义。

## 验收

- [ ] 受管区全文不再出现「类型就是这三个」「不要写 trellis-*，写 cw-*」式无条件断言，改成带条件的表述。
- [ ] 有「kind 不可用时」的明确规则。
- [ ] 有「执行前确定分工」的明确规则（含小改动留主会话的判据）。
- [ ] 有「与 Trellis inline 步骤冲突时以本文为准」的一句，且不要求改 Trellis 资产。
- [ ] `npm test` 全绿（渲染/文案相关测试未破坏）。
