#!/usr/bin/env python3
"""Trellis ``after_start`` hook: isolate every started task in its own worktree.

Reads ``TASK_JSON_PATH`` (exported by ``run_task_hooks``), ensures branch
``feat/<task-dir-name>`` is checked out in a linked worktree at
``../<prefix><task-dir-name>`` (prefix from ``WORKTREE_DIR_PREFIX``), and records
both in task.json (``branch`` /
``worktree_path``). The checkout that ran ``task.py start`` is never touched.

Exit 0 on success and benign skips; exit 1 on real failures so
``run_task_hooks`` surfaces the captured output as its warning (hook output is
swallowed on success — task.json is the machine-readable record, the AGENTS.md
task-isolation rules are the human-readable contract).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

WORKTREE_DIR_PREFIX = "wt-"
DEFAULT_BRANCHES = {"main", "master"}

# Runtime directories a checkout does NOT contain but a working agent needs.
#
# A linked worktree is a checkout of committed files only. This package's Trellis state —
# ``.trellis/tasks``, ``.trellis/scripts``, ``.trellis/config.yaml`` and the whole of ``.pi/`` — is
# deliberately untracked, so a fresh worktree has none of it: no task records, no ``task.py``, no
# spec injection inputs, no project config, and no subagent agent definitions. A child dispatched
# there then cannot read its own PRD or run the task lifecycle, which is exactly the kind of
# "works on my checkout" gap this hook exists to prevent.
#
# Symlinked, not copied: these are *shared* records. A child updating a task must update the one the
# parent reads, and duplicating them would create two divergent histories.
MATERIALISE = (
    (".trellis/tasks", "dir"),
    (".trellis/scripts", "dir"),
    (".trellis/workspace", "dir"),
    (".trellis/config.yaml", "file"),
    (".trellis/workflow.md", "file"),
    (".pi", "dir"),
)


def run_git(cwd: Path, *args: str) -> tuple[int, str, str]:
    # Bounded: this hook runs inside `task.py start`, and an unbounded git call there blocks the
    # whole session (worst on a slow filesystem, where `worktree add` can take minutes).
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            timeout=120,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return 124, "", f"git {' '.join(args)} 超过 120 秒未返回"
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def fail(message: str) -> int:
    print(f"[auto-worktree] {message}", file=sys.stderr)
    return 1


def parse_worktrees(output: str) -> dict[Path, str | None]:
    """Map worktree path -> checked-out branch (None for detached/bare)."""
    worktrees: dict[Path, str | None] = {}
    current: Path | None = None
    for line in output.splitlines():
        if line.startswith("worktree "):
            current = Path(line[len("worktree ") :])
            worktrees[current] = None
        elif line.startswith("branch refs/heads/") and current is not None:
            worktrees[current] = line[len("branch refs/heads/") :]
    return worktrees


def record(task_json: Path, data: dict, branch: str, worktree_path: Path) -> int:
    if data.get("branch") == branch and data.get("worktree_path") == str(worktree_path):
        return 0
    data["branch"] = branch
    data["worktree_path"] = str(worktree_path)
    task_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main() -> int:
    raw = os.environ.get("TASK_JSON_PATH")
    if not raw:
        return 0
    task_json = Path(raw).resolve()
    if not task_json.is_file():
        return fail(f"task.json not found: {task_json}")
    task_name = task_json.parent.name

    code, out, err = run_git(task_json.parent, "rev-parse", "--show-toplevel")
    if code != 0:
        return fail(f"not inside a git repository: {err}")
    repo_root = Path(out).resolve()

    code, git_dir, _ = run_git(repo_root, "rev-parse", "--absolute-git-dir")
    code2, common_dir, _ = run_git(repo_root, "rev-parse", "--git-common-dir")
    if code == 0 and code2 == 0 and Path(git_dir).resolve() != Path(common_dir).resolve():
        # Already inside a linked worktree: the caller is isolated, and nesting
        # a worktree here would hide task state from the main checkout.
        return 0

    code, out, _ = run_git(repo_root, "branch", "--show-current")
    current_branch = out if code == 0 else ""

    data = json.loads(task_json.read_text(encoding="utf-8"))
    recorded = data.get("branch")
    if recorded and recorded not in DEFAULT_BRANCHES and recorded != current_branch:
        target_branch = recorded
    else:
        target_branch = f"feat/{task_name}"

    worktree_path = repo_root.parent / f"{WORKTREE_DIR_PREFIX}{task_name}"

    code, out, err = run_git(repo_root, "worktree", "list", "--porcelain")
    if code != 0:
        return fail(f"git worktree list failed: {err}")
    worktrees = parse_worktrees(out)

    branch_home = next((p for p, b in worktrees.items() if b == target_branch), None)
    if branch_home is not None:
        print(f"[auto-worktree] {target_branch} already checked out at {branch_home}")
        return record(task_json, data, target_branch, branch_home)

    if worktree_path in worktrees:
        existing = worktrees[worktree_path]
        if existing is None:
            return fail(f"{worktree_path} is registered as a detached worktree")
        if existing != target_branch:
            return fail(f"{worktree_path} belongs to {existing}, expected {target_branch}; refusing to adopt another branch")
        return record(task_json, data, target_branch, worktree_path)

    if worktree_path.exists():
        return fail(
            f"{worktree_path} exists but is not a registered worktree; "
            "move or remove it, then re-run task.py start"
        )

    branch_exists = (
        run_git(repo_root, "show-ref", "--verify", "--quiet", f"refs/heads/{target_branch}")[0] == 0
    )
    if branch_exists:
        code, _, err = run_git(repo_root, "worktree", "add", str(worktree_path), target_branch)
    else:
        code, _, err = run_git(repo_root, "worktree", "add", "-b", target_branch, str(worktree_path))
    if code != 0:
        return fail(f"git worktree add failed: {err}")

    for relative, kind in MATERIALISE:
        source = repo_root / relative
        if not source.exists():
            continue
        target = worktree_path / relative
        if target.exists() or target.is_symlink():
            # Already tracked and checked out (older projects tracked some of these), or a hook ran
            # twice: leaving the real files alone is the safe answer.
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(source, target_is_directory=(kind == "dir"))
        except OSError as error:
            # A worktree without these is still usable for a child that only edits code, so this is a
            # warning rather than a failed start — but it has to be said, not swallowed.
            print(f"[auto-worktree] warn: 未能链接 {relative}: {error}", file=sys.stderr)

    print(f"[auto-worktree] ready: {worktree_path} (branch {target_branch})")
    return record(task_json, data, target_branch, worktree_path)


if __name__ == "__main__":
    sys.exit(main())
