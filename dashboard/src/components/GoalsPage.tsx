import { useState, useEffect, useCallback, useRef } from 'react';
import { SectionTitle } from './SectionTitle';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import type { Goal, Project, ProjectLearning, Heartbeat, Task } from '../types';

// ── FolderPicker ──────────────────────────────────────────────────────────────

interface FolderPickerProps {
  value: string;
  onChange: (path: string) => void;
}

function FolderPicker({ value, onChange }: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState<{ current: string; parent: string | null; dirs: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function browse(path?: string) {
    setLoading(true);
    try {
      const result = await api.browseDir(path) as { current: string; parent: string | null; dirs: string[] };
      setBrowsing(result);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  function handleOpen() {
    setOpen(true);
    setManualMode(false);
    browse(value || undefined);
  }

  function handleSelect(path: string) {
    onChange(path);
    setOpen(false);
    setBrowsing(null);
  }

  function handleEnterDir(dirName: string) {
    if (!browsing) return;
    browse(`${browsing.current}/${dirName}`);
  }

  const displayName = value ? value.split('/').filter(Boolean).pop() || value : '';

  if (manualMode) {
    return (
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/Users/you/projects/my-repo"
          className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
        <button
          type="button"
          onClick={() => setManualMode(false)}
          className="text-[11px] text-gray-500 hover:text-gray-300 whitespace-nowrap"
        >
          Use picker
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <div className="flex gap-2">
        <div
          className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm flex items-center gap-2 min-w-0 cursor-pointer hover:border-white/20"
          onClick={handleOpen}
        >
          {value ? (
            <>
              <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              <span className="text-gray-200 truncate">{displayName}</span>
              <span className="text-gray-600 text-[11px] truncate hidden sm:block">{value}</span>
            </>
          ) : (
            <span className="text-gray-600">Browse to select folder…</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleOpen}
          className="px-3 py-2 text-xs text-gray-400 bg-black/40 border border-white/10 rounded-md hover:border-white/20 hover:text-gray-200 transition-colors whitespace-nowrap"
        >
          Browse…
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-full bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden">
          {/* Current path breadcrumb */}
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between">
            <span className="text-[11px] text-gray-500 truncate flex-1">{browsing?.current || '…'}</span>
            {value && (
              <button
                type="button"
                onClick={() => handleSelect(browsing?.current || value)}
                className="ml-2 text-[11px] text-violet-400 hover:text-violet-300 whitespace-nowrap"
              >
                Select this folder
              </button>
            )}
          </div>

          {loading ? (
            <div className="px-3 py-4 text-[12px] text-gray-600 text-center">Loading…</div>
          ) : browsing ? (
            <div className="max-h-48 overflow-y-auto py-1">
              {browsing.parent && (
                <button
                  type="button"
                  onClick={() => browse(browsing.parent!)}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-gray-500 hover:bg-white/[0.04] flex items-center gap-2"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                  <span>..</span>
                </button>
              )}
              {browsing.dirs.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-gray-600">No subdirectories</div>
              )}
              {browsing.dirs.map((dir) => {
                const fullPath = `${browsing.current}/${dir}`;
                return (
                  <div key={dir} className="flex items-center group">
                    <button
                      type="button"
                      onClick={() => handleEnterDir(dir)}
                      className="flex-1 text-left px-3 py-1.5 text-[12px] text-gray-300 hover:bg-white/[0.04] flex items-center gap-2 min-w-0"
                    >
                      <svg className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                      </svg>
                      <span className="truncate">{dir}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelect(fullPath)}
                      className="pr-3 text-[11px] text-violet-500 hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
                    >
                      Select
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="border-t border-white/[0.06] px-3 py-2">
            <button
              type="button"
              onClick={() => { setOpen(false); setManualMode(true); }}
              className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
            >
              Enter path manually instead
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `~${(n / 1000).toFixed(0)}K tokens`;
  return `~${(n / 1_000_000).toFixed(1)}M tokens`;
}

// Real USD spent (from session_usage), denominated for the goal/project budget view.
function formatUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}

function statusBadge(status: Goal['status']) {
  const map: Record<Goal['status'], { label: string; cls: string }> = {
    active:   { label: 'Active',   cls: 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50' },
    achieved: { label: 'Achieved', cls: 'bg-blue-900/40 text-blue-400 border-blue-800/50' },
    paused:   { label: 'Paused',   cls: 'bg-yellow-900/40 text-yellow-400 border-yellow-800/50' },
  };
  const { label, cls } = map[status];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>{label}</span>;
}

const PROJECT_COLORS = [
  '#a855f7', '#3b82f6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#06b6d4', '#84cc16',
];

// ── sub-components ────────────────────────────────────────────────────────────

interface GoalFormProps {
  initial?: Partial<Goal>;
  onSave: (data: { name: string; description: string; successMetric: string; budgetUsd: number | null; status: Goal['status'] }) => void;
  onCancel: () => void;
}

function GoalForm({ initial, onSave, onCancel }: GoalFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [successMetric, setSuccessMetric] = useState(initial?.successMetric || '');
  const [budgetUsdStr, setBudgetUsdStr] = useState(initial?.budgetUsd != null ? String(initial.budgetUsd) : '');
  const [status, setStatus] = useState<Goal['status']>(initial?.status || 'active');

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Goal name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ship authentication v2"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Mission / why this matters</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Describe the business objective behind this goal"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Success metric — what does done look like?</label>
        <input
          value={successMetric}
          onChange={(e) => setSuccessMetric(e.target.value)}
          placeholder="e.g. All auth flows pass E2E, deployed to prod"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Budget cap — USD (optional)</label>
          <input
            type="number"
            min="0"
            step="1"
            value={budgetUsdStr}
            onChange={(e) => setBudgetUsdStr(e.target.value)}
            placeholder="e.g. 50"
            className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
          />
        </div>
        {initial && (
          <div>
            <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Goal['status'])}
              className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="active">Active</option>
              <option value="achieved">Achieved</option>
              <option value="paused">Paused</option>
            </select>
          </div>
        )}
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), successMetric: successMetric.trim(), budgetUsd: budgetUsdStr ? parseFloat(budgetUsdStr) : null, status })}
          disabled={!name.trim()}
          className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
        >
          {initial ? 'Save' : 'Create Goal'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ProjectFormProps {
  goals: Goal[];
  initial?: Partial<Project>;
  onSave: (data: { name: string; description: string; goalId: string | null; primaryRepo: string; color: string; cartridges: string[] }) => void;
  onCancel: () => void;
}

function ProjectForm({ goals, initial, onSave, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [goalId, setGoalId] = useState<string | null>(initial?.goalId || null);
  const [primaryRepo, setPrimaryRepo] = useState(initial?.primaryRepo || '');
  const [color, setColor] = useState(initial?.color || '#a855f7');
  // The cartridges this project owns. Seeded from primaryRepo for a project created before
  // projects had a set, so editing an old project does not silently unlink it.
  const [cartridges, setCartridges] = useState<string[]>(
    initial?.cartridges?.length ? initial.cartridges : (initial?.primaryRepo ? [initial.primaryRepo] : []),
  );
  // Every repo a cartridge has ever registered in — the real candidates, deduped.
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    api.getAgents()
      .then((as) => setKnown([...new Set(as.map((a) => a.repoPath).filter(Boolean))].sort()))
      .catch(() => setKnown([]));
  }, []);
  const toggle = (repo: string) =>
    setCartridges((prev) => (prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo]));

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Project name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Auth service refactor"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What work does this project cover?"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Goal (optional)</label>
        <select
          value={goalId || ''}
          onChange={(e) => setGoalId(e.target.value || null)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
        >
          <option value="">— No goal —</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Codebase — for doc output &amp; save-to-project (optional)</label>
        <FolderPicker value={primaryRepo} onChange={setPrimaryRepo} />
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
          Cartridges — every repo whose work belongs to this project
        </label>
        {known.length === 0 ? (
          <p className="text-[11px] text-gray-600">No cartridges have registered yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {known.map((repo) => (
              <button
                key={repo}
                onClick={() => toggle(repo)}
                title={repo}
                className={`px-2 py-1 text-[11px] rounded transition-colors ${
                  cartridges.includes(repo)
                    ? 'bg-violet-900/60 text-violet-200'
                    : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'
                }`}
              >
                {repo.split('/').pop()}
              </button>
            ))}
          </div>
        )}
        <p className="text-[10px] text-gray-600 mt-1">
          Anything these cartridges do — prompts, confers, workflow runs — counts as this
          project's work. Nothing needs tagging.
        </p>
      </div>
      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Color</label>
        <div className="flex gap-2 flex-wrap">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full transition-transform ${color === c ? 'ring-2 ring-white scale-110' : 'hover:scale-105'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), goalId, primaryRepo: primaryRepo.trim(), color, cartridges })}
          disabled={!name.trim()}
          className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
        >
          {initial ? 'Save' : 'Create Project'}
        </button>
        <button onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ProjectCardProps {
  project: Project;
  onEdit: (p: Project) => void;
  onDelete: (id: string) => void;
  onLearnings: (p: Project) => void;
  onHeartbeats: (p: Project) => void;
  onRun: (p: Project) => void;
}

function ProjectCard({ project, onEdit, onDelete, onLearnings, onHeartbeats, onRun }: ProjectCardProps) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} />
          <span className="text-sm font-medium text-gray-200 truncate">{project.name}</span>
          {(project.activeRunCount ?? 0) > 0
            ? <span className="inline-flex items-center gap-1 text-[10px] text-blue-400 bg-blue-900/30 border border-blue-700/30 rounded-full px-1.5 py-0.5 flex-shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />{project.activeRunCount} running</span>
            : project.lastRunStatus && <RunStatusDot status={project.lastRunStatus} />
          }
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            onClick={() => onRun(project)}
            className="text-gray-600 hover:text-violet-400 transition-colors p-0.5"
            title="Run workflow"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
          </button>
          <button onClick={() => onEdit(project)} className="text-gray-600 hover:text-gray-300 transition-colors p-0.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
          </button>
          <button onClick={() => onDelete(project.id)} className="text-gray-600 hover:text-red-400 transition-colors p-0.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>
      {project.description && (
        <p className="text-[12px] text-gray-500 leading-relaxed line-clamp-2">{project.description}</p>
      )}
      <div className="flex items-center justify-between gap-2 mt-auto pt-1 border-t border-white/[0.05]">
        <div className="flex items-center gap-3 text-[11px] text-gray-600">
          {project.primaryRepo && (
            <span className="truncate max-w-[100px]" title={project.primaryRepo}>
              {project.primaryRepo.split('/').pop()}
            </span>
          )}
          <span>{project.runCount ?? 0} runs</span>
          {(project.tokensUsed ?? 0) > 0 && (
            <span className="text-violet-400">{formatTokens(project.tokensUsed!)}</span>
          )}
          {(project.costUsd ?? 0) > 0 && (
            <span className="text-emerald-400" title="Real spend on this cartridge (from session usage)">{formatUsd(project.costUsd!)}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onHeartbeats(project)}
            className="text-[10px] text-gray-600 hover:text-emerald-400 transition-colors flex items-center gap-1"
            title="Scheduled runs"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Schedule
          </button>
          <button
            onClick={() => onLearnings(project)}
            className="text-[10px] text-gray-600 hover:text-violet-400 transition-colors flex items-center gap-1"
            title="Workflow learnings"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
            Learnings
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectLearningsPanel({ project }: { project: Project; onClose: () => void }) {
  const [learnings, setLearnings] = useState<ProjectLearning[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getProjectLearnings(project.id).then((data) => {
      setLearnings(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [project.id]);

  function formatRelativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  return (
    <div className="space-y-3">
      {loading ? (
        <p className="text-[12px] text-gray-500">Loading learnings...</p>
      ) : learnings.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-[12px] text-gray-600">No learnings captured yet.</p>
          <p className="text-[11px] text-gray-700 mt-1">Add a "Capture Learnings" connector step at the end of a workflow to start building project memory.</p>
        </div>
      ) : (
        learnings.map((l) => (
          <div key={l.id} className="bg-black/30 border border-white/[0.07] rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] font-medium text-violet-400">{l.workflowName}</span>
              <span className="text-[10px] text-gray-600">{formatRelativeTime(l.createdAt)}</span>
              {l.tags.length > 0 && l.tags.map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-gray-500">{t}</span>
              ))}
            </div>
            <pre className="text-[11px] text-gray-400 whitespace-pre-wrap leading-relaxed font-sans line-clamp-6">{l.content}</pre>
          </div>
        ))
      )}
    </div>
  );
}

function RunStatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-500',
    running:   'bg-blue-400 animate-pulse',
    failed:    'bg-red-500',
    paused:    'bg-yellow-500',
  };
  const cls = map[status] || 'bg-gray-600';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} title={status} />;
}

