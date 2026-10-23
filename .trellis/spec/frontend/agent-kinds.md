# 类型化子 agent（kind）设计

本文档记录本项目的**设计意图与取舍**，不是实现说明书。实现分布见文末「落点」；两者冲突时以实现为准，并回来修本文档。

## 问题

派单原本是一个扁平动作：主会话对每个子 agent 单独写提示词、单独决定派谁，项目层唯一的控制是全局限一个并发数。于是「这个项目用哪几类子 agent、每类能同时跑几个、哪类现在不参与」这些信息只存在于散文里，模型可能遵守也可能不遵守，而且没有任何东西执行它。

## 设计

### 类型是注册 + 门禁，不是新的执行路径

一个 kind = 一份 agent 定义 + 两条项目策略（是否启用、同时上限）。

- 注册后，`cw-executor` 这类名字**真的出现在主会话的 agent 列表里**，派单就是普通的一次 `subagent({ agent: "cw-executor" })`。
- 本包不因此获得调度权：不 spawn、不排队、不重试、不维护每类的运行账本。
- 类型数量、进程、超时、产物仍归 pi-subagents。

### 一类一种角色；role 只声明在定义文件里

`role` 不是第二套身份，是「这个 kind 的子会话注入哪一档上下文」的键（`implement` / `check` / `research` / `none`）。它只有一份真相：kind 定义文件的 frontmatter。会话名不参与判定——`trellis-check` 这类名字不再获得 check 上下文。

| kind | agent | Trellis 角色 | 默认 | 默认上限 |
|---|---|---|---|---|
| 执行者 | `cw-executor` | implement | 开 | 5 |
| 审计者 | `cw-auditor` | check | 开 | 5 |
| 调研者 | `cw-researcher` | research | 开 | 5 |

**这是「覆盖」而非「并列」**：kind 与 Trellis 角色一一对应，`cw-*` 走的是同一份角色上下文注入（prd、design、implement、对应 jsonl 或 spec 树），但额外经过本项目的开关与数量上限。`trellis-implement` / `trellis-check` / `trellis-research` 在采用本模块后**不再是本项目推荐的派单目标**——它们绕开这两道闸。

默认值是**项目改的起点，不是本包设的上限**：三种 kind 都默认开、都从 5 起，具体数字由 `/Coworkflow:settings` 决定。按 kind 定死不同的小数字（执行者 3、审计者 1）等于替主会话做了拆分决定——它读到的是「只准有一个审计者」，而没有任何人做过这个决定。上限的作用是「别一次铺开太多」，不是分配权限。

`.pi/agents/trellis-*.md` 不再由本包模板产出（老项目里残留的由迁移步骤清掉，见「不做的事」），`trellis-*` 只是不再作为本项目的推荐派单目标。

### 每个 kind 自己的模型与思考等级

三种 kind 通常不该跑同一个模型：执行者做机械的活，适合便宜的；审计者做复核，适合强的。一个继承来的默认模型无法表达这件事，所以每个 kind 可以在 `.pi/Coworkflow.json` 里单独声明：

```jsonc
"agentKinds": {
  "executor":   { "model": "anthropic/claude-haiku-4",  "thinking": "low" },
  "auditor":    { "model": "anthropic/claude-opus-4",   "thinking": "high" }
}
```

**写在定义里，不写在派单参数里。** 我们的 kind 是*运行时注册*的，定义就是权威位置：上游在注册时校验 `model`/`thinking`，定义生效于该 kind 的**每一次**派单，包括手写的 `subagent({ agent: "cw-executor" })`；派单级参数只覆盖本包自己发起的那些。同理也不用上游的 `subagents.agentOverrides`：那是给发现式 agent 的，我们的 kind 由本包注册，配置面应当只有一个。

优先级（高到低）：**kind 自己的 `model` → `subagents.defaultModel` → Pi 默认**。字段缺省就是继承，这就是「没有自己的模型」的表达方式；`thinking` 与 `model` 独立，可以固定模型而继承等级。

