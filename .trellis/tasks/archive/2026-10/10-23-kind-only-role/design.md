# 设计：role 的唯一真相在定义文件

## 数据流（改后）

```
.pi/Coworkflow/agents/<kind>.md  frontmatter: role: implement|check|research|none
        │  (shipped kinds 的同名资产 modules/agent-kinds/assets/<kind>.md 提供默认)
        ▼
readKindDefinitions() → definitions.get(kind).role
        ▼
kindRole(kind, definitions) → SubagentRole | null
        ▼
subagent-context：注入 implement.jsonl / check.jsonl / spec 树，或（null）不注入
```

## 具体改动

1. `modules/agent-kinds/assets/{executor,auditor,researcher}.md`：frontmatter 增加 `role:`（implement / check / research）。
2. `modules/agent-kinds/defaults.ts`：删除 `BuiltinKind.role` 字段与三个取值；`kindRole()` 删掉 `builtinKind(kind)?.role` 兜底。
3. `modules/subagent-context/index.ts`：删除 `asRole()`、`AGENT_RE` 与会话名匹配；`resolveRole` 只剩 marker + kind 定义文件两条来源。
4. 资产读取：确认 `readKindDefinitions`/`definitionDefaults` 会把 shipped 资产的 frontmatter 并入 definitions（若目前只读项目 `.pi/Coworkflow/agents/`，需要在 shipped 资产一侧解析并合并）。

## 风险与处理

| 风险 | 处理 |
|---|---|
| shipped 资产解析出错 → 三个默认 kind 失去上下文 | 合并失败时按 kind 隔离：该 kind role 视为 null 并报告，不影响其它 kind |
| 删掉名字匹配后，用户手写 `agent: trellis-check` 期待注入 | 这是有意的：kind 时代不认旧名字；报告与 spec 写明 |
| `role: none` 语义被改 | 测试守住：none 仍= 不注入，且不是 null 的同义词混淆 |

## 测试

- 正向：`cw-executor` / `cw-auditor` / `cw-researcher` 各自拿到对应上下文（既有用例）。
- 反向：派单 `agent: "trellis-check"` 不再获得 check 上下文。
- 定义文件覆盖：项目写 `role: none` → 不注入；写 `role: research` → 注入 research。
