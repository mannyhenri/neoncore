---
name: "source-command-worktree-add"
description: "Create a git worktree for parallel development and open in VS Code"
---

# source-command-worktree-add

Use this skill when the user asks to run the migrated source command `worktree-add`.

## Command Template

# Create Git Worktree

Create a git worktree to work on multiple branches simultaneously in separate VS Code windows.

## Step 1: Gather Information

Use AskUserQuestion to collect:

**Question 1: Branch Name**
- Header: "Branch"
- Ask: "What branch do you want to work on? (existing or new)"
- Options:
  - "Create new branch"
  - "Use existing branch"

**Question 2: Branch/Feature Name**
- Header: "Name"
- Ask: "What is the branch name or feature name?"
- Example: "feature/new-dashboard" or "GRD-205-add-settings"

## Step 2: Determine Worktree Location

Worktrees will be created as sibling directories:
- Main repo: `/path/to/gridlight-marketplace`
- Worktree: `/path/to/gridlight-marketplace-<branch-suffix>`

Extract a short suffix from the branch name:
- `feature/new-dashboard` → `gridlight-marketplace-new-dashboard`
- `GRD-205-add-settings` → `gridlight-marketplace-GRD-205`
- `fix/login-bug` → `gridlight-marketplace-login-bug`

## Step 3: Check Prerequisites

```bash
# Ensure we're in a git repo
git rev-parse --git-dir

# List existing worktrees
git worktree list

# Check if branch exists
git branch -a | grep -E "^[* ]*<branch-name>$|remotes/origin/<branch-name>"
```

If the worktree already exists for this branch, inform user and offer to just open VS Code for it.

## Step 4: Create Worktree

**If creating new branch:**
```bash
# First ensure dev is up to date
git fetch origin dev

# Create worktree with new branch based on dev
git worktree add ../<worktree-folder-name> -b <branch-name> origin/dev
```

**If using existing branch:**
```bash
# Fetch latest
git fetch origin

# Create worktree for existing branch
git worktree add ../<worktree-folder-name> <branch-name>
```

## Step 5: Open VS Code

Open the new worktree in a new VS Code window:

```bash
code ../<worktree-folder-name>
```

## Step 6: Confirm Success

Report to user:
- ✅ Worktree created: `../<worktree-folder-name>`
- ✅ Branch: `<branch-name>`
- ✅ VS Code window opened

**Remind user:**
- Each VS Code window has its own branch and file state
- Use `/commit-push` in each window independently to commit changes
- Use `/worktree-finish` when ready to create PRs
- Use `/worktree-list` to see all active worktrees
- Run `git worktree remove ../<folder>` when done with a worktree

## Notes

- Worktrees share the same git history but have separate working directories
- You can run different dev servers in each worktree
- Each worktree can have its own `.env` file
- Changes committed in one worktree are immediately visible in the git history of others
