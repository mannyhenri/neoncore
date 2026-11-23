/**
 * THE BUG TRIAGE ENGINE — one state machine per issue (docs/plans/bug-triage.md).
 *
 *   intake → triage → code_check → reproduce → fix → pull_request → follow_up
 *
 * Every outcome goes through applyOutcome, which reads TRANSITIONS (types.ts): the labels, the
 * reporter message, the next stage. The server never takes a cartridge's word for the facts that
 * matter: it runs the reproduction itself (fails twice before), the reproduction and the full suite
 * after the fix, and the diff guardrails — and only then opens a PR. It never merges.
 *
 * One run per issue: every step on an issue goes through withLock(issue), so a poll, a webhook,
 * a submission and the sweep can never work the same issue at once. State is all in SQLite, so a
 * restart resumes (resumeIssues).
 */
import crypto from 'crypto';
import db from '../../db.js';
import {
  AGENT_STAGES, SUBMISSION_FIELDS, TRANSITIONS, TriageError,
  type AgentStage, type Stage, type TriageIssue, type TriageSource,
} from './types.js';
import {
  addFindings, createIssue, findIssue, getIssue, getSettings, getSource, listIssues, listSources,
  logEvent, markPolled, nowIso, updateIssue,
} from './store.js';
import { JiraClient, type JiraIssue } from './jira.js';
import { addLabels, sendMoment, transition, type MessageData } from './messenger.js';
import {
  completeRequest, dispatchBlocked, dispatchRequest, getRequest, onTriageRequestFailed, openRequest,
  supersedeOpen, sweepTriageRequests, type TriageRequest,
} from './dispatch.js';
import { codeCheckPrompt, fixPrompt, reproducePrompt, triagePrompt } from './prompts.js';
import { sandbox } from './sandbox.js';
import { checkFix, isTestFile } from './guardrails.js';

// ── one run per issue ─────────────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();
/** Run `fn` after everything already running on this issue. */
export function withLock<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(issueId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  chains.set(issueId, tail);
  void tail.then(() => { if (chains.get(issueId) === tail) chains.delete(issueId); });
  return next;
}
/** Resolves when every queued step on every issue has finished (tests). */
export async function triageSettled(): Promise<void> {
  for (let i = 0; i < 50 && chains.size > 0; i++) await Promise.all([...chains.values()]);
}

/** Jira client per source — injectable for tests. */
type JiraFactory = (source: TriageSource) => Pick<JiraClient, 'search' | 'getIssue' | 'comments' | 'myself' | 'createIssue' | 'addRemoteLink'>;
let jiraFactory: JiraFactory = (s) => new JiraClient(s);
export function setEngineJira(f: JiraFactory | null): void { jiraFactory = f ?? ((s) => new JiraClient(s)); }

function sourceOf(issue: TriageIssue): TriageSource {
  const s = getSource(issue.sourceId);
  if (!s) throw new TriageError('the issue\'s source no longer exists', 404);
  return s;
}

// ── outcomes ──────────────────────────────────────────────────────────────────────────────

/**
 * Record a stage's outcome and act on it: labels, the reporter message, the next stage. The
 * outcome must be one TRANSITIONS lists for the issue's current stage.
 */
export async function applyOutcome(issueId: string, outcome: string, reason: string, message: MessageData = {}): Promise<TriageIssue> {
  let issue = getIssue(issueId)!;
  const t = TRANSITIONS[issue.stage]?.[outcome];
  if (!t) throw new TriageError(`"${outcome}" is not an outcome of the ${issue.stage} stage`);
  const source = sourceOf(issue);
  logEvent(issueId, 'decision', `${issue.stage}: ${outcome}${reason ? ` — ${reason}` : ''}`, { outcome, reason });
  issue = updateIssue(issueId, { outcome, state: t.state });
  await addLabels(source, issue, t.labels).catch((err) => logEvent(issueId, 'error', `could not label: ${String(err)}`));
  if (t.moment) await sendMoment(source, issue, t.moment, message).catch((err) => logEvent(issueId, 'error', `could not comment (${t.moment}): ${String(err)}`));
  if (outcome === 'needs_info') updateIssue(issueId, { questionsAt: nowIso() });
  if (outcome === 'merged') updateIssue(issueId, { fixedAt: nowIso() });
  if (outcome === 'released') updateIssue(issueId, { releasedAt: nowIso() });
  if (outcome === 'awaiting_review') await transition(source, getIssue(issueId)!, 'inReview').catch(() => undefined);
  if (outcome === 'released') await transition(source, getIssue(issueId)!, 'done').catch(() => undefined);
  if (t.next) {
    updateIssue(issueId, { stage: t.next });
    logEvent(issueId, 'stage', `→ ${t.next}`, {}, { stage: t.next });
    await startStage(issueId);
  }
  return getIssue(issueId)!;
}