两条验证规则，方向相反且都必要：

| 时机 | 行为 | 理由 |
|---|---|---|
| 写入时（面板） | 形状不合法或**注册表里查不到**都**拒绝并说明原因**，不落盘 | 面板手里就有注册表；写进去只会在该 kind 派单时炸 |
| 写入时（`setAgentKind`） | **拒绝并说明原因**，不落盘 | 解码器会丢弃非法值，写进去等于一条下次读就消失的设置 |
| 读取时（`parseAgentKinds`） | **丢弃，不转发** | 上游在注册时拒绝不可用的 model，那会让整个 kind 连派单都不可用；丢弃只是回到继承 |

两层的分工要说清楚：`setAgentKind` 只管**形状**（它是一个纯配置写入器，手里没有模型注册表），
所以“形状对但 id 不存在”的校验落在**面板**这一层。两层都拒绝时配置都不动。
读取时那一层只管形状：解码发生在没有注册表的地方（门禁、状态行、子会话），
它不能、也不应当判断某个 id 今天是否在注册表里。

`model` 接受 `provider/id`、裸 id，或任一形式后跟 `:level`（上游语义）。可以包含控制字符或过长（> 200 字符）的值一律视为不可用——那是粘贴事故，不是模型 id。

**模型必须进定义签名。** 注册器按每个 kind 定义的 `signature()` 判断「变没变」，相同的定义保留活注册。若 `model`/`thinking` 不在签名里，改模型会被判成 unchanged，会话继续用旧模型——「面板写了一个会话不用的设置」正是本模块要消灭的那种失败。

### 面板页跟随 kind 表，不写死

`/Comodels` 不再是固定的「主会话 / 子 agent」两页：

```
主会话              会话模型 + 思考等级，经 pi.setModel 只作用于本会话
子 agent（默认）     subagents.defaultModel / defaultProvider / defaultThinking
执行者 cw-executor   agentKinds.executor.model / .thinking
审计者 cw-auditor    …
```

- 页面列表**就是** `control.agentKinds()` 的返回值（`snapshot.kinds`），面板里**没有**任何 kind 列表。因此它跟随的是本包**发布**的 kind 表：发布一个新 kind，它的页面自动出现，面板一行都不用改。硬编码的 kind 列表在这里等于「发布了一个 kind，面板看不见它」。
- 「加一个 kind 多一页、删一个少一页」只在**发布物**这个意义上成立，这是有意的：一个 kind 需要本包提供系统提示资产与 Trellis 角色映射，所以它不是用户自由定义的配置键。项目在 `agentKinds` 里声明了一个本包没有的 kind 会**保留**在配置里（那是项目写下的决定），但**没有页面**——背后没有 agent 可注册；`/Coworkflow:status` 把它作为「已声明、本包未发布」报出来。
- 关掉的 kind **保留页面**并标注「已关闭」：它的模型仍然存着，打开那一刻就生效。`agent-kinds` 模块关掉时页面也保留，但标注「本会话未启用」——那时没有注册任何 kind，写入只改配置。
- 思考等级跟随该页的**有效模型**：固定了模型的 kind 列该模型的等级，继承的列它继承到的模型的等级——默认页本来就是这个规则，只是现在按 kind 逐页应用。
- 选中「继承」那一行 = 删掉该键（`setAgentKind(kind, { model: null })`），不是写空串：两者不能对「继承」有两种说法。
- `/Coworkflow:status` 每个 kind 一行：`cw-executor（kind executor）已注册 · 模型 <provider/id> · 思考 <level>` 或 `· 继承默认 · 思考 继承`。面板与状态读同一个解析结果，所以不会互相矛盾。

#### 一页只有一个当前值

这是面板里最容易出数据丢失的地方，规则写死在这里：

| 情形 | 当前值（`✓`） | 光标初始位置 | `Enter` 写回 |
|---|---|---|---|
| kind 没固定模型 | 「继承」那一行 | 继承行 | 删除该键 |
| 固定了模型，注册表里能解析 | 那个模型的行 | 那一行 | 同一个模型 |
| 固定了模型，注册表里**解析不到** | 该 pin 自己单独一行（`…（不在模型注册表）`） | 那一行 | **原样写回同一个字符串** |

