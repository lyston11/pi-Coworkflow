# Stage 2 — task exit state in /Coworkflow:lanes

## What changed

`modules/lane-worktree/index.ts` only:

- The `lanes` handler now renders a read-only exit block right after the `任务:` line, from
  `exitState(root, taskRef, planRun(...))`. `planRun` remains the single Git validator — the exit
  block performs *no* validation of its own and only runs on tasks it already accepted (or reports
  its message when it did not).
- New helpers: `gitProbe` (a read-only `git -C … ` probe that distinguishes "git could not answer"
  from "no"), `readExitRecord` (reads `branch` / `base_branch` from `task.json`, defaulting the base
  to `main`), `exitState`, and a hoisted `quote` (previously local to `mergePlan`).

The block reports:

1. **Branch** — `git merge-base --is-ancestor <branch> <base>` plus
   `git rev-list --count <base>..<branch>`: "已合并进 main（领先 N 个提交）" or
   "尚未合并进 main（还领先 N 个提交）". A git failure reads "无法判定", never as merged.
2. **Worktree** — for an accepted plan the validated `worktree` is stated as present and registered;
   otherwise `planRun`'s own message is shown and the precondition `任务 worktree 前提未满足` is
   recorded (a missing path therefore reads "不存在或不是目录").
3. **Working tree** — `git status --porcelain --untracked-files=normal` in the validated worktree;
   ignored files are not counted. The first five entries are shown.

Commands appear **only** when every precondition holds:

```
清理命令（前提已满足: 分支已合并且工作树干净；逐条执行并复核结果）:
  git -C '<main checkout>' worktree remove '<validated worktree>'
  git -C '<main checkout>' branch -d '<branch>'
```

When anything fails, the line is `不提供清理命令: 前提未满足 —— <failing preconditions>。保留现场并先解决上述项，
不以强制方式掩盖未完成的工作。` — no destructive command, and `--force` / `-D` appear nowhere in the
module. Nothing is merged, archived, recorded or removed by the command.

## Verification

- `npm run typecheck` — clean.
- `node --experimental-strip-types --test scripts/capacity-lanes.test.ts` — 7/7.
- `npm test` — 92/92 (91 pre-existing + 1 new).

New regression: `scripts/capacity-lanes.test.ts` → *"lanes: exit state prints cleanup only when the
branch is merged and the worktree is clean"*. It builds a real repository + linked task worktree and
drives the production `Coworkflow:lanes` handler:

- unmerged (1 commit ahead, worktree clean) → ahead count reported, no `worktree remove`, no
  `branch -d`;
- merged but dirty (1 modified tracked file) → merge confirmed, dirty precondition named, no commands;
- merged and clean → both exact commands present, no `--force`/`-D`;
- `task.json` pointing at a removed worktree → "不存在或不是目录" + `任务 worktree 前提未满足`, no commands;
- `for-each-ref` / `worktree list --porcelain` / `status --porcelain` fingerprint of the main checkout
  is identical before and after the successful and the failing rendering — the report mutates no
  repository state.

## Notes

- Behaviour delivered by `b79870f` is preserved: run lines, children, patch/apply plan and the
  `lane.recordMerge` / `worktree.cleanup` steps are unchanged; the exit block is appended between the
  task header and the per-run lines.
- Stage 1 and Stage 3 code was not touched.
