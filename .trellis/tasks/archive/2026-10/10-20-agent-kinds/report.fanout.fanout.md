# report: `coworkflow.fanout` + serial-dispatch measurement

任务：`.trellis/tasks/10-20-agent-kinds`（本阶段：独立子任务并发 + 派单重叠事实）
工作树：`/Users/lyston/PycharmProjects/wt-10-20-agent-kinds`
未提交、未合并、未改任务状态。`pi-subagents` 只读，未被改动。

## 1. `coworkflow.fanout`（`core/subagents-workflow.ts`）

> **已按 supervisor 更正重写：args 是 kind 驱动的，不是 agent 名驱动的。** 最终 shape 见下。

### 最终 args shape

```ts
subagent({
  workflow: "coworkflow.fanout",
  args: {
    tasks: [                                   // 1..8 项，必填
      { kind: "executor", task: "实现 A" },     // kind ∈ 本包提供的 kind 表
      { kind: "auditor",  task: "只读审计 C" }, // executor / auditor / researcher
    ],
    focus?: "本次扇出的共同要求",                // 可选，1..2000 字符
  },
})
```

- 每个 task **只有 `kind` 与 `task` 两个字段**；`agent`、`model`、`worktree` 等任何其他字段都被拒（`args.tasks[i] contains unsupported fields: agent`）。
- `kind` → agent 名走 `agentNameFor()`（`modules/agent-kinds/defaults.ts`），**没有第二份映射**：`executor → cw-executor`、`auditor → cw-auditor`、`researcher → cw-researcher`。
- 本包不提供的 kind（`worker`、`trellis-implement`、`cw-executor` 这种带前缀的）→ 报错并**列出可用的 kind**：`args.tasks[0].kind 'worker' is not a kind this package ships; available kinds: executor、auditor、researcher.`
- 返回的每个 result 同时带 `kind` 与 `agent`，所以父会话读得到"这是哪个 kind、实际跑的是哪个 agent"。

新增导出：`FANOUT_NAME = "coworkflow.fanout"`、`FANOUT_VERSION`、`resolveFanout(args, prepared, policy)`、`FanoutChild`、`FanoutPolicy`。

- **校验**（与 `resolveImplementReview` 同风格同措辞）：`args` 只接受 `tasks` 与 `focus`；任未知顶层字段 → `workflow 'coworkflow.fanout' args contain unsupported fields: …`（`worktree`、`script` 因此被拒）。`tasks` 必须 1–8 项，`tasks[i]` 只允许 `kind`/`task`，`kind` 走既有 `AGENT_RE` 且 ≤96 字符并被 kind 表校验，`task` 非空且 ≤8000 字符，`focus` 1–2000 字符。
- **按 kind 的策略在扇出里照样生效**（这条是更正的核心）：
  - resolver 仍然纯函数、无 I/O，所以策略由宿主在 gate 时解析好传进来：新增 `fanoutPolicyFor(host, runtime)`（`modules/agent-kinds/index.ts`），读的是 `resolveKinds(readConfig(root))` **加** owner 本会话真的接受的 kind 注册（`snapshot.registered`），与面板和 `tool_call` 门同一口径。
  - `dispatchable === false` 的 task **不启动**，直接判该 task 失败，错误文案复用门的话术：新增 `disabledKindMessage()` / `unregisteredKindMessage()`（`modules/agent-kinds/defaults.ts`），门的 `disabledRefusal` 也改成调同一个 helper —— **一套词，不是两套**。
  - 策略读不到（agent-kinds 模块关闭 / 注册未完成 / 契约不可用）→ 该 task 拒绝，不假设可用。兄弟 task 照常跑。
