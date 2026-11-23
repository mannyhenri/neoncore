/**
 * THE FEATURE PIPELINE (the goal pilot) — one feature of a project, run as a managed pipeline of
 * agents and workflows. A feature is a goal row filed under a project (see ProjectsPage.tsx).
 *
 *   Feature → Scope → Workflows → Repos → Run
 *
 * 1. FEATURE     the general questions (GoalPilotIntake). Creates the feature, or starts one from the list.
 * 2. SCOPE       a planner cartridge asks what is still open; the person answers, delegates, or
 *                accepts suggestions — as many rounds as the planner needs.
 * 3. WORKFLOWS   the planner's scope brief and proposed workflows, editable, accepted explicitly.
 * 4. REPOS       which of the project's repos (and which engine in each) execute it, and which stage runs where.
 * 5. RUN         the stages run in order; anything that needs the person says so here.
 *
 * The planner is a CARTRIDGE, like every other piece of generated text in NeonCore: the server
 * dispatches the request and the cartridge answers through MCP, so planner steps take as long as
 * the cartridge takes. The panel polls while it waits and listens for `goal_pilot_updated`.
 * Rules (what is required, what a delegation means) live on the server; lib/goalPilot.ts mirrors
 * them only so the panel can say what is missing before a request is refused.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoverageChoice, RunProgressModal } from './RunProgress';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import { WorkflowCanvasEditor } from './WorkflowCanvasEditor';
import { DatePicker } from './DatePicker';
import type { Agent, Goal, GoalPilot, GoalPilotMeta, PilotAnswer, PilotBrief, PilotCandidateRepo, PilotQuestion, PilotStage } from '../types';
import {
  PILOT_STEPS, stepIndexFor, isLivePilot, waitingOnPlanner, suggestionFor, missingRequired, acceptSuggestions,
  answerLabel, moveItem, draftStagesFrom, includedStages, plannerCandidates, defaultEngine, engineStatus,
  resolveAssignments, resolveTeams, intakeFromGoal, STAGE_TONE, STAGE_ICON, since, pipelineSummary, type DraftStage,
  draftCriteriaFrom, criteriaProblems, type DraftCriterion,
} from '../lib/goalPilot';

import { ENGINE_LABEL, input, primaryBtn, quietBtn, dangerBtn, errorText } from './pilotStyles';
import { CriteriaEditor, ContractCard } from './AcceptanceContractPanel';
import { AiWorkingBar } from './SectionTitle';
import { useAttachments, AttachmentList, fileToPayload, MAX_TOTAL_BYTES } from './AttachmentPicker';
import type { FeatureFile } from '../types';

let metaCache: Promise<GoalPilotMeta> | null = null;
/** The registries barely change; one fetch per page load is enough. */
function loadMeta(): Promise<GoalPilotMeta> {
  if (!metaCache) metaCache = api.getGoalPilotMeta().catch((e) => { metaCache = null; throw e; });
  return metaCache;
}

function useMeta(): GoalPilotMeta | null {
  const [meta, setMeta] = useState<GoalPilotMeta | null>(null);
  useEffect(() => { loadMeta().then(setMeta).catch(() => {}); }, []);
  return meta;
}

function Pill({ on, children, onClick, title }: { on: boolean; children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`text-[13px] font-semibold min-h-10 px-3.5 py-2 rounded-full border transition-colors text-left ${
        on ? 'bg-[rgba(124,108,255,0.2)] border-[#7C6CFF] text-[#E4DFFF]' : 'bg-transparent border-white/[0.18] text-gray-300 hover:text-gray-100 hover:border-white/30'
      }`}
    >
      {children}
    </button>
  );
}

function PlannerPicker({ agents, value, onChange, preferRepos }: { agents: Agent[]; value: string; onChange: (id: string) => void; preferRepos?: string[] }) {
  const options = plannerCandidates(agents, preferRepos);
  if (options.length === 0) {
    return (
      <p className="text-[13px] text-amber-300/90">
        No cartridge is online. The planner is a cartridge — launch one from the Agents view, then come back.
      </p>
    );
  }
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {ENGINE_LABEL[a.agentType] ?? a.agentType} · {a.repoName || a.name}{a.status === 'working' ? ' (busy — will queue)' : ''}
        </option>
      ))}
    </select>
  );
}

// ── 1. the general questions ───────────────────────────────────────────────────

/**
 * The guided feature form. With `goal`, starts a feature already on the list (its fields pre-fill
 * the answers); without, the answers create a new feature — in `projectId` when given.
 * `preferRepos` (the project's repos) puts the cartridges that can read the feature's code first
 * in the planner picker.
 */
