# Audit prompt task injection and worktree contracts

## Goal
审查主会话、五种 kind、Trellis 任务与上下文注入、工作目录与 worktree、派单和验收的完整契约。

## Scope and constraints
- 审查当前源码、随包模板和已存在的真实子会话证据。
- 只写本任务审查工件；不修改生产代码、提示词和模型设置。
- 不重复已完成的五模型路由测试；仅用临时目录或纯内存探针确认本次具体疑点。
- 不派发新的模型任务；主会话独立完成。

## Acceptance criteria
- [x] 对任务身份、执行目录、上下文来源和验收所有权给出一致性结论。
- [x] 每个问题包含当前文件行号、触发条件、影响及最小修复建议。
- [x] 区分已复现缺陷、源码证据、设计取舍和未验证范围。
- [x] 明确哪些旧问题已解决，避免重复报告。

## Deliverable
`review.md`：审查报告与修复优先级。本任务为只读调查，无代码实施阶段，无需分配代码 worktree。
