---
name: "source-command-create-branch"
description: "Create a new git branch and check it out"
---

# source-command-create-branch

Use this skill when the user asks to run the migrated source command `create-branch`.

## Command Template

# Create Branch from Jira Task

Create a properly named branch with task context for focused development.

## Step 1: Gather Task Information

Use AskUserQuestion to collect the following information from the user:

**Question 1: Jira Task Number**
- Header: "Task ID"
- Ask: "What is the Jira task number?"
- Options: Text input (e.g., GRD-184, GRD-205)

**Question 2: Task Title**
- Header: "Title"
- Ask: "What is the task title? (will be used for branch name)"
- Options: Text input (e.g., "Add user preferences page")

**Question 3: Description**
- Header: "Description"
- Ask: "What needs to be done? (copy from Jira description)"
- Options: Text input (multi-line description)

**Question 4: Acceptance Criteria**
- Header: "Criteria"
- Ask: "What are the acceptance criteria? (copy from Jira)"
- Options: Text input (checklist format preferred)

**Question 5: Technical Notes (Optional)**
- Header: "Notes"
- Ask: "Any technical notes, hints, or related files?"
- Options: Text input or skip

## Step 2: Create Branch

After collecting information:

1. **Check for uncommitted changes**
```bash
git status --porcelain
```
Warn user if there are uncommitted changes.

2. **Sanitize the title for branch name**
- Convert to lowercase
- Replace spaces with hyphens
- Remove special characters
- Example: "Add User Preferences Page" → "add-user-preferences-page"

3. **Create and checkout branch**
```bash
git checkout -b <JIRA_NUMBER>-<sanitized-title>
```
Example: `git checkout -b GRD-184-add-user-preferences-page`

## Step 3: Create Task Context File

Create `.Codex/tasks/<JIRA_NUMBER>.md` with this structure:

```markdown
# <JIRA_NUMBER>: <Task Title>

## Task Details
- **Jira:** <JIRA_NUMBER>
- **Branch:** <branch-name>
- **Created:** <current-date>

## Description
<user-provided description>

## Acceptance Criteria
<user-provided criteria>

## Technical Notes
<user-provided notes or "None provided">

## Progress
- [ ] Task started
```

## Step 4: Confirm Success

Report to user:
- ✅ Branch created: `<branch-name>`
- ✅ Task context: `.Codex/tasks/<JIRA_NUMBER>.md`
- Summary of task goals from description/criteria

Remind user that Codex will read this context file to stay focused on task goals.
