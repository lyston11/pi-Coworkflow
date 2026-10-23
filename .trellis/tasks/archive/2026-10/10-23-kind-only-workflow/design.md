# 设计：Pi 分支 kind-only + trellis-* agent 的幂等守卫

## 为什么改文件而不是改模板源

`trellis` 是全局 npm 包，本仓没有它的模板源。`.trellis/workflow.md` 是**本项目的文件**（git 跟踪），且本包 init 跑 `trellis update -s`（跳过所有已改文件）——就地修改不会被覆盖。因此「我们的改版」落在项目文件上，而不是全局包。

## 守卫（新增）

`modules/trellis/index.ts` 已有 Trellis 对齐路径（`trellis update` / version 检查）。新增一个纯函数：

```
retireRoleAgents(root): { removed: string[]; kept: string[] }
```

- 只处理三个固定相对路径：`.pi/agents/trellis-implement.md`、`trellis-check.md`、`trellis-research.md`。
- 存在则删除并记录；不存在则记为 kept（不报错）。
- 由 init 的对齐步骤在 `trellis update -s` **之后**调用一次，报告「已移除 N 个角色 agent（trellis-* 不再生成，下次 update 后会自动再移除）」。

为什么需要它：`-s` 只跳过「已修改」的文件，**已删除的不受保护**，`trellis update` 会重新生成。守卫是这个缺口唯一诚实的补法。

## workflow.md 的改写边界

Pi 相关块用平台标记划定：`[codex-inline, Pi, Kilo, Antigravity, Devin, DeepSeek Harness]` … `[/…]`。只改这些块内部的：

1. 「Spawn the implement sub-agent / Agent type: trellis-implement」→ kind 版本（派 `cw-executor`，名字以 `/Coworkflow:status` 为准）；
2. 「Spawn the check sub-agent / Agent type: trellis-check」→ `cw-auditor`；
3. research 步骤里的 `Agent type: trellis-research` → `cw-researcher`；
4. Pi 的 inline 五步（读规范→实现→跑检查）→ 派单 + 主会话验收。

块外（例如 275-280 行的多平台总则、`[Claude Code, …]` 块）不改：那描述的是别的平台的派单协议，本任务不越界。

## 测试

- 守卫：临时目录里放入三个文件 → 运行 → 文件消失、报告两条；再运行 → 不报错、结果相同。
- workflow.md：断言 Pi 块内不再匹配 `Agent type: trellis-`，且非 Pi 块文本与改动前一致（快照字符串）。

## 失败模式

| 失败模式 | 要求 |
|---|---|
| 守卫删了又生、生生不息 | 每次 init 都删，且报告说清「update 会重建，下次 init 再清」 |
| 改到别的平台块 | 测试用块文本断言守住 |
| 重复改写产生漂移 | 幂等测试：第二次运行 diff 为空 |
