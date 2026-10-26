# Kind 在脚本编排通道里的治理缺口

## 背景（已确认的现状，2026-10-26 复核）

kind 是真实 agent 定义，通过 pi-subagents 的 runtime-agent contract 注册在**父进程**（`modules/agent-kinds/index.ts:708`：`!runtime.isChild && runtime.enabled && moduleEnabled("agent-kinds")` 才注册）。因此**解析层**上，任何在父进程内按名字启动的通道都能启动 `cw-*`，包括 workflow 脚本沙箱里的 `runs.run`；但**治理层**上，脚本内的启动不经过任何 `tool_call`，enabled 开关与 `maxConcurrent` 都施加不上。

本包当前的处理是拒绝可识别的形状（`decodeUngovernedLaunch()`，`modules/agent-kinds/index.ts:397` 起）：

- `workflow: true` → 一律拒（payload 里没有脚本，无从检查）。
- `workflow: "<含 /> 的路径>"` 且文件文本里出现 `runs.run` / `runs.all` / `runs.lanes` → 拒，理由指回 `coworkflow_dispatch`。
- 读不到文件、或读到但没有启动调用 → 放行（未知不等于证据）。
- 命名资源（`coworkflow.fanout`、上游 `parallel`）不是脚本，按其参数逐 kind 判（`fanoutPolicyFor()`，同一份 `resolveKinds`）。

四种通道的实际矩阵：

| 通道 | kind 可用 | enabled | maxConcurrent | 角色上下文注入 | 独立计时 |
|---|---|---|---|---|---|
| 直派 `subagent({agent})` | ✅ | ✅ gate | ✅ | ✅ | ✅ |
| `coworkflow_dispatch` | ✅ | ✅ `admitOne` | ✅ 排队 | ✅ | ✅ |
| `coworkflow.fanout` / `parallel` | ✅ | ✅ | ✅ 整批超限即拒 | ✅ | ✅ |
| 脚本 `workflow: true` / 带启动的 `.js` | ❌ 被拒 | 无法施加 | 无法施加 | （若跑起来会生效） | 不计入 |

副作用（同样是刻意设计，不是缺口）：子会话不注册 kind（`runtime.isChild` → 不注册），子 agent 不能再派 `cw-*`。

## 待决定的问题

现在这条缝的代价是：任何**只有脚本能表达**的编排（后一步读前一步 `output`、条件分支、`resume` 到指定 child key、`runs.lanes` 分组）都无法使用本项目的 kind，只能退回上游内置 agent 或放弃准入。要么补通道，要么把脚本的需求消掉。

## Requirements

- R1 二选一定案，二选一之前不改现有拒绝行为（现状是诚实降级，不是 bug）：
  - **A：补一条受治理的脚本通道。** 需要能回答：脚本内每个 child 启动前如何过 `admitOne`（沙箱里没有 `tool_call`）。可行方向是让 kind 的启动改走一个受控入口（例如脚本里调用本包暴露的受限 `runs` 包装，或上游提供沙箱内准入钩子），而不是读脚本文本猜。
  - **B：把表达力补齐到不需要脚本。** 让 `coworkflow_dispatch` / `coworkflow.fanout` 覆盖「依赖前一步 output」「条件/聚合」「按 child key 复用」。代价是 fanout 的输入契约要扩，且要判断是否值得自己维护一套编排语义。
- R2 无论选哪条，`/Coworkflow:status` 与 AGENTS 受管区的表述必须与实现一致；不得出现「声称覆盖脚本通道」而实际没有准入的文案。
- R3 若选 A，必须同时处理：脚本内 child 是否计入 fleet 占用、是否受项目上限、超时与交接预算是否照旧生效、以及与 `subagent-context` 注入的先后顺序。
- R4 若选 B，必须给出与上游 `workflow` 能力差距的清单，明确「哪些脚本场景本项目不支持」，而不是笼统说够用。

## Acceptance Criteria

- [ ] 任务里有一份对比结论（A vs B），含各自代价与不可做的部分，而不是只列选项。
- [ ] 选定方案后，四种通道矩阵（上表）逐格有实现或明确拒绝理由，没有空格子。
- [ ] `decodeUngovernedLaunch()` 的行为随定案一起调整（选 A 时不再一律拒；选 B 时保持拒绝并更新拒绝文案）。
- [ ] 至少一个真实会话验证：脚本通道（若保留）里启动的 kind 计入上限、被挡住时给出原因，或明确说明为何不做。
- [ ] `scripts/agent-kinds.test.ts` 覆盖定案后的形状；`/Coworkflow:status` 文案与实现一致。

## Notes

- 相关实现位置：`modules/agent-kinds/index.ts`（注册、gate、`decodeUngovernedLaunch`、`fanoutPolicyFor`）、`modules/dispatch/index.ts`（RPC `spawn`、`admitOne`）、`modules/subagent-context/index.ts`（`detectRole` / `kindOf`，与通道无关）。
- 上游能力参照：`~/.pi/agent/npm/node_modules/pi-subagents/docs/workflows.md`（`runs.run` / `runs.all` / `runs.lanes` / `reuseFrom`）、`docs/extension-api.md`（`subagents:rpc:v1` 只有 `spawn`，无沙箱内准入）。
- 本题只是记录与定案，不包含实现；定案后再决定是否拆实现任务。
