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
    description: "Set the workflow description to the bug being investigated. Reproduce & root cause → impact assessment → fix plan (human gate) → implement → verify → capture learnings.",
    stepNames: ["Reproduce & Root Cause","Impact Assessment","Fix Plan","Implement Fix","Verify Fix","Capture Learnings","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-3",
    name: "CE Develop and Optimize",
    description: "Works a task list one item at a time: build a correct runnable slice with TDD, optimize it against a fixed metric when needed, preserve correctness for every experiment, append durable evidence, and stop for discussion on bugs or unmet goals.",
    stepNames: ["Load Work and Goals","Develop and Optimize Every Task","Verify Coverage and Evidence","Goal Achievement Gate","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-5",
    name: "CE: Phase 2 — Plan",
    description: "Pressure-test the plan from 3 angles before any code is written. Load brainstorm → CEO review → Eng review → CE Plan research → merge to docs/[slug]/plan.md.",
    stepNames: ["Load Brainstorm","/plan-ceo-review","/plan-eng-review","CE Plan Research","Write Plan Doc","Phase 2 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-6",
    name: "CE: Phase 3 — Implement",
    description: "Isolated implementation in a git worktree. Load plan → write failing tests (TDD) → implement → run tests → build summary. When the build summary passes, CE: Phase 4 — Review starts automatically on the same project and cartridge.",
    stepNames: ["Load Plan + Worktree","Write Failing Tests","CE Implement","Run Tests","Build Summary","Phase 3 Complete","Continue to Phase 4","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-7",
    name: "CE: Phase 4 — Review",
    description: "Specialist reviews (security, perf, architecture, quality, codex) → triage P1/P2/P3 → decision checkpoint → resolve P2s → open PR.",
    stepNames: ["Load Diff + Build Summary","Security Review","Performance Oracle","Architecture Review","Code Quality Review","Codex — Cross-Model Review","Triage — P1 / P2 / P3","Review Decision","Resolve P1s + P2s","Open PR","Phase 4 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-8",
    name: "CE: Phase 5 — QA",
    description: "Real-browser QA on staging. Walk every user flow, fix bugs with atomic commits, write regression tests. Enter [slug] and [staging URL] in launch context.",
    stepNames: ["QA Browser Run","CE Three Questions","Investigate Uncertainties","QA Report","Phase 5 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-9",
    name: "CE: Phase 6 — Ship",
    description: "Document release → human merge approval → land & deploy → 10-min canary → decision checkpoint (all clear / rollback / hotfix).",
    stepNames: ["Document Release","Merge Gate","Land & Deploy","Canary Watch","Canary Decision","Recovery Action","Phase 6 Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-10",
    name: "CE: Phase 7 — Compound",
    description: "Make the next feature cheaper. CE compound → update CLAUDE.md → retro → learn. The most important phase — do not skip.",
    stepNames: ["CE Compound","Update CLAUDE.md","Retro","Learn & Final Review","Sprint Complete","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-11",
    name: "Confer",
    description: "Two or more cartridges work together — they agree an approach, split it between themselves, and build in rounds. Put the task in the context, or add a Jira epic: the epic is looked up first and the run keeps going until every task in it is done. Pick the cartridges under \"Run on\" at launch.",
    stepNames: ["Scope the Work","Confer & Build","Verify Coverage","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-12",
    name: "Deep Research",
    description: "Set the workflow description to the research subject — it is automatically injected into the first step. Web + local research → synthesis → your review → epic planning → save epic → optional Jira creation → notify.",
    stepNames: ["Deep Research","Idea Synthesis","Your Review","Epic Planning","Save Epic","Create in Jira?","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-13",
    name: "Engineering Architecture Review",
    description: "Set the workflow description to the system or feature under review. Architecture mapping → bottleneck analysis → alternative approaches → recommendation → implementation roadmap → human review → capture learnings.",
    stepNames: ["Architecture Mapping","Bottleneck & Risk Analysis","Alternative Approaches","Architecture Recommendation","Implementation Roadmap","Capture Learnings","Save to Project","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-14",
    name: "Epic: Task by Task",
    description: "Loads an epic and works every task to the end: understand → failing tests → implement → verify → commit → next. One commit per task. Runs unattended — it never asks between tasks.",
    stepNames: ["Load Epic","Work Every Task","Verify Coverage","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-15",
    name: "Epic: Two Repos",
    description: "One epic, two repos, working at the same time. Scope and partition once → each cartridge works only its own repo's tasks, committing as it goes → a join step that fails if either side is short. Assign a cartridge per side at launch (\"assign per step\").",
    stepNames: ["Scope & Partition","Work Repo A","Work Repo B","Verify Both Repos","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-16",
    name: "Feature Validation",
    description: "TDD-based feature validation: specify → define/review tests (human gate) → evaluate code → implement gaps → run tests. Enter the feature description (and optional Jira epic key) in the launch prompt.",
    stepNames: ["Feature Specification","Test Discovery & Creation","Code Evaluation","Code Implementation","Run Tests","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-17",
    name: "Jira Tasks Validation",
    description: "Enter the Jira epic name or key in the launch prompt — each task in the epic is checked against the codebase and transitioned to In QA if requirements are met.",
    stepNames: ["Fetch & Save Tasks","Validate & Save Results","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-18",
    name: "Product Strategy Session",
    description: "Set the workflow description to the product/feature being reviewed. Premise challenge → alternatives → dual-voice analysis (CEO vs PM) → 10-dimension scorecard → action plan with a 3-year picture → capture learnings.",
    stepNames: ["Context & Premise","Alternatives Analysis","Dual Voice Analysis","Strategy Review","Action Plan","Capture Learnings","Save to Project","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-19",
    name: "QA Testing Guide",
    description: "Produces a REUSABLE testing guide for this product — every flow, its steps, its expected result and how it fails — not a report of one QA run. Writes docs/qa/testing-guide.md. Re-run it to refresh the guide as the product changes.",
    stepNames: ["Map What Can Be Tested","Write the Steps for Each Flow","Edge Cases and Data Setup","Write the Guide","Check It Is Followable","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-20",
    name: "Release Documentation",
    description: "Produces the documents you SHIP with a release, not the ones you keep: release notes, upgrade/migration steps, install & configuration, and a support runbook. Put the version or tag range in the description. Writes docs/release/[version]/.",
    stepNames: ["Establish What Shipped","Release Notes","Upgrade & Migration","Install & Configure","Support Runbook","Assemble the Release Bundle","Notify","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-21",
    name: "Resolve PR Conflicts",
    description: "Run on a feature branch whose PR conflicts with its base: bring the base in → resolve keeping both sides → re-test → push and comment on the PR. Never force-pushes, never merges.",
    stepNames: ["Bring the base in","Resolve the conflicts","Re-test","Push and report","Workflow Completion Report"],
  },
  {
    id: "demo-tpl-22",
    name: "Super QA",
    description: "Put what to QA in the context: a branch, PR or files (reviewed as a change) or a feature, URL or the whole app (tested as a product). Read the code → functional testing (golden paths, edge cases) → logic & error handling → security → performance & accessibility → test coverage → QA report with one verdict (human gate) → capture learnings.",
    stepNames: ["Scope & Read the Code","Functional Testing","Logic & Error Handling","Security Review","Performance & Accessibility","Test Coverage","QA Report","Capture Learnings","Notify","Workflow Completion Report"],
  },
];
