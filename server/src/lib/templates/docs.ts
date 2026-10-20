/** Standard workflow templates: QA Testing Guide and Release Documentation. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedDocs({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── 0d. QA Testing Guide ──────────────────────────────────────────────────
  //
  // The gap: Full QA Review and CE Phase 5 both produce a REPORT OF ONE RUN — findings, a health
  // score, bugs found. Neither produces a GUIDE: the reusable document that tells the next
  // person (or the next agent) how to test this thing. Searched all templates for user guides,
  // test plans, runbooks — zero. So every QA run rediscovers the flows from scratch.
  {
    const wfId = stableId('QA Testing Guide');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(),
          s5 = randomUUID(), s6 = randomUUID();
    insertWorkflow.run(wfId, 'QA Testing Guide',
      'Produces a REUSABLE testing guide for this product — every flow, its steps, its expected result and how it fails — not a report of one QA run. Writes docs/qa/testing-guide.md. Re-run it to refresh the guide as the product changes.', now);

    step(wfId, s1, 'Map What Can Be Tested', 'Enumerate every user-facing flow from the code, not from memory.', 300, 50, 'claude-code',
      { ...cc('tester'), prompt: 'Enumerate EVERY testable user-facing flow in this product, derived from the CODE — routes, screens, commands, jobs — not from what you remember about it.\n\n1. Find the entry points: HTTP routes, UI screens/views, CLI commands, scheduled jobs, webhooks.\n2. For each, identify the user-visible flow it belongs to. A flow is something a person does end to end ("launch a workflow", "approve a permission"), not a function call.\n3. Group flows by area, and mark each CRITICAL / IMPORTANT / MINOR — critical means the product is broken without it.\n4. Note which flows have automated coverage already (find the tests) and which have none.\n\nSTATE THE COUNT: "N flows across M areas — X critical, Y already covered by automated tests."\n\nThis enumeration is the spine of the guide. A flow missed here is a flow nobody tests.' }, []);

    step(wfId, s2, 'Write the Steps for Each Flow', 'Concrete, followable steps — no "verify it works".', 300, 225, 'claude-code',
      { ...cc('tester'), prompt: 'For EVERY flow enumerated above — iterate the list, skip none — write the actual test procedure.\n\nEach flow gets:\n- **Preconditions** — what must be true first (logged in? data seeded? a cartridge running?). Name them concretely.\n- **Steps** — numbered, each a single action a person can perform without interpretation. "Click Run Workflow" not "start the workflow".\n- **Expected result** — what you should SEE. A specific string, state or screen, not "it works".\n- **How it fails** — the realistic failure modes and what each looks like. This is the part that turns a script into a guide: it tells the tester what they are looking at when it goes wrong.\n\nWrite it so someone who has never used this product can follow it. Where a step needs a value (a URL, an id, a file), say where to get that value.\n\nIf a flow cannot be tested manually, say so and say why — that is a finding, not an omission.' }, [s1]);

    step(wfId, s3, 'Edge Cases and Data Setup', 'The cases that break in production, and how to create them.', 300, 400, 'claude-code',
      { ...cc('tester'), prompt: 'A guide that only covers the happy path is a demo script. For each CRITICAL flow above, add the cases that actually break:\n\n- **Empty / first-run state** — nothing created yet. The most common broken screen in any product.\n- **Boundary** — one item, many items, maximum length, zero, negative.\n- **Failure injection** — the network is down, the dependency is offline, the file is missing, permission denied. Say HOW to create each condition in this product specifically.\n- **Concurrency** — two of something at once, where that is possible here.\n- **Interrupted** — the user closes the tab / the process dies mid-operation.\n\nThen write a **Test Data** section: exactly how to get the system into each state needed above — commands, fixtures, SQL, UI steps. A guide whose setup is "have some data" is a guide nobody can follow.' }, [s2]);

    step(wfId, s4, 'Write the Guide', 'One document, on disk, for a human or an agent to follow.', 300, 575, 'claude-code',
      { ...cc('planner'), prompt: 'Assemble everything above into ONE document and WRITE it to `docs/qa/testing-guide.md`. Read the existing file first if it is there and PRESERVE any hand-written notes, marking what you changed.\n\n```\n# QA Testing Guide — [Product]\n\nLast generated: [date] · [N] flows · [X] critical\n\n## How to use this guide\n[how to run a pass: full sweep vs critical-only, roughly how long each takes]\n\n## Environment and Test Data\n[how to get a working environment, and how to create each state the flows need]\n\n## Critical Flows\n### [Flow name]\n**Preconditions** · **Steps** (numbered) · **Expected** · **How it fails**\n\n## Important Flows\n## Minor Flows\n\n## Edge Cases by Flow\n\n## Known Gaps\n[flows with no automated coverage, and anything that cannot be tested manually and why]\n\n## Regression Checklist\n[the short list — the N things to check before any release. Critical flows only.]\n```\n\nEvery flow from step 1 appears, or is listed under Known Gaps with a reason. State the count at the end.' }, [s3]);

    step(wfId, s5, 'Check It Is Followable', 'A guide nobody can follow is a document, not a guide.', 300, 750, 'quality-gate',
      { ...gate('standard'), includeDepOutput: true, criteria: 'Read docs/qa/testing-guide.md as if you had never seen this product. PASS only if: every critical flow has numbered steps with a CONCRETE expected result (not "verify it works"); every precondition says how to reach it; the Test Data section is specific enough to act on; and the flow count in the document matches the count enumerated in step 1. Name the first flow that fails any of these and quote it.', maxRetries: 1 }, [s4]);

    step(wfId, s6, 'Notify', 'The testing guide is written.', 300, 925, 'connector',
      { connectorType: 'system-notify', title: 'QA Testing Guide — Ready', message: 'docs/qa/testing-guide.md has been written or refreshed.' }, [s5]);
  }

  // ── 0e. Release Documentation ─────────────────────────────────────────────
  //
  // The other gap: `Document Release` (CE Phase 6) updates INTERNAL docs — README, ARCHITECTURE,
  // CLAUDE.md — against the diff. Nothing produced anything you would SHIP: release notes, an
  // upgrade path, install steps, a support runbook. Searched every template for user guides,
  // release notes, runbooks, install docs — zero hits.
  {
    const wfId = stableId('Release Documentation');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(),
          s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID();
    insertWorkflow.run(wfId, 'Release Documentation',
      'Produces the documents you SHIP with a release, not the ones you keep: release notes, upgrade/migration steps, install & configuration, and a support runbook. Put the version or tag range in the description. Writes docs/release/[version]/.', now);

    step(wfId, s1, 'Establish What Shipped', 'The real change set, from git — not from memory.', 300, 50, 'claude-code',
      { ...cc('researcher'), prompt: 'Establish exactly what is in this release. The version or tag range is in the workflow description; if it is not, use the commits since the last tag (`git describe --tags --abbrev=0`) and SAY which range you used.\n\n1. `git log --oneline <range>` — every commit.\n2. Sort each commit into: USER-VISIBLE change, BUG FIX, BREAKING change, INTERNAL only, or DEPENDENCY.\n3. For each user-visible one: what can a user now do, or do differently, that they could not before? Answer from the diff, not from the commit message — commit messages describe intent and code describes behaviour.\n4. Flag every BREAKING change explicitly: a changed API shape, a renamed config key, a dropped option, a schema migration, a new required environment variable.\n\nSTATE THE COUNTS: "N commits — A user-visible, B fixes, C breaking, D internal."\n\nIf the range is empty or you cannot determine it, say so and STOP rather than inventing a release.' }, []);

    step(wfId, s2, 'Release Notes', 'What changed, written for the person using it.', 300, 225, 'claude-code',
      { ...cc('planner'), prompt: 'Write the release notes, for USERS. Not a changelog of commits — a description of what is different for someone using this product.\n\nRules that separate release notes from a git log:\n- Lead with what they can now DO. "Workflows now run on a schedule" beats "add heartbeat scheduler".\n- No commit hashes, no file paths, no internal module names in the body.\n- Every BREAKING change goes at the TOP, before the features, with what the reader must do about it.\n- Internal-only commits do not appear at all.\n- If the release is small, it is short. Padding a release note is how people learn not to read them.\n\n```\n# [Product] [version]\n[one sentence: the headline of this release]\n\n## Breaking changes\n[what broke | what you must do | why]  — or "None."\n\n## New\n## Improved\n## Fixed\n## Known issues\n```' }, [s1]);

    step(wfId, s3, 'Upgrade & Migration', 'How an existing install gets from the last version to this one.', 300, 400, 'claude-code',
      { ...cc('backend'), prompt: 'Write the upgrade path for someone ALREADY RUNNING the previous version. This is the document whose absence causes support tickets.\n\nWork from the breaking changes and schema/config changes found in step 1:\n1. **Before you upgrade** — what to back up, what to check, anything that must be drained or stopped.\n2. **Steps** — numbered, in order, each independently verifiable. Include the actual commands.\n3. **Schema migrations** — do they run automatically or by hand? Are they reversible? What happens to existing rows?\n4. **Configuration changes** — every new, renamed, or removed setting, with defaults and whether it is required.\n5. **Verify the upgrade worked** — the specific checks, with expected output.\n6. **Rollback** — how to go back, and what is lost if you do. If rollback is impossible, SAY SO PROMINENTLY.\n\nIf nothing is required, write "No migration needed — upgrade in place" and say why you are confident.' }, [s1]);

    step(wfId, s4, 'Install & Configure', 'A clean install, from nothing to running.', 300, 575, 'claude-code',
      { ...cc('backend'), prompt: 'Write the install and configuration guide for someone starting from NOTHING. Derive it from the repo — package manifests, Dockerfiles, env handling, setup scripts — and not from what you assume a developer already has.\n\n1. **Requirements** — runtimes and versions, OS support, external services. Read the manifests; state real versions.\n2. **Install** — the actual commands, in order, for each supported platform.\n3. **Configuration** — EVERY environment variable and config key: name, what it does, default, required or optional. Find these in the code, not in an existing doc that may be stale.\n4. **First run** — how to start it and how to tell it is working.\n5. **Common install problems** — what goes wrong and the fix.\n\nWhere a secret or credential is needed, say what it is for and where to obtain it. NEVER include a real credential, token or key in this document — if you find one hardcoded in the repo, report that as a finding instead.' }, [s1]);

    step(wfId, s5, 'Support Runbook', 'What the person on the other end of the problem needs.', 300, 750, 'claude-code',
      { ...cc('reviewer'), prompt: 'Write the support runbook — for whoever handles it when this release misbehaves in the field.\n\n1. **Health checks** — how to tell, quickly, whether the system is working. Exact commands or endpoints with expected output.\n2. **Where the logs are** — paths, formats, how to raise verbosity.\n3. **Symptom → cause → fix**, one row per realistic failure. Derive these from the error paths in the code and from the risks in this release specifically, not generic advice.\n4. **Diagnostics to collect** before escalating — the exact set, so a report arrives complete.\n5. **Known limitations** of this release that will be reported as bugs but are not.\n\nBe concrete. "Check the logs" helps nobody; "`tail -f server/neoncore-server.log` and look for `[heartbeat] SKIPPED`" does.' }, [s1]);

    step(wfId, s6, 'Assemble the Release Bundle', 'Write the documents to disk, together.', 300, 925, 'claude-code',
      { ...cc('planner'), prompt: 'Write every document above to `docs/release/[version]/`, one file each:\n\n  RELEASE-NOTES.md · UPGRADE.md · INSTALL.md · SUPPORT-RUNBOOK.md · README.md (an index of the four, with a one-line description of each)\n\nDerive [version] from the range established in step 1. Create the directory.\n\nThen cross-check the set before you finish:\n- Every BREAKING change from step 1 appears in BOTH the release notes and the upgrade guide.\n- Every new config key appears in the install guide.\n- No document contradicts another about a version number, a default, or a command.\n- No credential, token or key appears anywhere in the bundle.\n\nReport: the files written, the counts from step 1, and any contradiction you had to resolve.' }, [s2, s3, s4, s5]);

    step(wfId, s7, 'Notify', 'The release bundle is written.', 300, 1100, 'connector',
      { connectorType: 'system-notify', title: 'Release Documentation — Ready', message: 'The shippable release bundle has been written to docs/release/.' }, [s6]);
  }
}
