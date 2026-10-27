## 工作流约束（pi-Coworkflow 受管区）

本区由 `pi-Coworkflow` 生成，`/Coworkflow:init` 会整段覆盖，**不要手工编辑**。项目自己的补充写在受管区之外。

### 本套工作流的开关

本区属于 `pi-Coworkflow`，该扩展在本项目**是否安装、哪几个模块生效、新会话是否自动跑**由项目配置 `.pi/Coworkflow.json` 决定：

- 文件不存在 = 本项目未采用本工作流，扩展在项目里不做任何事（不安装、不注入、不记账）。
- 文件里的 `modules` 是逐模块开关（`trellis` / `worktree` / `agents` / `subagents` / `subagent-context` / `lane-worktree` / `capacity` / `panel`）。
- `autoEnable` 决定**新会话是否自动跑**运行时模块；默认不自动跑，需要时用 `/Coworkflow:start` 只为当前会话打开（派发的子 agent 会跟随，因为开关按会话 id 记录）。
- 用 `/Coworkflow:init` 安装或刷新，`/Coworkflow:init --enable <id> --disable <id>` 改模块开关，`--auto-enable on|off` 改新会话自动跑，`/Coworkflow:status` 查看当前状态。关掉某个模块会收回它写下的东西（如本区、`config.yaml` 的 `after_start` 注册）。
- 模型与思考等级用 `/Comodels` 面板调：主会话那一页只影响本会话，子 agent 那一页写本项目 `.pi/settings.json` 的 `subagents.*`（不写全局）。
- 范式文件（Pi 扩展、提示词、agent 定义、workflow 文档、Trellis 脚本）由**本包随附的模板**渲染，只有这一个来源；要刷新就再跑一次 `/Coworkflow:init`，它只写范式，`tasks/` `spec/` `workspace/` `.runtime/` 等记录原样保留。
- 这些都是项目级的：不会写用户的全局设置。`pi-subagents` 若已安装则直接复用，否则只声明在项目的 `.pi/settings.json`。

### 任务隔离（多 agent 硬性规则）

多个 agent 共用一个工作区曾导致 `reset` 抹掉 main 上已提交的改动。并行工作必须遵守：

