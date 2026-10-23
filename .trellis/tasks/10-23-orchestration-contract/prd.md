# Coherent parent orchestration and bounded delegation

## Goal

让「主会话负责判断、执行交出去」在本项目里成为**可执行的事实**，而不是一段提醒：主会话收到的指引一致、可派角色来自当前运行时、派单成本足够低、约束落在真正的启动边界上。

## 问题（已核查）

1. Trellis 的 Pi 扩展在 `in_progress` 时注入的是「读规范 → 自己实现 → 跑 lint/type-check」的 inline 指引，与 Coworkflow 受管区的主会话分工直接相反。
2. 受管区把「类型就是这三个 kind」写成静态事实；`cw-*` 是否可用取决于运行时（本会话就曾没有 `cw-*`，派单直接失败）。
3. 派单前的机械决策（后台、fresh、预算、容量、角色名）都由模型自己算；超过每类上限时整批被拒，模型必须自己拆批、等待、续派。
4. 约束按**调用外形**识别（`coworkflow.fanout` / 上游 `parallel` / 直接 `agent`），且上游 `parallel` 批次里的**非 kind** agent 会被误判为「未注册 kind」而拒绝。

## 需求

- R1 主会话的执行分工必须明确、可追踪：判断、契约、验收、集成留在主会话；有输入/产物/验收条件的工作单元交给子 agent；小改动允许留在主会话但要被记录为范围。
- R2 主会话收到的能力事实必须来自当前运行时：哪些 kind 真正可派、哪些不可用及原因、本会话是否启用。
- R3 静态指引不得把「可派角色」写成固定三个；它必须指向运行时事实，并规定 kind 不可用时的行为（报告原因，不静默换成 `trellis-*`）。
- R4 门槛只处理本包拥有的 kind：任何其它 agent（builtin、`trellis-*`、其它扩展的）在任何批次形状里都不被拦、不被改写。
- R5 约束的判定放在解析出具体子 agent 之后，而不是继续按 workflow 名字扩充白名单。
- R6 计数不可读、窗口截断、会话换代一律拒绝，不当成 0。
- R7 不引入第二个运行器、排队器、重试队列或生命周期账本；上游仍是执行与容量的所有者。

## 不做

- 不在对话里注入提醒消息（会作为 user 轮次改写进行中的工作）。
- 不改写 Trellis 拥有的生成资产（`.trellis/workflow.md`、`.pi/extensions/trellis/`、`trellis-*` agent）。
- 不实现跨进程的全局容量权威。

## 子任务

| 子任务 | 交付物 |
|---|---|
| `10-23-orchestration-admission` | 批次准入只作用于本包 kind；非 kind agent 原样放行；有回归 |
| `10-23-orchestration-parent` | 受管区改成「运行时能力 + 不可用时的行为」，不再写死三个 kind |
| `10-23-orchestration-scheduler` | 记录并验证「整批拒绝 vs 逐任务准入」的边界；本轮只落地可验证部分 |

## 验收

- [x] 上游 `parallel` 批次里混入 `reviewer` / `trellis-check` 时不被本包拒绝，且不触发任何 fleet 读取。
- [x] 上游 `parallel` 批次里 `cw-*` 超上限时被拒，措辞给出 kind、上限、当前占用，且不启动任何子进程。
- [x] 受管区不再断言「类型就是这三个」；改为读 `/Coworkflow:status` 的实时列表。
- [x] kind 不可用时的行为有明确规则（报告原因 + 保留在主会话），不是静默替换。
- [x] `npm test` 通过（271/271）；新增回归覆盖 R4 与 R6。
- [x] 本轮复查后 `.trellis/spec/` 与实际行为一致（`agent-kinds.md` 失败模式、`subagents-integration.md` 批次准入与容量范围）。

## 交付与残留

已集成到 `main`（提交 `071d6df`），三个子任务已归档：

| 子任务 | 状态 |
|---|---|
| `10-23-orchestration-admission` | 已归档，代码 + 两条回归 |
| `10-23-orchestration-parent` | 已归档，受管区四点改写 |
| `10-23-orchestration-scheduler` | 已归档，决策记录（不建队列/账本/重试） |

残留（未做，需要时另立任务）：

- R5 只完成了一半：批次解码仍按 workflow 名称识别（`coworkflow.fanout` / 上游 `parallel`），任意脚本内的 `runs.run` 仍绕过每类上限。真正的「解析出子 agent 后统一准入」需要上游提供启动扩展点，或在本包自己的资源里逐个 `runs.run` 前判定。
- 本会话仍在运行**打补丁前**加载的扩展代码：改动要 `/reload` 之后才进入活运行时（单元回归已直接驱动生产 gate）。
