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
    "agents-md": true,
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
- `modules.<id>` 是逐模块开关：**显式 `false` 才是关闭**；键缺失表示“该模块是在这份配置写出之后新增的”，默认开启（每次运行都会把整张开关表写全）。运行时模块在**会话启动时**读取开关；改开关后重开会话生效。
- 一切都是项目级的：不写用户的全局设置（`~/.pi/agent/*`）。`pi-subagents` 若已安装则直接复用，
  只在缺失时才声明到项目的 `.pi/settings.json`。

## 命令

| 命令 | 作用 |
|---|---|
| `/Coworkflow:init` | **初始化/刷新本项目**（首次运行 = 一键装上全部模块）；未初始化前其他功能都不存在 |
| `/Coworkflow:start` | **在本会话加载 Coworkflow**（子 agent 的 Trellis 注入、`/Coworkflow:lanes`、`/Comodels`）；`off` 卸载本会话，`status` 看状态 |
| `/Coworkflow:settings` | 设置面板：模块开关、新会话是否自动加载、worktree 前缀、Trellis 范式对齐；未初始化时可直接从面板初始化 |
| `/Coworkflow:status` | 查看初始化状态、模块开关、自动加载、安装产物与本会话是否已加载（等价 `--dry-run`，不改文件） |
| `/Comodels` | 模型面板（需先 /Coworkflow:start）：主会话 / 子 agent 两个 tab，三列 = 模型 \| 思考等级 \| 用量 |
| `/Coworkflow:lanes` | 当前 Trellis 任务的 lane（worktree 隔离派单）状态、patch 路径与合并计划（需先 /Coworkflow:start） |
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

## 模块

| id | 类型 | 负责 | 产物 / 行为 | 关闭时 |
|---|---|---|---|---|
| `trellis` | 安装 | 改版 Trellis 本体 | 无 `.trellis/` 时 `trellis init --pi -y`；已有项目**只报告不重写**（tasks/spec/workspace/.runtime 记录保留），范式对齐走 `trellis update` 或 `--trellis-update` | 只报告，不删（Trellis 资产归 CLI 管） |
| `worktree` | 安装 | 任务隔离的**机制** | `.trellis/scripts/hooks/auto_worktree.py` + `.trellis/config.yaml` 的 `hooks.after_start` | 移除 `after_start` 注册（脚本保留） |
| `agents-md` | 安装 | 任务隔离与派单的**策略** | `AGENTS.md` 受管区 | 移除受管区（其余内容不动） |
| `subagents` | 安装 | 复用已装的 `pi-subagents`，缺失时项目级安装 | 检测用户级/项目级/npm 目录；必要时写项目 `.pi/settings.json` 的 `packages`；写 `subagents.projectRootResolution: "git-root"` | 移除 `projectRootResolution`（packages 保留） |
| `subagent-context` | 运行时 | 子会话按角色注入 Trellis 上下文 | 在**子会话**里读角色 + 任务，注入 `implement.jsonl`/`check.jsonl`/spec 树 + prd/design/implement | 不注册钩子 = 不注入 |
| `lane-worktree` | 运行时 | lane 账目与合并计划 | 在**主会话**里记录 lane 指针到 `.trellis/.runtime/lanes/`，提供 `/Coworkflow:lanes` | 不注册钩子 = 不记账 |
| `capacity` | 运行时 | 项目级子 agent 并发上限 | 在**主会话**里拦截超出本项目上限的派单（`tool_call` gate）；不写 pi-subagents 的配置文件 | 不注册钩子 = 不拦截 |
| `panel` | 常驻 | 模型面板 | `/Comodels`：主会话（本会话）/ 子 agent（本项目）两个 tab，模型 + 思考等级 + token 用量；不写全局 | 关掉即无面板 |

`panel` 是控制面（`alwaysActive`）：工作流关闭时也能用。

`trellis` 模块**不自带** Trellis 资产：那些文件由 Trellis CLI 拥有、在 `.trellis/.template-hashes.json`
里做三路合并，本模块只调 `trellis init --pi -y`。这样 `trellis update` 仍是同步 Trellis 的唯一入口，
不会出现两份内容互相打架。其余模块只放上游没有的那一层。

### 已有 Trellis 记录的项目

项目之前用过（原版或旧版）Trellis 时：

