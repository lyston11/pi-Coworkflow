# child-tail — 子会话日志尾部读取（当前动作）

## 结论

实现完成，`npx tsc --noEmit` 干净，`npm test` **195 / 195 通过**（含新增 11 个测试）。唯一未做的是一项被禁改的文档：`README.md` 的「没有实时正在做什么」段落（另一个 child 正在改该文件），已在下方给出确切替换文本。

## 机制：为什么是「尾部读」而不是「实时流」

`pi.events` 是进程内的，子会话的工具调用不会流回父会话 —— 这条限制没有变，也没有被绕过。但公开 `cost` 回复给每个可读取的 child 一个 `sessionFile`，而本包**本来就在读这些文件**（`core/usage.ts` 的有界读取：精确绝对路径、`O_NONBLOCK`、先 `stat`、拒绝非普通文件、不 glob、不列目录）来拼子用量历史。读它的**尾部**就能回答「它最近在做什么」。

所以供给的是 `正在 <action>（读自子会话日志尾部）`，不是「它此刻正在做」。这个区分写进了代码注释、面板行、spec。

## 新增文件

### `core/child-tail.ts`（新，约 300 行）

导出：

| 符号 | 作用 |
|---|---|
| `readChildTail(path, budget?)` | 读一个绝对 sessionFile 的尾部，返回 `ChildTail` |
| `refreshChildTails(host, runtime, cost)` | 从一次公开 `cost` 回复重建 runId → action 缓存 |
| `childTailActions(host, runtime)` | 同步渲染用的缓存查询，不触 I/O |
| `disposeChildTails(host)` | 会话结束/模块关闭时丢弃 |
| `formatChildAction(action)` | `bash npm test` / `输出「…」` |
| `MAX_TAIL_BYTES = 64 * 1024`、`MAX_HINT_CHARS = 60`、`MAX_TAIL_RUNS = 16` | 预算常量，测试直接断言它们 |

行为：

- **有界尾部读**：`open(path, O_RDONLY | O_NONBLOCK)` → `stat` → 非普通文件直接拒绝 → `offset = max(0, size - limit)`，在 `offset` 处 `read`，循环到读满或 EOF。返回 `bytes` 与 `offset`，测试断言 `offset === size - MAX_TAIL_BYTES`。
- **JSONL 容错**：从 offset 起读时首行几乎必然被切断，直接丢；其余逐行 `JSON.parse`，解析失败计入 `dropped` 而不失败整次读 —— 子会话仍在追写，半行是常态而非错误。
- **取值优先级**：尾部内最后一次 toolCall（`toolCall`/`tool_call`/`toolUse`/`tool_use`）→ 否则最后一段 assistant `text` → 否则 `action: null` 并带 `note`（显式缺席，不是空字符串）。
- **提示白名单**：`command`/`file_path`/`filePath`/`path`/`pattern`/`glob`/`query`/`url`。这是白名单而非「取第一个字符串参数」，因为 `edit`/`write` 的 `content`、`subagent` 的 `task` 分别是一整个文件正文和一整段提示词。序列化参数若不能 `JSON.parse` 就跳过（可能是整段提示）。提示压成一行（控制字符折叠）、截断到 60 字符加省略号。
- **永不抛**：不存在/不可读 → `无法打开子会话日志（不存在或不可读）`；目录 → `子会话日志不是普通文件`；相对路径或非字符串 → `子会话日志没有可用的绝对路径`；读中途失败 → `读取子会话日志失败`。全部是 `{ kind: "unknown", reason }`。
- **归属**：只用 `cost.children[].runId` + `sessionFile`，两者都来自同一条公开回复。没有 `runId` 或路径不是绝对路径的 child 不贡献任何条目 —— 不猜路径、不用 fleet key。
- **发布语义**：读完才发布（`generation` 单调递增），刷新中途的渲染看到的是上一轮结果而不是半成品；会话换代（`sessionEpoch`/`sessionId` 变化）、模块关闭、`disposeChildTails` 之后的在途结果都无法发布（`disposals` 记录进入 dispose 时的 generation）。
- **没有任何定时器**：文件里不含 `setTimeout`/`setInterval`，测试同时断言源码与运行时。

### `scripts/child-tail.test.ts`（新，11 个测试）

全部驱动生产代码：

1. 尾部最后一个工具调用胜出（即使其后有散文），带路径提示、`turns` 计数正确；
2. 助手文本兜底；空文件 → `action: null` + `note`，不是空串；
3. 半行被丢弃，用上一条记录，`dropped === 1`；
4. 大文件（约 256 KiB）只读尾部：断言 `offset === size - MAX_TAIL_BYTES`、`bytes === MAX_TAIL_BYTES`，且只找到尾部那条记录；小预算（4096）同样断言 offset/bytes；
5. 缺失 / 目录 / 相对路径 / 非字符串 全部显式未知，不抛；
6. 提示截断（长度恰为 61 = 60 + 省略号）且不含文件正文；`subagent` 的 `task` 不出现；
7. 控制字符被折叠，动作保持一行；
8. 归属只用 `runId`：无 `runId` 的 child 不贡献、相对 `sessionFile` 不贡献、fleet 的 `fleet-key-1` 查不到动作、`formatRunSummary` 输出里不出现 fleet key；一次 `kind: "unknown"` 刷新清空缓存（离开回复的 run 不留旧动作）；
9. 没有动作的 run 不打印 `正在`；
10. 尾部读取路径上不注册任何 `setTimeout`/`setInterval`/`setImmediate`（源码 + 运行时双重断言）；
11. 既有 `refreshUsage` 边界就是填充缓存的边界，`disposeUsage` 之后缓存清空。

