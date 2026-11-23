/**
 * THE ACCEPTANCE CONTRACT — what "done" means for a piloted goal, fixed before any work starts and
 * checked by NeonCore itself. See docs/GOAL-PILOT.md § Acceptance contract.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────
 * A goal report built from what the agents SAID ("tests pass", "done") is only as honest as the
 * least careful agent in the pipeline. And an agent that writes the code also writes the test, so
 * the bar can quietly move to wherever the code landed. The contract takes both out of the agents'
 * hands:
 *
 *   1. CRITERIA are numbered (AC-1…n) and frozen when the person accepts the plan. Each says what
 *      must be true (`text`), exactly what is expected (`expect`: inputs → result), and how it is
 *      checked (`verify`: an automated TEST, or a CHECKLIST item for work a test cannot judge —
 *      research, docs, UX copy).
 *   2. Before anything is built, an agent writes ONE TEST PER TEST-CRITERION that encodes the
 *      expected result and FAILS now (stage "Write the acceptance tests"). NeonCore reads the files
 *      and hashes them.
 *   3. The PERSON reviews criteria ↔ tests ↔ commands, runs them (they should be red), and
 *      approves. Approval LOCKS them: contents and hashes are stored.
 *   4. After EVERY workflow stage NeonCore re-hashes the locked files — any change stops the
 *      pipeline until the person restores the approved version or accepts the change with a
 *      reason — and runs each criterion's command itself (lib/repo-access.ts).
 *   5. Checklist criteria are judged at the end by an INDEPENDENT cartridge (not one that did the
 *      work), and each verdict is confirmed by the person.
 *   6. The goal report is SUCCESS only when every criterion passes on that evidence.
 *
 * Only a person can change a locked test: "unlock" (with a reason, optionally new wording),
 * "accept the change" (with a reason). Every such change is an AMENDMENT, versioned and shown in
 * the report. No agent-facing tool can do either.
 *
 * This module holds the records and the pure rules. The side effects — dispatching the test
 * writer and the reviewer, running commands, hashing files — live in lib/acceptance-runner.ts.
 */
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import db from '../db.js';
import { safeRelPath } from './repo-access.js';

// ── criteria ──────────────────────────────────────────────────────────────────

export type VerifyMethod = 'test' | 'checklist' | 'command';

export const VERIFY_METHODS: { value: VerifyMethod; label: string; hint: string }[] = [
  { value: 'test', label: 'Automated test', hint: 'A test written before the work, locked once you approve it, run by NeonCore after every stage.' },
  { value: 'command', label: 'Command', hint: 'One command from the repo root (e.g. "cargo build && cargo test") — it passes when it exits 0. No test is written; NeonCore runs it after every stage.' },
  { value: 'checklist', label: 'Checklist', hint: 'Judged at the end by an independent cartridge; you confirm each verdict.' },
];

/**
 * HOW BIG A FEATURE IS decides how many criteria it may have. "Set up the project with its
 * dependencies" does not need twelve behaviours, each with its own locked test: it needs "it builds"
 * and "its tests run". A planner given no budget writes to the ceiling, so each size has one, and a
 * submission over it is REJECTED with the reason (never trimmed silently) — the planner merges, drops
 * or re-sizes and submits again.
 */
export type FeatureSize = 'small' | 'medium' | 'large';
export const FEATURE_SIZES: { value: FeatureSize; label: string; hint: string; maxCriteria: number }[] = [
  { value: 'small', label: 'Small', maxCriteria: 3, hint: 'Setup, scaffolding, a config change, one narrow fix — usually 1-3 checks, often a single command.' },
  { value: 'medium', label: 'Medium', maxCriteria: 6, hint: 'One user-facing behaviour with its edge cases.' },
  { value: 'large', label: 'Large', maxCriteria: 12, hint: 'Several behaviours across modules or repos.' },
];
export const DEFAULT_FEATURE_SIZE: FeatureSize = 'medium';

