# 主会话、子 agent、Trellis 与 worktree 契约审查

基线：`290c9b5`。日期：2026-10-28。范围：当前 Coworkflow 源码、随包提示词/模板、本机 pi-subagents 的注册和启动默认行为。

## 结论

五种用途与主会话直接负责交付的方向合理。主要问题已经从职责措辞，转到运行时是否遵守同一份任务与工作目录契约。发现 4 项 P1、3 项 P2；没有 P0。建议先修这些边界，不增加角色、自动调度器或更长的系统提示词。

本轮只写审查工件，不修改生产代码、提示词或模型设置。没有发起新的远端模型请求，没有重跑模型路由测试。`probes.mjs` 使用真实 Git 临时仓库、上游注册接口和模块级事件探针；全部临时仓库已在脚本 finally 中删除。

## P1-1：项目规则默认没有进入子 agent

- 位置：`modules/agent-kinds/index.ts:750–760`，`modules/subagent-context/index.ts:337–360`。
- 声明：`modules/agents/assets/subagent-AGENTS.md:13` 说上下文来自项目受管区外的规则。
- 实现：kind 注册只传 description、systemPrompt、model、thinking，没有声明 `inheritProjectContext`。本机 `pi-subagents/src/agents/runtime-agent-registry.js:13–20,294–298` 对非 delegate 默认采用 `systemPromptMode: replace`、`inheritProjectContext: false`、`inheritSkills: false`；启动器 `src/runs/shared/child-launch.js:232–235` 将其变成 `noContextFiles: true`、`noSkills: true`。
- 复现：将生产 `kindRegistrationPlan` 的五份定义送入上游 `registerRuntimeAgent`，再读取实际注册配置，五个 kind 全部是 `inheritProjectContext: false`。
- 影响：主会话看到了项目 AGENTS 中的约束，但子 agent 不一定看得到。现有剥离函数只会处理已存在的 contextFiles，不能补回没有加载的项目规则。Trellis manifest 只能提供其中列出的规范，不能代替所有项目规则。
- 最小修复：显式决定并传递项目规则继承策略，保持当前受管区剥离；不要顺带打开全部全局上下文或技能。必要验证是实际启动配置与最终 child system prompt 中，保留项目自定义规则且没有重复主会话派单规则。

## P1-2：任务身份与执行 worktree 可以分离

- 位置：`modules/session-worktree/index.ts:328–356`、`:178–206`，派单调用位于 `modules/dispatch/index.ts`；子上下文则独立通过 `modules/subagent-context/index.ts:302–309` 解析任务。
- 触发：同一主会话先派发任务 A，随后激活任务 B，仍从原主检出派发 B。
- 复现：第一次 `sessionTree` 返回 `wt-a`；父任务指针改为 B 后，第二次仍返回 `wt-a`。同次测试里 `resolveChildTask('Active task: .trellis/tasks/b')` 正确返回 B。
- 原因：缓存只用会话身份失效，不包含任务身份、任务 worktree；placement 也没有接收每个派单的显式任务引用。因此即使重新解析，也可能与子上下文的显式任务选择不同。
- 影响：子 agent 按 B 的 PRD 工作，却写进 A 的分支。这比缺少提示词更危险，因为它同时持有看似正确的材料和错误的目录。
- 最小修复：每次启动解析一次明确的任务身份，并让注入与 placement 使用同一结果。存在 task/cwd 冲突时拒绝派发，不静默沿用旧目录。缓存应包含任务与目录身份；新派单可以去 B，仍运行的 A 子任务继续持有 A。
- 相邻源码风险：`resolveSessionTree` 遇到非空 taskPlan 失败时仍能走会话 worktree 回退，且已有 linked cwd 的优先级高于任务检查。应与上述冲突检测一起处理；本轮单独动态复现的是 A→B 缓存问题。

## P1-3：显式 `(none)` 与任务绑定没有跨轮次保持

- 位置：`modules/subagent-context/index.ts:285–309`、`:437`。
- 触发：child 首轮收到 `Active task: (none)`；随后被继续或补充指令，新的 prompt 没有重复这个引用，而父会话仍有活跃任务。
- 复现：用同一个 child host/runtime 连续触发两次 `before_agent_start`。首轮不含父任务 B 的 PRD；第二轮 `Continue the same assignment.` 后出现 `TASK_B`。
- 原因：每轮从当前消息和去除旧注入后的提示重新解析；显式 opt-out 没存入 child 会话绑定。没有引用时，又读取父会话此刻的任务指针。
- 影响：独立 worker 在后续轮次被绑定到父任务；同理，显式绑定 A 的 child 也可能在丢失引用后跟随父会话切到 B。
- 最小修复：将首次解析的 `task | none | invalid` 作为 child 会话状态保留，支持恢复。只有明确的新任务指令才能改变它；不能用父指针覆盖已有绑定。
- 证据边界：这是模块级真实事件接口的复现；没有新启远端模型或对所有上游 resume 包装方式作遍历。只要后续事件不再带原始引用，就会触发。

## P1-4：task start 会认领同名但属于其它分支的 worktree

- 位置：`modules/worktree/assets/auto_worktree.py:117–139`。
- 触发：任务 C 声明 `feat/c`，预期目录 `wt-c` 已存在，但属于 `foreign` 分支；`feat/c` 尚无已签出的 worktree。
- 复现：在临时 Git 仓库运行真实 hook，task.json 从 `branch: feat/c` 变为 `branch: foreign`，并记录该现存目录。
- 原因：脚本只检查目标目录是否是 registered worktree；找到就将该目录的现有分支写回任务，未要求它等于目标分支。
- 影响：任务绑定被静默改成其它工作的分支。后续 `planRun` 可能因为元数据已经同步被改写而把它认成有效绑定。
- 最小修复：目标路径已占用且分支不匹配时明确失败，不改 task.json。正常重入只允许验证过的目标分支与 worktree。

