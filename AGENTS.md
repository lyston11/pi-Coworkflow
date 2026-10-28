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

- 一个任务一个分支 + 一个 linked worktree。`task.py start` 的 `after_start` 钩子（`.trellis/scripts/hooks/auto_worktree.py`）自动创建 `feat/<任务目录名>` 分支、在仓库旁 `../wt-<任务目录名>` 建 worktree，并把两者写入 task.json 的 `branch` / `worktree_path`。钩子成功时无输出，以 task.json 为准；写代码前必须先 `cd` 进该 worktree，不得在主检出里改业务代码。
- **同会话并发写同一批文件：声明 `files` 才会被拦住。** 同一会话的所有子 agent 共用一个 worktree，所以两个单元写同一个文件时 git **不会报冲突**——那是静默覆盖，比冲突更糟。因此 `coworkflow_dispatch` 支持每个单元声明 `files`（它要写的路径，只读单元写 `files: []`）：两个声明重叠的单元不会同时跑，后者排队（reason `overlap`），前一个完成自动放行；目录声明覆盖其下所有文件（`src/dispatch` 与 `src/dispatch/index.ts` 冲突，与 `src/dispatch-extra` 不冲突）。未声明的单元仍并行，但每次报告都会点出「这些单元同时在跑且都没声明 files」，把风险说在明面上而不是假装管住——能强制的地方强制，不知道的地方明说。
- **会话本身也有隔离 worktree（`session-worktree`，默认开）。** 每个 pi 会话解析出一个 worktree，所有子 agent 在其中执行，不再落在共享检出里：优先级是「你已 `cd` 进去的 linked worktree」→「活跃任务 task.json 的 worktree」→「会话 worktree `../wt-cw-<token>` / 分支 `cw/<token>`（从 `origin/HEAD` 指向的基线切出）」。分配失败（非 git 仓库、`worktree add` 失败、同名分支非本会话）时**派单被拒并写明原因**，不静默退回共享目录。新 worktree 会软链 `.trellis/{tasks,scripts,workspace,config.yaml,workflow.md}` 与 `.pi`，子 agent 因此能读 PRD、spec 与 kind 定义；已被跟踪的同名路径保留检出里的那份（软链覆盖受跟踪文件会让 worktree 无法 `git merge`），所以记录以**主检出那份为准**，子 agent 的相对路径可能读到基线快照。主会话可以直接写代码；委派时核对实际 cwd，并在产物所在 worktree 验收。
- **子 agent 的默认模型由父会话解析后下发；思考等级保留既有优先级。** `subagents.defaultModel` 在 `.pi/settings.json` 里，而上游是按**子进程的工作目录**解析它的——会话 worktree 是提交的快照，没提交过的项目设置根本不在里面。所以派单链路（`tool_call` 网关与 `coworkflow_dispatch`）会把父会话解析出的模型写进每次启动；声明了但注册表里没有、或 provider 没凭据的模型会**拒绝派单**并说明原因，不静默回退到父会话模型。
- 会话 worktree 的收尾是显式的：`/Coworkflow:merge` 先看 `git status` 与 `git log <基线>..HEAD`，有未提交改动或冲突就停下（不自动解冲突、不 push、不删 worktree）；合并成功后才由人确认清理。多个会话各拿各的分支，合并顺序由人定。
- 在自己的分支上只允许 commit；禁止 `reset --hard`、`rebase`、`push -f`、切换到非本任务的分支。需要基线分支的新代码时 `git fetch` 后把上游基线 merge 进自己分支（分支名按仓库而定，常见是 `origin/main`；以 `git symbolic-ref refs/remotes/origin/HEAD` 的结果为准）。
- 任何 agent 不得改写基线分支或他人分支的历史；历史整理只由人在专门时机做。
- `task.py` 生命周期命令（current / finish / archive 等）在启动任务的主检出里执行；代码改动和提交都在任务 worktree 里。任务确实不需要隔离时（如纯文档小改），完成后用 `git worktree remove ../wt-<任务目录名>` 清理。
- **按需并行，不强制拆分。** 主会话先判断委派是否值得；已决定委派且确实独立的单元可以并行。接口未定、修改高度耦合或交接成本过高时，留在主会话连续完成，无需为串行辩护。
- 选择并行后先明确接口、写入范围和依赖。同一工作区的写任务用 `files` 协调；独立 lane 用隔离 worktree，产出 patch 由主会话串行集成。不能把“支持隔离”当成“必须并行”的理由。
- 主会话的直接写入不受子任务队列的 `files` 检查保护：与子 agent 并行时不得修改其占用路径。共享工作区的提交与最终验收由主会话在相关写入停止后统一完成，子 agent 不操作共享 Git index。
- 小步提交并尽早 push（或本地 `git branch backup/<任务>` 钉住）；远端是抗本机历史重写的唯一兜底。
- 发现提交被抹掉时：先停掉所有并行 agent，从 `git reflog` 定位丢失提交，用 `git branch rescue/<名> <sha>` 钉住，核对后 cherry-pick 或取回文件。
- 分支合并回 main 由人（或单一串行集成通道）执行，集成时检查 migration 序号冲突。
- 任务收尾必含清理，不得把残留 worktree 留给用户：分支合并进 main、`task.py archive` 完成后，执行集成的 agent 必须立即 `git worktree remove ../wt-<任务目录名>` 并 `git branch -d feat/<任务目录名>`，并在交付说明中报告清理结果。删除前置条件：分支已合并进 main、worktree 无未提交代码改动（构建产物等未跟踪文件可忽略）；条件不满足时保留现场并向用户说明原因，禁止用 `--force` / `git branch -D` 掩盖未合并或未提交的工作。