- 一个任务一个分支 + 一个 linked worktree。`task.py start` 的 `after_start` 钩子（`.trellis/scripts/hooks/auto_worktree.py`）自动创建 `feat/<任务目录名>` 分支、在仓库旁 `../{{worktreePrefix}}<任务目录名>` 建 worktree，并把两者写入 task.json 的 `branch` / `worktree_path`。钩子成功时无输出，以 task.json 为准；写代码前必须先 `cd` 进该 worktree，不得在主检出里改业务代码。
- **会话本身也有隔离 worktree（`session-worktree`，默认开）。** 每个 pi 会话解析出一个 worktree，所有子 agent 在其中执行，不再落在共享检出里：优先级是「你已 `cd` 进去的 linked worktree」→「活跃任务 task.json 的 worktree」→「会话 worktree `../wt-cw-<token>` / 分支 `cw/<token>`（从 `origin/HEAD` 指向的基线切出）」。分配失败（非 git 仓库、`worktree add` 失败、同名分支非本会话）时**派单被拒并写明原因**，不静默退回共享目录。新 worktree 会软链 `.trellis/{tasks,scripts,workspace,config.yaml,workflow.md}` 与 `.pi`，子 agent 因此能读 PRD、spec 与 kind 定义。父会话仍负责规划/审计，写业务代码交给子 agent。
- 会话 worktree 的收尾是显式的：`/Coworkflow:merge` 先看 `git status` 与 `git log <基线>..HEAD`，有未提交改动或冲突就停下（不自动解冲突、不 push、不删 worktree）；合并成功后才由人确认清理。多个会话各拿各的分支，合并顺序由人定。
- 在自己的分支上只允许 commit；禁止 `reset --hard`、`rebase`、`push -f`、切换到非本任务的分支。需要基线分支的新代码时 `git fetch` 后把上游基线 merge 进自己分支（分支名按仓库而定，常见是 `origin/main`；以 `git symbolic-ref refs/remotes/origin/HEAD` 的结果为准）。
- 任何 agent 不得改写基线分支或他人分支的历史；历史整理只由人在专门时机做。
- `task.py` 生命周期命令（current / finish / archive 等）在启动任务的主检出里执行；代码改动和提交都在任务 worktree 里。任务确实不需要隔离时（如纯文档小改），完成后用 `git worktree remove ../{{worktreePrefix}}<任务目录名>` 清理。
- **默认并行，串行要给出理由。** 拆分多段工作时的顺序是：先定**接口契约**（函数签名、payload 形状、端点、状态字段），再让各段在**各自 worktree**里并行实现，最后由主会话集成后独立审阅。
- **「共用一个 worktree，不能同时写」不是串行的理由** —— 那是配置问题不是依赖问题：`coworkflow.fanout` 传 `worktrees: true`，每个 lane 拿自己的独立 worktree，产出 patch 由主会话按顺序 `git apply --3way` 集成。
- 真正必须串行的只有一种：后一步**必须看到前一步已实现的行为**才能定下自己的接口——那就说明契约还没定，先定契约，再并行。
- 其余共享同一批**具体行**（同一文件同一段）、migration 序号、数据库或端口的，按契约切分后仍并行；切不开才串行，并在交付说明里写清为什么。
- 小步提交并尽早 push（或本地 `git branch backup/<任务>` 钉住）；远端是抗本机历史重写的唯一兜底。
- 发现提交被抹掉时：先停掉所有并行 agent，从 `git reflog` 定位丢失提交，用 `git branch rescue/<名> <sha>` 钉住，核对后 cherry-pick 或取回文件。
- 分支合并回 main 由人（或单一串行集成通道）执行，集成时检查 migration 序号冲突。
- 任务收尾必含清理，不得把残留 worktree 留给用户：分支合并进 main、`task.py archive` 完成后，执行集成的 agent 必须立即 `git worktree remove ../{{worktreePrefix}}<任务目录名>` 并 `git branch -d feat/<任务目录名>`，并在交付说明中报告清理结果。删除前置条件：分支已合并进 main、worktree 无未提交代码改动（构建产物等未跟踪文件可忽略）；条件不满足时保留现场并向用户说明原因，禁止用 `--force` / `git branch -D` 掩盖未合并或未提交的工作。

### 核心分工：主会话只做脑子，执行全部交出去

**主会话负责规划、拆解、派单、监听、审计、决策；具体的执行工作由多个子 agent 完成，子 agent 只回结果。** 主会话不是执行者，它派完单不空等——继续做自己的判断、盯着进度、随时审计，直到总任务完成。

**执行归属以本节为准。** Trellis 的 Pi 分支（`.trellis/workflow.md` 与 `in_progress` 的 inline 步骤）写的是「自己读规范、自己实现、自己跑检查」——那描述的是这一步**要做完什么**，不改变**由谁做**。两者冲突时按本节分工执行；这是唯一需要点明的冲突，且不需要、也不应该去改写 Trellis 的生成资产（`.trellis/workflow.md`、`.pi/extensions/trellis/`、`trellis-*` agent 定义）。

```text
主会话
  ├─ 规划：理解需求 → 建/更新 Trellis 任务 → 拆成可独立验证的子任务
  ├─ 派单：subagent({ agent: "<kind 的 agent 名>", … })（可用名字看 /Coworkflow:status）
  │          多件互不依赖的工作：workflow "coworkflow.fanout" 一次并发派出
  ├─ 监听：完成通知 + subagent({ action: "status" })；子 agent 提问走 contact_supervisor
  ├─ 中断：/Coworkflow:stop <runId>（停止）或 /Coworkflow:steer <runId> <说明>（追加指令）
  ├─ 审计：读 diff / 产物，对照 prd 验收条件，跑受影响范围的最小充分检查
  └─ 决策：合并、重派、调整拆分，或回头改需求
```

主会话自己动手的唯一场合：**需要全局判断、或改动小到不值得派单**（一行修复、改个配置、回答一个问题）。除此之外，"我来写"不是理由——派出去、审回来。

