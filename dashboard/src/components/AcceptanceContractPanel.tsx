/**
 * THE ACCEPTANCE CONTRACT in the Goal Pilot panel (server: lib/acceptance-contract.ts and
 * lib/acceptance-runner.ts; docs/GOAL-PILOT.md § Acceptance contract).
 *
 *   CriteriaEditor   the plan step: numbered criteria, each with its EXACT expected result and how it
 *                    is checked (an automated test, or a checklist item). Frozen when the plan is
 *                    accepted.
 *   ContractCard     the running pipeline: every criterion with its evidence, and every decision
 *                    that is the person's alone —
 *                      · review the tests an agent wrote before any work (criterion ↔ test ↔
 *                        command ↔ file contents), run them (they should fail), approve & lock,
 *                        or ask for changes;
 *                      · a locked test changed during a stage: restore the approved version, or
 *                        accept the change with a reason;
 *                      · unlock one criterion (with a reason, optionally new wording);
 *                      · confirm or overrule the independent reviewer's checklist verdicts.
 *
 * Nothing here decides anything: each button is one route, and the server enforces every rule
 * (lib/goalPilot.ts mirrors a few only so the panel can say what is missing before a click).
 */
import { useState } from 'react';
import { api } from '../lib/api';
import type { AcceptanceContract, ContractTest, CriterionState, GoalPilot, GoalPilotMeta, VerifyMethod } from '../types';
import {
  type DraftCriterion, criterionId, criteriaProblems, moveItem, OUTCOME_LABEL, OUTCOME_TONE, contractAction, contractHeadline,
  activityLine,
} from '../lib/goalPilot';
import { input, primaryBtn, quietBtn, dangerBtn, errorText } from './pilotStyles';

// ── the plan step: criteria ───────────────────────────────────────────────────

/** Rows for a textarea that shows its whole text (about 95 characters a row at this width). */
const fit = (text: string) => Math.min(5, Math.max(1, Math.ceil(text.length / 95)));

