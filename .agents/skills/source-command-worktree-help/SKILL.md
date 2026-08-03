---
name: "source-command-worktree-help"
description: "Quick guide to git worktrees and worktree commands"
---

# source-command-worktree-help

Use this skill when the user asks to run the migrated source command `worktree-help`.

## Command Template

# Git Worktrees - Quick Guide

Display this guide to help the user understand git worktrees and the available commands.

## What Are Worktrees?

Git worktrees let you work on **multiple branches simultaneously** in separate folders. Each worktree:
- Has its own working directory
- Has its own checked-out branch
- Shares the same git history with the main repo
- Can run its own dev server, have its own `.env`, etc.

## Directory Structure

```
gridlight-marketplace/              → dev (main repo)
gridlight-marketplace-feature-x/    → feature/x (worktree)
gridlight-marketplace-feature-y/    → feature/y (worktree)
```

## Available Commands

| Command | Description |
|---------|-------------|
| `/worktree-add` | Create a new worktree + open VS Code |
| `/worktree-list` | Show all worktrees and their status |
| `/worktree-finish` | Create PRs for completed worktrees |
| `/worktree-remove` | Clean up a worktree when done |
| `/worktree-help` | Show this guide |

## Typical Workflow

### 1. Create Worktrees
```
/worktree-add  →  Creates worktree, opens VS Code window
```
Repeat for each feature/branch you want to work on in parallel.

### 2. Work Independently
In each VS Code window:
- Make changes to your feature
- Use `/commit-push` to commit and push (works as usual)
- Each window is isolated - no branch switching needed

### 3. Finish When Ready
```
/worktree-finish  →  "Current worktree only"
```
- Creates a PR to merge your branch into `dev`
- Asks if you want to remove the worktree folder
- Other worktrees keep running independently

### 4. Clean Up (Optional)
```
/worktree-remove  →  Removes folder, optionally deletes branch
```

## Tips

- **Check status anytime**: `/worktree-list` shows all worktrees
- **Finish one at a time**: Features complete at different times - that's fine
- **Create new anytime**: Add more worktrees whenever you need them
- **Each window is independent**: Different dev servers, different `.env` files
- **Shared history**: Commits in one worktree appear in git log everywhere

## Common Git Commands (Manual)

```bash
# List all worktrees
git worktree list

# Create worktree for existing branch
git worktree add ../folder-name branch-name

# Create worktree with new branch
git worktree add ../folder-name -b new-branch origin/dev

# Remove a worktree
git worktree remove ../folder-name

# Open worktree in VS Code
code ../folder-name
```

## FAQ

**Q: Can I delete a worktree folder manually?**
A: Yes, but run `git worktree prune` afterward to clean up git's tracking.

**Q: What if I have uncommitted changes?**
A: The commands will warn you and ask what to do (commit, stash, or discard).

**Q: Do worktrees take up extra disk space?**
A: Minimal - they share the git object database. Only working files are duplicated.

**Q: Can I have the same branch in two worktrees?**
A: No - each branch can only be checked out in one worktree at a time.