`package.json` 的 `test` 脚本已追加该文件。

## 改动的既有文件

| 文件 | 改动 |
|---|---|
| `core/subagents-client.ts` | `formatRunSummary(activity, fleet, now, actions = new Map())` 新增可选第 4 参数；run 行在缓存有该 `run.id` 时追加 ` · 正在 <action>（读自子会话日志尾部）`，无条目时一个字符都不加。行数上限不变（`MAX_SUMMARY_RUNS = 8`），与 turns 无关。 |
| `core/usage.ts` | `refreshUsage` 在拿到 `cost`、读完子历史之后调用 `refreshChildTails(host, runtime, cost)`，再校验 `valid()` 才发布快照 —— 复用既有刷新边界（session start / `agent_settled` / 原生完成 / 面板打开），没有新增事件、没有新增定时器；`disposeUsage` 一并 `disposeChildTails`。 |
| `extensions/coworkflow.ts` | `facts()` 把 `childTailActions(runtimeHost, runtime)` 传给 `formatRunSummary`。面板 facts 块与 `/Coworkflow:status` 因此显示同一行。（`extensions/coworkflow.ts` 不在禁改清单内；它只是传一个缓存 lookup。） |
| `package.json` | `test` 脚本追加 `scripts/child-tail.test.ts`。 |
| `.trellis/spec/frontend/agent-kinds.md` | 「决定是否打断所需的可见性」里「明确**拿不到**：它此刻在读哪个文件、调哪个工具」替换为准确版本：拿不到的是**跨进程事件流**；能拿到的是子会话自己日志的**尾部**，附一张约束表（有界、容错、白名单、归属、边界、未知、来源标注），并明确「这条能力弱于实时，但强于没有：它回答『它刚在做什么』，不回答『它此刻正在做什么』」。 |

## 我没做的一件事（禁改文件）

`README.md` 约 408–412 行仍是旧措辞：

> **没有实时"正在做什么"。** 逐文件、逐工具的实时叙述只存在于上游的外部运行展示 API…

另一个 child 正在写 `README.md`，我没有改它。建议替换为：

```md
**没有跨进程的实时事件流，但有一份可读的尾部记录。** 逐文件、逐工具的实时叙述只存在于上游的外部运行展示 API，
不在 RPC `status` 里；`pi.events` 是进程内的，**不跨进程**，子会话的工具调用不会流回父会话。这一点没有变。
但公开 `cost` 回复给每个可读取的 child 一个 `sessionFile`，而本包本来就在读这些文件（有界、精确绝对路径、不扫目录）
来拼子用量历史。读它的**尾部**（默认 64 KiB）就能说出它最近在做什么，面板与 `/Coworkflow:status` 显示为
`正在 bash npm test（读自子会话日志尾部）`。

它是尾部读，不是实时：只能看到子会话已经 flush 的部分；半行记录会被丢弃；提示只取路径/命令/模式这几个白名单键并截断
（`edit`/`write` 的正文、`subagent` 的整段提示不会出现在面板）；读不到时显式显示未知与原因，不显示成「空闲」。
没有轮询、没有定时器，只在既有的刷新边界（会话开始、`agent_settled`、原生完成、面板打开）读一次。

判断要不要停，靠的是状态、耗时、目标、用量、最近动作这五个可归属事实，加上你自己的派单记录。
```

同节上方的表格行 `<td>某个 run 正在读哪个文件 / 调哪个工具</td><td>**不能**</td><td>见下</td>` 也应改成：

```md
| 某个 run 最近在做什么（调哪个工具、读哪个文件） | **能，是尾部读不是实时** | 公开 `cost` 回复的 `child.sessionFile` 的尾部，按 `child.runId` 归属 |
```

## 明确没有做的事

- 没有从 fleet key 推 runId —— 也没有 weakening 这条既有约束；测试里专门钉住 `actions.get("fleet-key-1") === undefined`。
- 没有在渲染或按键处理里读文件：`childTailActions` 只做 `WeakMap` 查表，且会话换代/关闭后返回空 map。
- 没有新增轮询、定时器、watchdog 或重试。
- 没有改 `pi-subagents`、`modules/subagents/index.ts`、`core/subagents-workflow.ts`、`modules/panel/settings.ts`。
- 没有把「最近动作」写进 lanes 记录（本任务范围是 `formatRunSummary` + facts 块；lanes 的 kind 分组归 Stage 3 另一处改动）。

## 验证（实际执行）

```
$ npx tsc --noEmit
（无输出，无错误）

$ node --experimental-strip-types --test scripts/child-tail.test.ts
ℹ tests 11  ℹ pass 11  ℹ fail 0

$ npm test
ℹ tests 195  ℹ suites 0  ℹ pass 195  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
ℹ duration_ms 12091.685667
```

`tsc` 全绿，因此没有需要豁免的 `subagents-workflow.ts` / `subagents/index.ts` 错误 —— 另一个 child 的在途改动当时是编译过的。
