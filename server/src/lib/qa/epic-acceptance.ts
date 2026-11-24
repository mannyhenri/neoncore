/**
 * THE EPIC ACCEPTANCE RUN — QA for an epic in ANY project, with or without a web UI
 * (docs/plans/epic-qa-any-project.md). When the last feature of an epic is done, one run checks
 * the epic AS IT STANDS, in the repo:
 *
 *   for each feature (newest pilot → its locked acceptance contract):
 *     locked files unchanged? ── no ──► a failed `tamper` check
 *     every locked test / command criterion, run again  ► `test` / `command` checks
 *     checklist criteria: the feature's confirmed review verdict, carried forward ► `checklist`
 *   then the epic's QA command (the phase gate), once, in the project's repo ► `qa-command`
 *
 *   all green ► passed · any red ► failed · could not run ► error · nothing to run ► no-tests
 *
 * It never presses Passed QA — that stays the person's. A failed run blocks it (epic-qa-store.ts
 * epicQaBlock). Commands run through lib/repo-access.ts (this machine, or the repo's runner).
 * A run waits while a cartridge is working in one of its repos: an edit mid-run would make a red
 * that is not the epic's.
 */
import db from '../../db.js';
import { pilotsForGoal, type GoalPilot } from '../goal-pilot.js';
import { getContract, checklistCriteria, type AcceptanceContract } from '../acceptance-contract.js';
import { runLockedChecks } from '../acceptance-runner.js';
import { repoAccessFor, checkTimeoutMs } from '../repo-access.js';
import { normalizeRepoPath } from '../resolve-agent.js';
import { epicQaOf } from '../project-spec.js';
import { QaError } from './types.js';
import {
  type EpicCheck, type EpicQaRun,
  currentEpicRun, epicFinishedAt, epicQaEnabledAt, finishEpicRun, insertEpicRun, qaCommandFor, saveEpicChecks,
} from './epic-qa-store.js';

const inFlight = new Map<string, Promise<void>>();

/** Resolves when every run in flight has finished (tests). */
export async function epicQaSettled(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight.values()]);
}

interface Member { id: string; name: string; contract: AcceptanceContract | null; repo: string }

/**
 * Where a feature's work lives now. A feature built on its own branch keeps its WORKTREE path in its
 * contract, and that worktree is removed once the feature ships (Beam Phase 0: "beam-feature-go-
 * project-skeleton does not exist on this machine"). The epic is QA'd in the repo the worktree was
 * cut from — pilot.workspace.repos[] — and a feature built in place is already there.
 */
function homeRepoOf(contractRepo: string, workspace: GoalPilot['workspace']): string {
  const at = normalizeRepoPath(contractRepo);
  const hit = workspace?.repos?.find((r) => r.worktreePath && normalizeRepoPath(r.worktreePath) === at);
  return hit?.repoPath || contractRepo;
}

function membersOf(epicId: string): Member[] {
  return (db.prepare('SELECT id, name FROM goals WHERE epic_id = ? ORDER BY position, rowid').all(epicId) as { id: string; name: string }[])
    .map((g) => {
      const pilot = pilotsForGoal(g.id)[0];
      const contract = pilot ? getContract(pilot.id) : null;
      return { ...g, contract, repo: contract ? homeRepoOf(contract.repoPath, pilot!.workspace) : '' };
    });
}

const runsTests = (c: AcceptanceContract | null): c is AcceptanceContract => !!c && c.status === 'locked' && c.tests.length > 0;

/** A cartridge with a step running in one of these repos — null when they are all quiet. */
export function busyRepo(repoPaths: string[]): string | null {
  const wanted = new Set(repoPaths.filter(Boolean).map(normalizeRepoPath));
  if (wanted.size === 0) return null;
  const rows = db.prepare(
    `SELECT a.repo_path FROM workflow_steps s JOIN workflows w ON w.id = s.workflow_id
       JOIN agents a ON a.id = COALESCE(NULLIF(s.dispatch_agent_id, ''), s.executor_id)
      WHERE w.status IN ('running', 'paused') AND s.status = 'running'`,
  ).all() as { repo_path: string }[];
  const hit = rows.find((r) => r.repo_path && wanted.has(normalizeRepoPath(r.repo_path)));
  return hit ? hit.repo_path : null;
}

function epicOrThrow(epicId: string): { id: string; name: string; project_id: string; primary_repo: string } {
  const e = db.prepare('SELECT e.id, e.name, e.project_id, p.primary_repo FROM epics e JOIN projects p ON p.id = e.project_id WHERE e.id = ?')
    .get(epicId) as { id: string; name: string; project_id: string; primary_repo: string } | undefined;
  if (!e) throw new QaError('epic not found', 404);
  return e;
}

/**
 * Start the epic's QA run now ("Run QA", or the sweep). Refuses (409) while the epic is not finished,
 * while a run of it is in flight, and while a cartridge is working in one of its repos.
 */