- `tasks/` `spec/` `workspace/` `.developer/` `.runtime/` 是项目历史，本包**从不重写**；`trellis update` 也把它们列为 “User data (preserved)”。
- 范式（Pi 扩展、`.pi/prompts/`、`.pi/agents/`、`.trellis/workflow.md` 等）由 `trellis update` 对齐到本仓版本；`/Coworkflow:init --trellis-update` 会先跑 `--dry-run` 报告差异，再跑 `update -s`（升级未被本地改动的文件、保留本地改动）。
- 本包写过的 `.trellis/config.yaml`（`after_start` 注册）与 `.pi/settings.json`（`subagents.*`）算“本地改动”，会被 `-s` 保留；即使被覆盖，后面的模块也会重新写回（顺序：trellis → worktree → agents-md → subagents）。
- `AGENTS.md` 已有手写等价章节时，`agents-md` 模块不追加受管区、只提示迁移——两份规则不会同时存在。

## 会话内面板

### `/Coworkflow:settings`

项目设置都在这里改（Enter 执行）：

```
── 模块              trellis / worktree / agents-md / subagents / subagent-context / lane-worktree / panel 逐个 on·off
── 会话              新会话自动加载 on·off · worktree 前缀（Enter 弹出输入框）
── 子 agent 并发     同时活跃的 async run 上限（留空 = 不限） · 单次 parallel 并发度（留空 = 默认）
── 维护              重新初始化（= /Coworkflow:init） · Trellis 范式对齐（= trellis update -s）
── 状态              配置路径 · 初始化时间 · 本会话是否已加载
```

开关改动走与命令完全相同的代码路径（持久化 + 应用/收回产物），所以从面板关掉 `agents-md` 会真的把 `AGENTS.md` 受管区收回。未初始化的项目打开它会先问"初始化本项目？"，确认后直接跑完整初始化。

**并发上限是项目级**，由本包自己执行——这是必要的兼容层：pi-subagents 的容量键（`maxActiveAsyncRunsPerSession`、`maxSubagentSpawnsPerSession`、`globalConcurrencyLimit`、`parallel.*`）只存在于它自己的用户级配置文件 `~/.pi/agent/extensions/subagent/config.json`，**没有项目级覆盖**；写进 `.pi/settings.json` 会被静默忽略（实测：工具仍报 `0/unlimited`）。

所以本项目上限存在 `.pi/Coworkflow.json` 的 `subagentConcurrency` 里，由 `capacity` 模块在 `tool_call` 上执行：

| 面板项 | 存哪 | 含义 |
|---|---|---|
| 本项目并发上限 | `.pi/Coworkflow.json` → `subagentConcurrency`（留空 = 不限） | 同一会话同时活跃的**顶层 async run** 数，与 pi-subagents 自己的口径一致；达到上限时新派单被拦下，理由里带上正在跑的 run 与下一步建议 |

执行细节（都在 `core/capacity.ts`）：

- 计数来源是 pi-subagents 自己写的运行目录（`<tmp>/pi-subagents-<scope>/async-subagent-runs/*/status.json`），按 `sessionId`（= 父会话文件）归属，终态集合与 pi-subagents 的 `TERMINAL_STATES` 一致；**进程已死但状态非终态**也释放，避免崩溃的 runner 永久占位。
- 只拦「会新建 run」的调用：管理动作（`status`、`lane.*`、`worktree.*`、`mission.*`、`doctor`…）永远放行，否则满额时连"现在在跑什么"都问不了；前台调用（`async: false`）不占异步槽，也不拦。
- **不改用户的 pi-subagents 配置文件**，所以没有需要还原的文件、没有两个项目的会话互相覆盖、Pi 崩溃也不会留下脏数据。没初始化 Coworkflow 的项目完全不受影响，照旧用 pi-subagents 自己的（用户级）配置。
- 面板「状态」段同时显示 pi-subagents 自身上限与当前活跃 run 数，两个数字并排可见。
- **同一轮并行派单也拦得住**：`tool_call` 通过后立刻在进程内占一个位（`CapacityTracker`），到该调用的 `tool_result` 释放；占位若已能被磁盘上的 run 对应上（按 `startedAt` 配对）就不再重复计数，所以既堵住了「第一个 run 还没落盘」的窗口，也不会把同一个 run 数两次。占位按 tool call id 记录并带 5 分钟 TTL，被拦下或失败的调用不会永久占位。