function LaunchFromProjectModal({ project, onClose }: { project: Project; onClose: (runId?: string) => void }) {
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; repoName: string; status: string }[]>([]);
  const [learningsCount, setLearningsCount] = useState(0);
  const [templateId, setTemplateId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [note, setNote] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.getWorkflows().then((ws) => ws.filter((w) => !w.templateId).map((w) => ({ id: w.id, name: w.name }))),
      api.getAgents().then((as) => as.filter((a) => a.status !== 'offline').map((a) => ({ id: a.id, name: a.name, repoName: a.repoName, status: a.status }))),
      api.getProjectLearnings(project.id, 3).then((ls) => ls.length).catch(() => 0),
    ]).then(([tmps, ags, count]) => { setTemplates(tmps); setAgents(ags); setLearningsCount(count); });
  }, [project.id]);

  async function handleLaunch() {
    if (!templateId) return;
    setLaunching(true);
    setError('');
    try {
      const result = await api.startWorkflowV2(
        templateId,
        agentId ? { [templateId]: agentId } : undefined,
        undefined,
        note.trim() || undefined,
        project.id,
      );
      onClose(result?.workflow?.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Launch failed');
      setLaunching(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Workflow template</label>
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
        >
          <option value="">— Select template —</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Agent (optional)</label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
        >
          <option value="">— Any available —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.repoName || a.name} ({a.status})</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Run note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Additional context for this run…"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 resize-none"
        />
      </div>

      {learningsCount > 0 && (
        <div className="flex items-center gap-2 bg-violet-900/20 border border-violet-700/30 rounded-lg px-3 py-2">
          <svg className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
          </svg>
          <span className="text-[12px] text-violet-300">{learningsCount} past learning{learningsCount !== 1 ? 's' : ''} will be auto-injected as context</span>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleLaunch}
          disabled={!templateId || launching}
          className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm rounded-md transition-colors"
        >
          {launching ? 'Launching…' : 'Launch'}
        </button>
        <button onClick={() => onClose()} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
      </div>
    </div>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface HeartbeatFormData {
  templateId: string;
  agentId: string;
  scheduleType: 'hourly' | 'daily' | 'weekly';
  scheduleTime: string;
  scheduleDay: number;
  label: string;
  active: boolean;
}

const EMPTY_FORM: HeartbeatFormData = {
  templateId: '', agentId: '', scheduleType: 'daily',
  scheduleTime: '09:00', scheduleDay: 1, label: '', active: true,
};

function HeartbeatsPanel({ project }: { project: Project; onClose: () => void }) {
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; repoName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<HeartbeatFormData>(EMPTY_FORM);
  const [firing, setFiring] = useState<string | null>(null);
  const [firedRun, setFiredRun] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getHeartbeats(project.id),
      api.getWorkflows().then((ws) => ws.filter((w) => !w.templateId).map((w) => ({ id: w.id, name: w.name }))),
      api.getAgents().then((as) => as.map((a) => ({ id: a.id, name: a.name, repoName: a.repoName }))),
    ]).then(([hbs, tmps, ags]) => {
      setHeartbeats(hbs);
      setTemplates(tmps);
      setAgents(ags);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [project.id]);

  async function handleSave() {
    const schedule = {
      type: form.scheduleType,
      ...(form.scheduleType !== 'hourly' && { time: form.scheduleTime }),
      ...(form.scheduleType === 'weekly' && { day: form.scheduleDay }),
    };
    try {
      if (editingId) {
        const updated = await api.updateHeartbeat(editingId, {
          templateId: form.templateId, agentId: form.agentId,
          schedule, label: form.label, active: form.active,
        });
        setHeartbeats((prev) => prev.map((h) => (h.id === editingId ? updated : h)));
      } else {
        const created = await api.createHeartbeat({
          projectId: project.id, templateId: form.templateId, agentId: form.agentId,
          schedule, label: form.label, active: form.active,
        });
        setHeartbeats((prev) => [created, ...prev]);
      }
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (e) { /* no-op */ }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this scheduled run?')) return;
    await api.deleteHeartbeat(id);
    setHeartbeats((prev) => prev.filter((h) => h.id !== id));
  }

  async function handleFire(id: string) {
    setFiring(id);
    try {
      const result = await api.fireHeartbeat(id);
      setFiredRun(result.runId);
      const updated = await api.getHeartbeats(project.id);
      setHeartbeats(updated);
    } catch { /* no-op */ } finally {
      setFiring(null);
    }
  }

  function startEdit(h: Heartbeat) {
    setForm({
      templateId: h.templateId,
      agentId: h.agentId,
      scheduleType: h.schedule.type,
      scheduleTime: h.schedule.time || '09:00',
      scheduleDay: h.schedule.day ?? 1,
      label: h.label,
      active: h.active,
    });
    setEditingId(h.id);
    setShowForm(true);
  }

  function formatRelativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function formatNextRun(iso: string) {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff < 0) return 'overdue';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.floor(hrs / 24)}d`;
  }

  if (loading) return <p className="text-[12px] text-gray-500">Loading...</p>;

  return (
    <div className="space-y-3">
      {firedRun && (
        <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <span className="text-[12px] text-emerald-400">Run started — ID: {firedRun.slice(0, 8)}…</span>
          <button onClick={() => setFiredRun(null)} className="text-emerald-600 hover:text-emerald-400 text-[11px]">dismiss</button>
        </div>
      )}

      {!showForm && (
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
          className="flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-violet-400 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Schedule a recurring run
        </button>
      )}

      {showForm && (
        <div className="bg-black/30 border border-white/[0.07] rounded-lg p-3 space-y-3">
          <h4 className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider">
            {editingId ? 'Edit schedule' : 'New scheduled run'}
          </h4>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Label (optional)</label>
            <input
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              placeholder="e.g. Weekly code health check"
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Workflow template</label>
            <select
              value={form.templateId}
              onChange={(e) => setForm((f) => ({ ...f, templateId: e.target.value }))}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="">— Select template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1">Agent (optional)</label>
            <select
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
            >
              <option value="">— Any available agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.repoName || a.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <div>
              <label className="block text-[11px] text-gray-500 mb-1">Frequency</label>
              <select
                value={form.scheduleType}
                onChange={(e) => setForm((f) => ({ ...f, scheduleType: e.target.value as HeartbeatFormData['scheduleType'] }))}
                className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            {form.scheduleType !== 'hourly' && (
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Time</label>
                <input
                  type="time"
                  value={form.scheduleTime}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleTime: e.target.value }))}
                  className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
                />
              </div>
            )}
            {form.scheduleType === 'weekly' && (
              <div>
                <label className="block text-[11px] text-gray-500 mb-1">Day</label>
                <select
                  value={form.scheduleDay}
                  onChange={(e) => setForm((f) => ({ ...f, scheduleDay: parseInt(e.target.value) }))}
                  className="bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
                >
                  {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="hb-active"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              className="rounded border-white/20 bg-black/40"
            />
            <label htmlFor="hb-active" className="text-[12px] text-gray-400">Active</label>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!form.templateId}
              className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm rounded-md transition-colors"
            >
              {editingId ? 'Save' : 'Create'}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}
              className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {heartbeats.length === 0 && !showForm ? (
        <p className="text-[12px] text-gray-600">No scheduled runs yet.</p>
      ) : (
        heartbeats.map((h) => (
          <div key={h.id} className={`bg-black/30 border rounded-lg p-3 ${h.active ? 'border-white/[0.07]' : 'border-white/[0.04] opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${h.active ? 'bg-emerald-500' : 'bg-gray-600'}`} />
                  <span className="text-[12px] font-medium text-gray-200 truncate">{h.label || h.templateName || h.templateId.slice(0, 8)}</span>
                </div>
                <p className="text-[11px] text-gray-500 ml-4">{h.scheduleLabel}</p>
                {h.templateName && h.label && (
                  <p className="text-[10px] text-gray-600 ml-4 mt-0.5">{h.templateName}</p>
                )}
                <div className="flex gap-3 text-[10px] text-gray-700 ml-4 mt-1">
                  {h.lastRunAt && <span>Last: {formatRelativeTime(h.lastRunAt)}</span>}
                  <span>Next: {formatNextRun(h.nextRunAt)}</span>
                  {h.agentName && <span>Agent: {h.agentName}</span>}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => handleFire(h.id)}
                  disabled={firing === h.id}
                  className="text-gray-600 hover:text-emerald-400 disabled:opacity-40 transition-colors p-0.5"
                  title="Fire now"
                >
                  {firing === h.id ? (
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                    </svg>
                  )}
                </button>
                <button onClick={() => startEdit(h)} className="text-gray-600 hover:text-gray-300 transition-colors p-0.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                  </svg>
                </button>
                <button onClick={() => handleDelete(h.id)} className="text-gray-600 hover:text-red-400 transition-colors p-0.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

interface GoalCardProps {
  goal: Goal;
  projects: Project[];
  tasks: Task[];
  expanded: boolean;
  onToggle: () => void;
  onEditGoal: (g: Goal) => void;
  onDeleteGoal: (id: string) => void;
  onEditProject: (p: Project) => void;
  onDeleteProject: (id: string) => void;
  onAddProject: (goalId: string) => void;
  onLearnings: (p: Project) => void;
  onHeartbeats: (p: Project) => void;
  onRun: (p: Project) => void;
}

const TASK_STATUS_DOT: Record<string, string> = {
  queued: 'bg-gray-500',
  claimed: 'bg-blue-400',
  in_progress: 'bg-violet-400 animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-yellow-600',
};

function GoalCard({ goal, projects, tasks, expanded, onToggle, onEditGoal, onDeleteGoal, onEditProject, onDeleteProject, onAddProject, onLearnings, onHeartbeats, onRun }: GoalCardProps) {
  const totalTokens = projects.reduce((s, p) => s + (p.tokensUsed ?? 0), 0);
  // Budget bar is driven by REAL spend ($ from session_usage, counting both
  // workflows and tasks) against the goal's dollar cap.
  const spentUsd = goal.costUsd ?? 0;
  const budgetPct = goal.budgetUsd && spentUsd > 0 ? Math.min(100, (spentUsd / goal.budgetUsd) * 100) : null;
  // Tasks roll up to the goal through their project (Task → Project → Goal).
  const projectIds = new Set(projects.map((p) => p.id));
  const goalTasks = tasks.filter((t) => t.projectId && projectIds.has(t.projectId));
  const activeTasks = goalTasks.filter((t) => ['queued', 'claimed', 'in_progress'].includes(t.status));

  return (
    <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl overflow-hidden">
      {/* Goal header */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
        onClick={onToggle}
      >
        <svg className={`w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-gray-100">{goal.name}</span>
            {statusBadge(goal.status)}
          </div>
          {goal.successMetric && (
            <p className="text-[12px] text-gray-500">
              <span className="text-gray-600">Done when: </span>{goal.successMetric}
            </p>
          )}
          <div className="flex items-center gap-4 mt-2 text-[11px] text-gray-600">
            <span>{goal.projectCount ?? projects.length} projects</span>
            <span>{goal.runCount ?? 0} runs</span>
            {goalTasks.length > 0 && (
              <span>{activeTasks.length} active {activeTasks.length === 1 ? 'task' : 'tasks'}</span>
            )}
            {spentUsd > 0 && (
              <span className="text-emerald-400 font-medium" title="Real spend across this goal's cartridges — workflows + tasks, cache-inclusive (from session usage)">{formatUsd(spentUsd)} spent</span>
            )}
            {goal.budgetUsd && <span>/ {formatUsd(goal.budgetUsd)} budget</span>}
            {totalTokens > 0 && <span className="text-violet-400/60" title="Workflow token estimate (does not include tasks)">{formatTokens(totalTokens)} · workflows</span>}
          </div>
          {budgetPct !== null && (
            <div className="mt-2 h-1 bg-white/10 rounded-full overflow-hidden w-48">
              <div
                className={`h-full rounded-full transition-all ${budgetPct >= 90 ? 'bg-red-500' : budgetPct >= 70 ? 'bg-yellow-500' : 'bg-violet-500'}`}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
          )}
        </div>
        <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => onEditGoal(goal)} className="text-gray-600 hover:text-gray-300 transition-colors p-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
          </button>
          <button onClick={() => onDeleteGoal(goal.id)} className="text-gray-600 hover:text-red-400 transition-colors p-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* Projects grid */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-white/[0.05]">
          {budgetPct !== null && budgetPct >= 90 && (
            <div className={`mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] font-medium ${budgetPct >= 100 ? 'bg-red-900/30 border border-red-700/40 text-red-400' : 'bg-yellow-900/30 border border-yellow-700/40 text-yellow-400'}`}>
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              {budgetPct >= 100 ? `Budget cap reached — heartbeats paused` : `${Math.round(budgetPct)}% of budget used — approaching cap`}
            </div>
          )}
          {projects.length === 0 ? (
            <p className="text-[12px] text-gray-600 mt-3">No projects yet — add one to start tracking work against this goal.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} onEdit={onEditProject} onDelete={onDeleteProject} onLearnings={onLearnings} onHeartbeats={onHeartbeats} onRun={onRun} />
              ))}
            </div>
          )}
          <button
            onClick={() => onAddProject(goal.id)}
            className="mt-3 flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-violet-400 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add project
          </button>

          {/* Tasks queued against this goal's projects */}
          {goalTasks.length > 0 && (
            <div className="mt-4">
              <h4 className="text-[11px] text-gray-600 uppercase tracking-wider mb-2">Tasks</h4>
              <div className="space-y-1.5">
                {goalTasks.slice(0, 8).map((t) => {
                  const project = projects.find((p) => p.id === t.projectId);
                  return (
                    <div key={t.id} className="flex items-center gap-2 text-[12px] bg-black/20 border border-white/[0.05] rounded-md px-2.5 py-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TASK_STATUS_DOT[t.status] || 'bg-gray-600'}`} title={t.status} />
                      <span className="text-gray-300 truncate flex-1">{t.title}</span>
                      {project && (
                        <span className="text-[10px] flex-shrink-0" style={{ color: project.color }} title={project.name}>
                          {project.name}
                        </span>
                      )}
                    </div>
                  );
                })}
                {goalTasks.length > 8 && (
                  <p className="text-[11px] text-gray-600 pl-1">+{goalTasks.length - 8} more</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#111] border border-white/10 rounded-xl p-5 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function GoalsPage() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Modal state
  const [modal, setModal] = useState<
    | { type: 'new-goal' }
    | { type: 'edit-goal'; goal: Goal }
    | { type: 'new-project'; goalId: string | null }
    | { type: 'edit-project'; project: Project }
    | { type: 'learnings'; project: Project }
    | { type: 'heartbeats'; project: Project }
    | { type: 'run'; project: Project }
    | null
  >(null);

  const refresh = useCallback(async () => {
    const [g, p, t] = await Promise.all([api.getGoals(), api.getGoalProjects(), api.getTasks()]);
    setGoals(g);
    setProjects(p);
    setTasks(t);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh project stats when runs start/complete or heartbeats fire
  useSocket({
    onWorkflowUpdated: useCallback(() => { refresh(); }, [refresh]),
    onReconnect: useCallback(() => { refresh(); }, [refresh]),
  });

  const toggleGoal = (id: string) => {
    setExpandedGoals((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Goals CRUD
  const handleCreateGoal = async (data: Parameters<typeof api.createGoal>[0]) => {
    const goal = await api.createGoal(data);
    setGoals((prev) => [goal, ...prev]);
    setExpandedGoals((prev) => new Set([...prev, goal.id]));
    setModal(null);
  };

  const handleUpdateGoal = async (id: string, data: Parameters<typeof api.updateGoal>[1]) => {
    const updated = await api.updateGoal(id, data);
    setGoals((prev) => prev.map((g) => (g.id === id ? updated : g)));
    setModal(null);
  };

  const handleDeleteGoal = async (id: string) => {
    if (!confirm('Delete this goal? Projects under it will lose their goal association.')) return;
    await api.deleteGoal(id);
    setGoals((prev) => prev.filter((g) => g.id !== id));
  };

  // Projects CRUD
  const handleCreateProject = async (data: Parameters<typeof api.createProject>[0]) => {
    const project = await api.createProject(data);
    setProjects((prev) => [project, ...prev]);
    setModal(null);
  };

  const handleUpdateProject = async (id: string, data: Parameters<typeof api.updateProject>[1]) => {
    const updated = await api.updateProject(id, data);
    setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
    setModal(null);
  };

  const handleDeleteProject = async (id: string) => {
    if (!confirm('Delete this project?')) return;
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  // Ungrouped projects (no goal)
  const ungroupedProjects = projects.filter((p) => !p.goalId);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-sm text-gray-500">Loading...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <SectionTitle>Goals</SectionTitle>
          <p className="text-[12px] text-gray-600 mt-0.5">Business objectives and the projects advancing them</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setModal({ type: 'new-project', goalId: null })}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 border border-white/10 hover:border-white/20 px-3 py-1.5 rounded-md transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Project
          </button>
          <button
            onClick={() => setModal({ type: 'new-goal' })}
            className="flex items-center gap-1.5 text-xs text-white bg-violet-600 hover:bg-violet-500 px-3 py-1.5 rounded-md transition-colors font-medium"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Goal
          </button>
        </div>
      </div>

      {/* Goals list */}
      {goals.length === 0 && ungroupedProjects.length === 0 ? (
        <div className="text-center py-16 border border-white/[0.06] rounded-xl bg-white/[0.02]">
          <div className="text-3xl mb-3">🎯</div>
          <h3 className="text-sm font-medium text-gray-400 mb-1">No goals yet</h3>
          <p className="text-[12px] text-gray-600 max-w-xs mx-auto">
            Goals connect your AI workflows to business objectives. Set a goal, create projects under it, and every workflow run counts toward something.
          </p>
          <button
            onClick={() => setModal({ type: 'new-goal' })}
            className="mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-md transition-colors"
          >
            Create your first goal
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              projects={projects.filter((p) => p.goalId === goal.id)}
              tasks={tasks}
              expanded={expandedGoals.has(goal.id)}
              onToggle={() => toggleGoal(goal.id)}
              onEditGoal={(g) => setModal({ type: 'edit-goal', goal: g })}
              onDeleteGoal={handleDeleteGoal}
              onEditProject={(p) => setModal({ type: 'edit-project', project: p })}
              onDeleteProject={handleDeleteProject}
              onAddProject={(goalId) => setModal({ type: 'new-project', goalId })}
              onLearnings={(p) => setModal({ type: 'learnings', project: p })}
              onHeartbeats={(p) => setModal({ type: 'heartbeats', project: p })}
              onRun={(p) => setModal({ type: 'run', project: p })}
            />
          ))}

          {/* Ungrouped projects */}
          {ungroupedProjects.length > 0 && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
              <h3 className="text-[11px] text-gray-600 uppercase tracking-wider mb-3">Projects without a goal</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {ungroupedProjects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    onEdit={(proj) => setModal({ type: 'edit-project', project: proj })}
                    onDelete={handleDeleteProject}
                    onLearnings={(proj) => setModal({ type: 'learnings', project: proj })}
                    onHeartbeats={(proj) => setModal({ type: 'heartbeats', project: proj })}
                    onRun={(proj) => setModal({ type: 'run', project: proj })}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {modal?.type === 'new-goal' && (
        <Modal title="New Goal" onClose={() => setModal(null)}>
          <GoalForm onSave={handleCreateGoal} onCancel={() => setModal(null)} />
        </Modal>
      )}

      {modal?.type === 'edit-goal' && (
        <Modal title="Edit Goal" onClose={() => setModal(null)}>
          <GoalForm
            initial={modal.goal}
            onSave={(data) => handleUpdateGoal(modal.goal.id, data)}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'new-project' && (
        <Modal title="New Project" onClose={() => setModal(null)}>
          <ProjectForm
            goals={goals}
            initial={modal.goalId ? { goalId: modal.goalId } : undefined}
            onSave={handleCreateProject}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'edit-project' && (
        <Modal title="Edit Project" onClose={() => setModal(null)}>
          <ProjectForm
            goals={goals}
            initial={modal.project}
            onSave={(data) => handleUpdateProject(modal.project.id, data)}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.type === 'learnings' && (
        <Modal title={`Learnings — ${modal.project.name}`} onClose={() => setModal(null)}>
          <ProjectLearningsPanel project={modal.project} onClose={() => setModal(null)} />
        </Modal>
      )}

      {modal?.type === 'heartbeats' && (
        <Modal title={`Scheduled Runs — ${modal.project.name}`} onClose={() => setModal(null)}>
          <HeartbeatsPanel project={modal.project} onClose={() => setModal(null)} />
        </Modal>
      )}

      {modal?.type === 'run' && (
        <Modal title={`Run Workflow — ${modal.project.name}`} onClose={() => setModal(null)}>
          <LaunchFromProjectModal
            project={modal.project}
            onClose={(runId) => {
              setModal(null);
              if (runId) refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
