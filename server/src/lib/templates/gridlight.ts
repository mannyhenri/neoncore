/** Standard workflow templates: Gridlight QA and Gridlight Performance Improvement. Seeded on every boot by ./index.ts. */
import { randomUUID } from 'crypto';
import type { SeedKit } from './kit.js';
import {
  GRIDLIGHT_QA_TEMPLATES, GRIDLIGHT_PERF_TEMPLATE_NAME, GRIDLIGHT_PERF_TEMPLATE_DESCRIPTION, GRIDLIGHT_PERF_STEPS,
} from '../gridlight-qa-templates.js';

export function seedGridlight({ now, stableId, insertWorkflow, step }: SeedKit): void {
  // ── Gridlight QA — one selected script run, one purpose-built HTML report ───────────
  for (const template of GRIDLIGHT_QA_TEMPLATES) {
    const wfId = stableId(template.name);
    const runId = randomUUID(), reportId = randomUUID();
    insertWorkflow.run(wfId, template.name, template.description, now);
    step(wfId, runId, template.scriptStepName, template.scriptDescription,
      300, 50, 'claude-code', template.scriptConfig, []);
    step(wfId, reportId, 'Workflow Completion Report',
      'Render the selected script run as a customized self-contained HTML report and store it in the journal.',
      300, 225, 'claude-code', template.reportConfig, [runId]);
  }

  // ── Gridlight Performance Improvement — target → develop → 7B QA → approve-and-loop ──
  // The definition, and why its loop is the quality gate's retry, is in gridlight-qa-templates.ts.
  {
    const wfId = stableId(GRIDLIGHT_PERF_TEMPLATE_NAME);
    insertWorkflow.run(wfId, GRIDLIGHT_PERF_TEMPLATE_NAME, GRIDLIGHT_PERF_TEMPLATE_DESCRIPTION, now);
    const ids = new Map(GRIDLIGHT_PERF_STEPS.map((s) => [s.key, randomUUID()]));
    GRIDLIGHT_PERF_STEPS.forEach((s, i) => {
      step(wfId, ids.get(s.key)!, s.name, s.description, 300, 50 + i * 175, s.type, s.config,
        s.deps.map((d) => ids.get(d)!));
    });
  }
}
