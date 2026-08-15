/**
 * REVIEW AND ACCEPT a proposed decomposition (GOAL-042).
 *
 * A cartridge proposes projects and tasks; the user picks what becomes real. Accepting here is
 * heavier than accepting a goal-intent draft: these rows get dispatched to cartridges that
 * change repositories, so the selection is explicit, per item, and nothing is ticked by default
 * except on an initial "select all" the user can immediately clear.
 *
 * Two rules the UI has to carry rather than leave to the server:
 *  - A task cannot be created without its project. Unticking a project visibly disables its
 *    tasks, so the constraint is legible before submit instead of arriving as a "skipped" list.
 *  - What validation DROPPED is shown, not swallowed. A silently truncated plan presented as
 *    the model's actual output is the worst possible failure in a review surface.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api';
import type { Goal, GoalDecomposition, Agent } from '../types';

/**
 * The goal fields a plan is grounded in. Mirrors the INTENT block of the decomposition prompt,
 * so the warning appears exactly when that block would be replaced by "THIS GOAL STATES NO
 * INTENT" — the UI and the prompt must agree about what "empty" means.
 */
const INTENT_KEYS = ['description', 'acceptanceCriteria', 'noGos', 'rabbitHoles', 'invariants'];

const SIZE_TONE: Record<string, string> = {
  S: 'text-emerald-400/80',
  M: 'text-gray-500',
  L: 'text-amber-300/80',
};

