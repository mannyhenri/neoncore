/**
 * FINDINGS — what the Explorer found, by severity. The same bug reached by ten paths is one
 * finding with a seen count. Each has the steps taken, a screenshot, and a reproduction test.
 */
import { useState } from 'react';
import { evidenceUrl } from '../../lib/qaApi';
import { QaArt } from './art';
import { SentenceList } from './TestsTab';
import type { QaFinding, QaTarget } from './types';
import { QA_SEVERITIES } from './types';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, INPUT, Loading, SeverityPill } from './ui';

export function ExploreForm({ target, busy, onExplore }: {
  target: QaTarget;
  busy?: boolean;
  onExplore: (goal: string, budgets: { steps: number; minutes: number }) => Promise<void> | void;
}) {
  const [goal, setGoal] = useState('');
  const [steps, setSteps] = useState(target.budgets.steps);
  const [minutes, setMinutes] = useState(target.budgets.minutes);
  return (
    <div data-qa-explore className={`${CARD} flex flex-col md:flex-row gap-3 md:items-end`}>
      <QaArt name="module-explorer" className="w-20 shrink-0 hidden md:block" />
      <label className="flex-1 space-y-1">
        <span className="text-[12px] text-gray-400">Goal (optional)</span>
        <input className={INPUT} placeholder='e.g. "focus on the approval flow"' value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label className="w-28 space-y-1">
        <span className="text-[12px] text-gray-400">Step budget</span>
        <input className={INPUT} type="number" min={1} value={steps} onChange={(e) => setSteps(Math.max(1, Number(e.target.value) || 1))} aria-label="Step budget" />
      </label>
      <label className="w-28 space-y-1">
        <span className="text-[12px] text-gray-400">Minutes</span>
        <input className={INPUT} type="number" min={1} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))} aria-label="Time budget in minutes" />
      </label>
      <button className={BTN_PRIMARY} disabled={busy || !target.agentId} title={target.agentId ? undefined : 'Pick the cartridge that explores in the target settings'} onClick={() => onExplore(goal.trim(), { steps, minutes })}>
        Explore
      </button>
    </div>
  );
}

export function FindingsTab({ findings, target, busy, onExplore, onAddTest, onDismiss }: {
  findings: QaFinding[] | undefined;
  target: QaTarget;
  busy?: boolean;
  onExplore: (goal: string, budgets: { steps: number; minutes: number }) => Promise<void> | void;
  onAddTest: (f: QaFinding) => Promise<void> | void;
  onDismiss: (f: QaFinding) => Promise<void> | void;
}) {
  const form = <ExploreForm target={target} busy={busy} onExplore={onExplore} />;
  if (findings === undefined) return <div className="space-y-4">{form}<Loading what="findings" /></div>;
  const open = findings.filter((f) => f.status === 'open');
  if (open.length === 0) {
    return (
      <div className="space-y-4">
        {form}
        <Empty art="empty-findings" title="No findings">
          <p>The Explorer uses the app like a person would and reports crashes, console errors, failed calls, broken links, dead buttons and missing validation — each with a screenshot, the steps it took and a test that reproduces it.</p>
        </Empty>
      </div>
    );
  }
  const bySeverity = QA_SEVERITIES.map((sev) => ({ sev, items: open.filter((f) => f.severity === sev) })).filter((g) => g.items.length > 0);
  return (
    <div className="space-y-4">
      {form}
      {bySeverity.map(({ sev, items }) => (
        <section key={sev} data-qa-severity-group={sev} className="space-y-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-gray-400">{sev} · {items.length}</h3>
          {items.map((f) => (
            <article key={f.id} data-qa-finding={f.id} className={`${CARD} space-y-3`}>
              <div className="flex items-start gap-3 flex-wrap">
                <SeverityPill severity={f.severity} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-100">{f.title}</div>
                  <div className="text-[12px] text-gray-400 font-mono">{f.page}{f.kind ? ` · ${f.kind}` : ''}</div>
                </div>
                {f.seenCount > 1 && <span data-qa-seen={f.seenCount} className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[12px] text-gray-300">seen {f.seenCount}×</span>}
              </div>
              {f.detail && <p className="text-[14px] text-gray-300 whitespace-pre-wrap">{f.detail}</p>}
              <div className="flex gap-4 flex-col md:flex-row">
                {f.steps.length > 0 && (
                  <div className="flex-1">
                    <div className="text-[12px] text-gray-500 mb-1">Steps taken</div>
                    <ol className="list-decimal pl-5 text-[13px] text-gray-300 space-y-0.5">{f.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  </div>
                )}
                {f.screenshot && (
                  <a href={evidenceUrl(f.runId, f.screenshot)} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={evidenceUrl(f.runId, f.screenshot)} alt={`Screenshot: ${f.title}`} className="w-56 rounded-[10px] border border-white/[0.1]" />
                  </a>
                )}
              </div>
              {f.sentences.length > 0 && (
                <div>
                  <div className="text-[12px] text-gray-500 mb-1">Reproduction test</div>
                  <SentenceList sentences={f.sentences} />
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <button className={BTN_GHOST} onClick={() => onDismiss(f)}>Dismiss</button>
                {f.reproTestId
                  ? <span className="h-10 px-3 inline-flex items-center text-[13px] text-emerald-300">In Tests ✓</span>
                  : <button className={BTN_PRIMARY} disabled={f.sentences.length === 0} onClick={() => onAddTest(f)}>Add as test</button>}
              </div>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
