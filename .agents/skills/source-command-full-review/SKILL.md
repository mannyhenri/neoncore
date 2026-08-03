---
name: "source-command-full-review"
description: "Full review — challenge assumptions, code review, and debug analysis in one pass"
---

# source-command-full-review

Use this skill when the user asks to run the migrated source command `full-review`.

## Command Template

# Full Review

Combined quality gate that runs challenge, code review, and debug analysis sequentially, producing a unified report.

## Phase 1: Challenge (Devil's Advocate)

Read the active plan file at `.Codex/plans/` or the most recent changes on the current branch:

```bash
git log --oneline -10
git diff --stat HEAD~3..HEAD 2>/dev/null || git diff --stat HEAD
```

Critically question the approach:

### Assumptions
- What assumptions is this implementation making?
- Are we solving the right problem at the right layer?
- What if key assumptions are wrong?

### Risks
- What could go wrong in production?
- Edge cases not considered?
- Security implications? Performance at scale?
- What are the failure modes?

### Alternatives
- Is there a simpler way to achieve this?
- Are there existing patterns in the codebase we could reuse?
- What would a 10x simpler solution look like?

### Gaps
- What's missing? Dependencies not identified?
- Testing strategy? Rollback plan? Monitoring?

### Complexity Check
- Over-engineered for the problem?
- Will future developers understand this?

---

## Phase 2: Code Review (Lint + Security + Risk Tags)

### 2a: Detect and Lint

Detect project type and run linters:

```bash
ls package.json Cargo.toml pyproject.toml go.mod 2>/dev/null
```

Run appropriate linters (format check, lint, type check, dependency audit) based on project type. Auto-fix what can be auto-fixed.

### 2b: Security Analysis

Review changed files for:
- **Secrets**: API keys, passwords, tokens, credentials in code or staged files
- **Injection**: SQL, command, XSS via string concat, eval(), exec()
- **Auth issues**: Missing auth checks, weak token handling
- **Data exposure**: Logging PII, verbose error messages
- **Path traversal**: File operations with user-supplied paths

### 2c: Risk Tagging

Tag security-sensitive functions:
- **HIGH**: SQL/command injection, missing auth, hardcoded secrets, path traversal, broken crypto
- **MINOR**: Missing input validation, verbose errors, complexity, unused code

Add `//HIGH-RISK-UNREVIEWED` or `//MINOR-RISK-UNREVIEWED` as first line inside flagged function bodies. Skip already-tagged functions.

---

## Phase 3: Debug Analysis

Without re-running expensive builds, analyze for issues:

1. **Read recent build/test output** if available in `/tmp/*.log` or project logs
2. **Check for type errors**: `npx tsc --noEmit 2>&1` (fast, no build)
3. **Trace error chains**: For each error, read the file, trace imports/dependencies, identify root cause
4. **Check recent commits** for regressions:
   ```bash
   git log --oneline -5
   git diff HEAD~1 -- <suspicious files>
   ```

Present error chains as:
```
Root: <root cause> in file:line
  -> <consequence> in file:line
    -> <symptom>
```

---

## Phase 4: Unified Report

Present a single combined report:

```
## Full Review Report

### Challenge Results
[Critical concerns, moderate risks, minor considerations, alternative approaches, open questions]

### Code Review Results

#### Lint
- Format: [status]
- Lint: [status]
- Types: [status]
- Deps: [status]

#### Security
- Secrets: [status]
- Injection risks: [count]
- Auth issues: [count]

#### Risk Tags Added
| # | Risk | Function | File:Line | Category |
|---|------|----------|-----------|----------|

### Debug Analysis
[Error chains found, root causes identified, fixes applied or suggested]

### Verdict: PASS | NEEDS_FIXES | CRITICAL_ISSUES

**PASS**: No HIGH risks, no critical concerns, lint clean, no errors
**NEEDS_FIXES**: MINOR risks or moderate concerns that should be addressed
**CRITICAL_ISSUES**: HIGH risks, critical concerns, or blocking errors found
```

## Phase 5: Interactive Fix

If verdict is NEEDS_FIXES or CRITICAL_ISSUES, use AskUserQuestion:
- **Question:** "How should we proceed?"
- **Header:** "Fix scope"
- **Options:**
  1. **Fix all issues** — Address all HIGH and MINOR risks, apply suggested fixes
  2. **Fix HIGH only** — Only fix critical/high severity issues
  3. **Skip fixes** — Keep tags in code, fix later with `/list-risks`

Apply chosen fixes, verify with lightweight checks (type check, lint), and report what was fixed.
