# pi-Coworkflow

把 lyston 的 Pi 工作流打包成**一条命令 + 一组可独立维护、可单独开关的模块**：改版 Trellis、任务 worktree
隔离、AGENTS.md 约束、subagent 层，以及两个运行时模块——**子会话的 Trellis 子任务注入**与
**lane 账目 / 合并计划**。

用户级装一次，之后**每个项目自己决定要不要采用**：没采用的项目里这个扩展什么都不做。

```bash
pi install git:github.com/lyston11/pi-Coworkflow@v0.1.0   # 推荐：按 tag 固定
pi install https://github.com/lyston11/pi-Coworkflow      # 跟随默认分支
pi install /path/to/pi-Coworkflow                         # 本地开发
```

不需要 npm 账号：git 源由 Pi 直接 clone 并按 tag 固定，`pi update --extensions` 负责同步。
（包名是 `pi-coworkflow`，将来若要发到 npm 画廊再用 `pi install npm:pi-coworkflow`。）

三种源行为一致：扩展本身是**用户级**装的，装完任何项目都能用命令；每个项目要自己
`/Coworkflow:init` 采用、`/Coworkflow:start` 加载。

> 更名说明：本包曾叫 `pi-trellis-workflow`。已采用的项目无需手工迁移——旧配置
> `.pi/trellis-workflow.json` 会被读入并在下次运行后写成 `.pi/Coworkflow.json`（前缀与开关保持），
> `AGENTS.md` 里旧标记 `<!-- pi-trellis-workflow:start/end -->` 的受管区会被就地换成新标记，
> 不会出现两份。

## 采用与开关：项目级、显式

项目采用与否、哪几个模块生效，只看项目里的一个文件：

```jsonc
// .pi/Coworkflow.json —— 这个文件是项目的“同意书”，建议提交
{
  "version": 1,
  "installedAt": "2026-10-18T06:47:13.914Z",
  "worktreePrefix": "wt-",
  "autoEnable": false,          // 新会话是否自动加载 Coworkflow；默认不加载
  "modules": {
    "trellis": true,
    "worktree": true,
    "agents": true,
    "subagents": true,
    "subagent-context": true,
    "lane-worktree": true,
    "panel": true
  }
}
```

