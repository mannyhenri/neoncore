---
name: "source-command-worktree-remove"
description: "Remove a git worktree and optionally delete the branch"
---

# source-command-worktree-remove

Use this skill when the user asks to run the migrated source command `worktree-remove`.

## Command Template

# Remove Git Worktree

Clean up a worktree after completing work on a feature.

## Step 1: List Worktrees

```bash
git worktree list
```

Show all worktrees except the main one.

## Step 2: Select Worktree to Remove

Use AskUserQuestion:

**Question: Select Worktree**
- Header: "Remove"
- Ask: "Which worktree do you want to remove?"
- Options: List of worktree paths (excluding main repo)

## Step 3: Check Status

```bash
cd <selected-worktree>
git status --porcelain
git log origin/dev..<branch-name> --oneline
```

Warn if:
- There are uncommitted changes
- There are unpushed commits
- No PR exists for this branch

If any warnings, ask user to confirm proceeding.

## Step 4: Remove Worktree

```bash
git worktree remove <worktree-path>
```

If there are uncommitted changes:
```bash
git worktree remove --force <worktree-path>
```

## Step 5: Ask About Branch Deletion

Use AskUserQuestion:

**Question: Delete Branch**
- Header: "Branch"
- Ask: "Do you also want to delete the branch '<branch-name>'?"
- Options:
  - "No, keep the branch"
  - "Delete local branch only"
  - "Delete local and remote branch"

**If delete local:**
```bash
git branch -d <branch-name>
```
Use `-D` if branch has unmerged commits (after confirmation).

**If delete remote too:**
```bash
git push origin --delete <branch-name>
```

## Step 6: Confirm Cleanup

```bash
git worktree list
git branch -a | grep <branch-name> || echo "Branch fully cleaned up"
```

Report:
- ✅ Worktree removed: `<path>`
- ✅ Branch status (kept/deleted locally/deleted remotely)