export function startEpicQa(epicId: string): EpicQaRun {
  const epic = epicOrThrow(epicId);
  const finishedAt = epicFinishedAt(epicId);
  if (!finishedAt) {
    const qa = epicQaOf(epicId);
    throw new QaError(qa === 'none' ? `"${epic.name}" has no feature to QA.` : `"${epic.name}" is not finished — QA runs once every feature of it is done.`, 409);
  }
  if (inFlight.has(epicId) || currentEpicRun(epicId)?.status === 'running') throw new QaError('QA is already running for this epic.', 409);
  const members = membersOf(epicId);
  const command = qaCommandFor(epicId);
  const repos = [...members.filter((m) => runsTests(m.contract)).map((m) => m.repo), ...(command ? [epic.primary_repo] : [])];
  const busy = busyRepo(repos);
  if (busy) throw new QaError(`A cartridge is working in ${busy} — QA runs when it is free.`, 409);
  const run = insertEpicRun(epicId, epic.project_id, finishedAt);
  const job = execute(run.id, members, command, epic.primary_repo).finally(() => inFlight.delete(epicId));
  inFlight.set(epicId, job);
  return run;
}

async function execute(runId: string, members: Member[], command: string, projectRepo: string): Promise<void> {
  const checks: EpicCheck[] = [];
  const save = () => saveEpicChecks(runId, checks);
  try {
    for (const m of members) {
      const c = m.contract;
      if (!c) continue;
      const byId = new Map(c.criteria.map((cr) => [cr.id, cr]));
      if (runsTests(c)) {
        const res = await runLockedChecks(c, repoAccessFor(m.repo));
        if (res.kind === 'tampered') {
          for (const f of res.tampered) {
            checks.push({
              kind: 'tamper', goalId: m.id, feature: m.name, criterionId: f.criterionId, text: `Locked test ${f.path} ${f.actual ? 'was changed' : 'was deleted'} since it was approved — its tests were not run.`,
              command: '', passed: false, exitCode: null, timedOut: false, output: '', durationMs: 0,
            });
          }
        } else {
          for (const r of res.results) {
            const cr = byId.get(r.criterionId);
            checks.push({
              kind: cr?.verify === 'command' ? 'command' : 'test', goalId: m.id, feature: m.name, criterionId: r.criterionId, text: cr?.text ?? '',
              command: r.command, passed: r.passed, exitCode: r.exitCode, timedOut: r.timedOut, output: r.output, durationMs: r.durationMs,
            });
          }
        }
        save();
      }
      // Checklist criteria are judged by a person at the end of each feature: carried forward as given.
      for (const cr of checklistCriteria(c)) {
        const conf = c.checklist?.confirmations[cr.id];
        const verdict = c.checklist?.verdicts.find((v) => v.criterionId === cr.id);
        const passed = conf ? conf.accepted : verdict?.verdict === 'met';
        const output = conf
          ? `Confirmed at feature review: ${conf.accepted ? 'met' : 'not met'}${conf.note ? ` — ${conf.note}` : ''}.`
          : verdict ? `Reviewer said ${verdict.verdict} (not confirmed): ${verdict.evidence}` : 'Never reviewed at the end of the feature.';
        checks.push({ kind: 'checklist', goalId: m.id, feature: m.name, criterionId: cr.id, text: cr.text, command: '', passed, exitCode: null, timedOut: false, output, durationMs: 0 });
      }
    }
    if (command) {
      const r = await repoAccessFor(projectRepo).run(command, checkTimeoutMs());
      checks.push({
        kind: 'qa-command', goalId: '', feature: '', criterionId: '', text: "The epic's QA command", command,
        passed: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut, output: r.output, durationMs: r.durationMs,
      });
    }
    const failed = checks.filter((c) => !c.passed).length;
    const status = checks.length === 0 ? 'no-tests' : failed ? 'failed' : 'passed';
    const summary = status === 'no-tests'
      ? 'Nothing to run: no locked acceptance tests, no QA command, no checklist.'
      : `${checks.length - failed} of ${checks.length} checks passed.`;
    finishEpicRun(runId, { status, checks, summary });
  } catch (err) {
    finishEpicRun(runId, { status: 'error', checks, summary: '', error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * THE SWEEP. Starts one run for every epic that is waiting for QA and has not run since it last
 * finished. Epics that finished before epic QA existed are left for "Run QA". A busy repo is
 * skipped and tried on the next pass. Returns the epics it started.
 */
export function sweepEpicQa(): string[] {
  const enabledAt = epicQaEnabledAt();
  const started: string[] = [];
  for (const { id } of db.prepare('SELECT id FROM epics').all() as { id: string }[]) {
    if (epicQaOf(id) !== 'waiting' || inFlight.has(id)) continue;
    const at = epicFinishedAt(id);
    if (!at || at < enabledAt || currentEpicRun(id)) continue;
    try { startEpicQa(id); started.push(id); } catch { /* busy or raced: the next pass */ }
  }
  return started;
}