export function featureSize(v: unknown): FeatureSize | '' {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return FEATURE_SIZES.some((x) => x.value === s) ? s as FeatureSize : '';
}

export function criteriaBudget(size: unknown): number {
  return FEATURE_SIZES.find((x) => x.value === (featureSize(size) || DEFAULT_FEATURE_SIZE))!.maxCriteria;
}

/** '' when the criteria fit the size; else the reason a planner is given (and must act on). */
export function overBudget(count: number, size: FeatureSize): string {
  const max = criteriaBudget(size);
  if (count <= max) return '';
  const bigger = FEATURE_SIZES.find((x) => x.maxCriteria > max);
  return `a ${size} feature takes at most ${max} acceptance criteria; ${count} were sent. Merge criteria that check the same thing, drop any that describe an implementation step rather than an observable result, and use one "command" criterion for build/setup checks` +
    (bigger ? ` — or, if the work really is bigger, submit "size": "${bigger.value}"` : '');
}

/** What every planner is told a criterion is — the same words for scoping and for document plans. */
export const CRITERION_RULES = [
  '- A criterion is an OBSERVABLE RESULT someone could check from outside — not an implementation step',
  '  ("add a Cargo.toml", "create a module") and not something another criterion already proves.',
  '- Fewer is better: write the smallest set that, if all pass, means the work is done.',
  '- Setup / scaffolding / dependency work is usually ONE "command" criterion ("cargo build && cargo test",',
  '  "npm ci && npm test") — the command exiting 0 is the check; no test file is written for it.',
];

export interface Criterion {
  /** AC-1, AC-2… — stable once the plan is accepted. */
  id: string;
  /** What must be true: "When a user saves an expense…, the system shall…". */
  text: string;
  /** EXACTLY what is expected — inputs → result. What the test asserts, or the checklist judges. */
  expect: string;
  verify: VerifyMethod;
  /** verify "command" only: the one command, from the repo root, that passes when it exits 0. */
  command?: string;
}

export const MAX_CRITERIA = 12;
export const MAX_FILES_PER_TEST = 6;
export const MAX_COMMAND_CHARS = 400;

/** Work whose result is code: criteria default to an automated test. The rest default to a checklist. */
export const TESTABLE_WORK_TYPES = new Set(['feature', 'bug', 'improvement', 'performance']);