#### 开始执行前先定分工

动手之前把这一轮的工作单元列出来，每个标注归属，然后再开始：

| 交给子 agent | 留在主会话 |
|---|---|
| 有明确输入、产物、验收方式 | 需要全局判断或跨模块契约 |
| 能独立验证（它自己的检查就能判定对错） | 最终验收与集成（审计、合并、决策） |
| 工作量大于一次派单的成本 | 改动小到派单成本更高：一行修复、一个配置值、回答一个问题 |

- 留主会话的小改动**要在交付说明里写出范围**（改了哪几处），别因为"顺手"扩成一次大改。
- 分工是执行前的一次决定，不是按工具调用次数触发的提醒：本包不统计调用次数，也不会为这件事往对话里注入消息。分不清时按上表判——输入、产物、验收说得清的执行工作就派出去。

### 可派角色以 `/Coworkflow:status` 为准

本项目装了 `agent-kinds` 模块后，可派的子 agent 类型（kind）由**本会话的注册状态**决定，而它会变：项目可能关掉某类、改它的上限，注册也可能失败。所以本文件**不写死清单**——这一会话能派哪些 agent，以 `/Coworkflow:status` 的 `agent-kinds` 行为准（每个已注册 kind 一行：`= agent-kinds: cw-executor（kind executor）已注册 · 模型 …`），或以 `subagent({ action: "list" })` 的实际结果为准。

**稳定的是对应关系，不是可用性。** 每个 kind 与 Trellis 的一个角色一一对应，因此 `cw-*` 拿到同一份角色上下文，并额外经过本项目的开关与并发上限：

| kind | agent | Trellis 角色 |
|---|---|---|
| 执行者 | `cw-executor` | implement |
| 审计者 | `cw-auditor` | check |
| 调研者 | `cw-researcher` | research |

这是本包随附的三个默认 kind：默认都开、默认上限 {{kindLimit}}，实际值由 `/Coworkflow:settings` 的面板决定。**一个 kind 就是一份 markdown**：`<项目>/.pi/Coworkflow/agents/<kind>.md`，frontmatter 声明它是什么（label / agent / role / description / model / thinking / maxConcurrent / enabled），正文就是它的系统提示词（职能）。所以你可以改这三个的职能与名字，也可以新增自己的 kind；改完下一次派单就生效，不用重启。用 `pi-coworkflow kind scaffold|export|set --from|check` 操作它，或在面板/`/Coworkflow:kind` 里改。

`trellis-implement` / `trellis-check` / `trellis-research` 不是本项目的推荐派单目标：`cw-*` 拿到的是同一份角色上下文，但会经过本项目的开关与数量限制，而 `trellis-*` 绕开了这两道闸。这个说法的前提是**该 kind 在本会话可用**；不可用时的退路见下一节，不是退回 `trellis-*`。

面板（`/Coworkflow:settings` 的「子 agent 类型」）里关掉的 kind，派单会被拒绝并列出当前可用的 kind；超过某 kind 的上限也会被拒绝并给出当前占用。**这条上限对直接派单和 `coworkflow.fanout` 同样有效**：fanout 里某个 kind 的任务数加上正在运行的数量超过上限时，**整批**被拒（workflow 要么全跑要么不跑），并在拒绝理由里给出批大小、上限与当前占用。

### kind 不可用时怎么办

派单被拒、或 `/Coworkflow:status` 里找不到你要的 kind 时，**不要换个名字重试**，也不要当成没事发生，按这三条处理：

1. **先读原因。** 常见四类，都能从 `/Coworkflow:status` 或拒绝理由里读出来：面板把它关了（`已关闭（不注册；派单会被拒绝）`）、注册失败（`x agent-kinds: <kind> 无法使用：<原因>`）、运行时契约不可用（`x agent-kinds: 注册契约…`）、上游拒绝（派单返回 `Unknown agent 'cw-…'` —— 它是真的不在本会话的 agent 列表里，不是名字打错了）。
2. **按顺序退让。** 先改派给 `/Coworkflow:status` 里**已列出**的 kind（同一份角色上下文、同样的开关与上限）；实在无可用 kind，或没有对应的角色，就把这个工作单元**收回主会话自己做完**。两条禁止：不得静默换成 `trellis-implement` / `trellis-check` / `trellis-research`（它们绕开项目开关与上限，这正是 kind 存在的理由），也不得不声不响地自己顶替而把这次降级藏起来。
3. **报告里写明**哪个 kind 不可用、原因是什么、最后走了哪条路（改派给谁 / 收回主会话）。这是一次降级，要当事实写出来，不要说成正常派单。

