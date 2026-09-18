/**
 * WHICH CARTRIDGES DOES THIS RUN DRIVE? The one answer.
 *
 * Three places asked this and gave three different answers, which is how a confer run could
 * pass the launch guard, be created, and then fail on its first action with
 *
 *     Cannot attach files: none of the selected cartridges has a repo path
 *
 * …while every selected cartridge had one. The attachment path resolved a run's repos with
 * `JOIN agents a ON a.id = s.executor_id`, and the confer conversion deliberately EMPTIES
 * executor_id — "it stops meaning anything for a confer step" — putting the roster in
 * `executorConfig.conferAgentIds`. The join matched nothing.
 *
 * lib/workflow-launch.ts's header had already named the hazard: "Deliberately mirrors
 * resolveWorkflowTargets … Two different answers would mean a launch that satisfies the busy
 * guard and fails the assignment guard, or worse, the reverse." Mirroring is not sharing; there
 * were three mirrors and they had drifted. This is the shared one.
 *
 * A cartridge is only ever reported if it EXISTS. A stale id drives nothing, and counting one
 * queues a run behind a ghost.
 */
import db from '../db.js';
import { cartridgeExists, awaitsLaunchFill } from './cartridge-exists.js';

/**
 * Every way a cartridge can be attached to a run. Declared so a test can assert it is complete
 * rather than a reader having to trust a comment — a source added here without a resolver is
 * exactly the bug this file exists to end.
 */
export const CARTRIDGE_SOURCES = [
  'step.executor_id',                        // a direct pin, or a launch fill already applied
  'body.agentId',                            // the run-level fill, before it is applied
  'body.agentOverrides',                     // per-step assignment from the launch modal
  'body.conferAllSteps',                     // run-level confer, at launch
  'executorConfig.conferAgentIds',           // a converted confer step — executor_id is EMPTY
  'executorConfig.panelAgentIds',            // deliberation panel
  'executorConfig.reviewAgentId',            // review gate's judge
] as const;

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch { return {}; }
}

function addIds(into: Set<string>, value: unknown): void {
  const list = Array.isArray(value) ? value : [value];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || awaitsLaunchFill(id)) continue;
    if (cartridgeExists(id)) into.add(id);
  }
}

/**
 * The cartridges this run drives, from every source.
 *
 * `body` is the launch request when one is in hand — at launch time the run-level cartridge and
 * the confer roster live there and have not been written to the steps yet. Afterwards the steps
 * carry everything, so calling this with no body is correct for an existing run.
 */
export function workflowCartridges(
  workflowId: string,
  body?: Record<string, unknown> | undefined,
): string[] {
  const out = new Set<string>();

  const steps = db.prepare(
    'SELECT executor_id, executor_config FROM workflow_steps WHERE workflow_id = ?',
  ).all(workflowId) as { executor_id: string; executor_config: string }[];

  let anyAwaitingFill = false;
  for (const s of steps) {
    if (awaitsLaunchFill((s.executor_id ?? '').trim())) anyAwaitingFill = true;
    addIds(out, s.executor_id);

    // The multi-agent step types keep their roster in config, not in executor_id.
    const cfg = parseConfig(s.executor_config);
    addIds(out, cfg.conferAgentIds);
    addIds(out, cfg.panelAgentIds);
    addIds(out, cfg.reviewAgentId);
  }

  if (!body) return [...out];

  // Only count the run-level fill when there is a step for it to fill. Adding it
  // unconditionally would queue a fully-pinned run behind a cartridge it never touches.
  const runAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (runAgentId && anyAwaitingFill) addIds(out, runAgentId);

  if (body.agentOverrides && typeof body.agentOverrides === 'object') {
    addIds(out, Object.values(body.agentOverrides as Record<string, unknown>));
  }
  // Run-level confer at launch: the roster is in the request and not yet on the steps.
  addIds(out, body.conferAllSteps);

  return [...out];
}

/**
 * The distinct repo paths this run touches, with the cartridge each belongs to.
 *
 * What the attachment path needs: a file has to be materialized into every checkout the run
 * will dispatch into. Blank paths are dropped — a cartridge with no repo path cannot receive
 * a file, and that is not an error on its own.
 */
export function workflowRepoTargets(
  workflowId: string,
  body?: Record<string, unknown> | undefined,
): { repoPath: string; machine: string; repoName: string }[] {
  const ids = workflowCartridges(workflowId, body);
  if (ids.length === 0) return [];
  const rows = db.prepare(
    `SELECT DISTINCT repo_path AS repoPath, machine, repo_name AS repoName
       FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as { repoPath: string; machine: string; repoName: string }[];
  return rows.filter((r) => (r.repoPath || '').trim() !== '');
}