export function defaultVerify(workType?: string): VerifyMethod {
  return TESTABLE_WORK_TYPES.has(workType ?? '') ? 'test' : 'checklist';
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The planner's criteria, as usable rows. Accepts objects ({text, expect, verify}) or bare strings;
 * when none were sent at all, each line of the free-text acceptance criteria becomes one (with no
 * `expect` — the person is told to add it). Ids are always re-assigned by position: a planner's own
 * numbering is not trusted to be unique or gap-free.
 */
export function normalizeCriteria(
  raw: unknown, opts: { fallback?: string; workType?: string } = {}, notes: string[] = [],
): Criterion[] {
  const def = defaultVerify(opts.workType);
  let items: { text: string; expect: string; verify: VerifyMethod; command?: string }[] = [];
  if (Array.isArray(raw) && raw.length) {
    raw.forEach((r, i) => {
      if (typeof r === 'string') { if (r.trim()) items.push({ text: oneLine(r.replace(/^[-*•]\s*/, '')), expect: '', verify: def }); return; }
      if (!r || typeof r !== 'object') { notes.push(`criterion ${i + 1} was not an object — dropped`); return; }
      const o = r as Record<string, unknown>;
      const text = oneLine(str(o.text) || str(o.criterion));
      if (!text) { notes.push(`criterion ${i + 1} had no text — dropped`); return; }
      const v = str(o.verify).toLowerCase();
      let verify: VerifyMethod = v === 'test' || v === 'checklist' || v === 'command' ? v : def;
      if (v && v !== verify) notes.push(`criterion ${i + 1}: verify "${v}" is not test, command or checklist — used ${verify}`);
      const command = oneLine(str(o.command));
      if (verify === 'command' && !command) {
        verify = def;
        notes.push(`criterion ${i + 1}: verify "command" came with no command — used ${verify}`);
      }
      items.push({ text, expect: oneLine(str(o.expect) || str(o.expected)), verify, ...(verify === 'command' ? { command } : {}) });
    });
  } else if (opts.fallback) {
    items = opts.fallback.split('\n').map((l) => oneLine(l.replace(/^[-*•]\s*/, '').replace(/^AC-\d+:\s*/i, ''))).filter(Boolean)
      .map((text) => ({ text, expect: '', verify: def }));
    if (items.length) notes.push('no structured criteria were sent — each acceptance-criteria line became one; add the exact expected result to each');
  }
  const seen = new Set<string>();
  items = items.filter((c) => {
    const k = c.text.toLowerCase();
    if (seen.has(k)) { notes.push(`"${c.text.slice(0, 60)}" was listed twice — kept once`); return false; }
    seen.add(k);
    return true;
  });
  if (items.length > MAX_CRITERIA) {
    notes.push(`${items.length} criteria sent; kept the first ${MAX_CRITERIA}`);
    items = items.slice(0, MAX_CRITERIA);
  }
  return items.map((c, i) => ({ id: `AC-${i + 1}`, ...c }));
}

/**
 * The criteria the PERSON accepts. Stricter than the planner's: a criterion checked by a test must
 * say exactly what it expects — a test written against "works correctly" can be made to pass by
 * anything, which is the failure the contract exists to prevent.
 */
export function acceptedCriteria(raw: unknown, workType?: string): { criteria: Criterion[]; error: string } {
  const notes: string[] = [];
  const criteria = normalizeCriteria(raw, { workType }, notes);
  if (Array.isArray(raw) && criteria.length !== raw.length) {
    return { criteria, error: `every criterion needs its text (${raw.length - criteria.length} empty or duplicate)` };
  }
  const badCommand = criteria.filter((c) => c.verify === 'command' && (!c.command || c.command.length > MAX_COMMAND_CHARS));
  if (badCommand.length) {
    return { criteria, error: `${badCommand.map((c) => c.id).join(', ')} ${badCommand.length === 1 ? 'is' : 'are'} checked by a command but ${badCommand.length === 1 ? 'has' : 'have'} none (or one longer than ${MAX_COMMAND_CHARS} characters) — give the one command that passes when it exits 0` };
  }
  const vague = criteria.filter((c) => c.verify === 'test' && !c.expect);
  if (vague.length) {
    return { criteria, error: `${vague.map((c) => c.id).join(', ')} ${vague.length === 1 ? 'is' : 'are'} checked by a test but say${vague.length === 1 ? 's' : ''} nothing about the expected result — write exactly what it should produce, or make it a checklist item` };
  }
  return { criteria, error: '' };
}

/** The criteria as the brief's free-text acceptance criteria (what reaches every agent in the goal brief). */
export function criteriaText(criteria: Criterion[]): string {
  return criteria.map((c) => `- ${c.id}: ${c.text}${c.expect ? ` Expected: ${c.expect}` : ''}${c.command ? ` Check: \`${c.command}\` exits 0.` : ''}`).join('\n');
}

export function criteriaHash(criteria: Criterion[]): string {
  return sha(JSON.stringify(criteria.map((c) => [c.id, c.text, c.expect, c.verify, ...(c.command ? [c.command] : [])])));
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── the contract record ───────────────────────────────────────────────────────

/**
 *   drafting  tests are being written (first time, after "ask for changes", or an amendment)
 *   review    tests are written; waiting for the person to approve them
 *   locked    approved — contents and hashes are the contract
 *   waived    the person skipped writing tests: test criteria stay unverified in the report
 */
export type ContractStatus = 'drafting' | 'review' | 'locked' | 'waived';

export interface TestFile { path: string; sha256: string; bytes: number; content: string }
export interface CriterionTest { criterionId: string; command: string; files: TestFile[] }

export interface CheckResult {
  criterionId: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  output: string;
  durationMs: number;
  at: string;
}

export interface BaselineRun {
  /** Which set of tests this ran against — a baseline of older tests says nothing about new ones. */
  testsHash: string;
  at: string;
  results: CheckResult[];
  error: string;
}

export interface TamperedFile { path: string; criterionId: string; expected: string; actual: string | null }

export interface Verification {
  id: string;
  stageId: string;
  stagePosition: number;
  stageTitle: string;
  at: string;
  version: number;
  status: 'passed' | 'partial' | 'failed' | 'tampered' | 'error';
  passing: number;
  total: number;
  /** Files whose hash was checked against the approved version. */
  filesChecked: number;
  results: CheckResult[];
  tampered: TamperedFile[];
  error: string;
}

export interface ChecklistVerdict { criterionId: string; verdict: 'met' | 'not-met'; evidence: string }

export interface ChecklistReview {
  requestId: string;
  reviewerAgentId: string;
  reviewerName: string;
  at: string;
  verdicts: ChecklistVerdict[];
  /** The person's decision per criterion. */
  confirmations: Record<string, { accepted: boolean; note: string; at: string }>;
  confirmedAt: string | null;
  /** False when only a cartridge that did the work was available to review it. */
  independent: boolean;
}

export interface Amendment {
  at: string;
  kind: 'changes-requested' | 'unlock' | 'restore' | 'accept-change' | 'waive';
  criterionIds: string[];
  reason: string;
  before?: { text: string; expect: string };
  after?: { text: string; expect: string };
  paths?: string[];
  /** The contract version this amendment produced (or, for a change request, the one it revised). */
  version: number;
}

export interface AcceptanceContract {
  id: string;
  pilotId: string;
  goalId: string;
  /** The repo the tests live in and run in (the acceptance stage's repo). */
  repoPath: string;
  agentType: string;
  status: ContractStatus;
  /** 0 until first locked; +1 on every lock and accepted change. */
  version: number;
  criteria: Criterion[];
  criteriaHash: string;
  /** What the test writer submitted, under review. */
  draftTests: CriterionTest[];
  /** What the person approved — the locked contract. */
  tests: CriterionTest[];
  /** The test writer's own notes (e.g. "AC-4 cannot be tested automatically"). */
  testNotes: string;
  /** The person's "ask for changes" text — sent with the next request. */
  feedback: string;
  /** An amendment in progress: which criteria were unlocked and why. */
  amending: { criterionIds: string[]; reason: string } | null;
  /** The person asked to approve: lock as soon as a baseline shows the tests red (or they confirmed). */
  /** `auto`: requested by NeonCore itself (not hands-on) — locks on a red baseline, asks otherwise. */
  approval: { requestedAt: string; confirmPassing: boolean; blocked: string; auto?: boolean } | null;
  baseline: BaselineRun | null;
  verifications: Verification[];
  checklist: ChecklistReview | null;
  amendments: Amendment[];
  /** Locked files found changed after a stage — the pipeline is stopped until the person decides. */
  tamper: { stageId: string; verificationId: string; files: TamperedFile[] } | null;
  /** The current tests request (stage 0, a change request, or an amendment). */
  requestId: string;
  /** Why a tests request is not out yet (no cartridge, a busy one). */
  waitReason: string;
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const parse = <T>(s: unknown, fallback: T): T => {
  try { return s ? JSON.parse(s as string) as T : fallback; } catch { return fallback; }
};

function rowToContract(row: Record<string, unknown>): AcceptanceContract {
  return {
    id: row.id as string,
    pilotId: row.pilot_id as string,
    goalId: row.goal_id as string,
    repoPath: (row.repo_path as string) || '',
    agentType: (row.agent_type as string) || 'claude',
    status: row.status as ContractStatus,
    version: (row.version as number) || 0,
    criteria: parse<Criterion[]>(row.criteria, []),
    criteriaHash: (row.criteria_hash as string) || '',
    draftTests: parse<CriterionTest[]>(row.draft_tests, []),
    tests: parse<CriterionTest[]>(row.tests, []),
    testNotes: (row.test_notes as string) || '',
    feedback: (row.feedback as string) || '',
    amending: parse<AcceptanceContract['amending']>(row.amending, null),
    approval: parse<AcceptanceContract['approval']>(row.approval, null),
    baseline: parse<BaselineRun | null>(row.baseline, null),
    verifications: parse<Verification[]>(row.verifications, []),
    checklist: parse<ChecklistReview | null>(row.checklist, null),
    amendments: parse<Amendment[]>(row.amendments, []),
    tamper: parse<AcceptanceContract['tamper']>(row.tamper, null),
    requestId: (row.request_id as string) || '',
    waitReason: (row.wait_reason as string) || '',
    lockedAt: (row.locked_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

const COLUMNS: Record<string, { col: string; json: boolean }> = {
  repoPath: { col: 'repo_path', json: false },
  agentType: { col: 'agent_type', json: false },
  status: { col: 'status', json: false },
  version: { col: 'version', json: false },
  criteria: { col: 'criteria', json: true },
  criteriaHash: { col: 'criteria_hash', json: false },
  draftTests: { col: 'draft_tests', json: true },
  tests: { col: 'tests', json: true },
  testNotes: { col: 'test_notes', json: false },
  feedback: { col: 'feedback', json: false },
  amending: { col: 'amending', json: true },
  approval: { col: 'approval', json: true },
  baseline: { col: 'baseline', json: true },
  verifications: { col: 'verifications', json: true },
  checklist: { col: 'checklist', json: true },
  amendments: { col: 'amendments', json: true },
  tamper: { col: 'tamper', json: true },
  requestId: { col: 'request_id', json: false },
  waitReason: { col: 'wait_reason', json: false },
  lockedAt: { col: 'locked_at', json: false },
};

export type ContractPatch = Partial<Omit<AcceptanceContract, 'id' | 'pilotId' | 'goalId' | 'createdAt' | 'updatedAt'>>;

export function updateContract(id: string, patch: ContractPatch): void {
  const keys = Object.keys(patch).filter((k) => COLUMNS[k]);
  if (keys.length === 0) return;
  const values = keys.map((k) => {
    const v = (patch as Record<string, unknown>)[k];
    return COLUMNS[k].json ? (v == null ? '' : JSON.stringify(v)) : v ?? null;
  });
  db.prepare(`UPDATE acceptance_contracts SET ${keys.map((k) => `${COLUMNS[k].col} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), id);
}

export function getContract(pilotId: string): AcceptanceContract | null {
  const row = db.prepare('SELECT * FROM acceptance_contracts WHERE pilot_id = ?').get(pilotId) as Record<string, unknown> | undefined;
  return row ? rowToContract(row) : null;
}

/**
 * Create (or replace) the contract when the pipeline starts. A contract with no test criteria is
 * locked from the start: there is nothing to write or approve, only checklist items to judge.
 */
export function createContract(input: { pilotId: string; goalId: string; criteria: Criterion[]; repoPath: string; agentType: string }): AcceptanceContract {
  const t = new Date().toISOString();
  const hasTests = input.criteria.some((c) => c.verify === 'test');
  db.prepare('DELETE FROM acceptance_contracts WHERE pilot_id = ?').run(input.pilotId);
  // Command criteria are their own check: they join the tests now, with no file to write or lock.
  const commands = commandTests(input.criteria);
  db.prepare(
    `INSERT INTO acceptance_contracts (id, pilot_id, goal_id, repo_path, agent_type, status, version, criteria, criteria_hash, tests, locked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), input.pilotId, input.goalId, input.repoPath, input.agentType,
    hasTests ? 'drafting' : 'locked', hasTests ? 0 : 1, JSON.stringify(input.criteria), criteriaHash(input.criteria),
    JSON.stringify(commands), hasTests ? null : t, t, t);
  return getContract(input.pilotId)!;
}

/** The command criteria as checks NeonCore runs: the command, no files. */
export function commandTests(criteria: Criterion[]): CriterionTest[] {
  return criteria.filter((c) => c.verify === 'command' && c.command).map((c) => ({ criterionId: c.id, command: c.command!, files: [] }));
}

export function deleteContract(pilotId: string): void {
  db.prepare('DELETE FROM acceptance_contracts WHERE pilot_id = ?').run(pilotId);
}

export const testCriteria = (c: Pick<AcceptanceContract, 'criteria'>) => c.criteria.filter((x) => x.verify === 'test');
export const checklistCriteria = (c: Pick<AcceptanceContract, 'criteria'>) => c.criteria.filter((x) => x.verify === 'checklist');
/** Criteria NeonCore checks by running something (a written test, or a command). */
export const runCriteria = (c: Pick<AcceptanceContract, 'criteria'>) => c.criteria.filter((x) => x.verify !== 'checklist');

/** The criteria a tests request is for: the unlocked ones during an amendment, else every test criterion. */
export function criteriaToWrite(c: AcceptanceContract): Criterion[] {
  const all = testCriteria(c);
  return c.amending ? all.filter((x) => c.amending!.criterionIds.includes(x.id)) : all;
}

/** Do workflow stages have to wait? Only while tests are being written or reviewed. */
export function contractBlocksWork(c: AcceptanceContract | null): boolean {
  return !!c && (c.status === 'drafting' || c.status === 'review');
}

// ── the test writer's submission ──────────────────────────────────────────────

export interface TestsSubmission {
  tests: { criterionId: string; command: string; files: string[] }[];
  notes: string;
}

/**
 * Validate what the test writer sent, before any file is read. Every criterion it was asked for
 * needs a test: a command (one line, from the repo root) and at least one repo-relative file.
 * Errors are written for the agent, which receives them verbatim and may submit again.
 */
export function normalizeTestsSubmission(raw: unknown, wanted: Criterion[]): { value: TestsSubmission | null; errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, errors: ['the submission was not an object'], notes };
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.tests) ? r.tests : [];
  const want = new Map(wanted.map((c) => [c.id, c]));
  const out: TestsSubmission['tests'] = [];
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') { errors.push(`tests[${i}] is not an object`); return; }
    const o = t as Record<string, unknown>;
    const id = str(o.criterionId).toUpperCase();
    if (!want.has(id)) { notes.push(`tests[${i}] is for "${str(o.criterionId)}", which is not one of the criteria asked for — ignored`); return; }
    if (out.some((x) => x.criterionId === id)) { errors.push(`${id} has two tests — send one entry per criterion (several files are fine)`); return; }
    const command = str(o.command);
    if (!command) errors.push(`${id} has no command — give the one command that runs only this test from the repo root`);
    else if (/[\r\n]/.test(command)) errors.push(`${id}: the command must be one line`);
    else if (command.length > MAX_COMMAND_CHARS) errors.push(`${id}: the command is longer than ${MAX_COMMAND_CHARS} characters`);
    const rawFiles = Array.isArray(o.files) ? o.files : typeof o.file === 'string' ? [o.file] : [];
    const files: string[] = [];
    for (const f of rawFiles) {
      const p = safeRelPath(f);
      if (!p) { errors.push(`${id}: "${String(f)}" is not a path inside the repo (relative, no ..)`); continue; }
      if (!files.includes(p)) files.push(p);
    }
    if (files.length === 0) errors.push(`${id} names no test file`);
    if (files.length > MAX_FILES_PER_TEST) errors.push(`${id} names ${files.length} files — at most ${MAX_FILES_PER_TEST}`);
    out.push({ criterionId: id, command, files });
  });
  const missing = wanted.filter((c) => !out.some((x) => x.criterionId === c.id));
  if (missing.length) errors.push(`no test for ${missing.map((c) => c.id).join(', ')} — every criterion listed needs one (if one cannot be tested automatically, say so in notes AND still submit your best test; the person can switch it to a checklist)`);
  const value = errors.length ? null : { tests: out.sort((a, b) => num(a.criterionId) - num(b.criterionId)), notes: str(r.notes).slice(0, 2000) };
  return { value, errors, notes };
}

