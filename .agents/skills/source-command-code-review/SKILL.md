---
name: "source-command-code-review"
description: "Unified code quality gate — lint, security analysis, risk tagging, and interactive fix workflow"
---

# source-command-code-review

Use this skill when the user asks to run the migrated source command `code-review`.

## Command Template

# Code Review

Single command that lints, audits security, tags risks, and lets you fix them — all in one interactive flow.

## Phase 1: Lint & Format

### 1a: Detect Project Structure

```bash
ls package.json Cargo.toml pyproject.toml setup.py go.mod 2>/dev/null
```

### 1b: Determine Scope

If arguments are provided, check only those files/directories.

Otherwise, detect changed files:
```bash
git diff --name-only HEAD
git diff --name-only --cached
git status --porcelain
```

If no changes, check all tracked source files.

### 1c: Run Linters

**Rust** (if `Cargo.toml` exists):
```bash
cargo fmt --check
cargo clippy -- -D warnings
```

**JavaScript/TypeScript** (if `package.json` exists):
```bash
npx prettier --check . 2>/dev/null
npm run lint -- --quiet 2>/dev/null || npx eslint . 2>/dev/null
npx tsc --noEmit 2>/dev/null
```

**Python** (if `pyproject.toml` or `setup.py` exists):
```bash
ruff check . 2>/dev/null || flake8 . 2>/dev/null
ruff format --check . 2>/dev/null || black --check . 2>/dev/null
```

**Shell scripts** (if `.sh` files changed):
```bash
shellcheck <files> 2>/dev/null
```

### 1d: Auto-Fix Lint Issues

If lint errors are found, attempt auto-fix:

```bash
# Rust
cargo fmt

# JS/TS
npx prettier --write . 2>/dev/null
npm run lint -- --fix 2>/dev/null

# Python
ruff check --fix . 2>/dev/null
ruff format . 2>/dev/null
```

Re-run checks after auto-fix. Record what was auto-fixed vs what still needs manual attention.

### 1e: Dependency Audit (quick)

```bash
cargo audit 2>/dev/null
npm audit --audit-level=high 2>/dev/null
pip-audit 2>/dev/null
```

Report any known CVEs but don't block the flow.

---

## Phase 2: Security Analysis

### 2a: Secrets Scan

Search changed and staged files for potential secrets:

```bash
git diff --cached -- . | grep -iE "(api_key|api_secret|password|secret_key|private_key|token)" | grep -vE "(example|placeholder|TODO|env\\.|process\\.env|config\\[)" 2>/dev/null
```

Also check for:
- `.env` files staged for commit
- Hardcoded connection strings with credentials
- AWS/GCP/Azure credentials
- Private keys or certificates

### 2b: OWASP Vulnerability Scan

Review changed files for:
- **Injection**: SQL/Cypher/command injection via `format!()`, string concat, `eval()`, `exec()`
- **Broken Auth**: Missing auth checks, weak token handling, timing attacks
- **Data Exposure**: Logging PII, unencrypted sensitive data, verbose error messages
- **Broken Access Control**: Missing authorization checks, direct object references
- **XSS**: Unsanitized user input in HTML output, `dangerouslySetInnerHTML`
- **Insecure Deserialization**: `pickle.loads()`, unsafe JSON parsing of untrusted data
- **Path Traversal**: File operations with user-supplied paths

### 2c: Language-Specific Checks

**Rust:**
- `unsafe` blocks without justification
- Unchecked `.unwrap()` on user input
- `Command::new()` with user-derived arguments
- TOCTOU race conditions

**JavaScript/TypeScript:**
- `eval()` or `Function()` usage
- Prototype pollution risks
- Regex DoS (ReDoS) patterns
- Unvalidated redirects

**Python:**
- `eval()`, `exec()`, `pickle.loads()` on untrusted data
- `subprocess` with `shell=True`
- SQL string concatenation

---

## Phase 3: Risk Tagging

### 3a: Find Security-Sensitive Functions

Search source files for functions that handle:
- Authentication / authorization / token validation
- Encryption / hashing / cryptographic signing
- Database queries with dynamic input (SQL, Cypher)
- File uploads or file operations with user paths
- HTTP endpoint handlers that process external user input
- License validation / enforcement
- Secret or credential loading

### 3b: Classify Each Issue

For every issue found (lint, security, or risk), classify as:

**HIGH** — Must fix before shipping:
- SQL/Cypher/command injection
- Missing authentication or authorization
- Hardcoded secrets or credentials
- Path traversal vulnerabilities
- Broken cryptographic operations
- Known CVEs in dependencies (critical/high severity)

**MINOR** — Should fix, lower urgency:
- Missing input validation on non-security fields
- Verbose error messages leaking internals
- Complexity warnings (deep nesting, long functions)
- Unused code or dead imports
- Style/formatting issues that auto-fix missed
- Known CVEs in dependencies (medium/low severity)
- Auth patterns that work but could be stronger

### 3c: Tag in Code

For HIGH risk functions, add marker as the first line inside the function body:

