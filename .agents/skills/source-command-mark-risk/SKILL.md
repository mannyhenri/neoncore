---
name: "source-command-mark-risk"
description: "Manage HIGH-RISK function markers — scan, tag, review status, and audit"
---

# source-command-mark-risk

Use this skill when the user asks to run the migrated source command `mark-risk`.

## Command Template

# Mark Risk

Manage the HIGH-RISK annotation system for security-sensitive functions.

## Step 1: Determine Action

Use AskUserQuestion if not provided as argument:
- **Question:** "What do you want to do with HIGH-RISK markers?"
- **Header:** "Action"
- **Options:**
  1. **Scan & tag** — Find unmarked security-sensitive functions and tag them
  2. **Audit** — Show all HIGH-RISK markers and their review status
  3. **Review** — Mark a specific function as REVIEWED after human verification
  4. **Reset modified** — Find REVIEWED functions that changed and reset to UNREVIEWED

---

## Action: Scan & Tag

### Find Security-Sensitive Functions

Search all source files for functions that handle:
- Authentication / authorization / login / session / token
- Encryption / hashing / cryptography / signing
- Database queries with dynamic input / ORM write operations
- File system operations with user-provided paths
- HTTP request handling / API endpoints / webhook receivers
- Payment processing / financial calculations
- Email sending / notification dispatch
- User input parsing / validation / sanitization
- IAM policies / security groups / permissions (in IaC files)
- Secret/credential loading or management

### Check if Already Tagged

For each found function, check if it already has a `HIGH-RISK-UNREVIEWED` or `HIGH-RISK-REVIEWED` marker within 3 lines of the function signature.

### Tag Unmarked Functions

Add the marker as the first line inside the function body:

**JavaScript/TypeScript:**
```typescript
function handleLogin(credentials: LoginInput) {
  //HIGH-RISK-UNREVIEWED
  // ... function body
}
```

**Python:**
```python
def handle_login(credentials):
    #HIGH-RISK-UNREVIEWED
    # ... function body
```

**Rust:**
```rust
fn handle_login(credentials: &LoginInput) -> Result<Token> {
    //HIGH-RISK-UNREVIEWED
    // ... function body
}
```

**Terraform:**
```hcl
resource "aws_iam_policy" "admin" {
  #HIGH-RISK-UNREVIEWED
  # ... resource body
}
```

Report each newly tagged function.

---

## Action: Audit

Search the entire project for all HIGH-RISK markers:

```bash
grep -rn "HIGH-RISK-UNREVIEWED\|HIGH-RISK-REVIEWED" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.rs" --include="*.go" --include="*.java" --include="*.tf" --include="*.hcl" .
```

Present a dashboard:

### HIGH-RISK Function Dashboard

| # | Function | File:Line | Status | Category |
|---|----------|-----------|--------|----------|
| 1 | handleLogin | auth.ts:45 | UNREVIEWED | Authentication |
| 2 | processPayment | payment.ts:120 | REVIEWED | Data Handling |
| 3 | aws_iam_policy.admin | main.tf:55 | UNREVIEWED | Infrastructure |

**Summary:**
- Total HIGH-RISK functions: X
- Reviewed: Y
- Unreviewed: Z (need human review)
- Review coverage: N%

---

## Action: Review

Ask which function to mark as reviewed:
- **Question:** "Which function have you reviewed? (provide file:line or function name)"
- **Header:** "Function"
- **Options:** List up to 4 UNREVIEWED functions, or user types custom

Change the marker from `HIGH-RISK-UNREVIEWED` to `HIGH-RISK-REVIEWED` for the specified function.

**IMPORTANT**: Remind the user:
> By marking this as REVIEWED, you confirm that you have personally read and understood the complete logic of this function, including all edge cases, error handling, and security implications.

---

## Action: Reset Modified

Check git diff for any files containing `HIGH-RISK-REVIEWED` that have been modified:

```bash
git diff --name-only | xargs grep -l "HIGH-RISK-REVIEWED" 2>/dev/null
```

For each file, check if lines around the marker were changed. If the function body was modified, change `HIGH-RISK-REVIEWED` to `HIGH-RISK-UNREVIEWED`.

Report each reset with reason.

---

## Notes

- The HIGH-RISK system exists to ensure humans have personally verified security-critical code
- AI (Codex) must ALWAYS mark functions as UNREVIEWED — only humans can mark REVIEWED
- Any modification to a REVIEWED function by anyone (human or AI) must reset it to UNREVIEWED
- The `/check-code` and `/commit-push` commands also check for HIGH-RISK markers as part of their workflow
