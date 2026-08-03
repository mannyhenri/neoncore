---
name: "source-command-pull-branches"
description: "Pull latest changes from remote for current branch and dev branch"
---

# source-command-pull-branches

Use this skill when the user asks to run the migrated source command `pull-branches`.

## Command Template

# Pull Branches

Follow these steps:

1. **Check Current State**
```bash
   git status
   git branch --show-current
```
   Verify current branch and check for uncommitted changes.

2. **Fetch and Pull Current Branch**
   If there are uncommitted changes, warn me before proceeding.
```bash
   git fetch origin
   git pull origin <current-branch>
```

3. **Pull Dev Branch**
   Update the local dev branch without switching to it:
```bash
   git fetch origin dev:dev
```

4. **Report Status**
   Show me what was pulled for both branches (new commits, files changed) or confirm already up to date.
   Mention that both branches are now updated and ready for diffing.

Wait for my approval before executing git commands if there are uncommitted changes.
