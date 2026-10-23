# Stage 2 报告 — `/Comodels` 分页跟随 kind

结论：Stage 2 完成。`tsc --noEmit` 退出码 0；`npm test` **224 passed / 0 failed**（Stage 1 后是 220，本阶段新增 4 个用例，原有 220 个全绿）。Requirement 8 的文档也一并补了（README + 两份 spec）。

## 改了什么

| 文件 | 改动 |
|---|---|
| `modules/panel/shared.ts` | `Tab` 变为 `"session" \| "subagent" \| \`kind:${string}\``；`PanelSnapshot` 增加 `kinds: PanelKindSnapshot[]`（kind/label/agent/enabled/model/thinking/effectiveModel）；新增 `panelPages()`、`nextTab()`、`resolveTab()`、`kindTab()`/`kindOfTab()`/`kindForTab()`、`kindStateLabel()`、`inheritModelLabel()`、`modelForRef()`；`modelRows`/`thinkingRows` 改为按「解析后的 tab + kind 条目」取值。 |
| `modules/panel/models.ts` | port 新增 `applyKindModel(kind, model\|null)`、`applyKindThinking(kind, level\|null)`，都走 `runtime.control.setAgentKind`（它先校验、再写配置、再 `await syncAgentKinds`）；`snapshot()` 带 `kinds`，在打开与每次应用后重读 `control.agentKinds()`，不在渲染里读盘。 |
| `modules/panel/models-panel.ts` | 页签从 `panelPages(snapshot)` 渲染、Tab 用 `nextTab` 循环；`apply()` 按 tab 分派（session / 默认 / kind）；kind 页的状态行给出「固定 …」或「继承（跟随 …）」，关闭的 kind 额外说明「已关闭，模型仍然保留」；`updateBody` 用 `resolveTab` 兜底（kind 页消失则回主会话）。新增测试用的 `pages()`/`currentTab()`。 |
| `modules/panel/index.ts` | 重新导出新增的纯函数与类型；模块头注释改成「页面由项目 kind 算出 + 优先级」。 |
| `scripts/agent-kind-panel.test.ts`（新） | 4 个用例，见下。 |
| `scripts/verify.ts` | `panel` 探针的 snapshot 补 `kinds: []`（否则新字段缺失，探针会渲染出无页签）。 |
| `package.json` | 新测试文件接入 `npm test`。 |
| `README.md` | `/Comodels` 一节改成「页面不是写死的两个」+ 页面/写入目标/思考等级来源对照表 + Tab 说明；kind 一节新增「每个 kind 自己的模型」（优先级、写入拒绝 vs 读取丢弃、签名）；配置示例加 `model`/`thinking`；命令表、测试条数与覆盖项同步。 |
| `.trellis/spec/frontend/agent-kinds.md` | 新增「每个 kind 自己的模型与思考等级」「面板页跟随 kind，不写死」两节；失败模式表加两行；落点补 `shared.ts`/`models.ts`。 |
| `.trellis/spec/frontend/subagents-integration.md` | kind 定义加 `model`/`thinking` 与优先级、读取丢弃/写入拒绝；模型面板一节改为「页面由配置的 kind 算出」。 |

## 测试驱动的是生产函数

新增 `scripts/agent-kind-panel.test.ts`（4 个用例）：

1. **`panel: the page list follows the snapshot's kinds…`** —— 纯函数 `panelPages`/`nextTab`/`resolveTab`：三个 kind → 5 页且顺序为 主会话/子 agent（默认）/执行者 cw-executor/审计者 cw-auditor/调研者 cw-researcher，关闭的那个带 `已关闭` 且仍有页；去掉一个 → 4 页；`kinds: []` → 2 页；`nextTab` 走完一圈回到 `session`；kind 页消失时 `resolveTab` 回 `session`。
2. **`panel: a kind page's rows are that kind's model, and its levels follow the kind's own model`** —— 继承时首行是「继承」且是 current；固定时该 kind 解析出的模型那行是 current（`provider/id` 与带 `:level` 的裸 id 都能对上）；继承页列的是会话模型的等级（含 `xhigh`），固定到非推理模型后只剩 `off`；默认页行为不变。
3. **`Comodels: a page per kind, applying writes the config and re-registers that agent, clearing inherits again`** —— 真扩展 + 已安装 pi-subagents（fake bus 上挂的是 **owner 自己的** 注册监听）：打开后 `pages()` 为上述 5 页；Tab 三次到 `kind:auditor` 且渲染出 `[审计者 cw-auditor]`；Enter 选中 `p/cheap` 后**配置文件** `agentKinds.auditor.model === "p/cheap"` 且 owner registry 里 `cw-auditor.model === "p/cheap"`（其它 kind 未受影响）；状态行报 `模型 p/cheap`、思考列不再出现 `xhigh`；选「继承」后键被删除、owner registry 里 `cw-auditor.model` 变回 `undefined`、思考列恢复；默认页仍写 `subagents.defaultModel/defaultProvider`（读 `.pi/settings.json` 验证）且不碰任何 `agentKinds`。
4. **`Comodels: a disabled kind keeps its page and keeps the model it had stored`** —— 关闭的 kind 有页且带 `已关闭`，页面仍显示它存的 `p/cheap`，配置未被清空，owner registry 里没有 `cw-researcher`。

另外手工跑了一次真实渲染探针（临时项目 + 真扩展 + 真 `control.agentKinds()`），确认 5 页页签、kind 页的「当前：… 固定 …/继承（跟随 …）」、关闭 kind 的提示、以及 `agentKinds.<kind>` 的 scope 行都对。

## 没做 / 边界

- 没动 `pi-subagents`、`/Coworkflow:settings`、kind gate、Trellis 资产（与派单边界一致）。
- 未提交、未 push、未合并，任务生命周期状态未改。
- 一处**有意的取舍**：`snapshot.kinds` 在打开面板和每次应用后重读，不在每次渲染重读——渲染高频，而 `agentKinds()` 要解码 `.pi/Coworkflow.json`。面板自身不能改 kind 的开关（那是设置面板），所以面板开着期间 kind 集合不会变；`resolveTab` 兜底了配置在外部被改的情况。