/** Stop here and give the issue to a person, with everything learned so far. */
export async function handOver(issueId: string, reason: string): Promise<TriageIssue> {
  supersedeOpen(issueId);
  const issue = updateIssue(issueId, { state: 'handed_over', outcome: issue0(issueId).outcome || 'handed_over' });
  logEvent(issueId, 'decision', `handed over at ${issue.stage}: ${reason}`, { reason, findings: issue.findings });
  addFindings(issueId, 'handOver', reason);
  await addLabels(sourceOf(issue), issue, ['ai-handed-over']).catch(() => undefined);
  return getIssue(issueId)!;
}
const issue0 = (id: string) => getIssue(id)!;

// ── starting a stage ──────────────────────────────────────────────────────────────────────

/** Budget checks before anything is asked of a cartridge; a hand-over when spent. */
async function withinBudget(issue: TriageIssue, source: TriageSource): Promise<boolean> {
  if (issue.dispatches >= source.limits.dispatchesPerIssue) {
    logEvent(issue.id, 'budget', `dispatch budget spent (${issue.dispatches}/${source.limits.dispatchesPerIssue})`);
    await handOver(issue.id, `the issue used its ${source.limits.dispatchesPerIssue} cartridge requests`);
    return false;
  }
  if (issue.agentMinutes >= source.limits.minutesPerIssue) {
    logEvent(issue.id, 'budget', `time budget spent (${Math.round(issue.agentMinutes)}/${source.limits.minutesPerIssue} min)`);
    await handOver(issue.id, `the issue used its ${source.limits.minutesPerIssue} minutes`);
    return false;
  }
  return true;
}

export async function startStage(issueId: string, opts: { review?: string[] } = {}): Promise<void> {
  const issue = getIssue(issueId)!;
  const source = sourceOf(issue);
  if (!issue.startedAt) updateIssue(issueId, { startedAt: nowIso() });
  switch (issue.stage) {
    case 'intake': return;
    case 'triage': {
      if (!(await withinBudget(issue, source))) return;
      if (!source.triageAgentId) { await handOver(issueId, 'no triage cartridge is set for this source'); return; }
      const recent = listIssues({ sourceId: source.id }).filter((x) => x.id !== issueId).slice(0, 40)
        .map((x) => ({ key: x.issueKey, summary: x.summary, status: x.state }));
      const comments = String((issue.findings.reporterReplies as string | undefined) ?? '');
      const req = dispatchRequest({ issueId, stage: 'triage', agentId: source.triageAgentId, prompt: (id) => triagePrompt(id, issue, { recent, comments }) });
      logEvent(issueId, 'dispatch', `asked the triage cartridge (${req.queued ? 'queued' : 'sent'})`, { requestId: req.id, status: req.status });
      return;
    }
    case 'code_check': {
      if (!(await withinBudget(issue, source))) return;
      const ws = await ensureWorkspace(issue, source);
      if (!ws) return;
      const req = dispatchRequest({ issueId, stage: 'code_check', resolvePath: ws.worktreePath, resolveType: source.codeAgentType, prompt: (id) => codeCheckPrompt(id, getIssue(issueId)!, source) });
      logEvent(issueId, 'dispatch', `asked the issue's cartridge to check the code (${req.queued ? 'queued' : 'sent'})`, { requestId: req.id });
      return;
    }
    case 'reproduce': case 'fix': {
      if (!(await withinBudget(issue, source))) return;
      if (issue.stage === 'reproduce') await transition(source, issue, 'inProgress').catch(() => undefined);
      const stage = issue.stage;
      const prompt = (id: string) => (stage === 'reproduce' ? reproducePrompt(id, getIssue(issueId)!, source) : fixPrompt(id, getIssue(issueId)!, source, opts.review));
      const req = dispatchRequest({ issueId, stage, resolvePath: issue.worktreePath, resolveType: source.codeAgentType, prompt });
      logEvent(issueId, 'dispatch', `asked the issue's cartridge to ${stage === 'reproduce' ? 'reproduce the bug' : 'fix it'} (${req.queued ? 'queued' : 'sent'})`, { requestId: req.id });
      return;
    }
    case 'pull_request': return openPullRequest(issueId);
    case 'follow_up': return;
  }
}