两条必须同时成立，否则「不动光标按一下 `Enter`」就会把用户没选过的模型写进 `.pi/Coworkflow.json`：

- 解析不到的 pin **不得**回退成继承到的模型。那是**另一个设置**：拿它当 `effectiveModel` 会把继承模型的行标成当前、光标落到那里，一下 `Enter` 就把 pin 覆盖掉。查不到就是查不到，页面写明「不在当前模型注册表中」，`effectiveModel` 留空。
- 一行不能既因「存的字符串」又因「解析出的模型」被标成当前。存的值为准；`effective` 只在没有存值时才用来标记（默认页的 `subagents.defaultModel` 是裸 id 的情形）。

模型引用（`provider/id`、裸 id、任一形式后跟 `:level`）的解析规则：

- 只有**已知的思考等级**后缀才是等级（上游 `splitKnownThinkingSuffix` 的规则）。`ollama/llama3:latest`、`openrouter/x:free` 的冒号是 id 的一部分，剥掉就解析不到——或者更糟，解析成另一个同名的模型。
- 裸 id 在多个 provider 下都存在是**歧义，不是「取第一个」**（上游的解析器此时返回 `undefined`）：猜一个会展示、并且写回错的 provider 的模型。给定 provider 时优先它，唯一匹配才采纳。
- 面板写入时用注册表校验：形状合法但注册表里没有的 id **拒绝写入并说明**（配置不动），因为写进去只会在该 kind 派单时失败。清除（「继承」行）不受影响。

### 三种约束，强度不同，不能混为一谈

| 想要的 | 机制 | 强度 |
|---|---|---|
| 关掉的类派不了 | `tool_call` 拒绝，理由列出当前可用的 kind | **强制** |
| 某类超上限派不了 | `tool_call` 拒绝，理由给出上限与当前占用 | **强制** |
| 「只能派给开着的类」 | 提示词与面板告知 | 引导，非强制 |

第三条必须说清楚它不是强制：`cw-*` 之外的名字（内置 agent、别的扩展的、`trellis-*`）不受本模块管理，本模块不会替主会话改派任务。把「拒绝」说成「枚举」是过度承诺。

### 占用计数来自上游公开投影

某一类当前跑了几个，来自 pi-subagents 公开 fleet 投影的 `entries[].agent`，不建本地镜像。

- 缺 `fleetStatus` 能力、投影无法解析、有界窗口发生溢出（`omitted` 非零）、回复落在会话换代之后 —— **一律拒绝派单**，不当成 0。
- 理由：一个数不准的上限比没有上限更糟，它会让项目以为被保护着。

### 并行是一等公民，串行是可测量的行为

独立的多件工作用命名工作流 `coworkflow.fanout` 一次并发派出（内部对每个子任务 `Promise.all`），而不是让每次派单的脚本写法决定是否并行。派单参数按 **kind** 指定，`kind → cw-<kind>` 唯一映射，被关闭的 kind 用与 `tool_call` gate 相同的措辞拒绝。

同时记录「这次派单是否与别的派单重叠」，并在 `/Coworkflow:status` 作为**事实**报告：`派单重叠: 3 次并行、5 次串行`。时间戳缺失记为 unknown，**不计入串行**。

判断哪些工作彼此独立仍然是主会话的判断，机制不替它做；机制只负责让并行变便宜、让串行变可见。

### 可以随时打断，但「接受」不等于「结束」

- `stop` / `steer` / `interrupt` 是上游**公开可选**的控制方法：使用前探能力，未通告就明确拒绝，不发出去碰运气。
- `stop` 的成功回复意为**停止请求已被接受**（`state: "stopping"`），**不是** run 已终止。终止须由 `status` 与进程终止证据确认。因此输出必须把「已接受」与「已停止」分成两句，禁止打印「已停止」。
- `/Coworkflow:lanes stop <runId>` 只接受本任务记录过的 runId，不接受任意 id。
- 失败的 stop 不自动重试，也不报告成「可能已死」的超时。

