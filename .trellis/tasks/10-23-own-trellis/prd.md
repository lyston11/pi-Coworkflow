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

- [x] 渲染路径不调用全局 `trellis`；无 CLI 场景由测试覆盖，`--trellis-update` 已标记废弃。
- [x] `.trellis/workflow.md` 的 Pi 块只讲 kind / `cw-*`；模板同源。
- [x] `templates/trellis/dot-pi/agents/` 只有 `.gitkeep`；项目 `.pi/agents` 无 `trellis-*`。
- [x] 迁移用例：旧 `trellis-*` agent 与旧 Pi 引导 → 覆盖为模板版本并报告升级；`tasks/spec/workspace` 永不写入。
- [x] 幂等用例：第二次渲染零写入。
- [x] `npm test` 287/287、`tsc` 干净；golden test 锁住模板与主检出资产逐字节一致（集成时我改了 workflow.md 两处，golden 立刻失败并逼我同步模板——它真的在工作）。

## 交付与残留

集成到 `main`：`076d5f9`（实现，107 文件含 81 个模板文件）+ `05a691a`/`e8881d2`（任务归档）。两个子任务已归档，worktree 与分支已清理。

不再保留的过渡论证：**「`trellis update -s` 跳过已改文件所以就地改安全」已从代码、注释、测试、spec、README、workflow.md 中全部删除**（`rg 'skip-all|update -s'` 除「不要手工跑」的禁令与上游历史案例外零命中）。`retireRoleAgents()` 的唯一理由现在是老项目迁移清理。

残留：

- `trellis mem` / `trellis channel` 仍依赖全局 CLI，本包不自带（明确不做）。
- `templates/trellis/dot-trellis/scripts/` 是 Trellis 的 Python 工具集副本，今后 bug 由本仓负责修。
- `.trellis/spec/guides/*.md` 里引用 `trellis update` 的段落是上游历史案例，未改（不影响机制）。
