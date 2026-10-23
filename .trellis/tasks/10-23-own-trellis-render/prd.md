# Render the bundled Trellis

## Goal

`templates/trellis/` 随包发布，`/Coworkflow:init` 直接渲染它，取代 `trellis init/update`。

## 需求

- R1 模板目录（打包内相对路径固定）：
  ```
  templates/trellis/
    dot-trellis/{workflow.md,config.yaml,agents/,scripts/}
    dot-pi/{agents/, extensions/trellis/, prompts/}
    dot-agents/skills/
  ```
  `dot-*` 前缀表示渲染到对应的点目录，避免模板目录本身被工具扫描。
- R2 渲染规则：
  - **本包拥有的资产**（上述全部）：以模板为准写入，已存在且内容相同则跳过（报告「已是最新」）。
  - **用户数据**（`.trellis/tasks|spec|workspace`）：永不写入、永不删除。
  - **`.trellis/config.yaml`**：不存在则写模板；存在则只补缺失的 key（不覆盖用户值）。
- R3 版本标记：`.trellis/.version` 写本包模板版本（`pi-coworkflow@<version>`），供报告用；不再与全局 CLI 比较。
- R4 迁移：渲染前检测旧状态——`.pi/agents/trellis-{implement,check,research}.md` 存在，或 `.trellis/workflow.md` 的 Pi 块含 `Agent type: trellis-`——命中则按模板覆盖并报告「已从旧 Trellis 产物升级到本仓模板」。
- R5 全局 CLI 不再必需：`runUpdate()` 对外部生成器的调用删除；`trellis` 存在只用于探测可选功能（`mem` / `channel`），不存在时报告一行「可选：未安装全局 trellis CLI，mem/channel 不可用」，不报错。
- R6 `package.json#files` 加入 `templates/`。
- R7 测试：
  - golden：模板渲染结果与当前主检出对应文件逐字节一致；
  - 幂等：重复渲染第二次无写入；
  - 用户数据保护：`tasks/` 下放一个文件，渲染后仍在；
  - 迁移：构造旧状态 → 渲染 → 旧 agent 消失、Pi 块更新、报告含升级说明；
  - 无 CLI：`PATH` 里没有 `trellis` 时渲染仍成功。

## 不做

- 不动 `modules/agent-kinds/`、`modules/subagents/`。
- 不实现 `mem` / `channel` 的本地替代。

## 验收

- [ ] 上述 5 条测试全绿；`npm test`、`tsc` 干净。
- [ ] 模板目录被 `npm pack --dry-run` 包含。
- [ ] 渲染后 `.trellis/workflow.md` 的 Pi 块只讲 kind。