### 连 `subagent` 工具都没有

这是 kind 不可用的极端情况，同样是事实而不是违约。

**先确认 `subagent` 工具存在再用它。** 派单靠的是 pi-subagents 提供的 `subagent` 工具；它没加载时（新项目还没 `/Coworkflow:init`、项目未受信任、刚装完还没重开 Pi），本会话里根本没有这个工具。这种情况下：

- **不要** `tool_search` 去找它（搜不到，只是浪费一轮）；
- **不要**说"违反了分工约定"——那条约定在这个会话里无法执行，不是你违反了它；
- 按单体直接做，在交付说明里写一句「本会话没有 subagent 工具，未派单」，并说明修法（`/Coworkflow:init` 后重开 Pi）；
- `/Coworkflow:status` 会明确报这一行：`! subagents: 本会话没有 subagent 工具`。

### 派单执行约定

- 授权：主会话可以主动派发子 agent，不必逐次询问。
- **必须后台，这一条由代码强制。** 不传 `async` 也会被写成 `true`——上游的 `asyncByDefault` 可能是 `false`，靠默认值靠不住；传了 `async: false`，`agent-kinds` 的 gate 会在放行之前把它改回后台（`/Coworkflow:status` 会报「已把 N 次前台派单改为后台」）。理由不只是"会占住主会话"：前台子会话跑在主进程内、拿不到 ambient 扩展，拿不到子 agent 该有的上下文。确实需要结果就用 `bg_wait` 显式等，而不是靠前台阻塞。后台派单后主会话继续做自己的事，用完成通知和 `subagent({ action: "status" })` 监控，子 agent 的提问走 `contact_supervisor` 转达。实测：后台子会话由 harness 加载项目 `AGENTS.md` 与 Magic Context（ambient 扩展），但本包的 `subagent-context` 会在注入子 agent 约定之前把**本受管区**（`<!-- pi-Coworkflow:start/end -->` 之间，含上面的核心分工）从继承来的 `<project_instructions>` 里剥掉，项目自己写在区外的内容照旧保留。所以派单提示词只需给任务，不要把本文件受管区的约定重抄一遍。
- 多阶段工作用命名的 workflow 表达（例如本包注册的 implement → review），而不是在本会话里把几个阶段串起来自己做：workflow 的子步骤在原生侧执行、有稳定的 child key 与验收结论，主会话只接收产物与结论。
- 单步工作可以直接派一个有边界的子 agent（`context: "fresh"`），不必套 workflow；子 agent 的数量与并行度按上游容量与项目并发上限来，不要用不限量的并行去换速度。
- **子 agent 的预算要写进任务里。** 上游默认 30 分钟，子 agent 看不到这个数字，所以任务描述里要写明「上限约 N 分钟、剩余 M 分钟会要求停下交接」，并在派单参数里带 `timeoutMs` + `checkpointBeforeDeadlineMs`（`coworkflow.fanout` / `implement-review` 已经带好）。没有交接的超时等于这次执行作废。
- **要求「一次探针」而不是「逐条验证」。** 让子 agent 写一个脚本把所有结论一次跑完并打印一张表；逐条各跑一次命令时，每个工具调用都是一次完整往返，几十条就能吃掉整个预算——实测同一类复核任务，逐条验证用掉 23 分钟 / 160 次调用，一次探针只用 5 分钟 / 60 次。
- **派单边界**：能独立验证的边界工作才派（有明确的输入、产物、验收方式）；探索性、需要全局判断、或跨多个模块协调的工作留在主会话。子 agent 不负责决定"做什么"，只负责"把它做好并报告"。
- **审计边界**：子 agent 回结果不等于结果可用。主会话要对照 prd 的验收条件检查产物、核对它引用的文件与结论、跑该模块的测试；发现偏差就重派或自己修，不能直接把子 agent 的结论当成事实汇报给用户。
- 子会话**不继承**主会话上下文：派单时显式写 `context: "fresh"`（三个 Trellis 角色 agent 也已声明 `defaultContext: fresh`；若你全局配了 `defaultSubagentContext: "fork"`，它会被覆盖，必须显式 `fresh`）。它拿到的 Trellis 上下文由 `pi-Coworkflow` 的 `subagent-context` 模块按**角色**注入：`implement` 拿到 `implement.jsonl` / `check` 拿到 `check.jsonl` / `research` 拿到 spec 目录树，加上 prd.md、design.md、implement.md；字节预算沿用 `.trellis/config.yaml` 的 `context_injection`。 **注入按角色，不按 agent 名**：`cw-executor` → implement、`cw-auditor` → check、`cw-researcher` → research 来自 kind 表；任何其它 agent 只要标记成这三个角色之一（`<!-- trellis-agent: <role> -->`）也拿到对应那一份；`role: none` 的 kind 与未标记的 agent 拿到的是子 agent 约定（不含角色上下文），不是什么都不给。
- 因此派单提示词**首行必须是 `Active task: <任务目录>`**（Trellis 既有的派单协议）——注入靠它定位任务。这里的 `<任务目录>` 是占位符：**占位符本身不算引用**（注入会忽略它并回退到本会话的任务指针），但一个形状像任务路径、实际不存在的引用（`.trellis/tasks/typo`）会被当成无效引用报出来，不会悄悄换成父会话的任务。角色按两级识别：① **会话名里的 agent 名**（`subagent-<agent>-<runId>-<i>` 或 `<agent>: <task>` 都含 agent 名）按 kind 表解析成角色，改名后的 kind 也一样；② agent 定义或派单提示词里的 `<!-- trellis-agent: <role> -->` 标记——但 kind 自己写了 `role:` 就以它为准。所以想让任意 agent（例如 `worker`）拿到 implement 那份上下文，就在它的定义里加一行 `<!-- trellis-agent: implement -->`。
- 并行派单不要猜 API：`subagent({ workflow: "parallel", args: { tasks: [...] } })` 的每个 task **只接受 `agent` 和 `task`**（带 `output` 会被拒）；多步/带产出的 workflow 必须把 JS 脚本写成文件再用 `workflow: "<路径>"`，`workflow: true` 只在同一回复里写了 ```js 代码块时有效。先 `subagent({ action: "validate", workflow: "<路径>" })` 再 `async: true` 派发。
- 多段工作优先用 `coworkflow.fanout` 一次派出（内部并发），而不是逐个 `await`；写代码的 lane 传 `worktrees: true`。只派单件时才用单次 `subagent`。
- **批量工作用 `coworkflow_dispatch`，不要自己拆批。** 一次交全部工作单元即可：它按 kind 上限排队、完成一个自动放行下一个，依赖用 `needs` 表达——拆批与续派是你替机制做的、机制本来就会做的事。同理也不要用脚本内自建启动（`workflow: true` 的代码块，或 `workflow: "<脚本路径>"` 里自己 `runs.run`）：那种形状的子进程不经过本包准入，`agent-kinds` 的 gate 会拒绝并指回 `coworkflow_dispatch`。
- 并行写代码的 lane 用 `worktree: true`（`coworkflow.fanout` 里是 `worktrees: true`）。pi-subagents 托管 worktree、从干净 HEAD 分配（要求主检出干净），产出每个 lane 的 patch + handoff manifest，**不会**自动应用。
- 合并只由主会话做：`/Coworkflow:lanes` 看 lane 状态、patch 路径与合并计划 → `git apply --3way <patch>` 进主会话自己的 worktree → 审计并跑受影响范围的最小充分检查 → commit → `lane.recordMerge` 记录合并证据 → `worktree.cleanup` 清理（需授权）。子 agent 不合并、不 push。
