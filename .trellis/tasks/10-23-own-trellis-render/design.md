# 设计：模板即真相，渲染即安装

## 为什么是「模板」而不是「fork CLI」

要脱钩的只有**产物**，不是生成器：`.trellis/scripts/**` 已验证不调 `trellis` 二进制，所以只要产物由本仓提供，整条链路就自洽。修复上游 bug 的能力我们本来就没有（用的是发布版），所以放弃上游更新没有额外损失。

## 模块结构

`modules/trellis/index.ts` 现有职责（版本检查、调用外部 `trellis` 生成器）改为：

```
renderTemplate(ctx)                 // 新：纯文件渲染，返回报告
  ├─ planTemplate(root)             // 计算要写/要跳过的文件清单（纯函数，可测）
  ├─ migrateLegacy(root)            // 旧产物检测与覆盖
  └─ writePlanned(root, plan)       // 原子写、幂等
probeOptionalCli(ctx)               // 新：仅探测 mem/channel
```

`planTemplate` 是纯函数：输入 root + 模板根 + 已存在文件内容，输出 `{writes, skips, migrations}`。测试直接断言它，不需要真跑 init。

## 数据/资产边界（最重要的一条）

| 路径 | 归属 | 渲染行为 |
|---|---|---|
| `.trellis/workflow.md`、`.trellis/agents/`、`.trellis/scripts/` | 本包 | 模板覆盖 |
| `.trellis/config.yaml` | 用户 | 只在缺失时写入；存在则补缺失 key |
| `.trellis/tasks/`、`.trellis/spec/`、`.trellis/workspace/` | 用户 | 永不触碰 |
| `.pi/agents/`、`.pi/extensions/trellis/`、`.pi/prompts/` | 本包 | 模板覆盖（模板里没有 `trellis-*`） |
| `.agents/skills/trellis-*` | 本包 | 模板覆盖 |
| `.pi/Coworkflow.json`、`.pi/settings.json` | 本包/用户 | 不动（现有模块负责） |

## 迁移

`migrateLegacy` 的两条触发条件（任一命中即升级）：

1. `.pi/agents/trellis-{implement,check,research}.md` 任一存在；
2. `.trellis/workflow.md` 的 `[codex-inline, Pi, …]` 块里仍出现 `Agent type: trellis-`。

升级动作就是「按模板覆盖 + 删除旧 agent」，报告里写明 `旧产物 → 本仓模板`。

## 失败模式

| 失败模式 | 要求 |
|---|---|
| 覆盖用户写过的 `config.yaml` | 禁止：只补缺失 key，用户值原样保留 |
| 渲染半途失败留下混合状态 | 每个文件原子写；失败的文件报错并继续，报告列出失败清单 |
| 第二次 init 重写文件导致 mtime 抖动 | 内容相同则跳过（不算写入） |
| 没装 CLI 就当失败 | 只报告「可选功能不可用」，退出码成功 |
