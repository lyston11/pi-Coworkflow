<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten when the template is rendered again.

<!-- TRELLIS:END -->

<!-- pi-Coworkflow:start -->
<!-- pi-Coworkflow:start -->
## 工作流约束（pi-Coworkflow 受管区）

本区由 `pi-Coworkflow` 生成；修改本包模板后通过 `/Coworkflow:init` 刷新，不手工编辑受管区。项目补充写在区外。

### 默认执行与按需委派

**主会话默认负责端到端交付：理解需求、规划、实现、验证、验收与集成。** 复杂任务也可以连续直接完成；不强制并行，不固定经过规划、执行、审计流水线。

只有收益高于重复上下文、交接和集成成本时才派单：具体难点的规划建议、可独立查证的调研、边界清楚且容易检查的实现，或风险值得独立复核的改动。耗时长、工具调用次数和文件数量本身都不是派单理由。

- 子 agent 提建议，最终决定和验收留在主会话。咨询与审计默认只读；发现问题报告证据，由主会话决定并实施修复。
- 主会话核对真实产物与验证证据；只补缺失检查，或重跑被集成改变的行为，不机械重复全量验证。
- 没有独立工作时交还控制，等待原生完成通知；不 sleep、不轮询，也不用 `bg_wait` 等原生异步子任务。

### 配置与类型

`.pi/Coworkflow.json` 决定本项目是否采用本工作流、模块开关和 `autoEnable`；不存在时扩展不安装、不注入、不记账。用 `/Coworkflow:init` 安装/刷新，`/Coworkflow:start` 切换当前会话，`/Coworkflow:status` 看实际状态。模板刷新保留 `tasks/spec/workspace/.runtime` 记录与项目配置，不写全局设置。

- 可派类型以当前 `/Coworkflow:status` 或 `subagent({ action: "list" })` 为准，不能仅凭文件存在认定已注册。
- kind 按用途分；随附 executor（委派实现）、planner（方案建议）、auditor（只读审查）、researcher（事实调查）、worker（已定步骤）。可以增删或改名。
- 每个类型的完整提示词在 `.pi/Coworkflow/agents/<kind>.md`；frontmatter 声明用途、agent、role、context 与默认参数。CLI：`pi-coworkflow kind scaffold|export|set --from|check`。
- 模型按用途分别配在 `.pi/Coworkflow.json` 的 `agentKinds.<kind>.model`；数量与开关也沿用项目配置，随附默认上限 5。不硬编码模型名称，不按耗时推定适合低成本模型。
- `/Comodels` 主会话页只影响当前会话，默认子 agent 页写项目 `.pi/settings.json` 的 `subagents.*`，各 kind 页写各自配置。父会话解析默认模型后随启动下发；无效模型拒绝派单并说明原因。
- 派单失败时先读并报告原因。不得换成 `trellis-*` 或改名绕过开关与数量限制；选已注册的合适 kind，或由主会话完成。没有 `subagent` 工具就直接实施；确需委派时才报告缺失及安装/重载办法，不用搜索工具反复找它。

### 派单契约

- 主会话可按需派单，无需逐次询问；**必须后台**：`async: true`，并显式传 `context: "fresh"`。子 agent 不再委派。子 agent 不合并、不 push。
- 交代目标、必要上下文、写入范围、产物、验收方式和预算；配置 `timeoutMs` 与 `checkpointBeforeDeadlineMs`，并在任务文本写清时限和交接要求。
- 属于 Trellis 任务时首行写 `Active task: <真实任务路径>`；独立小工作写 `Active task: (none)`，直接提供必要文件，无需为派单另建任务。路径无效会报告，不改绑其它任务；省略引用仅保留兼容性回退，不是推荐写法。
- 子会话按定义注入：implement → `implement.jsonl` 与任务工件，check → `check.jsonl` 与工件，research 默认只有 spec 目录树；`context: task` 为 research 增加任务工件和实现清单（planner 默认启用）。`role: none` 只加载通用子 agent 约定；预算沿用 `context_injection`。这里的定义字段 `context` 与启动参数 `context: "fresh"` 不同。
- 单件用 `subagent`；已决定委派的批量用 `coworkflow_dispatch` 一次交齐，依赖写 `needs`。只有需要特定流程/独立产物契约时才选命名 workflow；不要用脚本自行启动来绕过准入，API 不确定先读工具契约。
- 子会话加载通用子 agent 约定和本项目受管区外的规则，受管区本身会被剥离；派单无需重抄规则。咨询默认返回建议，只有派单明确许可才可在指定路径写报告。

### 写入、Git 与任务收尾

- Trellis 任务一个分支、一个 linked worktree。`task.py start` 后读 task.json 的 `branch/worktree_path`，写代码前进入该目录（通常 `../wt-<任务名>`）。生命周期命令在启动任务的主检出里执行。
- 子 agent 默认共用会话 worktree：当前 linked worktree → 已验证的活跃任务 worktree → 会话 worktree。分配失败拒绝启动，不退回共享主检出；验收时核对子 agent 的实际 cwd。
- worktree 中已跟踪的 `.pi/.trellis` 可能是提交快照；以主检出记录为准，注入提供工件绝对路径。不得用软链覆盖受跟踪文件来强行共享，这会破坏 Git 合并。
- 同一工作区的批量写任务声明 `files`，只读写 `files: []`。已声明的重叠路径排队；遗漏声明仍可并行且报告风险，不能据此假定安全。目录覆盖其下路径，不覆盖同名字符串前缀。
- 主会话的直接写入不受子任务队列的 `files` 检查保护；不得与子 agent 占用路径重叠。共享工作区只有主会话在写入停止后操作 Git index 和提交。
- 独立 lane 才用 `worktree: true`（fanout 为 `worktrees: true`）；需要干净 HEAD，产出 patch 不会自动应用。主会话串行集成、核查证据、提交，再记录合并并按授权清理。
- 禁止 `reset --hard`、`rebase`、`push -f`、切到他人分支或改写基线历史；需新基线时 fetch 后 merge。丢提交时先停写，用 reflog 定位并建 rescue 分支固定，再恢复。
- 合并由主会话或唯一集成通道执行。`/Coworkflow:merge` 遇未提交改动或冲突会停下，不自动 push 或删除 worktree。
- 完成任务后归档；仅在分支已合并且 worktree 无未提交代码时，执行 `git worktree remove` 和 `git branch -d`，报告清理结果。条件不足保留现场并说明；禁止用 `--force` 或 `-D` 掩盖未交付工作。
<!-- pi-Coworkflow:end -->
<!-- pi-Coworkflow:end -->
<!-- pi-Coworkflow:end -->