### 运行预算属于项目

一次派单的墙上时间上限写进 `.pi/Coworkflow.json` 的 `subagentRunBudgetMs`（面板里是「子 agent 运行上限」，单位分钟），缺省用内置的 25 分钟。两个工作流把它连同「提前多少时间要求停下交接」一起交给上游，并在子任务正文里写明——启动参数在运行内部看不见。提前量由上限推算（1/6，夹在 15 秒与 4 分钟之间），因为它和上限描述的是同一条策略。

### 决定是否打断所需的可见性

主会话要先看到才决定停不停。可归因、可显示的内容：

- 每个 run 的 `state` / `agent` / `model` / `startedAt` 推算的已运行时长；
- `goal`（**仅**来自我们自己的派单记录，不冒充 runner 上报）；
- 按 run 的 token 走 `cost` 渠道（自带有校验的求和与 `runId` 归属），`unresolvedAsyncChildren > 0` 时聚合是**下界**，显示为 `≥` 并标注「不完整」；
- 按类型计数走 fleet 渠道；
- 每个 run **最近一次动作**（工具名 + 路径/命令短提示，或最后一段助手文本），读自该子会话自己的 session 日志**尾部**。

### 「最近动作」是尾部读，不是实时

曾经写在这里的是「它此刻在读哪个文件、调哪个工具**拿不到**」。半句对、半句不对，现在说准确：

- **拿不到的是跨进程事件流。** `pi.events` 是进程内的，子会话的工具调用不会流回父会话。这一条依然成立，不美化。
- **能拿到的是子会话自己写的日志。** 公开 `cost` 回复给每个可读取的 child 一个 `sessionFile`；父会话本来就在读这些文件（有界、按精确绝对路径、不扫目录）来拼子用量历史。读它的**尾部**就知道它最近在做什么。

所以要守住这条界线，实现与措辞都有约束（落点 `core/child-tail.ts`）：

| 约束 | 理由 |
|---|---|
| 只读尾部（默认 64 KiB，`open` 后按 offset 读） | 一个 run 的日志会长很大，读全量等于把刷新变成 I/O |
| JSONL 逐行容错，半行丢弃 | 子会话还在追写，最后一行随时可能不完整 |
| 提示只从白名单键（路径/命令/模式）取，且截断 | `edit`/`write` 的正文与 `subagent.task` 的整段提示不能进面板 |
| 归属只用 `cost.children[].runId` + `sessionFile` | fleet 的 `key` 不是 run id（见下节），不能用来归属 |
| 只在既有刷新边界读（会话开始、`agent_settled`、原生完成、面板打开） | 没有轮询、没有定时器、渲染不做 I/O |
| 读不到 = 显式未知 + 原因 | 权限、消失、非普通文件、尾部无有效记录，都不是「空闲」 |
| 行尾标注来源：「（读自子会话日志尾部）」 | 它滞后于子会话已 flush 的部分，不是实时叙述 |

这条能力弱于实时，但强于没有：它回答「它刚在做什么」，不回答「它此刻正在做什么」。

### fleet 的 key 不是 run id

fleet 投影的 `key` 是不透明显示键，上游明确禁止当作 run 或 async id。因此 fleet 数据只能**丰富显示**，任何 `fleet.key ↔ runId` 的关联都是错的——那个关联不存在，硬拼会静默错配。

### 不给对话注入消息

任何 `sendMessage` 的自定义消息在 Pi 里都会作为 **user 轮次**进入模型上下文（`display: true` 只影响显示）。所以「用一条消息提醒模型该怎么派单」会改写它正在做的事，代价大于收益。

本设计因此只通过三个渠道传达状态：`/Coworkflow:status` 与 `/Coworkflow:lanes` 的输出、面板、以及工具结果。**没有任何自动注入**。曾经有过按工具调用次数计数的提醒，已删除；这条约束有测试守着（工作流自身从不调用 `sendMessage`）。