### `/Comodels`

面板是 **tab + 三列表格**，宽度自适应（宽终端一屏看全，窄终端自动换行）：

```
pi-Coworkflow · 模型面板
[主会话]  子 agent                      ← ←→ 切换 tab
作用范围：本会话（不写任何配置文件）
当前：模型 clinepass/deepseek-v4.1-flash · 思考 medium

── 模型                      ── 思考等级        ── 用量
→ deepseek-v4.1-flash [clinepass] ✓   ○ off      主会话  in 34.0k · out 2.8k · cache 29.0k · $0.0134 · 3 turns
  glm-5.3-flash [clinepass]           ○ minimal    deepseek-v4.1-flash  in 30.0k · out 2.5k · cache 29.0k
  gpt-5.6-sol [openai-codex]          ○ low        glm-5.3-flash  in 4.0k · out 300 · $0.0009
                                      ● medium     子 agent  本会话无派单
                                      ○ high
```

- **三列分工**：左列选模型（`↑↓` + 直接打字即过滤，`✓` 是当前生效项，`→` 是光标），中列选思考等级（只列当前生效模型**真正支持**的档位），右列是 token 用量表（只读）。
- **键位**：`↑↓` 在当前列内移动 · `Tab` 在 模型/思考 两列之间切光标 · `←→` 切换 `主会话`/`子 agent` tab · `Enter` 应用 · `Esc` 关闭 · 直接打字即搜索（只在模型列生效）。`←→` 在面板里先于搜索框处理——否则 `Input` 会把左右键当成光标移动吃掉，tab 就永远切不过去。
- **两个 tab 的作用域**：`主会话` = 本会话（`pi.setModel` / `pi.setThinkingLevel`，不写任何配置文件）；`子 agent` = 本项目（`.pi/settings.json` 的 `subagents.defaultModel` / `defaultProvider` / `defaultThinking`，pi-subagents 的项目设置优先于用户设置，从不写全局）。子 agent 那一页第一项是 `(默认 / 继承主会话模型)`、思考第一项是 `(默认 / 继承主会话思考)`，选中即删键回到继承。
- **用量列跟着 tab 走**：`主会话` tab 先显示本会话按模型拆分的消耗，`子 agent` tab 先显示本会话派单的按 agent 拆分消耗，另一半与「本项目累计」跟在后面。
- **需要 `/Coworkflow:start`**：未加载的会话里 `/Comodels` 仍然注册着（这样 Pi 的斜杠命令模糊补全不会把它带到原生 `/model`），但会明确拒绝并提示先 start。

## 面板里的用量统计

面板顶部常驻一块用量，按「谁花的」拆开，数据全部来自 Pi 与 pi-subagents **已经写到磁盘的记录**（不是估算，也没有自己的账本）：

| 行 | 来源 | 口径 |
|---|---|---|
| 主会话 | Pi 的会话条目（`sessionManager.getEntries()`）：assistant 消息的 `{provider, model, usage}`，以及 `usage`（cache_warm）、compaction、branch summary 条目 | **本会话**，按模型分行（切换过模型就能看出各模型各花多少） |
| 子 agent | pi-subagents 的运行元数据 `<sessionDir>/subagent-artifacts/<runId>_<agent>_meta.json`（`artifacts: "session"` 默认位置）与 `<cwd>/.pi/subagents/artifacts/`（project 模式） | **本会话派单**（按 `parentSessionId` 过滤），按 agent + 模型分行 |
| 本项目累计 | 同上目录下的全部 meta | 该项目所有会话的派单汇总（包括其他会话派出去的），仅在本会话派单之外还有记录时显示 |

显示 `in / out / cache / $ / turns`，金额只在记录里有非零 cost 时出现（例如 clinepass 没配价格就不显示 `$`）。这与 pi-subagents 自己的 `/subagent-cost`（它返回 `parent` + `children` + `childTotal`）是同一套账，只是从已记录的 artifact 读、并按本项目的作用域拆分展示。

## 运行时模块怎么工作

### `subagent-context`：子会话只拿到它要执行的那部分

派单时**不**让子会话继承主会话上下文（显式 `context: "fresh"`；三个 Trellis 角色 agent 也已声明
`defaultContext: fresh`）。子会话要的 Trellis 上下文由这个模块注入：

