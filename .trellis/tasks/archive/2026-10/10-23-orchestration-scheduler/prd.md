# Bounded work-unit scheduling and continuation

## Goal

把「派单成本高」这件事收敛成一条明确的边界决定：哪些准入逻辑属于本包，哪些必须留给上游；本轮只落地可验证的部分。

## 问题

每类上限超限时整批被拒（`coworkflow.fanout` 与上游 `parallel` 都是如此）。对独立任务 N>上限 的常见情形，主会话必须：自己拆批 → 派一批 → 等完成 → 续派。模型因此把「派单」当成昂贵操作，倾向于自己做完。

## 本轮结论（决策记录）

1. **排队不做。** 上游是执行与容量的所有者；本包再实现一个队列就是第二运行器，会与上游 capacity 冲突，且必须在本地维护运行账本——这正是 `subagents-integration.md` 明令禁止的。
2. **整批拒绝保留。** 「只启动一部分」会让主会话以为任务已派出，实际一半没跑；全或无是当前唯一诚实的语义。
3. **可做的是降低「派出前的机械决策」**：后台强制、`context: "fresh"`、预算与交接时间、`outputSchema`、`acceptance` 已经由 `coworkflow.fanout` 统一补齐，主会话只需给 kind 与任务文本。
4. **需要模型自己做的只剩一件事**：把工作切成不超过每类上限的批次。这条要在受管区写清（见 `10-23-orchestration-parent`），而不是靠机制绕过。

## 后续可选方向（本轮不实现）

- 主会话一次给出全部工作单元，由扩展按上限分批、按完成通知续派。代价：需要在上游之外维护「已声明未启动」的状态，并为中断/换代定义语义；在真正需要前不引入。

## 验收

- [ ] 决策记录写入 `.trellis/spec/frontend/subagents-integration.md`（「Project capacity scope」一节补一句：整批拒绝是有意的，续派由主会话决定）。
- [ ] 不新增队列、账本、重试或定时器代码。

## 结果（已完成）

决策已写入 `.trellis/spec/frontend/subagents-integration.md` 的「Project capacity scope」：整批拒绝是有意的，拆批与续派归主会话；本包不建立队列、待启动账本或重试定时器。未新增任何调度代码。