## 不做的事

- 不做「自动把任务分给某个类」的调度器——那是判断，不是机制。
- 不改 pi-subagents 的任何文件，不加载第二份运行器。
- 不改写 Trellis 的 CLI 与全局模板；**但本包自带 Trellis 资产模板，本项目工作面只讲 kind**：模板不产出 `.pi/agents/trellis-{implement,check,research}.md`，老项目里残留的由 `retireRoleAgents()` 在迁移时删除，`.trellis/workflow.md` 的 Pi 块在模板里就写成 kind 派单，其它平台块不动。全局 `trellis` CLI 是可选的（只有 `trellis mem` / `trellis channel` 需要，本包不自带），也不用 `trellis update` 对齐——手工跑它会把范式换回上游版本，与本包模板混成两种真相。
- 不自动重试、不自动合并、不自动清理。

## 失败模式与对应要求

| 失败模式 | 要求 |
|---|---|
| 契约不可用却报告已注册 | 不注册、面板与状态说明原因、派单被拒 |
| 名字撞内置 agent 或项目已有 agent | 只有该类失败，其它类不受影响；**不得让整个会话的派单失效** |
| 计数不可读 | 拒绝派单，不当 0 |
| 把别的 agent 当成本包 kind | 直接派单与批次都必须原样放行，且不产生公开读取；批次里只有本包 kind 参与上限判定 |
| 窗口截断（`omitted > 0`） | 按 unknown 处理，不把部分和当总数 |
| stop 被接受 | 只说「已接受」，并做一次状态复核，不用轮询 |
| 开关改了但没生效 | 每次派单从磁盘重读策略；不重启生效 |
| 面板显示与实际不一致 | 面板只复述模块自己的事实，不推断 |
| 一个 kind 的模型改了却没生效 | `model`/`thinking` 属于定义签名，改动即重新注册 |
| 存的模型 id 打错了 | 读取时丢弃（回到继承），写入时拒绝并说明原因；面板额外用模型注册表校验，查不到的 id 拒绝写盘 |

最后一条尤其重要：这个包已经出现过两次「自称在拦、实际没拦」——那是比没有功能更坏的状态。

## kind 端口：项目定义文件

`.pi/Coworkflow/agents/<kind>.md` 是 kind 的**来源**，不是配置的替代品。frontmatter 声明 kind 是什么（label / agent / role / description / model / thinking / maxConcurrent / enabled），正文是它的系统提示词。

两层与优先级：

| 层 | 决定 | 谁赢 |
|---|---|---|
| 定义文件（否则本包随附的资产） | 这个 kind **是什么**：提示词、label、role、agent 名、以及各项默认值 | 低 |
| `.pi/Coworkflow.json` 的 `agentKinds.<kind>`（面板写的） | 项目**选了什么**：enabled / maxConcurrent / model / thinking | **高，永远** |

`resolveKinds(config, definitions)` 是唯一的合成点，`ResolvedAgentKind` 因此带上 `source`（`file` / `shipped`）与 `chosen`（每个策略字段是项目选的还是定义默认的）——报告要能说出「默认」和「选过」的区别，这是模块开关早就确立的规矩。

解析失败一律**按 kind 隔离**：`readKindDefinitions` 返回 `{ definitions, failures }`，坏的进 `failures`（带原因），好的照常注册。目录不存在或读不了 = 「没有定义」，不是错误。未知 frontmatter 键**直接拒绝**：一个静默无效的拼写比报错更坏，因为用户以为配置生效了。

**热更新不是轮询**：gate 本来就要读定义目录来决定策略，于是它顺手比较「应该注册的」与「已注册的」指纹（`planSignature`：提示词哈希、agent 名、模型、思考、描述）。不同就**在决定之前**先重新注册，所以本次派单用的就是新定义；相同则什么都不做。比较刻意放在 kind 解析**之前**：被删掉的定义查不到 kind，而那正是最需要撤回 agent 的时刻。

