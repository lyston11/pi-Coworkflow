# One role declaration

## Goal

`role` 只存在于 kind 定义文件；本包不再有第二份 kind→role 表，也不再从会话名猜角色。

## 已确认的重复

| 位置 | 现状 | 问题 |
|---|---|---|
| `modules/agent-kinds/defaults.ts` 的 `BUILTIN_KINDS[].role` | shipped kind 的 role 写死在 TS | 与 kind 定义文件 frontmatter 的 `role` 重复 |
| `modules/subagent-context/index.ts` 的 `asRole` / `AGENT_RE` | 从会话名 `trellis-<role>` 猜角色 | kind 时代的历史包袱，让「角色」作为平行身份继续存在 |

`kindRole(kind, definitions)` 已经优先读定义文件，`builtinKind(kind)?.role` 只是兜底——这次把兜底也移除。

## 需求

- R1 shipped kind 的 role 移入资产 frontmatter（`modules/agent-kinds/assets/<kind>.md` 增加 `role:` 行），`BUILTIN_KINDS` 不再有 `role` 字段。
- R2 `kindRole()` 只看定义文件（`definitions.get(kind)?.role`）；未声明 = `null`（不注入角色上下文）。
- R3 `subagent-context` 删除按 `trellis-<role>` 名字猜角色的路径，只保留：kind 定义文件的 role、派单提示词里的 `<!-- trellis-agent: <role> -->` 标记。`trellis-*` 名字不再触发任何注入。
- R4 注入结果不退化：`cw-executor` 仍拿到 implement 上下文、`cw-auditor` 拿 check、`cw-researcher` 拿 research、`role: none` 不注入。
- R5 已有测试全绿；为 R3 加一条「`trellis-check` 名字不再获得 check 上下文」的反向断言。

## 验收

- [ ] `rg 'trellis-' modules/subagent-context/index.ts` 只剩说明性注释或零命中。
- [ ] `BUILTIN_KINDS` 无 `role` 字段；资产带 `role:`。
- [ ] `npm test`、`tsc` 干净；`role: none` 行为不变。
