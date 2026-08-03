---
name: "source-command-list-commands"
description: "List and explain all available Codex commands in this project"
---

# source-command-list-commands

Use this skill when the user asks to run the migrated source command `list-commands`.

## Command Template

# List Commands

Find and explain all available Codex slash commands in this project.

## Step 1: Discover All Commands

Search for command files in all possible locations:

```bash
# Project-level commands (repo-specific)
find .Codex/commands -name "*.md" 2>/dev/null

# User-level commands (global, shared across repos)
find ~/.Codex/commands -name "*.md" 2>/dev/null
```

## Step 2: Parse Each Command

For each `.md` file found, read the frontmatter and first few lines to extract:
- **name** — from the YAML frontmatter `name:` field
- **description** — from the YAML frontmatter `description:` field
- **location** — whether it's project-level or user-level
- **purpose** — a 1-line summary derived from reading the first heading and paragraph

## Step 3: Categorize Commands

Group commands by function:

### Git Workflow
Commands related to branching, committing, pushing, PRs, merging.

### Code Quality & Security
Commands related to linting, formatting, security analysis, and risk management.

### Debugging
Commands related to error analysis, log collection, test failures.

### Planning & Scoping
Commands related to task planning, epic scoping, branch setup.

### Other
Anything that doesn't fit the above categories.

## Step 4: Present the Guide

Output a formatted reference:

```
## Available Commands

### Git Workflow
| Command | Description | Usage |
|---------|-------------|-------|
| /commit-push | Lint + commit + push to all remotes | `/commit-push` |
| /commit-push-pr | Commit, push, and create PR | `/commit-push-pr` |
| ...

### Code Quality & Security
| Command | Description | Usage |
|---------|-------------|-------|
| /code-review | Lint + security + risk tagging + interactive fix | `/code-review [files]` |
| /list-risks | View tagged risks, pick which to fix | `/list-risks` |
| ...

(etc. for each category)
```

For each command, include:
- **What it does** — 1-2 sentence explanation
- **When to use it** — The scenario where this command is most valuable
- **What it checks/produces** — Key outputs or side effects
- **Related commands** — Other commands that work well with this one

## Step 5: Highlight the Quality System

Explain how the commands work together as a system:

```
## How Commands Work Together

1. /start-working → Begin a task with full context
2. /code-review → Lint + security + tag risks + fix (all-in-one)
3. /list-risks → Revisit and fix tagged risks later
4. /debug-check → Diagnose issues efficiently
5. /reduce-complexity → Keep code lean
6. /commit-push → Quality-gated commit to all remotes
7. /commit-push-pr → Same as above + PR creation
8. /finish-branch → Clean up when done
```

## Step 6: Check for Missing Setup

Warn if any common tooling is missing that commands depend on:
- ESLint / Prettier / Biome for JS/TS projects
- clippy / rustfmt for Rust
- ruff / mypy for Python
- `gh` CLI for GitHub PR commands
- `jira` CLI for Jira commands (optional)

## Notes

- Project-level commands (`.Codex/commands/`) take precedence over user-level (`~/.Codex/commands/`)
- Commands are invoked with `/command-name` in Codex
- Arguments can be passed after the command name
- To share commands across repos, copy the `.Codex/commands/` directory
