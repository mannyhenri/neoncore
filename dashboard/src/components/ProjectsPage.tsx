/**
 * PROJECTS → FEATURES.
 *
 *   Project   a name, what it is, and the repos/cartridges involved
 *     └─ Features   the list of things to build, in order — "these are the 10 features I want"
 *          └─ Pipeline   taken one at a time: the planner scopes the feature with you, proposes
 *                        the workflows, you pick the repos, it runs (GoalPilotPanel)
 *
 * A feature is a goal row filed under its project (goals.project_id), so everything the goal
 * pipeline does — scoping questions, the brief every agent receives, the acceptance contract,
 * cost, progress, the report — carries over unchanged. This page is the new way in.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────────────────
 * One column, the full width of the work area: `ProjectPicker` (a dropdown, at the top — the bar
 * App puts above the page) chooses the project, and `ProjectsWorkspace` (the project's tabs and
 * feature list, or one feature's pipeline) fills everything under it. They share one store through `ProjectsProvider`, which stays mounted across
 * view switches and fetches only while the view is active. The selection lives in the URL
 * (lib/projectSelection.ts), so a project and a feature can be linked to and survive a refresh.
 */
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, createContext, useContext, useId } from 'react';
import { createPortal } from 'react-dom';
import { ProjectRewards } from './rewards/ProjectRewards';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import type { Goal, Project, Task, Agent } from '../types';
import { GoalDraftPanel } from './GoalDraftPanel';
import { GoalPilotPanel } from './GoalPilotPanel';
import {
  ProjectForm, FeatureForm, ProjectLearningsPanel, HeartbeatsPanel, LaunchFromProjectModal, Modal,
  INTENT_FIELDS, IntentBlock, TASK_STATUS_DOT, formatUsd, type ProjectFormData,
} from './ProjectParts';
import { UNFILED, parseProjectHash, projectHash, resolveProjectSelection, type ProjectRequest } from '../lib/projectSelection';
import { featureStatus, nextUp, anyInFlight, TONE_PILL, TONE_DOT, type FeatureStatus } from '../lib/featureStatus';
import { progressView, healthView } from '../lib/goalRollup';
import { DocsBar, SpecTab, RoadmapTab, ChangelogTab, ArchitectureTab } from './ProjectHub';
import { DesignSystemTab } from './DesignSystemTab';
import { SegMeter, PageTitle, AiWorkingBar } from './SectionTitle';

const primaryBtn = 'h-10 px-4 btn-primary rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const quietBtn = 'h-10 px-4 btn-ghost rounded-[10px] text-[13px] font-semibold transition-colors disabled:opacity-40';
const iconBtn = 'h-9 px-3 btn-ghost rounded-[10px] text-[12px] font-semibold text-gray-300 transition-colors';

const repoName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A project's repos: its cartridges, plus the primary repo for a project from before it had a set. */
function projectRepos(p: Project): string[] {
  return [...new Set([...(p.cartridges ?? []), p.primaryRepo].filter(Boolean))];
}

// ── shared state ──────────────────────────────────────────────────────────────

type ModalState =
  | { type: 'new-project' }
  | { type: 'edit-project'; project: Project }
  | { type: 'learnings'; project: Project }
  | { type: 'heartbeats'; project: Project }
  | { type: 'run'; project: Project }
  | { type: 'edit-feature'; feature: Goal }
  | { type: 'draft'; feature: Goal }
  | { type: 'move-feature'; feature: Goal }
  | null;

interface ProjectsContextValue {
  projects: Project[];
  /** Every feature (goal), in each project's build order. */
  features: Goal[];
  tasks: Task[];
  agents: Agent[];
  loading: boolean;
  /** Changes on every refresh — a dependency for views that load their own data. */
  version: number;
  /** What the workspace can actually show — already resolved, never the raw request. */
  selection: ProjectRequest;
  selectProject: (projectId: string) => void;
  /** Open a feature; `start` opens it straight onto its first questions (the list's "Start"). */
  openFeature: (feature: Goal, opts?: { start?: boolean }) => void;
  /** The feature whose "Start" was just clicked — its page opens onto the questions. */
  startRequested: string | null;
  modal: ModalState;
  setModal: (m: ModalState) => void;
  refresh: () => Promise<void>;
  createProject: (data: ProjectFormData) => Promise<void>;
  updateProject: (id: string, data: ProjectFormData) => Promise<void>;
  deleteProject: (p: Project) => Promise<void>;
  addFeatures: (projectId: string, names: string[]) => Promise<void>;
  updateFeature: (id: string, data: Parameters<typeof api.updateGoal>[1]) => Promise<void>;
  deleteFeature: (f: Goal) => Promise<void>;
  moveFeature: (projectId: string, featureId: string, delta: -1 | 1) => Promise<void>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

function useProjects(): ProjectsContextValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error('ProjectPicker/ProjectsWorkspace must render inside <ProjectsProvider>');
  return ctx;
}

