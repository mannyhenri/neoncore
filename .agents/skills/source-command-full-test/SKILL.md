---
name: "source-command-full-test"
description: "Comprehensive testing — audit coverage, find gaps, implement missing tests, run all tests"
---

# source-command-full-test

Use this skill when the user asks to run the migrated source command `full-test`.

## Command Template

# Full Test

Evaluate existing test coverage, identify gaps, implement missing tests, and run the full suite.

## Phase 1: Detect Test Framework

```bash
ls package.json Cargo.toml pyproject.toml go.mod 2>/dev/null
```

Identify the test framework:
- **Node**: Check for vitest, jest, mocha in package.json (devDependencies + scripts)
- **Rust**: cargo test (built-in)
- **Python**: Check for pytest, unittest in pyproject.toml or imports
- **Go**: go test (built-in)

```bash
# Node — detect framework
cat package.json | grep -E "vitest|jest|mocha" 2>/dev/null
# Find existing test files
find . -name "*.test.*" -o -name "*.spec.*" -o -name "test_*" | grep -v node_modules | head -30
```

## Phase 2: Audit Existing Tests

Categorize all existing test files by type:

| Type | What it tests | Example patterns |
|------|---------------|------------------|
| **Unit** | Single function/component in isolation | Mock dependencies, test inputs → outputs |
| **Integration** | Multiple modules working together | API endpoints, DB queries, service interactions |
| **E2E / Functional** | Full user workflows | Browser automation, CLI test scripts |
| **Regression** | Previously fixed bugs | Tests added alongside bug fix commits |
| **Security** | Auth bypass, injection, XSS | Malformed inputs, auth edge cases |
| **Performance** | Response times, load handling | Benchmark tests, stress tests |
| **Edge case** | Boundary values, null/empty, concurrency | Empty arrays, max values, race conditions |

For each test file found:
1. Read it to determine what it covers and which type(s) it is
2. Note which source files/modules it tests
3. Note any patterns (test utilities, fixtures, mocks)

## Phase 3: Gap Analysis

### 3a: Identify Changed Files

```bash
# Files changed on this branch vs main
git diff --name-only main...HEAD 2>/dev/null || git diff --name-only HEAD~10..HEAD
```

### 3b: Map Coverage

For each changed source file, check:
- Does a corresponding test file exist?
- Are the new/modified functions covered?
- What test types are missing?

### 3c: Report Gaps

```
## Coverage Gap Analysis

### Files with NO tests
| Source File | Functions | Risk |
|------------|-----------|------|
| src/utils/parser.ts | parseInput, validate | HIGH — handles user input |

### Files with PARTIAL tests
| Source File | Covered | Missing |
|------------|---------|---------|
| src/api/users.ts | getUser, listUsers | deleteUser, updateUser |

### Missing Test Types
- [ ] Security tests for auth endpoints
- [ ] Edge case tests for input validation
- [ ] Integration tests for DB operations
```

## Phase 4: Implement Missing Tests

Write tests to fill the most critical gaps, following project patterns:

### Priorities (implement in this order):
1. **Unit tests** for new/modified functions without coverage
2. **Integration tests** for API endpoints or cross-module flows
3. **Edge case tests** for boundary values, null/empty inputs, error paths
4. **Security tests** for auth, input validation, injection prevention

### Rules:
- Follow existing test file naming conventions (detect from Phase 2)
- Use the same test framework, assertion library, and mock patterns as existing tests
- Keep tests focused — one behavior per test
- Use descriptive test names that explain the expected behavior
- Don't test implementation details — test behavior and contracts

## Phase 5: Run All Tests

Execute the full test suite:

```bash
# Node (vitest)
npx vitest run 2>&1

# Node (jest)
npx jest --verbose 2>&1

# Rust
cargo test 2>&1

# Python
pytest -v 2>&1

# Go
go test ./... -v 2>&1
```

If tests fail:
1. Read the failure output
2. Determine if it's a test bug or a code bug
3. Fix the issue (prefer fixing the code if it's a real bug, fix the test if the test is wrong)
4. Re-run to verify

## Phase 6: Report

```
## Test Coverage Report

### Existing Coverage (before this run)
- Unit: X tests across Y files
- Integration: X tests
- E2E: X tests
- Security: X tests
- Edge case: X tests

### New Tests Added
| File | Type | What it covers |
|------|------|----------------|
| src/__tests__/parser.test.ts | Unit | parseInput validation, edge cases |
| src/__tests__/api.test.ts | Integration | User CRUD endpoints |

### Test Results
- Passed: X
- Failed: Y
- Skipped: Z
- Total runtime: Xs

### Remaining Gaps
- [Areas that still need tests but were out of scope]
- [Complex scenarios that need manual test design]

### Recommendations
- [Suggestions for improving test infrastructure]
- [Test patterns that should be adopted project-wide]
```
