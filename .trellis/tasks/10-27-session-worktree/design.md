# 技术设计：会话级 worktree 隔离

## 一句话

新增 `session-worktree` 模块，惰性为每个 pi 会话分配（或复用任务）一个 linked worktree，把它的路径作为**所有子 agent 启动的 cwd**，并提供 `/Coworkflow:merge` 与退出清理。分配/注入/合并各自是独立失败点，任一处不允许静默降级为共享 cwd。

## 为什么是新模块，而不是改 dispatch/fanout 默认值

三个理由，都不是风格问题：

1. **上游 `worktree: true` 不能用**。它要求 clean source（`pi-subagents/src/runs/shared/worktree.js:204`），而用户的主检出常态是脏的；且它按 child 分配 `worktrees/<project>/pi-worktree-<runId>-<index>` 并要求手 `git apply` patch 回来。我们要的是「会话一个分支、直接改文件、最后 `git merge`」，语义不同。
2. **隔离单元不是「一次调用」而是「一个会话」**。`worktree: true` 是 per-launch，会让同一会话的 5 次派单落在 5 个互不相干的分支上，合并变成 5 次。
3. **可关闭**。模块化后 `modules` 里关掉 `session-worktree` 就恢复现有行为（含现有 opt-in `worktree: true`），不需要回退代码。

## 组件与边界

```
modules/session-worktree/index.ts        WorkflowModule（id: session-worktree）
  ├─ resolve(host, runtime)              → SessionTree | Failure   解析（缓存 per sessionEpoch）
  ├─ allocate(...)                       → 建 branch + git worktree add + 软链记录目录
  ├─ injectCwd(event)                    tool_call: mutate input.cwd
  ├─ statusLines(host)                   runtimeStatus 行
  └─ merge(host, args)                   /Coworkflow:merge
modules/index.ts                         注册新模块
modules/dispatch/index.ts                spawn 参数里加 cwd: session tree（无则失败）
modules/subagents/index.ts               fanout / implement-review 的 spawn 加 cwd（implement-review 保持 planRun）
modules/agent-kinds/index.ts             注入后的 input 仍然只做准入判断，不改写
```

`resolve()` 的优先级（PRD R1）：

1. 活跃 Trellis 任务且 `planRun()` 通过 → 用它（复用 `modules/subagents/index.ts:866` 已有校验，不重写一遍 git 判定）。
2. 否则会话级：`<repoParent>/wt-cw-<sessionShort>`，分支 `cw/<sessionShort>`，从 `origin/HEAD`（无远端则 HEAD）建。
3. 已存在且归属正确（分支匹配、是本仓库 linked worktree）→ 复用，幂等；归属不符 → 失败，不覆盖。

`sessionShort` = `runtime.sessionId` 的稳定短散列（会话替换 = 新 epoch = 新散列，不复用旧 worktree）。

分配时要软链的记录目录与 `auto_worktree.py` 的 `MATERIALISE` 保持一致：`.trellis/{tasks,scripts,workspace,config.yaml,workflow.md}` 与 `.pi`。理由已在那个 hook 的注释里写清：worktree 只有已提交文件，而子 agent 需要 PRD、spec、kind 定义与项目配置。**软链，不复制**——共享记录不能有两份历史。

## cwd 注入

pi 允许 `tool_call` handler 就地改 `event.input`（`docs/extensions.md:208,218`）。所以：

```ts
host.on("tool_call", (event) => {
  if (event.toolName !== "subagent") return;
  if (!launchesChildren(event.input)) return;      // status/stop/steer/list/validate/resume 一律不碰
  if (event.input.cwd !== undefined) return;        // 调用方显式指定，尊重
  event.input.cwd = tree.path;                     // 就地注入
});
```

`launchesChildren` 复用 `childrenOfCall` 已有的形状判断（`modules/subagents/index.ts:176`：fanout → 按 tasks，implement-review → 2，其余 → 1），加上 action 白名单：带 `action` 的调用是管理面，不注入。

`coworkflow_dispatch` 不走 `tool_call`（它自己就是工具），所以在 `spawnViaRpc` 的参数里直接加 `cwd`（`modules/dispatch/index.ts:737`）。两者共用同一个 `resolve()` 结果，不允许各自算一遍。

## 失败语义

| 情况 | 行为 |
|---|---|
| 不是 git 仓库 | 写类派单拒绝，理由写明「无 git，无法隔离」；状态行显示原因 |
| `git worktree add` 失败 | 同上，附 git stderr |
| 任务 worktree 校验失败 | 退回会话级分配（任务本身有问题不该阻塞隔离），状态行记下退回原因 |
| 已有同名分支/worktree 但归属不符 | 拒绝，**不**覆盖、不 `--force` |
| resolve 曾在本次派单成功后失效（worktree 被外部删除） | 下次派单重新 resolve；缓存 key 含 sessionEpoch |

## `/Coworkflow:merge`

```
1. 读状态：git -C <worktree> status --porcelain  → 非空即拒绝（未提交改动）
2. git -C <worktree> log --oneline <base>..HEAD  → 空则「无事可合并」并给出清理提示
3. 合并：在基线分支的检出上 git merge --no-ff <branch>
   - 冲突 → 停下，输出冲突文件清单，保留现场，不自动解、不 push
4. 成功后不自动删 worktree：由清理步骤在「已合并 + 干净」时才删（PRD R5）
```

合并动作本身用 `execFileSync` + 明确的 `-C`，不依赖进程 cwd；输出原样回传。

## 观测（`/Coworkflow:status`）

一行显示：`worktree: <path> · branch cw/<id> · base main · clean|dirty · N commits ahead`。没有隔离时一行原因（例如 `worktree: 未启用（session-worktree 关闭）` / `分配失败：…`）。这是 PRD R6 的落地形式，也是避免「以为隔离了其实没有」的唯一手段。

## 测试计划

- `scripts/session-worktree.test.ts`（新增）：优先级（任务 vs 会话）、脏主检出也能分配、幂等复用、归属不符拒绝、无 git 拒绝、软链集合正确、`sessionEpoch` 变化后重新分配。
- `scripts/dispatch-*.test.ts`：spawn 参数含 `cwd`；resolve 失败时派单被拒且理由正确。
- `scripts/agent-kinds.test.ts`：注入后 gate 仍按 kind 判定，管理面调用不被改写。
- 真实会话：两个 pi 进程并发派 executor，确认落在两个 worktree、主检出无改动、`/Coworkflow:merge` 各自合并。

## 风险

- **父会话自己写主检出**：本设计不拦截父会话的文件写入（它有正当写文档/配置的时候）。缓解是状态行明示 + AGENTS 受管区把「业务代码由子 agent 在 worktree 里写」写死。若要硬拦，另开一条规则，不在本任务。
- **基线漂移**：会话 worktree 从启动时的 HEAD 建分支，长时间会话会落后。合并前 `git log base..HEAD` 会显示；是否自动 merge 上游基线由人决定（项目规则本来就禁止自动 rebase）。
- **多会话同基线**：各自分支独立，合并顺序由人定；本设计不引入自动串行通道。
