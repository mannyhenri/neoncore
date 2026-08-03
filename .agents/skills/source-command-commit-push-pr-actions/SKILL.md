---
name: "source-command-commit-push-pr-actions"
description: "Create a commit message, commit changes, push, create a PR, and trigger GitHub Actions workflows"
---

# source-command-commit-push-pr-actions

Use this skill when the user asks to run the migrated source command `commit-push-pr-actions`.

## Command Template

# Commit, Push, Create PR, and Trigger GitHub Actions

Follow these steps:

## Step 1: Check for Task Context

Get the current branch name and check for a task file:
```bash
BRANCH=$(git branch --show-current)
```

If branch matches `GRD-XXX-*` pattern, read `.Codex/tasks/GRD-XXX.md` to get:
- Original description (intent)
- Acceptance criteria (planned outcomes)

## Step 2: Review Changes

```bash
git status
git diff
```
Show what files changed and summarize the actual implementation.

## Step 3: Create Commit Message

Based on the changes, write a commit message:
- Use present tense ("Add feature" not "Added feature")
- First line: Brief summary (50 chars max)
- Blank line
- Detailed explanation if needed
- Include "Resolves GRD-XXX" if applicable
- Do NOT include any Co-Authored-By lines

## Step 4: Commit and Push

```bash
git add .
git commit -m "<your-generated-message>"
git push origin <current-branch>
```

## Step 5: Create Pull Request

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

Create the PR:
```bash
gh pr create --title "GRD-XXX: <description>" --body "<PR-body>" --base main
```

## Step 6: Trigger GitHub Actions Workflows

After the PR is created, trigger all relevant GitHub Actions workflows manually:

```bash
# List available workflows
gh workflow list

# Trigger each workflow on the current branch
gh workflow run "<workflow-name>" --ref <current-branch>
```

Trigger ALL workflows found in `.github/workflows/`. For each one, run:
```bash
gh workflow run "<workflow-filename>" --ref <current-branch>
```

Report which workflows were triggered and provide the link to view them:
```bash
echo "View runs at: https://github.com/<owner>/<repo>/actions"
```

## Step 7: Cleanup Task File

After PR is created successfully, delete the task context file:
```bash
rm .Codex/tasks/GRD-XXX.md
git add .Codex/tasks/
git commit -m "Remove task file for GRD-XXX after PR created"
git push
```

Report the PR URL and triggered workflows to the user.

Wait for my approval before executing git commands.
