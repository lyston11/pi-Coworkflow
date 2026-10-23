# Stated dispatch boundary

## Goal

对我们治理不到的启动形状显式说清并拒绝；文档与 spec 如实描述治理边界。

## 需求

- R1 `tool_call` gate 新增一条判定：`subagent` 调用若携带我们无法治理的**脚本内自建启动**（上游 `workflow` + 脚本里 `runs.run` 的形态，或 `workflow: true` 的代码块形态），在 `agent-kinds` 开启时拒绝，理由写明：这种形状的启动不经过本包准入，请改用 `coworkflow.dispatch`（排队与依赖都在那里）。**只拒绝能识别的形状**，不做启发式猜测。
- R2 拒绝消息必须列出替代调用（`coworkflow.dispatch`），而不是只说"不行"。
- R3 `.trellis/spec/frontend/subagents-integration.md` 增一节「What is governed」：三处启动点 + 一次准入函数 + 明确不治理的部分（第三方脚本、其它进程、上游 RPC 直调）。
- R4 受管区（`modules/agents/assets/main-AGENTS.region.md`）增加一句：批量工作用 `coworkflow.dispatch`，不要自己拆批；不要用脚本内自建启动。
- R5 测试：可识别的不治理形状被拒且理由含 `coworkflow.dispatch`；普通 `parallel` 与直接派单不受影响。

## 不做

- 不改 `admitOne` 与 dispatch 模块本身（其它 lane）。
