---
name: "source-command-commit-push-pr"
description: "Create a commit message, commit changes, push, and create a PR"
---

# source-command-commit-push-pr

Use this skill when the user asks to run the migrated source command `commit-push-pr`.

## Command Template

# Commit, Push, and Create PR

Follow these steps:

## Step 1: Detect Remote and Base Branch

```bash
REMOTE=$(git remote | head -1)
BASE=$(git symbolic-ref refs/remotes/${REMOTE}/HEAD 2>/dev/null | sed "s|refs/remotes/${REMOTE}/||")
if [ -z "$BASE" ]; then
  git rev-parse --verify ${REMOTE}/dev &>/dev/null && BASE=dev || BASE=main
fi
echo "Remote: $REMOTE, Base: $BASE"
```

## Step 2: Check for Task Context

Get the current branch name and check for a task file:
```bash
BRANCH=$(git branch --show-current)
```

If branch matches `GRD-XXX-*` pattern, read `.Codex/tasks/GRD-XXX.md` to get:
- Original description (intent)
- Acceptance criteria (planned outcomes)

## Step 3: Review Changes

```bash
git status
git diff
```
Show what files changed and summarize the actual implementation.

## Step 4: Create Commit Message

Based on the changes, write a commit message:
- Use present tense ("Add feature" not "Added feature")
- First line: Brief summary (50 chars max)
- Blank line
- Detailed explanation if needed
- Include "Resolves GRD-XXX" if applicable
- Do NOT include any Co-Authored-By lines

## Step 5: Commit and Push

```bash
git add <specific-files>
git commit -m "<your-generated-message>"
```

Push to all configured remotes:
```bash
git remote | while read r; do git push $r <current-branch>; done
```

## Step 6: Create Pull Request

PR title format: `GRD-XXX: Brief description`

PR body structure:
```markdown
## Summary
Brief description of what was implemented.

## Intent vs Reality

### Original Task (from Jira)
<Copy the description from the task file>

### What Was Actually Done
<Summary of actual implementation>

### Acceptance Criteria Status
- [x] Criteria 1 - completed
- [x] Criteria 2 - completed
- [ ] Criteria 3 - not done (reason)

## Changes Made
- List of key changes
- Files modified

## Testing Done
- How it was tested
```

Create the PR against the detected base branch:
```bash
gh pr create --title "GRD-XXX: <description>" --body "<PR-body>" --base ${BASE}
```

## Step 7: Cleanup Task File

After PR is created successfully, delete the task context file:
```bash
rm .Codex/tasks/GRD-XXX.md
git add .Codex/tasks/
git commit -m "Remove task file for GRD-XXX after PR created"
git remote | while read r; do git push $r <current-branch>; done
```

Report the PR URL to the user.

Wait for my approval before executing git commands.