| 事实 | 来源（按优先级） |
|---|---|
| 角色 | 子会话名（pi-subagents 写作 `subagent-trellis-check-<runId>-<n>`，或 `<agent>: <task excerpt>`）→ `trellis-implement` / `trellis-check` / `trellis-research`；其次 `<!-- trellis-agent: <role> -->` 标记 |
| 任务 | 派单提示词里的 `Active task: <任务目录>`（pi-subagents 会把它包成 `Task: Active task: …`）→ 会话名里的任务路径 → 父会话的 Trellis 会话指针 |

注入内容与字节预算沿用上游 Trellis 子 agent 钩子的语义（每文件 32K、每工件 64K、总计 128K，读
`.trellis/config.yaml` 的 `context_injection` 可覆盖；`0` 关闭）：

| 角色 | 注入 |
|---|---|
| `implement` | `implement.jsonl` 列出的 spec/research 正文 + `prd.md` + `design.md` + `implement.md` |
| `check` | `check.jsonl` + `prd.md` + `design.md` + `implement.md` |
| `research` | `.trellis/spec/` 目录树 + 搜索提示（不需要任务） |

所有文件都从**主检出**读（worktree 里只有已提交内容），每个 (角色, 任务) 只注入一次，且只在子会话里生效——
主会话的 Trellis 扩展自己负责它那份，本模块不重复。

注意：三个角色 agent 来自 `.pi/agents/trellis-*.md`，由 pi-subagents 从项目发现，**需要项目被信任**；
以 `pi -na`（`--no-approve`）启动时会忽略项目本地资源，派单会报 `Unknown agent: trellis-check`。

### `lane-worktree`：把 lane 绑到任务上

并行 lane 本身是 pi-subagents 的职责，它已经做了托管 worktree、每个 lane 的 patch、以及
parallel handoff manifest（`lane.status` / `lane.recordMerge` / `worktree.cleanup`）。本模块**不重造**这些，
只补 Trellis 这一侧缺的账：

1. 主会话每次派单带 worktree 隔离时，从结果里的 `Parallel handoff: <path>`（或 `details.handoffPath`）
   取出 manifest 路径，记一条指针到 `.trellis/.runtime/lanes/<任务>/<runId>.json`。
   放在 `.runtime/` 下是因为它已被 gitignore：lane 指针是机器状态，不该提交。
2. `/Coworkflow:lanes` 读这些指针 + 每个 manifest，打印 lane 的 agent/status/worktree/branch/patch、
   证据状态（`terminal-eligible` / `terminal-blocked` …）以及合并计划。

它**不合并、不 apply patch、不删 worktree**：合并由主会话审计后执行，破坏性清理仍走 pi-subagents 自己的授权策略。

## 失败处理

**lane 失败会自动重派一次。** pi-subagents 把子 agent 的失败当成一条 `custom_message`（`subagent-incremental-child-notify`，`details.outcome: "failed"`）报给主会话，恢复留给模型——而一个跑到 112 条消息才断的 lane（实测 `Stream error occurred`）很可能要等到模型下次被唤醒才被注意到。`capacity` 模块因此在 `message_start`/`message_end` 上监听这条通知，用**同样的 agent 与 task、`context: "fresh"`** 自动重派一次；第二次再失败就原样报告，由模型或你决定。重派同样走项目并发上限，不会越限。

- 派单时记录的 `agent`/`task` 是重派依据，所以在**任何**项目里都会记（包括没设并发上限的项目）。
- 拿不到 agent/task 时不会猜：只报失败并给出 `subagent({ action: "status", id })` 的查看方式。
- 每个 child 只重派一次（按 child run id 去重），不会形成重试风暴。

## lane 记账的边界

lane 指针写在 `.trellis/.runtime/lanes/<任务>/<runId>.json`，只要求**项目已初始化**，不要求本会话跑过 `/Coworkflow:start`——未加载状态下派的单同样产出 artifact，漏记会让 `/Coworkflow:lanes` 少报。项目没初始化（没有 `.pi/Coworkflow.json`）时一律不写。

## 目录结构

