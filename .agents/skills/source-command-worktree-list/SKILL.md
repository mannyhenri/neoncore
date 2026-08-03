---
name: "source-command-worktree-list"
description: "List all git worktrees for the current repository"
---

# source-command-worktree-list

Use this skill when the user asks to run the migrated source command `worktree-list`.

## Command Template

# List Git Worktrees

Show all active worktrees and their status.

## Step 1: List Worktrees

```bash
git worktree list
```

## Step 2: Show Status for Each

For each worktree, show:

```bash
# For each worktree path from the list
cd <worktree-path>
echo "=== <worktree-path> ==="
git branch --show-current
git status --short
git log -1 --oneline
cd -
```

## Step 3: Present Summary

Create a table showing:

| Path | Branch | Status | Last Commit |
|------|--------|--------|-------------|
| /path/to/main | dev | clean | abc123 Add feature |
| /path/to/worktree-1 | feature/x | 2 modified | def456 WIP |

## Tips

- Use `/worktree-add` to create a new worktree
- Use `/worktree-finish` to create PRs for completed work
- Use `git worktree remove <path>` to clean up a worktree
- Use `code <path>` to open a worktree in VS Code