**Rust:** `//HIGH-RISK-UNREVIEWED`
**Python:** `#HIGH-RISK-UNREVIEWED`
**JavaScript/TypeScript:** `//HIGH-RISK-UNREVIEWED`

For MINOR risk functions, add:

**Rust:** `//MINOR-RISK-UNREVIEWED`
**Python:** `#MINOR-RISK-UNREVIEWED`
**JavaScript/TypeScript:** `//MINOR-RISK-UNREVIEWED`

Skip tagging functions that already have a marker.

---

## Phase 4: Interactive Dashboard & Fix Prompt

### 4a: Present Unified Dashboard

```
## Code Review Results

### Lint
- Format: ✅ Clean (or ⚠️ N issues auto-fixed)
- Clippy: ✅ Clean (or ❌ N errors)
- Deps: ✅ No CVEs (or ⚠️ N advisories)

### Security
- Secrets: ✅ None detected (or 🔴 N potential secrets found)
- Injection risks: N found
- Auth issues: N found

### Risk Tags
| # | Risk  | Function             | File:Line           | Category         |
|---|-------|----------------------|---------------------|------------------|
| 1 | HIGH  | extract_table_data   | db_connectors.rs:98 | SQL Injection    |
| 2 | HIGH  | store_relationship   | neo4j.rs:709        | Cypher Injection |
| 3 | MINOR | neon_query           | handlers.rs:4868    | Input Handling   |
| ...

**Summary:**
- HIGH risk: X functions
- MINOR risk: Y functions
- Lint issues remaining: Z
```

### 4b: Prompt User for Action

Use AskUserQuestion:
- **Question:** "What would you like to fix?"
- **Header:** "Fix scope"
- **Options:**
  1. **Fix all HIGH risks** — Fix all HIGH-tagged vulnerabilities now
  2. **Fix all risks (HIGH + MINOR)** — Fix everything
  3. **Skip for now** — Keep tags in code, fix later with `/list-risks`

### 4c: Apply Fixes (if user chose to fix)

For each tagged function the user chose to fix, apply the appropriate remediation:

**SQL Injection:**
- Sanitize dynamic table/column names (strip non-alphanumeric/underscore, wrap in double quotes)
- Use parameterized queries for dynamic values
- Validate LIMIT/OFFSET as integers

**Cypher Injection:**
- Sanitize dynamic relationship types (strip non-alphanumeric/underscore, uppercase)
- Validate against known relationship types where possible

**Command Injection:**
- Avoid shell expansion, use argument arrays
- Validate/sanitize user input before passing to commands

**Auth Weakness:**
- Add constant-time comparison where needed
- Ensure all endpoints have auth checks
- Sanitize error responses

**Input Handling:**
- Add validation for required fields
- Validate content types, sizes, formats
- Sanitize before passing to downstream systems

**General rules:**
- Keep fixes minimal — don't refactor beyond what's needed
- Add `// SEC: <description>` comments explaining each security fix
- Preserve existing behavior for valid inputs

### 4d: Verify Fixes

After applying fixes:

```bash
# Compile check
cargo check 2>&1

# Lint check
cargo clippy -- -D warnings 2>&1

# Test suite
cargo test 2>&1
```

Fix any issues that arise. All three must pass.

### 4e: Remove Tags for Fixed Functions

For each function that was successfully fixed and verified:
- Delete the `//HIGH-RISK-UNREVIEWED` or `//MINOR-RISK-UNREVIEWED` line entirely
- Keep the `// SEC:` comments that were added

Verify no tags remain for fixed functions:
```bash
grep -rn "RISK-UNREVIEWED" --include="*.rs" --include="*.py" --include="*.js" --include="*.ts" .
```

Report any tags that could NOT be removed (function couldn't be fully fixed).

---

## Phase 5: Final Report

```
## Code Review Complete

### Lint
- Format: ✅ Clean
- Clippy: ✅ Clean (N issues auto-fixed)
- Tests: ✅ Passing

### Security Fixes Applied
| # | Function           | File              | Issue            | Fix              |
|---|--------------------|--------------------|------------------|------------------|
| 1 | extract_table_data | db_connectors.rs   | SQL Injection    | Sanitized names  |
| 2 | store_relationship | neo4j.rs           | Cypher Injection | Sanitized types  |

### Remaining Tags (fix later with /list-risks)
| # | Risk  | Function   | File:Line         | Reason           |
|---|-------|------------|-------------------|------------------|
| 1 | MINOR | neon_query | handlers.rs:4868  | User chose skip  |

### Summary
- Issues found: X
- Auto-fixed (lint): Y
- Security fixes applied: Z
- Tags remaining: N (use /list-risks to address later)
```

---

## Notes

- This command replaces the former `/lint-check`, `/check-code`, `/security-review`, `/mark-risk`, and `/fix-high-risk`
- The `/commit-push` command still checks for remaining risk tags as part of its pre-commit gate
- Use `/list-risks` to revisit and fix tagged risks later
- Run again anytime to re-scan after new changes