export function CriteriaEditor({ criteria, onChange, meta, defaultVerify }: {
  criteria: DraftCriterion[];
  onChange: (next: DraftCriterion[]) => void;
  meta: GoalPilotMeta;
  defaultVerify: VerifyMethod;
}) {
  const problems = criteriaProblems(criteria);
  const methods = meta.verifyMethods ?? [
    { value: 'test' as const, label: 'Automated test', hint: '' }, { value: 'checklist' as const, label: 'Checklist', hint: '' },
  ];
  const max = meta.limits.maxCriteria ?? 12;
  const set = (i: number, patch: Partial<DraftCriterion>) => onChange(criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const tests = criteria.filter((c) => c.verify === 'test').length;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="text-[11px] text-gray-400 uppercase tracking-wider">Acceptance criteria — the contract</h3>
        <span className="text-[10px] text-gray-600">Frozen when you accept · numbered AC-1…</span>
      </div>
      <p className="text-[11px] text-gray-600 mb-2 leading-relaxed">
        What "done" means, one behaviour each, with <span className="text-gray-400">exactly</span> what is expected.
        {tests > 0 && <> Before anything is built, an agent writes one failing test per <span className="text-gray-400">test</span> criterion;
          you approve them, they are locked, and NeonCore runs them itself after every stage.</>}
        {' '}Checklist items are judged at the end by a cartridge that did not do the work, and you confirm each verdict.
      </p>
      <div className="space-y-2">
        {criteria.map((c, i) => {
          const vague = c.verify === 'test' && c.text.trim() && !c.expect.trim();
          return (
            <div key={i} className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5" data-testid="criterion-row">
              <div className="flex items-start gap-2">
                <span className="text-[11px] font-mono text-violet-300 mt-1.5 w-10 flex-shrink-0">{criterionId(i)}</span>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <textarea rows={fit(c.text)} className={`${input} text-[12px]`} value={c.text} aria-label={`${criterionId(i)} criterion`}
                    placeholder="When <situation>, the system shall <result>." onChange={(e) => set(i, { text: e.target.value })} />
                  <div className="flex items-start gap-2">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider mt-2 w-14 flex-shrink-0">Expected</span>
                    <textarea rows={fit(c.expect)} className={`${input} text-[12px] ${vague ? 'border-amber-600/60' : ''}`} value={c.expect} aria-label={`${criterionId(i)} expected`}
                      placeholder="Inputs → exact result, with real values (12.50 on 2024-03-05 → listed under March 2024)"
                      onChange={(e) => set(i, { expect: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {methods.map((m) => (
                      <button key={m.value} type="button" title={m.hint} onClick={() => set(i, { verify: m.value })}
                        className={`text-[11px] px-2 py-0.5 rounded border ${c.verify === m.value ? 'bg-violet-600/30 border-violet-500/60 text-violet-100' : 'border-white/10 text-gray-500 hover:text-gray-300'}`}>
                        {m.value === 'test' ? '⚙ ' : '☑ '}{m.label}
                      </button>
                    ))}
                    {vague && <span className="text-[11px] text-amber-300/90">A test needs an exact expected result.</span>}
                  </div>
                </div>
                <div className="flex flex-col gap-0.5 items-center">
                  <button type="button" onClick={() => onChange(moveItem(criteria, i, -1))} disabled={i === 0} className="text-gray-500 hover:text-gray-200 disabled:opacity-20 text-[11px]" title="Move up">▲</button>
                  <button type="button" onClick={() => onChange(moveItem(criteria, i, 1))} disabled={i === criteria.length - 1} className="text-gray-500 hover:text-gray-200 disabled:opacity-20 text-[11px]" title="Move down">▼</button>
                  <button type="button" onClick={() => onChange(criteria.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 text-[12px]" title="Remove">×</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <button type="button" disabled={criteria.length >= max} onClick={() => onChange([...criteria, { text: '', expect: '', verify: defaultVerify }])} className={quietBtn}>
          + Add a criterion
        </button>
        {problems.length > 0 && <span className="text-[11px] text-amber-300/90 text-right">{problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}</span>}
      </div>
    </div>
  );
}

// ── the running pipeline: the contract card ─────────────────────────────────────

function OutcomePill({ s }: { s: Pick<CriterionState, 'outcome'> }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full border whitespace-nowrap ${OUTCOME_TONE[s.outcome]}`}>{OUTCOME_LABEL[s.outcome]}</span>;
}

function TestFiles({ test }: { test: ContractTest }) {
  return (
    <div className="space-y-1">
      {test.files.map((f) => (
        <details key={f.path} className="group">
          <summary className="text-[11px] text-gray-400 hover:text-gray-200 cursor-pointer font-mono">
            {f.path} <span className="text-gray-600">· {f.bytes} bytes · sha256 {f.sha256.slice(0, 10)}…</span>
          </summary>
          <pre className="mt-1 text-[11px] text-gray-300 bg-black/40 rounded-md p-2 max-h-72 overflow-auto whitespace-pre">{f.content}</pre>
        </details>
      ))}
    </div>
  );
}

function RunResult({ r, expectRed = false }: { r: CriterionState['last']; expectRed?: boolean }) {
  if (!r) return null;
  const good = expectRed ? !r.passed : r.passed;
  return (
    <details>
      <summary className={`text-[11px] cursor-pointer ${good ? 'text-emerald-300/90' : 'text-amber-300/90'}`}>
        {r.passed ? 'passes' : 'fails'} (exit {r.exitCode ?? 'none'}{r.timedOut ? ', timed out' : ''}, {Math.max(1, Math.round(r.durationMs / 100) / 10)}s)
        {expectRed && (r.passed ? ' — already passes before any work' : ' — as it should before any work')}
      </summary>
      <pre className="mt-1 text-[11px] text-gray-400 bg-black/40 rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap">{r.output || '(no output)'}</pre>
    </details>
  );
}

/** Tests under review: criterion ↔ test ↔ command ↔ contents, and the baseline run. */
function ReviewTests({ pilot, c, act, busy }: { pilot: GoalPilot; c: AcceptanceContract; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const running = c.activity?.kind === 'baseline';
  const baseline = c.baselineFresh ? c.baseline : null;
  const green = baseline?.results.filter((r) => r.passed).map((r) => r.criterionId) ?? [];
  const waitingOnRun = !!c.approval && !c.approval.blocked;

  return (
    <div className="space-y-2.5">
      <p className="text-[12px] text-gray-300">
        Check that each test encodes <span className="text-gray-100">exactly</span> what its criterion expects. Run them: before any work they should all
        <span className="text-red-300"> fail</span>. Approving locks them — from then on only you can change them.
      </p>
      {c.amending && <p className="text-[12px] text-violet-200/80">Amendment for {c.amending.criterionIds.join(', ')}: {c.amending.reason}</p>}
      {c.testNotes && <p className="text-[11px] text-gray-400 border-l-2 border-white/10 pl-2">The test writer says: {c.testNotes}</p>}
      <div className="space-y-2">
        {c.draftTests.map((t) => {
          const cr = c.criteria.find((x) => x.id === t.criterionId);
          const r = baseline?.results.find((x) => x.criterionId === t.criterionId) ?? null;
          const changed = c.amending ? c.amending.criterionIds.includes(t.criterionId) : true;
          return (
            <div key={t.criterionId} className={`rounded-lg border p-2.5 ${changed ? 'border-violet-700/40 bg-violet-950/20' : 'border-white/[0.06] opacity-70'}`}>
              <div className="flex items-start gap-2">
                <span className="text-[11px] font-mono text-violet-300 w-10 flex-shrink-0 mt-0.5">{t.criterionId}</span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-[12px] text-gray-100">{cr?.text}</p>
                  {cr?.expect && <p className="text-[11px] text-gray-400"><span className="text-gray-600 uppercase tracking-wider text-[10px] mr-1">expected</span>{cr.expect}</p>}
                  <p className="text-[11px]"><span className="text-gray-600 uppercase tracking-wider text-[10px] mr-1">command</span><code className="text-sky-200 bg-black/40 px-1 rounded">{t.command}</code></p>
                  <TestFiles test={t} />
                  {r && <RunResult r={r} expectRed />}
                  {!changed && <p className="text-[10px] text-gray-600">Locked — unchanged by this amendment.</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {c.criteria.some((x) => x.verify === 'checklist') && !c.amending && (
        <p className="text-[11px] text-gray-500">
          Not tested: {c.criteria.filter((x) => x.verify === 'checklist').map((x) => x.id).join(', ')} — checklist, judged at the end by a cartridge that did not do the work.
        </p>
      )}
      {running && <p className="text-[12px] text-sky-300">{activityLine(c)}</p>}
      {c.baseline?.error && !c.approval?.blocked && <p className="text-[12px] text-amber-300">The tests could not be run: {c.baseline.error}</p>}
      {c.approval?.blocked && (
        <div className="text-[12px] text-amber-200 bg-amber-900/25 border border-amber-700/40 rounded-md px-2.5 py-2 space-y-1.5">
          <p>{c.approval.blocked}</p>
          {green.length > 0 && (
            <button disabled={busy} onClick={() => act(() => api.approveAcceptanceTests(pilot.id, true))} className={dangerBtn}>
              Approve anyway — {green.join(', ')} will count as passing from the start
            </button>
          )}
        </div>
      )}
      {asking && (
        <div className="space-y-1.5">
          <textarea rows={3} className={`${input} text-[12px]`} value={feedback} autoFocus aria-label="What should change"
            placeholder="What should change — e.g. AC-2 must also check that April expenses are excluded"
            onChange={(e) => setFeedback(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAsking(false)} className={quietBtn}>Cancel</button>
            <button disabled={busy || feedback.trim().length < 5} onClick={() => act(async () => { await api.requestAcceptanceChanges(pilot.id, feedback); setAsking(false); setFeedback(''); })} className={primaryBtn}>
              Send to the test writer
            </button>
          </div>
        </div>
      )}
      {!asking && (
        <div className="flex items-center justify-end gap-2 flex-wrap">
          <button disabled={busy || running} onClick={() => act(() => api.runAcceptanceTests(pilot.id))} className={quietBtn}>
            {running ? 'Running…' : baseline ? 'Run them again' : 'Run them now'}
          </button>
          <button disabled={busy} onClick={() => setAsking(true)} className={quietBtn}>Ask for changes</button>
          <button disabled={busy || running || waitingOnRun} onClick={() => act(() => api.approveAcceptanceTests(pilot.id))} className={primaryBtn}
            title="Runs the tests first if they have not been run against this version; locks them when they all fail">
            {waitingOnRun ? 'Locking once the run finishes…' : 'Approve & lock'}
          </button>
        </div>
      )}
    </div>
  );
}

/** A locked test changed during a stage. Only the person resolves it. */
function TamperAlert({ pilot, c, act, busy }: { pilot: GoalPilot; c: AcceptanceContract; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState('');
  const t = c.tamper!;
  const stage = pilot.stages.find((s) => s.id === t.stageId);
  const deleted = t.files.some((f) => !f.actual);
  return (
    <div className="rounded-lg border border-red-700/50 bg-red-950/30 p-3 space-y-2" role="alert">
      <p className="text-[13px] text-red-200 font-medium">Locked acceptance tests were changed{stage ? ` during stage ${stage.position + 1} (${stage.title})` : ''}.</p>
      <ul className="text-[12px] text-red-100/80 space-y-0.5 font-mono">
        {t.files.map((f) => <li key={f.path}>· {f.path} ({f.criterionId}) — {f.actual ? `sha256 ${f.expected.slice(0, 8)}… → ${f.actual.slice(0, 8)}…` : 'deleted'}</li>)}
      </ul>
      <p className="text-[11px] text-red-100/60">The pipeline is stopped. Agents may not move the bar: put the approved version back, or — if the change is right — accept it as a new version of the contract, with your reason on record.</p>
      {accepting ? (
        <div className="space-y-1.5">
          <textarea rows={2} className={`${input} text-[12px]`} value={reason} autoFocus aria-label="Why accept the change" placeholder="Why the changed test is right" onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAccepting(false)} className={quietBtn}>Cancel</button>
            <button disabled={busy || reason.trim().length < 5} onClick={() => act(() => api.acceptAcceptanceTestChange(pilot.id, reason))} className={dangerBtn}>Accept the change as v{c.version + 1}</button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2 flex-wrap">
          <button disabled={busy || deleted} onClick={() => setAccepting(true)} className={quietBtn} title={deleted ? 'A deleted test cannot be accepted — restore it, or unlock its criterion' : undefined}>Accept the change…</button>
          <button disabled={busy} onClick={() => act(() => api.restoreAcceptanceTests(pilot.id))} className={primaryBtn}>Restore the approved version</button>
        </div>
      )}
    </div>
  );
}

/** The independent reviewer's verdicts; the person confirms or overrules each. */
function ChecklistConfirm({ pilot, c, act, busy }: { pilot: GoalPilot; c: AcceptanceContract; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const review = c.checklist!;
  const [decisions, setDecisions] = useState<Record<string, { accepted: boolean; note: string }>>(() =>
    Object.fromEntries(review.verdicts.map((v) => [v.criterionId, { accepted: v.verdict === 'met', note: '' }])));
  const needNote = review.verdicts.filter((v) => (v.verdict === 'met') !== decisions[v.criterionId]?.accepted && (decisions[v.criterionId]?.note ?? '').trim().length < 5);
  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 space-y-2">
      <p className="text-[13px] text-amber-100 font-medium">Checklist verdicts to confirm</p>
      <p className="text-[11px] text-amber-100/70">
        Judged by {review.reviewerName || 'a cartridge'}{review.independent ? ', which did not do the work' : ' — it also worked on this goal, so this is NOT an independent review'}.
        Your decision is what counts; overruling needs a note.
      </p>
      {review.verdicts.map((v) => {
        const cr = c.criteria.find((x) => x.id === v.criterionId);
        const d = decisions[v.criterionId];
        return (
          <div key={v.criterionId} className="rounded-md border border-white/10 p-2 space-y-1">
            <p className="text-[12px] text-gray-100"><span className="font-mono text-violet-300 mr-1.5">{v.criterionId}</span>{cr?.text}</p>
            <p className="text-[11px] text-gray-400">Reviewer: <span className={v.verdict === 'met' ? 'text-emerald-300' : 'text-red-300'}>{v.verdict}</span> — {v.evidence}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {[true, false].map((accepted) => (
                <button key={String(accepted)} type="button" onClick={() => setDecisions((p) => ({ ...p, [v.criterionId]: { ...p[v.criterionId], accepted } }))}
                  className={`text-[11px] px-2 py-0.5 rounded border ${d?.accepted === accepted ? (accepted ? 'bg-emerald-700/40 border-emerald-500/60 text-emerald-100' : 'bg-red-800/40 border-red-500/60 text-red-100') : 'border-white/10 text-gray-500'}`}>
                  {accepted ? 'Met' : 'Not met'}
                </button>
              ))}
              <input className={`${input} text-[11px] flex-1 min-w-[180px]`} value={d?.note ?? ''} aria-label={`${v.criterionId} note`}
                placeholder={(v.verdict === 'met') !== d?.accepted ? 'Why you disagree (required)' : 'Note (optional)'}
                onChange={(e) => setDecisions((p) => ({ ...p, [v.criterionId]: { ...p[v.criterionId], note: e.target.value } }))} />
            </div>
          </div>
        );
      })}
      <div className="flex justify-end">
        <button disabled={busy || needNote.length > 0} onClick={() => act(() => api.confirmAcceptanceChecklist(pilot.id, decisions))} className={primaryBtn}>
          Confirm verdicts
        </button>
      </div>
    </div>
  );
}

/** One criterion on a locked contract: its evidence, and the person's "unlock". */
function CriterionRow({ pilot, c, s, act, busy }: { pilot: GoalPilot; c: AcceptanceContract; s: CriterionState; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const [unlocking, setUnlocking] = useState(false);
  const [reason, setReason] = useState('');
  const [text, setText] = useState(s.text);
  const [expect, setExpect] = useState(s.expect);
  const test = c.tests.find((t) => t.criterionId === s.id);
  const live = pilot.phase === 'running' || pilot.phase === 'paused';
  return (
    <div className="rounded-md border border-white/[0.07] bg-white/[0.015] px-2.5 py-2" data-testid={`criterion-${s.id}`}>
      <div className="flex items-start gap-2">
        <span className="text-[11px] font-mono text-violet-300 w-10 flex-shrink-0 mt-0.5">{s.id}</span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-[12px] text-gray-100">{s.text}</p>
          {s.expect && <p className="text-[11px] text-gray-500"><span className="uppercase tracking-wider text-[10px] mr-1">expected</span>{s.expect}</p>}
          {s.verify === 'test' && s.test && (
            <p className="text-[11px] text-gray-500"><code className="text-sky-200/80">{s.test.command}</code>{s.lastStage && <span> · last checked after {s.lastStage}</span>}</p>
          )}
          {s.verify === 'checklist' && <p className="text-[11px] text-gray-500">Checklist — judged at the end by an independent cartridge{s.reviewer ? ` (${s.reviewer})` : ''}.</p>}
          {s.last && <RunResult r={s.last} />}
          {s.verdict && <p className="text-[11px] text-gray-400">Reviewer: {s.verdict.verdict} — {s.verdict.evidence}{s.confirmation ? ` · you: ${s.confirmation.accepted ? 'met' : 'not met'}${s.confirmation.note ? ` (${s.confirmation.note})` : ''}` : ''}</p>}
          {test && <details><summary className="text-[11px] text-gray-600 hover:text-gray-400 cursor-pointer">Locked test files</summary><div className="mt-1"><TestFiles test={test} /></div></details>}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <OutcomePill s={s} />
          {live && c.status === 'locked' && !c.tamper && s.verify === 'test' && !unlocking && (
            <button onClick={() => setUnlocking(true)} className="text-[10px] text-gray-500 hover:text-violet-300" title="Only you can change a locked test">Unlock…</button>
          )}
        </div>
      </div>
      {unlocking && (
        <div className="mt-2 space-y-1.5 pl-12">
          <textarea rows={2} className={`${input} text-[12px]`} value={reason} autoFocus aria-label={`Why unlock ${s.id}`} placeholder="Why this test has to change (recorded in the report)" onChange={(e) => setReason(e.target.value)} />
          <input className={`${input} text-[12px]`} value={text} aria-label={`${s.id} new wording`} onChange={(e) => setText(e.target.value)} />
          <input className={`${input} text-[12px]`} value={expect} aria-label={`${s.id} new expected`} placeholder="Expected result" onChange={(e) => setExpect(e.target.value)} />
          <p className="text-[11px] text-gray-600">The agent rewrites this one test; you approve it again. Stages that have not started wait for the new version.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setUnlocking(false)} className={quietBtn}>Cancel</button>
            <button disabled={busy || reason.trim().length < 5} onClick={() => act(async () => { await api.unlockAcceptanceCriterion(pilot.id, s.id, { reason, text, expect }); setUnlocking(false); })} className={dangerBtn}>
              Unlock {s.id}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContractCard({ pilot, onChanged }: { pilot: GoalPilot; onChanged: () => void }) {
  const c = pilot.acceptance;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!c) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const action = contractAction(c, pilot.stages);
  const pct = c.total ? Math.round((c.passing / c.total) * 100) : 0;
  const checks = c.verifications.filter((v) => v.status !== 'error').length;
  const writer = c.status === 'drafting' ? pilot.stages.find((s) => s.kind === 'acceptance')?.agentName : '';

  return (
    <div className={`rounded-lg border p-3 space-y-2.5 ${action ? 'border-amber-600/50 bg-amber-950/10' : 'border-sky-800/40 bg-sky-950/10'}`} data-testid="acceptance-contract">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h4 className="text-[12px] text-sky-100 font-semibold flex items-center gap-2">
            <span aria-hidden="true">⚖</span> Acceptance contract
            {action && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-700/40 text-amber-100 uppercase tracking-wider">needs you</span>}
          </h4>
          <p className="text-[11px] text-gray-400">{contractHeadline(c)}</p>
        </div>
        <div className="flex items-center gap-2 min-w-[180px]">
          <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden" title={`${c.passing} of ${c.total} criteria passing`}>
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] text-gray-300 whitespace-nowrap">{c.passing}/{c.total} passing</span>
        </div>
      </div>

      {c.activity && c.activity.kind !== 'baseline' && <p className="text-[12px] text-sky-300">{activityLine(c)}</p>}
      {c.status === 'drafting' && (
        <p className="text-[12px] text-gray-400">
          {c.waitReason || (c.request?.status === 'failed' ? `The request failed: ${c.request.error}` : `${writer || 'A cartridge'} is writing one failing test per criterion — you review them before anything is built.`)}
          {action === 'ask-again' && <button disabled={busy} onClick={() => act(() => api.askAgainForAcceptanceTests(pilot.id))} className="ml-2 text-violet-300 hover:text-violet-200">Ask again</button>}
        </p>
      )}
      {c.tamper && <TamperAlert pilot={pilot} c={c} act={act} busy={busy} />}
      {c.status === 'review' && <ReviewTests pilot={pilot} c={c} act={act} busy={busy} />}
      {action === 'confirm-checklist' && c.checklist && <ChecklistConfirm pilot={pilot} c={c} act={act} busy={busy} />}

      {c.status !== 'review' && (
        <div className="space-y-1.5">
          {c.states.map((s) => <CriterionRow key={s.id} pilot={pilot} c={c} s={s} act={act} busy={busy} />)}
        </div>
      )}

      {(checks > 0 || c.amendments.length > 0) && (
        <details>
          <summary className="text-[11px] text-gray-500 hover:text-gray-300 cursor-pointer">
            History — {checks} check{checks === 1 ? '' : 's'} by NeonCore{c.amendments.length ? `, ${c.amendments.length} change${c.amendments.length === 1 ? '' : 's'} by you` : ''}
          </summary>
          <ul className="mt-1.5 space-y-0.5 text-[11px] text-gray-400 pl-3 border-l border-white/10">
            {[...c.verifications.map((v) => ({ at: v.at, line: v.status === 'tampered'
              ? `after stage ${v.stagePosition} (${v.stageTitle}): locked tests changed — ${v.tampered.map((f) => f.path).join(', ')}`
              : v.status === 'error' ? `after stage ${v.stagePosition}: could not check — ${v.error}`
              : `after stage ${v.stagePosition} (${v.stageTitle}): ${v.passing}/${v.total} passing · ${v.filesChecked} locked file${v.filesChecked === 1 ? '' : 's'} unchanged (v${v.version})` })),
            ...c.amendments.map((a) => ({ at: a.at, line: `you — ${a.kind.replace('-', ' ')} ${a.criterionIds.join(', ')}${a.version ? ` → v${a.version}` : ''}: ${a.reason}` }))]
              .sort((x, y) => x.at.localeCompare(y.at))
              .map((x, i) => <li key={i}><span className="text-gray-600">{x.at.slice(11, 16)}</span> {x.line}</li>)}
          </ul>
        </details>
      )}
      {error && <p className="text-[12px] text-amber-300">{error}</p>}
    </div>
  );
}
