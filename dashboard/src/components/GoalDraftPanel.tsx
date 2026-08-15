/**
 * DRAFT AND APPROVE. The user reviews generated intent field by field.
 *
 * The intent fields are not notes — `goal-brief.ts` injects them into every prompt dispatched
 * under this goal, so accepting one is closer to writing a standing instruction than to filling
 * in a form. That is why this is per-field with the current value shown beside the proposal,
 * rather than a single "apply draft" button: accepting a good acceptance-criteria block must
 * never smuggle in a no-gos section nobody read.
 *
 * Nothing here writes to the goal except the explicit accept. Requesting a draft, receiving
 * one, and closing this panel all leave the goal byte-identical — enforced server-side and
 * asserted in test/goal-draft.test.ts.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import type { Goal, GoalDraft, DraftableField, Agent } from '../types';

type KeyResultish = { metric: string; baseline?: string; target?: string; measure?: string };

/** Render a proposed value, whichever shape it is. */
function ValueBlock({ value, muted }: { value: unknown; muted?: boolean }) {
  const cls = `text-[12px] whitespace-pre-wrap leading-relaxed ${muted ? 'text-gray-500' : 'text-gray-200'}`;
  if (Array.isArray(value)) {
    return (
      <div className="space-y-1">
        {(value as KeyResultish[]).map((kr, i) => (
          <div key={i} className={cls}>
            {kr.metric}
            {kr.baseline && <span className="text-gray-500"> · from {kr.baseline}</span>}
            {kr.target && <span className="text-emerald-400/80"> → {kr.target}</span>}
            {kr.measure && <span className="text-gray-500"> ({kr.measure})</span>}
          </div>
        ))}
      </div>
    );
  }
  const s = typeof value === 'string' ? value : '';
  if (!s) return <p className="text-[12px] text-gray-600 italic">empty</p>;
  return <p className={cls}>{s}</p>;
}

/** What the goal currently holds for a drafted key, for the side-by-side. */
function currentValue(goal: Goal, key: string): unknown {
  const v = (goal as unknown as Record<string, unknown>)[key];
  if (key === 'keyResults') return Array.isArray(v) ? v : [];
  return typeof v === 'string' ? v : '';
}

