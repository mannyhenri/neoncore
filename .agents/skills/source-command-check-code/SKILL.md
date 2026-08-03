---
name: "source-command-check-code"
description: "Run strict linting, formatting, type checks, and complexity analysis on changed or specified files"
---

# source-command-check-code

Use this skill when the user asks to run the migrated source command `check-code`.

## Command Template

# Check Code Quality

Run strict linting, formatting, type checks, and complexity analysis. Auto-detects project type.

## Step 1: Detect Project Structure

Scan the repository root to identify what exists:

```bash
ls package.json Cargo.toml pyproject.toml setup.py requirements.txt go.mod Makefile 2>/dev/null
```

Also check for common tool configs:

```bash
ls .eslintrc* eslint.config* .prettierrc* biome.json tsconfig.json rustfmt.toml .clippy.toml .flake8 .ruff.toml ruff.toml 2>/dev/null
```

Record which stacks are present:
- **Node/TS**: `package.json` exists
- **Rust**: `Cargo.toml` exists
- **Python**: `pyproject.toml`, `setup.py`, or `requirements.txt` exists
- **Go**: `go.mod` exists

Check for monorepo structure (multiple package.json, Cargo.toml in subdirectories).

## Step 2: Determine Scope

If arguments are provided, check only those files/directories.

Otherwise, check files changed since the last commit:

```bash
git diff --name-only HEAD
git diff --name-only --cached
```

If no changes, check all tracked files:
```bash
git ls-files
```

## Step 3: Run Stack-Specific Checks

### Node/TypeScript Projects

For each directory containing a `package.json`:

**Format Check:**
```bash
# Check if prettier is available
npx prettier --check . 2>/dev/null || echo "Prettier not configured"
```

**Lint:**
```bash
# Use the project's lint script if available
npm run lint 2>/dev/null || npx eslint . 2>/dev/null || echo "ESLint not configured"
```

**Type Check:**
```bash
npx tsc --noEmit 2>/dev/null || echo "TypeScript not configured"
```

**Auto-fix (if issues found):**
```bash
npm run lint -- --fix 2>/dev/null
npx prettier --write . 2>/dev/null
```

### Rust Projects

For each directory containing a `Cargo.toml`:

```bash
cargo fmt --check
SQLX_OFFLINE=true cargo clippy -- -D warnings -W clippy::pedantic 2>/dev/null || cargo clippy -- -D warnings
```

### Python Projects

```bash
# Prefer ruff (fast), fall back to flake8/pylint
ruff check . 2>/dev/null || flake8 . 2>/dev/null || pylint **/*.py 2>/dev/null
ruff format --check . 2>/dev/null || black --check . 2>/dev/null
mypy . 2>/dev/null || echo "Type checking not configured"
```

### Go Projects

```bash
go vet ./...
gofmt -l .
golangci-lint run 2>/dev/null || echo "golangci-lint not installed"
```

## Step 4: Dependency Security Audit

Run audit for detected stacks:

```bash
# Node
npm audit 2>/dev/null

# Rust
cargo audit 2>/dev/null

# Python
pip-audit 2>/dev/null || safety check 2>/dev/null
```

## Step 5: Code Complexity Scan

Search for complexity indicators in changed files:

1. **Long functions** — Find functions longer than 50 lines
2. **Deep nesting** — Find code with more than 4 levels of nesting
3. **Large files** — Flag files over 300 lines
4. **Duplicated patterns** — Note similar code blocks

Use grep/search to identify these in the changed files and report them.

## Step 6: HIGH-RISK Marker Audit

Check for any `//HIGH-RISK-UNREVIEWED` or `//HIGH-RISK-REVIEWED` markers in changed files:

```bash
git diff --name-only HEAD | xargs grep -n "HIGH-RISK" 2>/dev/null
```

Report:
- Any HIGH-RISK functions that were modified (should be marked UNREVIEWED)
- Any UNREVIEWED functions that haven't been addressed
- Total count of HIGH-RISK markers in the project

## Step 7: Report

Present a summary:

### ✅ Passed
- Checks that passed cleanly

### ❌ Failed
- Checks that found issues (with file:line references)

### ⚠️ Warnings
- Complexity concerns
- Large files
- Missing lint/format configs
- Unreviewed HIGH-RISK functions

### 🔧 Auto-Fixed
- Issues that were automatically resolved

### 📊 Stats
- Files checked: X
- Issues found: X (Y auto-fixed)
- HIGH-RISK markers: X unreviewed / Y reviewed