const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/** One fingerprint for a set of tests: which files with which contents, run by which commands. */
export function testsHash(tests: CriterionTest[]): string {
  return sha(JSON.stringify(tests.map((t) => [t.criterionId, t.command, t.files.map((f) => [f.path, f.sha256])])));
}

/** Every locked file, with the criterion it belongs to. A file shared by two tests is listed once. */
export function lockedFiles(tests: CriterionTest[]): { path: string; criterionId: string; sha256: string; content: string }[] {
  const seen = new Map<string, { path: string; criterionId: string; sha256: string; content: string }>();
  for (const t of tests) for (const f of t.files) if (!seen.has(f.path)) seen.set(f.path, { path: f.path, criterionId: t.criterionId, sha256: f.sha256, content: f.content });
  return [...seen.values()];
}

/** Which locked files no longer match what the person approved. `reads` are the files as they are now. */
export function findTampering(tests: CriterionTest[], reads: { path: string; exists: boolean; sha256: string }[]): TamperedFile[] {
  const now = new Map(reads.map((r) => [r.path, r]));
  return lockedFiles(tests).flatMap((f): TamperedFile[] => {
    const r = now.get(f.path);
    if (!r || !r.exists) return [{ path: f.path, criterionId: f.criterionId, expected: f.sha256, actual: null }];
    return r.sha256 === f.sha256 ? [] : [{ path: f.path, criterionId: f.criterionId, expected: f.sha256, actual: r.sha256 }];
  });
}

