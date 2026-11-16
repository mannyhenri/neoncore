/**
 * THE WORK STANDARD CHECK A LAUNCH ADDS — where it goes, and when it is not added.
 *
 * A workflow with no gate of its own is audited before it reports: the launch adds a quality gate
 * with the `standard` preset (docs/WORK-STANDARD.md). Moved out of routes/workflows.ts so the
 * scheduled-run clone (lib/workflow-from-template.ts) applies exactly the same rule — it used to
 * add no gate at all, so the same template was audited when you pressed Run and not when it ran
 * on a schedule.
 */
import { v4 as uuid } from 'uuid';
import { STEP_X, STEP_START_Y } from './workflow-layout.js';
import { isReportStep } from './workflow-report.js';

interface GateNode { id: string; type: string; deps: string[]; report: boolean }

/**
 * WHERE THE WORK STANDARD CHECK GOES: after the work, BEFORE the trailing connectors.
 *
 * It used to depend on every terminal step — and most templates end in a connector chain
 * (Capture Learnings → Save to Project → Notify). So the check ran after "Notify: Done" had already
 * told you the run was finished, and the only dependency output it was handed to audit was Notify's
 * one line ("Notification sent"). Now the trailing connectors — connectors nothing but other
 * trailing connectors (or the report) depend on — are moved after it: work → check → connectors →
 * report. A connector in the MIDDLE of the work (something a work step depends on) stays put.
 *
 * Returns null when there is no work step to audit (no gate is added).
 */
function placeStandardGate(nodes: GateNode[], gateId: string): {
  gateDeps: string[];
  /** New dependencies for the trailing connectors and the report(s); everything else is unchanged. */
  rewired: Map<string, string[]>;
} | null {
  const nonReport = nodes.filter((n) => !n.report);
  const dependents = new Map<string, string[]>();
  for (const n of nonReport) for (const d of n.deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id]);

  const trailing = new Set(nonReport.filter((n) => n.type === 'connector' && n.deps.length > 0).map((n) => n.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...trailing]) {
      if ((dependents.get(id) ?? []).some((d) => !trailing.has(d))) { trailing.delete(id); changed = true; }
    }
  }
  const core = nonReport.filter((n) => !trailing.has(n.id));
  if (!core.some((n) => ['claude-code', 'command', ''].includes(n.type))) return null;

  const coreIds = new Set(core.map((n) => n.id));
  const coreTerminal = core.filter((n) => !(dependents.get(n.id) ?? []).some((d) => coreIds.has(d))).map((n) => n.id);
  const gateDeps = coreTerminal.length > 0 ? coreTerminal : [core[core.length - 1].id];

  const rewired = new Map<string, string[]>();
  for (const n of nonReport.filter((x) => trailing.has(x.id))) {
    rewired.set(n.id, [...new Set(n.deps.map((d) => (coreIds.has(d) ? gateId : d)))]);
  }
  // The report waits for everything, the connectors included: the ends of the new graph.
  const after = new Set<string>();
  for (const deps of rewired.values()) for (const d of deps) after.add(d);
  const ends = [...trailing].filter((id) => !after.has(id));
  const reportDeps = ends.length > 0 ? ends : [gateId];
  for (const n of nodes.filter((x) => x.report)) rewired.set(n.id, reportDeps);
  return { gateDeps, rewired };
}

/**
 * Append the work-standard verify gate to a step list, unless one is already there.
 *
 * The gate depends on every TERMINAL step of the work, so it runs after all the work regardless of
 * how the graph branches — appending it to the last step in the array would silently skip parallel
 * branches — and before any trailing connectors (see placeStandardGate).
 *
 * Skipped when: the caller opted out, the workflow already has a gate (don't stack two critics),
 * or there is no work step to audit.
 */