- **child key 由位置决定**（`task-1`…`task-8`），不取自调用方文本——两个 child 可以是同一 kind 做不同的事（上游对重复 key 直接拒绝）。
- 每个 child：`context: "fresh"`、`worktree: false`、各自的 `acceptance { level: "checked", report: "on", criteria, evidence }` 与共享的 `FANOUT_SCHEMA`（`status/summary/handoff` 三字段必填）。`cwd` 只在宿主准备好了已验证 worktree 时显式传入，否则继承工作流自身 cwd（也是宿主选的）。
- **并发是代码事实**：`tasks.map(... runs.run(...))` 先全部启动，之后才 `await Promise.all(...)`；单条 child 的 rejection 被 `.then(ok, err)` 转成该 task 的 outcome，不取消兄弟。
- **返回**：`{ status: "completed" | "partial", acceptance: "parent-owned", note, concurrency: "parallel", total, completed, failed, results: [{ key, kind, agent, ok, status, summary, handoff, runId, outputReference, error }] }`。`note` 复用 implement-review 的措辞（"只代表执行完成，不代表验收通过…合并、清理与最终结论仍由主会话决定"）。**全部失败才 fail-closed**（抛错并列出每个 task 的原因）。
- **注册**：仍是同一个 `registerImplementReviewWorkflow`，一次注册两个名字，任一失败则 dispose 已落地的、返回原因；返回的 handle 一次 dispose 两个。没有第二条注册路径，`withdraw`/`replace`/`onSessionEnd` 语义不变。kind 策略通过新参数 `fanoutPolicy?: () => FanoutPolicy` 注入（`modules/subagents/index.ts` 的 `schedule()` 传 `fanoutPolicyFor(host, runtime)`），resolver 自身仍不读盘。
- 无任何 `sendMessage`/`sendUserMessage`/`emit`/`console` 调用。

## 2. 派单重叠（新文件 `core/dispatch-timing.ts` + 链接字段）

- `NativeRunLink` 新增 `startedAt`、`settledAt`（ISO 字符串）。`recordLaunchLink` 保留已有 `startedAt`/首个 `settledAt`，因此后期 adopt（handoff 路径迟到）不会移动开始时间——这正是不能用 `recordedAt` 的原因。
- `recordRunSettled(root, runId)` 只由观察到的结构化原生完成（`message_end` + `decodeNativeCompletions`）写入，且只写一次。
- `summarizeOverlap(intervals, now)`（纯函数）：区间相交 = 并行；有完整区间且不相交 = 串行；缺时间戳 / 仍在运行 / 时钟倒退 = `unresolved`，**永不并入串行**。
- `dispatchOverlap(root, sessionId)` 只读本会话链接（`readSessionLinks`）。
- `/Coworkflow:status` 多一行（`modules/subagents/index.ts` 的 `runtimeStatus`）：`派单重叠: 3 次并行、5 次串行（本次会话）`；未测量时是 `本次会话还没有派单记录`；有未决项时追加 `N 次仍在运行或时间未知（不计入串行）`。渲染时读取，纯存储状态，不发消息。
- 顺带收紧了本模块 `tool_call` 门：现在只拦本包自己的两个资源名（`implement-review`、`fanout`），其他 dispatch 在 judged 之前就返回；`fanout` 不要求活跃任务 worktree（通用扇出），`implement-review` 仍然要求。

**依赖说明（未触碰的文件）**：`modules/lane-worktree/index.ts`、`core/subagents-client.ts`、面板路径按要求由其它子任务持有，我没有修改。`/Coworkflow:lanes` 之后可以直接复用 `dispatchOverlap`/`formatOverlapLine` 渲染同一测量；lane 记录里已经存了 `startedAt`（`recordLaunchLink` 自动填），只需在它的完成观察点调 `recordRunSettled`。

## 3. 文档

- `README.md`：新增「并行扇出：`coworkflow.fanout`」一节（串行/并行脚本对比、**kind 驱动的 args**、kind 开关照样生效、args 校验、并发是 `Promise.all`、partial 语义、`parent-owned`），以及「串行派单是被测量的缺陷，不是被提醒的缺陷」（一行状态、三种判定、旧提醒被删除的原因：自定义消息会以 user turn 回到模型）。
- `.trellis/spec/frontend/subagents-integration.md`：新增「Independent children (`coworkflow.fanout`) and the serial-dispatch measurement」，并更新 ownership 段（两个工作流名 + 两个时间戳）。
  - **注意**：该 spec 文件在本工作树里是未跟踪文件（`git status` 显示 `??`），且已被并发的 kinds 子任务写过。我是在其现有内容上追加了一段，没有改动它的 kinds 段。

## 4. 测试（`scripts/fanout.test.ts`，已加进 `npm test`）

20 个用例，全部走生产函数；并发断言跑在 **pi-subagents 自己的脚本沙箱 `runWorkflowScript`** 上（不是本地重写的 stub）：