## P2-1：会话结束清理未检查仍在运行的子任务

- 位置：`modules/session-worktree/index.ts:451–461`；`extensions/coworkflow.ts:401–418` 明确说明 session_shutdown 也会在 reload 和会话替换时触发。
- 当前条件：source 为 session、worktree 干净且 ahead 为零，就删除 worktree 和分支。没有查询 run 占用，也没有与 child 生命周期联动。
- 复现：在临时会话 worktree 内启动一个普通 Node 进程作为尚未写入的 child 替身；调用模块 `onSessionEnd` 后，进程仍可响应 IPC，但 worktree 路径已经不存在。
- 影响：后台任务仍处于阅读、推理或即将写入时，目录可能被回收；可能导致后续读写失败。测试没有声称丢失已写入代码，dirty 检查仍能保护它们。
- 最小修复：有运行者或无法确认占用时保留；只有确认所有相关运行者结束，且目录干净、没有未集成提交时再清理。不要为此重建一套运行器。
- 证据边界：验证了清理实现和本地进程的竞态条件，未证明本机每一种真实 Pi shutdown 顺序都会撞上它，因此列 P2。

## P2-2：有效目录被误当成有效 Trellis 任务

- 位置：`modules/subagent-context/index.ts:194–209,248–254`；`core/trellis.ts:112`。
- 复现：`Active task: .trellis/spec` 在目录存在时被接受为 `{kind:'task'}`，即使没有 task.json。
- 原因：路径解析后的校验只有 `isDirectory()`，没有校验任务目录结构或任务记录。
- 影响：错误引用不会进入 invalid 分支，child 以为已经绑定任务，却拿不到应有的 PRD/设计/实施资料。对真正 invalid 的引用，现有指令还会要求“先按派单提示词本身工作”，并不是阻止写入的 fail-closed 行为。
- 最小修复：校验项目内任务目录、task.json 和身份。独立工作仍用显式 `(none)`；对失效任务绑定应停止任务相关写入并返回错误，不悄悄按无任务继续。

## P2-3：files 的等价路径能绕过重叠保护

- 位置：`modules/dispatch/index.ts:323–331,618–633`。
- 复现：`overlapOf(['src/a.ts'], ['src/a.ts'])` 命中；`overlapOf(['src/a.ts'], ['src/x/../a.ts'])` 返回 null。入队预处理只去首个 `./`、尾部 `/` 和替换分隔符，保留上述 `..`。
- 影响：两份声明指向同一文件，但共享 worktree 中仍可同时启动，违反“已声明重叠会排队”的承诺。
- 最小修复：在队列边界将声明统一到 worktree 相对规范路径，折叠 `.`/`..`，拒绝越界路径；根目录声明应覆盖全树。对符号链接/大小写按平台明确支持范围，不承诺字符串比较能保护所有文件别名。
- 附带源码证据：`:582–584` 只有“未声明任务数量大于 1”才警告。一份未声明任务与一份已声明写任务并行时不警告，与主 AGENTS 的无条件提醒说法不一致。可一起补齐提示，仍保留未知范围允许并行的原取舍。

## 已合理的部分与需要纠正的旧判断

- 主会话负责规划、实施、验收与集成；没有必须经过多 agent 的固定流水线。这部分不应再改回去。
- executor/worker 按判断需求区分；planner/researcher 按用途与上下文档位区分。五类模型可独立配置，上一轮真实会话验证继续有效；本轮没有重复测试模型路由。
- planner 的 `context: task` 与通用字节预算、默认 research 的 spec tree 已存在，不应再作为“未实现”报告。
- 审计者只读、主会话负责修复的职责文案一致。这里是合作协议，不是操作系统级只读沙箱；本轮不要求为了审计新增复杂沙箱。
- `acceptance-report` 的来源需纠正：当前 kind 注册没有提供 acceptanceRole/defaultAcceptance；上游 `src/runs/shared/acceptance.js:80–86` 的默认轻量 attestation，以及 `:540` 的提示词，会要求 fenced report。因此它不能作为 auditor 自行扩大任务的证据。若要减少只读调用的输出，应在上游支持的 acceptance 配置处明确策略，不能只在 auditor 文案再加“不要输出”。不要顺带给 writer 全部开启强制 reviewer，避免重新引入固定多 agent 流程。
- 任务材料优先从主检出读取，是为了避免 worktree 中提交快照过期；此取舍本身合理。需要修的是 task identity 与 cwd 的一致性，不是把受跟踪的 `.pi/.trellis` 改成软链。

## 修复次序与验收范围

1. 明确项目上下文继承，修复 start 时异分支目录认领。这两项各有单一边界。
2. 将任务解析结果贯穿 child 会话与 placement；同时覆盖任务切换、显式 `(none)`、后续指令及 invalid 情形。
3. 让会话 worktree 清理受运行者占用约束；规范化 files 并补充缺失警告。
4. 文档只同步已经实施的契约，不追加大段重复规则。验证以本报告触发条件为准，加必要的真实本地 Pi 注入探针；不重跑五个远端模型。

本次复现：`node .trellis/tasks/<本任务目录>/probes.mjs`（归档后从仓库根目录使用实际归档路径）。脚本依赖本机当前 pi-subagents 安装路径；只用于保存本次环境的证据，不是新生产测试框架。详细机器输出见 `probe-results.jsonl`。