export function verificationStatus(results: CheckResult[]): Verification['status'] {
  const passing = results.filter((r) => r.passed).length;
  return passing === results.length ? 'passed' : passing === 0 ? 'failed' : 'partial';
}

// ── where each criterion stands ───────────────────────────────────────────────

export type CriterionOutcome =
  | 'pass' | 'fail' | 'not-run'                       // test and command criteria
  | 'met' | 'not-met' | 'unconfirmed' | 'not-checked'  // checklist criteria
  | 'waived';

export interface CriterionState extends Criterion {
  outcome: CriterionOutcome;
  /** The locked test, if any. */
  test: { command: string; files: string[] } | null;
  /** The latest NeonCore run of its test (after a stage). */
  last: CheckResult | null;
  lastStage: string;
  /** The run before any work: a good test was red here. */
  baseline: CheckResult | null;
  verdict: ChecklistVerdict | null;
  confirmation: { accepted: boolean; note: string; at: string } | null;
  reviewer: string;
}

export const PASSING: ReadonlySet<CriterionOutcome> = new Set(['pass', 'met']);

/** Every criterion with its current evidence. The one function the view and the report both read. */
export function criterionStates(c: AcceptanceContract): CriterionState[] {
  const latest = [...c.verifications].reverse().find((v) => v.status !== 'tampered' && v.status !== 'error' && v.results.length) ?? null;
  return c.criteria.map((cr) => {
    const test = c.tests.find((t) => t.criterionId === cr.id) ?? null;
    const last = latest?.results.find((r) => r.criterionId === cr.id) ?? null;
    const baseline = c.baseline?.results.find((r) => r.criterionId === cr.id) ?? null;
    const verdict = c.checklist?.verdicts.find((v) => v.criterionId === cr.id) ?? null;
    const confirmation = c.checklist?.confirmations[cr.id] ?? null;
    let outcome: CriterionOutcome;
    if (cr.verify === 'command') {
      outcome = last ? (last.passed ? 'pass' : 'fail') : 'not-run';
    } else if (cr.verify === 'test') {
      const waived = c.status === 'waived' || (!test && c.amendments.some((a) => a.kind === 'waive' && a.criterionIds.includes(cr.id)));
      outcome = waived && !last ? 'waived' : last ? (last.passed ? 'pass' : 'fail') : 'not-run';
    } else if (confirmation) {
      outcome = confirmation.accepted ? 'met' : 'not-met';
    } else {
      outcome = verdict ? 'unconfirmed' : 'not-checked';
    }
    return {
      ...cr, outcome,
      test: test ? { command: test.command, files: test.files.map((f) => f.path) } : null,
      last, lastStage: last && latest ? (latest.stageId ? `stage ${latest.stagePosition} (${latest.stageTitle})` : latest.stageTitle) : '',
      baseline, verdict, confirmation, reviewer: verdict ? c.checklist?.reviewerName ?? '' : '',
    };
  });
}

