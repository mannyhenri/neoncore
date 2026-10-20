# The NeonCore Work Standard

Every ask dispatched through NeonCore — dashboard prompt, mobile prompt, workflow step,
queued task, agent-to-agent handoff — is executed under this contract. It exists because
of two specific, recurring failure modes:

- **Partial completion.** Asked to fix "a report doesn't copy all items from the previous
  report," the agent fixed the copy for *a few sections* and stopped. It never established
  how many sections exist, so "some sections now work" looked like success.
- **Silent deference.** The agent decides part of the ask isn't its call, leaves it out,
  and doesn't say so. The gap is only discovered by the human, later, in production.

Both have the same root cause: **work started from the symptom instead of from the set.**
This standard forces the set to be established first, and completion to be measured
against it.

---

## The five phases

Every task runs SCOPE → REPRODUCE → FIX → VERIFY → REPORT. No phase is skipped. For a
one-line change the first two phases take thirty seconds; they are still not skipped.

### 1. SCOPE — establish the complete set before touching code

Restate the ask in one sentence, then **enumerate what "all" means, derived from the code,
not from the bug report.**

The bug report says "items aren't copied." The report is a sample, not the scope. Go find
the authoritative list: the registry, the schema, the type, the enum, the call sites.
Write down the count.

> Copying a report must carry: 12 sections (`REPORT_SECTIONS` in `lib/report-schema.ts`),
> 4 of which have nested line items, plus 3 top-level attachments. N = 12 + 3.

If you cannot produce a definitive count, say so explicitly and state the method you used
to bound it (`grep -rn "copyFrom" src/` → 9 call sites). An unbounded scope is a finding,
not a reason to start typing.

**Also state, in the same breath, what would prove the task done.** The success test is
defined *now*, before any code changes — not chosen afterwards from whatever happens to
pass.

### 2. REPRODUCE — a failing test over the whole set, not one example

Write the test before the fix and watch it fail.

**The test must be set-based.** This is the rule that would have caught the report bug:

```ts
// WRONG — passes with a half-done fix
expect(copied.sections.summary).toEqual(original.sections.summary)
expect(copied.sections.findings).toEqual(original.sections.findings)

// RIGHT — fails until every member of the set is handled
for (const key of REPORT_SECTIONS) {
  expect(copied.sections[key]).toEqual(original.sections[key])
}
expect(Object.keys(copied.sections)).toHaveLength(REPORT_SECTIONS.length)
```

An example-based test is a half-fix detector that doesn't detect. It passes as soon as the
examples you happened to pick are handled, which is exactly the failure being prevented.

Drive the test off the same registry the production code uses, so a section added later is
covered automatically.

If the work is a feature rather than a bug, the equivalent is a test that fails because the
feature doesn't exist yet, covering every case listed in SCOPE.

If the thing genuinely cannot be tested in code (visual polish, infra, a one-off script),
say so and define the manual verification instead — exact steps, expected observation.
"Cannot be tested" is a claim that needs a reason, not a default.

### 3. FIX — the whole set, in one pass

Fix every item enumerated in SCOPE. Not the first few. Not the ones that were easy.

Prefer a fix at the level of the set over N fixes at the level of the item: if twelve
sections each need copying, iterate the registry rather than adding twelve lines — a
per-item fix silently excludes item thirteen when someone adds it next month.

**Deference is allowed exactly once, and never silently.** If something in scope must not
be done — genuinely blocked, genuinely out of bounds, genuinely requires a decision that
isn't yours — it goes in the `deferred:` line of the report with the reason. It does not
get dropped, softened into a suggestion, or left as a "consider also…" at the end.

The default expectation is `deferred: none`.

### 4. VERIFY — run the test from phase 1, paste the real output

Run the exact test defined in SCOPE. Paste the actual output, including the counts.

Then run the surrounding suite, the type check, and the linter — a fix that breaks three
other tests is not a fix.

The verdict is the observed output. Not "should now work," not "the change looks correct."
If you did not run it, the task is not verified, and saying it is verified is a false
report.

If verification fails, return to FIX. A failing verify never ends the task.

### 5. REPORT — machine-checkable completion

End the task with this block, verbatim, as the last thing you emit:

```
NEONCORE-DONE
scope: <done>/<total> — <one line on what the set was>
verify: <exact command run> → <actual result>
deferred: none
```

Real example:

```
NEONCORE-DONE
scope: 15/15 — 12 report sections + 3 attachment types, per REPORT_SECTIONS
verify: npm test -- report-copy → 15 passed, 0 failed
deferred: none
```

If something was deferred, it is named and justified:

```
deferred: audit-log section — copying it needs a retention decision (see #412)
```

`scope:` where done < total, or a `deferred:` line, is a legitimate outcome. An **absent**
completion block, or one where `verify:` has no real command output, is not — that is the
half-done state this standard exists to make impossible.

**Workflow steps and claimed tasks report through the tool instead.** A step's completion
call (`neoncore_report_step_done`) or a task's (`neoncore_report_task_done`) carries the same
`scope` / `verify` / `deferred` fields, and the endpoint rejects it without real verification.
An *accepted* report closes the objective and disarms the stop gate (`disarmOnReport`), so a
step agent is never asked for the same block twice. That is why workflow steps are dispatched
with the standard *silent* (`standard: 'silent'`): the gate is offered and arms on the first
edit, but the short form below is not appended — the step's completion instruction and the
tool's schema already carry the contract.

---

## The short form

This is the version injected into dispatched prompts. It is the standard compressed, not a
different standard:

> **NeonCore work standard.** Before coding: restate the ask, enumerate the COMPLETE set of
> things it touches (from the code — registry/schema/call sites — not from the description),
> state the count, and state the test that will prove it done. Write that test first and
> watch it fail; make it set-based (iterate the registry) so a partial fix cannot pass it.
> Then fix EVERY item in the set — no partial fixes, no silent deferrals. Anything not done
> is named in `deferred:` with a reason. Verify by running the stated test and pasting the
> real output. Finish with the NEONCORE-DONE block: scope, verify, deferred.

---

## Applying it proportionally

The standard scales with the work; it is never waived.

| Ask | SCOPE | REPRODUCE | VERIFY |
|---|---|---|---|
| Typo / copy change | one line: what's affected | none if not code | screenshot or `tsc` |
| Bug fix | full enumeration + count | set-based failing test | test output pasted |
| Feature | enumeration of cases + acceptance test | failing test per case | full suite |
| Refactor | every call site, counted | existing tests must be green before AND after | before/after both pasted |

The one part that is never proportional: **the completion block**. Every task ends with it,
including the typo.

---

## What this asks of the human

The contract binds both directions. An ask that cannot be scoped cannot be executed to this
standard, so:

- Name the set if you already know it ("all 12 sections", "every endpoint under /api/reports").
- Say when you want a partial fix — an explicit "just the summary section for now" is a
  scope, and the agent will hold to it.
- Read the `deferred:` line. It is the agent telling you what it decided not to do, which is
  the information that used to be missing entirely.
