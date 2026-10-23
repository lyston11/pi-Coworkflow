# Queued dispatch channel

## Goal

`coworkflow.dispatch`：一次交全部工作单元，按 kind 上限排队，完成一个自动启动下一个；支持 `needs` 依赖。

## 需求

- R1 新模块 `modules/dispatch/`，注册工具 `coworkflow.dispatch`，input/output 见父任务契约。
- R2 每次实际启动前调用 `admitOne(host, state, runtime, {kind, count: 1})`（从 `modules/agent-kinds/index.ts` 导入）。`ok` → 启动；`over-ceiling` → 入队（reason `ceiling`）；`disabled` / `unregistered` → failed（不排队，等也不会好）；`unknown-count` / `session-gone` → failed 并说明。
- R3 启动走上游公开 RPC：`pi.events.emit("subagents:rpc:v1:request", {version:1, requestId, method:"spawn", params:{ agent, task, context:"fresh", timeoutMs, checkpointBeforeDeadlineMs }})`，回复在 `subagents:rpc:v1:reply:<requestId>`。若 `core/subagents-client.ts` 已有可用封装，优先复用，不要另造。
- R4 续派：监听上游完成事件（`events.asyncComplete` 能力；若不可用则监听现有 settled 通知路径），一个 run 结束后释放它占的 kind 名额，并重新调度队列。**不得用定时器轮询。**
- R5 依赖：`needs: [key...]`，全部前置 `completed` 才 ready；前置 `failed` → 本任务 failed（reason `dependency`）。
- R6 状态：进程内，按会话隔离；会话换代后旧队列作废并报告，**不当作空队列**。`/Coworkflow:status` 增加一行：`dispatch: N 运行 / M 排队（原因分布）`。
- R7 测试（不启动真实子进程：注入一个 fake spawn）：
  - 上限 2、提交 4 → started 2 / queued 2；模拟一个完成 → 自动启动第 3 个；
  - `needs` 未满足保持 queued，前置完成后启动；
  - 前置 failed → 后继 failed；
  - disabled kind → failed 而非 queued；
  - 换代后队列作废且报告。

## 不做

- 不持久化队列到磁盘。
- 不自己 fork 子进程，不实现第二套执行器。
