---
name: "source-command-scoping"
description: "Scope an epic into tasks or detail a specific task implementation"
---

# source-command-scoping

Use this skill when the user asks to run the migrated source command `scoping`.

## Command Template

# Scoping Command

Help scope work by breaking down epics into tasks or detailing task implementation.

## Step 1: Determine Scope Type

Use AskUserQuestion to ask:
- **Question:** "What are you scoping?"
- **Header:** "Scope type"
- **Options:**
  1. **Epic** - Break down a large feature into individual tasks
  2. **Task** - Detail implementation specifics for a single task
  3. **Tasks from Epic** - Generate detailed specs for all tasks in an existing epic and push to Jira

---

## If Epic Scoping

### Step 2a: Gather Epic Information

Prompt user for:
1. **Epic Title** - Name of the epic (e.g., "User Authentication System")
2. **Epic Description** - High-level description of what needs to be built
3. **Business Goals** - What problem does this solve? Who benefits?
4. **Known Constraints** - Timeline, tech limitations, dependencies
5. **Reference Materials** - Any designs, docs, or examples (optional)

### Step 3a: Analyze Codebase

Read relevant parts of the codebase to understand:
- Existing patterns and architecture
- Related features already implemented
- Database schema and models
- API structure
- Frontend component patterns

### Step 4a: Generate Task Breakdown

Create a list of Jira-ready tasks with:
- Task number placeholder (EPIC-001, EPIC-002, etc.)
- Task title
- Brief description (2-3 sentences)
- Estimated complexity (S/M/L/XL)
- Dependencies (which tasks must complete first)
- Suggested assignee type (Frontend/Backend/Full-stack)

### Step 5a: Save Epic Document

Create `.Codex/scoping/EPIC-<sanitized-title>.md`:

```markdown
# Epic: <Epic Title>

## Overview
<Epic description>

## Business Goals
<Why this matters>

## Constraints
<Known limitations>

## Task Breakdown

### Phase 1: Foundation
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| EPIC-001 | Setup base models | Create database models for... | M | None |
| EPIC-002 | API endpoints | Implement CRUD endpoints... | L | EPIC-001 |

### Phase 2: Core Features
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| EPIC-003 | ... | ... | ... | ... |

### Phase 3: Polish & Integration
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| EPIC-004 | ... | ... | ... | ... |

## Architecture Notes
<Key technical decisions and patterns to follow>

## Open Questions
<Things that need clarification before starting>

## Created
<date>
```

---

## If Task Scoping

### Step 2b: Get Task ID

Ask user for task ID using AskUserQuestion:
- **Question:** "Enter the task ID (e.g., GRD-184):"
- **Header:** "Task ID"
- **Options:** Provide 2 placeholder options - user will select "Other" to type their ID
- User types their task ID in the "Other" free-text field

### Step 3b: Get Task Details

Ask user for full task details using AskUserQuestion:
- **Question:** "Enter ALL task details below (title, description, acceptance criteria, context - as much as you have):"
- **Header:** "Task details"
- **Options:** Provide 2 placeholder options - user will select "Other" to paste their details
- User pastes/types full task description in the "Other" free-text field
- This can include: title, description from Jira, acceptance criteria, business context, technical notes, etc.

### Step 4b: Analyze Codebase (Automatic)

Codex automatically:
1. Read AGENTS.md to understand project patterns and conventions
2. Search codebase for related files based on task description
3. Identify existing patterns to follow
4. Find related code, APIs, and dependencies
5. Check test patterns used in the project

### Step 5b: Generate Detailed Jira Task

Based on analysis, create a comprehensive task document with:
- Clear acceptance criteria (derived from description)
- Specific files to modify/create
- Code patterns to follow (from AGENTS.md)
- API changes with request/response examples
- Database migrations if needed
- Tests to write
- Edge cases to handle
- Estimated effort (S/M/L/XL)

### Step 6b: Save Task Document

Create `.Codex/tasks/TASK-<task-id>.md`:

```markdown
# Task: <Task ID> - <Task Title>

## Summary
<Brief description of what this task accomplishes>

## Acceptance Criteria
<From Jira or user input>

## Implementation Plan

### 1. Backend Changes

#### Files to Modify
- `backend/src/api/handlers/xxx.rs` - Add new endpoint
- `backend/src/services/xxx.rs` - Implement business logic

#### Database Changes
```sql
-- Migration needed? Describe here
```

#### API Changes
```
POST /api/xxx
Request: { ... }
Response: { ... }
```

### 2. Frontend Changes

#### Components
- `frontend/src/app/components/Xxx.tsx` - New component
- `frontend/src/app/pages/Xxx.tsx` - Update page

#### State Management
- Add new API call to `services/api.ts`

### 3. Tests

#### Backend Tests
- Unit test for service logic
- Integration test for API endpoint

#### Frontend Tests
- Component test for new UI

### 4. Edge Cases
- What happens if X fails?
- How to handle Y scenario?

## Dependencies
- Requires: <list any blockers>
- Blocks: <list tasks waiting on this>

## Estimated Effort
<S/M/L/XL with brief justification>

## Open Questions
<Things to clarify before starting>

## Created
<date>
```

---

## If Tasks from Epic (Batch Mode)

### Step 2c: Select Epic

1. List all available epics from `.Codex/scoping/EPIC-*.md`
2. Use AskUserQuestion to let user select which epic to process:
   - **Question:** "Which epic do you want to create tasks from?"
   - **Header:** "Select epic"
   - **Options:** List epic filenames (up to 4, or provide placeholder for "Other" to type filename)

### Step 3c: Parse Epic Tasks

1. Read the selected epic file
2. Parse all tasks from the "Task Breakdown" tables
3. Extract for each task:
   - Task ID (e.g., MCP-001, WIN-001)
   - Title
   - Description
   - Size (S/M/L/XL)
   - Dependencies
   - Phase