写入只有一个实现（`writeKindDefinition`），三个入口都走它：**终端 CLI**（`scripts/cli.ts`，`pi-coworkflow kind …`）、Pi 内命令 `/Coworkflow:kind`、公开请求 `coworkflow:kind:v1`。**先校验再落盘**。

**一个 kind 就是一份 markdown 文档**（`.pi/Coworkflow/agents/<kind>.md`），正文即系统提示词。所以 CLI 的主路是文件而不是参数：`scaffold` 生成骨架 → 用编辑器改 → `set <kind> --from <file>` 校验后**按原样写入**（保留标题、列表、强调、换行与注释）→ `check` 只读校验。`export <kind> --out <file>` 把生效定义（含本包随附的提示词）导出成可编辑文件，避免让人重打一份长提示词。

CLI 是给**外部 agent** 的入口：不依赖 Pi 会话、扩展宿主或任何常驻进程，任何能跑 shell 的 agent 都能用。两条约定不可动摇——**退出码是结论**（0 成功 / 1 被拒绝且文件未改动 / 2 用法或找不到 / 3 内部错误），`--json` 让机器读结果而不用解析散文。它用 `mainCheckout` 解析项目根：在 task worktree 里执行会写到主检出，因为 worktree 只有已提交文件，写在里面没有 gate 会读到。不做「只在内存里注册」的通路——那种 kind 在 `/reload` 后会消失，正好违背这个端口的承诺；也**不做目录监听**：刷新点是 `/reload` 与命令本身，轮询是另一种成本。

`subagent-context` 的角色解析也读这张表：定义可以改名（`agent: cw-reviewer`）或改 role（`role: none`），靠名字猜会注入错上下文或什么都不注入。

## 面板的一条硬规则：不动光标按 Enter 必须写回原值

模型列和思考等级列都要满足：**光标落点就是当前生效值**。

- 存着的固定模型若不在模型注册表里，它**自己占一行**并标记为当前，光标落在它上面；选中它不会写入（面板拒绝并说明），要清除得选「继承」。
- 存着的思考等级若不在本页提供的等级里（该 kind 的模型变了、或模型解析不到只剩通用集），同样**自己占一行**并标记为当前，选中它写回同一个值。
- 「继承」那一行只在真的没有固定值时才标记为当前。

理由是这个类别的失败是**静默丢数据**：没有当前行时，光标落到「继承」行，一次 Enter 就把用户没动过的设置删掉。模型列先修，思考列漏过一次，两列现在都有测试守着（`scripts/agent-kind-panel.test.ts`）。

## 落点

- 类型表与默认值：`modules/agent-kinds/defaults.ts`、`modules/agent-kinds/assets/*.md`
- 注册（上游公开 `./agents` 导出 + `pi-subagents:runtime-agent-register:v1` 事件）：`modules/agent-kinds/registration.ts`
- 门禁与状态：`modules/agent-kinds/index.ts`
- 配置形状与开关解析：`core/config.ts`
- 角色映射：`modules/subagent-context/index.ts`（`kindRole()` 只读 kind 定义文件的 `role:` frontmatter；shipped 资产的 frontmatter 经 `parseDefinition` 解析后作为默认，`BUILTIN_KINDS` 不再有 role 字段）
- 面板行：`modules/panel/settings.ts`
- 模型面板（页面列表、每页的取值与写入）：`modules/panel/shared.ts`（`panelPages` / `modelRows` / `thinkingRows` / `modelForRef` / `stripThinkingSuffix`）、`modules/panel/models.ts`（`snapshot.kinds`、`kindsActive`、`applyKindModel`/`applyKindThinking`）、`modules/panel/models-panel.ts`（页签与表体）
- 派单记录与 lane 展示：`modules/lane-worktree/index.ts`、`core/subagents-workflow.ts`
- 中断控制：`core/subagents-client.ts`、`modules/subagents/run-control.ts`
- 集成契约（所有权与公开能力下限）：`.trellis/spec/frontend/subagents-integration.md`
