---
name: "source-command-reduce-complexity"
description: "Analyze and simplify code to reduce context window cost and improve AI comprehension"
---

# source-command-reduce-complexity

Use this skill when the user asks to run the migrated source command `reduce-complexity`.

## Command Template

# Reduce Complexity

Analyze code for unnecessary complexity and suggest simplifications. Every line of code costs context window tokens, energy, and increases the probability of future AI task failures.

## Step 1: Determine Scope

If arguments are provided, analyze those files/directories.

Otherwise, analyze files changed since the last commit:
```bash
git diff --name-only HEAD
git diff --name-only --cached
```

If no changes, ask:
- **Question:** "What should I analyze for complexity?"
- **Header:** "Scope"
- **Options:**
  1. **Entire project** — Scan all source files
  2. **Specific directory** — I'll specify which
  3. **Largest files** — Start with the biggest files first

## Step 2: Measure Current Complexity

For each file in scope, gather metrics:

1. **Line count** — Flag files over 200 lines
2. **Function count** — Flag files with more than 10 functions
3. **Max function length** — Flag functions over 30 lines
4. **Max nesting depth** — Flag nesting deeper than 3 levels
5. **Parameter count** — Flag functions with more than 4 parameters
6. **Import count** — Flag files with more than 15 imports
7. **Duplicate patterns** — Similar code blocks across files

Sort results by complexity (worst first).

## Step 3: Identify Simplification Opportunities

For each complexity flag, categorize the fix:

### Quick Wins (safe, mechanical changes)
- **Dead code removal** — Unused imports, unreachable code, commented-out code
- **Inline single-use helpers** — Functions called only once that add indirection
- **Remove redundant type annotations** — Where TypeScript/Rust can infer
- **Collapse nested ternaries** — Replace with early returns or switch
- **Flatten unnecessary wrappers** — Components/functions that just pass through

### Structural Improvements (requires understanding)
- **Extract repeated patterns** — Only if used 3+ times (not premature abstraction)
- **Replace deep nesting with early returns** — Guard clauses
- **Merge tiny related files** — If they're always used together
- **Simplify state management** — Derived state that could be computed
- **Remove over-engineered abstractions** — Factories, strategies, or patterns used for a single case

### Do NOT Suggest
- Adding abstraction layers for hypothetical future use
- Creating utility files for one-off operations
- Splitting files that are already cohesive
- Adding configuration for things with one value

## Step 4: Apply Changes

For each simplification:
1. Explain what's being simplified and why (one line)
2. Show the before/after line count difference
3. Apply the change
4. Verify it doesn't break types: `npx tsc --noEmit` or equivalent

## Step 5: Report

### Summary

| Metric | Before | After | Saved |
|--------|--------|-------|-------|
| Total lines | X | Y | Z lines (-N%) |
| Functions > 30 lines | X | Y | |
| Files > 200 lines | X | Y | |
| Max nesting depth | X | Y | |
| Dead code removed | - | - | Z lines |

### Changes Made
List each change with file:line and brief explanation.

### Remaining Complexity
Flag items that were NOT simplified because:
- They serve a clear purpose at their current size
- Simplifying would reduce readability
- They need human judgment to restructure

### Context Window Impact
Estimate tokens saved (roughly 1 token per 4 chars):
```
Lines removed: X
Estimated tokens saved: ~Y
```
