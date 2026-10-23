# 设计：批次准入只作用于本包 kind

## 现状

`decodeFanoutCall` 把 `coworkflow.fanout` 与上游 `parallel` 的 `args.tasks[*]` 归一成 `{ kind: <名字>, count }`，其中 `<名字>` 可能是 kind 名（`executor`）也可能是 agent 名（`cw-executor`）。`gateFanout` 再拿这个名字查项目 kind 表。

缺陷不在解码，而在判定：查不到 policy 时返回 `unregisteredRefusal`，等于把「不认识的名字」当成「本包声明了但没注册的 kind」。

## 判定规则（唯一实现）

批次项分三类，按顺序判定：

| 类别 | 条件 | 行为 |
|---|---|---|
| 非本包 | `policy === undefined`（名字不在 kind 表） | **跳过**：不拒绝、不计数 |
| 本包·不可派 | policy 存在但 `!enabled`，或不在本会话已注册集合 | 拒绝整次调用（现状语义） |
| 本包·可派 | 其余 | 累计计数后做上限判定 |

批次进入判定前先做一次快速返回：若没有任何项解析到 policy，立即 `return undefined`——在任何 `attachSubagents` / `agentCount` 之前，这样普通批次连一次公开读取都不产生。

上限与计数仍按 kind 聚合（同一 kind 多次出现取和），因为上游 `parallel` 允许同名多任务。

## 为什么仍然整批拒绝

`coworkflow.fanout` 与本包文档的契约是「要么全跑要么不跑：只启动一部分比一个都不启动更糟」。逐任务准入是另一个决定，属于 `10-23-orchestration-scheduler` 的评估范围；本轮不改变已声明的语义，只修正「谁算本包的 kind」。

## 措辞

拒绝理由固定三段：起因（kind/agent/上限/占用）、影响（本次调用全部子进程都不会启动）、恢复（减任务数、等结束、调高上限）。非 kind 项不出现在理由里，因为它们与拒绝无关。

## 落点

- `modules/agent-kinds/index.ts`：`gateFanout` 的 entries 构造与 `decide()`。
- 测试：`modules/agent-kinds/` 下既有的 gate/fanout 测试文件（新增两例：纯非 kind 批次、混批）。

## 失败模式

| 失败模式 | 要求 |
|---|---|
| 把非 kind 当未注册 | 不得发生；回归守着 |
| 纯非 kind 批次仍读 fleet | 不得发生；回归断言 `agentCount` 未被调用 |
| 混批时用非 kind 的理由拒绝 | 理由里只出现 kind 项 |
| 计数读不到就放行 | 仍拒绝（unknown ≠ 0） |