### 核心分工：主会话默认执行，子 agent 按需协助

**主会话默认负责端到端交付：理解需求、规划、实现、验证、验收与集成。** 直接实施不限于小改动；不为满足角色分工而把任务拆出去，也不要求每项任务经过执行者、调研者、审计者流水线。

Trellis 的 Pi 步骤与本节采用同一策略：主会话读相关规范、直接实现并做必要检查。任务状态与审批规则保持不变；有任务时遵守其 worktree 边界。修改策略应更新本包模板并重新渲染，不手工维护两套指令。

#### 什么时候值得委派

只有收益高于重复上下文、交接和集成成本时才派单。委派不是定时动作，也不由工具调用次数、耗时或文件数量触发。

| 默认留在主会话 | 可按需交给子 agent |
|---|---|
| 连续实现、局部修复、上下文高度耦合的改动 | 输入明确、结果可独立检查的重复性或耗时工作 |
| 产品判断、最终方案选择、跨模块协调 | 针对具体难点给出独立规划建议或备选方案 |
| 常规自查与受影响范围的必要验证 | 风险较高、且有稳定产物可看的独立审查 |
| 问题仍在变化、拆分成本大于收益 | 互不依赖的资料调研或接口调查 |

- 子 agent 可以提出方案，**最终决定仍由主会话作出**。没有合适的子任务就直接完成，不必解释为什么没有派单。
- 模型、职能、提示词和数量上限沿用项目配置与当前可用 kind；不硬编码模型名称，不强制某种模型担任某种角色。主会话可按任务选择配置中的模型或显式指定可用模型。
- 简单且可检查的工作可以使用较低成本模型；复杂规划、模糊需求或难定位故障不能仅因耗时长就交给它。较低单价不代表较低总成本。
- 派单时给清楚目标、必要上下文、写入范围、产物、验收方式与预算。主会话保持责任，不把检查过的内容无理由重做，也不把子 agent 的自述当作验收。
- 有独立工作就继续做；没有就交还事件循环，等待原生完成通知。不要为了“主会话不能闲着”重复调查、轮询或用 sleep 等待。

`subagent`、批量队列和命名 workflow 都是可选工具，不是任务必须经过的阶段。启用委派后，以下后台、准入、上下文及隔离规则仍然有效。

