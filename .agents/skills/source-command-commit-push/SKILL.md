---
name: "source-command-commit-push"
description: "Lint, check HIGH-RISK markers, commit changes, and push to all remotes"
---

# source-command-commit-push

Use this skill when the user asks to run the migrated source command `commit-push`.

## Command Template

# Commit and Push (with Quality Gates)

Commit and push with pre-commit quality checks to catch issues before they reach the remote.

## Step 1: Pre-Commit Quality Gates

### Gate 1: Lint & Format Check

Auto-detect project type and run appropriate checks on changed files only:

```bash
git diff --name-only --cached
git diff --name-only
```

**Node/TypeScript** (if `package.json` exists):
```bash
npx tsc --noEmit 2>/dev/null
npm run lint -- --quiet 2>/dev/null
```

**Rust** (if `Cargo.toml` exists):
```bash
cargo fmt --check
cargo clippy -- -D warnings 2>/dev/null
```

**Python** (if `pyproject.toml` / `setup.py` exists):
```bash
ruff check . 2>/dev/null || flake8 . 2>/dev/null
```

If lint errors are found:
1. Attempt auto-fix
2. If auto-fix resolves all issues, include the fixes in the commit
3. If issues remain, report them and ask: "Lint issues found. Commit anyway?"

### Gate 2: Risk Marker Audit

Check if any modified files contain risk markers:

```bash
git diff --name-only | xargs grep -n "RISK-UNREVIEWED\|RISK-REVIEWED" 2>/dev/null
```

**Check for violations:**
- If a function marked `HIGH-RISK-REVIEWED` or `MINOR-RISK-REVIEWED` has been modified in this diff, **STOP** and change it to the corresponding `-UNREVIEWED` before committing. Warn the user.
- Report total count of UNREVIEWED markers (HIGH and MINOR) in changed files
- Suggest running `/list-risks` to fix remaining tags before committing

### Gate 3: Secret Scan

Quick check for accidentally staged secrets:
```bash
git diff --cached | grep -iE "(api_key|api_secret|password|secret_key|private_key|token)" | grep -vE "(example|placeholder|TODO|env\.|process\.env|config\[)" 2>/dev/null
```

If potential secrets found, warn and ask for confirmation.

## Step 2: Review Changes

```bash
git status
git diff
git diff --cached
```

Show what files changed and summarize the changes.

## Step 3: Create Commit Message

Based on the changes, write a commit message:
- Use present tense ("Add feature" not "Added feature")
- First line: Brief summary (50 chars max)
- Blank line
- Detailed explanation if needed
- Do NOT include any Co-Authored-By lines

## Step 4: Stage and Commit

```bash
git add <specific-files>
git commit -m "<your-generated-message>"
```

Prefer adding specific files by name rather than `git add .` to avoid staging secrets or build artifacts.

## Step 5: Push to All Remotes

Detect all configured remotes:
```bash
git remote -v
```

Push to each remote:
```bash
git push <remote-name> <current-branch>
```

If pushing to multiple remotes, push to each one.

## Step 6: Report

```
✅ Quality gates passed
  - Lint: clean (or N issues auto-fixed)
  - HIGH-RISK: N unreviewed / M reviewed in changed files
  - Secrets: none detected

✅ Committed: <hash> "<message>"
✅ Pushed to: <remote1>, <remote2>
```