### Step 4c: Confirm Task Selection

Use AskUserQuestion to confirm:
- **Question:** "Found X tasks in this epic. Which tasks do you want to detail?"
- **Header:** "Task selection"
- **Options:**
  1. **All tasks** - Generate specs for all tasks
  2. **Phase 1 only** - Only foundation/first phase tasks
  3. **Custom selection** - I'll specify which tasks

If "Custom selection", ask which task IDs to include.

### Step 5c: Generate All Task Details

For each selected task (in parallel where possible):

1. **Read AGENTS.md** to understand project patterns
2. **Analyze codebase** for related code based on task description
3. **Generate detailed task spec** following the Task Document template
4. **Save to** `.Codex/tasks/TASK-<task-id>.md`

Use TodoWrite to track progress through tasks.

### Step 6c: Ask About Jira Push

Use AskUserQuestion:
- **Question:** "Do you want to create these tasks in Jira?"
- **Header:** "Jira push"
- **Options:**
  1. **Yes, create in Jira** - Create all tasks under the epic
  2. **No, keep local only** - Just save the markdown files

### Step 7c: Push to Jira (if selected)

If user selected Jira push:

1. **Generate Epic Config File**

   Create a JSON config file for the unified script:

   ```json
   {
     "epic": {
       "summary": "<Epic Title from parsed file>",
       "description": "<Epic description from Overview section>"
     },
     "labels": ["<extracted-labels-from-epic>"],
     "tasks": [
       {"id": "PREFIX-001", "summary": "Task Title"},
       {"id": "PREFIX-002", "summary": "Another Task"}
     ]
   }
   ```

   Save to `.Codex/scripts/<epic-name>-config.json`

2. **Run the Unified Script**

   Use `create-jira-tasks-with-descriptions.sh` which handles everything in one pass:

   ```bash
   # The script reads task specs from .Codex/tasks/<task-id>.md
   # and creates Jira issues with FULL markdown descriptions
   ./.Codex/scripts/create-jira-tasks-with-descriptions.sh .Codex/scripts/<epic-name>-config.json
   ```

   This script automatically:
   - Creates the Epic in Jira
   - For each task, reads `.Codex/tasks/<task-id>.md`
   - Converts markdown to Atlassian Document Format (ADF)
   - Creates the task with the COMPLETE description
   - Links tasks to the parent Epic
   - Outputs task mapping (TASK-ID → GRD-XXX)

3. **CRITICAL: Full Markdown in Description**

   The script ensures task descriptions contain the ENTIRE content of the task spec file:
   - Summary section
   - Acceptance criteria
   - Implementation plan with code snippets
   - Files to modify
   - Tests to write
   - Verification steps
   - Estimated effort
   - Notes

   DO NOT use scripts that only send brief summaries. The full implementation guide MUST be in Jira.

4. **Update task files** with Jira issue numbers from the mapping output

5. **Report results**:
   - List of created issues with links
   - Any failures

### Step 8c: Summary Report

Output a summary:
```
✅ Tasks from Epic: <epic-name>

Created X task specifications:
- TASK-MCP-001.md - Create MCP module structure
- TASK-MCP-002.md - MCP type definitions
- ...

Jira issues created:
- GRD-201: Create MCP module structure
- GRD-202: MCP type definitions
- ...

Next steps:
1. Review generated task specs in .Codex/tasks/
2. Assign tasks to team members in Jira
3. Start with Phase 1 tasks (no dependencies)
```

---

## Final Step

Report to user:
- ✅ Document created: `.Codex/scoping/<filename>.md` (for epics) or `.Codex/tasks/<filename>.md` (for tasks)
- Summary of key findings
- Recommend next steps (create Jira tasks for epic, or start implementation for task)

---

## Notes

### Jira Integration Options

The command supports multiple Jira integration approaches:

1. **Jira REST API with curl** (recommended):
   - Uses `curl` with Basic auth
   - Full markdown content via ADF conversion
   - Requires `~/.config/.jira/.config.yml` with server, login, api_token

2. **Jira CLI** (if `jira` CLI is installed):
   - Direct Jira API integration
   - Requires authentication setup
   - Note: May have issues with large descriptions

3. **Manual** (default fallback):
   - Generates markdown files only
   - User copies content to Jira manually

### Helper Scripts

Located in `.Codex/scripts/`:

- **`create-jira-tasks-with-descriptions.sh`** - **PRIMARY SCRIPT** for creating epic + tasks
  ```bash
  # Creates epic and all tasks with FULL markdown descriptions in one pass
  ./.Codex/scripts/create-jira-tasks-with-descriptions.sh epic-config.json
  ```
  - Reads task specs from `.Codex/tasks/<task-id>.md`
  - Converts markdown to ADF automatically
  - Creates epic, then all tasks linked to it
  - Outputs task ID → Jira key mapping

- **`md_to_adf.py`** - Standalone markdown to Jira ADF converter
  ```bash
  python3 .Codex/scripts/md_to_adf.py path/to/file.md
  ```

- **`update-jira-*-descriptions.sh`** - Update existing Jira tasks with full markdown
  - Useful if tasks were created with summaries only
  - Reads task files from `.Codex/tasks/`
  - Updates via Jira REST API

See `.Codex/docs/jira-task-workflow.md` for complete documentation.

### Task ID Conventions

- Epic tasks use prefix from epic name: `MCP-001`, `WIN-001`, `HF-001`
- Once pushed to Jira, update files with real Jira IDs: `GRD-201`
- Keep both references for traceability

### Parallel Processing

When generating multiple task specs:
- Use parallel exploration agents for codebase analysis
- Generate task files concurrently
- Track progress with TodoWrite
