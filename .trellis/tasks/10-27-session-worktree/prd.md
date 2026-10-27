# 每个 pi 会话自动隔离在独立 worktree，并提供合并回 main

## 问题（已核实的现状）

多个 pi 进程在同一 checkout 里并发执行时，子 agent 落在共享工作区，互相覆盖文件与提交。四处成因，全部有代码/配置锚点：

1. **隔离是 opt-in。** `coworkflow_dispatch` 只有 `worktree === true` 才给每个单元加标记（`modules/dispatch/index.ts:541,744`），schema 无默认（`:893`）；`coworkflow.fanout` 要 `worktrees: true`。上游支持项目级默认 `subagents.worktree: true`（`pi-subagents/docs/configuration.md:637`），本项目与全局 settings 都没设。
2. **子进程从不接收 cwd。** 只有 `/Coworkflow:run` 传 `cwd: plan.worktree`（`modules/subagents/index.ts:1152`）并强制校验（`:1249`）；`coworkflow_dispatch` 的 RPC spawn 参数只有 `agent/task/context/timeoutMs/worktree?`（`modules/dispatch/index.ts:737`）→ 子进程继承父 cwd。父会话多半在主检出里，于是所有进程写同一份文件。
3. **fanout 的回退是写明的设计**：「children fall back to the workflow's own cwd when no task is prepared」（`modules/subagents/index.ts:1248`）。
4. **上游 worktree 有硬前提**：`worktree isolation requires a clean git working tree`（`pi-subagents/src/runs/shared/worktree.js:204`）——脏主检出是启动失败，不是回退。

## 目标行为

**一个 pi 会话 = 一个隔离单元（一个 linked worktree + 一个分支），所有子 agent 在其中执行；结束时由显式命令合并回 main 并清理。** 不需要用户记得传任何 flag，也不需要每个进程手工 `task.py start`。

## Requirements

- R1 **自动分配**。会话第一次派单时（惰性，不在 session 启动时创建空 worktree）解析隔离工作树，优先级：
  1. 活跃 Trellis 任务的 `worktree_path`（沿用 `planRun` 已有的四项校验：目录存在、非主检出、分支匹配、git 归属）；
  2. 否则按会话分配 `../wt-cw-<sessionShort>`，分支 `cw/<sessionShort>`，基线取 `git symbolic-ref refs/remotes/origin/HEAD` 指向的分支（无远端时退回当前 HEAD），并把 `.trellis/{tasks,scripts,workspace,config.yaml,workflow.md}` 与 `.pi` 软链进去（复用 `auto_worktree.py` 的 `MATERIALISE` 语义，否则子 agent 读不到 PRD、spec 与 kind 定义）。
  - 必须能在**脏主检出**上分配（`git worktree add` 本身不要求 clean，不受上游那条限制）。
- R2 **cwd 委派覆盖所有启动路径**。`tool_call` 钩子对 `subagent` 的 input **就地写入** `cwd`（pi 文档 `docs/extensions.md:208,218` 明确允许 mutate `input`），这样直派也会落到会话 worktree；`coworkflow_dispatch` 的 RPC spawn 显式传 `cwd`；fanout 的 workflow 启动传 `cwd`。
- R3 **失败要说清，不许静默回退**。分配失败（无 git 仓库、`git worktree add` 失败、任务 worktree 校验不通过）时：拒绝写类派单并给出原因与出路；**不得**悄悄退回共享 cwd 继续执行。
- R4 **合并回 main 是一个显式动作**。`/Coworkflow:merge`：
  - 先展示 `git log --oneline main..cw/<id>` 与 `git status` 结论，未提交改动存在时拒绝合并；
  - 合并用 `--no-ff` 进基线分支，冲突时停下并保留现场（不自动解冲突、不 push）；
  - 由人（或单一集成通道）决定，符合项目既有的「分支合并回 main 由人执行」约束。
- R5 **退出清理**。会话结束（`session_end`）时：分支已合并进基线且 worktree 无未提交改动 → 提供清理；不满足则保留并在 `runtimeStatus` 写明原因，禁止 `--force`／`-D` 掩盖未合并工作。
- R6 **可观测**。`/Coworkflow:status` 必须显示：本会话的隔离 worktree 路径、分支、基线、工作树是否干净、与基线相比的提交数；没有隔离时显示为什么没有。缺一不可，避免「以为隔离了其实没有」。

## 非目标

- 不改变 `/Coworkflow:run`（implement→review）的现有语义，它继续要求 Trellis 任务 worktree。
- 不自动 push、不自动解冲突、不自动 rebase 他人分支。
- 不在子会话里再分配 worktree（会话级隔离是唯一的隔离单元）。
- 不接管父会话自己的 cwd（pi 会话 cwd 固定启动值；父会话在主检出里做规划/审计，写业务代码交给子 agent 或 `cd` 进 worktree）。

## Acceptance Criteria

- [ ] 在一个**脏**主检出里开新会话、直接派 3 个 executor，三者都在同一个会话 worktree 里执行，主检出无新增改动；`/Coworkflow:status` 显示路径/分支/基线/提交数。
- [ ] 同一仓库再开第二个会话，派同样的工作 → 拿到**另一个** worktree 与分支，两会话互不覆盖。
- [ ] 活跃 Trellis 任务存在时，复用其 `worktree_path`，不新建第二个 worktree。
- [ ] 任务 worktree 校验失败、或仓库无 git 时，写类派单被拒且原因可读；没有任何一路静默落回共享 cwd。
- [ ] `/Coworkflow:merge` 在干净且有提交时合并成功；有未提交改动时拒绝；冲突时停下并保留现场。
- [ ] 合并后清理：worktree 被移除、分支被删除；未合并时保留现场并在状态里说明。
- [ ] `scripts/` 下对应单测覆盖：分配优先级、注入 cwd、拒绝路径、合并前置条件、清理前置条件。

## Notes

- 相关实现位置：`modules/dispatch/index.ts`（spawn 参数）、`modules/subagents/index.ts`（`planRun` 与 workflow cwd）、`modules/agent-kinds/index.ts`（`tool_call` gate，注入点）、`modules/worktree/`、`modules/lane-worktree/`、`core/`（runtime.sessionId / configRoots）。
- 上游参照：`pi-subagents/docs/configuration.md:617-637`（worktreeBaseDir / worktreeProvider / 项目级 `worktree: true` 默认）、`src/runs/shared/worktree.js:204`（clean source 限制，我们不用它）、pi `docs/extensions.md:208,218`（`tool_call` 可 mutate `input`）。
- 记录相关：`10-26-script-workflow-kinds` 记录的是脚本通道的 kind 治理缺口，与本任务的 cwd 委派相邻但独立。