export function GoalPilotIntake({ agents, goal, projectId, preferRepos, onCreated, onCancel }: {
  agents: Agent[];
  goal?: Goal;
  projectId?: string;
  preferRepos?: string[];
  onCreated: (goalId: string) => void;
  onCancel: () => void;
}) {
  const meta = useMeta();
  const [values, setValues] = useState<Record<string, string>>(() =>
    goal ? intakeFromGoal(goal) : { workType: 'feature', involvement: 'balanced' });
  const [planner, setPlanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const staged = useAttachments();
  // The project's repos this feature involves — all to start with; untick what it does not touch.
  const [repoPick, setRepoPick] = useState<Set<string>>(() => new Set(preferRepos ?? []));
  // Keyed on the list's contents: the parent rebuilds the array every render, and resetting on its
  // identity would undo every untick.
  const repoKey = (preferRepos ?? []).join('|');
  useEffect(() => { setRepoPick(new Set(repoKey ? repoKey.split('|') : [])); }, [repoKey]);

  const candidates = useMemo(() => plannerCandidates(agents, preferRepos), [agents, preferRepos]);
  useEffect(() => { if (!planner && candidates.length) setPlanner(candidates[0].id); }, [candidates, planner]);

  const missing = meta ? meta.intakeQuestions.filter((q) => q.required && !String(values[q.key] ?? '').trim()) : [];
  const set = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  const submit = async (replace = false) => {
    setBusy(true); setError('');
    try {
      // Sent with the request, so the planner's first scoping prompt already carries them.
      const files = staged.attachments.length ? await staged.encode() : undefined;
      const repos = (preferRepos ?? []).filter((r) => repoPick.has(r));
      const out = await api.createGoalPilot({ intake: values, plannerAgentId: planner, goalId: goal?.id, projectId: goal ? undefined : projectId, replace, files, repos });
      staged.clear();
      if (out.error) setError(`Created, but: ${out.error}`);
      onCreated(out.goalId);
    } catch (e) {
      const msg = errorText(e);
      if (/already has a pilot/.test(msg)) setConflict(true);
      setError(msg);
    } finally { setBusy(false); }
  };

  if (!meta) return <p className="text-[13px] text-gray-500">Loading…</p>;

  const optionalOpen = meta.intakeQuestions.some((q) => !q.required && String(values[q.key] ?? '').trim() !== '');
  const renderQuestion = (q: (typeof meta.intakeQuestions)[number]) => (
    <div key={q.key}>
      <label className="block text-[13px] text-gray-300 mb-1">
        {q.label}{q.required && <span className="text-violet-400"> *</span>}
      </label>
      {q.kind === 'textarea' ? (
        <textarea rows={3} className={input} placeholder={q.placeholder} value={values[q.key] ?? ''} onChange={(e) => set(q.key, e.target.value)} />
      ) : q.kind === 'choice' ? (
        <div className="flex flex-wrap gap-1.5">
          {q.options!.map((o) => (
            <Pill key={o.value} on={values[q.key] === o.value} onClick={() => set(q.key, o.value)} title={o.hint}>{o.label}</Pill>
          ))}
        </div>
      ) : q.kind === 'date' ? (
        <DatePicker value={values[q.key] ?? ''} onChange={(v) => set(q.key, v)} placeholder="No target date" />
      ) : (
        <input
          className={input}
          type={q.kind === 'number' ? 'number' : 'text'}
          min={q.kind === 'number' ? 0 : undefined}
          placeholder={q.placeholder}
          value={values[q.key] ?? ''}
          onChange={(e) => set(q.key, e.target.value)}
        />
      )}
      {q.kind === 'choice' && values[q.key]
        ? <p className="text-[12px] text-gray-500 mt-1">{q.options!.find((o) => o.value === values[q.key])?.hint}</p>
        : <p className="text-[12px] text-gray-500 mt-1">{q.help}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-500 leading-relaxed">
        A few questions about this feature. A planner cartridge then asks whatever is still needed so the
        agents never have to ask once work starts, proposes the workflows that will build it, and runs
        them in order in the project's repos once you accept. Nothing runs until you say so.
      </p>
      {/* The required questions up front; the optional ones one click away, opened by themselves
          when any of them already has an answer (a feature that carries a date or a budget). */}
      {meta.intakeQuestions.filter((q) => q.required).map(renderQuestion)}
      <details className="group rounded-xl border border-white/[0.08] bg-gl-code/60" open={optionalOpen}>
        <summary className="cursor-pointer select-none px-3.5 py-2.5 text-[13px] text-gray-300 hover:text-gray-100">
          More detail <span className="text-gray-500">— who it is for, what must not change, target date, budget (optional)</span>
        </summary>
        <div className="px-3.5 pb-3.5 space-y-4">
          {meta.intakeQuestions.filter((q) => !q.required).map(renderQuestion)}
        </div>
      </details>

      {(preferRepos?.length ?? 0) > 1 && (
        <div>
          <div className="block text-[13px] text-gray-300 mb-1">Which repos does this feature involve?</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {preferRepos!.map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-[13px] text-gray-300 cursor-pointer" title={r}>
                <input type="checkbox" className="accent-violet-500" checked={repoPick.has(r)}
                  onChange={() => setRepoPick((prev) => { const n = new Set(prev); if (n.has(r)) n.delete(r); else n.add(r); return n; })} />
                {r.split(/[\\/]/).pop()}
              </label>
            ))}
          </div>
          <p className="text-[12px] text-gray-500 mt-1">The planner scopes only these, and they are what the pipeline runs in (each on the feature's own branch).</p>
        </div>
      )}

      <div>
        <label className="block text-[13px] text-gray-300 mb-1">Files <span className="text-gray-500">(optional)</span></label>
        <FileDrop onFiles={staged.addFiles} label="Add mockups, specs, examples…" />
        <div className="mt-2"><AttachmentList attachments={staged.attachments} onRemove={staged.removeAttachment} /></div>
        {staged.error && <p className="text-[12px] text-amber-300 mt-1">{staged.error}</p>}
        <p className="text-[12px] text-gray-500 mt-1">
          Kept with the feature: the planner reads them while it scopes, and every stage of the pipeline gets a copy in its repo.
          You can add more at any point.
        </p>
      </div>

      <div>
        <label className="block text-[13px] text-gray-300 mb-1">Which cartridge does the planning?</label>
        <PlannerPicker agents={agents} value={planner} onChange={setPlanner} preferRepos={preferRepos} />
        <p className="text-[12px] text-gray-500 mt-1">
          It reads your answers (and the repo it is in) and submits questions, a brief and a pipeline back to NeonCore.
          Its spend counts toward this feature.
        </p>
      </div>

      {error && <p className="text-[13px] text-amber-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={quietBtn}>Cancel</button>
        {conflict && (
          <button onClick={() => submit(true)} disabled={busy} className={quietBtn} title="Cancel the pilot in progress and start a new one">
            Start over
          </button>
        )}
        <button
          onClick={() => submit(false)}
          disabled={busy || missing.length > 0 || !planner || ((preferRepos?.length ?? 0) > 1 && repoPick.size === 0)}
          className={primaryBtn}
          title={missing.length ? `Still needed: ${missing.map((m) => m.label).join(', ')}` : undefined}
        >
          {busy ? 'Sending…' : goal ? 'Start scoping' : 'Add feature & start scoping'}
        </button>
      </div>
    </div>
  );
}

// ── the feature's files ───────────────────────────────────────────────────────

/** A click-or-drop target for files. */
function FileDrop({ onFiles, label, disabled = false }: { onFiles: (files: File[]) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button" tabIndex={0} aria-label={label}
      onClick={() => !disabled && ref.current?.click()}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ref.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) onFiles(Array.from(e.dataTransfer.files)); }}
      className={`flex items-center justify-center rounded-xl border border-dashed px-3 py-3 text-[13px] cursor-pointer transition-colors
        ${over ? 'border-violet-400/70 bg-violet-500/10 text-violet-100' : 'border-white/15 text-gray-400 hover:text-gray-200 hover:border-white/25'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {label} <span className="text-gray-500 ml-1">— click or drop</span>
      <input ref={ref} type="file" multiple hidden onChange={(e) => { if (e.target.files) onFiles(Array.from(e.target.files)); e.target.value = ''; }} />
    </div>
  );
}

/**
 * The files kept with the feature — added here they reach the next request the planner gets and
 * every stage not yet started (each cartridge gets a copy in its own repo).
 */
export function FeatureFilesCard({ goalId }: { goalId: string }) {
  const [files, setFiles] = useState<FeatureFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.getFeatureFiles(goalId).then((f) => live && setFiles(f)).catch(() => live && setFiles([]));
    return () => { live = false; };
  }, [goalId]);
  const add = async (picked: File[]) => {
    if (!picked.length) return;
    const total = picked.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL_BYTES) { setErr('Add up to 20 MB at a time.'); return; }
    setBusy(true); setErr('');
    try { setFiles(await api.addFeatureFiles(goalId, await Promise.all(picked.map(fileToPayload)))); }
    catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const remove = async (f: FeatureFile) => {
    setErr('');
    try { await api.removeFeatureFile(goalId, f.id); setFiles((list) => (list ?? []).filter((x) => x.id !== f.id)); }
    catch (e) { setErr(errorText(e)); }
  };
  if (files === null) return null;
  return (
    <div className="rounded-xl border border-white/[0.08] bg-gl-code/60 px-3.5 py-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h4 className="text-[13px] text-gray-200">Files <span className="text-gray-500">— {files.length ? `${files.length} kept with this feature` : 'none yet'}</span></h4>
        <span className="text-[12px] text-gray-500">The planner and every stage get a copy in their repo.</span>
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded-lg bg-white/[0.08] px-2.5 py-1 text-[12px] text-gray-300">
              <span className="max-w-[200px] truncate" title={f.name}>{f.name}</span>
              <span className="text-gray-600">{Math.max(1, Math.ceil(f.size / 1024))} KB</span>
              <button type="button" onClick={() => remove(f)} className="text-gray-400 hover:text-gray-100" aria-label={`Remove ${f.name}`} title="Remove — later requests and stages no longer get it">×</button>
            </div>
          ))}
        </div>
      )}
      <FileDrop onFiles={add} disabled={busy} label={busy ? 'Uploading…' : 'Add files'} />
      {err && <p className="text-[12px] text-amber-300">{err}</p>}
    </div>
  );
}

// ── stepper ───────────────────────────────────────────────────────────────────

function Stepper({ pilot }: { pilot: GoalPilot }) {
  const at = stepIndexFor(pilot.phase);
  const finished = pilot.phase === 'completed';
  return (
    <ol aria-label="Pilot steps" className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
      {PILOT_STEPS.map((label, i) => {
        const done = i < at || finished;
        const here = i === at && !finished;
        return (
          <li
            key={label}
            aria-current={here ? 'step' : undefined}
            className={`flex items-center gap-2.5 h-11 px-3 rounded-[10px] border text-[14px] font-semibold ${
              here ? 'bg-[rgba(124,108,255,0.2)] border-[#7C6CFF] text-[#E4DFFF]' : 'bg-gl-code/60 border-white/[0.08] text-gray-300'
            }`}
          >
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] flex-shrink-0 ${
              done ? 'bg-emerald-400/20 text-emerald-300' : here ? 'bg-[#7C6CFF] text-[#0B0820]' : 'bg-white/[0.08] text-gray-400'
            }`}>{done ? '✓' : i + 1}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

// ── 2a. waiting on the planner ────────────────────────────────────────────────

function PlannerWait({ pilot, agents, onChanged }: { pilot: GoalPilot; agents: Agent[]; onChanged: () => void }) {
  const req = pilot.currentRequest;
  const failed = req?.status === 'failed';
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!other) setOther(pilot.plannerAgentId); }, [pilot.plannerAgentId, other]);

  const what = pilot.phase === 'planning'
    ? 'choosing the workflows that will deliver the scope'
    : pilot.rounds.length === 0 ? 'reading your answers and working out what still needs asking'
    : `reading your answers to round ${pilot.rounds.length}`;

  const retry = async () => {
    setBusy(true); setError('');
    try { await api.retryGoalPilot(pilot.id, other || undefined); onChanged(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const showPrompt = async () => {
    if (!req) return;
    if (prompt !== null) { setPrompt(null); return; }
    try { setPrompt((await api.getGoalPilotRequest(req.id)).prompt); } catch { setPrompt('(could not load the prompt)'); }
  };

  return (
    <div className={`rounded-lg border px-3 py-3 ${failed ? 'bg-amber-900/15 border-amber-700/40' : 'bg-violet-900/15 border-violet-700/40'}`}>
      {failed ? (
        <>
          <p className="text-[14px] text-amber-200 font-medium">The planner did not answer.</p>
          <p className="text-[13px] text-amber-200/70 mt-0.5">{req?.error}</p>
        </>
      ) : (
        <div className="space-y-2.5">
          <AiWorkingBar label={`${pilot.plannerName || 'The planner'} is ${what}`} />
          <div className="min-w-0">
            <p className="text-[14px] text-violet-100">
              {pilot.plannerName || 'The planner'} is {what}…
            </p>
            <p className="text-[12px] text-violet-200/60 mt-0.5">
              {req?.queued ? 'Queued behind its current work · ' : ''}asked {since(req?.createdAt)} ago.
              You can leave this page — the answer will be here.
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <div className="min-w-[220px] flex-1"><PlannerPicker agents={agents} value={other} onChange={setOther} /></div>
        <button onClick={retry} disabled={busy || !other} className={failed ? primaryBtn : quietBtn}>
          {failed ? 'Ask again' : 'Ask again / switch planner'}
        </button>
        {req && <button onClick={showPrompt} className="text-[12px] text-gray-500 hover:text-gray-300">{prompt !== null ? 'Hide' : 'Show'} what it was asked</button>}
      </div>
      {error && <p className="text-[13px] text-amber-300 mt-2">{error}</p>}
      {prompt !== null && (
        <pre className="mt-2 text-[12px] text-gray-400 bg-gl-code rounded-md p-2.5 max-h-64 overflow-auto whitespace-pre-wrap">{prompt}</pre>
      )}
    </div>
  );
}

// ── 2b. the questions ──────────────────────────────────────────────────────────

function QuestionInput({ q, answer, onChange }: { q: PilotQuestion; answer: PilotAnswer | undefined; onChange: (a: PilotAnswer | undefined) => void }) {
  const delegated = !!answer?.delegated;
  const value = answer && !delegated ? answer.value : q.kind === 'multi' ? [] : '';
  const suggestion = suggestionFor(q);
  const suggestionText = Array.isArray(suggestion) ? suggestion.join(', ') : suggestion;
  const [other, setOther] = useState(() => (typeof value === 'string' && value && !q.options.includes(value) ? value : ''));

  const body = (() => {
    if (q.kind === 'text') {
      return <textarea rows={2} className={input} value={String(value)} disabled={delegated} onChange={(e) => onChange({ value: e.target.value })} />;
    }
    if (q.kind === 'multi') {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <Pill key={o} on={!delegated && picked.includes(o)} onClick={() => onChange({ value: picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o] })}>
              {picked.includes(o) && !delegated ? '☑ ' : '☐ '}{o}
            </Pill>
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <Pill key={o} on={!delegated && value === o} onClick={() => { setOther(''); onChange({ value: o }); }}>{o}</Pill>
          ))}
        </div>
        {q.kind === 'choice' && (
          <input
            className={`${input} text-[13px]`}
            placeholder="Something else…"
            value={other}
            disabled={delegated}
            onChange={(e) => { setOther(e.target.value); onChange(e.target.value ? { value: e.target.value } : undefined); }}
          />
        )}
      </div>
    );
  })();

  return (
    <div className={`rounded-lg border p-3 ${delegated ? 'border-white/[0.06] bg-white/[0.01]' : 'border-white/[0.08] bg-white/[0.02]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] text-gray-100">{q.text}{q.required && <span className="text-violet-400"> *</span>}</p>
          {q.why && <p className="text-[12px] text-gray-500 mt-0.5">{q.why}</p>}
        </div>
      </div>
      <div className={`mt-2 ${delegated ? 'opacity-40' : ''}`}>{body}</div>
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        {suggestionText && !delegated && (
          <button type="button" onClick={() => { setOther(''); onChange({ value: suggestion }); }} className="text-[12px] text-violet-400 hover:text-violet-300">
            Use suggestion: {suggestionText}
          </button>
        )}
        <label className="flex items-center gap-1.5 text-[12px] text-gray-500 cursor-pointer">
          <input type="checkbox" className="accent-violet-500" checked={delegated} onChange={() => onChange(delegated ? undefined : { value: suggestion, delegated: true })} />
          Let the agents decide{suggestionText ? ` (→ ${suggestionText})` : ''}
        </label>
      </div>
    </div>
  );
}

function QuestionsStep({ pilot, onChanged }: { pilot: GoalPilot; onChanged: () => void }) {
  const round = pilot.rounds[pilot.rounds.length - 1];
  const [answers, setAnswers] = useState<Record<string, PilotAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setAnswers({}); }, [round?.requestId]);
  if (!round) return null;
  const missing = missingRequired(round.questions, answers);
  const notes = pilot.requests.find((r) => r.id === round.requestId)?.notes ?? [];

  const send = async () => {
    setBusy(true); setError('');
    try { await api.answerGoalPilot(pilot.id, answers); onChanged(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[14px] text-gray-200">
            <span className="text-violet-300">Round {round.round}.</span> {round.message || 'The planner needs a few answers.'}
          </p>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Answer what you know. Anything you let the agents decide uses the suggestion and is recorded as an assumption.
          </p>
        </div>
        <button onClick={() => setAnswers(acceptSuggestions(round.questions, answers))} className="text-[12px] text-violet-400 hover:text-violet-300 whitespace-nowrap">
          Accept all suggestions
        </button>
      </div>
      {notes.length > 0 && <ValidationNotes notes={notes} />}
      {round.questions.map((q) => (
        <QuestionInput
          key={`${round.requestId}-${q.id}`}
          q={q}
          answer={answers[q.id]}
          onChange={(a) => setAnswers((prev) => {
            const next = { ...prev };
            if (a) next[q.id] = a; else delete next[q.id];
            return next;
          })}
        />
      ))}
      {error && <p className="text-[13px] text-amber-300">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        {missing.length > 0 && <span className="text-[12px] text-gray-500">{missing.length} required still open</span>}
        <button onClick={send} disabled={busy || missing.length > 0} className={primaryBtn}>
          {busy ? 'Sending…' : 'Send answers'}
        </button>
      </div>
    </div>
  );
}

function ValidationNotes({ notes }: { notes: string[] }) {
  return (
    <div className="px-3 py-2 rounded-lg bg-amber-900/15 border border-amber-700/30">
      <h4 className="text-[11px] text-amber-300/90 uppercase tracking-wider mb-1">Adjusted on arrival</h4>
      <ul className="text-[12px] text-amber-200/70 space-y-0.5">{notes.map((n, i) => <li key={i}>· {n}</li>)}</ul>
    </div>
  );
}

function Conversation({ pilot }: { pilot: GoalPilot }) {
  const answered = pilot.rounds.filter((r) => r.answeredAt);
  if (answered.length === 0) return null;
  const count = answered.reduce((n, r) => n + r.questions.length, 0);
  return (
    <details className="group">
      <summary className="text-[12px] text-gray-500 hover:text-gray-300 cursor-pointer select-none">
        Scoping so far — {answered.length} round{answered.length === 1 ? '' : 's'}, {count} decision{count === 1 ? '' : 's'}
      </summary>
      <div className="mt-2 space-y-2 pl-3 border-l border-white/10">
        {answered.map((r) => (
          <div key={r.requestId} className="space-y-1">
            <p className="text-[11px] text-gray-500 uppercase tracking-wider">Round {r.round}</p>
            {r.questions.map((q) => (
              <div key={q.id} className="text-[13px]">
                <span className="text-gray-500">{q.text}</span>{' '}
                <span className={r.answers[q.id]?.delegated ? 'text-violet-300/80' : 'text-gray-200'}>→ {answerLabel(q, r.answers[q.id])}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

// ── 3. brief + workflows ───────────────────────────────────────────────────────

function PlanStep({ pilot, meta, onChanged }: { pilot: GoalPilot; meta: GoalPilotMeta; onChanged: () => void }) {
  const source = pilot.plan ?? { brief: pilot.brief!, stages: pilot.proposal?.stages ?? [] };
  const [brief, setBrief] = useState<PilotBrief>(source.brief);
  const [stages, setStages] = useState<DraftStage[]>(() => draftStagesFrom(source.stages));
  const defaultVerify = meta.defaultVerify?.[pilot.intake.workType ?? ''] ?? 'test';
  const [criteria, setCriteria] = useState<DraftCriterion[]>(() => draftCriteriaFrom(pilot, defaultVerify));
  const criteriaIssues = criteriaProblems(criteria);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pipelineNotes = pilot.requests.find((r) => r.kind === 'pipeline' && r.status === 'ready')?.notes ?? [];

  const alternatives = pilot.proposal?.alternatives ?? [];
  const templateWhy = new Map(meta.templates.map((t) => [t.name, t.description]));
  const included = stages.filter((s) => s.include).length;

  const add = () => {
    if (!adding) return;
    const alt = alternatives.find((a) => a.template === adding);
    setStages((prev) => [...prev, {
      key: `added-${prev.length + 1}`, template: adding, title: adding, why: alt?.why || templateWhy.get(adding) || '', focus: '', optional: false, skipSteps: [], include: true,
    }]);
    setAdding('');
  };

  const accept = async () => {
    setBusy(true); setError('');
    try { await api.acceptGoalPilotPlan(pilot.id, { brief, stages: includedStages(stages), criteria }); onChanged(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-[12px] text-gray-400 uppercase tracking-wider">Scope brief</h3>
          <span className="text-[11px] text-gray-500">Fields marked → feature are written onto the feature and reach every agent working on it.</span>
        </div>
        <div className="space-y-3 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3">
          <div>
            <label className="block text-[12px] text-gray-400 mb-1">Slug <span className="text-gray-500">— used for docs/&lt;slug&gt;/ paths</span></label>
            <input className={`${input} font-mono text-[13px]`} value={brief.slug} onChange={(e) => setBrief({ ...brief, slug: e.target.value })} />
          </div>
          {/* The acceptance criteria are edited as numbered rows below; the brief's text is written from them. */}
          {meta.briefFields.filter((f) => f.key !== 'acceptanceCriteria').map((f) => (
            <div key={f.key}>
              <label className="flex items-center gap-2 text-[12px] text-gray-400 mb-1" title={f.guidance}>
                {f.label}
                {f.onGoal && <span className="text-[9px] px-1 py-px rounded bg-violet-900/50 text-violet-300 border border-violet-700/40">→ feature</span>}
              </label>
              <textarea
                rows={Math.min(8, Math.max(2, String(brief[f.key] ?? '').split('\n').length + 1))}
                className={`${input} text-[13px]`}
                value={brief[f.key] ?? ''}
                placeholder={f.guidance}
                onChange={(e) => setBrief({ ...brief, [f.key]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </div>

      <CriteriaEditor criteria={criteria} onChange={setCriteria} meta={meta} defaultVerify={defaultVerify} size={pilot.brief?.size || pilot.intake?.size} />

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-[12px] text-gray-400 uppercase tracking-wider">Workflows, in order</h3>
          {pilot.proposal?.message && <span className="text-[12px] text-gray-500 text-right">{pilot.proposal.message}</span>}
        </div>
        {pipelineNotes.length > 0 && <div className="mb-2"><ValidationNotes notes={pipelineNotes} /></div>}
        <div className="space-y-2">
          {stages.map((s, i) => (
            <div key={`${s.key}-${i}`} className={`rounded-lg border p-3 ${s.include ? 'border-violet-700/40 bg-violet-900/10' : 'border-white/[0.06] bg-white/[0.01] opacity-60'}`}>
              <div className="flex items-start gap-2.5">
                <input type="checkbox" className="mt-1.5 accent-violet-500" checked={s.include}
                  onChange={() => setStages((prev) => prev.map((x, j) => (j === i ? { ...x, include: !x.include } : x)))} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] text-gray-500 w-4">{i + 1}.</span>
                    <input className="bg-transparent text-[14px] text-gray-100 font-medium flex-1 min-w-[160px] focus:outline-none border-b border-transparent focus:border-violet-500/50"
                      value={s.title} onChange={(e) => setStages((prev) => prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-900/40 border border-violet-700/40 text-violet-300">⇉ {s.template}</span>
                    {s.optional && <span className="text-[11px] text-gray-500">optional</span>}
                  </div>
                  {s.why && <p className="text-[13px] text-gray-500 pl-6">{s.why}</p>}
                  {(s.skipSteps?.length ?? 0) > 0 && (
                    <div data-skip-steps className="pl-6 flex items-center gap-1.5 flex-wrap text-[12px] text-gray-500">
                      <span>Leaves out:</span>
                      {s.skipSteps!.map((n) => (
                        <span key={n} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 bg-white/[0.03] text-gray-400">
                          {n}
                          <button type="button" aria-label={`Keep ${n}`} title="Keep this step"
                            onClick={() => setStages((prev) => prev.map((x, j) => (j === i ? { ...x, skipSteps: (x.skipSteps ?? []).filter((m) => m !== n) } : x)))}
                            className="text-gray-500 hover:text-gray-200">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <details className="pl-6">
                    <summary className="text-[12px] text-gray-500 hover:text-gray-400 cursor-pointer">What this stage will be told</summary>
                    <textarea rows={4} className={`${input} mt-1 text-[13px]`} value={s.focus} placeholder="The focus for this stage on this feature"
                      onChange={(e) => setStages((prev) => prev.map((x, j) => (j === i ? { ...x, focus: e.target.value } : x)))} />
                  </details>
                </div>
                <div className="flex flex-col gap-0.5">
                  <button type="button" onClick={() => setStages((prev) => moveItem(prev, i, -1))} disabled={i === 0} className="text-gray-500 hover:text-gray-200 disabled:opacity-20 text-[12px]" title="Run earlier">▲</button>
                  <button type="button" onClick={() => setStages((prev) => moveItem(prev, i, 1))} disabled={i === stages.length - 1} className="text-gray-500 hover:text-gray-200 disabled:opacity-20 text-[12px]" title="Run later">▼</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <select className={`${input} text-[13px]`} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a workflow…</option>
            {alternatives.length > 0 && (
              <optgroup label="Considered by the planner">
                {alternatives.map((a) => <option key={a.template} value={a.template}>{a.template} — {a.why}</option>)}
              </optgroup>
            )}
            <optgroup label="All workflows">
              {meta.templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </optgroup>
          </select>
          <button onClick={add} disabled={!adding} className={quietBtn}>Add</button>
        </div>
      </div>

      {error && <p className="text-[13px] text-amber-300">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        <span className="text-[12px] text-gray-500">Accepting freezes the criteria and writes the → feature fields onto the feature. Nothing runs yet.</span>
        <button onClick={accept} disabled={busy || included === 0 || !brief.summary.trim() || criteriaIssues.length > 0} className={primaryBtn}
          title={criteriaIssues.length ? criteriaIssues.join(' ') : undefined}>
          {busy ? 'Saving…' : `Accept plan · ${included} workflow${included === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

// ── 4. repos and cartridges ────────────────────────────────────────────────────

function StaffStep({ pilot, meta, onChanged }: { pilot: GoalPilot; meta: GoalPilotMeta; onChanged: () => void }) {
  const [repos, setRepos] = useState<PilotCandidateRepo[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});      // repoPath → engine
  const [assign, setAssign] = useState<Record<string, string>>({});      // stage key → repoPath
  const [teamPick, setTeamPick] = useState<Record<string, string[]>>({}); // team stage key → repoPaths
  // Its own branch: a worktree + cartridge per repo, a PR per repo at the end — so it can run beside other features.
  const [ownBranch, setOwnBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stages = pilot.plan?.stages ?? [];
  const criteria = pilot.plan?.criteria ?? [];
  const tested = criteria.filter((c) => c.verify === 'test');
  const checklist = criteria.filter((c) => c.verify === 'checklist');
  const keys = meta.contractStageKeys ?? { acceptance: 'acceptance', review: 'review' };
  // The contract's own stages are placed like any workflow: the tests live in (and run in) one repo.
  const placed = [
    ...(tested.length ? [{ key: keys.acceptance, title: 'Write the acceptance tests', template: `${tested.length} test${tested.length === 1 ? '' : 's'} — they live and run here` }] : []),
    ...stages.map((s) => ({ key: s.key, title: s.title, template: s.template })),
    ...(checklist.length ? [{ key: keys.review, title: 'Independent review of the checklist', template: `${checklist.length} item${checklist.length === 1 ? '' : 's'}` }] : []),
  ];

  useEffect(() => {
    api.getGoalPilotCandidates(pilot.goalId).then((list) => {
      setRepos(list);
      // Pre-select the project's repos, else the planner's own repo if it is a candidate.
      // The repos chosen when the feature started, when it named some; else the project's.
      const wanted = new Set(pilot.featureRepos ?? []);
      const featured = list.filter((r) => wanted.has(r.repoPath));
      const owned = list.filter((r) => r.owned);
      const planner = list.find((r) => r.engines.some((e) => e.agentId === pilot.plannerAgentId));
      let pick = featured.length ? featured : owned.length ? owned : planner ? [planner] : [];
      // The first chosen repo is where every stage runs unless you move it — so it should be the
      // repo the planner read the feature in, not whichever name sorts first.
      if (planner && pick.includes(planner)) pick = [planner, ...pick.filter((r) => r !== planner)];
      setChosen(Object.fromEntries(pick.map((r) => [r.repoPath, defaultEngine(r)])));
    }).catch((e) => setError(errorText(e)));
  }, [pilot.goalId, pilot.plannerAgentId, pilot.featureRepos]);

  const chosenPaths = Object.keys(chosen);
  // Stages worked by several cartridges together (Confer): two or more repos each, not one.
  const teamNames = new Set(meta.teamTemplates ?? []);
  const teamKeys = stages.filter((s) => teamNames.has(s.template)).map((s) => s.key);
  const { teams, short } = resolveTeams(teamKeys, chosenPaths, teamPick);
  const assignments: Record<string, string | string[]> = {
    ...resolveAssignments(placed.map((s) => s.key), chosenPaths, assign),
    ...teams,
  };
  const byPath = new Map((repos ?? []).map((r) => [r.repoPath, r]));

  const start = async () => {
    setBusy(true); setError('');
    try {
      await api.startGoalPilot(pilot.id, { repos: chosenPaths.map((p) => ({ repoPath: p, agentType: chosen[p] })), assignments, isolate: ownBranch });
      onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const revise = async () => {
    try { await api.reviseGoalPilotPlan(pilot.id); onChanged(); } catch (e) { setError(errorText(e)); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[12px] text-gray-400 uppercase tracking-wider mb-1">Which repos build this feature?</h3>
        <label className="flex items-start gap-2 text-[13px] text-gray-300 mb-2 cursor-pointer">
          <input type="checkbox" className="accent-violet-500 mt-0.5" checked={ownBranch} onChange={() => setOwnBranch((v) => !v)} />
          <span>
            Work on its own branch
            <span className="block text-[12px] text-gray-500">A git worktree and a cartridge per repo, so it runs beside other features; a PR per repo when it is done. Untick to work in the repos' own checkouts.</span>
          </span>
        </label>
        <p className="text-[12px] text-gray-500 mb-2">
          The project's repos are picked for you — untick any this feature does not touch, and choose the engine that works in each.
          A repo from outside the project is added to the project when the run starts.
          A stage whose cartridge is not running waits for it and starts by itself when it connects.
        </p>
        {repos === null ? <p className="text-[13px] text-gray-500">Loading repos…</p> : repos.length === 0 ? (
          <p className="text-[13px] text-amber-300/90">No repos known yet — launch a cartridge in the repo you want to use.</p>
        ) : (
          <div className="space-y-1.5">
            {repos.map((r) => {
              const on = r.repoPath in chosen;
              const engine = chosen[r.repoPath] ?? defaultEngine(r);
              const status = engineStatus(r, engine);
              return (
                <div key={r.repoPath} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${on ? 'border-violet-700/40 bg-violet-900/10' : 'border-white/[0.06]'}`}>
                  <input type="checkbox" className="accent-violet-500" checked={on} onChange={() => setChosen((prev) => {
                    const next = { ...prev };
                    if (on) delete next[r.repoPath]; else next[r.repoPath] = defaultEngine(r);
                    return next;
                  })} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-gray-100 flex items-center gap-2">
                      {r.repoName}
                      {r.owned && <span className="text-[9px] px-1 rounded bg-violet-900/40 text-violet-300">in this project</span>}
                    </div>
                    <div className="text-[11px] text-gray-500 font-mono truncate">{r.repoPath}</div>
                  </div>
                  <select disabled={!on} className="bg-gl-code border border-white/10 rounded px-1.5 py-1 text-[13px] text-gray-300 disabled:opacity-40"
                    value={engine} onChange={(e) => setChosen((prev) => ({ ...prev, [r.repoPath]: e.target.value }))}>
                    {meta.engines.map((eng) => {
                      const st = engineStatus(r, eng);
                      return <option key={eng} value={eng}>{ENGINE_LABEL[eng] ?? eng}{st === 'live' ? ' ● live' : st === 'offline' ? ' ○ offline' : ''}</option>;
                    })}
                  </select>
                  {on && (
                    <span className={`text-[11px] w-16 text-right ${status === 'live' ? 'text-emerald-400' : 'text-amber-300/80'}`}>
                      {status === 'live' ? 'ready' : 'will wait'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(chosenPaths.length > 1 || teamKeys.length > 0) && (
        <div>
          <h3 className="text-[12px] text-gray-400 uppercase tracking-wider mb-1">Where each stage runs</h3>
          <div className="space-y-1">
            {placed.map((s, i) => teamKeys.includes(s.key) ? (
              <div key={s.key} className="text-[13px] space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 w-4">{i + 1}.</span>
                  <span className="text-gray-300 flex-1 truncate">{s.title} <span className="text-gray-500">· {s.template} — worked together by:</span></span>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-6">
                  {chosenPaths.map((p) => (
                    <label key={p} className="flex items-center gap-1 text-gray-300">
                      <input type="checkbox" className="accent-violet-500" checked={teams[s.key]?.includes(p) ?? false}
                        onChange={() => setTeamPick((prev) => {
                          const cur = teams[s.key] ?? [];
                          return { ...prev, [s.key]: cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p] };
                        })} />
                      {byPath.get(p)?.repoName ?? p}
                    </label>
                  ))}
                  {short.includes(s.key) && (
                    <span className="text-amber-300/90">Needs two or more repos{chosenPaths.length < 2 ? ' — choose another repo above' : ''}.</span>
                  )}
                </div>
              </div>
            ) : (
              <div key={s.key} className="flex items-center gap-2 text-[13px]">
                <span className="text-gray-500 w-4">{i + 1}.</span>
                <span className="text-gray-300 flex-1 truncate">{s.title} <span className="text-gray-500">· {s.template}</span></span>
                <select className="bg-gl-code border border-white/10 rounded px-1.5 py-1 text-[13px] text-gray-300"
                  value={String(assignments[s.key] ?? '')} onChange={(e) => setAssign((prev) => ({ ...prev, [s.key]: e.target.value }))}>
                  {chosenPaths.map((p) => <option key={p} value={p}>{byPath.get(p)?.repoName ?? p}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {criteria.length > 0 && (
        <div className="text-[13px] text-gray-400 rounded-lg border border-sky-800/40 bg-sky-950/10 px-3 py-2">
          <span className="text-sky-200">⚖ The acceptance contract.</span>{' '}
          {tested.length > 0
            ? <>Before any workflow runs, an agent writes {tested.length} failing test{tested.length === 1 ? '' : 's'} ({tested.map((c) => c.id).join(', ')}). You review and approve them; then they are locked and NeonCore runs them after every stage. </>
            : null}
          {checklist.length > 0 && <>At the end, a cartridge that did not do the work judges {checklist.map((c) => c.id).join(', ')}; you confirm each verdict. </>}
          The feature report is a success only if every criterion passes.
        </div>
      )}

      {error && <p className="text-[13px] text-amber-300">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <button onClick={revise} className="text-[12px] text-gray-500 hover:text-gray-300">← Change the plan</button>
        <button onClick={start} disabled={busy || chosenPaths.length === 0 || short.length > 0} className={primaryBtn}
          title={short.length ? 'A stage worked together needs two or more repos' : undefined}>
          {busy ? 'Starting…' : `Start the pipeline · ${stages.length} workflow${stages.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

// ── 5. the running pipeline ────────────────────────────────────────────────────

function StageRow({ pilot, stage, index, onOpenRun, onChanged }: {
  pilot: GoalPilot; stage: PilotStage; index: number; onOpenRun: (id: string) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progressOpen, setProgressOpen] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const live = pilot.phase === 'running' || pilot.phase === 'paused';
  const team = (stage.participants ?? []).map((p) => p.repoPath.split(/[\\/]/).pop()).filter(Boolean);
  const pct = stage.progress && stage.progress.total ? Math.round((stage.progress.completed / stage.progress.total) * 100) : null;
  const repoName = stage.repoPath.split(/[\\/]/).pop();
  const kindBadge = stage.kind === 'acceptance' ? '⚖ acceptance tests' : stage.kind === 'review' ? '⚖ independent review' : `⇉ ${stage.template}`;
  const checking = stage.status === 'verifying';

  return (
    <div className={`rounded-xl border px-3.5 py-3 ${stage.status === 'running' ? 'border-[rgba(124,108,255,0.5)] bg-[rgba(124,108,255,0.1)]' : 'border-white/[0.08] bg-gl-code/60'}`}>
      <div className="flex items-start gap-3.5">
        <span className={`text-[18px] leading-6 w-6 text-center ${stage.status === 'running' ? 'text-[#B9AEFF]' : STAGE_TONE[stage.status]}`} title={stage.status}>{STAGE_ICON[stage.status]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] text-gray-100 font-semibold">{index + 1}. {stage.title}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${stage.kind === 'workflow' ? 'bg-white/[0.05] border-white/10 text-gray-400' : 'bg-sky-900/30 border-sky-700/40 text-sky-200'}`}>{kindBadge}</span>
            <span className="text-[11px] text-gray-500">
              {team.length >= 2
                ? `worked together by ${team.join(' + ')}`
                : stage.agentName || (stage.kind === 'review' ? 'a cartridge that did not do the work' : `${ENGINE_LABEL[stage.agentType] ?? stage.agentType} · ${repoName}`)}
            </span>
            {stage.attempts > 1 && <span className="text-[11px] text-gray-500">attempt {stage.attempts}</span>}
          </div>
          {(stage.skipSteps?.length ?? 0) > 0 && (
            <p data-skip-steps className="text-[12px] text-gray-500 mt-0.5">Leaves out: {stage.skipSteps!.join(' · ')}</p>
          )}
          {pct !== null && stage.status === 'running' && (
            <div className="flex items-center gap-2 mt-1.5">
              <div aria-hidden="true" className="flex-1 flex gap-[2px]">
                {Array.from({ length: 24 }, (_, k) => (
                  <span key={k} className={`flex-1 h-[5px] rounded-[1px] ${k < Math.round((24 * pct) / 100) ? 'seg-on' : 'bg-white/[0.08]'}`} />
                ))}
              </div>
              <span className="text-[11px] text-gray-500">{stage.progress!.completed}/{stage.progress!.total} steps{stage.runStatus === 'paused' ? ' · paused' : ''}</span>
            </div>
          )}
          {stage.attention && (
            <div className="mt-2 text-[13px] text-amber-200 bg-amber-900/25 border border-amber-700/40 rounded-md px-2.5 py-1.5">
              <span className="uppercase tracking-wider text-[11px] text-amber-400/90 mr-1.5">needs you · {stage.attention.reason.replace('-', ' ')}</span>
              {stage.attention.detail}
            </div>
          )}
          {stage.status === 'waiting' && stage.waitReason && (
            <p className="mt-1.5 text-[13px] text-amber-300/90">{stage.waitReason}</p>
          )}
          {stage.kind === 'acceptance' && stage.status === 'review' && (
            <p className="mt-1.5 text-[13px] text-amber-200">The tests are written — review them in the acceptance contract above, then approve to lock them.</p>
          )}
          {stage.kind === 'review' && stage.status === 'review' && (
            <p className="mt-1.5 text-[13px] text-amber-200">The reviewer's verdicts are in — confirm or overrule them in the acceptance contract above.</p>
          )}
          {stage.kind === 'review' && stage.status === 'running' && stage.waitReason && (
            <p className="mt-1.5 text-[13px] text-amber-300/80">{stage.waitReason}</p>
          )}
          {checking && (
            <p className={`mt-1.5 text-[13px] ${stage.verifyState === 'tampered' || stage.verifyState === 'error' ? 'text-red-300' : 'text-sky-300'}`}>
              {stage.verifyState === 'tampered' ? 'Its run changed locked acceptance tests — see the acceptance contract above.'
                : stage.verifyState === 'error' ? `Its work could not be checked: ${stage.waitReason}`
                : stage.waitReason || 'Run finished — NeonCore is checking the locked tests are unchanged and running them…'}
            </p>
          )}
          {stage.resultSummary && (
            <details className="mt-1.5">
              <summary className="text-[12px] text-gray-500 hover:text-gray-300 cursor-pointer">
                {stage.status === 'completed' ? 'What it produced' : 'Last result'}
              </summary>
              <pre className="mt-1 text-[12px] text-gray-400 bg-gl-code rounded-md p-2 whitespace-pre-wrap max-h-56 overflow-auto">{stage.resultSummary}</pre>
            </details>
          )}
          {progressOpen && stage.runId && (
            <RunProgressModal workflowId={stage.runId} title={stage.title} onClose={() => { setProgressOpen(false); onChanged(); }} />
          )}
          {error && <p className="text-[13px] text-amber-300 mt-1">{error}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* A held step is the one kind of "needs you" a single click settles — no reason to send
              the person into the canvas for it. Decisions and questions need the run's own UI. */}
          {/* Tasks still open and no further progress: keep working, or accept — never decided
              for you (server lib/coverage-loop.ts). */}
          {stage.attention?.reason === 'tasks-outstanding' && stage.attention.stepId && stage.runId && (
            <CoverageChoice compact workflowId={stage.runId} stepId={stage.attention.stepId} onDone={onChanged} />
          )}
          {stage.runId && (
            <button onClick={() => setProgressOpen(true)} title="The run's progress document and what the engine has seen"
              className="text-[12px] px-2 py-1 rounded border border-white/10 text-sky-300 hover:bg-white/5">
              Progress
            </button>
          )}
          {stage.attention?.reason === 'manual-advance' && stage.attention.stepId && (
            <button
              disabled={busy}
              onClick={() => act(() => api.advanceWorkflowStep(stage.runId, stage.attention!.stepId))}
              title={`Release "${stage.attention.stepName}" so the run continues`}
              className="text-[12px] px-2 py-1 rounded border border-emerald-600/60 text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-40"
            >
              Advance
            </button>
          )}
          {stage.runId && (
            <button onClick={() => onOpenRun(stage.runId)} className={`text-[12px] px-2 py-1 rounded border ${stage.attention ? 'border-amber-600/60 text-amber-200 hover:bg-amber-900/30' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}>
              Open run
            </button>
          )}
          {live && checking && stage.verifyState === 'error' && (
            <button disabled={busy} onClick={() => act(() => api.verifyGoalPilotStageAgain(pilot.id, stage.id))} className="text-[12px] px-2 py-1 rounded border border-sky-600/50 text-sky-200 hover:bg-sky-900/30 disabled:opacity-40">
              Check again
            </button>
          )}
          {live && ['failed', 'cancelled', 'waiting'].includes(stage.status) && (
            <button disabled={busy} onClick={() => act(() => api.retryGoalPilotStage(pilot.id, stage.id))} className="text-[12px] px-2 py-1 rounded border border-violet-600/50 text-violet-200 hover:bg-violet-900/30 disabled:opacity-40">
              Retry
            </button>
          )}
          {live && !['completed', 'skipped', 'verifying'].includes(stage.status) && (
            <button
              disabled={busy}
              onClick={() => {
                const warning = stage.kind === 'acceptance'
                  ? 'Skip the acceptance tests? The pipeline then runs without them, and the test criteria will never be checked — the report will say so.'
                  : stage.kind === 'review' ? 'Skip the independent review? The checklist criteria will stay unchecked.'
                  : stage.status === 'running' ? 'Skip this stage? Its run will be cancelled.' : '';
                if (!warning || confirm(warning)) act(() => api.skipGoalPilotStage(pilot.id, stage.id));
              }}
              className="text-[12px] px-2 py-1 rounded border border-white/10 text-gray-500 hover:text-gray-200 disabled:opacity-40"
            >
              Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const REPORT_TONE: Record<string, string> = {
  SUCCESS: 'text-emerald-300 border-emerald-600/50', PARTIAL: 'text-amber-300 border-amber-600/50',
  FAILED: 'text-red-300 border-red-600/50', INCOMPLETE: 'text-red-300 border-red-600/50',
};

/**
 * The feature report (the goal report): what the whole pipeline did, in one place. The full document (every stage's run
 * report, the scope, decisions, learnings, open items) opens as a page or downloads as Markdown.
 */
function GoalReportCard({ pilot, onChanged }: { pilot: GoalPilot; onChanged: () => void }) {
  const r = pilot.report!;
  const req = pilot.currentRequest;
  const writing = req?.kind === 'report' && req.status === 'pending';
  const plannerFailed = req?.kind === 'report' && req.status === 'failed' && r.summary.source !== 'planner';
  const [busy, setBusy] = useState(false);
  const askAgain = async () => {
    setBusy(true);
    try { await api.retryGoalPilot(pilot.id); onChanged(); } catch { /* the compiled report stands */ } finally { setBusy(false); }
  };
  const base = `/api/goal-pilots/${encodeURIComponent(pilot.id)}/report`;
  return (
    <div className="rounded-lg border border-violet-700/40 bg-violet-950/30 p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h4 className="text-[14px] text-violet-100 font-semibold">Feature report</h4>
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${REPORT_TONE[r.status] ?? 'text-gray-300 border-white/20'}`}>{r.status}</span>
        </div>
        <div className="flex items-center gap-2">
          <a href={`${base}/html`} target="_blank" rel="noreferrer" className={primaryBtn}>Open report</a>
          <a href={`${base}/markdown`} className={quietBtn}>Download .md</a>
        </div>
      </div>
      <div className="flex gap-4 flex-wrap text-[12px] text-gray-400">
        {r.acceptance && r.acceptance.total > 0 && (
          <span className={r.acceptance.passing === r.acceptance.total ? 'text-emerald-300' : 'text-amber-300'}>
            {r.acceptance.passing}/{r.acceptance.total} criteria pass
            {!r.acceptance.testsUnchanged && ` · ${r.acceptance.tamperEvents.length} change${r.acceptance.tamperEvents.length === 1 ? '' : 's'} to locked tests (${
              [...new Set(r.acceptance.tamperEvents.map((t) => t.resolution))].join(', ')})`}
          </span>
        )}
        <span>{r.outcome.stagesCompleted}/{r.outcome.stagesTotal} stages</span>
        <span>{r.outcome.stepsCompleted}/{r.outcome.stepsTotal} steps</span>
        {r.outcome.testsTotal > 0 && <span>{r.outcome.testsPassed}/{r.outcome.testsTotal} tests passing</span>}
        {r.outcome.issues > 0 && <span className="text-amber-300">{r.outcome.issues} issue{r.outcome.issues === 1 ? '' : 's'}</span>}
        <span>${r.costUsd.toFixed(2)} spent</span>
      </div>
      <p className="text-[14px] text-gray-200 leading-relaxed">{r.summary.text}</p>
      {r.summary.highlights.length > 0 && (
        <div>
          <h5 className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">What was done</h5>
          <ul className="text-[13px] text-gray-300 space-y-0.5">{r.summary.highlights.map((h, i) => <li key={i}>· {h}</li>)}</ul>
        </div>
      )}
      {r.openItems.length > 0 && (
        <div>
          <h5 className="text-[11px] text-amber-400/80 uppercase tracking-wider mb-1">Still open</h5>
          <ul className="text-[13px] text-amber-100/80 space-y-0.5">{r.openItems.slice(0, 6).map((h, i) => <li key={i}>☐ {h}</li>)}</ul>
          {r.openItems.length > 6 && <p className="text-[12px] text-gray-500 mt-0.5">+{r.openItems.length - 6} more in the report</p>}
        </div>
      )}
      <p className="text-[12px] text-gray-500">
        {writing ? `${pilot.plannerName || 'The planner'} is writing the summary… until then it is compiled from the run reports.`
          : r.summary.source === 'planner' ? 'Summary written by the planner from the records.'
          : 'Summary compiled from the run reports.'}
        {plannerFailed && (
          <> The planner did not answer. <button onClick={askAgain} disabled={busy} className="text-violet-400 hover:text-violet-300">Ask again</button></>
        )}
        {r.files && <span className="block text-gray-500 font-mono truncate" title={r.files.html}>Saved to {r.files.html.replace(/\/[^/]+$/, '/')}</span>}
      </p>
    </div>
  );
}

/**
 * The feature's own branch: a worktree + cartridge per repo, and each repo's PR (or why there is none).
 * The end of the job: the PRs open by themselves when the pipeline ends; then the person is asked to
 * merge — one button merges every PR (all or none), and the worktrees, the branch and their cartridges
 * go. A PR merged on GitHub instead is noticed and cleaned up the same way.
 */
export function WorkspaceCard({ pilot, busy, act }: { pilot: GoalPilot; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const ws = pilot.workspace!;
  const [confirming, setConfirming] = useState(false);
  const base = (p: string) => p.split(/[\\/]/).pop() || p;
  const live = ws.repos.filter((r) => !r.removed);
  const open = live.filter((r) => r.pr?.state === 'open');
  const mergedNotCleaned = live.some((r) => r.pr?.state === 'merged');
  const into = [...new Set(open.map((r) => r.base))].join(', ');
  const status = ws.cleanedAt ? 'merged — worktrees, branch and cartridges removed'
    : open.length ? `${open.length} PR${open.length === 1 ? '' : 's'} ready — review, then merge`
    : ws.prsAt ? '' : 'a worktree and a cartridge per repo; the PRs open when the pipeline finishes';
  return (
    <div className="rounded-xl border border-white/[0.08] bg-gl-code/60 px-3.5 py-3 space-y-2" data-testid="workspace-card">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-[13px] text-gray-300">
          Own branch <span className="font-mono text-violet-200">{ws.branch}</span>
          {status && <span className={ws.cleanedAt ? 'text-emerald-400' : open.length ? 'text-amber-300' : 'text-gray-500'}> — {status}</span>}
        </div>
        <div className="flex items-center gap-2">
          {open.length > 0 && !confirming && (
            <button disabled={busy} onClick={() => setConfirming(true)} className={primaryBtn}>Merge{open.length > 1 ? ` ${open.length} PRs` : ''}…</button>
          )}
          {open.length > 0 && confirming && (
            <>
              <button disabled={busy} onClick={() => { setConfirming(false); act(() => api.mergeFeaturePrs(pilot.id)); }} className={primaryBtn}>
                Merge into {into || 'the base'} &amp; clean up
              </button>
              <button disabled={busy} onClick={() => setConfirming(false)} className={quietBtn}>Not yet</button>
            </>
          )}
          {live.length > 0 && (!ws.prsAt || live.some((r) => !r.pr)) && <button disabled={busy} onClick={() => act(() => api.openFeaturePrs(pilot.id))} className={quietBtn}>Open PRs now</button>}
          {mergedNotCleaned && <button disabled={busy} onClick={() => act(() => api.cleanupFeatureWorkspace(pilot.id))} className={quietBtn}
            title="For each repo whose PR is merged: end its worktree cartridge and remove the worktree">Clean up merged</button>}
        </div>
      </div>
      {confirming && (
        <p className="text-[12px] text-gray-400">
          Every PR below is merged — none if any one cannot be — then each worktree, the {ws.branch} branch (here and on origin) and the worktree cartridges are removed.
        </p>
      )}
      <ul className="space-y-1">
        {ws.repos.map((r) => (
          <li key={r.repoPath} className="text-[13px] flex items-baseline gap-2 flex-wrap">
            <span className="text-gray-100">{base(r.repoPath)}</span>
            <span className="text-[11px] text-gray-500 font-mono truncate" title={r.worktreePath}>{r.removed ? 'worktree removed' : base(r.worktreePath)}</span>
            {r.pr && (
              <a href={r.pr.url} target="_blank" rel="noreferrer" className="text-neon-400 hover:text-neon-300">
                PR #{r.pr.number || ''}{r.pr.state && r.pr.state !== 'open' ? ` · ${r.pr.state}` : ''}
              </a>
            )}
            {r.error && <span className="text-[12px] text-amber-300">{r.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PipelineStep({ pilot, goal, agents, onChanged, onGoalChanged }: {
  pilot: GoalPilot; goal: Goal; agents: Agent[]; onChanged: () => void; onGoalChanged: () => void;
}) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); onChanged(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[14px] text-[#CFC8FF]">{pipelineSummary(pilot.stages)}</p>
        <div className="flex items-center gap-2">
          {pilot.phase === 'running' && <button disabled={busy} onClick={() => act(() => api.pauseGoalPilot(pilot.id))} className={quietBtn}>Pause</button>}
          {/* A changed locked test is resolved in the contract card (restore / accept), not by resuming. */}
          {pilot.phase === 'paused' && !pilot.acceptance?.tamper && <button disabled={busy} onClick={() => act(() => api.resumeGoalPilot(pilot.id))} className={primaryBtn}>Resume</button>}
        </div>
      </div>

      {pilot.phase === 'paused' && pilot.attention && (
        <div className="text-[13px] text-amber-200 bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2">{pilot.attention}</div>
      )}

      {pilot.workspace && <WorkspaceCard pilot={pilot} busy={busy} act={act} />}
      {pilot.report && <GoalReportCard pilot={pilot} onChanged={onChanged} />}
      <ContractCard pilot={pilot} onChanged={onChanged} />
      {!pilot.report && pilot.phase === 'cancelled' && pilot.stages.some((s) => s.runId) && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-white/10">
          <p className="text-[13px] text-gray-400">This pipeline was cancelled part-way. A report can still account for what ran.</p>
          <button disabled={busy} onClick={() => act(() => api.buildGoalPilotReport(pilot.id))} className={quietBtn}>Build report</button>
        </div>
      )}
      {pilot.phase === 'completed' && (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-emerald-900/20 border border-emerald-700/40">
          <p className="text-[14px] text-emerald-200">
            Every stage finished.{pilot.acceptance && pilot.acceptance.total > 0
              ? ` ${pilot.acceptance.passing} of ${pilot.acceptance.total} acceptance criteria pass on NeonCore's own check.`
              : ' Check the results against “done when”.'} Then mark the feature done.
          </p>
          {goal.status !== 'achieved' && (
            <button disabled={busy} onClick={() => act(async () => { await api.updateGoal(goal.id, { status: 'achieved' }); onGoalChanged(); })} className={primaryBtn}>
              Mark feature done
            </button>
          )}
        </div>
      )}

      <div className="space-y-2">
        {pilot.stages.map((s, i) => <StageRow key={s.id} pilot={pilot} stage={s} index={i} onOpenRun={setOpenRun} onChanged={onChanged} />)}
      </div>
      {error && <p className="text-[13px] text-amber-300">{error}</p>}

      {openRun && (
        <WorkflowCanvasEditor workflowId={openRun} agents={agents} onClose={() => { setOpenRun(null); onChanged(); }} />
      )}
    </div>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────────

/**
 * The pipeline section of a feature's page. With no pilot, an offer to start one; otherwise the
 * step the pilot is on.
 */
export function GoalPilotPanel({ goal, agents, onGoalChanged, projectRepos, startOpen = false }: {
  goal: Goal;
  agents: Agent[];
  onGoalChanged: () => void;
  /** The feature's project's repos — its cartridges are offered first as the planner. */
  projectRepos?: string[];
  /** Open straight onto the questions when the feature was never started (the "Start" click). */
  startOpen?: boolean;
}) {
  const meta = useMeta();
  const [pilots, setPilots] = useState<GoalPilot[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const lastPhase = useRef<string>('');

  const load = useCallback(async () => {
    try { setPilots(await api.getGoalPilots(goal.id)); } catch { setPilots((p) => p ?? []); }
  }, [goal.id]);
  useEffect(() => { setPilots(null); setStarting(false); load(); }, [load]);
  // A feature that was never started opens on its questions when asked to — the list's "Start".
  useEffect(() => { if (startOpen && pilots && pilots.length === 0) setStarting(true); }, [startOpen, pilots]);

  const pilot = useMemo(() => (pilots ?? []).find(isLivePilot) ?? (pilots ?? [])[0] ?? null, [pilots]);

  // Planner steps and running stages change without the person doing anything: poll while they
  // do, and listen for the server's nudge so an answer shows up the moment it lands.
  const active = !!pilot && (waitingOnPlanner(pilot) || pilot.phase === 'running'
    || (pilot.currentRequest?.kind === 'report' && pilot.currentRequest.status === 'pending'));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);
  useSocket({
    onGoalPilotUpdated: useCallback((d: { id: string }) => { if (!pilot || d.id === pilot.id) load(); }, [pilot, load]),
    onWorkflowUpdated: useCallback(() => { if (pilot?.phase === 'running') load(); }, [pilot?.phase, load]),
  });

  // Accepting a plan writes the goal's fields; starting attaches projects; every stage that starts
  // or finishes moves the goal's runs, progress and spend. Refresh the goal on each of those — not
  // on every poll, which would refetch the whole hierarchy every three seconds for nothing.
  const stageSignature = pilot ? pilot.stages.map((s) => `${s.status}:${s.runId}`).join('|') : '';
  useEffect(() => {
    if (!pilot) return;
    const sig = `${pilot.phase}#${stageSignature}`;
    if (lastPhase.current && lastPhase.current !== sig && ['staffing', 'running', 'paused', 'completed'].includes(pilot.phase)) onGoalChanged();
    lastPhase.current = sig;
  }, [pilot, stageSignature, onGoalChanged]);

  const cancel = async () => {
    if (!pilot || !confirm('Cancel this feature\'s pipeline? A running stage\'s run is cancelled too. The feature stays on the list, and you can start it again.')) return;
    try { await api.cancelGoalPilot(pilot.id); load(); } catch (e) { setError(errorText(e)); }
  };

  if (pilots === null) return null;

  const shell = (body: React.ReactNode, header?: React.ReactNode) => (
    <section className="rounded-[22px] border border-[rgba(124,108,255,0.45)] bg-[rgba(10,16,32,0.85)] shadow-[0_0_36px_rgba(124,108,255,0.14)] p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="font-display text-[22px] text-gray-100 font-semibold flex items-center gap-2">
          <span aria-hidden="true" className="text-[#B9AEFF]">✦</span> Feature pipeline
        </h3>
        {header}
      </div>
      {body}
    </section>
  );

  if (starting || !pilot) {
    if (!starting) {
      return shell(
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[13px] text-gray-400 max-w-xl">
            Let a planner cartridge scope this feature with you, propose the workflows that build it, and run them in order
            in the project's repos — so no agent has to ask anything once work starts.
          </p>
          <button onClick={() => setStarting(true)} className={primaryBtn}>✦ Start this feature</button>
        </div>,
      );
    }
    return shell(
      <GoalPilotIntake agents={agents} goal={goal} preferRepos={projectRepos} onCancel={() => setStarting(false)} onCreated={() => { setStarting(false); load(); onGoalChanged(); }} />,
    );
  }

  const header = (
    <div className="flex items-center gap-3 flex-wrap">
      {isLivePilot(pilot) ? (
        <button onClick={cancel} className={dangerBtn}>Cancel pipeline</button>
      ) : (
        <button onClick={() => setStarting(true)} className={primaryBtn}>
          {pilot.phase === 'cancelled' ? 'Start over' : 'Run again'}
        </button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (waitingOnPlanner(pilot)) body = <PlannerWait pilot={pilot} agents={agents} onChanged={load} />;
  else if (pilot.phase === 'clarifying') body = <QuestionsStep pilot={pilot} onChanged={load} />;
  else if (pilot.phase === 'proposed') body = meta ? <PlanStep key={pilot.updatedAt} pilot={pilot} meta={meta} onChanged={load} /> : null;
  else if (pilot.phase === 'staffing') body = meta ? <StaffStep pilot={pilot} meta={meta} onChanged={load} /> : null;
  else if (pilot.phase === 'cancelled' && pilot.stages.length === 0) body = <p className="text-[13px] text-gray-500">This pilot was cancelled before anything ran.</p>;
  else body = <PipelineStep pilot={pilot} goal={goal} agents={agents} onChanged={load} onGoalChanged={onGoalChanged} />;

  return shell(
    <>
      <Stepper pilot={pilot} />
      {body}
      <FeatureFilesCard goalId={goal.id} />
      {pilot.phase !== 'clarifying' && <Conversation pilot={pilot} />}
      {pilot.phase === 'clarifying' && pilot.rounds.length > 1 && <Conversation pilot={{ ...pilot, rounds: pilot.rounds.slice(0, -1) }} />}
      {error && <p className="text-[13px] text-amber-300">{error}</p>}
    </>,
    header,
  );
}