export function GoalDraftPanel({
  goal, agents, onApplied, onClose,
}: {
  goal: Goal;
  agents: Agent[];
  onApplied: (goal: Goal) => void;
  onClose: () => void;
}) {
  const [fieldsMeta, setFieldsMeta] = useState<DraftableField[]>([]);
  const [seed, setSeed] = useState('');
  const [agentId, setAgentId] = useState('');
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    api.getDraftableFields().then(setFieldsMeta).catch(() => {});
    // Surface a draft already in flight for this goal, so reopening the panel after a reload
    // does not silently start a second one.
    api.getGoalDrafts(goal.id)
      .then((ds) => {
        const live = ds.find((d) => !d.appliedAt && (d.status === 'pending' || d.status === 'ready'));
        if (live) setDraft(live);
      })
      .catch(() => {});
  }, [goal.id]);

  // A cartridge takes minutes, not milliseconds — there is no synchronous answer to wait on.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!draft || draft.status !== 'pending') return;
    pollRef.current = setInterval(() => {
      api.getGoalDraft(draft.id).then(setDraft).catch(() => {});
    }, 4000);
    return () => clearInterval(pollRef.current);
  }, [draft?.id, draft?.status]);

  const idle = agents.filter((a) => a.status !== 'offline');
  useEffect(() => {
    if (!agentId && idle.length) setAgentId(idle[0].id);
  }, [idle, agentId]);

  const request = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const { draft: d, queued } = await api.requestGoalDraft({ goalId: goal.id, seed, agentId });
      setDraft(d);
      if (queued) setError('The cartridge is busy — this is queued and will run when it frees up.');
    } catch (e) {
      setError((e as Error).message || 'could not reach the cartridge');
    } finally {
      setBusy(false);
    }
  }, [goal.id, seed, agentId]);

  const accept = useCallback(async () => {
    if (!draft || chosen.size === 0) return;
    setBusy(true); setError('');
    try {
      const { goal: updated } = await api.applyGoalDraft(draft.id, [...chosen]);
      onApplied(updated);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'could not apply');
    } finally {
      setBusy(false);
    }
  }, [draft, chosen, onApplied, onClose]);

  const proposed = draft?.status === 'ready'
    ? fieldsMeta.filter((f) => draft.fields[f.key] !== undefined)
    : [];

  return (
    <div className="space-y-4">
      {/* Ask */}
      {(!draft || draft.status === 'failed') && (
        <>
          <p className="text-[12px] text-gray-500 leading-relaxed">
            A cartridge drafts the intent — outcome, acceptance criteria, no-gos, invariants,
            key results — from a sentence or two of context. It produces a <em>proposal</em>:
            nothing reaches this goal until you accept it field by field.
          </p>
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
              What is this goal about?
            </label>
            <textarea
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              rows={4}
              placeholder="A sentence or two. What outcome do you want, and why now? The more concrete you are, the less the assistant has to guess — and it is told to leave fields blank rather than invent them."
              className="w-full bg-black/30 border border-white/10 rounded-md px-3 py-2 text-[13px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-violet-500/50"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
              Which cartridge
            </label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-md px-3 py-2 text-[13px] text-gray-200 focus:outline-none focus:border-violet-500/50"
            >
              {idle.length === 0 && <option value="">No cartridge is online</option>}
              {idle.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.repoName} ({a.status})
                </option>
              ))}
            </select>
            <p className="text-[11px] text-gray-600 mt-1">
              Drafting runs on a cartridge, so its cost is attributed to this goal like any other
              work. If the cartridge is busy the request queues behind what it is doing.
            </p>
          </div>
        </>
      )}

      {draft?.status === 'pending' && (
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-violet-900/20 border border-violet-700/40">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse flex-shrink-0" />
          <p className="text-[12px] text-violet-200">
            Drafting… the cartridge submits when it is done. You can close this and come back.
          </p>
        </div>
      )}

      {draft?.status === 'failed' && draft.error && (
        <p className="text-[12px] text-red-400">Draft failed: {draft.error}</p>
      )}

      {/* Review */}
      {draft?.status === 'ready' && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] text-gray-500">
              {proposed.length} {proposed.length === 1 ? 'field' : 'fields'} proposed. Tick what
              you want to keep — nothing is applied by default.
            </p>
            <button
              onClick={() => setChosen(new Set(chosen.size === proposed.length ? [] : proposed.map((f) => f.key)))}
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors flex-shrink-0"
            >
              {chosen.size === proposed.length ? 'Clear all' : 'Select all'}
            </button>
          </div>

          <div className="space-y-3">
            {proposed.map((f) => {
              const cur = currentValue(goal, f.key);
              const hasCurrent = Array.isArray(cur) ? cur.length > 0 : !!cur;
              const on = chosen.has(f.key);
              return (
                <div
                  key={f.key}
                  className={`rounded-lg border p-3 transition-colors ${
                    on ? 'bg-violet-900/15 border-violet-700/40' : 'bg-white/[0.02] border-white/[0.08]'
                  }`}
                >
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const next = new Set(chosen);
                        on ? next.delete(f.key) : next.add(f.key);
                        setChosen(next);
                      }}
                      className="mt-0.5 accent-violet-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] font-medium text-gray-200">{f.label}</span>
                        {hasCurrent && (
                          <span className="text-[10px] text-amber-300/80" title="Accepting replaces what is there now">
                            replaces existing
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-600 mt-0.5">{f.guidance}</p>

                      <div className="mt-2">
                        <ValueBlock value={draft.fields[f.key]} />
                      </div>

                      {/* The current value, so "replaces existing" is a fact you can check
                          rather than a warning you have to trust. */}
                      {hasCurrent && (
                        <details className="mt-2">
                          <summary className="text-[11px] text-gray-600 cursor-pointer hover:text-gray-400">
                            Currently
                          </summary>
                          <div className="mt-1 pl-2 border-l border-white/10">
                            <ValueBlock value={cur} muted />
                          </div>
                        </details>
                      )}
                    </div>
                  </label>
                </div>
              );
            })}
          </div>
        </>
      )}

      {error && <p className="text-[12px] text-amber-300">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 border border-white/10 hover:border-white/20 rounded-md transition-colors"
        >
          Close
        </button>
        {draft?.status === 'ready' ? (
          <button
            onClick={accept}
            disabled={busy || chosen.size === 0}
            className="px-3 py-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors font-medium"
          >
            {chosen.size === 0 ? 'Select fields to accept' : `Accept ${chosen.size} ${chosen.size === 1 ? 'field' : 'fields'}`}
          </button>
        ) : draft?.status === 'pending' ? null : (
          <button
            onClick={request}
            disabled={busy || !agentId}
            className="px-3 py-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors font-medium"
          >
            {busy ? 'Sending…' : 'Draft it'}
          </button>
        )}
      </div>
    </div>
  );
}