### 可派角色以 `/Coworkflow:status` 为准

本项目装了 `agent-kinds` 模块后，可派的子 agent 类型（kind）由**本会话的注册状态**决定，而它会变：项目可能关掉某类、改它的上限，注册也可能失败。所以本文件**不写死清单**——这一会话能派哪些 agent，以 `/Coworkflow:status` 的 `agent-kinds` 行为准（每个已注册 kind 一行：`= agent-kinds: cw-executor（kind executor）已注册 · 模型 …`），或以 `subagent({ action: "list" })` 的实际结果为准。

**稳定的是对应关系，不是可用性。** kind 按**用途**划分，Trellis 角色只有三个，所以多个 kind 可以共用一个角色：角色决定子 agent 拿到哪份上下文，kind 决定它是做什么的、该用哪个模型。

| kind | agent | 用途 | Trellis 角色 |
|---|---|---|---|
| 执行者 | `cw-executor` | 主实现：做完一件已定义的工作 | implement |
| 规划者 | `cw-planner` | 难点上的备选方案与取舍，只建议不实施 | research |
| 审计者 | `cw-auditor` | 只读复核一处改动，给出可复现的阻断项 | check |
| 调研者 | `cw-researcher` | 查清一个问题，给出有出处、可复现的答案 | research |
| 分工执行者 | `cw-worker` | 边界清楚、结果可独立检查的重复性或耗时工作 | implement |

这是本包随附的五个默认 kind：默认都开、默认上限 5，实际值由 `/Coworkflow:settings` 的面板决定。**一个 kind 就是一份 markdown**：`<项目>/.pi/Coworkflow/agents/<kind>.md`，frontmatter 声明它是什么（label / agent / role / description / model / thinking / maxConcurrent / enabled），正文就是它的系统提示词（职能）。所以你可以改这五个的职能与名字，也可以新增自己的 kind；改完下一次派单就生效，不用重启。用 `pi-coworkflow kind scaffold|export|set --from|check` 操作它，或在面板/`/Coworkflow:kind` 里改。

**模型按用途分别配**，写在 `.pi/Coworkflow.json` 的 `agentKinds.<kind>.model`，不在代码或提示词里：便宜且可检查的活可以配低成本模型，规划与审查这类需要判断的活配更强的模型。耗时长短不是选模型的依据，难度和可验证性才是。

`trellis-implement` / `trellis-check` / `trellis-research` 不是本项目的推荐派单目标：`cw-*` 拿到的是同一份角色上下文，但会经过本项目的开关与数量限制，而 `trellis-*` 绕开了这两道闸。这个说法的前提是**该 kind 在本会话可用**；不可用时的退路见下一节，不是退回 `trellis-*`。

面板（`/Coworkflow:settings` 的「子 agent 类型」）里关掉的 kind，派单会被拒绝并列出当前可用的 kind；超过某 kind 的上限也会被拒绝并给出当前占用。**这条上限对直接派单和 `coworkflow.fanout` 同样有效**：fanout 里某个 kind 的任务数加上正在运行的数量超过上限时，**整批**被拒（workflow 要么全跑要么不跑），并在拒绝理由里给出批大小、上限与当前占用。

### kind 不可用时怎么办

派单被拒、或 `/Coworkflow:status` 里找不到你要的 kind 时，**不要换个名字重试**，也不要当成没事发生，按这三条处理：

1. **先读原因。** 常见四类，都能从 `/Coworkflow:status` 或拒绝理由里读出来：面板把它关了（`已关闭（不注册；派单会被拒绝）`）、注册失败（`x agent-kinds: <kind> 无法使用：<原因>`）、运行时契约不可用（`x agent-kinds: 注册契约…`）、上游拒绝（派单返回 `Unknown agent 'cw-…'` —— 它是真的不在本会话的 agent 列表里，不是名字打错了）。
2. **不要绕过开关与上限。** 先报告失败原因；主会话可以继续直接完成，也可以在仍值得委派时选用已列出的合适 kind。不得静默换成 `trellis-*` 绕过准入。
3. **报告事实。** 已尝试的派单失败需要说明；主会话直接执行本来就是正常路径，不是需要道歉或补派的降级。

