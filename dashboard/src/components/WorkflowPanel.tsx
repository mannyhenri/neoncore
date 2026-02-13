import { useState, useEffect, useCallback } from 'react';
import type { Agent, WorkflowTemplate, WorkflowRun, WorkflowStep } from '../types';
import { api } from '../lib/api';

interface Props {
  agents: Agent[];
}

// ─── Command Presets ─────────────────────────────────

interface CommandGroup {
  label: string;
  commands: { value: string; label: string }[];
}

const COMMAND_PRESETS: CommandGroup[] = [
  {
    label: 'Quick Actions',
    commands: [
      { value: '/full-review', label: '/full-review' },
      { value: '/full-test', label: '/full-test' },
      { value: 'Research and provide a recommended implementation plan. Steps:\n1. Analyze the task requirements\n2. Research current best practices using web search\n3. Analyze the existing codebase for architecture and conventions\n4. Produce a detailed implementation plan\n\nDo NOT start implementing — research and plan only.', label: 'Research' },
    ],
  },
  {
    label: 'Git',
    commands: [
      { value: '/commit-push', label: '/commit-push' },
      { value: '/commit-push-pr', label: '/commit-push-pr' },
      { value: '/commit-push-pr-actions', label: '/commit-push-pr-actions' },
      { value: '/sync-branch', label: '/sync-branch' },
      { value: '/pull-branches', label: '/pull-branches' },
      { value: '/create-branch', label: '/create-branch' },
      { value: '/checkout', label: '/checkout' },
      { value: '/finish-branch', label: '/finish-branch' },
      { value: '/check-merge', label: '/check-merge' },
    ],
  },
  {
    label: 'Quality',
    commands: [
      { value: '/code-review', label: '/code-review' },
      { value: '/security-review', label: '/security-review' },
      { value: '/check-code', label: '/check-code' },
      { value: '/run-tests', label: '/run-tests' },
      { value: '/debug-check', label: '/debug-check' },
      { value: '/mark-risk', label: '/mark-risk' },
      { value: '/list-risks', label: '/list-risks' },
    ],
  },
  {
    label: 'Worktree',
    commands: [
      { value: '/worktree-add', label: '/worktree-add' },
      { value: '/worktree-list', label: '/worktree-list' },
      { value: '/worktree-sync', label: '/worktree-sync' },
      { value: '/worktree-finish', label: '/worktree-finish' },
      { value: '/worktree-remove', label: '/worktree-remove' },
    ],
  },
  {
    label: 'Other',
    commands: [
      { value: '/diagnose', label: '/diagnose' },
      { value: '/challenge', label: '/challenge' },
      { value: '/scoping', label: '/scoping' },
      { value: '/start-working', label: '/start-working' },
      { value: '/reduce-complexity', label: '/reduce-complexity' },
      { value: '/list-commands', label: '/list-commands' },
    ],
  },
];

// ─── Template Editor ─────────────────────────────────