/** The issue's worktree on bug/<KEY>, and its cartridge launched. Null (and handed over) when it cannot be made. */
async function ensureWorkspace(issue: TriageIssue, source: TriageSource): Promise<{ worktreePath: string } | null> {
  if (issue.worktreePath) return { worktreePath: issue.worktreePath };
  const repo = source.repoFor[issue.projectKey] ?? Object.values(source.repoFor)[0];
  if (!repo) { await handOver(issue.id, `no repository is mapped for project ${issue.projectKey}`); return null; }
  const branch = `bug/${issue.issueKey}`;
  try {
    const ws = sandbox().createWorkspace(repo, branch);
    updateIssue(issue.id, { repoPath: repo, worktreePath: ws.worktreePath, branch: ws.branch, baseBranch: ws.base });
    logEvent(issue.id, 'stage', `sandbox: worktree ${ws.worktreePath} on ${branch} from ${ws.base}`, ws);
  } catch (err) {
    await handOver(issue.id, `could not make the sandbox: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return null;
  }
  const fresh = getIssue(issue.id)!;
  if (!sandbox().agentFor(fresh.worktreePath, source.codeAgentType)) {
    const err = sandbox().launch(fresh.worktreePath, source.codeAgentType);
    if (err) { await handOver(issue.id, `could not start a cartridge in the sandbox: ${err}`); return null; }
    logEvent(issue.id, 'stage', `launched a ${source.codeAgentType} cartridge in the sandbox`);
  }
  return { worktreePath: fresh.worktreePath };
}

// ── submissions ───────────────────────────────────────────────────────────────────────────

/** Refuse fields another stage owns, and anything unknown: a ticket cannot widen what a stage may do. */
export function validateFields(stage: AgentStage, result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TriageError('result must be an object');
  const allowed = new Set(SUBMISSION_FIELDS[stage]);
  const extra = Object.keys(result).filter((k) => !allowed.has(k));
  if (extra.length) throw new TriageError(`a ${stage} submission may only contain ${[...allowed].join(', ')} — refused: ${extra.join(', ')}`);
  return result as Record<string, unknown>;
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The shape each stage's answer must have, before the engine acts on it. */
function validateStage(stage: AgentStage, r: Record<string, unknown>): void {
  switch (stage) {
    case 'triage':
      if (!['bug', 'question', 'feature'].includes(String(r.classification))) throw new TriageError('classification must be bug, question or feature');
      if (typeof r.complete !== 'boolean') throw new TriageError('complete must be true or false');
      if (r.questions !== undefined && (!Array.isArray(r.questions) || r.questions.some((q) => typeof q !== 'string'))) throw new TriageError('questions must be a list of strings');
      if (r.duplicateOf !== undefined && r.duplicateOf !== '' && !/^[A-Z][A-Z0-9_]*-\d+$/.test(String(r.duplicateOf))) throw new TriageError('duplicateOf must be an issue key like ABC-12');
      return;
    case 'code_check':
      if (!['plausible', 'works_as_designed', 'already_fixed'].includes(String(r.verdict))) throw new TriageError('verdict must be plausible, works_as_designed or already_fixed');
      if (r.files !== undefined && (!Array.isArray(r.files) || r.files.some((f) => typeof f !== 'string'))) throw new TriageError('files must be a list of paths');
      return;
    case 'reproduce':
      if (typeof r.reproduced !== 'boolean') throw new TriageError('reproduced must be true or false');
      if (r.reproduced && (!str(r.testFile) || !str(r.command))) throw new TriageError('a reproduction needs testFile and command');
      if (r.reproduced && (str(r.testFile).startsWith('/') || str(r.testFile).includes('..'))) throw new TriageError('testFile must be repo-relative');
      return;
    case 'fix':
      if (typeof r.fixed !== 'boolean') throw new TriageError('fixed must be true or false');
      if (r.fixed && (!str(r.cause) || !str(r.summary))) throw new TriageError('a fix needs cause and summary');
      return;
  }
}

/**
 * A cartridge's answer. Validated now (a bad answer is refused with the reason and the request
 * stays open for another try); acted on under the issue's lock, after the reply.
 */
export function submitTriageResult(requestId: string, result: unknown): { ok: true; message: string } {
  const req = getRequest(requestId);
  if (!req) throw new TriageError('request not found', 404);
  if (req.status !== 'pending') throw new TriageError(`this request is ${req.status}, not open`, 409);
  if (!(AGENT_STAGES as readonly string[]).includes(req.stage)) throw new TriageError('unknown request stage');
  const issue = getIssue(req.issueId);
  if (!issue) throw new TriageError('the issue no longer exists', 404);
  if (issue.stage !== req.stage) throw new TriageError(`the issue is at ${issue.stage}, not ${req.stage}`, 409);
  const r = validateFields(req.stage, result);
  validateStage(req.stage, r);
  completeRequest(requestId, r);
  const minutes = req.dispatchedAt ? Math.max(0, (Date.now() - Date.parse(req.dispatchedAt)) / 60_000) : 0;
  db.prepare('UPDATE triage_issues SET agent_minutes = agent_minutes + ? WHERE id = ?').run(minutes, issue.id);
  logEvent(issue.id, 'submission', `${req.stage} answer received`, r, { costMinutes: Math.round(minutes * 10) / 10 });
  void withLock(issue.id, () => actOn(issue.id, req, r)).catch((err) => {
    logEvent(issue.id, 'error', `acting on the ${req.stage} answer failed: ${err instanceof Error ? err.message : String(err)}`);
    void handOver(issue.id, `an internal error at ${req.stage}`).catch(() => undefined);
  });
  return { ok: true, message: req.stage === 'reproduce' || req.stage === 'fix' ? 'NeonCore is now checking it itself.' : 'Recorded.' };
}

async function actOn(issueId: string, req: TriageRequest, r: Record<string, unknown>): Promise<void> {
  const issue = getIssue(issueId)!;
  const source = sourceOf(issue);
  addFindings(issueId, req.stage, r);
  switch (req.stage) {
    case 'triage': {
      const reason = str(r.reason);
      if (r.classification !== 'bug') {
        await applyOutcome(issueId, 'not_a_bug', `${r.classification}: ${reason}`, { intended: r.classification === 'feature' ? 'this asks for something new rather than reporting something broken, so it goes to the team as a request' : 'this reads as a question rather than a fault', how: reason });
        return;
      }
      const dup = str(r.duplicateOf);
      if (dup && dup !== issue.issueKey) {
        const other = findIssue(source.id, dup);
        await applyOutcome(issueId, 'duplicate', reason, { duplicateOf: dup, duplicateStatus: other?.state ?? '' });
        return;
      }
      if (!r.complete) {
        const questions = (r.questions as string[] | undefined)?.map((q) => q.trim()).filter(Boolean).slice(0, 4) ?? [];
        await applyOutcome(issueId, 'needs_info', reason, { questions });
        return;
      }
      await applyOutcome(issueId, 'continue', reason);
      return;
    }
    case 'code_check': {
      const verdict = String(r.verdict);
      await applyOutcome(issueId, verdict, str(r.reason), { intended: str(r.intended) || str(r.reason) });
      return;
    }
    case 'reproduce': {
      if (!r.reproduced) { await applyOutcome(issueId, 'not_reproduced', 'the cartridge could not reproduce it', { tried: str(r.tried) }); return; }
      const testFile = str(r.testFile); const command = str(r.command);
      if (!isTestFile(testFile)) { await applyOutcome(issueId, 'not_reproduced', `${testFile} is not a test file`, { tried: str(r.tried) }); return; }
      // The SERVER's own run: it must fail twice in a row before anything is fixed.
      const runs = [];
      for (let i = 0; i < 2; i++) runs.push(await sandbox().runCommand(issue.worktreePath, command, 10 * 60_000));
      logEvent(issueId, 'check', `ran the reproduction twice: exit ${runs.map((x) => x.code).join(', ')}`, { command, outputs: runs.map((x) => x.output.slice(-1500)) });
      if (runs.some((x) => x.code === 0)) {
        await applyOutcome(issueId, 'not_reproduced', 'NeonCore ran the reproduction and it PASSED — the cartridge\'s claim was not confirmed', { tried: str(r.tried) || 'an automated test of the reported steps' });
        return;
      }
      updateIssue(issueId, { repro: { testFile, command } });
      await applyOutcome(issueId, 'reproduced', `${testFile} fails twice, as reported`);
      return;
    }
    case 'fix': {
      if (!r.fixed) { await applyOutcome(issueId, 'too_complex', str(r.handOver) || 'the cartridge handed it over'); return; }
      const verdict = await verifyFix(issue, source);
      if (!verdict.ok) {
        const attempts = Number((issue.findings.fixAttempts as number | undefined) ?? 0) + 1;
        addFindings(issueId, 'fixAttempts', attempts);
        addFindings(issueId, 'fixProblems', verdict.problems);
        // Guardrail breaches are never retried; a failing run gets one more try within budget.
        if (verdict.guardrail || attempts >= 2) { await applyOutcome(issueId, 'too_complex', verdict.problems.join('; ')); return; }
        logEvent(issueId, 'decision', `fix not confirmed (${verdict.problems.join('; ')}) — asking once more`);
        await startStage(issueId, { review: verdict.problems });
        return;
      }
      addFindings(issueId, 'cause', str(r.cause));
      addFindings(issueId, 'summary', str(r.summary));
      await applyOutcome(issueId, 'fix_ready', 'reproduction green, suite green, guardrails passed');
      return;
    }
  }
}

/** The server's own check of a fix: repro green, full suite green, diff inside the guardrails. */
export async function verifyFix(issue: TriageIssue, source: TriageSource): Promise<{ ok: boolean; guardrail: boolean; problems: string[] }> {
  const sb = sandbox();
  const diff = await sb.diff(issue.worktreePath, issue.baseBranch);
  const guard = checkFix(diff, { protectedPaths: source.protectedPaths, maxFiles: source.limits.maxFiles, maxLines: source.limits.maxLines, reproTestFile: issue.repro.testFile });
  logEvent(issue.id, 'check', guard.ok ? `diff within the guardrails (${guard.files.length} files)` : `diff refused: ${guard.problems.join('; ')}`, { problems: guard.problems, files: guard.files.map((f) => f.path) });
  if (!guard.ok) return { ok: false, guardrail: true, problems: guard.problems };
  const repro = await sb.runCommand(issue.worktreePath, issue.repro.command ?? '', 10 * 60_000);
  logEvent(issue.id, 'check', `reproduction after the fix: exit ${repro.code}`, { output: repro.output.slice(-1500) });
  if (repro.code !== 0) return { ok: false, guardrail: false, problems: ['NeonCore ran the reproduction test after the fix and it still FAILS'] };
  const suite = await sb.runCommand(issue.worktreePath, source.testCommand, 30 * 60_000);
  logEvent(issue.id, 'check', `full suite after the fix: exit ${suite.code}`, { output: suite.output.slice(-2000) });
  if (suite.code !== 0) return { ok: false, guardrail: false, problems: [`the full suite (${source.testCommand}) fails after the fix`] };
  return { ok: true, guardrail: false, problems: [] };
}

async function openPullRequest(issueId: string): Promise<void> {
  const issue = getIssue(issueId)!;
  const source = sourceOf(issue);
  const cause = String(issue.findings.cause ?? '');
  const summary = String(issue.findings.summary ?? '');
  const jiraUrl = issue.origin === 'jira' && source.jiraBaseUrl ? `${source.jiraBaseUrl}/browse/${issue.issueKey}` : '';
  const body = [
    `Fixes ${jiraUrl ? `[${issue.issueKey}](${jiraUrl})` : issue.issueKey}: ${issue.summary}`,
    '', '## Cause', cause, '', '## Change', summary,
    '', '## Test', `Reproduction: \`${issue.repro.testFile ?? ''}\` — failed twice before the fix, passes after (\`${issue.repro.command ?? ''}\`).`,
    `Full suite: \`${source.testCommand}\` passes.`,
    '', '_Opened by NeonCore Bug Triage for human review. It will not be merged automatically._',
  ].join('\n');
  try {
    const url = await sandbox().openPr(issue.worktreePath, { base: issue.baseBranch, branch: issue.branch, title: `${issue.issueKey}: ${issue.summary}`.slice(0, 200), body });
    updateIssue(issueId, { prUrl: url });
    logEvent(issueId, 'pr', `opened ${url}`, { url });
    if (issue.origin === 'jira') await jiraFactory(source).addRemoteLink(issue.issueKey, url, `Fix: ${url}`).catch((err) => logEvent(issueId, 'error', `could not link the PR in Jira: ${String(err)}`));
    await applyOutcome(issueId, 'awaiting_review', 'pull request opened', { cause, prUrl: url });
  } catch (err) {
    await handOver(issueId, `could not open the pull request: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// ── intake ────────────────────────────────────────────────────────────────────────────────

/** A Jira issue NeonCore has not seen → a new state machine, and its first comment. */
export async function intake(source: TriageSource, j: JiraIssue, origin: 'jira' | 'qa' = 'jira'): Promise<TriageIssue | null> {
  if (findIssue(source.id, j.key)) return null;
  if (origin === 'jira' && source.issueTypes.length && !source.issueTypes.some((t) => t.toLowerCase() === j.issueType.toLowerCase())) return null;
  if (origin === 'jira' && source.projects.length && !source.projects.includes(j.projectKey)) return null;
  const issue = createIssue({
    sourceId: source.id, origin, issueKey: j.key, projectKey: j.projectKey, summary: j.summary,
    description: [j.description, j.environment ? `Environment: ${j.environment}` : '', j.attachments.length ? `Attachments: ${j.attachments.map((a) => a.filename).join(', ')}` : ''].filter(Boolean).join('\n\n'),
    reporterId: j.reporter.accountId, reporterName: j.reporter.displayName, jiraCreatedAt: j.created || null,
  });
  logEvent(issue.id, 'stage', `intake: ${j.key} from ${origin === 'jira' ? source.name : 'the QA section'}`, { key: j.key, reporter: j.reporter.displayName }, { stage: 'intake' });
  await withLock(issue.id, () => applyOutcome(issue.id, 'queued', 'new bug'));
  return getIssue(issue.id);
}

/** The reporter answered our questions → triage again with what they said. */
async function resumeFromReporter(source: TriageSource, issue: TriageIssue): Promise<void> {
  if (issue.state !== 'waiting_reporter' || issue.origin !== 'jira') return;
  const comments = await jiraFactory(source).comments(issue.issueKey);
  const since = Date.parse(issue.questionsAt ?? issue.createdAt);
  const replies = comments.filter((c) => c.author.accountId === issue.reporterId && Date.parse(c.created) > since && c.author.accountId !== source.serviceAccountId);
  if (replies.length === 0) return;
  await withLock(issue.id, async () => {
    const fresh = getIssue(issue.id)!;
    if (fresh.state !== 'waiting_reporter') return;
    const text = replies.map((c) => `${c.author.displayName}: ${c.body}`).join('\n');
    addFindings(issue.id, 'reporterReplies', [String(fresh.findings.reporterReplies ?? ''), text].filter(Boolean).join('\n'));
    logEvent(issue.id, 'stage', 'the reporter answered — triaging again', { replies: replies.length });
    updateIssue(issue.id, { state: 'working', stage: 'triage' });
    await startStage(issue.id);
  });
}

/** One poll of a source: new bugs → intake; replies to our questions → resume. */
export async function pollSource(sourceId: string): Promise<{ seen: number; new: number }> {
  const source = getSource(sourceId);
  if (!source) throw new TriageError('source not found', 404);
  if (!source.jiraBaseUrl) throw new TriageError('this source has no Jira site');
  if (getSettings().paused) return { seen: 0, new: 0 };
  const jira = jiraFactory(source);
  const startedAt = nowIso();
  let serviceAccountId = source.serviceAccountId;
  if (!serviceAccountId) serviceAccountId = (await jira.myself().catch(() => ({ accountId: '' }))).accountId;
  const minutes = source.lastPolledAt ? Math.min(7 * 24 * 60, Math.ceil((Date.now() - Date.parse(source.lastPolledAt)) / 60_000) + 2) : 7 * 24 * 60;
  const projects = source.projects.map((p) => `"${p}"`).join(', ');
  const types = source.issueTypes.map((t) => `"${t}"`).join(', ');
  const jql = [projects ? `project in (${projects})` : '', types ? `issuetype in (${types})` : '', `updated >= "-${minutes}m"`].filter(Boolean).join(' AND ') + ' ORDER BY created ASC';
  const found = await jira.search(jql);
  let created = 0;
  for (const j of found) {
    const known = findIssue(source.id, j.key);
    if (!known) { if (await intake(getSource(sourceId)!, j)) created++; continue; }
    await resumeFromReporter(source, known).catch((err) => logEvent(known.id, 'error', `could not read replies: ${String(err)}`));
  }
  markPolled(sourceId, startedAt, serviceAccountId || undefined);
  return { seen: found.length, new: created };
}

/** Jira webhook signature: `X-Hub-Signature: sha256=<hex HMAC of the raw body>` with the source's secret. */
export function verifyWebhook(source: TriageSource, rawBody: Buffer, header: string | undefined): boolean {
  const secret = source.webhookSecretEnv ? process.env[source.webhookSecretEnv] ?? '' : '';
  if (!secret || !header) return false;
  const want = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(want); const b = Buffer.from(header.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A verified webhook event: an issue created, or a comment added. */
export async function handleWebhook(sourceId: string, event: Record<string, any>): Promise<{ handled: string }> {
  const source = getSource(sourceId);
  if (!source) throw new TriageError('source not found', 404);
  if (getSettings().paused) return { handled: 'paused' };
  const key = String(event.issue?.key ?? '');
  if (!key) return { handled: 'ignored' };
  const jira = jiraFactory(source);
  const known = findIssue(source.id, key);
  if (event.webhookEvent === 'jira:issue_created' && !known) {
    const made = await intake(source, await jira.getIssue(key));
    return { handled: made ? 'intake' : 'ignored' };
  }
  if (event.webhookEvent === 'comment_created' && known) { await resumeFromReporter(source, known); return { handled: 'comment' }; }
  return { handled: 'ignored' };
}

// ── follow-up ─────────────────────────────────────────────────────────────────────────────

export const FOLLOW_UP_EVERY_MS = 2 * 60_000;

/** Watch one PR: approved → send a held message; changes requested → back to fix; merged → fixed; in a tag → released. */
export async function followUp(issueId: string): Promise<void> {
  const issue = getIssue(issueId)!;
  if (issue.stage !== 'follow_up' || !issue.prUrl || !['waiting_review', 'fixed'].includes(issue.state)) return;
  const source = sourceOf(issue);
  updateIssue(issueId, { lastCheckedAt: nowIso() });
  const pr = await sandbox().prState(issue.worktreePath || issue.repoPath, issue.prUrl);
  if (issue.heldMessage && (pr.reviewDecision === 'APPROVED' || pr.state === 'MERGED')) {
    let d: MessageData = {}; try { d = JSON.parse(issue.heldMessage) as MessageData; } catch { /* keep empty */ }
    await sendMoment(source, getIssue(issueId)!, 'solution_found', d, { forceRelease: true });
  }
  if (pr.state === 'CLOSED') { await handOver(issueId, 'the pull request was closed without merging'); return; }
  if (pr.state === 'OPEN' && pr.reviewDecision === 'CHANGES_REQUESTED' && issue.state === 'waiting_review') {
    if (issue.reviewRounds >= source.limits.reviewRounds) { await handOver(issueId, `changes requested after ${issue.reviewRounds} review round(s) — over the limit`); return; }
    updateIssue(issueId, { reviewRounds: issue.reviewRounds + 1 });
    logEvent(issueId, 'pr', 'changes requested on the PR', { comments: pr.reviewComments });
    // Back to fix with the review: applyOutcome moves the stage; the fix request carries the comments.
    const t = TRANSITIONS.follow_up.changes_requested;
    updateIssue(issueId, { outcome: 'changes_requested', state: t.state, stage: 'fix' });
    logEvent(issueId, 'stage', '→ fix (review round)', {}, { stage: 'fix' });
    await startStage(issueId, { review: pr.reviewComments });
    return;
  }
  if (pr.state === 'MERGED' && issue.state === 'waiting_review') {
    updateIssue(issueId, { prMergeCommit: pr.mergeCommit });
    await applyOutcome(issueId, 'merged', 'the pull request was merged by a person');
  }
  const now = getIssue(issueId)!;
  if (now.state === 'fixed' && (await sandbox().isReleased(now.repoPath || now.worktreePath, now.prMergeCommit))) {
    await applyOutcome(issueId, 'released', 'the merge is in a release tag');
  }
}

// ── people ────────────────────────────────────────────────────────────────────────────────

export async function retryIssue(issueId: string): Promise<TriageIssue> {
  const issue = getIssue(issueId);
  if (!issue) throw new TriageError('issue not found', 404);
  if (!['handed_over', 'error', 'queued'].includes(issue.state)) throw new TriageError(`a ${issue.state} issue cannot be retried`, 409);
  return withLock(issueId, async () => {
    supersedeOpen(issueId);
    updateIssue(issueId, { state: 'working', outcome: '', dispatches: 0, agentMinutes: 0 });
    logEvent(issueId, 'human', `retried at ${issue.stage}`);
    await startStage(issueId);
    return getIssue(issueId)!;
  });
}
export async function manualHandOver(issueId: string, reason: string): Promise<TriageIssue> {
  if (!getIssue(issueId)) throw new TriageError('issue not found', 404);
  return withLock(issueId, async () => { logEvent(issueId, 'human', 'a person took it over'); return handOver(issueId, reason || 'taken over by a person'); });
}
/** A person says a labelled issue IS a bug (a false "not a bug"): it goes on to the code check. */
export async function reopenIssue(issueId: string): Promise<TriageIssue> {
  const issue = getIssue(issueId);
  if (!issue) throw new TriageError('issue not found', 404);
  if (issue.state !== 'labelled') throw new TriageError('only a labelled issue (duplicate / not a bug / works as designed) can be reopened', 409);
  return withLock(issueId, async () => {
    updateIssue(issueId, { reopened: true, state: 'working', stage: 'code_check', outcome: '' });
    logEvent(issueId, 'human', 'reopened by a person — continuing to the code check');
    await startStage(issueId);
    return getIssue(issueId)!;
  });
}
/** The operator says the fix is live (no release tags in this repo). */
export async function markReleased(issueId: string): Promise<TriageIssue> {
  const issue = getIssue(issueId);
  if (!issue) throw new TriageError('issue not found', 404);
  if (issue.state !== 'fixed') throw new TriageError('only a merged fix can be marked released', 409);
  return withLock(issueId, async () => { logEvent(issueId, 'human', 'marked released by a person'); return applyOutcome(issueId, 'released', 'marked released by a person'); });
}

// ── QA link ───────────────────────────────────────────────────────────────────────────────

/** An Explorer finding from the QA section → a Jira bug (when the source may create issues) or straight into the pipeline. */
export async function fromQaFinding(findingId: string, sourceId: string): Promise<TriageIssue> {
  const source = getSource(sourceId);
  if (!source) throw new TriageError('source not found', 404);
  let f: Record<string, unknown> | undefined;
  try { f = db.prepare('SELECT * FROM qa_findings WHERE id = ?').get(findingId) as Record<string, unknown> | undefined; }
  catch { throw new TriageError('the QA section is not installed', 404); }
  if (!f) throw new TriageError('finding not found', 404);
  let steps: string[] = []; try { steps = JSON.parse(String(f.steps ?? '[]')) as string[]; } catch { /* none */ }
  const summary = String(f.title ?? 'QA finding');
  const description = [String(f.detail ?? ''), f.page ? `Page: ${f.page}` : '', steps.length ? `Steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '', `Found by the QA Explorer (severity ${f.severity ?? 'unknown'}).`].filter(Boolean).join('\n\n');
  const project = source.projects[0] ?? '';
  if (source.createIssues && source.jiraBaseUrl && project) {
    const jira = jiraFactory(source);
    const { key } = await jira.createIssue(project, summary, description);
    const made = await intake(source, await jira.getIssue(key));
    if (!made) throw new TriageError('the new Jira issue was not taken in (issue type or project filter)');
    return made;
  }
  const key = `QA-${String(findingId).replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase()}`;
  const made = await intake(source, {
    key, projectKey: project, summary, description, issueType: 'Bug', status: '', reporter: { accountId: '', displayName: 'QA Explorer' },
    labels: [], created: nowIso(), updated: nowIso(), environment: '', attachments: [], links: [],
  }, 'qa');
  if (!made) throw new TriageError('this finding is already in the pipeline', 409);
  return made;
}

// ── the sweep ─────────────────────────────────────────────────────────────────────────────

onTriageRequestFailed((req) => {
  void withLock(req.issueId, async () => {
    const issue = getIssue(req.issueId);
    if (!issue || issue.stage !== req.stage) return;
    logEvent(req.issueId, 'error', `the ${req.stage} request failed: ${req.error}`);
    await handOver(req.issueId, `the ${req.stage} request failed: ${req.error}`);
  });
});

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

/** One pass: poll due sources, move requests on, watch PRs. Skipped entirely while paused. */
export async function sweepTriage(now = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const budgetOf = (req: TriageRequest) => {
      const issue = getIssue(req.issueId); const source = issue ? getSource(issue.sourceId) : null;
      return Math.max(5, (source?.limits.minutesPerIssue ?? 90) - (issue?.agentMinutes ?? 0));
    };
    sweepTriageRequests(now, budgetOf);
    if (getSettings().paused) return;
    for (const s of listSources()) {
      if (!s.enabled || !s.jiraBaseUrl) continue;
      if (s.lastPolledAt && now - Date.parse(s.lastPolledAt) < s.pollSeconds * 1000) continue;
      await pollSource(s.id).catch((err) => console.warn(`[triage] poll of ${s.name} failed: ${err instanceof Error ? err.message : err}`));
    }
    for (const i of listIssues()) {
      if (i.stage !== 'follow_up' || !['waiting_review', 'fixed'].includes(i.state)) continue;
      if (i.lastCheckedAt && now - Date.parse(i.lastCheckedAt) < FOLLOW_UP_EVERY_MS) continue;
      await withLock(i.id, () => followUp(i.id)).catch((err) => logEvent(i.id, 'error', `follow-up failed: ${String(err)}`));
    }
  } finally { sweeping = false; }
}

/** After a restart: an issue mid-stage with no open request and nothing running gets its stage started again. */
export async function resumeIssues(): Promise<void> {
  for (const i of listIssues({ state: 'working' })) {
    if (openRequest(i.id)) continue;
    if (!(AGENT_STAGES as readonly string[]).includes(i.stage) && i.stage !== 'pull_request') continue;
    if (i.stage === 'pull_request' && i.prUrl) continue;
    await withLock(i.id, async () => { logEvent(i.id, 'stage', `resumed ${i.stage} after a restart`); await startStage(i.id); })
      .catch((err) => logEvent(i.id, 'error', `resume failed: ${String(err)}`));
  }
}

export function startTriageEngine(intervalMs = 15_000): void {
  if (timer) return;
  timer = setInterval(() => { void sweepTriage().catch((err) => console.error('[triage] sweep failed:', err)); }, intervalMs);
  timer.unref?.();
  void resumeIssues().catch((err) => console.error('[triage] resume failed:', err));
}

/** For a paused system: nothing is dispatched (dispatch.ts), nothing is polled (sweepTriage). */
export const isBlocked = dispatchBlocked;
export type { Stage };