- **文件不存在 = 本项目未初始化**：扩展在项目里不安装、不注入、不记账；只有 `/Coworkflow:init` 会创建它。
- **初始化 ≠ 加载**：`autoEnable` 默认 `false`，所以已初始化的项目里**新开会话也不加载** Coworkflow——就是原生 Pi。在该会话运行 `/Coworkflow:start` 才加载（开关按会话 id 记录，派发的子 agent 会跟随），或 `--auto-enable on` 让新会话直接加载。
- 会话状态与项目开关的优先级：**会话显式设置优先**（`/Coworkflow:start off` 即使项目 `autoEnable: on` 也保持未加载）。
- `modules.<id>` 是逐模块开关：**配置里显式写下的值永远优先**；键缺失表示“该模块是在这份配置写出之后新增的”，此时按该模块声明的 `newSwitchDefault` 决定——默认为 `"on"`（只观察/记录的层，升级即生效），可拒绝工作的 gate 模块声明 `"off"`（不会因为升级就开始管一个没同意过的项目）。今天的模块全部保持 `"on"`，所以既有配置的有效开关不变（每次运行都会把整张开关表写全）。报告里默认值会标 `（默认）`，不与“本项目选过”混同。运行时模块在事件/命令边界读取开关；关闭会撤销资源，重新启用可在本会话恢复。
- 一切都是项目级的：不写用户的全局设置（`~/.pi/agent/*`）——**唯一的例外是项目信任决定**：
  `/Coworkflow:init` 会把本项目写进 Pi 自己的信任库 `~/.pi/agent/trust.json`（理由与边界见
  [项目信任](#项目信任pi-的安全边界不是本包的限制)，`--no-trust` 可跳过）。`pi-subagents`
  若已安装则直接复用，只在缺失时才声明到项目的 `.pi/settings.json`。

## 命令

| 命令 | 作用 |
|---|---|
| `/Coworkflow:init` | **初始化/刷新本项目**（首次运行 = 一键装上全部模块）；未初始化前其他功能都不存在 |
| `/Coworkflow:start` | **在本会话加载 Coworkflow**（子 agent 的 Trellis 注入、`/Coworkflow:lanes`、`/Comodels`）；`off` 卸载本会话，`status` 看状态 |
| `/Coworkflow:settings` | 设置面板：模块开关、新会话是否自动加载、worktree 前缀、子 agent 并发上限、子 agent 类型（每个 kind 的开关与上限）、Trellis 范式对齐；未初始化时可直接从面板初始化 |
| `/Coworkflow:status` | 查看初始化状态、模块开关、自动加载、安装产物与本会话是否已加载（等价 `--dry-run`，不改文件） |
| `/Comodels` | 模型面板（需先 /Coworkflow:start）：主会话 / 子 agent 两个 tab，三列 = 模型 \| 思考等级 \| 用量 |
| `/Coworkflow:run [focus]` | 在宿主验证过的当前任务 worktree 运行原生 `coworkflow.implement-review`，交付后仍需主会话验收 |
| `/Coworkflow:stop <runId> [instructions]` | 请求停止一个异步 run；**接受≠终止**，会再读一次公开状态并把两件事分开说；带 instructions 时先 steer 再 stop（需先 /Coworkflow:start） |
| `/Coworkflow:steer <runId> <instructions>` | 给运行中的 run 追加指令（不杀进程、不是新派单），指令只作为数据传给 pi-subagents |
| `/Coworkflow:lanes` | 当前 Trellis 任务的 lane（worktree 隔离派单）状态、patch 路径与合并计划；按记录的 kind 分组；`/Coworkflow:lanes stop <runId>` 只停止本任务记录过的 run（需先 /Coworkflow:start） |
| `--enable <id,...>` / `--disable <id,...>` | `/Coworkflow:init` 的参数：改模块开关并持久化；关掉某模块会收回它写下的东西 |
| `--auto-enable on\|off` | 新会话是否自动加载 Coworkflow（默认 off） |
| `--trellis-update` | 代跑 `trellis update -s`：升级未被本地改动的 Trellis 文件，保留本地改动与所有任务记录 |
| `--prefix fg-` | worktree 目录前缀（默认 `wt-`；**已有钩子的前缀优先**，不会静默改写） |
| `--dry-run` | 只报告会做什么（汇总行以「预计」开头） |

### 三层状态

| 层 | 含义 | 怎么进/出 |
|---|---|---|
| 未初始化 | 本项目没有 `.pi/Coworkflow.json`：不安装、不注入、不记账，命令里只有 `/Coworkflow:init|status|settings` | `/Coworkflow:init` |
| 已初始化，未加载 | 新会话的默认状态：原生 Pi（原生 `/model`、你自己的 subagent 配置、无 Trellis 注入），命令里只有四个生命周期命令 | `/Coworkflow:start`，或在设置面板里打开「新会话自动加载」 |
| 已加载 | 本会话启用：`/Comodels`、`/Coworkflow:lanes`、子 agent 的 Trellis 注入都可用 | `/Coworkflow:start off` |

**`/reload` 不会丢掉会话开关。** 开关不是内存状态，而是按 session id 记在 `.trellis/.runtime/workflow-sessions.json`；`/reload` 触发的 `session_start`（`reason: "reload"`）带同一个 session id，扩展据此重新解析，开关照旧生效。真 TUI 实测：`/Coworkflow:start` → `/reload` → `/Comodels` 直接打开面板。

为了避免"写了一个 id、读的是另一个 id"，`/Coworkflow:start` 会把开关同时记在该会话**所有已知 id** 下（命令上下文的 session id 与进程环境的 id），`/Coworkflow:start status` 也会显示 `会话标记: on/off`——`off` 就意味着 reload 后会回到未加载，一眼可辨。另外每个命令与两个面板在动作前都会 `runtime.refresh()` 重读一次开关，所以「另一个窗口刚 start」「刚改过设置」这类时序也不会误判。

仍然成立的语义：**新会话必须自己 start 一遍**（或把项目的「新会话自动加载」打开）。`/Coworkflow:init` 结束时也会明确提示当前会话是"已加载"还是"尚未加载"，因为这是唯一容易漏掉的一步。

幂等：重复跑只把受管区刷到最新。`AGENTS.md` 里只有
`<!-- pi-Coworkflow:start -->` / `:end` 之间那一段由本包负责；检测到项目已有等价的手写章节时
**拒绝追加**并提示先迁移，避免同一份规则出现两遍。

## 分工：主会话只做脑子，执行全部交出去

这是整套工作流的核心约定，`AGENTS.md` 受管区里写成了硬规则：

```text
主会话
  ├─ 规划：理解需求 → 建/更新 Trellis 任务 → 拆成可独立验证的子任务
  ├─ 派单：subagent({ agent, async: true, context: "fresh", task: "Active task: …" })
  ├─ 监听：完成通知 + subagent({ action: "status" })；子 agent 提问走 contact_supervisor
  ├─ 审计：读 diff / 产物，对照 prd 验收条件，跑受影响范围的最小充分检查
  └─ 决策：合并、重派、调整拆分，或回头改需求
```

- **子 agent 只回结果**，不决定做什么；主会话派完单不空等，继续判断、盯进度、随时审计。
- **主会话自己动手的唯一场合**：需要全局判断，或改动小到不值得派单（一行修复、改个配置、答一个问题）。
- **派单边界**：有明确输入、产物、验收方式的工作才派；探索性、跨模块协调的留主会话。
- **审计边界**：子 agent 回结果 ≠ 结果可用。对照 prd 验收条件核对产物与它引用的文件、跑该模块测试，偏差就重派或自己修，不能把子 agent 的结论直接当成事实汇报。
- **多阶段工作用命名的 workflow 表达**（例如上游的 implement → review 资源），单步工作直接派一个有边界的子 agent；无论哪种，子步骤都在原生侧执行、有稳定的 child key 和验收结论，主会话只接收产物与结论，不把几个阶段串起来自己做。
- **注入按角色，不按 agent 名**：`worker` 加了 `<!-- trellis-agent: implement -->` 就拿到 implement 那份上下文，不必改名成 `trellis-implement`；未标记的 agent 也会拿到子 agent 约定（角色上下文除外）——"不知道你是谁"不等于"不给任何约束"。

**这条规则只写在文件里，不在运行时计数。** 早期版本还有运行时的一半：在主会话里数 `tool_call`，越过
「≥12 次工具调用 + ≥4 个文件且一次没派单」的阈值就派一条 `pi-Coworkflow` 记录。它已被删除，原因有三：
计数是对已经发生的那一轮做事后判断，改不了当时的决策；阈值把"该不该派"变成两个数字，而真正的判据是
"能不能独立验证"；上游原生的完成通知已经给出真正有用的事实（哪个 child 跑了哪个任务、产物在哪）。
那个返回给 `before_agent_start` 的提醒还曾经以**用户消息**的形式插进对话，读起来像提示注入——这条路径
也一并没有了：本包不再有 `sendUserMessage` 调用，也没有任何被动状态会以用户身份说话。

## 模块

| id | 类型 | 负责 | 产物 / 行为 | 关闭时 |
|---|---|---|---|---|
| `trellis` | 安装 | 改版 Trellis 本体 | 无 `.trellis/` 时 `trellis init --pi -y`；已有项目**只报告不重写**（tasks/spec/workspace/.runtime 记录保留），范式对齐走 `trellis update` 或 `--trellis-update` | 只报告，不删（Trellis 资产归 CLI 管） |
| `worktree` | 安装 | 任务隔离的**机制** | `.trellis/scripts/hooks/auto_worktree.py` + `.trellis/config.yaml` 的 `hooks.after_start` | 移除 `after_start` 注册（脚本保留） |
| `agents` | 安装 | 两份指令文件 | `AGENTS.md` 受管区（主会话）+ `.pi/Coworkflow/subagent-AGENTS.md`（子 agent）；不注册任何运行时钩子 | 移除受管区与子 agent 约定（其余内容不动） |
| `subagents` | 安装 | 复用已装的 `pi-subagents`，缺失时项目级安装 | 检测用户级/项目级/npm 目录；必要时写项目 `.pi/settings.json` 的 `packages`；写 `subagents.projectRootResolution: "git-root"` | 移除 `projectRootResolution`（packages 保留） |
| `subagent-context` | 运行时 | 子会话按角色注入 Trellis 上下文 | 在**子会话**里读角色 + 任务，注入 `implement.jsonl`/`check.jsonl`/spec 树 + prd/design/implement；角色来源接受 `trellis-<role>` 与 kind 名（`cw-executor`→implement、`cw-auditor`→check），只有一条注入路径 | 不注册钩子 = 不注入 |
| `agent-kinds` | 运行时 | 把项目声明的子 agent **类型**变成真 agent，并按 kind 控制开关与并发 | 在**主会话**里通过 pi-subagents 的公开 `./agents` 契约（`pi-subagents:runtime-agent-register:v1`）注册 `cw-<kind>`；在 `tool_call` 拦截关闭的/超上限的 kind；`/Coworkflow:settings` 的「子 agent 类型」一节 | 不注册钩子 = 不注册 kind、不拦截（已注册的会被撤销） |
| `lane-worktree` | 运行时 | lane 账目与合并计划 | 在**主会话**里记录原生身份链接（含派单的 kind，兼容旧 lane 指针），提供 `/Coworkflow:lanes` | 不注册钩子 = 不记账 |
| `capacity` | 运行时 | 项目级子 agent 并发上限 | 在**主会话**里拦截超出本项目上限的派单（`tool_call` gate）；不写 pi-subagents 的配置文件；**失败不自动重派**（早期版本的自动重派会重跑错的任务，已删除） | 不注册钩子 = 不拦截 |
| `panel` | 常驻 | 模型面板 | `/Comodels`：主会话（本会话）/ 子 agent（本项目）两个 tab，模型 + 思考等级 + token 用量；不写全局 | 关掉即无面板 |

`panel` 是控制面（`alwaysActive`）：工作流关闭时也能用。

`trellis` 模块**不自带** Trellis 资产：那些文件由 Trellis CLI 拥有、在 `.trellis/.template-hashes.json`
里做三路合并，本模块只调 `trellis init --pi -y`。这样 `trellis update` 仍是同步 Trellis 的唯一入口，
不会出现两份内容互相打架。其余模块只放上游没有的那一层。

### 已有 Trellis 记录的项目

项目之前用过（原版或旧版）Trellis 时：

- `tasks/` `spec/` `workspace/` `.developer/` `.runtime/` 是项目历史，本包**从不重写**；`trellis update` 也把它们列为 “User data (preserved)”。
- 范式（Pi 扩展、`.pi/prompts/`、`.pi/agents/`、`.trellis/workflow.md` 等）由 `trellis update` 对齐到本仓版本；`/Coworkflow:init --trellis-update` 会先跑 `--dry-run` 报告差异，再跑 `update -s`（升级未被本地改动的文件、保留本地改动）。
- 本包写过的 `.trellis/config.yaml`（`after_start` 注册）与 `.pi/settings.json`（`subagents.*`）算“本地改动”，会被 `-s` 保留；即使被覆盖，后面的模块也会重新写回（顺序：trellis → worktree → agents → subagents）。
- `AGENTS.md` 已有手写等价章节时，`agents` 模块不追加受管区、只提示迁移——两份规则不会同时存在。

## 会话内面板

### `/Comodels`

一张**表格**：模型与思考等级是各自独立的列，思考列始终显示全部可用等级；**用量列是一整块 7 天柱状图**，占满该列的整列高度（与可见模型行数同高），而不是一行迷你字符。

```
pi-Coworkflow · 模型面板
[主会话]  子 agent   本会话
当前：buddy2api/deepseek-v4.1-flash · high

  模型                                │ 思考等级         │ 用量
  ────────────────────────────────────┼──────────────────┼──────────────────────────────
→ ✓ deepseek-v4.1-flash [buddy2api]   │ ● high           │              ███
    glm-5.3 [buddy2api]               │                  │              ███
    glm-5.3-flash [buddy2api]         │                  │              ███
    gpt-6-astra [buddy2api]           │                  │              ███
    kimi-k3 [buddy2api]               │                  │              ███
    cline-free/deepseek-v4.1-flash    │                  │              ███
    cline-pass/deepseek-v4.1-flash    │                  │     ███   ████████████
    gpt-6-sol [lanin]                 │                  │  一  二  三  四  五  六  日   1.1M

当前生效：buddy2api/deepseek-v4.1-flash · 思考 high · 仅本会话
```

- 柱状图**竖直向上长**：7 根柱子（每天一列，2–3 列宽），高度按窗口内峰值等比；底行是星期标签与该窗口的 token 合计。
- 图表只画**光标所在行**的模型，`↑↓` 移动光标即切换统计对象。
- 7 天滑动窗口按**本地日期**；无消耗的日子没有柱子。
- **口径**：`input + output + cacheRead + cacheWrite`，按 `provider/model` 精确匹配（不同 provider 的同名模型不串账），且**只统计 `/Coworkflow:start` 之后**的消耗。
- 对齐：单元格先按列宽 pad 成纯文本再上色；分隔线 `─┼─` 与数据行 ` │ ` 同宽。
- 表格之外没有任何附加块。
- **性能**：会话启动、`agent_settled`、原生完成通知和打开面板时刷新公开数据；渲染/按键只对内存历史做投影，不扫描磁盘、不请求 RPC、没有轮询。

| 键 | 作用 |
|---|---|
| `↑↓` | 在当前列内移动（模型列移动即切换统计的模型） |
| `Tab` | 切换 主会话 / 子 agent tab |
| `←→` | 在 模型 / 思考 列之间切光标 |
| `Enter` | 应用当前项 |
| `Esc` | 关闭 |
| 直接打字 | 搜索过滤（只在模型列） |

### `/Coworkflow:settings`

一段一组，`↑↓` 移动、`Enter` 修改。两类键手势只作用于带对应动作的行，其余行行为不变：

| 键 | 作用 |
|---|---|
| `↑↓` | 在可选行之间移动 |
| `Enter` | 修改当前项（并发上限会问一个数；留空 = 默认/不限） |
| `Space` | 切换当前行的开关（`子 agent 类型` 的每个 kind） |
| `←→` | 把当前行的上限减/加 1（`子 agent 类型` 的每个 kind） |
| `Esc` | 关闭 |

面板里改的每一项都**当场写进 `.pi/Coworkflow.json` 并立刻生效**，不需要重启：模块开关走 `setSwitch`，
kind 开关与上限走同一条运行期对齐（重新注册/撤销注册），并发上限由 `capacity` 模块在下一次派单时读取。
连续切换两次同一项会回到原状态，不会留下重复注册、重复钩子或上游的重名冲突。

### 子 agent 类型（agent kinds）

`子 agent 类型` 一节每个内置 kind 一行：

```
  执行者 cw-executor   [x] 开 · 上限 3   已注册到 pi-subagents
  审计者 cw-auditor    [ ] 开 · 上限 1   关闭时该 kind 的派单会被拒绝，其他 agent 不受影响
  = agent-kinds: cw-executor（kind executor）已注册
  - agent-kinds: auditor 已关闭（不注册；派单会被拒绝）
```

最后几行是 `agent-kinds` 模块自己的状态，原样显示：**注册成功、注册失败的原因、契约不可用的原因**。
一个没有真正注册进 pi-subagents agent 列表的 kind 永远不会在这份面板里显示成可用——包括宿主没有
暴露运行时 agent 契约、`./agents` 导出不存在、以及项目已有同名 agent 造成的重名冲突。

## 面板里的用量统计

原生总量与模型日图有不同口径，不把无法归属的总量分摊到某个模型：

| 数据 | 来源 | 口径 |
|---|---|---|
| 本会话原生合计 | 公开 RPC `cost` v1：`parent`、`children`、`childTotal`、`total` | pi-subagents 当前会话分支的父子用量；显示在模型面板已有说明行和设置事实中 |
| 主会话日图 | Pi `sessionManager.getEntries()` 的 assistant、usage、compaction、branch_summary | 保留本地日期、精确 `provider/model`、启用时间之后的 7 天图 |
| 子会话日图 | 仅由原生 cost 明确给出的 `children[].sessionFile` | 读取对应 Pi JSONL 的真实模型与时间，合并到同一模型日图；两个 tab 继续使用这一合并口径 |

`unresolvedAsyncChildren > 0` 时原生总量显示 **≥ / 不完整**。公开能力不可用、协议无效或超时则显示**未知**，不补零。缺少 sessionFile、文件不可读、记录缺少模型/时间、坏行或读取预算不足时，图表保留已知数据并标记不完整；没有可见数据则显示“未知 / 不完整”，不画成已知零。真实可确认的零消耗仍显示零。

历史读取每次最多 128 个去重路径、单文件 8 MiB、合计 32 MiB；超过预算不截断后假装完整。只读原生给出的绝对路径，不搜索私有临时目录或 meta 文件，也不把文件 mtime 当作使用日期。原生 cost 没有跨会话项目累计或模型/每日分组，本包不推算这些数据。总量中的 `$` 只在原生金额非零时显示。

缓存只属于当前宿主、会话与 epoch；关模块、会话替换、reload/shutdown 后，旧异步结果不能写回新会话。面板打开时刷新一次，保持打开期间不定时刷新；关闭后重新打开可读取新记录。

## 原生 implement → review 工作流

`/Coworkflow:run [focus]` 使用 `coworkflow.implement-review`。Trellis 负责任务要求、当前任务指针和隔离 worktree；pi-subagents 负责执行、mission、稳定 child key、原生验收门、恢复记录与完成通知；Coworkflow 只做公开 API 适配、项目策略与任务到原生身份的关联。

宿主在 resolver 之外校验当前任务的 `task.json`、真实路径、同仓库 Git linked-worktree 成员关系及任务记录的分支，拒绝主检出、别的仓库、普通目录与不一致分支。纯 resolver 只接受准备好的当前任务引用及可选 focus/agent 名，拒绝调用方覆盖 worktree/mainCheckout 或传入未准备好的任务。必需的子扩展注册先于工作流；关闭/重载/会话切换会撤销注册。

工作流依次 await 稳定键 `implement`、`review`，两个 child 都使用 `context: "fresh"`、同一已验证 cwd 与 `worktree: false`；只有最外层异步。实现必须给出有效 completed 结果及验收证据，独立审查必须明确 pass 且没有阻塞 findings；失败、字段缺失或矛盾 verdict 都失败。原生 mission/run/artifact 引用会返回给主会话；**流程完成不代表最终验收、合并或发布**。

支持下限按公开能力检查：RPC v1 `ping/status/spawn/cost`、版本化 fleet/status projection、进程内完成事件，以及文档导出的 workflow-resource/required-child-extension 注册接口。已核对 pi-subagents 0.79.1；不能只凭版本号宣称支持。缺能力会显示诊断，不加载第二套 runtime，也不回退到 CLI 启动。RPC 请求有 UUID、超时与监听清理；spawn 回复超时可能已经启动，只能用 `rpc-spawn-<requestId>` 查询恢复，**绝不自动重发**。不启用 goal/watchdog、提醒或自动重试。

### 项目并发边界

`.pi/Coworkflow.json` 的 `subagentConcurrency` 保持有效，按公开 `fleet.topLevelAsyncCapacity.used` 加尚未被原生状态接管的本地预留决定准入。缺少可靠计数时，配置了上限的派单明确拒绝；不把未知当作 0。只有顶层 async 执行/恢复占位，管理调用与前台调用不占位；原生工作流内部 fanout 仍由上游限制。

同一门控覆盖 `subagent` 工具和本包 `/Coworkflow:run` 的 RPC spawn。它不控制其它扩展直接发出的 RPC，也不承诺跨进程协调；不会改用户级上游容量配置。已确认的 no-launch/完成会释放预留，模糊超时保留关联直到公开状态确认或会话结束，不靠 TTL 假设运行消失。

### 子 agent 类型（agent kinds）

项目可以在 `.pi/Coworkflow.json` 里声明自己用哪些**类型**的子 agent：

```json
{
  "agentKinds": {
    "executor": { "enabled": true,  "maxConcurrent": 3 },
    "auditor":  { "enabled": false, "maxConcurrent": 1 }
  }
}
```

缺省的 kind 用内置默认（`executor` 开、上限 3；`auditor` 关、上限 1）；缺省的字段用内置默认；
本包不发的 kind 保留配置但**不注册**，并在面板和 `/Coworkflow:status` 里报为「已声明、本包没有」。

注册走已安装 pi-subagents 的**公开** `./agents` 导出与 `pi-subagents:runtime-agent-register:v1` 事件，
名字统一 `cw-<kind>`（避让 `worker` / `reviewer` / 项目自己的 agent）。走事件而不是直接调
`registerRuntimeAgent`：直调会在**没有任何 owner 加载**时也写进全局注册表，于是本包会把一个根本没被
合并进 agent 列表的 kind 报成可用——而那正是一个什么也拦不住的“门”。

派单就是一个普通调用：`subagent({ agent: "cw-executor", … })`。本包保证的是两件事，且只保证这两件：

- 关闭的 kind 被拒绝，理由里列出**当下真的可用**的 kind（未注册的不算可用）；
- 超过该 kind `maxConcurrent` 的派单被拒绝，理由里是上限与当前占用；占用数来自公开 fleet 投影
  （`entries[].agent`），不是本包自己的账本。读不到（没 `fleetStatus`、投影不可解析、有界窗口溢出、
  回复落在会话切换之后）就**拒绝**，不把未知当 0。

其它派单（`trellis-*`、`worker`、其它扩展的 agent、`status`/`stop` 这类管理调用）一次都不读公开状态，行为与
没有本模块时完全一致。项目级 `subagentConcurrency` **仍然是第二道、更粗的门**，两者都要放行。

kind 与 Trellis 角色的对应写在 kind 表里（`executor → implement`、`auditor → check`），所以
`cw-executor` 的子会话拿到的就是现有那条 `subagent-context` 注入路径给的 implement 上下文——不新增按 kind 的第二条注入。
`/Coworkflow:run` 的原生 `implement → review` 工作流会跟随这两个 kind（已启用**且**已注册时），否则保持内置的
`trellis-implement` / `trellis-check`。

一行一个 kind 在 `/Coworkflow:settings` 的「子 agent 类型」里改，**当场生效、无需重启**；改两次等于没改：
不会留下重复注册、不会撞上游重名，也不会多出第二个 `tool_call` 钩子。

## 中断一个 run：`stop` / `steer`

主会话必须能随时打断自己派出去的 run，所以三个命令都走 pi-subagents 的公开 RPC
（`stop`、`steer`、`interrupt`），客户端在 `core/subagents-client.ts`：

- 先按 `ping.methods` 检查方法是否被通告，**没有就什么都不发**并说明原因；
- 保留上游自己的错误文字与 code（`invalid_state`、`not_found` 等），不改写成别的原因；
- 回复读不出来（没有 `state`、没有回执）就是 `protocol` 错误，不当成功；
- `stop` 的返回类型是**接受回执**（`{ accepted: true, state: "stopping" }`），不是终止：
  上游明确写 `state: "stopping"` 只表示这次停止操作被接受，终止要靠随后的 `status` 与进程终止证据确认；
- 失败的 stop 不会被报成“超时所以 run 死了”，也没有 `ambiguous` 重试别名。

`/Coworkflow:stop <runId>` 会先打印上游的接受回执，再读一次公开状态打印「停止后的公开状态」，两行分开；
状态仍是 `running`/`queued`/`stopping` 时明确说「停止尚未生效」。**任何情况下都不打印“已停止”**。
`/Coworkflow:lanes stop <runId>` 只接受本任务在 `.trellis/.runtime/native-runs.json` 里记录过的 run，
拒绝任意 id；其它 lanes 输出仍然只读。`/Coworkflow:steer <runId> <instructions>` 把指令作为数据传
（`params.message`），不做任何 shell 拼接或代码求值；`deliveryStatus: queued` 如实说「还在队列里」。

上游没通告 `stop`/`steer`/`interrupt` 时，命令原样说明「没有通告 RPC <method> 方法」，一个请求都不发。


## 运行时模块怎么工作

### `subagent-context`：子会话只拿到它要执行的那部分

派单时**不**让子会话继承主会话上下文（显式 `context: "fresh"`；三个 Trellis 角色 agent 也已声明
`defaultContext: fresh`）。子会话要的 Trellis 上下文由这个模块注入：

| 事实 | 来源（按优先级） |
|---|---|
| 角色 | 子会话名（pi-subagents 写作 `subagent-trellis-check-<runId>-<n>`，或 `<agent>: <task excerpt>`）→ `trellis-implement` / `trellis-check` / `trellis-research`；kind 名同样按同一张表解析（`cw-executor` → `implement`、`cw-auditor` → `check`）；其次 `<!-- trellis-agent: <role> -->` 标记 |
| 任务 | 派单提示词里的 `Active task: <任务目录>`（pi-subagents 会把它包成 `Task: Active task: …`）→ 会话名里的任务路径 → 父会话的 Trellis 会话指针 |

注入内容与字节预算沿用上游 Trellis 子 agent 钩子的语义（每文件 32K、每工件 64K、总计 128K，读
`.trellis/config.yaml` 的 `context_injection` 可覆盖；`0` 关闭）：

| 角色 | 注入 |
|---|---|
| `implement` | `implement.jsonl` 列出的 spec/research 正文 + `prd.md` + `design.md` + `implement.md` |
| `check` | `check.jsonl` + `prd.md` + `design.md` + `implement.md` |
| `research` | `.trellis/spec/` 目录树 + 搜索提示（不需要任务） |

所有文件都从**主检出**读（worktree 里只有已提交内容），每轮启动都幂等重建本包的注入块，且只在子会话里生效——
主会话的 Trellis 扩展自己负责它那份，本模块不重复。

注意：三个角色 agent 来自 `.pi/agents/trellis-*.md`，由 pi-subagents 从项目发现，**需要项目被信任**；
以 `pi -na`（`--no-approve`）启动时会忽略项目本地资源，派单会报 `Unknown agent: trellis-check`。

### `lane-worktree`：把 lane 绑到任务上

并行 lane 本身是 pi-subagents 的职责，它已经做了托管 worktree、每个 lane 的 patch、以及
parallel handoff manifest（`lane.status` / `lane.recordMerge` / `worktree.cleanup`）。本模块**不重造**这些，
只补 Trellis 这一侧缺的账：

1. 从已关联的工具/RPC 成功回执取得原生 run/mission 身份，将任务与身份及显式 artifact 引用存到 `.trellis/.runtime/native-runs.json`。这不是状态数据库，不保存生命周期、任务提示词或重试队列。kind 型派单额外存下**派单时看到的 kind**（不是事后从会话名猜的），非 kind 派单存空。
2. 从原生 `subagent-notify.details.runs` 和公开 status 更新可见引用，读取明确指定的 handoff/receipt；每个 child 按精确 runId 或原生索引对应它自己的 patch/output/worktree，不解析通知正文、不按数组顺序猜身份。
3. `/Coworkflow:lanes` 保留证据、合并与清理指导，并按记录的 kind 分组（`按 kind 分组: 执行者（executor） ×2 · 非 kind 派单 ×1`，每个 run 行也带 `kind`）；git apply 的目标使用已验证的任务 integration worktree。目标不合法时只显示原因和产物，不生成应用命令。

原来的 `.trellis/.runtime/lanes/<任务>/<runId>.json` 指针保持可读，不迁移或删除已有 lane 产物。新版本删除私有运行目录探测及 `core/ledger.ts`；不会从旧 meta 扫描结果重建原生生命周期。完成通知/唤醒、mission 恢复记录和执行状态始终由上游负责。

## 失败与记录边界

**失败不自动重派。** 启动回执不是终态，终态也不是主会话验收。重试、恢复、最终集成及清理仍由人或主会话决定；本包不合并、不 apply patch、不删 worktree、不运行自己的调度器。

lane 观察要求项目已采用且 `lane-worktree` 开启；会话尚未 `/start` 时也可保留明确的任务/原生身份关联。未知完成不附到“唯一待办”上。容量、工作流命令与子上下文各自遵守模块/会话开关，清理不因模块关闭而跳过。被动内部状态不发送用户消息或自定义上下文消息。

## 两份指令文件：主会话一份，子 agent 一份

项目根的 `AGENTS.md` 写的是**主会话的职责**（规划、派单、审计、合并），子 agent 不做这些。让子 agent 继承它有两个代价：白烧 token，以及把"主会话才该做的事"写进子 agent 的指令里。

`agents` 模块因此管理**两份**：

| 文件 | 读者 | 内容 | 归属 |
|---|---|---|---|
| `AGENTS.md`（受管区 `<!-- pi-Coworkflow:start/end -->`） | 主会话 | 开关说明、任务隔离规则、核心分工（主会话只做脑子）、派单与审计边界 | 项目自己（受管区由本包覆盖） |
| `.pi/Coworkflow/subagent-AGENTS.md` | 被派发的子 agent | 你只做派单里那一段、不能建/改 Trellis 任务、不能合并 push、验证再报告、上下文从哪来、禁止清单 | **本包** |

放在 `.pi/Coworkflow/` 而不是 `.trellis/`，是因为它是本包的产物；放进 `.trellis/` 会让 `trellis update` 把它当成需要协调的模板。旧位置 `.trellis/subagent-AGENTS.md` 仍被读取（迁移兜底），下次 `/Coworkflow:init` 后只保留新位置。

### 为什么不可能同时注入两份

子会话拿到项目 `AGENTS.md` 只有一条途径：pi-subagents 的 agent 声明了 `inheritProjectContext: true`（Pi 把它渲染成 `<project_instructions path="…">`）。

**这道隔离放在兼容层，不写进任何 agent 的 frontmatter。** `subagent-context` 在子会话里、追加自己的内容之前，先把每个继承来的 `<project_instructions>` 里**本包的受管区**（`<!-- pi-Coworkflow:start -->` 到 `:end`）剪掉，项目自己写在区外的东西原样保留：

| 场景 | 结果 |
|---|---|
| Trellis 角色子会话（`trellis-implement`/`check`/`research`） | 剪掉受管区 → 注入子 agent 约定 + 角色上下文 |
| 任意其它 agent（`worker`、`reviewer`、自定义） | 剪掉受管区 → 注入子 agent 约定（通用兜底或项目自己的那份），**不注入**角色上下文 |
| 未初始化本包的项目 / 模块被关掉 | 事件时门控不注入，系统提示一字不动；已注册清理钩子仍可执行 |
| 主会话 | 钩子只在子会话里生效（`runtime.isChild`），主会话照常继承项目 AGENTS.md |

剪整块 `<project_instructions>` 是早期版本的写法，它连"怎么构建、代码怎么组织"一起删掉了——子 agent 于是不知道这个仓库怎么跑测试。现在只剪本包写进去的那一段：项目自己的构建命令、代码规范、目录说明都还在。

为什么不改 agent frontmatter：那要写进 `trellis-{implement,check,research}.md`，属于 Trellis 的模板（`trellis update` 会覆盖，而且改的是别人的默认配置）；而且只能覆盖我们自己拥有的三个 agent，用户自定义的 agent 仍会继承。放在注入层则**对所有 agent 生效、随本包一起升级、且只在采用本包的项目里生效**。

**重复运行也是幂等的。** `before_agent_start` 每一轮都会触发，注入必须能被反复执行：块写进 `systemPromptOptions.sections.pi_coworkflow_child`，Pi 自己负责渲染和 diff，第二次是替换而不是追加；宿主没有结构化 options 时退回字符串路径，先剪掉自己上一轮的块再重新拼。同一个子会话跑十轮，系统提示里仍然只有一份。

**无效的任务引用不会被改写成父会话的任务。** 派单提示词写了 `Active task: .trellis/tasks/typo` 而该目录不存在时，注入会在块首明说这个引用无效、并告诉子 agent 不要猜；只有**完全没写**任务时才回落到父会话的 Trellis 指针。

注入顺序固定为：`Trellis 子任务上下文（role: …）`（角色会话才有）→ `子 agent 工作约定` → `边界`。

## 目录结构

```text
pi-Coworkflow/
├── package.json                 # pi.extensions → 单入口
├── extensions/coworkflow.ts       # 编排：开关 → 跑模块 → 渲染报告 → 激活运行时钩子
├── core/module.ts               # 模块契约（WorkflowModule / ModuleContext / PiRuntimeHost / RuntimeContext）
├── core/config.ts               # 项目配置与开关（.pi/Coworkflow.json）
├── core/agentdir.ts             # Pi 的 agent 目录与其中几个已知路径（唯一一处推导）
├── core/pi-subagents.ts         # 公开回执/完成与引用产物的解码
├── core/subagents-client.ts     # RPC v1、能力/状态/cost 解码与共享准入
├── core/subagents-workflow.ts   # 原生工作流注册、验收与任务身份链接
├── core/trellis.ts              # Trellis 布局、上下文注入原语、会话开关标记
├── core/usage.ts                # 公开 native cost 缓存 + Pi/sessionFile 每日历史
├── core/capacity.ts             # async 执行/管理分类（公开准入由 client 拥有）
├── core/trust.ts                # 项目信任决定（写 Pi 自己的 trust.json）
├── scripts/test.ts              # 契约 fixture 测试（node --test，无第三方依赖）
├── scripts/agent-kinds.test.ts       # kind 注册与按 kind 的门禁
├── scripts/agent-kinds-surface.test.ts  # 面板 / 状态 / 角色映射 / lane 分组 / 工作流跟随
└── modules/
    ├── index.ts                 # 注册表：顺序 = 安装顺序
    ├── trellis/index.ts
    ├── worktree/index.ts + assets/auto_worktree.py
    ├── agents/index.ts + assets/{main-AGENTS.region.md,subagent-AGENTS.md}
    ├── subagents/index.ts
    ├── subagent-context/index.ts
    ├── agent-kinds/
    │   ├── index.ts             # 注册 + 按 kind 的 tool_call 门禁 + 状态行
    │   ├── registration.ts      # pi-subagents 运行时 agent 契约（加载/注册/dispose）
    │   ├── defaults.ts          # 内置 kind 表（含 kind → Trellis 角色）与资产加载
    │   └── assets/{executor,auditor}.md   # 每个 kind 的系统提示
    ├── lane-worktree/index.ts
    ├── capacity/index.ts
    └── panel/
        ├── index.ts             # 模块定义：哪个命令何时注册
        ├── shared.ts            # 类型与纯函数（行构造、思考等级）
        ├── settings.ts          # /Coworkflow:settings
        └── models.ts            # /Comodels
```

`modules/panel` 从 `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` 导入——Pi 的加载器
为所有扩展别名主机包（`getAliases()`），所以这是受支持路径，不依赖同级安装。

`node_modules/@earendil-works/*` 是**仅供本地跑 `scripts/verify.ts` 的软链**（已 gitignore），Pi 内运行不需要。

模块只依赖 `core/`，互不引用；资产放在模块自己目录下（`moduleAsset(import.meta.url, …)`），
所以移动或删除一个模块不用改别处。

### 加一个模块

1. `modules/<id>/index.ts` 导出 `WorkflowModule`：`id`、`title`、可选的 `apply(ctx)`（安装）、
   `remove(ctx)`（关闭时收回）、`activate(host, runtime)`（运行时）、`onSessionActivate(host, runtime)`
   （只在会话已加载时注册的功能命令）、`onRuntimeChange(host, runtime)`（会话开关或项目模块开关
   变动时重新对齐自己持有的会话级资源，如 pi-subagents 按 session 注册的工作流资源）、
   `runtimeStatus(host)`（`/Coworkflow:status` 里的一行状态，存下来按需读，不主动发消息）、
   `onSessionEnd(host, runtime)`（会话结束时收回）、`alwaysActive: true`（控制面，工作流关闭时也用）。
   钩子的 gate 分两级：作用于模型行为的按 `runtime.enabled` 在调用时 gate；只记录事实的（lane 账目）
   按"项目已采纳" gate——未加载会话派的单同样产出 artifact，漏记只会让记录少报；
   如果新模块**会拒绝工作**（拦派单、限并发、否掉计划），声明 `newSwitchDefault: "off"`：它在没选过它的
   既有项目里默认关闭，不会因为一次升级就开始管人。只观察/记录/加能力的模块不用声明（默认 `"on"`）；
2. 需要模板就放 `modules/<id>/assets/`，用 `moduleAsset` 读；
3. 在 `modules/index.ts` 的 `MODULES` 里加一行。

## 两个环境前提

### 项目信任（Pi 的安全边界，不是本包的限制）

Pi 把 `.pi/settings.json`、`.pi/mcp.json`、`.pi/extensions`、`.pi/agents`、`.pi/prompts`、`.pi/skills`、`.pi/SYSTEM.md` 和项目 `.agents/skills` 都当作**受信任资源**：没有信任决定就不加载。所以在一个未受信任的项目里，文件明明在磁盘上，但

- `.pi/agents/trellis-*.md` 发现不了 → 派 `trellis-implement` / `trellis-check` 会报 unknown agent；
- `.pi/extensions/trellis/` 不加载 → 主会话的 Trellis 注入、提示词、workflow 状态都不在；
- `.pi/settings.json` 不加载 → 本项目 `subagents.*`（含 `projectRootResolution`）不生效。

**`/Coworkflow:init` 会替你给信任。** 这是本包唯一会写用户级文件的地方（`~/.pi/agent/trust.json`，路径遵循 Pi 自己的 `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`）。在一个项目里跑 init 本身就是"我要在这个项目用这套工作流"的明确动作，所以 init 把该项目的信任决定写进 Pi 自己的信任库（与 `/trust` 完全同形：realpath 规范化后的绝对路径 → 布尔值，按最近父目录生效）。报告会写清楚写到了哪：

```
+ 项目信任：已把 /path/to/project 记入 ~/.pi/agent/trust.json；本会话启动时已按未受信任加载，
  下次在本项目开 Pi 才生效（或本次用 `pi -a`）
```

- **只影响这一个项目**（写的是项目根，子目录/其 worktree 继承），不动你已有的信任决定，`--no-trust` 可跳过。
- **从面板点「重新初始化」也会写**（它跑的就是 `/Coworkflow:init`）；不想让它写就别从面板初始化，或先 `--no-trust`。
- **不做"按文件标记自动信任"**：Pi 允许扩展在 `project_trust` 事件里直接回答 yes，但那等于"仓库里放一个 `.pi/Coworkflow.json` 就自动获得信任，然后它的 `.pi/extensions/*.ts` 就能执行"——那正是信任门控要防的事。所以信任只由"你在项目里跑了一次 init"产生，不由文件存在产生。
- **时序**：信任在 Pi 启动时解析，所以刚 init 完的那个会话仍按未受信任运行，**下一次在本项目开 Pi 生效**；想当次就生效用 `pi -a`。
- 其他给信任的方式仍然可用：TUI 首次打开时批准一次、`pi -a`（`-na` 强制忽略）、`~/.pi/agent/settings.json` 的 `defaultProjectTrust: "always"`。

`/Coworkflow:init`、`/Coworkflow:status` 与设置面板的「状态」段都会报告当前信任状态；未受信任时直接说明哪些产物不会生效以及怎么处理。

实测（真会话 A/B）：把项目写进信任库后，会话系统提示里出现 Trellis 的 `workflow-state` 面包屑；移除该条目后再开一个会话，面包屑消失——即"信任决定 → 项目扩展真的加载"这条链是通的。

`AGENTS.md` / `CLAUDE.md` 这类上下文文件不受信任门控，所以受管区文本无论如何都会读到。

### 交互面板需要 TUI 会话

`/Comodels` 与 `/Coworkflow:settings` 用 `ctx.ui.custom()` 渲染组件，只有交互式 TUI 会话才有这个 UI。在 `pi -p`（print）、`--mode json`、RPC 里运行它们会得到一条「需要交互式 TUI 会话」的提示（同时打到 stderr），不会静默失败。其余命令（init / start / status / lanes）、子 agent 注入、并发拦截在无 UI 模式下照常工作。

## 校验

```bash
npm run typecheck                                                     # tsc --noEmit
npm test                                                              # 契约 fixture 测试（node --test）
node scripts/verify.ts <项目目录> Coworkflow:init                       # 安装层（真实写文件）
node scripts/verify.ts <项目目录> Coworkflow:status                      # 体检（不改文件）
node scripts/verify.ts <项目目录> Coworkflow:init --disable agents   # 模块开关 + 收回
node scripts/verify.ts <项目目录> Coworkflow:init --auto-enable on      # 新会话自动跑
node scripts/verify.ts <项目目录> Coworkflow:start                           # 本会话开关（写会话标记）
node scripts/verify.ts <项目目录> commands                             # 已注册命令
node scripts/verify.ts <项目目录> panel                                # 面板渲染 + 按键行为（headless）
PI_VERIFY_SESSION_DIR=<sessionDir> node scripts/verify.ts <项目目录> panel   # 带真实用量的面板渲染
node scripts/drive-tui.py <项目目录> /tmp/out.txt "/Comodels" 20 DOWN ENTER   # 真 TUI 里驱动面板并抓屏
PI_DRIVE_ARGS=-c node scripts/drive-tui.py …                          # 续接最近会话（有真实用量）
node scripts/verify.ts <项目目录> config                               # 打印项目配置
PI_VERIFY_SESSION_NAME="subagent-trellis-implement: x" \
  node scripts/verify.ts <项目目录> child-inject "Active task: .trellis/tasks/<任务>"   # 子会话注入
node scripts/verify.ts <项目目录> lane-record <handoff.json>           # 记一条 lane
node scripts/verify.ts <项目目录> Coworkflow:lanes                       # 渲染 lane 与合并计划
```

`npm test` 覆盖的正是"镜像了别人格式"的那几处，它们失效时不会报错、只会静默给错答案：
派单记录里 run id 与失败通知的 child id 对得上（`core/ledger.ts`）、`trellis update` 重排
`config.yaml` 之后 `after_start` 仍能被移除（`modules/worktree`）、失败的模块不会被记成已安装
（`extensions/coworkflow.ts`）、用户级路径跟随 `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`
（`core/agentdir.ts`）、子会话注入在重复运行/通用 agent/模块开关/会话替换下都正确
（`modules/subagent-context` + `core/trellis.ts`）。

## 卸载

```bash
pi remove /Users/lyston/PycharmProjects/pi-Coworkflow
```

只移除命令，项目里已写下的文件保持原样。要连项目侧产物一起清：先
`/Coworkflow:init --disable <全部模块>`（会收回受管区与钩子注册），再删 `.pi/Coworkflow.json`；
Trellis 部分按 Trellis 自己的方式卸载。
