# Blocker 修复交接

两项 blocker 已修复，误导性 `display: true` 注释已更正。最终 `npm run typecheck` 通过；`npm test` 实际日志结果为 **86 tests / 86 pass / 0 fail / 0 skipped**。

## 本次修改文件

- `extensions/coworkflow.ts`：在模块注册之前注册一个 `before_agent_start` 刷新监听器，使持久化会话标记先更新、子注入钩子后判断。shutdown 后该监听器保持静默，下一次 session_start 恢复。刷新先 ensureRuntime 再 activateSession；真实 setSwitch 启用模块后也补齐命令激活，沿用现有去重机制。
- `core/module.ts`：明确 `display: true` 仅控制显示，不会排除模型上下文；被动状态不得通过消息注入。
- `scripts/runtime-lifecycle.test.ts`：新增 6 个生产 extension 回归。对 unsubscribe/void 两种 host，分别覆盖初始开启、初始关闭的子会话，通过 `setSessionFlag` 修改持久化父会话 UUID 标记并验证下一次 before_agent_start 双向生效；通过真实 `controlSurface().setSwitch` 启用初始关闭的 subagents/lane-worktree，断言命令 map 出现 Coworkflow:run/Coworkflow:lanes，重复两轮切换无重复命令/监听器，关闭后命令拒绝执行。更新已有监听器数量断言以包含唯一的边界刷新监听器。
- `scripts/test.ts`：修正直接受本次行为变化影响的旧回归。该用例原本在子会话调用 start 并写 child id，却声称验证父会话标记；改成 `setSessionFlag` 写实际父会话 id，使断言符合生产继承契约。

## 检查与结果

实际执行命令：

1. `npm run typecheck` — 通过。
2. `npm test` — 初轮失败。新 fixture 的非 UUID 父会话文件名不能映射到所写 id，另一个直接相关旧回归依赖 child-local 缓存。没有修改无关测试。
3. `npm test > /tmp/coworkflow-fix-blockers-test.log 2>&1; result=$?; tail -n 100 /tmp/coworkflow-fix-blockers-test.log; exit "$result"` — 修正前再次获取完整失败日志：81 pass / 5 fail；四个新 fixture 失败和一个上述旧生命周期用例失败。
4. 修正上述测试后，`npm run typecheck > /tmp/coworkflow-fix-blockers-typecheck.log 2>&1; result=$?; cat /tmp/coworkflow-fix-blockers-typecheck.log; exit "$result"` — 通过，`tsc --noEmit` 无错误。
5. `npm test > /tmp/coworkflow-fix-blockers-test.log 2>&1; result=$?; tail -n 45 /tmp/coworkflow-fix-blockers-test.log; exit "$result"` — 最终通过，完整原始日志尾部为 86 tests / 86 pass / 0 fail / 0 skipped。工具界面的自动摘要与原始日志不一致，结论取自实际读取的日志文件。
6. `git diff --cached --name-only` — 输出为空，确认没有 staged files。

日志：`/tmp/coworkflow-fix-blockers-typecheck.log`、`/tmp/coworkflow-fix-blockers-test.log`。

## 边界及残余风险

- 生产改动只在所分配 worktree；本报告是唯一写到用户指定主目录路径的交付物。未 commit/push/merge，未改任务状态，未改已安装 pi-subagents 或全局配置。
- 回归使用临时项目及真实 extension/control/持久化标记；未启动真实 coding child，也未对真实项目运行 init/disable。
- 本次修复范围内未发现残余 blocker；未声称完成真实 coding mission 端到端验证。原报告记录的上游能力与跨进程边界不因本修复变化。
- 工作树预先已有多个阶段的未提交修改；以上清单只列本次修改的四个文件，未回退其它改动。

```acceptance-report
{
  "criteriaSatisfied": [
    {"id":"criterion-1","status":"satisfied","evidence":"Production before_agent_start refresh precedes dependent module hooks; setSwitch attaches enabled modules then activates their commands. Final full suite: 86 passed, 0 failed."},
    {"id":"criterion-2","status":"satisfied","evidence":"Six new lifecycle regressions drive persisted parent flags via setSessionFlag and real controlSurface().setSwitch, asserting host command maps, registration counts, live refusal gates and both host unsubscribe shapes."}
  ],
  "changedFiles": ["extensions/coworkflow.ts","core/module.ts","scripts/runtime-lifecycle.test.ts","scripts/test.ts"],
  "testsAddedOrUpdated": ["scripts/runtime-lifecycle.test.ts","scripts/test.ts"],
  "commandsRun": [
    {"command":"npm run typecheck","result":"passed","summary":"Initial and final tsc --noEmit passed."},
    {"command":"npm test (initial attempts)","result":"failed","summary":"81 passed / 5 failed: four new persisted-flag fixture key mismatches and one directly affected child-local cached-state assertion; corrected before final run."},
    {"command":"npm test (final)","result":"passed","summary":"86 tests / 86 pass / 0 fail / 0 skipped; raw log /tmp/coworkflow-fix-blockers-test.log."},
    {"command":"git diff --cached --name-only","result":"passed","summary":"Empty output; no staged files."}
  ],
  "validationOutput": ["tsc --noEmit: no errors","tests 86; pass 86; fail 0; skipped 0"],
  "residualRisks": ["No real coding child mission was launched; validation covers production handlers and the existing full automated suite."],
  "noStagedFiles": true,
  "diffSummary": "Refresh persisted session state before child hooks; activate newly enabled feature commands; preserve shutdown/registration idempotency; correct message visibility comment; add production lifecycle regressions.",
  "reviewFindings": ["No remaining blockers identified in the assigned repair scope."],
  "manualNotes": "The final raw npm test log reports 86/86 passing despite an inconsistent tool UI summary. No main-checkout source, installed upstream, global config, task lifecycle or git history changes. Only the requested handoff was written outside the assigned worktree."
}
```
