# Dispatch check — lanes exit state (80ea47c)

Claim verified: **true**. Driven through the registered `Coworkflow:lanes` handler from `modules/lane-worktree/index.ts` (via `activate` + `onSessionActivate`) in a throwaway `/tmp` repo with a real linked worktree; project repo untouched.

| Case | Branch line / ahead | Worktree line | `worktree remove` | `branch -d` | `--force` / `-D` |
|---|---|---|---|---|---|
| (a) unmerged + clean | 尚未合并进 main（还领先 1 个提交） | 存在且已注册；干净 | no | no | no / no |
| (b) merged + dirty | 已合并进 main（领先 0 个提交） | 1 处未提交改动 | no | no | no / no |
| (c) merged + clean | 已合并进 main（领先 0 个提交） | 干净 | **YES** | **YES** | no / no |
| (d) worktree deleted | 已合并进 main（领先 0 个提交） | 未满足前提 —— …记录的工作树不存在或不是目录 | no | no | no / no |

- (a)/(b) print "不提供清理命令: 前提未满足 —— …" naming the exact failing precondition (unmerged; dirty), not a generic refusal.
- (c) prints the two literal commands, quoted, no forced variants; both preconditions stated as satisfied.
- (d) states the missing worktree precondition; branch is merged but the worktree check still suppresses cleanup.

Read-only guarantee held: fingerprint (`for-each-ref` + `worktree list --porcelain` + `status --porcelain` + `rev-parse HEAD`) identical before/after in **all four** cases (`mutated: false` ×4). The handler's only git calls on this path are `merge-base --is-ancestor`, `rev-list --count`, `status --porcelain`, plus `planRun`'s validators — all reads; nothing merges, archives, removes or deletes.

Residual risk: only the merged+ahead branch state where `git merge-base` fails (exit code ≥2) is unexercised; code maps that to "无法判定" and suppresses cleanup, so it fails safe. Case (b)'s dirty file was traced/modified, not untracked; untracked-not-ignored is covered by the same `--untracked-files=normal` read but was not isolated in this run.
