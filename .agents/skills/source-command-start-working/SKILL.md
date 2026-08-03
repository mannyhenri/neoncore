---
name: "source-command-start-working"
description: "Start working on a Jira task with full context"
---

# source-command-start-working

Use this skill when the user asks to run the migrated source command `start-working`.

## Command Template

# Start Working on Task

Begin working on a task by gathering all relevant context and entering plan mode.

## Step 1: Get Task ID

Ask the user for the task ID if not provided as an argument:

```
What task are you starting? (e.g., GRD-427, MKT-001)
```

## Step 2: Fetch Task from Jira

Get the task details from Jira:

```bash
jira issue view <TASK-ID> --plain
```

Extract:
- Task summary/title
- Task description
- Epic link (parent)
- Labels
- Status

## Step 3: Fetch Parent Epic from Jira

If the task has a parent epic, fetch it:

```bash
jira epic list --table | grep <EPIC-KEY>
jira issue view <EPIC-KEY> --plain
```

## Step 4: Find Local Epic Document

Search for related epic documents in the codebase:

```bash
ls .Codex/scoping/EPIC-*.md
```

Try to match the epic by:
- Epic key in filename
- Epic title in file content
- Labels matching directory names

Read the matched epic file to get full context.

## Step 5: Read AGENTS.md

Read the project instructions:

```bash
cat AGENTS.md
```

This provides coding standards, patterns, and project-specific guidance.

## Step 6: Gather Additional Context

Present the user with what was found and ask:

```
## Task Context Loaded

**Task:** <TASK-ID> - <Summary>
**Epic:** <EPIC-KEY> - <Epic Title>
**Local Epic Doc:** <path if found>

### Additional Details

Please paste any additional context, requirements, or notes for this task:
(Press Enter twice when done)
```

Use the AskUserQuestion tool to let the user provide:
- Additional requirements
- Clarifications
- Links to designs/specs
- Any constraints

## Step 7: Enter Plan Mode

After gathering all context, enter plan mode to:
1. Analyze the task requirements
2. Identify files that need changes
3. Create an implementation plan
4. Get user approval before coding

Summarize what you know:
```
## Ready to Plan

**Task:** <summary>
**From Epic:** <epic context>
**Additional Context:** <user provided>

Entering plan mode to create implementation strategy...
```

Then use the EnterPlanMode tool to begin planning.

## Notes

- If Jira is not configured, fall back to asking user to paste task details
- If no local epic doc found, use Jira epic description
- Always read AGENTS.md for project standards
- The goal is to have full context before writing any code