### 连 `subagent` 工具都没有

这是 kind 不可用的极端情况，同样是事实而不是违约。

**先确认 `subagent` 工具存在再用它。** 派单靠的是 pi-subagents 提供的 `subagent` 工具；它没加载时（新项目还没 `/Coworkflow:init`、项目未受信任、刚装完还没重开 Pi），本会话里根本没有这个工具。这种情况下：

- **不要** `tool_search` 去找它（搜不到，只是浪费一轮）；
- **不要**说"违反了分工约定"——那条约定在这个会话里无法执行，不是你违反了它；
- 主会话继续直接完成任务；只有确实需要委派时才报告工具缺失与修复方式，不为普通直接执行增加安装前提；
- `/Coworkflow:status` 会明确报这一行：`! subagents: 本会话没有 subagent 工具`。

### 派单执行约定

- 授权：主会话可以主动派发子 agent，不必逐次询问。
- **必须后台，这一条由代码强制。** 不传 `async` 也会被写成 `true`——上游的 `asyncByDefault` 可能是 `false`，靠默认值靠不住；传了 `async: false`，`agent-kinds` 的 gate 会在放行之前把它改回后台（`/Coworkflow:status` 会报「已把 N 次前台派单改为后台」）。理由不只是"会占住主会话"：前台子会话跑在主进程内、拿不到 ambient 扩展，拿不到子 agent 该有的上下文。后台任务由原生完成通知唤醒；没有独立工作时交还控制，不 sleep、不循环查状态，也不使用 `bg_wait` 等这类原生通知。需要诊断时单次调用 `subagent({ action: "status" })`，子 agent 的提问走 `contact_supervisor` 转达。实测：后台子会话由 harness 加载项目 `AGENTS.md` 与 Magic Context（ambient 扩展），但本包的 `subagent-context` 会在注入子 agent 约定之前把**本受管区**（`<!-- pi-Coworkflow:start/end -->` 之间，含上面的核心分工）从继承来的 `<project_instructions>` 里剥掉，项目自己写在区外的内容照旧保留。所以派单提示词只需给任务，不要把本文件受管区的约定重抄一遍。
- 多阶段工作默认可由主会话连续完成。只有确实需要委派整段流程时，才选用命名 workflow（如 implement → review），而不是为凑齐阶段增加子 agent。
- 单步工作可以直接派一个有边界的子 agent（`context: "fresh"`），不必套 workflow；子 agent 的数量与并行度按上游容量与项目并发上限来，不要用不限量的并行去换速度。
- **子 agent 的预算要写进任务里。** 上游默认 30 分钟，子 agent 看不到这个数字，所以任务描述里要写明「上限约 N 分钟、剩余 M 分钟会要求停下交接」，并在派单参数里带 `timeoutMs` + `checkpointBeforeDeadlineMs`（`coworkflow.fanout` / `implement-review` 已经带好）。没有交接的超时等于这次执行作废。
- **要求「一次探针」而不是「逐条验证」。** 让子 agent 写一个脚本把所有结论一次跑完并打印一张表；逐条各跑一次命令时，每个工具调用都是一次完整往返，几十条就能吃掉整个预算——实测同一类复核任务，逐条验证用掉 23 分钟 / 160 次调用，一次探针只用 5 分钟 / 60 次。
- **派单边界**：实现任务必须可独立验证；咨询任务必须有具体问题、依据和交付要求。子 agent 可以提供规划或审查建议，不自行替主会话作最终决定或扩大实施范围。
- **验收边界**：主会话核对实际产物、验收条件和验证证据；仅补足缺失检查，或在集成改变被测代码时重跑受影响检查。发现偏差就修正，不能直接把子 agent 的结论当事实，也不为证明分工有效而重复全量验证。
- 子会话**不继承**主会话上下文：派单时显式写 `context: "fresh"`（kind 的 agent 定义已声明 `defaultContext: fresh`；若你全局配了 `defaultSubagentContext: "fork"`，它会被覆盖，必须显式 `fresh`）。它拿到的 Trellis 上下文由 `pi-Coworkflow` 的 `subagent-context` 模块按**角色**注入：`implement` 拿到 `implement.jsonl` / `check` 拿到 `check.jsonl` / `research` 拿到 spec 目录树，加上 prd.md、design.md、implement.md；字节预算沿用 `.trellis/config.yaml` 的 `context_injection`。 **注入按角色，不按 agent 名**：`cw-executor` 与 `cw-worker` → implement、`cw-auditor` → check、`cw-planner` 与 `cw-researcher` → research，都来自各自定义文件里的 `role:`；任何其它 agent 只要标记成这三个角色之一（`<!-- trellis-agent: <role> -->`）也拿到对应那一份；`role: none` 的 kind 与未标记的 agent 拿到的是子 agent 约定（不含角色上下文），不是什么都不给。
- 因此派单提示词**首行必须是 `Active task: <任务目录>`**（Trellis 既有的派单协议）——注入靠它定位任务。这里的 `<任务目录>` 是占位符：**占位符本身不算引用**（注入会忽略它并回退到本会话的任务指针），但一个形状像任务路径、实际不存在的引用（`.trellis/tasks/typo`）会被当成无效引用报出来，不会悄悄换成父会话的任务。角色按两级识别：① **会话名里的 agent 名**（`subagent-<agent>-<runId>-<i>` 或 `<agent>: <task>` 都含 agent 名）按 kind 表解析成角色，改名后的 kind 也一样；② agent 定义或派单提示词里的 `<!-- trellis-agent: <role> -->` 标记——但 kind 自己写了 `role:` 就以它为准。所以想让任意 agent（例如 `worker`）拿到 implement 那份上下文，就在它的定义里加一行 `<!-- trellis-agent: implement -->`。
- 并行派单不要猜 API：`subagent({ workflow: "parallel", args: { tasks: [...] } })` 的每个 task **只接受 `agent` 和 `task`**（带 `output` 会被拒）；多步/带产出的 workflow 必须把 JS 脚本写成文件再用 `workflow: "<路径>"`，`workflow: true` 只在同一回复里写了 ```js 代码块时有效。先 `subagent({ action: "validate", workflow: "<路径>" })` 再 `async: true` 派发。
- 已决定委派的单件工作用单次 `subagent` 即可；批量交给队列。只有需要 workflow 的独立产物/验收契约时才用 `coworkflow.fanout`，写代码的隔离 lane 传 `worktrees: true`。
- **已决定委派的批量工作用 `coworkflow_dispatch`，不要自己拆批。** 一次交全部委派单元即可：它按 kind 上限排队、完成一个自动放行下一个，依赖用 `needs` 表达——拆批与续派是你替机制做的、机制本来就会做的事。同理也不要用脚本内自建启动（`workflow: true` 的代码块，或 `workflow: "<脚本路径>"` 里自己 `runs.run`）：那种形状的子进程不经过本包准入，`agent-kinds` 的 gate 会拒绝并指回 `coworkflow_dispatch`。
- 并行写代码的 lane 用 `worktree: true`（`coworkflow.fanout` 里是 `worktrees: true`）。pi-subagents 托管 worktree、从干净 HEAD 分配（要求主检出干净），产出每个 lane 的 patch + handoff manifest，**不会**自动应用。
- 合并只由主会话做：`/Coworkflow:lanes` 看 lane 状态、patch 路径与合并计划 → `git apply --3way <patch>` 进主会话自己的 worktree → 审计并跑受影响范围的最小充分检查 → commit → `lane.recordMerge` 记录合并证据 → `worktree.cleanup` 清理（需授权）。子 agent 不合并、不 push。
<!-- pi-Coworkflow:end -->
