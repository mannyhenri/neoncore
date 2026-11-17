/**
 * WHERE A TASK-LIST RUN HAS GOT TO — and, when it stops with tasks open, the choice that is yours.
 *
 * Task-list runs (Confer, Epic: Task by Task, Epic: Two Repos, CE Develop and Optimize) keep a
 * progress document in the repo (`docs/progress/<ID>.md`) and the server keeps its own record of
 * every dispatch claim and coverage check (server lib/run-progress.ts). This shows both: a one-line
 * strip on the run card, and a window with the document, the record, and — when the run is holding
 * because a pass finished nothing more — "Keep working" / "Accept as is". No autonomy level makes
 * that choice, so it has to be reachable wherever the run is.
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import type { Workflow, WorkflowProgress } from '../types';
import { progressLine, coverageVerb } from '../lib/runProgress';
import { useEscapeKey } from '../hooks/useEscapeKey';

/** The tasks-still-open choice. Used on the run card, in the progress window and on a Goal Pilot stage. */
export function CoverageChoice({ workflowId, stepId, detail, onDone, compact }: {
  workflowId: string;
  stepId: string;
  detail?: string;
  onDone?: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (action: 'continue' | 'accept') => {
    setBusy(true);
    setError('');
    try {
      await api.resolveCoverage(workflowId, stepId, action);
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally { setBusy(false); }
  };
  return (
    <div className={compact ? 'flex items-center gap-1.5' : 'space-y-2 rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2'}>
      {!compact && detail && <p className="text-[12px] text-amber-200/90">{detail}</p>}
      <div className="flex items-center gap-1.5">
        <button
          disabled={busy}
          onClick={() => act('continue')}
          title="Send the run back to the work on the tasks that are still open"
          className="text-[11px] px-2 py-1 rounded border border-emerald-600/60 text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-40"
        >
          Keep working
        </button>
        <button
          disabled={busy}
          onClick={() => act('accept')}
          title="Let the run go on with those tasks still open — it will say so"
          className="text-[11px] px-2 py-1 rounded border border-red-700/50 text-red-300 hover:bg-red-900/20 disabled:opacity-40"
        >
          Accept as is
        </button>
      </div>
      {error && <p className="text-[11px] text-red-300">{error}</p>}
    </div>
  );
}

/** The window: the progress document, the engine's record, and the choice when the run holds. */
export function RunProgressModal({ workflowId, title, onClose }: { workflowId: string; title: string; onClose: () => void }) {
  const [data, setData] = useState<WorkflowProgress | null>(null);
  const [run, setRun] = useState<Workflow | null>(null);
  const [error, setError] = useState('');
  useEscapeKey(onClose);

  const load = useCallback(() => {
    api.getWorkflowProgress(workflowId).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Could not load progress.'));
    api.getWorkflow(workflowId).then(setRun).catch(() => {});
  }, [workflowId]);
  useEffect(() => { load(); }, [load]);

  const hold = run?.needsAttention?.reason === 'tasks-outstanding' ? run.needsAttention : null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[760px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Run progress"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div className="min-w-0">
            <div className="text-sm text-gray-200 font-medium truncate">Progress — {title}</div>
            <div className="text-[12px] text-gray-500">{data?.summary ? progressLine(data.summary) : 'No tasks recorded yet'}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="text-[12px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-white/5">Refresh</button>
            <button onClick={onClose} className="text-gray-500 hover:text-white text-lg" aria-label="Close">&times;</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <p className="text-[12px] text-red-300">{error}</p>}
          {hold && (
            <CoverageChoice workflowId={workflowId} stepId={hold.stepId} detail={hold.detail} onDone={load} />
          )}

          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wider text-gray-500">Progress document</h3>
            {!data?.doc ? (
              <p className="text-[12px] text-gray-600">This run has not named a progress document yet.</p>
            ) : (
              <>
                <p className="text-[12px] text-gray-400 font-mono break-all">{data.doc.path}</p>
                {data.doc.content !== null ? (
                  <div className="prose prose-invert prose-sm max-w-none bg-black/30 rounded-md p-3 overflow-x-auto">
                    <Markdown remarkPlugins={[remarkGfm]}>{data.doc.content}</Markdown>
                  </div>
                ) : (
                  <p className="text-[12px] text-amber-300/80">{data.doc.unavailable}</p>
                )}
              </>
            )}
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[11px] uppercase tracking-wider text-gray-500">What the engine saw</h3>
            {!data || data.events.length === 0 ? (
              <p className="text-[12px] text-gray-600">Nothing yet.</p>
            ) : (
              <ol className="space-y-1">
                {data.events.map((e, i) => (
                  <li key={i} className="text-[12px] text-gray-300 flex gap-2">
                    <span className="text-gray-600 font-mono shrink-0">{e.at.slice(11, 16)}</span>
                    {e.kind === 'task' ? (
                      <span>
                        <span className={e.verdict === 'DONE' ? 'text-emerald-300' : e.verdict === 'BLOCKED' ? 'text-red-300' : 'text-amber-300'}>{e.verdict}</span>
                        {' '}<span className="font-mono">{e.taskId}</span>
                        {e.remaining !== null && <span className="text-gray-500"> · {e.remaining} remaining</span>}
                      </span>
                    ) : (
                      <span>
                        <span className="text-sky-300">Coverage {e.done ?? '?'}/{e.total ?? '?'}</span>
                        <span className="text-gray-400"> — {coverageVerb(e.verdict)}</span>
                        {e.detail && <span className="block text-gray-500 whitespace-pre-wrap">{e.detail}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The run card's strip: the count, a Progress button, and the choice when the run holds. */
export function RunProgressStrip({ wf, onAction }: { wf: Workflow; onAction?: () => void }) {
  const [open, setOpen] = useState(false);
  const hold = wf.needsAttention?.reason === 'tasks-outstanding' ? wf.needsAttention : null;
  if (!wf.progress && !hold) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px]">
        {wf.progress && <span className="text-gray-300">{progressLine(wf.progress)}</span>}
        <button onClick={() => setOpen(true)} className="text-sky-300 hover:text-sky-200 px-1.5 py-0.5 rounded hover:bg-white/5">
          Progress
        </button>
      </div>
      {hold && <CoverageChoice workflowId={wf.id} stepId={hold.stepId} detail={hold.detail} onDone={onAction} />}
      {open && <RunProgressModal workflowId={wf.id} title={wf.name} onClose={() => { setOpen(false); onAction?.(); }} />}
    </div>
  );
}
