---
name: "source-command-security-review"
description: "Run security analysis with HIGH-RISK function tagging on changed or specified files"
---

# source-command-security-review

Use this skill when the user asks to run the migrated source command `security-review`.

## Command Template

# Security Review

Perform a comprehensive security review with automatic HIGH-RISK function tagging.

## Step 1: Identify Scope

Determine what to review:
- If files are specified as arguments, review those files
- Otherwise, review files changed in the current branch vs the main branch:
```bash
# Auto-detect remote and base branch
# 1. Find first remote (could be origin, github, upstream, local, etc.)
# 2. Check remote HEAD, then try dev, then main as base branch
REMOTE=$(git remote | head -1)
BASE=$(git symbolic-ref refs/remotes/${REMOTE}/HEAD 2>/dev/null | sed "s|refs/remotes/${REMOTE}/||")
if [ -z "$BASE" ]; then
  # No remote HEAD set — try dev first (common default), then main
  git rev-parse --verify ${REMOTE}/dev &>/dev/null && BASE=dev || BASE=main
fi
git diff --name-only ${REMOTE}/${BASE}...HEAD 2>/dev/null || \
git diff --name-only HEAD~10...HEAD 2>/dev/null || \
git ls-files
```

## Step 2: HIGH-RISK Function Scan

### Identify Functions That Should Be Marked HIGH-RISK

Search changed files for functions that handle:

1. **Authentication/Authorization** — login, logout, token generation/validation, session management, OAuth flows, API key handling, permission checks
2. **Cryptography** — encryption, decryption, hashing, key generation, certificate handling
3. **Data Handling** — PII processing, payment data, database queries with user input, file uploads, serialization/deserialization of untrusted data
4. **External Communication** — API calls with credentials, webhook handlers, email sending, SMS, third-party integrations
5. **Infrastructure** — Terraform/IaC that creates IAM roles, security groups, public endpoints, S3 policies, Lambda permissions
6. **Input Processing** — User input parsing, URL handling, file path construction, command execution, template rendering

### Check Existing Markers

Search the entire project for current HIGH-RISK markers:

```bash
grep -rn "HIGH-RISK-UNREVIEWED\|HIGH-RISK-REVIEWED" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rs" --include="*.go" --include="*.java" --include="*.tf" .
```

### Tag Unmarked Functions

For any security-sensitive function found that is NOT already tagged:
- Add `//HIGH-RISK-UNREVIEWED` (or `#HIGH-RISK-UNREVIEWED` for Python, `//HIGH-RISK-UNREVIEWED` for Rust/Go) as the first line inside the function
- Report each newly tagged function to the user

### Reset Modified Functions

**CRITICAL**: If a function already marked `//HIGH-RISK-REVIEWED` has been modified in the current diff, change it to `//HIGH-RISK-UNREVIEWED`. Any change to a reviewed function invalidates the review.

```bash
# Find HIGH-RISK-REVIEWED functions that appear in the diff
git diff --name-only | xargs grep -l "HIGH-RISK-REVIEWED" 2>/dev/null
```

For each such file, check if the function body around the marker was changed in the diff.

## Step 3: Check for Secrets and Credentials

Search for potential secrets, API keys, passwords, tokens:
- Hardcoded passwords or API keys
- AWS/GCP/Azure credentials
- Private keys or certificates
- Connection strings with credentials
- JWT secrets
- `.env` files staged for commit

## Step 4: OWASP Top 10 Review

Review code for:
- **Injection**: SQL injection, command injection, code injection
- **Broken Authentication**: Weak password handling, session issues
- **Sensitive Data Exposure**: Unencrypted sensitive data, logging PII
- **XML External Entities (XXE)**: Unsafe XML parsing
- **Broken Access Control**: Missing authorization checks
- **Security Misconfiguration**: Debug modes, default credentials
- **XSS**: Unsanitized user input in output
- **Insecure Deserialization**: Unsafe deserialization of untrusted data
- **Vulnerable Dependencies**: Outdated packages with known CVEs
- **Insufficient Logging**: Missing audit trails for security events

## Step 5: Language-Specific Checks

**Rust:**
- `unsafe` blocks without justification
- Unchecked `.unwrap()` on user input
- Path traversal vulnerabilities
- TOCTOU race conditions

**JavaScript/TypeScript:**
- `eval()` or `Function()` usage
- `dangerouslySetInnerHTML` without sanitization
- Prototype pollution risks
- Regex DoS (ReDoS) patterns
- Unvalidated redirects

**Python:**
- `eval()`, `exec()`, `pickle.loads()` on untrusted data
- SQL string concatenation
- `subprocess` with `shell=True`
- Insecure temp file creation

**Go:**
- Unvalidated user input in `fmt.Sprintf` for SQL
- Missing error handling on security operations
- Insecure TLS configs

**Terraform/IaC:**
- Overly permissive IAM policies (wildcards)
- Public S3 buckets
- Security groups with 0.0.0.0/0 ingress
- Missing encryption at rest
- Hardcoded secrets in tfvars

## Step 6: Report Findings

### 🔴 Critical
Issues that must be fixed before deployment.
- For each: file:line, description, recommended fix

### 🟠 High
Significant security risks.

### 🟡 Medium
Potential vulnerabilities worth addressing.

### 🟢 Low
Minor issues or best practice suggestions.

### 🏷️ HIGH-RISK Marker Summary

| Function | File | Status | Action Taken |
|----------|------|--------|--------------|
| `authenticateUser` | auth.ts:45 | UNREVIEWED | Newly tagged |
| `processPayment` | payment.ts:120 | UNREVIEWED | Reset (was REVIEWED but modified) |
| `hashPassword` | crypto.ts:30 | REVIEWED | No changes |

**Unreviewed count**: X functions need human review
**Reviewed count**: Y functions have been reviewed

### Next Steps
- List HIGH-RISK-UNREVIEWED functions that need human review
- A human must read, understand, and verify each function before changing the marker to HIGH-RISK-REVIEWED