```text
pi-Coworkflow/
├── package.json                 # pi.extensions → 单入口
├── extensions/coworkflow.ts       # 编排：开关 → 跑模块 → 渲染报告 → 激活运行时钩子
├── core/module.ts               # 模块契约（WorkflowModule / ModuleContext / PiRuntimeHost / RuntimeContext）
├── core/config.ts               # 项目配置与开关（.pi/Coworkflow.json）
├── core/trellis.ts              # Trellis 布局、上下文注入原语、会话开关标记
├── core/usage.ts                # token/成本统计（Pi 会话条目 + pi-subagents 运行元数据）
├── core/capacity.ts             # pi-subagents 活跃 async run 的观测（并发上限用）
└── modules/
    ├── index.ts                 # 注册表：顺序 = 安装顺序
    ├── trellis/index.ts
    ├── worktree/index.ts + assets/auto_worktree.py
    ├── agents-md/index.ts + assets/region.md
    ├── subagents/index.ts
    ├── subagent-context/index.ts
    ├── lane-worktree/index.ts
    ├── capacity/index.ts
    └── panel/index.ts
```

`modules/panel` 从 `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` 导入——Pi 的加载器
为所有扩展别名主机包（`getAliases()`），所以这是受支持路径，不依赖同级安装。

`node_modules/@earendil-works/*` 是**仅供本地跑 `scripts/verify.ts` 的软链**（已 gitignore），Pi 内运行不需要。

模块只依赖 `core/`，互不引用；资产放在模块自己目录下（`moduleAsset(import.meta.url, …)`），
所以移动或删除一个模块不用改别处。

### 加一个模块

1. `modules/<id>/index.ts` 导出 `WorkflowModule`：`id`、`title`、可选的 `apply(ctx)`（安装）、
   `remove(ctx)`（关闭时收回）、`activate(host, runtime)`（运行时；钩子要按 `runtime.enabled` 在调用时 gate）、
   `alwaysActive: true`（控制面，工作流关闭时也用）；
2. 需要模板就放 `modules/<id>/assets/`，用 `moduleAsset` 读；
3. 在 `modules/index.ts` 的 `MODULES` 里加一行。

## 两个环境前提

### 项目信任（Pi 的安全边界，不是本包的限制）

Pi 把 `.pi/settings.json`、`.pi/mcp.json`、`.pi/extensions`、`.pi/agents`、`.pi/prompts`、`.pi/skills`、`.pi/SYSTEM.md` 和项目 `.agents/skills` 都当作**受信任资源**：没有信任决定就不加载。所以在一个未受信任的项目里，文件明明在磁盘上，但

- `.pi/agents/trellis-*.md` 发现不了 → 派 `trellis-implement` / `trellis-check` 会报 unknown agent；
- `.pi/extensions/trellis/` 不加载 → 主会话的 Trellis 注入、提示词、workflow 状态都不在；
- `.pi/settings.json` 不加载 → 本项目 `subagents.*`（含 `projectRootResolution`）不生效。

**`/Coworkflow:init` 会替你给信任。** 在一个项目里跑 init 本身就是"我要在这个项目用这套工作流"的明确动作，所以 init 把该项目的信任决定写进 Pi 自己的信任库 `~/.pi/agent/trust.json`（与 `/trust` 完全同形：realpath 规范化后的绝对路径 → 布尔值，按最近父目录生效）。报告会写清楚写到了哪：

```
+ 项目信任：已把 /path/to/project 记入 ~/.pi/agent/trust.json；本会话启动时已按未受信任加载，
  下次在本项目开 Pi 才生效（或本次用 `pi -a`）
```

- **只影响这一个项目**（写的是项目根，子目录/其 worktree 继承），不动你已有的信任决定，`--no-trust` 可跳过。
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
node scripts/verify.ts <项目目录> Coworkflow:init                       # 安装层（真实写文件）
node scripts/verify.ts <项目目录> Coworkflow:status                      # 体检（不改文件）
node scripts/verify.ts <项目目录> Coworkflow:init --disable agents-md   # 模块开关 + 收回
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

## 卸载

```bash
pi remove /Users/lyston/PycharmProjects/pi-Coworkflow
```

只移除命令，项目里已写下的文件保持原样。要连项目侧产物一起清：先
`/Coworkflow:init --disable <全部模块>`（会收回受管区与钩子注册），再删 `.pi/Coworkflow.json`；
Trellis 部分按 Trellis 自己的方式卸载。
