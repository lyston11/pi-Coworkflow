## 工作流约束（pi-Coworkflow 受管区）

本区由 `pi-Coworkflow` 生成，`/Coworkflow:init` 会整段覆盖，**不要手工编辑**。项目自己的补充写在受管区之外。

### 本套工作流的开关

本区属于 `pi-Coworkflow`，该扩展在本项目**是否安装、哪几个模块生效、新会话是否自动跑**由项目配置 `.pi/Coworkflow.json` 决定：

- 文件不存在 = 本项目未采用本工作流，扩展在项目里不做任何事（不安装、不注入、不记账）。
- 文件里的 `modules` 是逐模块开关（`trellis` / `worktree` / `agents-md` / `subagents` / `subagent-context` / `lane-worktree` / `panel`）。
- `autoEnable` 决定**新会话是否自动跑**运行时模块；默认不自动跑，需要时用 `/Coworkflow:start` 只为当前会话打开（派发的子 agent 会跟随，因为开关按会话 id 记录）。
- 用 `/Coworkflow:init` 安装或刷新，`/Coworkflow:init --enable <id> --disable <id>` 改模块开关，`--auto-enable on|off` 改新会话自动跑，`/Coworkflow:status` 查看当前状态。关掉某个模块会收回它写下的东西（如本区、`config.yaml` 的 `after_start` 注册）。
- 模型与思考等级用 `/Comodels` 面板调：主会话那一页只影响本会话，子 agent 那一页写本项目 `.pi/settings.json` 的 `subagents.*`（不写全局）。
- 项目以前用过 Trellis 也没关系：`tasks/` `spec/` `workspace/` `.runtime/` 等记录原样保留；范式（Pi 扩展、提示词、agent 定义、workflow 文档）由 `trellis update` 对齐到本仓版本，本包只加自己那一层。
- 这些都是项目级的：不会写用户的全局设置。`pi-subagents` 若已安装则直接复用，否则只声明在项目的 `.pi/settings.json`。

### 任务隔离（多 agent 硬性规则）

多个 agent 共用一个工作区曾导致 `reset` 抹掉 main 上已提交的改动。并行工作必须遵守：

- 一个任务一个分支 + 一个 linked worktree。`task.py start` 的 `after_start` 钩子（`.trellis/scripts/hooks/auto_worktree.py`）自动创建 `feat/<任务目录名>` 分支、在仓库旁 `../{{worktreePrefix}}<任务目录名>` 建 worktree，并把两者写入 task.json 的 `branch` / `worktree_path`。钩子成功时无输出，以 task.json 为准；写代码前必须先 `cd` 进该 worktree，不得在主检出里改业务代码。
- 在自己的分支上只允许 commit；禁止 `reset --hard`、`rebase`、`push -f`、切换到非本任务的分支。需要 main 新代码时 `git fetch` 后把 `origin/main` merge 进自己分支。
- 任何 agent 不得改写 main 或他人分支的历史；历史整理只由人在专门时机做。
- `task.py` 生命周期命令（current / finish / archive 等）在启动任务的主检出里执行；代码改动和提交都在任务 worktree 里。任务确实不需要隔离时（如纯文档小改），完成后用 `git worktree remove ../{{worktreePrefix}}<任务目录名>` 清理。
- 只有文件/模块不相交的任务才并行；共享同一批文件、migration 序号、数据库或端口的任务一律串行。
- 小步提交并尽早 push（或本地 `git branch backup/<任务>` 钉住）；远端是抗本机历史重写的唯一兜底。
- 发现提交被抹掉时：先停掉所有并行 agent，从 `git reflog` 定位丢失提交，用 `git branch rescue/<名> <sha>` 钉住，核对后 cherry-pick 或取回文件。
- 分支合并回 main 由人（或单一串行集成通道）执行，集成时检查 migration 序号冲突。
- 任务收尾必含清理，不得把残留 worktree 留给用户：分支合并进 main、`task.py archive` 完成后，执行集成的 agent 必须立即 `git worktree remove ../{{worktreePrefix}}<任务目录名>` 并 `git branch -d feat/<任务目录名>`，并在交付说明中报告清理结果。删除前置条件：分支已合并进 main、worktree 无未提交代码改动（构建产物等未跟踪文件可忽略）；条件不满足时保留现场并向用户说明原因，禁止用 `--force` / `git branch -D` 掩盖未合并或未提交的工作。

### 子 agent 派单（pi-subagents + Trellis 子任务注入）

主会话是决策者，也是默认执行者。派单只用于并行和隔离，不是把工作推出去；派单的机制细节按需加载 `pi-subagents` skill。

- 授权：主会话可以主动派发子 agent，不必逐次询问。
- 必须后台（`async: true`）。前台子会话是主进程内的一个会话、会占住主会话；后台派单后主会话继续做自己的事，用完成通知和 `subagent({ action: "status" })` 监控，子 agent 的提问走 `contact_supervisor` 转达。实测：后台子会话**会**加载项目 `AGENTS.md` 与 Magic Context（ambient 扩展），所以派单提示词只需给任务，不要把项目约定重抄一遍。
- 子会话**不继承**主会话上下文：派单时显式写 `context: "fresh"`（三个 Trellis 角色 agent 也已声明 `defaultContext: fresh`；若你全局配了 `defaultSubagentContext: "fork"`，它会被覆盖，必须显式 `fresh`）。它拿到的 Trellis 上下文由 `pi-Coworkflow` 的 `subagent-context` 模块按角色注入：`trellis-implement` / `trellis-check` / `trellis-research` 分别得到 `implement.jsonl` / `check.jsonl` / spec 目录树，加上 prd.md、design.md、implement.md；字节预算沿用 `.trellis/config.yaml` 的 `context_injection`。
- 因此派单提示词**首行必须是 `Active task: <任务目录>`**（Trellis 既有的派单协议）——注入靠它定位任务。角色靠**会话名**里的 `trellis-<role>` 识别（`subagent-<agent>-<runId>-<i>` 或 `<agent>: <task>` 都含 agent 名），不需要额外标记；其它角色的 agent 不会得到注入，需要时在它的定义里放 `<!-- trellis-agent: <role> -->`。
- 并行派单不要猜 API：`subagent({ workflow: "parallel", args: { tasks: [...] } })` 的每个 task **只接受 `agent` 和 `task`**（带 `output` 会被拒）；多步/带产出的 workflow 必须把 JS 脚本写成文件再用 `workflow: "<路径>"`，`workflow: true` 只在同一回复里写了 ```js 代码块时有效。先 `subagent({ action: "validate", workflow: "<路径>" })` 再 `async: true` 派发。
- 只派可独立验证的边界工作，且文件/模块不相交才并行（同上一节）。共享文件、migration 序号、数据库或端口的任务一律串行。
- 需要并行写代码的 lane 用 `worktree: true`（pi-subagents 托管 worktree，从干净 HEAD 分配，要求主检出处干净）。产出是每个 lane 的 patch + handoff manifest，**不会**自动应用。
- 合并只由主会话做：`/Coworkflow:lanes` 看 lane 状态、patch 路径与合并计划 → `git apply --3way <patch>` 进主会话自己的 worktree → 审计并跑受影响范围的最小充分检查 → commit → `lane.recordMerge` 记录合并证据 → `worktree.cleanup` 清理（需授权）。子 agent 不合并、不 push。
