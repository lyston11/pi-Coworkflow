# Own the Trellis surface

## 决定

**装了 pi-Coworkflow 的项目，用的就是本仓这套魔改 Trellis。** 不依赖全局 `trellis` CLI，不需要同步给其它项目，也不需要「先 trellis init 再由本包打补丁」这两段式流程。

## 已核实的前提

| 事实 | 结论 |
|---|---|
| `trellis` 是全局 npm 包 `@mindfoldhq/trellis@0.6.17`，本仓无源码 | 所以要自带的是它的**产物模板**，不是它的生成器 |
| `.trellis/scripts/**` 只 `subprocess` 调 `git`，**没有调 `trellis` 二进制** | 这套 Python 工具自洽，脱钩后照常工作（`task.py`、`get_context.py`、hook 等） |
| `.trellis/` `.pi/` `.agents/` 都是项目内文件 | 可以被本包直接渲染，无需 CLI |
| `package.json#files` 目前只有 `core/ extensions/ modules/ scripts/` 等 | 加模板目录，否则发布包里没有模板 |

## 需求

- R1 新增 `templates/trellis/`，内容是**本仓已魔改并验证过的**那套资产：`.trellis/{workflow.md,config.yaml,agents/,scripts/}`、`.pi/agents/`、`.pi/extensions/trellis/`、`.pi/prompts/`、`.agents/skills/`。不含用户数据（`tasks/`、`spec/`、`workspace/`）。
- R2 `/Coworkflow:init` 的 Trellis 步骤改为**渲染模板**，不再调用 `trellis init` / `trellis update`；全局 CLI 从「必需」降级为「可选」（只有 `mem` / `channel` 之类运行时功能需要，缺了要如实报告，不阻塞安装）。
- R3 用户数据永不覆盖：`tasks/`、`spec/`、`workspace/` 及项目自己写的 `config.yaml` 不被模板重写。
- R4 老项目迁移：检测到旧的 `trellis-*` 角色 agent 或旧 Pi 引导（「自己实现」）时，就地升级为本仓模板版本，并报告升级了什么。
- R5 `trellis-*` 角色 agent 不再由模板产出；`retireRoleAgents()` 保留为迁移期的清理步骤（老项目仍需要），新装项目不再产生它们。
- R6 `.trellis/.version` 与「本机 CLI 版本不一致就报警」的逻辑改为按模板版本报告；不再因为没装全局 CLI 而报错。

## 不做

- 不 vendor Trellis 的生成器与 `mem` / `channel` 运行时（那是 V2，工作量与维护成本再上一个量级）。
- 不删除 `.trellis/scripts/`（它已经是本仓在用的代码）。
- 不改 `.trellis/.template-hashes.json` 的语义以外的 CLI 元数据。

## 子任务

| 子任务 | 交付物 |
|---|---|
| `10-23-own-trellis-render` | `templates/trellis/` + 渲染器 + 迁移 + golden/幂等测试 + `package.json#files` |
| `10-23-own-trellis-docs` | README / 受管区 / spec 改成「模板自带、CLI 可选」 |

## 验收

- [ ] 干净目录里只有本项目 → `/Coworkflow:init` 产出完整 `.trellis/` 与 `.pi/` 资产，**没有全局 `trellis` 也能成功**。
- [ ] 产出物里 `rg 'Agent type: trellis-' .trellis/workflow.md` 无命中（Pi 块）。
- [ ] `ls .pi/agents` 没有 `trellis-*`。
- [ ] 已有项目（本次迁移对象）跑一次 init 后 diff 只包含预期升级，`tasks/spec/workspace` 零改动。
- [ ] 重复 init 幂等（第二次 diff 为空）。
- [ ] `npm test`、`tsc` 干净；golden test 锁住模板与当前主检出资产一致。
