# State the new ownership

## Goal

文档与受管区如实说明：模板随包而来，全局 `trellis` CLI 是可选项。

## 需求

- R1 `README.md`：安装步骤删掉「先装 trellis CLI / 先 trellis init」；写明「模板随包，`/Coworkflow:init` 渲染」，`trellis` 仅 `mem` / `channel` 需要。
- R2 受管区（`modules/agents/assets/main-AGENTS.region.md`）：把「范式由 `trellis update` 对齐到本仓版本」改成「Trellis 资产由本包模板渲染；不要手工跑 `trellis update`，会得到混合状态」。
- R3 spec（`.trellis/spec/frontend/subagents-integration.md`、`agent-kinds.md`）：把「Retiring the trellis-* role agents」的因果从「事后删除」改为「模板不产出，守卫只服务老项目迁移」。
- R4 不夸大：明确写出我们**不**自带 `trellis mem` / `channel`，缺 CLI 时这两项不可用。

## 验收

- [ ] README 的安装流程在只有本包、没有全局 CLI 的前提下可完成。
- [ ] 受管区不再出现「跑 `trellis update` 对齐」。
- [ ] spec 两处因果改写完成，且与新代码一致（模板不产出 `trellis-*`）。
- [ ] `npm test` 全绿（受管区渲染相关断言未破坏）。
