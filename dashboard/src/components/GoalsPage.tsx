import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { Goal, Project } from '../types';

// ── helpers ──────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
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
  const [budgetStr, setBudgetStr] = useState(initial?.budgetUsd != null ? String(initial.budgetUsd) : '');
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
          <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Budget cap (USD, optional)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={budgetStr}
            onChange={(e) => setBudgetStr(e.target.value)}
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
          onClick={() => onSave({ name: name.trim(), description: description.trim(), successMetric: successMetric.trim(), budgetUsd: budgetStr ? parseFloat(budgetStr) : null, status })}
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
  onSave: (data: { name: string; description: string; goalId: string | null; primaryRepo: string; color: string }) => void;
  onCancel: () => void;
}

function ProjectForm({ goals, initial, onSave, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [goalId, setGoalId] = useState<string | null>(initial?.goalId || null);
  const [primaryRepo, setPrimaryRepo] = useState(initial?.primaryRepo || '');
  const [color, setColor] = useState(initial?.color || '#a855f7');

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
        <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">Primary repo path (optional)</label>
        <input
          value={primaryRepo}
          onChange={(e) => setPrimaryRepo(e.target.value)}
          placeholder="/Users/you/projects/my-repo"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25"
        />
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
          onClick={() => onSave({ name: name.trim(), description: description.trim(), goalId, primaryRepo: primaryRepo.trim(), color })}
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
}

function ProjectCard({ project, onEdit, onDelete }: ProjectCardProps) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} />
          <span className="text-sm font-medium text-gray-200 truncate">{project.name}</span>
        </div>
        <div className="flex gap-1 flex-shrink-0">
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
      <div className="flex items-center gap-3 text-[11px] text-gray-600 mt-auto pt-1 border-t border-white/[0.05]">
        {project.primaryRepo && (
          <span className="truncate max-w-[120px]" title={project.primaryRepo}>
            {project.primaryRepo.split('/').pop()}
          </span>
        )}
        <span>{project.runCount ?? 0} runs</span>
        {(project.estimatedCostUsd ?? 0) > 0 && (
          <span className="text-violet-400">{formatCost(project.estimatedCostUsd!)}</span>
        )}
      </div>
    </div>
  );
}

interface GoalCardProps {
  goal: Goal;
  projects: Project[];
  expanded: boolean;
  onToggle: () => void;
  onEditGoal: (g: Goal) => void;
  onDeleteGoal: (id: string) => void;
  onEditProject: (p: Project) => void;
  onDeleteProject: (id: string) => void;
  onAddProject: (goalId: string) => void;
}

function GoalCard({ goal, projects, expanded, onToggle, onEditGoal, onDeleteGoal, onEditProject, onDeleteProject, onAddProject }: GoalCardProps) {
  const totalCost = projects.reduce((s, p) => s + (p.estimatedCostUsd ?? 0), 0);
  const budgetPct = goal.budgetUsd && totalCost > 0 ? Math.min(100, (totalCost / goal.budgetUsd) * 100) : null;

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
            {totalCost > 0 && <span className="text-violet-400">{formatCost(totalCost)} spent</span>}
            {goal.budgetUsd && <span>/ {formatCost(goal.budgetUsd)} budget</span>}
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
          {projects.length === 0 ? (
            <p className="text-[12px] text-gray-600 mt-3">No projects yet — add one to start tracking work against this goal.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} onEdit={onEditProject} onDelete={onDeleteProject} />
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
        </div>
      )}
    </div>
  );
}

// ── modal wrapper ─────────────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#111] border border-white/10 rounded-xl p-5 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
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
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // Modal state
  const [modal, setModal] = useState<
    | { type: 'new-goal' }
    | { type: 'edit-goal'; goal: Goal }
    | { type: 'new-project'; goalId: string | null }
    | { type: 'edit-project'; project: Project }
    | null
  >(null);

  const refresh = useCallback(async () => {
    const [g, p] = await Promise.all([api.getGoals(), api.getGoalProjects()]);
    setGoals(g);
    setProjects(p);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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
          <h2 className="text-gray-300 text-sm font-semibold uppercase tracking-wide">Goals</h2>
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
              expanded={expandedGoals.has(goal.id)}
              onToggle={() => toggleGoal(goal.id)}
              onEditGoal={(g) => setModal({ type: 'edit-goal', goal: g })}
              onDeleteGoal={handleDeleteGoal}
              onEditProject={(p) => setModal({ type: 'edit-project', project: p })}
              onDeleteProject={handleDeleteProject}
              onAddProject={(goalId) => setModal({ type: 'new-project', goalId })}
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
    </div>
  );
}
