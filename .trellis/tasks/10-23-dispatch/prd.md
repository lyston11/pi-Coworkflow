# Unified dispatch

## Goal

让「派出去」在三条路径上都成立：**准入只有一个权威**、**派单参数不用模型自己算**、**超过上限自动排队续派**；并且对管不到的启动形状明说边界，而不是假装覆盖。

## 三个缺口与本轮交付

| 缺口 | 交付 | 验收 |
|---|---|---|
| 准入按调用形状识别，脚本 `runs.run` 绕过 | 抽出 `admitOne()` 作为唯一准入；直接派单与批次都调它；新 dispatch 通道每次启动前也调它；**无法治理的形状显式拒绝** | 三处启动点共用同一函数；一个"不治理形状"的负面用例 |
| 直接派单缺预算/context/checkpoint | `applyDispatchDefaults()` 在 `tool_call` 里补齐，用户显式值优先 | 缺字段被补、显式值不被覆盖 |
| 超上限整批拒绝、要模型自己拆批续派 | `coworkflow.dispatch`：一次交全部工作单元，按 kind 上限排队，完成一个自动启动下一个；支持 `needs` 依赖 | 上限 2 交 4 个 → 2 跑 2 排队 → 完成一个自动启动下一个 |

## 契约（先定，后续并行实现按此写）

```ts
// modules/agent-kinds/index.ts（导出）
export type AdmitFailure =
  | { code: "session-gone" }
  | { code: "disabled" }
  | { code: "unregistered" }
  | { code: "unknown-count"; reason: string }
  | { code: "over-ceiling"; limit: number; occupancy: number; requested: number };

export type AdmitResult =
  | { ok: true; kind: string; policy: ResolvedAgentKind }
  | { ok: false; failure: AdmitFailure };

export async function admitOne(
  host: PiRuntimeHost,
  state: State,
  runtime: RuntimeContext,
  request: { kind: string; count?: number },
): Promise<AdmitResult>;

export function applyDispatchDefaults(
  input: Record<string, unknown>,
  policy: { agent: string },
  config: WorkflowConfig | null,
): string[];   // 返回补上的字段名，空数组表示没有补
```

```ts
// modules/dispatch/index.ts（新模块，工具 `coworkflow.dispatch`）
type DispatchInput = {
  tasks: { key?: string; kind: string; task: string; needs?: string[] }[];
  worktree?: boolean;
};
type DispatchResult = {
  started: { key: string; runId: string; kind: string }[];
  queued: { key: string; kind: string; reason: "ceiling" | "dependency" }[];
  failed: { key: string; kind: string; reason: string }[];
};
```

## 不做的

- 不自己起子进程：排队后的启动走上游公开 RPC `spawn`（async-only，同一 executor）。
- 不持久化队列：进程内状态，`/Coworkflow:status` 报告；会话换代即作废（并如实报告，不当作空队列）。
- 不声称治理第三方脚本内部的 `runs.run`：那是别人的进程内调用，我们看不到；边界写清并由测试钉住我们能拦的形状。

## 验收

- [ ] `npm test`、`tsc` 干净。
- [ ] 三条路径都经过 `admitOne`（测试：同一 kind 在同一状态下，三处给出同一 failure code）。
- [ ] 直接派单缺 `options.context` / `timeoutMs` 时被补齐；显式值不被覆盖。
- [ ] 上限 2、提交 4 个 → 2 started + 2 queued；模拟完成 → 自动启动下一个。
- [ ] `needs` 未满足的任务保持 queued，前置完成后才启动。
- [ ] 不治理形状（脚本内 `runs.run`）被显式拒绝并说明原因。
- [ ] `/Coworkflow:status` 报告队列长度与排队原因。
