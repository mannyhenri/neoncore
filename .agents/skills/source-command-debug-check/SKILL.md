---
name: "source-command-debug-check"
description: "Analyze build errors, runtime logs, and test failures without running expensive CLI commands"
---

# source-command-debug-check

Use this skill when the user asks to run the migrated source command `debug-check`.

## Command Template

# Debug Check

Efficiently diagnose issues by analyzing existing output, logs, and error patterns — minimizing expensive rebuilds and browser checks.

## Step 1: Identify the Problem Type

Use AskUserQuestion if not clear from arguments:
- **Question:** "What kind of issue are you debugging?"
- **Header:** "Issue type"
- **Options:**
  1. **Build error** — Compilation or bundling failed
  2. **Runtime error** — App crashes or throws errors
  3. **Test failure** — Tests are failing
  4. **Unexpected behavior** — App works but does the wrong thing

## Step 2: Collect Diagnostic Data (without re-running)

### For Build Errors

Read the most recent build output. Check for common log locations:

```bash
# Check for recent build output in common locations
ls -t /tmp/*.log 2>/dev/null | head -3
ls -t ./*.log 2>/dev/null | head -3
```

If no cached output exists, run the build once and capture output:
```bash
# Node projects
npm run build 2>&1 | tee /tmp/build-output.log

# Rust projects
cargo build 2>&1 | tee /tmp/build-output.log
```

Parse the output for:
- **Error count**: How many errors total
- **First error**: Usually the root cause (later errors often cascade)
- **Error locations**: file:line for each
- **Error types**: Type errors, import errors, syntax errors, etc.

### For Runtime Errors

Check browser console logs if provided, or check:
```bash
# Check for running dev servers and their output
lsof -i :3000 -i :5173 -i :8080 -i :4200 2>/dev/null
```

Read the relevant source files around the error location. Do NOT suggest "open the browser and check" — instead:
1. Read the component/function that's failing
2. Trace the data flow from input to error
3. Check for common patterns: null access, missing props, async race conditions

### For Test Failures

Run tests once with verbose output:
```bash
# Node
npm test -- --verbose 2>&1 | tee /tmp/test-output.log

# Rust
cargo test -- --nocapture 2>&1 | tee /tmp/test-output.log

# Python
pytest -v 2>&1 | tee /tmp/test-output.log
```

Parse for:
- Which tests failed
- Expected vs actual values
- Stack traces

### For Unexpected Behavior

Do NOT suggest opening a browser. Instead:
1. Read the relevant source code
2. Trace the logic path
3. Check state/data flow
4. Look for off-by-one errors, wrong conditionals, missing edge cases

## Step 3: Root Cause Analysis

For each error found:

1. **Read the erroring file** at the reported line
2. **Read 20 lines of context** around the error
3. **Trace imports/dependencies** — read related files if the error involves cross-file references
4. **Check recent changes** that might have caused it:
   ```bash
   git log --oneline -10
   git diff HEAD~1 -- <erroring-file>
   ```

## Step 4: Abstracted Diagnosis Report

Present findings as a clear, abstracted summary (not raw logs):

### Problem Summary
One sentence describing the root cause.

### Error Chain
Show the causal chain from root to symptom:
```
Root: Missing export in utils/helpers.ts:15
  → Import fails in components/Widget.tsx:3
    → Build error: "Cannot find module './helpers'"
```

### For Distributed/Multi-file Issues
Summarize data flow status:
```
✅ Data defined correctly in: data/features.ts
✅ Data imported correctly in: pages/HomePage.tsx
❌ Data prop type mismatch in: components/FeatureCard.tsx:22
   Expected: FeatureCardData[]
   Received: FeatureCardData (not wrapped in array)
```

### Fix
Provide the specific fix with file:line references. Apply the fix directly if straightforward.

## Step 5: Verify Fix (Minimal Cost)

After applying a fix, verify with the cheapest possible check:

1. **Type error?** → `npx tsc --noEmit` (no build needed)
2. **Lint error?** → `npm run lint -- --quiet` (just the file)
3. **Import error?** → Read the file and verify the export exists
4. **Runtime error?** → Read the logic and trace the fix through the data flow
5. **Only rebuild** if the above lightweight checks pass

```bash
# Targeted type check on specific file (faster than full build)
npx tsc --noEmit <specific-file> 2>/dev/null || npx tsc --noEmit
```

## Notes

- **Goal**: Diagnose and fix with minimum CLI invocations. Reading files is free; rebuilding is expensive.
- **Never suggest**: "Open your browser and check the console" — instead, read the source and trace the logic.
- **For distributed systems**: Summarize cross-service data flow as "Data X reached Service A but not Service B" rather than dumping raw logs.
- **Cache results**: If a build/test run was just done, read the cached output rather than re-running.
