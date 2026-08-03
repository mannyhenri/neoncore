---
name: "source-command-sync-branch"
description: "Sync branch with remote (pull then push) — auto-detects remote name"
---

# source-command-sync-branch

Use this skill when the user asks to run the migrated source command `sync-branch`.

## Command Template

# Sync Branch

Follow these steps:

1. **Detect Remote**
```bash
   REMOTE=$(git remote | head -1)
   echo "Using remote: $REMOTE"
```

2. **Check Current State**
```bash
   git status
   git branch --show-current
```
   Verify current branch and check for uncommitted changes.

3. **Pull Latest Changes**
   If there are uncommitted changes, warn me before proceeding.
```bash
   git fetch ${REMOTE}
   git pull ${REMOTE} <current-branch>
```
   Handle any merge conflicts if they occur.

4. **Push Local Changes**

Push to all configured remotes:
```bash
   git remote | while read r; do git push $r <current-branch>; done
```

5. **Report Status**
   Confirm sync is complete and show the current state.

Wait for my approval before executing git commands if there are uncommitted changes or conflicts.
