/**
 * TALKING TO THE REPORTER — one Jira comment per stage change, mentioning the reporter so Jira
 * notifies them. Short, no jargon, never a release date (docs/plans/bug-triage.md, "Reporter
 * messages"). For `external` reporters "solution found" is HELD until a person approves the PR.
 */
import type { Moment, TriageIssue, TriageSource } from './types.js';
import { JiraClient, adfDoc, adfLink, adfMention, adfText, type AdfNode } from './jira.js';
import { getIssue, logEvent, nowIso, updateIssue } from './store.js';

export interface MessageData {
  questions?: string[]; duplicateOf?: string; duplicateStatus?: string; intended?: string; how?: string;
  tried?: string; cause?: string; prUrl?: string;
}

/** The words of each moment. Every template — the registry the tests iterate. */
export const TEMPLATES: Record<Moment, (d: MessageData) => string[]> = {
  received: () => [
    'Thanks for the report. We are looking at it now: first we check it against the code, then we try to reproduce it.',
    'We will post here as soon as we know more.',
  ],
  needs_info: (d) => [
    'Thanks — to look into this we need a little more detail:',
    ...(d.questions?.length ? d.questions : ['The exact steps you took, and what you expected to happen instead.']).map((q, i) => `${i + 1}. ${q}`),
    'We will pick it up again as soon as you reply here.',
  ],
  duplicate: (d) => [
    `This looks like the same problem as ${d.duplicateOf ?? 'an existing report'}${d.duplicateStatus ? ` (currently: ${d.duplicateStatus})` : ''}, so we will follow it there.`,
    'If yours is different, reply here and a person will take another look.',
  ],
  not_a_bug: (d) => [
    `This looks like it is working as intended: ${d.intended ?? 'the behaviour you saw is the designed behaviour'}.`,
    ...(d.how ? [`To get the result you wanted: ${d.how}`] : []),
    'A person will confirm this. If we have misunderstood, reply here and it will be reopened.',
  ],
  not_reproduced: (d) => [
    `We could not make this happen on our side yet${d.tried ? ` — we tried: ${d.tried}` : ''}.`,
    'A developer will take a look. Any extra detail (exact steps, the account used, a screenshot) helps.',
  ],
  solution_found: (d) => [
    `We found the cause: ${d.cause ?? 'a defect in the code'}.`,
    'A fix is written and waiting for review by the team. We will let you know when it is live.',
  ],
  released: () => [
    'The fix is now live. Could you check that it works for you? If anything is still wrong, reply here.',
  ],
};

/** Words a message must never contain: no promised dates (guardrail 7, "honesty"). */
const PROMISE = /\b(by|on|before)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|\d{1,2}(st|nd|rd|th)?\b|january|february|march|april|may|june|july|august|september|october|november|december)/i;

export function renderMessage(moment: Moment, d: MessageData): string[] {
  const lines = TEMPLATES[moment](d).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const l of lines) if (PROMISE.test(l)) throw new Error(`a ${moment} message would promise a date: "${l}"`);
  return lines;
}

/** One comment, opening with the reporter mention; a link to the PR when there is one. */
export function messageBody(issue: Pick<TriageIssue, 'reporterId' | 'reporterName'>, moment: Moment, d: MessageData): AdfNode {
  const lines = renderMessage(moment, d);
  const first: AdfNode[] = issue.reporterId ? [adfMention(issue.reporterId, issue.reporterName), adfText(' ')] : [];
  const paras: AdfNode[][] = [[...first, adfText(lines[0])], ...lines.slice(1).map((l) => [adfText(l)])];
  if (d.prUrl && moment === 'solution_found') paras.push([adfText('The proposed fix: '), adfLink(d.prUrl, d.prUrl)]);
  return adfDoc(paras);
}

export type JiraFor = (source: TriageSource) => Pick<JiraClient, 'addComment' | 'addLabels' | 'transitionTo' | 'addRemoteLink'>;
let jiraFor: JiraFor = (source) => new JiraClient(source);
export function setMessengerJira(fn: JiraFor | null): void { jiraFor = fn ?? ((s) => new JiraClient(s)); }
export const jiraOf = (source: TriageSource) => jiraFor(source);

/**
 * Send a moment's comment. Returns 'sent', 'held' (external reporter, PR not approved yet) or
 * 'skipped' (an issue that is not in Jira — filed from QA with no Jira project).
 */
export async function sendMoment(source: TriageSource, issue: TriageIssue, moment: Moment, d: MessageData = {}, opts: { forceRelease?: boolean } = {}): Promise<'sent' | 'held' | 'skipped'> {
  if (moment === 'solution_found' && source.reporters === 'external' && !opts.forceRelease) {
    updateIssue(issue.id, { heldMessage: JSON.stringify(d) });
    logEvent(issue.id, 'message', 'solution_found held: the reporter is external, so it goes out once a person approves the PR', { moment });
    return 'held';
  }
  if (issue.origin !== 'jira') {
    logEvent(issue.id, 'message', `${moment}: not sent — this issue is not in Jira`, { moment, lines: renderMessage(moment, d) });
    return 'skipped';
  }
  const body = messageBody(issue, moment, d);
  await jiraOf(source).addComment(issue.issueKey, body);
  const fresh = getIssue(issue.id);
  if (fresh && !fresh.firstCommentAt) updateIssue(issue.id, { firstCommentAt: nowIso() });
  if (moment === 'solution_found') updateIssue(issue.id, { heldMessage: '' });
  logEvent(issue.id, 'message', `told the reporter: ${moment}`, { moment, lines: renderMessage(moment, d) });
  return 'sent';
}

export async function addLabels(source: TriageSource, issue: TriageIssue, labels: string[]): Promise<void> {
  if (labels.length === 0 || issue.origin !== 'jira') return;
  await jiraOf(source).addLabels(issue.issueKey, labels);
  logEvent(issue.id, 'label', `labelled ${labels.join(', ')}`, { labels });
}

/** Only when the source allows the agent to change status (default: comment and label only). */
export async function transition(source: TriageSource, issue: TriageIssue, which: keyof TriageSource['transitionNames']): Promise<void> {
  const name = source.transitionNames[which];
  if (!source.transitions || !name || issue.origin !== 'jira') return;
  const moved = await jiraOf(source).transitionTo(issue.issueKey, name);
  logEvent(issue.id, 'transition', moved ? `moved to ${name}` : `could not move to ${name} (no such transition)`, { which, name, moved });
}