/**
 * The goal's verdict from its criteria: SUCCESS only when every criterion passes on NeonCore's own
 * evidence. INCOMPLETE when nothing has been judged yet.
 */
export function contractVerdict(states: CriterionState[]): 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'INCOMPLETE' {
  if (states.length === 0) return 'INCOMPLETE';
  const passing = states.filter((s) => PASSING.has(s.outcome)).length;
  const judged = states.filter((s) => !['not-run', 'not-checked', 'unconfirmed', 'waived'].includes(s.outcome)).length;
  if (passing === states.length) return 'SUCCESS';
  if (judged === 0) return 'INCOMPLETE';
  return passing === 0 ? 'FAILED' : 'PARTIAL';
}

// ── what every agent is told ──────────────────────────────────────────────────

export const CONTRACT_BLOCK_HEADER = '[NeonCore acceptance contract';
const CONTRACT_BLOCK_MAX = 2200;

/**
 * The locked contract, as it travels with every dispatched prompt for the goal (send-command.ts).
 * It is the one piece of the goal that is not advice: these files must not change, and these
 * commands are what "done" is measured by. '' when there is no contract in force.
 */
export function contractBlock(c: AcceptanceContract | null): string {
  // Nothing binds before the first lock; during an amendment the previous lock still does.
  if (!c || c.criteria.length === 0 || c.status === 'waived' || c.version === 0) return '';
  const tests = c.tests;
  const lines = c.criteria.map((cr) => {
    const t = tests.find((x) => x.criterionId === cr.id);
    if (cr.verify === 'checklist') return `- ${cr.id} (checklist): ${cr.text} — judged at the end by an independent reviewer.`;
    if (cr.verify === 'command') return `- ${cr.id} (command): ${cr.text} → \`${t?.command ?? cr.command}\` must exit 0`;
    if (!t) return `- ${cr.id} (test, being written): ${cr.text}`;
    return `- ${cr.id} (test): ${cr.text} → \`${t.command}\` [${t.files.map((f) => f.path).join(', ')}]`;
  });
  const block = [
    `${CONTRACT_BLOCK_HEADER} v${c.version} — LOCKED by the person]`,
    'These tests define "done". Do NOT edit, rename, move or delete the files in [brackets]: NeonCore checks',
    'their hashes after every stage and stops the pipeline if they changed. Make them pass by changing the',
    'product code. If a test looks wrong, say so in your report — only the person can unlock it.',
    ...lines,
  ].join('\n');
  return block.length > CONTRACT_BLOCK_MAX ? `${block.slice(0, CONTRACT_BLOCK_MAX - 1)}…` : block;
}

/** The contract of the pilot currently steering this goal, if it has one in force. */
export function activeContractForGoal(goalId: string): AcceptanceContract | null {
  if (!goalId) return null;
  const row = db.prepare(
    `SELECT c.* FROM acceptance_contracts c JOIN goal_pilots p ON p.id = c.pilot_id
      WHERE c.goal_id = ? AND p.phase IN ('running', 'paused') ORDER BY c.created_at DESC LIMIT 1`,
  ).get(goalId) as Record<string, unknown> | undefined;
  return row ? rowToContract(row) : null;
}
