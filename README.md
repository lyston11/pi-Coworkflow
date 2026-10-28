# pi-Coworkflow

以主会话直接完成任务为默认，按需借用可配置的子 agent 提供规划建议、独立审查或分担明确工作；相关能力由可单独开关的 Pi 模块提供。

装上之后，一个项目可以：

- 用 **kind**（执行者 / 审计者 / 调研者）派单，而不是每次现场挑一个 agent 名字；
- 在面板里决定哪几种 kind 参与、每种同时能跑几个，**当场生效**；
- 一次并发派出多个独立子任务，而不是写一串 `await`；
- 随时停掉或追加指令给正在跑的 run，并且能看见它刚才在做什么；
- 每个任务一个分支 + 一个 worktree，收尾时有机器可查的出口检查。

它**不**做这些：不重造运行器（执行、进程、超时、产物都归 [pi-subagents](https://github.com/lyston11/pi-subagents)），
不自动合并、不自动重试、不自动清理，也不往对话里插任何提醒。

## 安装

```bash
pi install git:github.com/lyston11/pi-Coworkflow@v0.1.0   # 推荐：按 tag 固定
pi install https://github.com/lyston11/pi-Coworkflow      # 跟随默认分支
pi install /path/to/pi-Coworkflow                         # 本地开发
```

装之前**不需要任何前置工具**：Trellis 那套范式文件随本包一起发布，由 `/Coworkflow:init` 直接渲染（见下）。

扩展是**用户级**装的，装完任何项目都有这些命令；但**每个项目要自己决定采用**：

```bash
/Coworkflow:init      # 本项目采用（首次会装上全部模块并渲染 Trellis 资产），可加 --dry-run 先看
/Coworkflow:start     # 本会话加载（否则会话就是原生 Pi）
```

没采用的项目里，这个扩展什么都不做：不安装、不注入、不记账。

### 模板与项目记录的分工

**范式文件是模板，随本包发布。** 本包自带 `.trellis/`（`workflow.md`、`config.yaml`、`agents/`、`scripts/`）
与 `.pi/`（`agents/`、`extensions/trellis/`、`prompts/`）的模板，`/Coworkflow:init` 按它们写进项目。
安装流程就是「装这一个包 → init」一步。

| 内容 | 谁提供 |
|---|---|
| `.trellis/`、`.pi/` 的范式文件（workflow、任务脚本、agent 定义、Pi 扩展） | **本包随附的模板**，`/Coworkflow:init` 渲染 |
| `tasks/`、`spec/`、`workspace/` 等项目记录 | 项目自己；模板不写、不覆盖 |

要刷新范式就再跑一次 `/Coworkflow:init`（幂等，用户数据不动）。

## 三层状态

| 状态 | 含义 | 怎么进出 |
|---|---|---|
| 未采用 | 没有 `.pi/Coworkflow.json`：不安装、不注入、不记账 | `/Coworkflow:init` |
| 已采用、未加载 | 新会话默认如此：原生 Pi，只是命令在 | `/Coworkflow:start`，或打开「新会话自动加载」 |
| 已加载 | `/Comodels`、`/Coworkflow:lanes`、子 agent 的 Trellis 注入、kind 注册与门禁都在 | `/Coworkflow:start off` |

会话开关按 session id 记在 `.trellis/.runtime/workflow-sessions.json`（不是内存），所以 `/reload`
之后仍然生效。子 agent 的会话会跟随父会话的开关。

## 子 agent 类型（kind）

这是这套工作流的中心。一个 kind = 一份 agent 定义 + 项目策略（是否启用、同时上限、可选的模型与思考等级）。

**kind 按用途划分，不按角色划分。** Trellis 只有三个角色（implement / check / research），
而委派的理由多于三个，所以多个 kind 可以共用一个角色：**角色决定子 agent 拿到哪份上下文
（prd / design / implement / 对应 jsonl 或 spec 树），kind 决定它是做什么的、该用哪个模型。**

| kind | agent | 用途 | 角色 | 默认 |
|---|---|---|---|---|
| 执行者 | `cw-executor` | 主实现：做完一件已定义的工作 | implement | 开，上限 5 |
| 规划者 | `cw-planner` | 难点上的备选方案与取舍，只建议不实施 | research | 开，上限 5 |
| 审计者 | `cw-auditor` | 只读复核一处改动，给出可复现的阻断项 | check | 开，上限 5 |
| 调研者 | `cw-researcher` | 查清一个问题，给出有出处、可复现的答案 | research | 开，上限 5 |
| 分工执行者 | `cw-worker` | 边界清楚、结果可独立检查的重复性或耗时工作 | implement | 开，上限 5 |

`cw-*` 拿到的是同一份角色上下文注入，但额外经过本项目的开关与数量限制。
`trellis-implement` / `trellis-check` / `trellis-research` 在采用本模块后**不再是推荐目标**——
它们绕开这两道闸。

**默认值不是本包定的上限，是给项目改的起点**：五种 kind 默认都开、都从 **5** 起，具体多少由
`/Coworkflow:settings` 决定。上限的意义是「别一次铺开太多」，不是「只准有一个审计者」——按 kind 定死
不同的小数字等于替主会话做了拆分决定，而那是它的判断。要收紧就在面板里改，或直接把某个 kind 关掉。

### 派单

注册之后，它们真的在主会话的 agent 列表里，派单就是普通的一次调用：

```js
subagent({ agent: "cw-executor", async: true, context: "fresh",
           task: "Active task: .trellis/tasks/<任务>\n实现 <这一件>" })
```

**同一类可以重复派发**：上限是按 kind 单独算的，不是「每类只能一个」。

### 面板里配置

```
  子 agent 类型
  执行者 cw-executor        [x] 开 · 上限 5   已注册到 pi-subagents
  规划者 cw-planner         [x] 开 · 上限 5   已注册到 pi-subagents
  审计者 cw-auditor         [x] 开 · 上限 5   已注册到 pi-subagents
  调研者 cw-researcher      [x] 开 · 上限 5   已注册到 pi-subagents
  分工执行者 cw-worker      [x] 开 · 上限 5   已注册到 pi-subagents
```

`Space` 开关、`←→` 调上限、`Enter` 输数字。**当场生效，无需重启**；改两次等于没改，
不会留下重复注册或多出来的钩子。

### 每个 kind 自己的模型

**每个用途配自己的模型，这正是 kind 存在的理由**：明确且可检查的活可以用低成本模型，规划建议与独立审查需要判断力、配更强的模型。耗时长短不是选模型的依据，难度和可验证性才是。在 `/Comodels` 里每个 kind 各有一页：

```
 主会话   子 agent（默认）   [执行者 cw-executor]   规划者 cw-planner   审计者 cw-auditor
 当前：p/strong · high · 固定 p/strong
```

字段写在 `.pi/Coworkflow.json` 的 `agentKinds.<kind>.model` / `.thinking`，**写进 agent 定义本身**，
所以每一次该 kind 的派单都按它跑（包括手写的 `subagent({ agent: "cw-executor" })`），
写盘后立即重新注册，当前会话无需重启。优先级：

**kind 自己的 model → `subagents.defaultModel` → Pi 默认**

选中「继承」那一行就是删掉该键，回到上一级；思考等级同理，与模型独立（可以固定模型、继承等级）。

- 选中的值在写盘前校验：形状不合法（空白前后缀、控制字符、超长）**当场拒绝并说明**；
  形状合法但**当前模型注册表里查不到**的 id 也拒绝——面板就拿着这张注册表，写进去只会让该 kind 在派单时失败。
  两种情况都**不落盘**（不留一个下次读就消失、或下次派单才炸的设置）。
- 已存的不合法值在读取时**丢弃而不是转发**：上游会在注册时拒绝一个不能用的 model，
  那会让整个 kind 连派单都不可用——丢掉则只是回到继承。
- 关掉的 kind 仍然有页面，并写明「已关闭」：模型还在，打开那一刻就生效。
- `agent-kinds` 模块关掉时页面保留并写明「本会话未启用」：那时没有注册任何 kind，写入只改配置。

### 三种约束，强度不同

| 想要的 | 机制 | 强度 |
|---|---|---|
| 关掉的 kind 派不了 | `tool_call` 拒绝，理由列出**当下真的可用**的 kind | 强制 |
| 某 kind 超上限派不了 | `tool_call` 拒绝，理由给出上限与当前占用 | 强制 |
| 「只能派给开着的 kind」 | 提示词与面板告知 | 引导，非强制 |

第三条不是强制，说清楚比含糊好：`cw-*` 之外的名字（内置 agent、别的扩展的、`trellis-*`）
不受本模块管理，本模块**不会替主会话改派任务**。

### 占用数从哪来

从 pi-subagents 公开 fleet 投影的 `entries[].agent` 数，不建本地镜像。读不到就**拒绝派单**，
不当 0：

- 没有 `fleetStatus` 能力；
- 投影无法解析；
- 有界窗口溢出（`omitted` 非零）；
- 回复落在会话换代之后。

一个数不准的上限比没有上限更糟——它让项目以为被保护着。

## 自定义子 agent 类型（kind 端口）

kind 集合是**项目自己的决定**。在 `.pi/Coworkflow/agents/<kind>.md` 里写一个文件即可——frontmatter 声明这个 kind 是什么，正文就是它的系统提示词（职能）：

```markdown
---
label: 建造者                     # 面板里显示的名字
agent: cw-builder                 # agent 名，必须形如 cw-<slug>；默认 cw-<kind>
role: implement                   # Trellis 角色：implement | check | research | none
context: role                     # role（默认）；task（research 增加任务上下文）
description: 按派单实现一处改动
model: provider/id                # 可选默认值
thinking: high                    # 可选默认值
maxConcurrent: 5                  # 可选默认值
enabled: true                     # 可选默认值
---

你是这个项目自己的执行者：按派单做完一件已定义的工作，然后报告事实。
```

文件名的 `<kind>` 就是 kind 名。能做的事：

| 想要 | 怎么做 |
|---|---|
| 改本包随附 kind 的职能 | 用同名文件覆盖它：正文替换提示词，frontmatter 覆盖 label / role / context / description |
| 新增一个 kind | 写一个用新名字的文件 |
| 改 agent 名 | `agent:`（必须 `cw-` 开头；撞到项目已有的 agent 时只有该 kind 失败并说明原因） |
| 改默认配置 | `model` / `thinking` / `maxConcurrent` / `enabled` |
| 删掉 | `/Coworkflow:kind remove <kind>`；随附的 kind 只能关掉（回到随附定义） |

**上下文按需要加载**：`planner` 的 `context: task` 会优先加载 `prd.md`、`design.md`、`implement.md`，再复用 `implement.jsonl` 的相关规范，遵守现有字节预算；`researcher` 默认只拿 spec 目录树。自定义或改名的 kind 同样可设置 `context`，不按名称写分支；`role: none` 始终不注入角色上下文。

派单首行写真实的 `Active task: <任务目录>`；独立的小工作写 `Active task: (none)`，不会继承父任务，也不必为派单新建任务。任务相关的代码修改仍沿用已有任务与 worktree 安全规则。

**两层，谁说了算不含糊**：定义文件说的是这个 kind **是什么**；`.pi/Coworkflow.json` 的 `agentKinds.<kind>` 说的是项目**选了什么**（面板写的），**永远优先**。所以定义里的 `model:` 是默认值，一旦在 `/Comodels` 里选过模型，配置赢，`/Coworkflow:kind show` 会标出哪些是「项目选择」、哪些是「默认」。

**热更新**：改完文件就生效，**不用重启、不用 `/reload`**。

| 改了什么 | 什么时候生效 |
|---|---|
| 提示词 / agent 名 / role / context / label / description / model / thinking | 下一次派单前：gate 发现磁盘上的定义与已注册的不一致，先重新注册再决定，所以这一次派单用的就是新内容 |
| `enabled` / `maxConcurrent` | 立即：每次派单都从磁盘重读策略 |
| 新增 / 删除定义文件 | 下一次派单前（删除会撤回对应的 agent） |

实现方式不是轮询也不是目录监听：gate 本来就要读一次定义目录来判定策略，顺手比对「应该注册的」与「已经注册的」指纹（提示词、agent 名、模型、思考、上限都在里面）。不一致才重新注册，一致则什么也不做。所以外部编辑器、别的程序、另一个进程里的 CLI 改文件，都会在**下一次派单**被吸收。

**出错只坏一个**：文件格式错、agent 名不合法或撞名、`model`/`thinking`/`maxConcurrent` 不可用、正文为空——**只有那个 kind 失败**，原因出现在 `/Coworkflow:status` 和设置面板里，其它 kind 照常工作。失败的 kind **不会被注册，派单会被拒绝**，不会出现「看起来可用、实际起不来」。

### 一个 kind 就是一个 markdown 文件

每种 kind 的提示词是它自己的一份文档——frontmatter 声明它是什么，正文就是它的系统提示词。这就是它的「subagents.md」：

```
.pi/Coworkflow/agents/<kind>.md
```

**推荐的 DIY 流程**（文件是主角，不是 shell 参数）：

```bash
# 1) 生成一个带注释骨架的文件
pi-coworkflow kind scaffold builder

# 2) 用你自己的编辑器改它（这才是写提示词的方式：标题、列表、强调、换行都保留）
$EDITOR .pi/Coworkflow/agents/builder.md

# 3) 交回去：先校验，通过后按你写的原样写入
pi-coworkflow kind set builder --from .pi/Coworkflow/agents/builder.md

# 4) 随时校验全部定义（只读，不写任何东西）
pi-coworkflow kind check
```

想改本包随附的三个 kind？把它们的提示词**导出成文件**再改，不用重打：

```bash
pi-coworkflow kind export auditor --out auditor.md   # 拿到它完整的提示词原文
$EDITOR auditor.md
pi-coworkflow kind set auditor --from auditor.md     # 覆盖本包的定义
pi-coworkflow kind remove auditor                    # 删掉覆盖，回到本包定义
```

### 终端 CLI（给别的 agent 用）、Pi 内命令、公开请求

**非交互会话（`pi -p`、脚本、CI）要派单，先记下会话开关。** 斜杠命令在 `-p` 里会被当成提示词，`/Coworkflow:start` 不会执行，于是第一次派单会因为「本会话未启用」被拒：

```bash
pi-coworkflow session on --session 01a16686-ac7e-730c-97b8-1d38c653f93a
# 也可以给会话文件路径，两种写法解析到同一个键
pi-coworkflow session on --session ~/.pi/agent/sessions/<项目>/2026-…_<id>.jsonl
pi-coworkflow session off --session <id>      # 显式关闭（区别于「从未选择」，后者回落到 autoEnable）
```

`on` / `off` 与交互会话里 `/Coworkflow:start` 写的是同一份记录（`.trellis/.runtime/workflow-sessions.json`）。它是**会话开关，不是采用**：项目还没有 `.pi/Coworkflow.json` 时命令会提示你先 `/Coworkflow:init`。

**`pi-coworkflow` 是终端入口**——不需要 Pi 会话、不需要扩展宿主、不需要任何进程在跑。任何能执行 shell 的 agent（Claude Code、Codex、你自己的脚本）都能用它 DIY 本项目的子 agent：

```bash
node --experimental-strip-types /path/to/pi-Coworkflow/scripts/cli.ts kind list
pi-coworkflow session on --session <id>              # 非交互会话要派单，先这一步
pi-coworkflow kind list --project /path/to/project
pi-coworkflow kind show builder
pi-coworkflow kind path builder
```

给 agent 用的两条约定：

- **退出码是结论**：`0` 成功；`1` 值被拒绝（**文件未改动**）；`2` 用法/找不到；`3` 内部错误。拒绝原因在 stderr。
- **`--json` 给机器读**：`list` / `show` / `set` / `check` 都支持，成功与失败都输出结构化结果，不用解析中文散文。

```bash
$ pi-coworkflow kind check --json; echo "exit=$?"
{"ok":false,"checked":["auditor"],"failures":[{"kind":"broken","reason":"role 只能是 implement / check / research 或 none：nope"}]}
exit=1
```

`--project <dir>` 指定作用于哪个项目；**在 task worktree 里执行会自动写到主检出**——worktree 只有已提交文件，写在里面没有任何 gate 会读到（CLI 用的是扩展同一套解析）。

`set <kind> key=value…` 仍然可用，适合改一两个字段；传 `prompt=` 时它会提醒你改用文件，因为把长提示词塞进 shell 字符串会丢掉换行与格式。

另外两个入口，同一个写入者：

```bash
# Pi 会话内
/Coworkflow:kind list | show <kind> | set <kind> k=v… | remove <kind>

# 公开请求（其它扩展/程序），信封与 pi-subagents 的 RPC 一致
# 频道 coworkflow:kind:v1:request，回复 coworkflow:kind:v1:reply:<requestId>
# 方法 list / show / define / remove；version 必须是 1
```

**三者都走同一个写入者**：先校验，再落盘。`set --from` 校验的是**将要落盘的那些字节**并原样写入，所以 CLI 不可能接受一个会话会拒绝的定义，被拒绝的文件也不会被写坏。也**没有「只活在内存里」的 kind**——那种 kind 在 `/reload` 后会消失，正好把这个端口的核心承诺反过来；同理不做目录监听：刷新点是 `/reload` 与命令本身。

## 一次并发派出多件事：`coworkflow.fanout`

独立的工作要一次派完。写脚本时最容易犯的错就是：

```js
const a = await runs.run("a", …);   // 串行：第二个要等第一个跑完
const b = await runs.run("b", …);
```

同一种能力，差别只在脚本怎么写，而串行版本**不报错、不慢到可疑、也没有任何信号**。
所以「一次跑 N 个独立 child」不是每次现场手写的脚本，而是本包注册的工作流资源：

```js
subagent({ workflow: "coworkflow.fanout", args: {
  tasks: [
    { kind: "executor", task: "<第一部分的活，按已定契约写>" },
    { kind: "executor", task: "<第二部分的活，按同一份契约写，不要等第一部分>" },
  ],
  focus: "契约就是这个任务里的 <契约文件>；两边都按它写",
  worktrees: true,
}})
```

契约定在哪、由谁写，是项目自己的事：一个接口说明文件、一段类型定义、一张表都行，只要**两份任务都能照着写而不必读对方的代码**。

`worktrees: true` 给每个 lane 自己的独立 worktree —— **「共用一个 worktree，不能同时写」是配置问题，不是依赖问题**。真正必须串行的只有一种：后一步要看到前一步**已实现的行为**才能定下自己的接口；那说明契约还没定。

### worktree 里有什么，以及为什么

worktree 是**已提交文件**的检出，而本包的 Trellis 状态（`.trellis/tasks`、`.trellis/scripts`、`config.yaml`、`workflow.md`、以及整个 `.pi/`）是**故意不入库**的。所以 `auto_worktree.py` 建好 worktree 后会把这几项**软链接**进去：

```
<worktree>/.trellis/{tasks,scripts,workspace,config.yaml,workflow.md} -> 主检出
<worktree>/.pi                                                      -> 主检出
```

软链而不是拷贝：这些是**共享记录**——子 agent 更新任务状态时必须更新主会话读到的那一份，拷贝会造出两份会分叉的历史。于是 worktree 里的子 agent 能读自己的 PRD、能跑 `task.py`、能拿到项目配置与 kind 定义。

**它仍然没有 `node_modules`**（链接一棵依赖树会让工具解析到别处的包），需要跑构建/测试时由项目自己决定。而上游托管的 lane worktree（`worktrees: true`）由 pi-subagents 创建，本包插不进去——那些 lane 里没有上述链接，所以 lane 的产物是 patch，集成与测试在主会话做。

### 子 agent 用哪个模型

优先级：`kind 的 model` → `.pi/settings.json` 的 `subagents.defaultModel` → 主会话的模型。

**声明了但解析不到时是静默回退**，所以 `/Coworkflow:status` 把三件事分开报：声明了什么（哪个文件）、实际会用哪个、有没有在模型注册表里核验到。

```
子 agent 模型：声明了 cline-pass/deepseek-v4.1-flash-1017（来自 .pi/settings.json），但宿主没有
提供模型注册表，无法确认它是否解析得到；解析不到时子 agent 会静默回退到主会话模型（…）
```

```
子 agent 模型：声明的 cline-pass/… 解析不到（在模型注册表里找不到这个 provider/model）——
子 agent 会静默回退到主会话模型（buddy2api/…），本项目等于没配；注册表里相近的有：clinepass/cline-pass/…
```

「宿主答不了」和「确认没有」是两种答案，本包不会把前者写成后者。

## 子 agent 的预算：为什么它们会撞上 30 分钟

上游对一次运行有 **30 分钟兜底**，而子 agent **看不到这个数字**。实测本项目的 14 个子运行：

| 现象 | 数据 |
|---|---|
| 主导工具 | `bash` 占 ~90%（一次复核 180 次调用里 166 次是 bash） |
| 每次调用 | 一次完整模型往返，几秒到几十秒 |
| 结果 | 160 次调用 ≈ 23 分钟，正好撞上限 |
| 超时点 | 多次发生在**正在写交接**时——工作快做完，结果作废 |

**不是空转**：这些运行的命令各不相同、结论在推进，是「很多个小步骤串行」把预算花光的。

**这个上限在面板里可改**：`/Coworkflow:settings` 的「子 agent 运行上限」，单位分钟，留空回到内置默认（25 分钟）。设置后写进 `.pi/Coworkflow.json` 的 `subagentRunBudgetMs`，**下一次派单生效**；「停下交接」的提前量按上限自动推算（上限的 1/6，最少 15 秒、最多 4 分钟），不需要第二个数字。

两处已改（`coworkflow.fanout` / `implement-review` 都带上了）：

- **写明预算**：任务描述里写「上限约 25 分钟、剩余 4 分钟会要求停下交接」，并用 `timeoutMs` + `checkpointBeforeDeadlineMs` 把上限与「停下交接」的提醒真正交给上游；
- **要求一次探针**：让子 agent 写一个脚本把全部结论一次跑完并打印一张表。同类复核任务，逐条验证 23 分钟 / 160 次调用，一次探针 5 分钟 / 60 次。

自己手写派单时，这两条同样适用（受管区里也写了）。

## 中断一个 run

主会话必须能随时打断自己派出去的 run，三个命令都走 pi-subagents 的公开 RPC：

```
/Coworkflow:stop <runId> [instructions]   # 接受≠终止，会再读一次状态并把两件事分开说
/Coworkflow:steer <runId> <instructions>  # 追加指令，不杀进程，指令只作为数据传
/Coworkflow:lanes stop <runId>            # 只停本任务记录过的 run，拒绝任意 id
```

纪律：

- 先按 `ping.methods` 检查方法是否被通告，**没有就什么都不发**并说明原因；
- 保留上游自己的错误文字与 code，不改写成别的原因；
- 回复读不出来就是 `protocol` 错误，不当成功；
- `stop` 的返回是**接受回执**（`{ accepted: true, state: "stopping" }`）：上游只表示这次停止操作被接受，
  终止要靠随后的 `status` 与进程终止证据确认；**任何情况下都不打印「已停止」**；
- 失败的 stop 不会被报成“超时所以 run 死了”，也不会自动重试。

## 决定要不要停之前，能看见什么

| 事实 | 能否看到 | 来源 |
|---|---|---|
| 某个 run 的状态、agent、model、开始时间 | **能**，可归属到 run | 公开 `status` 的 `asyncSnapshot.runs[]`（`id` 是真 run id） |
| 已运行多久 | **能**，渲染时用 `startedAt` 现算 | 同上；不装定时器、不轮询 |
| 这次派单的目标 | **能**，但只来自**本包自己的派单记录** | `tool_call` 时记下的 task 文本 |
| 各 run 的 token 用量 | **能，但可能不完整**，且必须标出 | 公开 fleet 窗口的 `entries[].tokens` |
| 某个 run 刚才在做什么 | **能，但有滞后** | 该 run 自己 session 日志的**尾部**（见下） |

### 「刚才在做什么」是尾部读，不是实时流

`pi.events` 是进程内的，子会话的工具调用不会流回父会话——这条限制没有变，也没有被绕过。
但公开 `cost` 回复给每个可读 child 一个 `sessionFile`，而本包**本来就在读这些文件**（拼子会话用量）。
读它的尾部就能回答「它最近在做什么」：

```
· cw-executor [running] · 已运行 3m · run 3eaa2c7d · 正在 bash npm test（读自子会话日志尾部）
```

- 有界：最多读最后 64 KiB，`O_NONBLOCK`、先 `stat`、拒绝非普通文件、不 glob、不列目录；
- 容忍半行：文件正在追加，末尾截断的 JSON 被丢弃、用前一条；
- 只在既有刷新边界读（会话开始 / `agent_settled` / 原生完成 / 打开面板），**无定时器**；
- 渲染和按键只查缓存，零 IO；
- 文案带来源后缀，因为**尾部读弱于实时、强于没有**：它回答「它刚做了什么」，不回答「它此刻正在做」。

### fleet 只能用来显示，不能用来归属

上游的 fleet DTO 明确不暴露 run/async/tool id，它的 `key` 是不透明显示键。本包**不做**「把 fleet 行
对应到 run id」这件事——那个对应关系不存在，编一个出来只会把 A 的用量记到 B 头上。
所以每个 run 的 agent/状态/耗时来自 `asyncSnapshot`，fleet 只在面板汇总里作为「窗口内求和」出现。

窗口不完整时不说成完整：有 `omitted`、某行没带用量、撞上字节上限，都会让求和变成**下界**，
显示成「不完整 —— <原因>；窗口内求和只是下界」，不把偏小的和当总数，也不把读不到的窗口显示成 0。

## 分工：主会话默认执行，子 agent 按需协助

主会话默认自己理解需求、规划、实现、验证和交付。直接执行不限于小改动，不必为串行解释，也不要求每次走“规划者 → 执行者 → 审计者”。

只有委派收益高于上下文、交接与集成成本时才使用子 agent：

- **独立建议**：围绕具体难点提出备选方案和依据，主会话作最终决定。
- **明确工作**：输入和产物清楚、易于检查的重复性或耗时任务；低成本模型是否合适取决于任务难度，而不只是耗时。
- **独立审查**：风险或第二视角确有价值时再派，不为每个改动固定增加一次审计。

模型、职能、提示词和并发上限沿用 `/Comodels` 与项目 kind 配置；没有固定模型名称、定时派单或自动路由器。没有合适子任务时，主会话直接完成就是正常路径。

委派后仍保留安全边界：

- 后台执行；有独立工作就继续，没有就交还控制等待原生完成通知，不循环查状态。状态与停止入口保留。
- 并行是可选手段，不是目标；先明确接口、写入范围和依赖。`files` 只协调队列内子任务，主会话不得同时改子 agent 占用的路径。
- 共享工作区的提交由主会话统一完成；需要独立产物时才用隔离 lane，并由主会话串行集成。
- 主会话检查实际产物及验证证据，只补缺失或集成后失效的检查；不把子 agent 自述当事实，也不机械重复全量测试。

单件可用 `subagent`，已决定委派的批量工作可用 `coworkflow_dispatch`，需要特定流程契约时才选命名 workflow。它们都是可选能力。调用次数和派单重叠是观察信息，不是逼迫模型委派或并行的指标。

## 命令

| 命令 | 作用 |
|---|---|
| `/Coworkflow:init` | 采用/刷新本项目；未采用前其他功能都不存在 |
| `/Coworkflow:start` | 在本会话加载；`off` 卸载，`status` 查看 |
| `/Coworkflow:settings` | 设置面板：模块开关、自动加载、worktree 前缀、并发上限、**子 agent 类型**、Trellis 对齐 |
| `/Coworkflow:status` | 初始化状态、模块开关、本会话加载状态、原生能力与派单重叠（不改文件） |
| `/Comodels` | 模型面板：主会话、子 agent 默认模型、每个 kind 各自的模型与思考等级，三列 = 模型 \| 思考等级 \| 用量 |
| `/Coworkflow:run [focus]` | 在验证过的当前任务 worktree 跑 `implement → review` |
| `/Coworkflow:lanes` | 当前任务的 lane 状态、patch 路径、合并计划、**任务出口检查** |
| `/Coworkflow:lanes stop <runId>` | 只停本任务记录过的 run |
| `/Coworkflow:stop <runId> [说明]` | 请求停止；接受≠终止 |
| `/Coworkflow:steer <runId> <说明>` | 追加指令，不杀进程 |

`/Coworkflow:init` 的参数：`--enable/--disable <id,…>`、`--auto-enable on|off`、`--prefix <p>`、
`--no-trust`、`--dry-run`。

## 面板

### `/Comodels`

一张表格，模型与思考等级是独立两列（思考列始终显示全部等级），用量列是一整块 7 天柱状图。

**页面不是写死的两个**：`主会话`、`子 agent（默认）`，然后是本包**发布**的每个 kind 一页
（`执行者 cw-executor`、`审计者 cw-auditor`……）。页面列表就是 `control.agentKinds()` 的返回值，
面板自己**不持有**任何 kind 列表：本包发布一个新 kind，它的页面自动出现，面板一行都不用改；
关掉的 kind 保留页面并标注「已关闭」（它存的模型仍在）；`agent-kinds` 模块关掉时页面仍在，
但标注「本会话未启用」——那时什么都没注册，写入只改配置。

「加一个 kind 多一页、删一个少一页」只在**本包发布**的 kind 表这个意义上成立，这是有意的：
一个 kind 需要本包提供一份系统提示资产与一个 Trellis 角色，所以 kind 是发布物而不是用户自由定义的键。
项目在 `agentKinds` 里声明了一个本包没有的 kind，会**保留**在配置里，但**没有页面**——
它背后没有 agent 可注册；`/Coworkflow:status` 会把它作为「已声明、本包未发布」报告出来。

**一页一次只标一个当前值。** 某 kind 固定了一个模型时，当前值就是那个模型：
若它在当前模型注册表里，光标落在它自己那一行；若不在（比如项目固定了一个本会话没配的模型，
或 `ollama/llama3:latest` 这种冒号是 id 一部分的写法），它单独占一行并写明「不在当前模型注册表」，
光标也落在那一行。**不动光标直接按 `Enter` 会写回原值**，不会把继承到的模型写上去；
注册表里查不到的 id 一律拒绝写入并说明原因（配置不动），「继承」那一行仍可清除。

| 键 | 作用 |
|---|---|
| `↑↓` | 在当前列内移动（模型列移动即切换统计对象） |
| `Tab` | 切换到下一个页面（主会话 → 默认 → 各 kind，循环） |
| `←→` | 在 模型 / 思考 列之间切光标 |
| `Enter` | 应用 |
| `Esc` | 关闭 |
| 直接打字 | 搜索过滤（只在模型列） |

各页写到哪里、思考等级取自哪个模型：

| 页面 | `Enter` 写进 | 思考等级来自 |
|---|---|---|
| 主会话 | `pi.setModel` / `pi.setThinkingLevel`（仅本会话） | 会话模型 |
| 子 agent（默认） | `.pi/settings.json` 的 `subagents.defaultModel/defaultProvider/defaultThinking` | 该默认模型，否则会话模型 |
| 某个 kind | `.pi/Coworkflow.json` 的 `agentKinds.<kind>.model/.thinking`，并重新注册 | 该 kind 固定的模型（固定了但注册表里查不到时，页面照实说查不到，不回退到继承的模型） |

口径：`input + output + cacheRead + cacheWrite`，按 `provider/model` 精确匹配，只统计 `/Coworkflow:start`
之后的消耗；7 天滑动窗口按本地日期。

### `/Coworkflow:settings`

`↑↓` 移动，`Enter` 修改；`Space` 切开关、`←→` 调上限（只作用于声明了对应手势的行，
其余行行为不变）。每一项**当场写进 `.pi/Coworkflow.json` 并立刻生效**。

数值在**面板内就地编辑**（不弹第二个对话框）：`Enter` 打开编辑行，`Enter` 提交、`Esc` 取消编辑。
留空表示回到默认值；不合法的数字留在状态行上报错，不会关闭面板。

一个 tick 内连按两下不会互相覆盖：行动作串行执行，在飞期间到达的手势被丢弃，
因为每次动作后行会重新读取，排队的手势会作用到用户没见过的值上。

## 模块

| id | 类型 | 负责 | 关闭时 |
|---|---|---|---|
| `trellis` | 安装 | 渲染本包的 Trellis 资产模板；`tasks/` `spec/` `workspace/` 与项目自己的 `config.yaml` **永不覆盖** | 只报告，不删 |
| `worktree` | 安装 | 任务隔离的**机制**：`auto_worktree.py` + `config.yaml` 的 `hooks.after_start` | 移除注册（脚本保留） |
| `agents` | 安装 | 两份指令文件：`AGENTS.md` 受管区（主会话）+ 子 agent 约定 | 移除受管区与约定，其余不动 |
| `subagents` | 安装 | 复用已装的 pi-subagents，缺失时才项目级安装 | 移除 `projectRootResolution` |
| `subagent-context` | 运行时 | 子会话按角色注入 Trellis 上下文（唯一注入路径） | 不注册钩子 = 不注入 |
| `agent-kinds` | 运行时 | 把声明的 kind 变成真 agent，并按 kind 控制开关与并发 | 不注册钩子 = 不注册、不拦截 |
| `lane-worktree` | 运行时 | lane 账目、`/Coworkflow:lanes`、任务出口检查 | 不注册钩子 = 不记账 |
| `capacity` | 运行时 | 项目级并发上限（第二道、更粗的门） | 不注册钩子 = 不拦截 |
| `panel` | 常驻 | `/Comodels` 与 `/Coworkflow:settings` | 关掉即无面板 |

`capacity` 的失败**不自动重派**：早期版本的自动重派会因为键空间对不上而重跑错的任务，已删除。

## 配置

```jsonc
// .pi/Coworkflow.json —— 项目的“同意书”，建议提交
{
  "version": 1,
  "worktreePrefix": "wt-",
  "autoEnable": false,
  "subagentConcurrency": 6,          // 可选：项目级并发上限
  "agentKinds": {                    // 可选：缺省用内置默认
    "executor":  { "enabled": true,  "maxConcurrent": 3, "model": "anthropic/claude-sonnet-4", "thinking": "high" },
    "auditor":   { "enabled": false, "maxConcurrent": 1 }
  },
  "modules": { "trellis": true, "worktree": true, "agents": true,
               "subagents": true, "subagent-context": true,
               "agent-kinds": true, "lane-worktree": true,
               "capacity": true, "panel": true }
}
```

- `modules.<id>` 显式写下的值永远优先。键缺失表示“该模块是在这份配置写出之后新增的”，
  此时按模块声明的 `newSwitchDefault` 决定：默认为 `"on"`（只观察/记录的层，升级即生效）；
  **会拒绝工作**的模块声明 `"off"`，不会因为一次升级就开始管一个没同意过的项目。
  报告里默认值标 `（默认）`，不与“本项目选过”混同。
- 本包不写用户全局设置，**唯一例外是项目信任决定**（见下）。

## 目录结构

```text
pi-Coworkflow/
├── extensions/coworkflow.ts       # 编排：开关 → 跑模块 → 渲染报告 → 激活运行时钩子
├── core/
│   ├── module.ts                  # 模块契约（WorkflowModule / RuntimeContext / PiRuntimeHost）
│   ├── config.ts                  # 项目配置、开关解析（含 newSwitchDefault）、配置根解析器
│   ├── agentdir.ts                # Pi 的 agent 目录（唯一一处推导）
│   ├── pi-subagents.ts            # 公开回执/完成的解码
│   ├── subagents-client.ts        # RPC v1、能力/状态/cost/fleet 解码、stop/steer/interrupt、共享准入
│   ├── subagents-workflow.ts      # 工作流注册（implement-review、fanout）、验收、任务身份链接、派单重叠
│   ├── child-tail.ts              # 子会话日志尾部的有界读（“刚才在做什么”）
│   ├── dispatch-timing.ts         # 派单区间与重叠判定
│   ├── trellis.ts                 # Trellis 布局、注入原语、会话开关标记
│   ├── usage.ts                   # 公开 native cost 缓存 + Pi/sessionFile 每日历史
│   ├── capacity.ts                # async 执行/管理分类
│   └── trust.ts                   # 项目信任决定（写 Pi 自己的 trust.json）
├── modules/                       # 只依赖 core/，互不引用
│   ├── index.ts                   # 注册表：顺序 = 安装顺序
│   ├── trellis/  worktree/  agents/  subagents/  subagent-context/
│   ├── agent-kinds/
│   │   ├── index.ts               # 注册 + 按 kind 的 tool_call 门禁 + 状态行
│   │   ├── registration.ts        # pi-subagents 运行时 agent 契约（加载/注册/dispose）
│   │   ├── definitions.ts         # 项目定义文件（.pi/Coworkflow/agents/<kind>.md）的读写与校验
│   │   ├── port.ts                # 公开请求端口 coworkflow:kind:v1（另一个入口，同一个写入者）
│   │   ├── defaults.ts            # 随附 kind 表（用途 → 角色）、默认值与资产加载
│   │   └── assets/{executor,planner,auditor,researcher,worker}.md
│   ├── lane-worktree/  capacity/
│   └── panel/{index,shared,settings,models}.ts
└── scripts/                       # node --test 套件 + cli.ts（终端入口）+ verify.ts（手工探针）
```

`modules/panel` 从 `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` 导入——Pi 的加载器
为所有扩展别名主机包，所以这是受支持路径。`node_modules/@earendil-works/*` 是仅供本地跑
`scripts/verify.ts` 的软链（已 gitignore），Pi 内运行不需要。

### 加一个模块

1. `modules/<id>/index.ts` 导出 `WorkflowModule`：`id`、`title`、可选的 `apply`/`remove`（安装与收回）、
   `activate`（运行时）、`onSessionActivate`（只在会话已加载时注册功能命令）、`onRuntimeChange`
   （开关变动时重新对齐会话级资源）、`runtimeStatus`（状态行，存下来按需读）、`onSessionEnd`、`alwaysActive`。
   钩子的 gate 分两级：作用于模型行为的按 `runtime.enabled` 在调用时 gate；只记录事实的按“项目已采用” gate。
2. **会拒绝工作的模块**声明 `newSwitchDefault: "off"`；只观察/记录的不用声明（默认 `"on"`）。
3. 需要模板放 `modules/<id>/assets/`，用 `moduleAsset` 读。
4. 在 `modules/index.ts` 的 `MODULES` 里加一行。

## 环境前提

### 项目信任（Pi 的安全边界）

Pi 把 `.pi/settings.json`、`.pi/extensions`、`.pi/agents` 等当作**受信任资源**：没有信任决定就不加载。
未受信任的项目里 `.pi/agents/` 下的 agent 定义发现不了，`.pi/extensions/trellis/` 不加载。

**`/Coworkflow:init` 会替你给信任**——这是本包唯一写用户级文件的地方（`~/.pi/agent/trust.json`，
路径遵循 `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`）。在一个项目里跑 init 本身就是「我要在这里用这套」的
明确动作；`--no-trust` 可跳过。

- 只影响这一个项目，不动已有信任决定；
- 从面板点「重新初始化」也会写；
- 信任在 Pi 启动时解析，所以刚 init 完的那个会话仍按未受信任运行，**下次在本项目开 Pi 生效**（或 `pi -a`）；
- 不做「按文件标记自动信任」：那等于「仓库里放一个配置文件就自动获得信任，然后它的扩展就能执行」。

`AGENTS.md` 这类上下文文件不受信任门控，所以受管区文本无论如何都会读到。

### 派单需要 `subagent` 工具，它有三个前置条件

按需派单靠 pi-subagents 提供的 `subagent` 工具。三个条件里任何一个没满足，本会话就**没有**这个工具，
但不妨碍主会话直接完成任务。需要委派时，`/Coworkflow:status` 会显示
`! subagents: 本会话没有 subagent 工具`，并列出该查哪一项。

1. **被 settings 声明。** 文件躺在 `~/.pi/agent/npm/node_modules/pi-subagents/` 里不等于会加载——Pi 只加载
   `packages` 里声明过的包。`/Coworkflow:init` 会把 `npm:pi-subagents` 写进项目 `.pi/settings.json`；
   项目还必须受信任（见上一节）。
2. **工具在两处被恢复，两处都要满足。** 这是让一台机器反复重启仍无效的原因：

   - **Pi 先按本会话历史恢复工具列表。** 一个历史里从未声明过 `subagent` 的会话，恢复后依然没有它。
     `--exclude-tools` 只是让扩展跳过延迟激活，**不会把缺失的工具补回来**。
   - **pi-subagents 默认 `toolActivation: "auto"`**，新会话只注册 `subagents_enable` 加载器，
     调用它之后 `subagent` 才出现；而恢复旧会话时它会沿用历史里保存的选择，`/reload` 改不动。

   ```bash
   # 完整的一条：跳过延迟入口 + 显式把派单工具加回来（+ 表示在默认工具之外追加）
   pi --session <id> --exclude-tools subagents_enable \
     --tools +subagent,+bg_wait,+contact_supervisor,+subagent_supervisor
   ```

   长期写法任选其一（`--tools` 的 `+name` 与纯名字不能混用，这条是 Pi 的规则）：

   ```jsonc
   // settings.json：每次启动都生效，不必带参数
   { "defaultTools": ["+subagent", "+bg_wait", "+contact_supervisor", "+subagent_supervisor"] }

   // 或者让扩展不做延迟激活（注意：这个键在 pi-subagents 自己的配置里）
   // ~/.pi/agent/extensions/subagent/config.json
   { "toolActivation": "eager" }
   ```

   ⚠️ `toolActivation` **不在** `settings.json` 的 `subagents` 下。写在那里不会被读取——这一点在这个
   包里曾经写错过，代价是反复重启加一次误诊。本包只**报告**它，不替你写。

   **恢复旧会话这一半由本包自己修**：如果 `subagent` 是「已配置但未激活」（包加载了，只是历史里没有），
   本会话启动时会重新声明它，`/Coworkflow:status` 会显示
   `~ subagents: 本会话历史里没有 subagent（恢复旧会话），已重新声明该工具`。
   只有「根本没配置」才需要你动手——那时状态行会给出声明检查的结果。

3. **必须重开 Pi。** `toolActivation` 在会话启动时读取，`/reload` 不够——`/reload` 也换不掉 Node 已经
   加载过、或已经失败过的扩展模块。改完配置要新起一个 Pi 进程。

三条都满足后，`/Coworkflow:status` 里不会再出现那一行，`subagent({ agent: "cw-executor", … })` 才可用。

### 交互面板需要 TUI 会话

`/Comodels` 与 `/Coworkflow:settings` 用 `ctx.ui.custom()`，只有交互式 TUI 才有。在 `pi -p`、
`--mode json`、RPC 里会长一条提示并打到 stderr，不会静默失败。其余命令、子 agent 注入、
并发拦截在无 UI 模式下照常工作。

## 校验

```bash
npm run typecheck     # tsc --noEmit
npm test              # node --test 回归套件
npm run verify:dispatch # 已安装 Pi + pi-subagents 时，验证真实后台派发与注入
```

`npm test` 覆盖的正是「失效时不会报错、只会静默给错答案」的那几处：

- kind 注册、按 kind 的门禁、面板与状态的一致性、角色映射、lane 分组（`agent-kinds*.test.ts`）
- 每个 kind 的模型：存储值的丢弃、定义签名变更即重新注册、清空回继承、面板页随 kind 增删（`agent-kind-models.test.ts`、`agent-kind-panel.test.ts`）
- 工作流并发是真的并发、kind 策略被遵守、失败不互相取消（`fanout.test.ts`）
- `stop` 的能力探测、接受≠终止、畸形回复是协议错误（`run-control.test.ts`）
- 尾部读的边界、半行容忍、无定时器（`child-tail.test.ts`）
- 公开 cost/fleet 的解码与「不完整不冒充完整」（`observability.test.ts`、`usage.test.ts`）
- `config.yaml` 被重排后 `after_start` 注册仍能被移除（worktree 用例）
- 配置根按会话缓存、git 失败不被当成当前目录（`config-root.test.ts`）
- 新模块默认值：gate 默认关、观察默认开、显式值优先（`switch-default.test.ts`）

`verify:dispatch` 使用临时 Git 仓库、独立 Pi 配置和本地测试模型，不调用外部模型服务。
它启动四个真实后台子进程，验证上限为二时的排队、依赖和自动续派，并检查每个
worktree 子会话最终送到模型的系统提示词是否包含 PRD、design、implement 和规范内容。
成功后清理临时 worktree；失败时保留证据并打印目录。这个探针验证运行时接线，
不衡量真实模型是否会主动拆分工作或选择派单。

手工探针（真实写文件，慎用）：

```bash
node scripts/verify.ts <项目目录> Coworkflow:init
node scripts/verify.ts <项目目录> Coworkflow:status
node scripts/verify.ts <项目目录> commands
node scripts/verify.ts <项目目录> panel
node scripts/drive-tui.py <项目目录> /tmp/out.txt "/Comodels" 20 DOWN ENTER
```

## 卸载

```bash
pi remove /Users/lyston/PycharmProjects/pi-Coworkflow
```

只移除命令，项目里已写下的文件保持原样。要连项目侧产物一起清：先
`/Coworkflow:init --disable <全部模块>`（收回受管区与钩子注册），再删 `.pi/Coworkflow.json`；
Trellis 部分按 Trellis 自己的方式卸载。

## 更名

本包曾叫 `pi-trellis-workflow`。已采用的项目无需手工迁移：旧配置
`.pi/trellis-workflow.json` 会被读入并写成 `.pi/Coworkflow.json`（前缀与开关保持），
`AGENTS.md` 里旧标记的受管区会就地换成新标记，不会出现两份。
