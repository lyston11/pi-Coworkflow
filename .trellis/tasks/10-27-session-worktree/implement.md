# 实施计划

按依赖顺序，每一步都能独立验证。工作在本仓库主检出进行：本检出就是 `~/.pi/agent/settings.json` 里加载的扩展路径，改动必须落在它上面才能被真实会话加载验证。

## 1. 模块骨架与 resolve

- 新增 `modules/session-worktree/index.ts`，`WorkflowModule` id `session-worktree`，注册进 `modules/index.ts`。
- `resolveSessionTree(host, runtime)`：
  - 任务优先：复用 `modules/subagents/index.ts` 的 `planRun()`（导出现有函数或提取共用版本），通过即返回；
  - 否则会话级：`wt-cw-<short>` / `cw/<short>`，基线 `origin/HEAD` → 退化 HEAD；
  - 幂等：已存在且归属正确则复用；不符则失败对象（不是异常）。
- 缓存 per `sessionEpoch`，`onSessionEnd` 清空。
- 验证：`scripts/session-worktree.test.ts` 用临时 git 仓库跑优先级、脏检出、幂等、归属不符。

## 2. 分配与软链

- `git worktree add -b <branch> <path> <base>`（`execFileSync`，`-C <repoRoot>`，超时 120s）。
- 软链 `.trellis/{tasks,scripts,workspace,config.yaml,workflow.md}` 与 `.pi`（与 `auto_worktree.py` 的 `MATERIALISE` 一致；已存在则跳过）。
- 验证：分配后 worktree 里能读到 PRD、spec、`.pi/Coworkflow.json`；主检出无新增改动。

## 3. cwd 注入（直派 + fanout）

- `tool_call` 上注入 `input.cwd`（只在 `launchesChildren(event.input)` 为真且调用方未指定 `cwd` 时）。
- `modules/subagents/index.ts` 的 fanout 启动传 `cwd`。
- 验证：`agent-kinds.test.ts` 增一条——注入后 gate 判定不变，管理面调用不被改写；真实会话确认子进程 workspace 是 worktree 路径。

## 4. dispatch 的 cwd

- `spawnViaRpc` 参数加 `cwd: tree.path`；resolve 失败时该单元的派单被拒，理由进入队列状态（`dispatch` 已有 `gated` 语义，复用）。
- 验证：`dispatch-queue.test.ts` / `dispatch-host.test.ts` 断言 spawn 参数含 cwd；失败路径的拒绝文案包含原因。

## 5. `/Coworkflow:merge`

- 注册命令（参照 `modules/subagents/index.ts:991` 的 `registerCommand` 用法）。
- 顺序：`status --porcelain` 空 → `log base..HEAD` 非空 → `git merge --no-ff`；冲突/脏 → 拒绝并保留现场；不 push、不删 worktree。
- 验证：临时仓库单测三条（成功、脏、冲突），以及一次真实会话的合并。

## 6. 退出清理与状态行

- `runtimeStatus` 加一行：path · branch · base · clean/dirty · N commits ahead，或失败原因。
- `session_end`：已合并且干净 → 清理（`git worktree remove` + `git branch -d`）；否则保留并记录原因。禁止 `--force`/`-D`。
- 验证：状态行在「未启用 / 分配中 / 已分配 / 失败」四种情况下各显示对的内容；清理前置条件单测。

## 7. 收尾

- `AGENTS.md` 受管区与 `modules/agents/assets/main-AGENTS.region.md` 同步：会话 worktree 的默认行为、`/Coworkflow:merge` 的用法、父会话写主检出的边界。
- `.trellis/spec/frontend/` 补一节：会话级隔离的边界与失败语义。
- `node --test` 跑受影响文件；真实双会话并发验证；提交。