export function GoalDecomposePanel({
  goal, agents, onAccepted, onClose,
}: {
  goal: Goal;
  agents: Agent[];
  onAccepted: () => void;
  onClose: () => void;
}) {
  const [seed, setSeed] = useState('');
  const [agentId, setAgentId] = useState('');
  const [dec, setDec] = useState<GoalDecomposition | null>(null);
  const [pickedProjects, setPickedProjects] = useState<Set<string>>(new Set());
  const [pickedTasks, setPickedTasks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ createdProjects: number; createdTasks: number; createdRuns: number; skipped: string[] } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    api.getDecompositions(goal.id)
      .then((ds) => {
        const live = ds.find((d) => !d.acceptedAt && (d.status === 'pending' || d.status === 'ready'));
        if (live) setDec(live);
      })
      .catch(() => {});
  }, [goal.id]);

  // Planning takes minutes — the cartridge has to read the repo before it can propose anything.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!dec || dec.status !== 'pending') return;
    pollRef.current = setInterval(() => {
      api.getDecomposition(dec.id).then(setDec).catch(() => {});
    }, 5000);
    return () => clearInterval(pollRef.current);
  }, [dec?.id, dec?.status]);

  // Default to everything selected once a plan arrives: the common case is accepting most of
  // it, and "select all then untick" is less work than ticking twenty boxes.
  useEffect(() => {
    if (dec?.status !== 'ready') return;
    setPickedProjects(new Set(dec.proposal.projects.map((p) => p.key)));
    setPickedTasks(new Set(dec.proposal.projects.flatMap((p) => p.tasks.map((t) => t.key))));
  }, [dec?.id, dec?.status]);

  const online = agents.filter((a) => a.status !== 'offline');
  useEffect(() => { if (!agentId && online.length) setAgentId(online[0].id); }, [online, agentId]);

  const request = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const { decomposition, queued } = await api.requestDecomposition(goal.id, { seed, agentId });
      setDec(decomposition);
      if (queued) setError('The cartridge is busy — this is queued and will run when it frees up.');
    } catch (e) {
      setError((e as Error).message || 'could not reach the cartridge');
    } finally { setBusy(false); }
  }, [goal.id, seed, agentId]);

  const accept = useCallback(async () => {
    if (!dec) return;
    setBusy(true); setError('');
    try {
      const r = await api.acceptDecomposition(dec.id, [...pickedProjects], [...pickedTasks]);
      setResult(r);
      onAccepted();
    } catch (e) {
      setError((e as Error).message || 'could not create the work');
    } finally { setBusy(false); }
  }, [dec, pickedProjects, pickedTasks, onAccepted]);

  const toggleProject = (key: string, tasks: string[]) => {
    const next = new Set(pickedProjects);
    const nextTasks = new Set(pickedTasks);
    if (next.has(key)) {
      next.delete(key);
      // Its tasks have nowhere to live, so drop them with it rather than silently skipping.
      tasks.forEach((t) => nextTasks.delete(t));
    } else {
      next.add(key);
      tasks.forEach((t) => nextTasks.add(t));
    }
    setPickedProjects(next);
    setPickedTasks(nextTasks);
  };

  const chosenTaskCount = pickedTasks.size;

  // ── after acceptance ────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="space-y-4">
        <div className="px-3 py-2.5 rounded-lg bg-emerald-900/20 border border-emerald-700/40">
          <p className="text-[13px] text-emerald-200 font-medium">
            Created {result.createdProjects} {result.createdProjects === 1 ? 'project' : 'projects'} and{' '}
            {result.createdTasks} {result.createdTasks === 1 ? 'task' : 'tasks'}.
          </p>
          {result.createdRuns > 0 && (
            <p className="text-[13px] text-emerald-200 font-medium">
              Started {result.createdRuns} {result.createdRuns === 1 ? 'workflow' : 'workflows'}.
            </p>
          )}
          <p className="text-[12px] text-emerald-200/70 mt-1">
            Tasks are queued in dependency order — prerequisites run first. Your setup answers
            travel with every one of them.
          </p>
        </div>
        {result.skipped.length > 0 && (
          <div>
            <h4 className="text-[11px] text-amber-300/80 uppercase tracking-wider mb-1">Skipped</h4>
            <ul className="text-[12px] text-gray-400 space-y-0.5">
              {result.skipped.map((s, i) => <li key={i}>· {s}</li>)}
            </ul>
          </div>
        )}
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 rounded-md transition-colors font-medium">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(!dec || dec.status === 'failed') && (
        <>
          <p className="text-[12px] text-gray-500 leading-relaxed">
            A cartridge reads the repository and proposes projects and tasks for this goal. It
            produces a <em>plan</em>: nothing is created until you pick the items you want.
          </p>

          {/* The plan is only as good as what the goal commits to. With no intent the cartridge
              has a name, your seed, and the repo — so it will either push back or guess, and
              guessing is expensive here because every proposed task becomes a dispatch. Warn
              rather than block: a name plus a good seed is a legitimate way to work. */}
          {INTENT_KEYS.every((k) => !String((goal as unknown as Record<string, unknown>)[k] ?? '').trim()) && (
            <div className="px-3 py-2 rounded-lg bg-amber-900/20 border border-amber-700/40">
              <p className="text-[12px] text-amber-200">
                This goal states no intent — no reason, acceptance criteria, no-gos or invariants.
              </p>
              <p className="text-[11px] text-amber-200/70 mt-1">
                The plan will be built from its name, whatever you write below, and the repo. Fill
                in the intent first (“Help me write this”) for a plan grounded in what you actually
                want, or give it real context here.
              </p>
            </div>
          )}
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
              Anything to steer it? (optional)
            </label>
            <textarea
              value={seed} onChange={(e) => setSeed(e.target.value)} rows={3}
              placeholder="Where to start, what to leave alone, constraints it cannot read from the goal. It already receives the goal's intent, no-gos and rabbit holes."
              className="w-full bg-black/30 border border-white/10 rounded-md px-3 py-2 text-[13px] text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-violet-500/50"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Which cartridge</label>
            <select
              value={agentId} onChange={(e) => setAgentId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-md px-3 py-2 text-[13px] text-gray-200 focus:outline-none focus:border-violet-500/50"
            >
              {online.length === 0 && <option value="">No cartridge is online</option>}
              {online.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.repoName} ({a.status})</option>)}
            </select>
            <p className="text-[11px] text-gray-600 mt-1">
              Pick one that can see the code this goal is about — a plan written without reading
              the repo names files that do not exist.
            </p>
          </div>
          {dec?.status === 'failed' && dec.error && (
            <p className="text-[12px] text-red-400">Planning failed: {dec.error}</p>
          )}
        </>
      )}

      {dec?.status === 'pending' && (
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-violet-900/20 border border-violet-700/40">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse flex-shrink-0" />
          <p className="text-[12px] text-violet-200">
            Planning… the cartridge is reading the repo. You can close this and come back.
          </p>
        </div>
      )}

      {dec?.status === 'ready' && (
        <>
          {/* What validation changed. Never swallowed — a truncated plan shown as the model's
              own output would make review meaningless. */}
          {dec.notes.length > 0 && (
            <div className="px-3 py-2 rounded-lg bg-amber-900/15 border border-amber-700/30">
              <h4 className="text-[11px] text-amber-300/90 uppercase tracking-wider mb-1">
                Adjusted on arrival
              </h4>
              <ul className="text-[11px] text-amber-200/70 space-y-0.5">
                {dec.notes.map((nt, i) => <li key={i}>· {nt}</li>)}
              </ul>
            </div>
          )}

          <p className="text-[12px] text-gray-500">
            {dec.proposal.projects.length} {dec.proposal.projects.length === 1 ? 'project' : 'projects'} proposed.
            Untick anything you do not want — a task cannot be created without its project.
          </p>

          <div className="space-y-3">
            {dec.proposal.projects.map((p) => {
              const on = pickedProjects.has(p.key);
              return (
                <div
                  key={p.key}
                  className={`rounded-lg border p-3 transition-colors ${
                    on ? 'bg-violet-900/12 border-violet-700/40' : 'bg-white/[0.02] border-white/[0.08]'
                  }`}
                >
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox" checked={on} className="mt-1 accent-violet-500"
                      onChange={() => toggleProject(p.key, p.tasks.map((t) => t.key))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-gray-100">{p.name}</div>
                      {p.description && <p className="text-[12px] text-gray-500 mt-0.5">{p.description}</p>}
                      {p.primaryRepo && (
                        <p className="text-[11px] text-gray-600 mt-0.5 font-mono truncate">{p.primaryRepo}</p>
                      )}
                    </div>
                  </label>

                  {p.tasks.length > 0 && (
                    <div className={`mt-2 pl-6 space-y-1 ${on ? '' : 'opacity-40 pointer-events-none'}`}>
                      {p.tasks.map((t) => (
                        <label key={t.key} className="flex items-start gap-2 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={pickedTasks.has(t.key)}
                            disabled={!on}
                            onChange={() => {
                              const next = new Set(pickedTasks);
                              next.has(t.key) ? next.delete(t.key) : next.add(t.key);
                              setPickedTasks(next);
                            }}
                            className="mt-1 accent-violet-500"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[12px] text-gray-300">{t.title}</span>
                              {/* A template-backed item launches a whole workflow rather than
                                  creating a one-shot task — a materially different thing to
                                  accept, so it is labelled rather than left to look identical. */}
                              {t.template && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-violet-900/40 border border-violet-700/40 text-violet-300"
                                  title={`Accepting this runs the "${t.template}" workflow against the project, not a single task`}
                                >
                                  ⇉ {t.template}
                                </span>
                              )}
                              <span className={`text-[10px] ${SIZE_TONE[t.size] || 'text-gray-500'}`}>{t.size}</span>
                              {t.dependsOn.length > 0 && (
                                <span className="text-[10px] text-gray-600" title={`Runs after: ${t.dependsOn.join(', ')}`}>
                                  after {t.dependsOn.join(', ')}
                                </span>
                              )}
                            </div>
                            {t.prompt && t.prompt !== t.title && (
                              <details className="mt-0.5">
                                <summary className="text-[10px] text-gray-600 cursor-pointer hover:text-gray-400">
                                  What the cartridge will be told
                                </summary>
                                <p className="text-[11px] text-gray-500 mt-1 whitespace-pre-wrap pl-2 border-l border-white/10">
                                  {t.prompt}
                                </p>
                              </details>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
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
        {dec?.status === 'ready' ? (
          <button
            onClick={accept}
            disabled={busy || pickedProjects.size === 0}
            className="px-3 py-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors font-medium"
          >
            {pickedProjects.size === 0
              ? 'Select at least one project'
              : `Create ${pickedProjects.size} ${pickedProjects.size === 1 ? 'project' : 'projects'}, ${chosenTaskCount} ${chosenTaskCount === 1 ? 'task' : 'tasks'}`}
          </button>
        ) : dec?.status === 'pending' ? null : (
          <button
            onClick={request}
            disabled={busy || !agentId}
            className="px-3 py-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors font-medium"
          >
            {busy ? 'Sending…' : 'Plan the work'}
          </button>
        )}
      </div>
    </div>
  );
}