export function ProjectsProvider({ active, agents, children }: { active: boolean; agents: Agent[]; children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [features, setFeatures] = useState<Goal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [startRequested, setStartRequested] = useState<string | null>(null);
  const [requested, setRequested] = useState<ProjectRequest | null>(() =>
    typeof window === 'undefined' ? null : parseProjectHash(window.location.hash));

  // Bumped on every refresh, so views that fetch their own data (the spec, the changelog) refetch too.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(async () => {
    const [p, g, t] = await Promise.all([api.getGoalProjects(), api.getGoals(), api.getTasks()]);
    setVersion((v) => v + 1);
    setProjects(p);
    // Build order. The server sends them sorted; sorting again keeps any other source honest.
    setFeatures([...g].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    setTasks(t);
    setLoading(false);
  }, []);

  // Workflow and pipeline events arrive in bursts (every step of a run emits). One refresh per
  // burst is enough — the list is recomputed server-side, and ten in a second would be ten full
  // rollups for the same picture.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = useCallback(() => {
    if (!active || pending.current) return;
    pending.current = setTimeout(() => { pending.current = null; refresh().catch(() => {}); }, 1200);
  }, [active, refresh]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  useEffect(() => { if (active) refresh().catch(() => setLoading(false)); }, [active, refresh]);

  useEffect(() => {
    const onHash = () => setRequested(parseProjectHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useSocket({
    onWorkflowUpdated: refreshSoon,
    onGoalPilotUpdated: refreshSoon,
    onReconnect: refreshSoon,
  });

  const hasUnfiled = features.some((f) => !f.projectId || !projects.some((p) => p.id === f.projectId));
  const selection = useMemo(
    () => resolveProjectSelection({ projectIds: projects.map((p) => p.id), features, hasUnfiled, requested }),
    [projects, features, hasUnfiled, requested],
  );

  const go = useCallback((projectId: string, featureId: string | null) => {
    window.location.hash = projectHash(projectId, featureId);
    setRequested({ projectId, featureId });
    window.scrollTo({ top: 0 });
  }, []);

  const selectProject = useCallback((projectId: string) => { setStartRequested(null); go(projectId, null); }, [go]);
  const openFeature = useCallback((f: Goal, opts?: { start?: boolean }) => {
    setStartRequested(opts?.start ? f.id : null);
    go(f.projectId || UNFILED, f.id);
  }, [go]);

  const createProject = useCallback(async (data: ProjectFormData) => {
    const p = await api.createProject(data);
    setProjects((prev) => [p, ...prev]);
    setModal(null);
    go(p.id, null);
  }, [go]);

  const updateProject = useCallback(async (id: string, data: ProjectFormData) => {
    const p = await api.updateProject(id, data);
    setProjects((prev) => prev.map((x) => (x.id === id ? p : x)));
    setModal(null);
  }, []);

  const deleteProject = useCallback(async (p: Project) => {
    const n = features.filter((f) => f.projectId === p.id).length;
    if (!confirm(n
      ? `Delete "${p.name}" and its ${n} feature${n === 1 ? '' : 's'}? Running pipelines are stopped. Runs already made stay in the history.`
      : `Delete "${p.name}"?`)) return;
    await api.deleteProject(p.id);
    await refresh();
  }, [features, refresh]);

  const addFeatures = useCallback(async (projectId: string, names: string[]) => {
    const clean = names.map((n) => n.trim()).filter(Boolean);
    if (clean.length === 0) return;
    await api.addProjectFeatures(projectId, clean.map((name) => ({ name })));
    await refresh();
  }, [refresh]);

  const updateFeature = useCallback(async (id: string, data: Parameters<typeof api.updateGoal>[1]) => {
    await api.updateGoal(id, data);
    setModal(null);
    await refresh();
  }, [refresh]);

  const deleteFeature = useCallback(async (f: Goal) => {
    if (!confirm(`Delete the feature "${f.name}"? Its pipeline is stopped; runs already made stay in the history.`)) return;
    await api.deleteGoal(f.id);
    if (f.projectId) go(f.projectId, null);
    await refresh();
  }, [go, refresh]);

  const moveFeature = useCallback(async (projectId: string, featureId: string, delta: -1 | 1) => {
    // The build order — features that already existed (imported) are not part of it.
    const list = features.filter((f) => f.projectId === projectId && f.origin !== 'imported');
    const i = list.findIndex((f) => f.id === featureId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const ids = list.map((f) => f.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    // Instant on screen; the server confirms the order on the refresh.
    setFeatures((prev) => {
      const pos = new Map(ids.map((id, k) => [id, k]));
      return prev.map((f) => (pos.has(f.id) ? { ...f, position: pos.get(f.id)! } : f))
        .sort((a, b) => (a.projectId === b.projectId ? (a.position ?? 0) - (b.position ?? 0) : 0));
    });
    await api.reorderProjectFeatures(projectId, ids);
    await refresh();
  }, [features, refresh]);

  const value: ProjectsContextValue = {
    projects, features, tasks, agents, loading, version, selection, selectProject, openFeature, startRequested,
    modal, setModal, refresh, createProject, updateProject, deleteProject, addFeatures, updateFeature, deleteFeature, moveFeature,
  };
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

// ── small pieces ──────────────────────────────────────────────────────────────

function StatusPill({ status, className = '' }: { status: FeatureStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-full border whitespace-nowrap ${TONE_PILL[status.tone]} ${className}`}>
      <span className={`w-[7px] h-[7px] rounded-full shadow-[0_0_8px_currentColor] ${TONE_DOT[status.tone]}`} />
      {status.label}
    </span>
  );
}

/** The three steps, drawn once — on the empty state and above an unstarted feature. */
function HowItWorks({ compact = false }: { compact?: boolean }) {
  const steps = [
    ['Project', 'Name it and pick the repos & cartridges involved.'],
    ['Features', 'List everything you want built, in order.'],
    ['One at a time', 'A planner scopes each feature with you, picks the workflows, and runs them.'],
  ];
  return (
    <ol className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3'} text-left`}>
      {steps.map(([title, body], i) => (
        <li key={title} className="rounded-[14px] border border-white/[0.08] bg-gl-surface/60 px-3.5 py-3">
          <div className="flex items-center gap-2 text-[14px] text-gray-100 font-semibold">
            <span className="w-6 h-6 rounded-full btn-primary font-semibold text-[12px] flex items-center justify-center">{i + 1}</span>
            {title}
          </div>
          <p className="text-[12px] text-gray-500 mt-1 leading-snug">{body}</p>
        </li>
      ))}
    </ol>
  );
}

/** Which of a project's repos have a cartridge running in them right now. */
function useRepoLiveness(agents: Agent[]) {
  return useMemo(() => {
    const live = new Map<string, string[]>();
    for (const a of agents) {
      if (!a.repoPath || a.status === 'offline') continue;
      const k = norm(a.repoPath);
      live.set(k, [...(live.get(k) ?? []), a.agentType || 'claude']);
    }
    return (repo: string) => [...new Set(live.get(norm(repo)) ?? [])];
  }, [agents]);
}

const ENGINE_SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

function RepoChips({ repos, agents }: { repos: string[]; agents: Agent[] }) {
  const liveIn = useRepoLiveness(agents);
  return (
    <div className="flex flex-wrap gap-1.5">
      {repos.map((r) => {
        const engines = liveIn(r);
        return (
          <span key={r} title={`${r}${engines.length ? ` — running: ${engines.map((e) => ENGINE_SHORT[e] ?? e).join(', ')}` : ' — no cartridge running'}`}
            className="inline-flex items-center gap-1.5 text-[12px] font-mono px-2.5 py-1 rounded-full bg-white/[0.04] border border-white/[0.12] text-gray-300">
            <span className={`w-1.5 h-1.5 rounded-full ${engines.length ? 'bg-emerald-400 shadow-[0_0_6px_#4ADE80]' : 'bg-gray-600'}`} />
            {repoName(r)}
            {engines.length > 0 && <span className="text-[11px] text-gray-500">{engines.map((e) => ENGINE_SHORT[e] ?? e).join(' · ')}</span>}
          </span>
        );
      })}
    </div>
  );
}

// ── the rail (left 1/3) ───────────────────────────────────────────────────────

const NEW_PROJECT_BTN = 'h-10 px-4 text-[13px] btn-primary font-semibold rounded-[10px] transition-colors';

/** What a project's row says under its name: how far its features are, its repos, what it has cost. */
function ProjectFacts({ p }: { p: Project }) {
  const total = p.featureCount ?? 0;
  const done = p.featuresDone ?? 0;
  const repos = projectRepos(p);
  return (
    <span className="flex items-center gap-2 text-[12px] text-gray-400 flex-wrap">
      <span>{total === 0 ? ((p.featuresExisting ?? 0) > 0 ? 'none planned yet' : 'no features yet') : `${done}/${total} features done`}</span>
      {(p.featuresExisting ?? 0) > 0 && <span className="text-sky-300/80">{p.featuresExisting} existing</span>}
      {(p.featuresActive ?? 0) > 0 && <span className="text-violet-300">{p.featuresActive} in progress</span>}
      <span>· {repos.length === 0 ? <span className="text-ember-300">no repos</span> : `${repos.length} repo${repos.length === 1 ? '' : 's'}`}</span>
      {(p.costUsd ?? 0) > 0 && <span className="text-emerald-400">{formatUsd(p.costUsd!)}</span>}
    </span>
  );
}
const NeedsYou = ({ n }: { n: number }) => (n > 0 ? (
  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-ember-500/[0.14] border border-ember-500/50 text-ember-300 whitespace-nowrap">{n} need{n === 1 ? 's' : ''} you</span>
) : null);

/**
 * THE PROJECT PICKER — which project is on the screen, chosen from a dropdown at the top of the
 * work area. (It was a list down the left side; the page needs that width for the project itself.)
 * The button says the project in front of you; the list is every project, each with how far it
 * is and whether it needs you, then the features that belong to no project, then "+ New project".
 */
export function ProjectPicker() {
  const { projects, features, loading, selection, selectProject, setModal } = useProjects();
  const unfiled = features.filter((f) => !f.projectId || !projects.some((p) => p.id === f.projectId));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The list is drawn OVER the page (a portal, placed under the button): the bar it opens from is
  // a clipped panel, and a list inside it would be cut off at the bar's bottom edge.
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => { const r = button.current?.getBoundingClientRect(); if (r) setAt({ left: r.left, top: r.bottom + 8, width: r.width }); };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const current = projects.find((p) => p.id === selection.projectId) ?? null;
  const onUnfiled = selection.projectId === UNFILED;
  const others = projects.filter((p) => p.id !== current?.id).reduce((n, p) => n + (p.featuresNeedYou ?? 0), 0);
  const pick = (id: string) => { selectProject(id); setOpen(false); };

  return (
    <div ref={box} data-project-picker className="relative flex items-center gap-3 min-w-0 flex-1">
      <button ref={button} type="button" data-project-picker-button aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="min-w-0 flex-1 max-w-[620px] text-left rounded-[12px] border border-neon-500/60 bg-neon-600/[0.1] hover:bg-neon-600/[0.16] px-4 py-2.5 flex items-center gap-3 transition-colors">
        {current ? (
          <>
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: current.color, boxShadow: `0 0 8px ${current.color}` }} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2"><span className="text-[17px] font-semibold text-gray-100 truncate">{current.name}</span><NeedsYou n={current.featuresNeedYou ?? 0} /></span>
              <ProjectFacts p={current} />
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1">
            <span className="block text-[17px] font-semibold text-gray-100 truncate">{loading ? 'Loading…' : onUnfiled ? 'Features without a project' : projects.length === 0 ? 'No projects yet' : 'Choose a project'}</span>
            <span className="block text-[12px] text-gray-400">{onUnfiled ? `${unfiled.length} to file` : projects.length === 0 ? 'A project names the work and the repos involved' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}</span>
          </span>
        )}
        {/* Another project waiting on you is said on the closed picker, so it is not hidden behind it. */}
        {others > 0 && <span data-others-need-you className="text-[11px] font-semibold text-ember-300 whitespace-nowrap" title="Features of other projects are waiting on you">+{others} elsewhere</span>}
        <span aria-hidden="true" className={`text-gray-300 text-[12px] transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      <button onClick={() => setModal({ type: 'new-project' })} className={NEW_PROJECT_BTN}>+ New project</button>

      {open && at && createPortal(
        <div ref={list} role="listbox" aria-label="Projects" style={{ left: at.left, top: at.top, width: Math.max(360, at.width) }}
          className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-[14px] border border-white/[0.14] bg-[#0A1020] shadow-[0_18px_50px_rgba(0,0,0,0.65)] p-2 flex flex-col gap-1.5">
          {projects.length === 0 && unfiled.length === 0 && (
            <p className="text-[13px] text-gray-500 leading-snug px-3 py-3">No projects yet. A project names the work and the repos involved; its features are built one at a time.</p>
          )}
          {projects.map((p) => {
            const active = selection.projectId === p.id;
            const total = p.featureCount ?? 0;
            const done = p.featuresDone ?? 0;
            return (
              <button key={p.id} role="option" aria-selected={active} data-project-option={p.id} onClick={() => pick(p.id)}
                className={`w-full text-left rounded-[10px] border px-3 py-2.5 flex flex-col gap-1.5 transition-colors ${
                  active ? 'bg-neon-600/[0.14] border-neon-500' : (p.featuresNeedYou ?? 0) > 0 ? 'border-ember-500/40 hover:border-ember-500/70 hover:bg-white/[0.03]' : 'border-transparent hover:border-white/[0.16] hover:bg-white/[0.03]'
                }`}>
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color, boxShadow: `0 0 8px ${p.color}` }} />
                  <span className="text-[15px] font-semibold text-gray-100 truncate flex-1">{p.name}</span>
                  <NeedsYou n={p.featuresNeedYou ?? 0} />
                </span>
                <ProjectFacts p={p} />
                {total > 0 && (
                  <span aria-hidden="true" className="flex gap-[2px]">
                    {Array.from({ length: 20 }, (_, k) => (
                      <span key={k} className={`flex-1 h-[4px] rounded-[1px] ${k < Math.round((20 * done) / total) ? 'bg-neon-500 shadow-[0_0_4px_#5AAEFF]' : 'bg-neon-500/[0.14]'}`} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
          {unfiled.length > 0 && (
            <button role="option" aria-selected={onUnfiled} data-project-option={UNFILED} onClick={() => pick(UNFILED)}
              className={`w-full text-left rounded-[10px] border border-dashed px-3 py-2.5 transition-colors ${onUnfiled ? 'bg-ember-500/[0.08] border-ember-500/50' : 'border-white/[0.16] hover:bg-white/[0.03]'}`}>
              <span className="block text-[13px] text-gray-300">Features without a project</span>
              <span className="block text-[13px] text-ember-300 mt-0.5">{unfiled.length} to file — goals from before projects held features</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── the project: its features ─────────────────────────────────────────────────

function FeatureRow({ feature, index, count, highlight }: { feature: Goal; index: number; count: number; highlight: boolean }) {
  const { openFeature, moveFeature } = useProjects();
  const st = featureStatus(feature);
  const start = st.key === 'backlog';
  return (
    <div
      className={`group flex items-center gap-3 rounded-[14px] border px-4 py-3 transition-colors ${
        highlight
          ? 'border-neon-500/60 bg-neon-600/[0.1] shadow-[0_0_20px_rgba(90,174,255,0.18)]'
          : st.needsYou
            ? 'border-ember-500/45 bg-ember-500/[0.06]'
            : 'border-white/[0.08] bg-gl-surface/60 hover:border-white/[0.18]'
      }`}
    >
      <div className="flex flex-col -my-1 opacity-40 group-hover:opacity-100 transition-opacity">
        <button type="button" aria-label="Move up" title="Build earlier" disabled={index === 0}
          onClick={() => moveFeature(feature.projectId!, feature.id, -1)} className="text-[11px] text-gray-400 hover:text-white disabled:opacity-20 leading-none py-0.5">▲</button>
        <button type="button" aria-label="Move down" title="Build later" disabled={index === count - 1}
          onClick={() => moveFeature(feature.projectId!, feature.id, 1)} className="text-[11px] text-gray-400 hover:text-white disabled:opacity-20 leading-none py-0.5">▼</button>
      </div>
      <span className="font-mono text-[13px] text-gray-500 w-5 text-right tabular-nums">{index + 1}</span>
      <button type="button" onClick={() => openFeature(feature)} className="flex-1 min-w-0 text-left">
        <div className={`text-[15px] font-semibold truncate ${st.key === 'done' ? 'text-gray-500 line-through decoration-gray-600' : 'text-gray-100'}`}>{feature.name}</div>
        {feature.description && st.key === 'backlog' && (
          <div className="text-[12px] text-gray-500 truncate">{feature.description}</div>
        )}
        {st.progress !== null && st.key !== 'done' && (
          <SegMeter pct={st.progress * 100} cells={16} height={8} className="mt-2 max-w-[240px]" />
        )}
        {st.key === 'thinking' && <AiWorkingBar label={st.label} cells={16} className="mt-2 max-w-[240px]" />}
      </button>
      <StatusPill status={st} className="hidden sm:inline-flex" />
      <button
        type="button"
        onClick={() => openFeature(feature, { start })}
        className={start || st.needsYou ? (highlight || st.needsYou ? primaryBtn : quietBtn) : quietBtn}
      >
        {start ? '▶ Start' : st.action}
      </button>
    </div>
  );
}

/** Type a feature and press Enter — or paste a whole list, one per line. */
function AddFeatures({ projectId, empty }: { projectId: string; empty: boolean }) {
  const { addFeatures } = useProjects();
  const [text, setText] = useState('');
  const [many, setMany] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const lines = many ? text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean) : [text.trim()].filter(Boolean);

  const submit = async () => {
    if (lines.length === 0) return;
    setBusy(true); setError('');
    try {
      await addFeatures(projectId, lines);
      setText('');
      if (!many) inputRef.current?.focus();
      setMany(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not add'); } finally { setBusy(false); }
  };

  return (
    <div className={`rounded-[14px] border border-dashed ${empty ? 'border-neon-500/50 bg-neon-600/[0.06] p-4' : 'border-white/[0.16] p-3'}`}>
      {empty && (
        <p className="text-[13px] text-gray-300 mb-2">
          What do you want built? Add the features — one at a time, or paste your whole list.
        </p>
      )}
      {many ? (
        <textarea
          autoFocus
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'One feature per line, in the order you want them built:\nSign in with Google\nExport invoices as CSV\nDark mode'}
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-[13px] text-gray-200 placeholder-gray-500 focus:outline-none"
        />
      ) : (
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          onPaste={(e) => {
            // A pasted list becomes a list, not one feature with newlines in its name.
            const t = e.clipboardData.getData('text');
            if (t.includes('\n')) { e.preventDefault(); setMany(true); setText(t); }
          }}
          placeholder="Add a feature — e.g. “Export invoices as CSV” — and press Enter"
          className="w-full glass-input rounded-[10px] px-3 py-2.5 text-[13px] text-gray-200 placeholder-gray-500 focus:outline-none"
        />
      )}
      <div className="flex items-center justify-between gap-2 mt-2">
        <button type="button" onClick={() => setMany((m) => !m)} className="text-[12px] text-gray-500 hover:text-gray-300">
          {many ? 'Add just one' : 'Paste several (one per line)'}
        </button>
        <div className="flex items-center gap-2">
          {error && <span className="text-[12px] text-ember-300">{error}</span>}
          <button type="button" onClick={submit} disabled={busy || lines.length === 0} className={primaryBtn}>
            {busy ? 'Adding…' : lines.length > 1 ? `Add ${lines.length} features` : 'Add feature'}
          </button>
        </div>
      </div>
    </div>
  );
}

type ProjectTab = 'design' | 'features' | 'spec' | 'roadmap' | 'changelog' | 'architecture';
const PROJECT_TABS: { key: ProjectTab; label: string; hint: string }[] = [
  // The roadmap comes first: it is where the project is planned (vision → epics → features) before anything is built.
  { key: 'roadmap', label: 'Roadmap', hint: 'Vision → epics → features on a timeline — plan here first; what you add is in Features too' },
  { key: 'design', label: 'Design system', hint: 'The project\'s colours, type and components — what every feature is built to' },
  { key: 'features', label: 'Features', hint: 'The same features as the roadmap, in build order — start the next one here' },
  { key: 'spec', label: 'Spec', hint: 'Every feature\'s intent beside what was verified' },
  { key: 'changelog', label: 'Changelog', hint: 'What shipped, by release' },
  { key: 'architecture', label: 'Architecture', hint: 'How it is built — a page with diagrams, generated from the codebase' },
];

/** "Already in the product": features that existed before NeonCore (generated from the codebase). */
function ExistingFeatures({ list, onOpenSpec }: { list: Goal[]; onOpenSpec: () => void }) {
  const [open, setOpen] = useState(false);
  if (list.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen((o) => !o)} className="text-[12px] text-gray-500 hover:text-gray-300 uppercase tracking-[0.12em]">
          {open ? '▾' : '▸'} Already in the product <span className="text-gray-500 normal-case tracking-normal">· {list.length} documented from the codebase</span>
        </button>
        <button onClick={onOpenSpec} className="text-[12px] text-neon-400 hover:text-neon-300">Their specs →</button>
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {list.map((f) => (
            <div key={f.id} className="rounded-[12px] border border-white/[0.1] bg-gl-surface/60 px-3 py-2">
              <div className="text-[13px] text-gray-200 truncate">{f.name}</div>
              {f.description && <div className="text-[12px] text-gray-500 truncate" title={f.description}>{f.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectDetail({ project }: { project: Project }) {
  const { features, tasks, agents, setModal, deleteProject, openFeature, refresh, version } = useProjects();
  const [tab, setTab] = useState<ProjectTab>('features');
  const all = features.filter((f) => f.projectId === project.id);
  const mine = all.filter((f) => f.origin !== 'imported');
  const existing = all.filter((f) => f.origin === 'imported');
  const openById = (id: string) => { const f = features.find((x) => x.id === id); if (f) openFeature(f); };
  const repos = projectRepos(project);
  const next = nextUp(mine);
  const busy = anyInFlight(mine);
  const done = mine.filter((f) => featureStatus(f).key === 'done').length;
  const myTasks = tasks.filter((t) => t.projectId === project.id);
  const activeTasks = myTasks.filter((t) => ['queued', 'claimed', 'in_progress'].includes(t.status));

  return (
    // data-stage-head: how many of the first blocks are the page's HEAD — they sit beside the captain (index.css).
    <div className="space-y-5" data-stage-head="2">
      {/* Identity */}
      <div className="panel-live rounded-[22px] p-6 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <PageTitle>
              <span className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ backgroundColor: project.color, boxShadow: `0 0 10px ${project.color}` }} />
              <span className="truncate">{project.name}</span>
            </PageTitle>
            {project.description && <p className="text-[14px] text-gray-400 mt-1.5 max-w-2xl leading-relaxed">{project.description}</p>}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={() => setModal({ type: 'edit-project', project })} className={iconBtn}>Edit</button>
            <button onClick={() => setModal({ type: 'run', project })} className={iconBtn} title="Run one workflow in this project, outside a feature">Run a workflow</button>
            <button onClick={() => setModal({ type: 'heartbeats', project })} className={iconBtn} title="Recurring runs">Schedule</button>
            <button onClick={() => setModal({ type: 'learnings', project })} className={iconBtn} title="What earlier runs learned">Learnings</button>
            <button onClick={() => deleteProject(project)} className="h-9 px-3 rounded-[10px] text-[12px] font-semibold border border-red-400/45 text-red-200 hover:bg-red-500/10 transition-colors">Delete</button>
          </div>
        </div>
      </div>

      {/* Repos & cartridges */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-[12px] text-gray-500 uppercase tracking-[0.12em]">Repos &amp; cartridges</h3>
          {/* Asked for: "edit the repos/cartridges loaded into a project". The project form already
              edits them; this puts the way in beside the list it changes, not only in the header. */}
          {repos.length > 0 && (
            <button onClick={() => setModal({ type: 'edit-project', project })} className="text-[12px] font-semibold text-neon-400 hover:text-neon-200 transition-colors">
              Edit repos
            </button>
          )}
        </div>
        {repos.length === 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-ember-500/45 bg-ember-500/[0.08] shadow-[0_0_22px_rgba(255,138,61,0.12)] px-3 py-2.5">
            <p className="text-[13px] text-ember-300">Add the repos this project works in — every feature is built in them.</p>
            <button onClick={() => setModal({ type: 'edit-project', project })} className={quietBtn}>Add repos</button>
          </div>
        ) : (
          <RepoChips repos={repos} agents={agents} />
        )}
      </div>

      {/* What the project has earned so far — counted from its own records. */}
      <ProjectRewards project={project} version={version} />

      {/* The project's views: the list you build from, and the documents it becomes. */}
      <div role="tablist" aria-label="Project views" className="flex items-center gap-1 p-1 rounded-xl bg-gl-surface/70 border border-white/[0.08] overflow-x-auto w-fit max-w-full">
        {PROJECT_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} title={t.hint} aria-current={tab === t.key ? 'page' : undefined}
            className={`h-9 px-4 rounded-lg text-[13px] font-semibold whitespace-nowrap transition-colors ${
              tab === t.key ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'design' && <DesignSystemTab project={project} />}
      {tab !== 'features' && tab !== 'design' && <DocsBar project={project} onChanged={refresh} />}
      {tab === 'spec' && <SpecTab project={project} agents={agents} version={version} onOpenFeature={openById} onChanged={refresh} />}
      {tab === 'roadmap' && <RoadmapTab project={project} agents={agents} version={version} onOpenFeature={openById} onChanged={refresh} />}
      {tab === 'changelog' && <ChangelogTab project={project} agents={agents} version={version} onChanged={refresh} />}
      {tab === 'architecture' && <ArchitectureTab project={project} agents={agents} version={version} onChanged={refresh} />}

      {tab === 'features' && (<>
      {/* The features */}
      <div>
        <div className="flex items-end justify-between gap-2 mb-2">
          <div>
            <h3 className="text-[12px] text-gray-500 uppercase tracking-[0.12em]">Features</h3>
            {mine.length > 0 && <p className="text-[12px] text-gray-500 mt-0.5">In the order you want them built · {done} of {mine.length} done</p>}
          </div>
          {(project.costUsd ?? 0) > 0 && <span className="text-[12px] text-emerald-400" title="Real spend across the project's repos">{formatUsd(project.costUsd!)} spent</span>}
        </div>

        {mine.length > 0 && (
          <SegMeter pct={(done / mine.length) * 100} cells={40} height={18} className="mb-4" label={`${done} of ${mine.length} features done`} />
        )}

        {/* The next thing to do, said once, at the top: nothing is in flight, so pick up the next. */}
        {next && !busy && (
          <div className="panel-live flex items-center justify-between gap-3 rounded-[18px] px-5 py-4 mb-3">
            <div className="min-w-0">
              <div className="text-[12px] text-neon-300 uppercase tracking-[0.12em]">Up next</div>
              <div className="font-display text-[18px] font-semibold neon-text truncate">{next.name}</div>
            </div>
            <button onClick={() => openFeature(next, { start: true })} className={primaryBtn}>▶ Start this feature</button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {mine.map((f, i) => (
            <FeatureRow key={f.id} feature={f} index={i} count={mine.length} highlight={!busy && next?.id === f.id} />
          ))}
        </div>
        <div className="mt-2">
          <AddFeatures projectId={project.id} empty={mine.length === 0} />
        </div>
        {mine.length === 0 && existing.length === 0 && (
          <p className="text-[12px] text-gray-500 mt-2">
            Picking up a product that already exists?{' '}
            <button onClick={() => setTab('spec')} className="text-neon-400 hover:text-neon-300">✦ Document what it already does, and the backlog the code points at</button>
            {' · '}<button onClick={() => setTab('architecture')} className="text-neon-400 hover:text-neon-300">its architecture</button>
            {' · '}<button onClick={() => setTab('changelog')} className="text-neon-400 hover:text-neon-300">its changelog</button>.
          </p>
        )}
        <ExistingFeatures list={existing} onOpenSpec={() => setTab('spec')} />
      </div>

      {/* Tasks pinned to this project (the Tasks view holds the full queue) */}
      {myTasks.length > 0 && (
        <div>
          <h3 className="text-[12px] text-gray-500 uppercase tracking-[0.12em] mb-2">
            Tasks {activeTasks.length > 0 && <span className="normal-case tracking-normal text-gray-500">· {activeTasks.length} active</span>}
          </h3>
          <div className="space-y-1.5">
            {myTasks.slice(0, 8).map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 text-[14px] bg-gl-surface/60 border border-white/[0.08] rounded-[12px] px-3 py-2.5 min-h-[40px]">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TASK_STATUS_DOT[t.status] || 'bg-gray-600'}`} title={t.status} />
                <span className="text-gray-300 truncate flex-1">{t.title}</span>
                <span className="text-[11px] text-gray-500">{t.status.replace('_', ' ')}</span>
              </div>
            ))}
            {myTasks.length > 8 && <p className="text-[12px] text-gray-500 pl-1">+{myTasks.length - 8} more in the Tasks view</p>}
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}

// ── one feature: its pipeline ─────────────────────────────────────────────────

function FeatureDetail({ feature, project }: { feature: Goal; project: Project | undefined }) {
  const { features, agents, setModal, deleteFeature, selectProject, openFeature, refresh, startRequested, updateFeature } = useProjects();
  // "Feature 3 of 7" counts the build list; an existing (documented) feature counts among its own kind.
  const siblings = features.filter((f) => (f.projectId || '') === (feature.projectId || '') && (project || !f.projectId)
    && (f.origin === 'imported') === (feature.origin === 'imported'));
  const idx = siblings.findIndex((f) => f.id === feature.id);
  const prev = idx > 0 ? siblings[idx - 1] : undefined;
  const nextF = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : undefined;
  const st = featureStatus(feature);
  const repos = project ? projectRepos(project) : [];
  const spent = feature.costUsd ?? 0;
  const budgetPct = feature.budgetUsd && spent > 0 ? Math.min(100, (spent / feature.budgetUsd) * 100) : null;
  const filled = INTENT_FIELDS.filter((f) => f.read(feature).trim()).length;
  const upNext = nextUp(siblings.filter((f) => f.id !== feature.id));
  const hv = healthView(feature.health);
  const pv = progressView(feature);

  return (
    <div className="space-y-5" data-stage-head="2">
      {/* Where am I */}
      <div className="flex items-center gap-2 text-[13px] text-gray-500 flex-wrap">
        <button onClick={() => selectProject(project ? project.id : UNFILED)} className="hover:text-gray-200 flex items-center gap-1.5">
          <span aria-hidden="true">←</span>
          {project && <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />}
          {project ? project.name : 'Features without a project'}
        </button>
        {idx >= 0 && <span className="text-gray-700">·</span>}
        {idx >= 0 && <span>Feature {idx + 1} of {siblings.length}</span>}
      </div>

      {/* Identity */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <PageTitle className="flex-wrap">
            <span className="truncate">{feature.name}</span>
            <StatusPill status={st} />
          </PageTitle>
          {feature.description && <p className="text-[14px] text-gray-400 mt-1.5 max-w-2xl leading-relaxed">{feature.description}</p>}
          {feature.successMetric && (
            <p className="text-[14px] text-gray-300 mt-1"><span className="text-gray-500">Done when: </span>{feature.successMetric}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {feature.origin !== 'imported' && st.key !== 'done' && project && (
            <select
              aria-label="Roadmap column"
              title="Where it sits on the project's roadmap. Automatic: Now while its pipeline runs, else Next/Later by list position."
              value={feature.roadmapLane || ''}
              onChange={(e) => updateFeature(feature.id, { roadmapLane: e.target.value as '' | 'now' | 'next' | 'later' })}
              className="h-9 text-[12px] font-semibold text-gray-300 glass-input rounded-[10px] px-2.5"
            >
              <option value="">Roadmap: automatic</option>
              <option value="now">Roadmap: Now</option>
              <option value="next">Roadmap: Next</option>
              <option value="later">Roadmap: Later</option>
            </select>
          )}
          {project && (
            <AreaField
              key={feature.id}
              value={feature.area || ''}
              suggestions={[...new Set(siblings.map((f) => f.area || '').filter(Boolean))].sort()}
              onSave={(area) => updateFeature(feature.id, { area })}
            />
          )}
          <button onClick={() => setModal({ type: 'edit-feature', feature })} className={iconBtn}>Edit</button>
          <button onClick={() => setModal({ type: 'move-feature', feature })} className={iconBtn} title="Move it to another project">Move to project…</button>
          {st.key === 'finished' && (
            <button onClick={() => updateFeature(feature.id, { status: 'achieved' })} className={primaryBtn}>✓ Mark done</button>
          )}
          {st.key === 'done' && (
            <button onClick={() => updateFeature(feature.id, { status: 'active' })} className={iconBtn}>Reopen</button>
          )}
          <button onClick={() => deleteFeature(feature)} className="h-9 px-3 rounded-[10px] text-[12px] font-semibold border border-red-400/45 text-red-200 hover:bg-red-500/10 transition-colors">Delete</button>
        </div>
      </div>

      {!project && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-ember-500/45 bg-ember-500/[0.08] shadow-[0_0_22px_rgba(255,138,61,0.12)] px-3 py-2.5">
          <p className="text-[13px] text-ember-300">This feature is not in a project yet. File it so it runs in the project's repos.</p>
          <button onClick={() => setModal({ type: 'move-feature', feature })} className={quietBtn}>Move to a project</button>
        </div>
      )}

      {/* Does anything need me? First: it is the only time-sensitive thing on the page. */}
      {hv && (
        <div className={`flex items-start gap-3 px-4 py-3 rounded-[14px] border ${
          hv.tone === 'bad' ? 'bg-red-500/[0.08] border-red-400/50 text-red-200' : 'bg-ember-500/[0.08] border-ember-500/45 text-ember-300 shadow-[0_0_22px_rgba(255,138,61,0.12)]'
        }`}>
          <span className={`mt-1 w-[9px] h-[9px] rounded-full flex-shrink-0 ${hv.tone === 'bad' ? 'bg-red-400 shadow-[0_0_8px_#FF6B6B]' : 'bg-ember-500 shadow-[0_0_8px_#FF8A3D]'}`} aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">{hv.label}</div>
            <p className="text-[13px] opacity-80 mt-0.5">{hv.detail}</p>
            {hv.runName && <p className="text-[12px] opacity-60 mt-0.5">in {hv.runName}</p>}
          </div>
        </div>
      )}

      {st.key === 'backlog' && startRequested !== feature.id && (
        <div className="rounded-[18px] border border-white/[0.1] bg-gl-surface/60 p-5 space-y-3">
          <p className="text-[14px] text-gray-200">This feature has not been started. When you start it:</p>
          <ol className="text-[13px] text-gray-400 space-y-1 list-decimal pl-5">
            <li>you answer a few questions about it, and a planner cartridge asks whatever is still open;</li>
            <li>it writes the brief and the acceptance criteria, and proposes the workflows — you edit and accept;</li>
            <li>you confirm which of the project's repos build it, and the workflows run one after another.</li>
          </ol>
        </div>
      )}

      {/* The pipeline: scope → workflows → repos → run. */}
      <GoalPilotPanel
        key={feature.id}
        goal={feature}
        agents={agents}
        onGoalChanged={refresh}
        projectRepos={repos}
        startOpen={startRequested === feature.id}
      />

      {/* Progress and spend */}
      {(pv.pct !== null || spent > 0 || feature.budgetUsd) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[12px] text-gray-500 uppercase tracking-[0.12em]">Progress</h3>
            <span className="text-[12px] text-gray-500">
              {pv.pct !== null ? `${pv.pct}% · ${pv.text}` : pv.text}
              {spent > 0 && <span className="text-emerald-400"> · {formatUsd(spent)} spent</span>}
              {feature.budgetUsd ? <span> / {formatUsd(feature.budgetUsd)} budget</span> : null}
            </span>
          </div>
          {pv.pct !== null && (
            <SegMeter pct={pv.pct} cells={40} height={18} />
          )}
          {budgetPct !== null && budgetPct >= 90 && (
            <p className={`text-[13px] ${budgetPct >= 100 ? 'text-red-300' : 'text-ember-300'}`}>
              {budgetPct >= 100 ? 'Budget reached — the pipeline pauses before its next stage.' : `${Math.round(budgetPct)}% of the budget used.`}
            </p>
          )}
        </div>
      )}

      {/* What every agent working on it is told. */}
      <details className="group rounded-[18px] border border-white/[0.1] bg-gl-surface/60">
        <summary className="cursor-pointer select-none px-4 py-3 flex items-center justify-between gap-2">
          <span className="text-[12px] text-gray-400 uppercase tracking-[0.12em]">Brief sent to every agent</span>
          <span className={`text-[12px] ${filled === INTENT_FIELDS.length ? 'text-gray-500' : 'text-ember-300'}`}>
            {filled}/{INTENT_FIELDS.length} filled <span className="text-gray-500 group-open:hidden">· show</span>
          </span>
        </summary>
        <div className="px-4 pb-4 space-y-3">
          <div className="flex justify-end">
            <button onClick={() => setModal({ type: 'draft', feature })} className="text-[12px] text-neon-400 hover:text-neon-300"
              title="A cartridge drafts the brief from a sentence or two. You accept it field by field.">
              ✎ Help me write this
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {INTENT_FIELDS.map((f) => <IntentBlock key={f.key} label={f.label} hint={f.hint} value={f.read(feature)} />)}
          </div>
          <p className="text-[12px] text-gray-500">Scoping fills these in when you accept the plan. You can also edit them with Edit above.</p>
        </div>
      </details>

      {/* Finished: celebrate, then offer the next one. */}
      {st.key === 'done' && upNext && (
        <div className="flex items-center justify-between gap-3 rounded-[18px] border border-emerald-400/45 bg-emerald-400/[0.07] shadow-[0_0_22px_rgba(74,222,128,0.12)] px-5 py-4">
          <div className="min-w-0">
            <div className="text-[13px] text-emerald-300">✓ Done. Next on the list:</div>
            <div className="font-display text-[18px] font-semibold text-gray-100 truncate">{upNext.name}</div>
          </div>
          <button onClick={() => openFeature(upNext, { start: true })} className={primaryBtn}>▶ Start it</button>
        </div>
      )}

      {/* Walk the list. */}
      {(prev || nextF) && (
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/[0.06]">
          {prev ? (
            <button onClick={() => openFeature(prev)} className="text-[13px] text-gray-500 hover:text-gray-200 truncate max-w-[45%]">← {prev.name}</button>
          ) : <span />}
          {nextF ? (
            <button onClick={() => openFeature(nextF)} className="text-[13px] text-gray-500 hover:text-gray-200 truncate max-w-[45%]">{nextF.name} →</button>
          ) : <span />}
        </div>
      )}
    </div>
  );
}

// ── features without a project ────────────────────────────────────────────────

function UnfiledDetail() {
  const { projects, features, openFeature, updateFeature } = useProjects();
  const mine = features.filter((f) => !f.projectId || !projects.some((p) => p.id === f.projectId));
  return (
    <div className="space-y-4" data-stage-head="1">
      <div>
        <PageTitle>Features without a project</PageTitle>
        <p className="text-[13px] text-gray-500 mt-1 max-w-2xl leading-relaxed">
          These are goals from before projects held features (a goal that spanned several projects could not be
          filed automatically). File each under the project it belongs to — it then runs in that project's repos.
        </p>
      </div>
      {mine.length === 0 ? (
        <p className="text-[13px] text-gray-500">Nothing left to file.</p>
      ) : (
        <div className="space-y-1.5">
          {mine.map((f) => {
            const st = featureStatus(f);
            return (
              <div key={f.id} className="flex items-center gap-3 rounded-[14px] border border-white/[0.08] bg-gl-surface/60 px-4 py-3">
                <button onClick={() => openFeature(f)} className="flex-1 min-w-0 text-left text-[15px] font-semibold text-gray-100 truncate">{f.name}</button>
                <StatusPill status={st} className="hidden sm:inline-flex" />
                <select
                  aria-label={`Move ${f.name} to a project`}
                  value=""
                  onChange={(e) => { if (e.target.value) updateFeature(f.id, { projectId: e.target.value }); }}
                  className="glass-input rounded-[10px] px-2 py-1.5 text-[13px] text-gray-300"
                >
                  <option value="">Move to…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MoveFeatureForm({ feature, onDone }: { feature: Goal; onDone: () => void }) {
  const { projects, updateFeature } = useProjects();
  const [target, setTarget] = useState(feature.projectId || '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-gray-400">The feature moves to the end of that project's list. Its pipeline and history come with it.</p>
      <select value={target} onChange={(e) => setTarget(e.target.value)}
        className="w-full glass-input rounded-[10px] px-3 py-2.5 text-sm text-gray-200 focus:outline-none">
        <option value="">— Pick a project —</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="flex gap-2">
        <button disabled={!target || target === feature.projectId || busy} className={primaryBtn}
          onClick={async () => { setBusy(true); try { await updateFeature(feature.id, { projectId: target }); onDone(); } finally { setBusy(false); } }}>
          Move
        </button>
        <button onClick={onDone} className="h-10 px-4 btn-ghost rounded-[10px] text-[13px] font-semibold">Cancel</button>
      </div>
    </div>
  );
}

// ── the working surface (right 2/3) ───────────────────────────────────────────

export function ProjectsWorkspace() {
  const { projects, features, agents, loading, selection, modal, setModal, refresh, createProject, updateProject, updateFeature } = useProjects();
  const project = selection.projectId && selection.projectId !== UNFILED ? projects.find((p) => p.id === selection.projectId) : undefined;
  const feature = selection.featureId ? features.find((f) => f.id === selection.featureId) : undefined;

  return (
    <section>
      {loading ? (
        <div className="flex items-center justify-center h-32"><span className="text-sm text-gray-500">Loading…</span></div>
      ) : selection.projectId === null ? (
        <div data-stage-head="0" className="border border-dashed border-neon-500/40 rounded-[22px] p-6 md:p-10 text-center space-y-5">
          <div>
            <div aria-hidden="true" className="flex justify-center gap-1 mb-3"><span className="w-3.5 h-8 rounded-[2px] seg-on" /><span className="w-3.5 h-8 rounded-[2px] seg-on" /><span className="w-3.5 h-8 rounded-[2px] seg-off" /></div>
            <h3 className="font-display text-xl font-semibold text-gray-100">Start with a project</h3>
            <p className="text-[14px] text-gray-400 mt-1.5 max-w-md mx-auto">
              A project is the thing you are building and the repos it lives in. List its features, then build them one at a time.
            </p>
          </div>
          <HowItWorks />
          <button onClick={() => setModal({ type: 'new-project' })} className="h-11 px-5 btn-primary font-semibold text-sm rounded-[10px] transition-colors">
            Create your first project
          </button>
        </div>
      ) : feature ? (
        <FeatureDetail feature={feature} project={project} />
      ) : selection.projectId === UNFILED ? (
        <UnfiledDetail />
      ) : project ? (
        <ProjectDetail project={project} />
      ) : null}

      {modal?.type === 'new-project' && (
        <Modal title="New project" onClose={() => setModal(null)}>
          <ProjectForm onSave={createProject} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === 'edit-project' && (
        <Modal title="Edit project" onClose={() => setModal(null)}>
          <ProjectForm initial={modal.project} onSave={(d) => updateProject(modal.project.id, d)} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === 'learnings' && (
        <Modal title={`Learnings — ${modal.project.name}`} onClose={() => setModal(null)}>
          <ProjectLearningsPanel project={modal.project} />
        </Modal>
      )}
      {modal?.type === 'heartbeats' && (
        <Modal title={`Scheduled runs — ${modal.project.name}`} onClose={() => setModal(null)}>
          <HeartbeatsPanel project={modal.project} />
        </Modal>
      )}
      {modal?.type === 'run' && (
        <Modal title={`Run a workflow — ${modal.project.name}`} onClose={() => setModal(null)}>
          <LaunchFromProjectModal project={modal.project} onClose={(runId) => { setModal(null); if (runId) refresh(); }} />
        </Modal>
      )}
      {modal?.type === 'edit-feature' && (
        <Modal title="Edit feature" onClose={() => setModal(null)}>
          <FeatureForm initial={modal.feature} onSave={(d) => updateFeature(modal.feature.id, d)} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === 'move-feature' && (
        <Modal title={`Move "${modal.feature.name}"`} onClose={() => setModal(null)}>
          <MoveFeatureForm feature={modal.feature} onDone={() => setModal(null)} />
        </Modal>
      )}
      {modal?.type === 'draft' && (
        <Modal title={`Draft the brief — ${modal.feature.name}`} onClose={() => setModal(null)}>
          <GoalDraftPanel goal={modal.feature} agents={agents} onApplied={() => refresh()} onClose={() => setModal(null)} />
        </Modal>
      )}
    </section>
  );
}

/**
 * The feature's capability group on the spec — free text, suggested from the project's other
 * features, so a planned feature joins the same groups the imported ones are in. Saved on blur / Enter.
 */
function AreaField({ value, suggestions, onSave }: { value: string; suggestions: string[]; onSave: (area: string) => void }) {
  const [text, setText] = useState(value);
  const listId = `areas-${useId()}`;
  const save = () => { const v = text.replace(/\s+/g, ' ').trim(); if (v !== value) onSave(v); };
  return (
    <>
      <input
        aria-label="Capability"
        title="Its capability group on the spec — '<group> · <sub-area>', e.g. 'Billing · Invoices'. Executives read the spec by these."
        list={listId}
        value={text}
        placeholder="Capability…"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="h-9 w-48 text-[12px] text-gray-300 glass-input rounded-[10px] px-2.5"
      />
      <datalist id={listId}>{suggestions.map((a) => <option key={a} value={a} />)}</datalist>
    </>
  );
}
