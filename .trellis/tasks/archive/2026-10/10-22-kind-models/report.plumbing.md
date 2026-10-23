# Stage 1 报告 — per-kind model / thinking（config → 注册定义）

结论：Stage 1 完成。`tsc --noEmit` 退出码 0；`npm test` **220 passed / 0 failed**（新增 7 个用例，原 213 个全绿）。

## 改了什么

| 文件 | 改动 |
|---|---|
| `core/config.ts` | `AgentKindConfig` 增加 `model?`/`thinking?`；新增 `isKindModel()`、`isThinkingLevel()`、`MAX_KIND_MODEL_LENGTH = 200`；`parseAgentKinds` 对两者**校验后丢弃**不合法值（不是转发）；`ResolvedAgentKind` 增加同名字段。思考等级直接取自 `modules/panel/shared.ts` 的 `THINKING_LEVELS`（不新建第二份列表）。 |
| `modules/agent-kinds/defaults.ts` | `resolveKinds` 原样透传 `model`/`thinking`；`BuiltinKind.defaults` 收窄为 `Required<Pick<AgentKindConfig,"enabled"\|"maxConcurrent">>`——内置表**不提供**模型默认值，缺省即继承。 |
| `modules/agent-kinds/registration.ts` | `KindDefinition` 增加 `model?`/`thinking?`；`signature()` **包含**两者（`model ?? null`、`thinking ?? null`），否则改模型会被判为 unchanged、活注册保留旧模型。`DesiredKind` 注释说明为何字段在 `definition` 内而非旁边。 |
| `modules/agent-kinds/index.ts` | `kindRegistrationPlan` 把两者写进 definition（缺省则键**不存在**）；`Snapshot.registered` / `disabled` 携带 model/thinking；`runtimeStatus` 每行追加 `kindModelSuffix()`：`· 模型 <id> · 思考 <level>` 或 `· 继承默认 · 思考 继承`。 |
| `core/module.ts` | `setAgentKind(kind, patch)` 的 patch 类型增加 `model?: string \| null`、`thinking?: string \| null`，注释写明 `null` = 继承（删键）、非法值返回消息而不抛。 |
| `extensions/coworkflow.ts` | `setAgentKind` 实现：先校验（`isKindModel`/`isThinkingLevel`，失败返回可读消息且**不写文件**），`null` 删除键，其余保持既有语义（缺字段保留原值、写后 `syncAgentKinds` 再报告注册结果）；报告行用新的 `kindModelLine()` 追加 `，模型 …/继承，思考 …/继承`。 |
| `scripts/agent-kind-models.test.ts`（新） | 7 个用例，见下。 |
| `package.json` | 新测试文件接入 `npm test`。 |

## 测试驱动的是生产函数

- `config: a malformed stored model or thinking level is dropped` —— 前后空白、控制字符、超长、空串被丢；同一 entry 里合法的另一字段仍保留（两字段独立）。
- `config: the validator is the one the panel and the writer share` —— `provider/id`、裸 id、`:level` 均通过；等级集合逐项取自 `THINKING_LEVELS`。
- `plan: … absence stays absent` —— `kindRegistrationPlan` 产出里 `"model" in definition === false`。
- `registration: a changed model re-registers …` —— 真 `createKindRegistry` + 已安装 pi-subagents 的真实事件监听与 `registerAgent`：改模型后 owner registry 里 `cw-executor.model` 变成新值且**只有一条**（重新注册而非重复）；只改 thinking 也会重新注册；同定义不再注册；清空后 owner 记录里 `model`/`thinking` 为 `undefined`。
- `status: … pins a model or inherits` —— 已注册行给出 `模型 …/继承默认`；被关闭的 kind 行保留其已存模型（打开时不丢设置）。
- `control: setting a kind's model writes the config and re-registers that agent` —— 走真实 `controlSurface()`：写盘 + owner 里生效，其它 kind 不受影响；`null` 让键消失；后续改上限不会把模型冲掉。
- `control: an unusable model is refused …` —— 非法值返回消息、配置文件**逐字节未变**。

## 未做 / 需下一阶段接手

- **Stage 2（`/Comodels` 分页、`Tab` 联合类型、`modelRows`/`thinkingRows` 按 kind）没有动**，按要求只做 Stage 1。
- **Requirement 8 的文档（README + `.trellis/spec/frontend/agent-kinds.md`）未改**：派单只要求 Stage 1 的六个代码点 + 测试，且另一 agent 可能正在写同一批文档，避免冲突。Stage 2/收尾时需要补：`agentKinds.<kind>.model`/`.thinking` 字段与优先级（kind model → `subagents.defaultModel` → Pi 默认）。
- `/Coworkflow:settings` 的行显示仍是「开/关 · 上限」，未加模型列（PRD 明确 settings 面板不在 scope）。

## 环境备注

该 worktree 原本没有 `node_modules`（`tsc` 不可用），我建了一个指向 `/Users/lyston/PycharmProjects/pi-Coworkflow/node_modules` 的符号链接（`.gitignore` 已忽略，不进版本库），仅用于运行 `tsc`/`node --test`。未改动主 checkout 或已安装的 pi-subagents。
