---
name: "source-command-checkout"
description: "Switch to a different git branch"
---

# source-command-checkout

Use this skill when the user asks to run the migrated source command `checkout`.

## Command Template

# Checkout Branch

Help the user switch to a different git branch.

## Step 1: Check Current State

```bash
git status
git branch --show-current
```

If there are uncommitted changes, warn the user and ask if they want to:
1. Stash changes before switching
2. Cancel the checkout

## Step 2: List Available Branches

Show the user available branches (both local and remote):

```bash
git branch -a --sort=-committerdate | head -20
```

Present the branches as a numbered list and ask which branch they want to checkout.

Common branches to highlight:
- `develop` (main development branch)
- `staging` (staging/pre-production branch)
- `main` or `master` (production branch)
- Any `DRIFT-*` feature branches

## Step 3: Checkout Selected Branch

Once the user selects a branch:

```bash
git checkout <branch-name>
```

If it's a remote branch that doesn't exist locally, detect the remote name:
```bash
REMOTE=$(git remote | head -1)
git checkout -b <branch-name> ${REMOTE}/<branch-name>
```

## Step 4: Confirm

Show the user:
- Current branch after checkout
- Brief status of the branch (ahead/behind remote)

```bash
git status
```
