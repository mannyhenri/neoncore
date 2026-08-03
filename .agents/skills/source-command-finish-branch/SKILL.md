---
name: "source-command-finish-branch"
description: "Checkout to base branch and delete the current working branch"
---

# source-command-finish-branch

Use this skill when the user asks to run the migrated source command `finish-branch`.

## Command Template

# Finish Branch

Clean up after completing work on a feature branch by checking out to the base branch and deleting the working branch.

## Step 1: Detect Remote and Base Branch

```bash
REMOTE=$(git remote | head -1)
BASE=$(git symbolic-ref refs/remotes/${REMOTE}/HEAD 2>/dev/null | sed "s|refs/remotes/${REMOTE}/||")
if [ -z "$BASE" ]; then
  git rev-parse --verify ${REMOTE}/dev &>/dev/null && BASE=dev || BASE=main
fi
echo "Remote: $REMOTE, Base: $BASE"
```

## Step 2: Check Current State

```bash
git branch --show-current
git status
```

- Store the current branch name (this is the branch to delete)
- If already on the base branch (`dev` or `main`), inform the user there's no working branch to clean up and stop
- If there are uncommitted changes, warn the user and ask if they want to:
  1. Stash changes before proceeding
  2. Discard changes (git checkout -- .)
  3. Cancel the operation

## Step 3: Checkout to Base Branch

```bash
git checkout ${BASE}
git pull ${REMOTE} ${BASE}
```

Update the base branch to ensure it's current with remote.

## Step 4: Delete the Working Branch

Delete the local branch that was checked out from:

```bash
git branch -d <previous-branch-name>
```

If the branch has unmerged changes, warn the user and ask if they want to:
1. Force delete with `git branch -D <branch>` (lose unmerged changes)
2. Cancel and keep the branch

## Step 5: Optionally Delete Remote Branch

Ask the user if they also want to delete the remote branch:

```bash
git push ${REMOTE} --delete <previous-branch-name>
```

Only offer this if the remote branch exists:
```bash
git ls-remote --heads ${REMOTE} <previous-branch-name>
```

## Step 6: Confirm Cleanup

Show final status:

```bash
git branch --show-current
git branch -a | grep -i "<previous-branch-pattern>" || echo "Branch fully cleaned up"
```

Report:
- Current branch (should be the base branch)
- Confirmation that the working branch was deleted
- Whether remote branch was also deleted (if applicable)
