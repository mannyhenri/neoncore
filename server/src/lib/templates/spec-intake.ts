/** Standard workflow templates: Spec Intake → Dev Spec. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';

export function seedSpecIntake({ now, stableId, insertWorkflow, step, cc, gate }: SeedKit): void {
  // ── 0a. Spec Intake → Dev Spec ────────────────────────────────────────────
  //
  // Upload a PDF of requirements, get a spec you can hit "start development" on.
  //
  // THE STEP THAT MATTERS IS THE COMPREHENSION CHECK. A specification understood wrongly and
  // then built is worse than one never read: the work looks finished and satisfies nobody. So
  // the agent must state its understanding back BEFORE writing a line of spec, and a human
  // confirms it. That is the only reason this is a workflow rather than one long prompt.
  //
  // The document arrives through the launch modal's "Attach files" — attachments are copied
  // into every cartridge's repo and referenced in each step's prompt (lib/attachments.ts), so
  // nothing here needs to know about PDFs specifically.
  {
    const wfId = stableId('Spec Intake → Dev Spec');
    const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), s4 = randomUUID(),
          s5 = randomUUID(), s6 = randomUUID(), s7 = randomUUID(), s8 = randomUUID();
    insertWorkflow.run(wfId, 'Spec Intake → Dev Spec',
      'Attach a requirements document (PDF/MD/DOCX) at launch. Extracts every requirement, checks them against this codebase, confirms its understanding with you, writes docs/specs/[slug]/spec.md, then waits for you to start development.', now);

    step(wfId, s1, 'Read the Document', 'Extract EVERY requirement from the attached document as a numbered, testable list.', 300, 50, 'claude-code',
      { ...cc('researcher'), prompt: 'A requirements document was ATTACHED to this run. Its path in this repo is given in the attachments block above — read that file first (use the Read tool; it handles PDF, Markdown and text).\n\nYour job is extraction, not interpretation. Do NOT design anything yet.\n\n1. Read the document END TO END before writing anything.\n2. Extract EVERY requirement as a numbered list. A requirement is anything the document says the system MUST, SHOULD or WILL do — including ones stated in passing, in a diagram caption, or in an example.\n3. For each: `R[n] | <one-line statement> | <MUST|SHOULD|MAY> | <verbatim quote or page/section>`.\n4. Separately list: explicit NON-goals, stated constraints (deadline, stack, compliance), and open questions the document leaves unanswered.\n5. STATE THE COUNT: "N requirements extracted".\n\nIf the document is unreadable or the attachment is missing, say so plainly and STOP — do not invent requirements from the workflow description.\n\nOutput:\n```\n## Extracted Requirements (N)\n[the numbered table]\n\n## Non-Goals\n## Constraints\n## Unanswered in the document\n```' }, []);

    step(wfId, s2, 'Map to This Codebase', 'For every requirement: what already exists, what is missing, what conflicts.', 300, 225, 'claude-code',
      { ...cc('architect'), prompt: 'Take the numbered requirements above and map EVERY ONE of them onto this repository. Iterate the list — a requirement you skip is one that gets discovered during development instead.\n\nFor each R[n], search the code (Grep/Glob/Read) and classify it:\n- ALREADY BUILT — name the file and symbol. Say how you verified it.\n- PARTIAL — what exists, what is missing.\n- MISSING — nothing in the repo does this.\n- CONFLICTS — the codebase already does something incompatible. Name both sides.\n- UNCLEAR — the requirement cannot be mapped without a decision from the author.\n\nThen answer three questions the document cannot:\n1. Which requirements are cheap because the groundwork exists?\n2. Which are expensive because they cut across existing structure?\n3. Which would change an existing contract (schema, route, exported type) that other things depend on?\n\nState the totals: "N requirements — A built, B partial, C missing, D conflicts, E unclear".' }, [s1]);

    step(wfId, s3, 'State Your Understanding', 'Say back what you think is being asked — in plain language, before any spec is written.', 300, 400, 'claude-code',
      { ...cc('planner'), prompt: 'Before any specification is written, state your understanding back to the author so they can correct it. This step exists because a document understood wrongly and then BUILT is the expensive failure — the work looks finished and satisfies nobody.\n\nWrite for the person who wrote the document, not for an engineer:\n\n```\n## What I understand you are asking for\n[3-6 sentences, plain language, no file paths, no jargon. What is the outcome they want and who is it for?]\n\n## The N requirements, in my words\n[the numbered list, each restated in ONE plain sentence — not quoted back]\n\n## What I believe is ALREADY done\n[from the mapping — so they can tell you if you are wrong about the current state]\n\n## What I think this will actually involve\n[the 3-6 real pieces of work, in dependency order]\n\n## Where I had to interpret\n[every place the document was ambiguous and you picked a reading. Say which reading and why. THIS IS THE MOST IMPORTANT SECTION — it is where a misunderstanding hides.]\n\n## What I still need from you\n[the questions that block a correct spec, or "nothing"]\n```\n\nThen use the AskUserQuestion tool to ask: "Is this the right understanding of what you want?" with options: Yes — write the spec / Mostly — I will correct some points / No — you have misread this.\n\nDo NOT proceed past your own question. Wait for the answer.' }, [s2], false);

    step(wfId, s4, 'Write the Dev Spec', 'Turn the confirmed understanding into an implementable specification on disk.', 300, 575, 'claude-code',
      { ...cc('architect'), prompt: 'The author has confirmed (or corrected) your understanding above. Fold in every correction they made — their correction outranks your earlier reading.\n\nDerive a short kebab-case slug from the subject and WRITE `docs/specs/[slug]/spec.md`:\n\n```\n# Spec: [Name]\n\n## Objective\n[what this delivers and for whom — 3-5 sentences]\n\n## Requirements\n[the numbered list, each with: statement | MUST/SHOULD/MAY | acceptance criterion that can be checked | current state]\n\n## Out of Scope\n[explicit non-goals, including anything the author ruled out in the previous step]\n\n## Design\n[the approach. Name real files, real functions, real tables. A spec that could describe any codebase is not a spec for this one.]\n\n## Work Breakdown\n[ordered tasks, each independently completable and verifiable. For each: what changes, what proves it done.]\n\n## Test Plan\n[per requirement: the test that proves it. Set-based where the requirement covers a set.]\n\n## Risks and Open Questions\n[what could make this wrong, and what is still undecided]\n```\n\nEvery requirement from step 1 appears here or in Out of Scope. None may silently vanish — state the count at the end: "N requirements: X specified, Y explicitly out of scope".' }, [s3]);

    step(wfId, s5, 'Start development?', 'The spec is written. Build it now, revise it, or stop here.', 300, 750, 'decision',
      { question: 'The development spec is written to docs/specs/[slug]/spec.md. Start development?',
        eli10: 'Everything so far has been reading and planning — nothing in the codebase has changed. Saying "build it" hands the spec to the agent, which will write failing tests first and then implement against them.',
        stakes: 'This is the last cheap moment. Changing the spec now costs a paragraph; changing it after implementation costs the implementation. If anything in the spec reads wrong, send it back.',
        recommendation: 'build',
        options: [
          { id: 'build', label: 'Start development', description: 'Implement the spec: failing tests first, then code, then verify against the acceptance criteria.' },
          { id: 'revise', label: 'Revise the spec first', description: 'Something is wrong or missing. The agent reworks the spec and asks again.' },
          { id: 'stop', label: 'Stop here — spec only', description: 'Keep the spec document and build nothing. The spec stays on disk for later.' },
        ] }, [s4]);

    step(wfId, s6, 'Build It', 'Implement the spec, test-first, or revise it — per the decision above.', 300, 925, 'claude-code',
      { ...cc('backend'), prompt: 'The decision above says what to do.\n\nIF "stop": output "Spec complete, no development requested." and nothing else. Do not touch the codebase.\n\nIF "revise": rework `docs/specs/[slug]/spec.md` against the feedback in the decision, then STOP and report what changed. Do not implement.\n\nIF "build":\n1. Read `docs/specs/[slug]/spec.md` in full.\n2. WRITE THE TESTS FIRST, from the Test Plan, and watch them fail. A test written after the code tests the code, not the requirement.\n3. Work the Work Breakdown IN ORDER. Commit after each task with a message naming the requirement id.\n4. Do not exceed the spec. Anything you believe is needed but is not specified goes in your report as a recommendation, not into the code.\n5. If a requirement turns out to be impossible or contradictory, STOP on that one, record it, and continue with the rest.\n\nReport: which requirements are implemented, which are deferred and why, and every commit made.' }, [s5]);

    step(wfId, s7, 'Verify Against the Spec', 'Every requirement checked against its own acceptance criterion.', 300, 1100, 'quality-gate',
      { ...gate('standard'), includeDepOutput: true, criteria: 'Read docs/specs/[slug]/spec.md. For EVERY numbered requirement marked MUST, verify its acceptance criterion against the actual code and the actual test output — not against the implementation report. PASS only if every MUST is satisfied or explicitly deferred with a reason. Say which requirement failed and how you checked.', maxRetries: 1 }, [s6]);

    step(wfId, s8, 'Notify', 'Spec intake complete.', 300, 1275, 'connector',
      { connectorType: 'system-notify', title: 'Spec Intake — Done', message: 'The spec is written and the run has finished. Check NeonCore for the report.' }, [s7]);
  }
}