export function withStandardGate(
  steps: Record<string, unknown>[],
  opts: { skip?: boolean } = {},
): Record<string, unknown>[] {
  if (opts.skip) return steps;

  const GATE_TYPES = new Set(['quality-gate', 'review-gate']);
  if (steps.some((s) => GATE_TYPES.has((s.executorType as string) || ''))) return steps;

  const WORK_TYPES = new Set(['claude-code', 'command', '']);
  const workSteps = steps.filter((s) => WORK_TYPES.has((s.executorType as string) || '')
    && !isReportStep(s.executorConfig as Record<string, unknown> | undefined));
  if (workSteps.length === 0) return steps;

  const gateId = `standard-gate-${uuid().slice(0, 8)}`;
  const placed = placeStandardGate(steps.map((s) => ({
    id: s.id as string,
    type: (s.executorType as string) || '',
    deps: (s.dependsOn as string[] | undefined) || [],
    report: isReportStep(s.executorConfig as Record<string, unknown> | undefined),
  })), gateId);
  if (!placed) return steps;

  // Inherit the executor from the last work step so the gate lands on a cartridge that
  // actually has the repo. A gate with no executor fails at dispatch.
  const executorId = (workSteps[workSteps.length - 1].executorId as string) || '';

  return [
    ...steps.map((s) => (placed.rewired.has(s.id as string) ? { ...s, dependsOn: placed.rewired.get(s.id as string) } : s)),
    {
      id: gateId,
      name: 'Work Standard Check',
      description: 'Verifies the work covered the complete set and is proven by a set-based test.',
      executorType: 'quality-gate',
      executorId,
      executorConfig: { gateType: 'standard', maxRetries: 1 },
      dependsOn: placed.gateDeps,
      autoAdvance: true,
      positionX: STEP_X,
      // Real coordinates rather than 0,0 — every gate used to stack at the top of the canvas.
      // The final layout is recomputed by layoutSteps once the graph is complete.
      positionY: STEP_START_Y,
    },
  ];
}

/**
 * Add the system-owned standard gate while cloning a persisted template into a run — every launch
 * path (the Run button and scheduled / decomposed runs alike). The report stays last; the gate goes
 * after the work and before the trailing connectors (placeStandardGate), so every launched run is
 * audited before it announces itself done and before it reports.
 *
 * `skip`: the template opted out (workflows.standard_gate = 'off').
 */
export function withStandardGateOnTemplateRows(
  rows: Record<string, unknown>[],
  opts: { skip?: boolean } = {},
): Record<string, unknown>[] {
  if (opts.skip) return rows;
  const gateTypes = new Set(['quality-gate', 'review-gate']);
  if (rows.some((row) => gateTypes.has(String(row.executor_type || '')))) return rows;

  const configOf = (row: Record<string, unknown>) => {
    try { return JSON.parse(String(row.executor_config || '{}')) as Record<string, unknown>; } catch { return {}; }
  };
  const depsOf = (row: Record<string, unknown>) => {
    try { return JSON.parse(String(row.depends_on || '[]')) as string[]; } catch { return []; }
  };
  const workRows = rows.filter((row) => !isReportStep(configOf(row))
    && ['claude-code', 'command', ''].includes(String(row.executor_type || '')));
  if (workRows.length === 0) return rows;

  const gateId = `standard-gate-${uuid().slice(0, 8)}`;
  const placed = placeStandardGate(rows.map((row) => ({
    id: String(row.id), type: String(row.executor_type || ''), deps: depsOf(row), report: isReportStep(configOf(row)),
  })), gateId);
  if (!placed) return rows;

  const lastWork = workRows[workRows.length - 1];
  const gate: Record<string, unknown> = {
    id: gateId,
    name: 'Work Standard Check',
    description: 'Verifies the work covered the complete set and is proven by a set-based test.',
    position_x: STEP_X,
    position_y: STEP_START_Y,
    executor_type: 'quality-gate',
    executor_id: lastWork.executor_id || '',
    executor_config: JSON.stringify({ gateType: 'standard', maxRetries: 1 }),
    auto_advance: 1,
    depends_on: JSON.stringify(placed.gateDeps),
  };
  const out = rows.map((row) => (placed.rewired.has(String(row.id))
    ? { ...row, depends_on: JSON.stringify(placed.rewired.get(String(row.id))) } : row));
  // Array order is the clone order (and the fallback layout order): the gate right after the work.
  const reports = out.filter((row) => isReportStep(configOf(row)));
  const rest = out.filter((row) => !reports.includes(row));
  const firstTrailing = rest.findIndex((row) => placed.rewired.has(String(row.id)));
  const at = firstTrailing >= 0 ? firstTrailing : rest.length;
  return [...rest.slice(0, at), gate, ...rest.slice(at), ...reports];
}