function TemplateEditor({
  agents,
  initial,
  onSave,
  onCancel,
}: {
  agents: Agent[];
  initial?: WorkflowTemplate;
  onSave: (data: { name: string; description: string; steps: WorkflowStep[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps || [{ command: '', target: 'any_idle' }]);

  const addStep = () => setSteps([...steps, { command: '', target: 'any_idle' }]);

  const removeStep = (i: number) => {
    if (steps.length <= 1) return;
    setSteps(steps.filter((_, idx) => idx !== i));
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };

  const updateStep = (i: number, field: keyof WorkflowStep, value: string) => {
    const next = [...steps];
    next[i] = { ...next[i], [field]: value };
    setSteps(next);
  };

  const valid = name.trim() && steps.every((s) => s.command.trim());

  return (
    <div className="glass-light rounded-lg p-4 border border-gl-purple/30 space-y-3">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workflow name..."
        className="w-full glass-input text-sm text-gray-200 rounded-md px-3 py-2 focus:outline-none placeholder-gray-600"
      />
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)..."
        className="w-full glass-input text-xs text-gray-400 rounded-md px-3 py-1.5 focus:outline-none placeholder-gray-600"
      />

      <div className="space-y-2">
        <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Steps</span>
        {steps.map((step, i) => (
          <div key={i} className="flex gap-2 items-start bg-black/30 rounded-lg p-2.5">
            <span className="text-xs text-gray-600 pt-2 shrink-0 w-5 text-center">{i + 1}</span>
            <div className="flex-1 space-y-1.5">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) updateStep(i, 'command', e.target.value);
                }}
                className="text-xs glass-input text-gray-400 rounded-md px-2 py-1.5 w-full focus:outline-none"
              >
                <option value="">Pick a command...</option>
                {COMMAND_PRESETS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.commands.map((cmd) => (
                      <option key={cmd.label} value={cmd.value}>{cmd.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <textarea
                value={step.command}
                onChange={(e) => updateStep(i, 'command', e.target.value)}
                placeholder="Or type a custom command..."
                className="w-full glass-input text-xs text-gray-200 rounded px-2 py-1.5 focus:outline-none resize-none placeholder-gray-600 font-mono"
                rows={2}
              />
              <select
                value={step.target}
                onChange={(e) => updateStep(i, 'target', e.target.value)}
                className="text-xs glass-input text-gray-300 rounded-md px-2 py-1.5 w-full focus:outline-none"
              >
                <option value="any_idle">Any idle agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.repoName || a.name} ({a.machine})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-0.5 shrink-0">
              <button
                onClick={() => moveStep(i, -1)}
                disabled={i === 0}
                className="text-[10px] text-gray-600 hover:text-gray-300 disabled:opacity-20 px-1"
              >
                ^
              </button>
              <button
                onClick={() => moveStep(i, 1)}
                disabled={i === steps.length - 1}
                className="text-[10px] text-gray-600 hover:text-gray-300 disabled:opacity-20 px-1 rotate-180"
              >
                ^
              </button>
              <button
                onClick={() => removeStep(i)}
                disabled={steps.length <= 1}
                className="text-[10px] text-gray-600 hover:text-red-400 disabled:opacity-20 px-1 mt-1"
              >
                x
              </button>
            </div>
          </div>
        ))}
        <button
          onClick={addStep}
          className="text-xs text-gray-500 hover:text-gl-purple transition-colors"
        >
          + Add step
        </button>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave({ name: name.trim(), description: description.trim(), steps })}
          disabled={!valid}
          className="text-sm px-3 py-1.5 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-30 transition-opacity"
        >
          {initial ? 'Update' : 'Create'}
        </button>
        <button
          onClick={onCancel}
          className="text-sm px-3 py-1.5 text-gray-500 hover:text-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Step Progress ───────────────────────────────────

const STEP_COLORS: Record<string, string> = {
  pending: 'bg-gray-700',
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
};

function RunCard({
  run,
  agents,
  onAdvance,
  onCancel,
}: {
  run: WorkflowRun;
  agents: Agent[];
  onAdvance: () => void;
  onCancel: () => void;
}) {
  const agentName = (id: string) => {
    const a = agents.find((a) => a.id === id);
    return a ? (a.repoName || a.name) : id.slice(0, 8);
  };

  const statusBadge = (status: WorkflowRun['status']) => {
    const cls = {
      pending: 'bg-gray-800 text-gray-400',
      running: 'bg-blue-900/50 text-blue-400',
      completed: 'bg-green-900/50 text-green-400',
      failed: 'bg-red-900/50 text-red-400',
      cancelled: 'bg-gray-800 text-gray-500',
    }[status];
    return `text-[10px] px-1.5 py-0.5 rounded ${cls}`;
  };

  return (
    <div className="glass-light rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-200 font-medium">{run.name || 'Workflow Run'}</span>
          <span className={statusBadge(run.status)}>{run.status}</span>
        </div>
        {run.status === 'running' && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={onAdvance}
              className="text-xs px-2 py-1 bg-blue-900/40 hover:bg-blue-900/60 text-blue-400 rounded transition-colors"
            >
              Advance
            </button>
            <button
              onClick={onCancel}
              className="text-xs px-2 py-1 text-gray-600 hover:text-red-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-gray-800">
        {run.steps.map((step, i) => (
          <div
            key={i}
            className={`flex-1 ${STEP_COLORS[step.status] || 'bg-gray-700'} ${
              step.status === 'running' ? 'animate-pulse' : ''
            }`}
          />
        ))}
      </div>

      {/* Step details */}
      <div className="space-y-1">
        {run.steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full shrink-0 ${STEP_COLORS[step.status] || 'bg-gray-700'}`} />
            <span className="text-gray-500 w-4 shrink-0">{i + 1}.</span>
            <span className="text-gray-400 font-mono truncate flex-1" title={step.command}>
              {step.command.length > 60 ? step.command.slice(0, 60) + '...' : step.command}
            </span>
            {step.agentId && (
              <span className="text-gray-600 shrink-0">{agentName(step.agentId)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────

export function WorkflowPanel({ agents }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [view, setView] = useState<'templates' | 'runs'>('templates');
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [editing, setEditing] = useState<WorkflowTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const loadTemplates = useCallback(() => {
    api.getWorkflowTemplates().then(setTemplates).catch(() => {});
  }, []);

  const loadRuns = useCallback(() => {
    api.getWorkflowRuns().then(setRuns).catch(() => {});
  }, []);

  useEffect(() => {
    if (!expanded) return;
    loadTemplates();
    loadRuns();
  }, [expanded, loadTemplates, loadRuns]);

  // Auto-refresh runs while panel is open
  useEffect(() => {
    if (!expanded) return;
    const interval = setInterval(loadRuns, 10_000);
    return () => clearInterval(interval);
  }, [expanded, loadRuns]);

  const handleSaveTemplate = async (data: { name: string; description: string; steps: WorkflowStep[] }) => {
    try {
      if (editing) {
        await api.updateWorkflowTemplate(editing.id, data);
      } else {
        await api.createWorkflowTemplate(data);
      }
      setEditing(null);
      setCreating(false);
      loadTemplates();
    } catch {
      // error handled silently
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await api.deleteWorkflowTemplate(id);
      loadTemplates();
    } catch {
      // error handled silently
    }
  };

  const handleStartRun = async (templateId: string) => {
    try {
      await api.startWorkflow(templateId);
      loadRuns();
      setView('runs');
    } catch {
      // error handled silently
    }
  };

  const handleAdvance = async (runId: string) => {
    try {
      await api.advanceWorkflow(runId);
      loadRuns();
    } catch {
      // error handled silently
    }
  };

  const handleCancel = async (runId: string) => {
    try {
      await api.cancelWorkflow(runId);
      loadRuns();
    } catch {
      // error handled silently
    }
  };

  const runningCount = runs.filter((r) => r.status === 'running').length;

  const tabClass = (t: 'templates' | 'runs') =>
    `px-3 py-1 text-xs font-medium rounded-md transition-colors ${
      view === t
        ? 'bg-gl-purple/20 text-gl-purple'
        : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06]'
    }`;

  return (
    <div className="glass rounded-xl md:rounded-2xl overflow-hidden">
      {/* Collapse header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 md:px-6 md:py-4 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
          </svg>
          <span className="text-gray-400 text-sm font-semibold uppercase tracking-wide">Workflows</span>
          {runningCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900/50 text-blue-400 animate-pulse">
              {runningCount} running
            </span>
          )}
        </div>
        <span className="text-xs text-gray-600">
          {templates.length} template{templates.length !== 1 ? 's' : ''}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 md:px-6 md:pb-6 space-y-3">
          {/* View tabs */}
          <div className="flex gap-1">
            <button onClick={() => setView('templates')} className={tabClass('templates')}>Templates</button>
            <button onClick={() => setView('runs')} className={tabClass('runs')}>
              Runs {runningCount > 0 && `(${runningCount})`}
            </button>
          </div>

          {/* Templates View */}
          {view === 'templates' && (
            <div className="space-y-3">
              {templates.length === 0 && !creating && (
                <p className="text-sm text-gray-600 italic text-center py-4">No workflow templates yet</p>
              )}

              {templates.map((t) =>
                editing?.id === t.id ? (
                  <TemplateEditor
                    key={t.id}
                    agents={agents}
                    initial={t}
                    onSave={handleSaveTemplate}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div key={t.id} className="glass-light rounded-lg p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-200 font-medium">{t.name}</span>
                        <span className="text-[10px] text-gray-600">{t.steps.length} step{t.steps.length !== 1 ? 's' : ''}</span>
                      </div>
                      {t.description && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{t.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleStartRun(t.id)}
                        className="text-xs px-2.5 py-1 gl-gradient hover:opacity-90 text-white rounded transition-opacity"
                      >
                        Run
                      </button>
                      <button
                        onClick={() => { setEditing(t); setCreating(false); }}
                        className="text-xs px-2 py-1 text-gray-500 hover:text-blue-400 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteTemplate(t.id)}
                        className="text-xs px-2 py-1 text-gray-600 hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )
              )}

              {creating ? (
                <TemplateEditor
                  agents={agents}
                  onSave={handleSaveTemplate}
                  onCancel={() => setCreating(false)}
                />
              ) : (
                <button
                  onClick={() => { setCreating(true); setEditing(null); }}
                  className="text-sm px-4 py-2 gl-gradient hover:opacity-90 text-white rounded-md transition-opacity"
                >
                  + New Template
                </button>
              )}
            </div>
          )}

          {/* Runs View */}
          {view === 'runs' && (
            <div className="space-y-3">
              {runs.length === 0 && (
                <p className="text-sm text-gray-600 italic text-center py-4">No workflow runs yet</p>
              )}
              {runs.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  agents={agents}
                  onAdvance={() => handleAdvance(run.id)}
                  onCancel={() => handleCancel(run.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
