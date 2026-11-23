/**
 * JOURNEYS — the Recorder. A staging app includes the recorder script; NeonCore groups the
 * sessions into journeys, ranks them by how often they happen, shows which have a test, and turns
 * the top ones into plain-language tests.
 */
import { useState } from 'react';
import { recorderSnippet } from '../../lib/qaApi';
import type { QaJourneys, QaTarget } from './types';
import { BTN_GHOST, BTN_PRIMARY, CARD, Empty, Loading } from './ui';
import { QaArt } from './art';

export function RecorderSnippet({ target, origin }: { target: QaTarget; origin: string }) {
  const snippet = recorderSnippet(origin, target.id, target.recorderKey ?? '');
  const [copied, setCopied] = useState(false);
  return (
    <div data-qa-snippet className={`${CARD} space-y-3`}>
      <div className="flex items-start gap-4">
        <QaArt name="module-recorder" className="w-20 shrink-0 hidden md:block" />
        <div className="flex-1 space-y-2 min-w-0">
          <div className="font-semibold text-gray-100">Record a staging app</div>
          <p className="text-[13px] text-gray-400">Paste this into the staging app's page. Use it on staging with consenting internal users only — never production customers.</p>
          <pre className="rounded-[10px] bg-gl-code border border-white/[0.08] p-2.5 font-mono text-[12px] text-gray-200 overflow-x-auto">{snippet}</pre>
          <ul className="text-[12px] text-gray-400 list-disc pl-5 space-y-0.5">
            <li>Password fields are never recorded.</li>
            <li>Fields marked <code className="font-mono text-gray-300">data-qa-sensitive</code> are never recorded.</li>
            <li>Typed text is masked by default; only fields marked <code className="font-mono text-gray-300">data-qa-record</code> keep what was typed.</li>
          </ul>
        </div>
        <button className={BTN_GHOST} onClick={() => { void navigator.clipboard?.writeText(snippet).then(() => setCopied(true)).catch(() => {}); }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

export function JourneysTab({ data, target, origin, busy, onGenerate }: {
  data: QaJourneys | undefined;
  target: QaTarget;
  origin: string;
  busy?: boolean;
  onGenerate: () => Promise<void> | void;
}) {
  const snippet = <RecorderSnippet target={target} origin={origin} />;
  if (data === undefined) return <div className="space-y-4">{snippet}<Loading what="journeys" /></div>;
  if (data.journeys.length === 0) {
    return (
      <div className="space-y-4">
        <Empty art="empty-journeys" title="No journeys recorded yet">
          <p>Once the recorder is in a staging app, sessions show up here grouped into journeys — the paths people actually take — ranked by how often they happen.</p>
        </Empty>
        {snippet}
      </div>
    );
  }
  const { covered, total } = data.coverage;
  const uncovered = data.journeys.filter((j) => !j.covered).length;
  return (
    <div className="space-y-4">
      <div className={`${CARD} flex items-center gap-4 flex-wrap`}>
        <div>
          <div className="font-display text-2xl text-gray-100" data-qa-coverage={`${covered}/${total}`}>{covered}/{total}</div>
          <div className="text-[12px] text-gray-400">journeys with a test · {data.sessions} session{data.sessions === 1 ? '' : 's'} recorded</div>
        </div>
        <div className="flex-1 flex gap-1 min-w-[160px]" aria-hidden="true">
          {data.journeys.map((j) => <span key={j.sig} className={`h-2.5 flex-1 rounded-sm ${j.covered ? 'seg-on bg-emerald-400/80' : 'seg-off border border-white/[0.16]'}`} />)}
        </div>
        <button className={BTN_PRIMARY} disabled={busy || uncovered === 0} onClick={() => onGenerate()}>Generate tests{uncovered > 0 ? ` (${uncovered})` : ''}</button>
      </div>
      <ol className="space-y-2">
        {data.journeys.map((j, i) => (
          <li key={j.sig} data-qa-journey={j.sig} data-qa-covered={j.covered ? 'yes' : 'no'} className={`${CARD} flex gap-3 items-start`}>
            <span className="font-display text-lg text-gray-500 w-7 text-right">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-gray-300 font-mono break-words">{j.steps.join(' → ')}</div>
              <div className="text-[12px] text-gray-500 mt-1">{j.count} session{j.count === 1 ? '' : 's'}</div>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${j.covered ? 'bg-emerald-500/15 text-emerald-200' : 'bg-ember-500/15 text-ember-300'}`}>{j.covered ? 'Has a test' : 'No test'}</span>
          </li>
        ))}
      </ol>
      {snippet}
    </div>
  );
}
