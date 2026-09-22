/**
 * THE TEMPLATE LIBRARY, AS IT ACTUALLY IS.
 *
 * Demo mode previously shipped runs but no templates, so the workflow library — the thing a
 * demo most needs to show — came up empty. Asked for as "copy all the workflow templates from
 * our live DB so we can get an idea of what is there".
 *
 * These are the REAL names, descriptions and step sequences, snapshotted from the library.
 * They are product content, not anybody's data: no repo paths, no tickets, no transcripts. The
 * ids are demo ids, so nothing here can address a real template.
 *
 * GENERATED, not hand-written. Regenerate after changing the template seed:
 *   node scripts/gen-demo-templates.mjs
 * Hand-editing it would make it drift from the library it exists to portray, which is the one
 * thing that would make it worse than having no templates at all.
 */

export interface DemoTemplate {
  id: string;
  name: string;
  description: string;
  stepNames: string[];
}

export const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    id: "demo-tpl-1",
    name: "Bug Hunter",
    description: "Proactive bug hunt: static analysis → dead code → bug pattern scan → prioritize & plan → implement fixes → verify → notify.",
    stepNames: ["Static & Lint Analysis","Dead Code Scan","Bug Pattern Hunt","Prioritize & Plan Fixes","Implement Fixes","Verify","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-2",
    name: "Bug Investigation",
    description: "Set the workflow description to the bug being investigated. Reproduce → root cause → impact assessment → fix plan (human gate) → implement → verify → capture learnings.",
    stepNames: ["Reproduce the Bug","Root Cause Analysis","Impact Assessment","Fix Plan","Implement Fix","Verify Fix","Capture Learnings","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-3",
    name: "CE Develop and Optimize",
    description: "Works a task list one item at a time: build a correct runnable slice with TDD, optimize it against a fixed metric when needed, preserve correctness for every experiment, append durable evidence, and stop for discussion on bugs or unmet goals.",
    stepNames: ["Load Work and Goals","Develop and Optimize Every Task","Verify Coverage and Evidence","Goal Achievement Gate","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-4",
    name: "CE: Full Delivery",
    description: "All 7 phases chained end-to-end. Interrogate → Plan → Implement → Review → QA → Ship → Compound. Enter feature slug + description in launch context.",
    stepNames: ["[P1] Load Prior Work","[P1] Office Hours","[P1] Pick Approach","[P1] CE Brainstorm","[P1] Write Brainstorm Doc","[P1] ✓ Interrogate Done","[P2] Load Brainstorm","[P2] /plan-ceo-review","[P2] /plan-eng-review","[P2] CE Plan Research","[P2] Write Plan Doc","[P2] ✓ Plan Done","[P3] Load Plan + Worktree","[P3] Write Failing Tests","[P3] CE Implement","[P3] Run Tests","[P3] Build Summary","[P3] ✓ Implement Done","[P4] Load Diff + Build","[P4] Security Sentinel","[P4] CSO / STRIDE","[P4] Performance Oracle","[P4] Architecture Review","[P4] Code Quality Review","[P4] Codex","[P4] Triage P1/P2/P3","[P4] Review Decision","[P4] Resolve Findings","[P4] Open PR","[P4] ✓ Review Done","[P5] QA Browser Run","[P5] CE Three Questions","[P5] Investigate","[P5] QA Report","[P5] ✓ QA Done","[P6] Document Release","[P6] Merge Gate","[P6] Land & Deploy","[P6] Canary Watch","[P6] Canary Decision","[P6] Recovery Action","[P6] ✓ Shipped","[P7] CE Compound","[P7] Update CLAUDE.md","[P7] Retro","[P7] Learn & Final Review","[P7] ✓ Sprint Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-5",
    name: "CE: Phase 1 — Interrogate",
    description: "Challenge the idea before any planning begins. Enter the feature slug + description in launch context. Outputs docs/[slug]/brainstorm.md.",
    stepNames: ["Load Prior Work","Office Hours — Interrogate","Pick Approach","CE Brainstorm","Write Brainstorm Doc","Phase 1 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-6",
    name: "CE: Phase 2 — Plan",
    description: "Pressure-test the plan from 3 angles before any code is written. Load brainstorm → CEO + Eng + CE Plan run in parallel → merge to docs/[slug]/plan.md.",
    stepNames: ["Load Brainstorm","/plan-ceo-review","/plan-eng-review","CE Plan Research","Write Plan Doc","Phase 2 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-7",
    name: "CE: Phase 3 — Implement",
    description: "Isolated implementation in a git worktree. Load plan → write failing tests (TDD) → implement → run tests → build summary. Auto-continues to Phase 4.",
    stepNames: ["Load Plan + Worktree","Write Failing Tests","CE Implement","Run Tests","Build Summary","Phase 3 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-8",
    name: "CE: Phase 4 — Review",
    description: "6 specialist agents run in parallel (security, perf, architecture, quality, codex) → triage P1/P2/P3 → decision checkpoint → resolve P2s → open PR.",
    stepNames: ["Load Diff + Build Summary","Security Sentinel","CSO / STRIDE Review","Performance Oracle","Architecture Review","Code Quality Review","Codex — Cross-Model Review","Triage — P1 / P2 / P3","Review Decision","Resolve P1s + P2s","Open PR","Phase 4 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-9",
    name: "CE: Phase 5 — QA",
    description: "Real-browser QA on staging. Walk every user flow, fix bugs with atomic commits, write regression tests. Enter [slug] and [staging URL] in launch context.",
    stepNames: ["QA Browser Run","CE Three Questions","Investigate Uncertainties","QA Report","Phase 5 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-10",
    name: "CE: Phase 6 — Ship",
    description: "Document release → human merge approval → land & deploy → 10-min canary → decision checkpoint (all clear / rollback / hotfix).",
    stepNames: ["Document Release","Merge Gate","Land & Deploy","Canary Watch","Canary Decision","Recovery Action","Phase 6 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-11",
    name: "CE: Phase 7 — Compound",
    description: "Make the next feature cheaper. CE compound → update CLAUDE.md → retro → learn. The most important phase — do not skip.",
    stepNames: ["CE Compound","Update CLAUDE.md","Retro","Learn & Final Review","Sprint Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-12",
    name: "Code Review & Audit",
    description: "Set the workflow description to the branch, PR, or files to review. Deep code reading → logic review → security audit → test coverage → review report (human gate) → capture learnings.",
    stepNames: ["Code Reading","Logic Review","Security Audit","Test Coverage Check","Review Report","Capture Learnings","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-13",
    name: "Confer",
    description: "Two or more cartridges work one task together — they agree an approach, split it between themselves, and build in rounds. Pick the cartridges under \"Run on\" at launch and put the task in the description.",
    stepNames: ["Confer & Build","Verify Together","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-14",
    name: "Daily AI Research Digest",
    description: "Searches the web for the last 24-48h of AI news, models, tooling and research plus the loudest Reddit threads, filters it against what you actually work on, and renders a self-contained newspaper-style HTML digest from a fixed template so it looks the same every morning. The digest is the deliverable — there is no separate completion report. Schedule it with a daily heartbeat.",
    stepNames: ["Scan the Web","Filter for Relevance","Render the Digest","Archive Note"],
  },
  {
    id: "demo-tpl-15",
    name: "Deep Research",
    description: "Set the workflow description to the research subject — it is automatically injected into the first step. Web + local research → synthesis → your review → epic planning → save epic → optional Jira creation → notify.",
    stepNames: ["Deep Research","Idea Synthesis","Your Review","Epic Planning","Save Epic","Create in Jira?","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-16",
    name: "Engineering Architecture Review",
    description: "Set the workflow description to the system or feature under review. Architecture mapping → bottleneck analysis → alternative approaches → recommendation → implementation roadmap → human review → capture learnings.",
    stepNames: ["Architecture Mapping","Bottleneck & Risk Analysis","Alternative Approaches","Architecture Recommendation","Implementation Roadmap","Capture Learnings","Save to Project","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-17",
    name: "Epic: Confer Across Repos",
    description: "One epic, cartridges from different repos working it TOGETHER. They converge on one plan, split the work between themselves, and build in rounds — the confer relationship as a workflow step. Pick the participants at launch.",
    stepNames: ["Read the Epic","Confer & Build","Verify Across Repos","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-18",
    name: "Epic: Task by Task",
    description: "Loads an epic and works every task to the end: understand → failing tests → implement → verify → commit → next. One commit per task. Runs unattended — it never asks between tasks.",
    stepNames: ["Load Epic","Work Every Task","Verify Coverage","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-19",
    name: "Epic: Two Repos",
    description: "One epic, two repos, working at the same time. Scope and partition once → each cartridge works only its own repo's tasks, committing as it goes → a join step that fails if either side is short. Assign a cartridge per side at launch (\"assign per step\").",
    stepNames: ["Scope & Partition","Work Repo A","Work Repo B","Verify Both Repos","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-20",
    name: "Feature Validation",
    description: "TDD-based feature validation: specify → define/review tests (human gate) → evaluate code → implement gaps → run tests → final report. Enter the feature description (and optional Jira epic key) in the launch prompt.",
    stepNames: ["Feature Specification","Test Discovery & Creation","Code Evaluation","Code Implementation","Run Tests","Final Report","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-21",
    name: "Full QA Review",
    description: "Set the workflow description to the feature or URL being tested. Golden path → edge cases → error handling → performance → security → accessibility → QA report → notify.",
    stepNames: ["Golden Path Testing","Edge Case Testing","Error Handling Review","Performance Assessment","Security Scan","Accessibility Review","QA Report","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-22",
    name: "Jira Tasks Validation",
    description: "Enter the Jira epic name or key in the launch prompt — each task in the epic is checked against the codebase and transitioned to In QA if requirements are met.",
    stepNames: ["Fetch & Save Tasks","Validate & Save Results","Summary Report","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-23",
    name: "Product Strategy Session",
    description: "Set the workflow description to the product/feature being reviewed. Premise challenge → alternatives → dream state → dual-voice analysis (CEO vs PM) → 10-dimension strategy review → action plan → capture learnings.",
    stepNames: ["Context & Premise","Alternatives Analysis","Dream State","Dual Voice Analysis","Strategy Review","Action Plan","Capture Learnings","Save to Project","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-24",
    name: "QA Testing Guide",
    description: "Produces a REUSABLE testing guide for this product — every flow, its steps, its expected result and how it fails — not a report of one QA run. Writes docs/qa/testing-guide.md. Re-run it to refresh the guide as the product changes.",
    stepNames: ["Map What Can Be Tested","Write the Steps for Each Flow","Edge Cases and Data Setup","Write the Guide","Check It Is Followable","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-25",
    name: "Release Documentation",
    description: "Produces the documents you SHIP with a release, not the ones you keep: release notes, upgrade/migration steps, install & configuration, and a support runbook. Put the version or tag range in the description. Writes docs/release/[version]/.",
    stepNames: ["Establish What Shipped","Release Notes","Upgrade & Migration","Install & Configure","Support Runbook","Assemble the Release Bundle","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-26",
    name: "Spec Intake → Dev Spec",
    description: "Attach a requirements document (PDF/MD/DOCX) at launch. Extracts every requirement, checks them against this codebase, confirms its understanding with you, writes docs/specs/[slug]/spec.md, then waits for you to start development.",
    stepNames: ["Read the Document","Map to This Codebase","State Your Understanding","Write the Dev Spec","Start development?","Build It","Verify Against the Spec","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-27",
    name: "UX Audit & Simplify — Dashboard",
    description: "Audits the web dashboard’s features and how they’re implemented, evaluates them against UX best practices, proposes prioritized simplifications, then — after you approve the scope — implements and verifies the changes.",
    stepNames: ["Inventory dashboard UI","Evaluate UX vs best practices","Propose simplifications","Design critique","Approve scope","Implement approved fixes","Verify & summarize","Workflow Completion Report"],
  },
];
