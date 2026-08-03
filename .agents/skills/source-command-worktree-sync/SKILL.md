---
name: "source-command-worktree-sync"
description: "Sync all worktrees with latest dev branch changes (after merging to dev)"
---

# source-command-worktree-sync

Use this skill when the user asks to run the migrated source command `worktree-sync`.

## Command Template

# Sync Worktrees with Dev

Sync changes between the main `dev` branch and feature worktrees.

**Run from the main repo (dev branch)** - uses `git -C` to operate on worktrees without leaving your current directory.

## Step 1: Ask Sync Direction

Ask the user which direction they want to sync:

- **Dev → Worktrees (Recommended)**: Push latest dev changes into all feature worktrees. Use this after merging a PR or feature into dev, so other worktrees pick up the fixes.
- **Worktree → Dev**: Merge a specific worktree's branch into dev. Use this to bring a completed feature into dev locally.

## Step 2: List All Worktrees

```bash
git worktree list
```

Identify:
- The main repository path (on `dev`)
- All worktree paths and their branches

---

## Path A: Dev → Worktrees

Push dev changes out to all feature worktrees.

### A1. Fetch Latest Dev

```bash
git fetch Github dev
```

### A2. Ask Sync Method

- **Rebase (Recommended)**: `git -C <path> rebase dev` - cleaner history
- **Merge**: `git -C <path> merge dev` - preserves branch history

### A3. For Each Worktree (Not on Dev)

For each worktree that is NOT on the `dev` branch:

**Check for uncommitted changes:**
```bash
git -C <worktree-path> status --porcelain
```

If there are uncommitted changes, ask the user:
- **Stash and continue**: `git -C <worktree-path> stash push -m "Auto-stash before sync"`
- **Skip this worktree**: Continue to next

**Rebase/merge onto dev:**
```bash
git -C <worktree-path> rebase dev
```

If conflicts occur:
- Report the conflicting files
- Instruct user to resolve manually: `cd <worktree-path> && git rebase --continue`
- Or abort: `git -C <worktree-path> rebase --abort`

**Restore stashed changes (if applicable):**
```bash
git -C <worktree-path> stash pop
```

---

## Path B: Worktree → Dev

Merge a specific worktree's feature branch into the local dev branch.

### B1. Show Available Worktrees

List non-dev worktrees and ask which one to merge into dev.

### B2. Check Dev is Clean

```bash
git status --porcelain
```

### B3. Merge the Feature Branch

```bash
git merge <feature-branch-name>
```

If conflicts occur, report and let user resolve.

### B4. Ask About Push

Ask if user wants to push the updated dev to remotes:
```bash
git push Github dev && git push local dev
```

---

## Step 3: Present Summary

Create a table showing sync results:

| Worktree | Branch | Status | Action |
|----------|--------|--------|--------|
| gridlight | dev | - | Source/target |
| gridlight-feature-x | feature/x | ✅ synced | Rebased onto dev |
| gridlight-feature-y | feature/y | ⚠️ conflicts | Needs manual resolution |
| gridlight-feature-z | feature/z | ⏭️ skipped | Had uncommitted changes |

## Notes

- All worktrees share the same git repository, so `git fetch` only needs to run once
- Always use `git -C <path>` to operate on worktrees from the main repo
- Rebasing is preferred to keep feature branches clean before PR
- If a rebase has conflicts, the worktree will be left in rebase state for manual resolution
- Use `git -C <path> rebase --abort` to undo a conflicted rebase