- 校验：0 项 / 9 项 / 非数组 / 空或空白 kind、task / 非字符串 task / 非法 kind 名 / 未知 per-task 字段（含 `agent`）/ 未知顶层字段 / `focus` 越界；
- kind：`worker`/`trellis-implement`/`cw-executor`/`reviewer` 都被拒，错误里列出全部可用 kind；
- 策略：某个 kind 被关闭 → 该 task 不启动、失败文案含「关闭了 kind auditor（cw-auditor）」与「当前可用的 kind：cw-executor」，兄弟照常完成（`status: "partial"`）；策略不可读 → 该 task 拒绝且**一个 child 都没启动**（全部失败 → fail-closed）；
- kind → agent：`params.agent` 断言为 `cw-executor` / `cw-auditor`，results 里同时带 `kind` 与 `agent`；
- 3 个 task：三个都启动、最后一个 child 在任何 child 结束**之前**启动（`starts[2] < min(finishes)`，span < 60ms）、每个 child 的 fresh/worktree/schema/cwd；
- 单 child 失败：兄弟结果完整、`status: "partial"`、失败归到自己的 key/agent、不被借用 runId；
- 无 structured verdict 视为该 task 失败；全部失败 fail-closed（消息含 `all 2 task(s) failed` 与每个具体原因）；
- 无 workflow 路径写消息：脚本文本不含 `sendMessage`/`sendUserMessage`/`emit(`/`console.*`，且 `result.emits` 与 `result.console` 均为空；
- 重叠测量：相交=并行、严格串行=串行、缺时间戳/仍在跑/时钟倒退=unknown、混合计数、只读本会话、re-adopt 不移动 startedAt、settledAt 只记第一次；
- `/Coworkflow:status` 行：空会话、两两并行、仍在运行的 unknown、且 `sendMessage`/`sendUserMessage` 调用次数为 0；
- 注册：两个名字都落地且一起 dispose、dispose 后替换会话可再注册、export 缺失的 owner 两个名字都不注册并返回原因；
- 门：`fanout` 无任务也被放行、`implement-review` 无 worktree 被拒、其它 dispatch（`workflow: true` / 别的 workflow / 裸派单）不被本模块判断。

## 5. 实际执行的验证

```
npx tsc --noEmit            → No errors found
node --test scripts/fanout.test.ts → tests 20, pass 20, fail 0
npm test                    → tests 184, pass 184, fail 0, skipped 0 (12.4s)
```

## 6. 更正落地记录

supervisor 的更正（kind 驱动，不用 trellis-* 名字）已经全部落地，不是"下一轮再做"：

| 更正要求 | 落地位置 |
|---|---|
| task 写 kind 而不是 agent | `resolveFanout` 的 `kind`/`task`，`FANOUT_ENTRY_FIELDS = ["kind", "task"]` |
| kind → agent 用现成 `agentNameFor()` | `fanoutKindOf()` 直接调 `agentNameFor` / `builtinKind` |
| 未知 kind 报错并列出可用 kind | `args.tasks[i].kind '…' is not a kind this package ships; available kinds: …` |
| 尊重按 kind 的开关，复用门的措辞 | `fanoutPolicyFor()` + `disabledKindMessage()` / `unregisteredKindMessage()`，门的 `disabledRefusal` 改成调同一 helper |
| 需要的新 helper 放 `modules/agent-kinds/` | `modules/agent-kinds/index.ts`（`fanoutPolicyFor`）、`modules/agent-kinds/defaults.ts`（`FanoutKindPolicy`、`disabledKindMessage`、`unregisteredKindMessage`）；**没有**改 lane-worktree / panel / subagents-client |
| 文档与示例只用 kind | README 示例改成 `{ kind: "executor" | "auditor" }`，spec 同步 |
| 去掉任意 `agent` 字段 | 已去掉：per-task 只允许 `kind`/`task`，传 `agent` 直接被拒 |

## 7. 已知取舍 / 留给后续

- fanout child 的 `acceptance` 统一为 `checked`（要求 changed-files/commands-run 等证据）。一个纯只读的 `auditor` child 用 `checked` 会要求它自报 changed-files；按 kind 的 role（`kindRole`：`auditor → check`）区分 acceptance 等级是自然的下一步，但属于 kind 表的口径扩展，本阶段没做。
- `settledAt` 只来自 `message_end` 的结构化完成。若观察不到完成（例如会话中断），该 run 一直是 unknown —— 这是设计选择，不是遗漏。
- 面板未新增行（面板路径由其它子任务持有）。
