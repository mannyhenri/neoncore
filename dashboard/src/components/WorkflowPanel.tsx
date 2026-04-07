import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import { WorkflowCanvasEditor } from './WorkflowCanvasEditor';
import type { Agent, Workflow, PlayerRole, PlayerType, StepSummary, WorkflowStep } from '../types';

// ─── Browser notification helper ────────────────────

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title: string, body: string, tag?: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, {
      body,
      tag: tag || 'workflow-step',
      icon: '/favicon.ico',
      silent: false,
    });
    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
  }
}

interface Props {
  agents: Agent[];
}

interface SelectedPlayer {
  playerType: PlayerType;
  agentId?: string;
  modelId?: string;
  name: string;
  roles: PlayerRole[];
}

const PHASE_LABELS = { research: 'Research', coding: 'Coding', review: 'Review' } as const;
const ROUND_LABELS = ['', 'Work', 'Reflect', 'Converge'] as const;
const ROLE_OPTIONS: PlayerRole[] = ['research', 'coding', 'review'];

// ─── WorkflowPanel ──────────────────────────────────

export function WorkflowPanel({ agents }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [showCreator, setShowCreator] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | undefined>();

  const loadWorkflows = useCallback(async () => {
    try {
      const data = await api.getWorkflows();
      setWorkflows(data);
    } catch {
      // silent
    }
  }, []);

  // Request notification permission on mount
  useEffect(() => {
    loadWorkflows();
    requestNotificationPermission();
  }, [loadWorkflows]);

  // Debounced reload for step updates (avoid hammering the API)
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debouncedReload = useCallback(() => {
    clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(loadWorkflows, 2000);
  }, [loadWorkflows]);

  useSocket({
    onWorkflowUpdated: (wf) => {
      setWorkflows((prev) => {
        const idx = prev.findIndex((w) => w.id === wf.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = wf;
          return next;
        }
        return [wf, ...prev];
      });
    },
    onWorkflowDeleted: ({ id }) => {
      setWorkflows((prev) => prev.filter((w) => w.id !== id));
    },
    onWorkflowStepUpdated: (step: WorkflowStep) => {
      // Refresh workflow list to update step summary counters
      debouncedReload();

      // Send browser notification for completed or failed steps
      if (step.status === 'completed') {
        const wf = workflows.find((w) => w.id === step.workflowId);
        const wfName = wf?.name || 'Workflow';
        if (step.autoAdvance) {
          sendNotification(
            `Step completed`,
            `"${step.name}" finished — ${wfName}`,
            `step-${step.id}`,
          );
        } else {
          sendNotification(
            `Step completed — action needed`,
            `"${step.name}" finished — advance to continue (${wfName})`,
            `step-${step.id}`,
          );
        }
      } else if (step.status === 'failed') {
        const wf = workflows.find((w) => w.id === step.workflowId);
        sendNotification(
          `Step failed`,
          `"${step.name}" failed — ${wf?.name || 'Workflow'}`,
          `step-${step.id}`,
        );
      }
    },
    onReconnect: loadWorkflows,
  });

  // Split workflows into templates and runs
  const templates = workflows.filter((w) => !w.templateId);
  const runs = workflows.filter((w) => !!w.templateId);
  const activeRuns = runs.filter((w) => ['running', 'paused'].includes(w.status));
  const recentRuns = runs.filter((w) => !['running', 'paused'].includes(w.status)).slice(0, 10);
  // Also include V1 workflows (no steps, no templateId) that are running
  const activeV1 = templates.filter((w) => ['running', 'paused'].includes(w.status) && !w.stepSummary);

  const totalActive = activeRuns.length + activeV1.length;

  // Helper to open a run in the canvas (view-only) or template (edit)
  const openWorkflow = (id: string) => { setEditingWorkflowId(id); setCanvasOpen(true); };

  // After starting a run from a template, open the new run in the canvas
  const handleRunCreated = (runId: string) => {
    loadWorkflows();
    openWorkflow(runId);
  };

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 mb-3 md:mb-4 group"
      >
        <span className={`text-xs text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9654;</span>
        <h2 className="text-gray-400 text-sm md:text-base font-semibold uppercase tracking-wide group-hover:text-gray-300 transition-colors">
          Workflows
        </h2>
        {totalActive > 0 && (
          <span className="bg-gl-blue/20 text-gl-blue px-2 py-0.5 rounded-full text-xs font-medium">
            {totalActive} active
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-4">
          {/* Create button */}
          <button
            onClick={() => { setEditingWorkflowId(undefined); setCanvasOpen(true); }}
            className="text-sm px-4 py-2 rounded-lg gl-gradient text-white hover:opacity-90 transition-opacity font-medium"
          >
            + New Workflow
          </button>

          {/* Active runs */}
          {activeRuns.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Active Runs</div>
              {activeRuns.map((wf) => (
                <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                  templateName={templates.find((t) => t.id === wf.templateId)?.name} />
              ))}
            </div>
          )}

          {/* Active V1 workflows */}
          {activeV1.map((wf) => (
            <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents} />
          ))}

          {/* Templates */}
          {templates.filter((t) => t.stepSummary).length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Templates</div>
              {templates.filter((t) => t.stepSummary).map((wf) => (
                <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                  onRunCreated={handleRunCreated}
                  runCount={runs.filter((r) => r.templateId === wf.id).length} />
              ))}
            </div>
          )}

          {/* Recent runs */}
          {recentRuns.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Recent Runs</div>
              {recentRuns.map((wf) => (
                <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} compact agents={agents}
                  templateName={templates.find((t) => t.id === wf.templateId)?.name} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Canvas Workflow Editor */}
      {canvasOpen && (
        <WorkflowCanvasEditor
          workflowId={editingWorkflowId}
          agents={agents}
          onClose={() => setCanvasOpen(false)}
          onSaved={() => { loadWorkflows(); }}
        />
      )}
    </div>
  );
}

// ─── WorkflowCreator ────────────────────────────────

function WorkflowCreator({ agents, onCreated, onCancel }: {
  agents: Agent[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [jiraTaskId, setJiraTaskId] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPlayers, setSelectedPlayers] = useState<SelectedPlayer[]>([]);
  const [maxIterations, setMaxIterations] = useState(3);
  const [availableModels, setAvailableModels] = useState<{ openai: string[]; gridlight: string[] }>({ openai: [], gridlight: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getAvailableModels().then(setAvailableModels).catch(() => {});
  }, []);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  function toggleAgent(agent: Agent) {
    setSelectedPlayers((prev) => {
      const exists = prev.find((p) => p.agentId === agent.id);
      if (exists) return prev.filter((p) => p.agentId !== agent.id);
      return [...prev, {
        playerType: 'vscode-agent' as PlayerType,
        agentId: agent.id,
        name: agent.repoName || agent.name,
        roles: ['research', 'coding', 'review'] as PlayerRole[],
      }];
    });
  }

  function toggleApiModel(type: PlayerType, modelId: string) {
    setSelectedPlayers((prev) => {
      const exists = prev.find((p) => p.modelId === modelId && p.playerType === type);
      if (exists) return prev.filter((p) => !(p.modelId === modelId && p.playerType === type));
      return [...prev, {
        playerType: type,
        modelId,
        name: modelId,
        roles: ['research', 'coding', 'review'] as PlayerRole[],
      }];
    });
  }

  function toggleRole(playerId: string, role: PlayerRole) {
    setSelectedPlayers((prev) => prev.map((p) => {
      const id = p.agentId || p.modelId;
      if (id !== playerId) return p;
      const hasRole = p.roles.includes(role);
      const newRoles = hasRole ? p.roles.filter((r) => r !== role) : [...p.roles, role];
      return { ...p, roles: newRoles };
    }));
  }

  const hasVsCodeCoder = selectedPlayers.some(
    (p) => p.playerType === 'vscode-agent' && p.roles.includes('coding'),
  );

  async function handleSubmit() {
    if (!description.trim() || selectedPlayers.length === 0) return;
    if (!hasVsCodeCoder) {
      setError('At least one VS Code agent must have the Coding role');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await api.startWorkflow({
        jiraTaskId: jiraTaskId.trim() || undefined,
        description: description.trim(),
        players: selectedPlayers.map((p) => ({
          playerType: p.playerType,
          agentId: p.agentId,
          name: p.name,
          modelId: p.modelId,
          roles: p.roles,
        })),
        maxIterations,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass rounded-xl p-4 space-y-4 border border-white/10">
      <div className="text-sm font-semibold text-gray-300 uppercase tracking-wider">New Workflow</div>

      {/* Task info */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          value={jiraTaskId}
          onChange={(e) => setJiraTaskId(e.target.value)}
          placeholder="GRD-427 (optional)"
          className="text-sm glass-input text-gray-300 rounded-md px-3 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple w-full sm:w-32"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what needs to be done..."
          rows={3}
          className="text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none focus:border-gl-purple flex-1 resize-none"
        />
      </div>

      {/* Player Selection */}
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Players</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* VS Code Agents */}
          <div className="space-y-1.5">
            <div className="text-xs text-gray-400 font-medium">VS Code Agents</div>
            {onlineAgents.length === 0 ? (
              <div className="text-xs text-gray-600 italic">No online agents</div>
            ) : (
              onlineAgents.map((agent) => {
                const selected = selectedPlayers.find((p) => p.agentId === agent.id);
                return (
                  <PlayerRow
                    key={agent.id}
                    name={agent.repoName || agent.name}
                    badge={agent.agentType === 'gridlight' ? 'GL' : 'CC'}
                    badgeColor={agent.agentType === 'gridlight' ? 'text-pink-400' : 'text-blue-400'}
                    selected={!!selected}
                    roles={selected?.roles || []}
                    onToggle={() => toggleAgent(agent)}
                    onToggleRole={(role) => toggleRole(agent.id, role)}
                  />
                );
              })
            )}
          </div>

          {/* API Models */}
          <div className="space-y-1.5">
            <div className="text-xs text-gray-400 font-medium">API Models</div>
            {availableModels.openai.map((m) => {
              const selected = selectedPlayers.find((p) => p.modelId === m && p.playerType === 'openai');
              return (
                <PlayerRow
                  key={`openai-${m}`}
                  name={m}
                  badge="OAI"
                  badgeColor="text-green-400"
                  selected={!!selected}
                  roles={selected?.roles || []}
                  onToggle={() => toggleApiModel('openai', m)}
                  onToggleRole={(role) => toggleRole(m, role)}
                />
              );
            })}
            {availableModels.gridlight.map((m) => {
              const selected = selectedPlayers.find((p) => p.modelId === m && p.playerType === 'gridlight-gateway');
              return (
                <PlayerRow
                  key={`gl-${m}`}
                  name={m}
                  badge="GL"
                  badgeColor="text-pink-400"
                  selected={!!selected}
                  roles={selected?.roles || []}
                  onToggle={() => toggleApiModel('gridlight-gateway', m)}
                  onToggleRole={(role) => toggleRole(m, role)}
                />
              );
            })}
            {availableModels.openai.length === 0 && availableModels.gridlight.length === 0 && (
              <div className="text-xs text-gray-600 italic">Configure API keys in Settings</div>
            )}
          </div>
        </div>
      </div>

      {/* Max iterations */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">Max review iterations:</span>
        <input
          type="range"
          min={1}
          max={5}
          value={maxIterations}
          onChange={(e) => setMaxIterations(Number(e.target.value))}
          className="w-24 accent-purple-500"
        />
        <span className="text-xs text-gray-400 font-mono">{maxIterations}</span>
      </div>

      {/* Validation */}
      {!hasVsCodeCoder && selectedPlayers.length > 0 && (
        <div className="text-xs text-amber-400">At least one VS Code agent needs the Coding role</div>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!description.trim() || selectedPlayers.length === 0 || !hasVsCodeCoder || submitting}
          className="text-sm px-4 py-2 rounded-md font-medium gl-gradient text-white hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
        >
          {submitting ? 'Starting...' : 'Start Workflow'}
        </button>
        <button
          onClick={onCancel}
          className="text-sm px-4 py-2 rounded-md text-gray-400 hover:text-white transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── PlayerRow ──────────────────────────────────────

function PlayerRow({ name, badge, badgeColor, selected, roles, onToggle, onToggleRole }: {
  name: string;
  badge: string;
  badgeColor: string;
  selected: boolean;
  roles: PlayerRole[];
  onToggle: () => void;
  onToggleRole: (role: PlayerRole) => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors ${selected ? 'bg-white/[0.06] border border-white/10' : 'hover:bg-white/[0.03]'}`}>
      <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="accent-purple-500 shrink-0"
        />
        <span className={`text-[13px] font-bold ${badgeColor} shrink-0`}>{badge}</span>
        <span className="text-xs text-gray-300 truncate">{name}</span>
      </label>
      {selected && (
        <div className="flex gap-1 shrink-0">
          {ROLE_OPTIONS.map((role) => (
            <button
              key={role}
              onClick={() => onToggleRole(role)}
              className={`text-[13px] px-1.5 py-0.5 rounded transition-colors ${
                roles.includes(role)
                  ? role === 'research' ? 'bg-blue-900/50 text-blue-300'
                    : role === 'coding' ? 'bg-green-900/50 text-green-300'
                    : 'bg-purple-900/50 text-purple-300'
                  : 'bg-white/[0.04] text-gray-600'
              }`}
            >
              {role.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── WorkflowRunCard ────────────────────────────────

function WorkflowRunCard({ workflow: wf, onAction, onOpen, compact, agents, templateName, onRunCreated, runCount }: {
  workflow: Workflow;
  onAction: () => void;
  onOpen?: (id: string) => void;
  compact?: boolean;
  agents?: Agent[];
  templateName?: string;
  onRunCreated?: (runId: string) => void;
  runCount?: number;
}) {
  const [showContext, setShowContext] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deferredPopup, setDeferredPopup] = useState<{
    agentSteps: { stepId: string; stepName: string }[];
    promptSteps: { stepId: string; stepName: string; field: string; label: string }[];
  } | null>(null);
  const [deferredAssignments, setDeferredAssignments] = useState<Record<string, string>>({});
  const [deferredPrompts, setDeferredPrompts] = useState<Record<string, Record<string, string>>>({});

  const isV2 = !!wf.stepSummary;
  const canRun = isV2 && !['running', 'paused'].includes(wf.status);
  const onlineAgents = (agents || []).filter((a) => a.status !== 'offline');

  async function handleRunFromList() {
    if (!canRun || starting) return;
    setStarting(true);
    try {
      const { steps } = await api.getWorkflowV2(wf.id);

      // Deferred cartridge assignments
      const agentSteps = steps.filter((s) =>
        s.executorId === '__deferred__' ||
        (s.executorType === 'review-gate' && (s.executorConfig as Record<string, unknown>).reviewAgentId === '__deferred__')
      ).map((s) => ({ stepId: s.id, stepName: s.name }));

      // Deferred prompt inputs
      const promptSteps: { stepId: string; stepName: string; field: string; label: string }[] = [];
      for (const s of steps) {
        const cfg = s.executorConfig as Record<string, unknown>;
        if (s.executorType === 'claude-code' || !s.executorType) {
          if (cfg.useIntent) {
            const intent = cfg.intent as Record<string, unknown> | undefined;
            if (!intent?.objective) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'intent.objective', label: 'Objective' });
          } else {
            if (!cfg.prompt && !s.description) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'prompt', label: 'Prompt' });
          }
        } else if (s.executorType === 'review-gate') {
          if (!cfg.criteria) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'criteria', label: 'Review Criteria' });
        } else if (s.executorType === 'deliberation') {
          if (!cfg.prompt && !s.description) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'prompt', label: 'Shared Prompt' });
        } else if (s.executorType === 'quality-gate') {
          if (cfg.gateType === 'custom' && !cfg.customPrompt) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'customPrompt', label: 'Custom Quality Check' });
        }
      }

      if (agentSteps.length > 0 || promptSteps.length > 0) {
        setDeferredPopup({ agentSteps, promptSteps });
        setDeferredAssignments({});
        setDeferredPrompts({});
        setStarting(false);
        return;
      }

      const result = await api.startWorkflowV2(wf.id);
      if (result?.workflow?.id && result.workflow.id !== wf.id && onRunCreated) {
        onRunCreated(result.workflow.id);
      } else {
        onAction();
      }
    } catch { /* silent */ }
    finally { setStarting(false); }
  }

  async function handleDeferredRun() {
    if (!deferredPopup) return;
    const allAgentsAssigned = deferredPopup.agentSteps.every((s) => deferredAssignments[s.stepId]);
    const allPromptsAssigned = deferredPopup.promptSteps.every((s) => deferredPrompts[s.stepId]?.[s.field]?.trim());
    if (!allAgentsAssigned || !allPromptsAssigned) return;

    setStarting(true);
    setDeferredPopup(null);
    try {
      const result = await api.startWorkflowV2(
        wf.id,
        deferredPopup.agentSteps.length > 0 ? deferredAssignments : undefined,
        deferredPopup.promptSteps.length > 0 ? deferredPrompts : undefined,
      );
      if (result?.workflow?.id && result.workflow.id !== wf.id && onRunCreated) {
        onRunCreated(result.workflow.id);
      } else {
        onAction();
      }
    } catch { /* silent */ }
    finally { setStarting(false); }
  }

  async function handlePause() {
    try { await api.pauseWorkflow(wf.id); onAction(); } catch { /* silent */ }
  }
  async function handleResume() {
    try { await api.resumeWorkflow(wf.id); onAction(); } catch { /* silent */ }
  }
  async function handleCancel() {
    try { await api.cancelWorkflow(wf.id); onAction(); } catch { /* silent */ }
  }
  async function handleDelete() {
    try { await api.deleteWorkflow(wf.id); onAction(); } catch { /* silent */ }
  }

  const statusColor = {
    pending: 'text-gray-400',
    running: 'text-blue-400',
    paused: 'text-amber-400',
    completed: wf.error ? 'text-amber-400' : 'text-emerald-400',
    failed: 'text-red-400',
    cancelled: 'text-gray-500',
  }[wf.status] || 'text-gray-400';

  // Deferred popup — rendered via portal to escape any parent stacking context
  const deferredPopupEl = deferredPopup && createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold text-white">Configure & Run</h2>
            <p className="text-[13px] text-gray-500 mt-0.5">Fill in the required fields before running</p>
          </div>
          <button onClick={() => setDeferredPopup(null)} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {deferredPopup.agentSteps.length > 0 && (
            <div className="space-y-3">
              <span className="text-[13px] text-gray-500 uppercase tracking-wider">Cartridge Selection</span>
              {deferredPopup.agentSteps.map((s) => (
                <div key={s.stepId}>
                  <label className="block text-sm text-gray-400 mb-1">{s.stepName}</label>
                  <select
                    value={deferredAssignments[s.stepId] || ''}
                    onChange={(e) => setDeferredAssignments((prev) => ({ ...prev, [s.stepId]: e.target.value }))}
                    className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none"
                  >
                    <option value="">Select cartridge...</option>
                    {onlineAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.repoName || a.name}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {deferredPopup.promptSteps.length > 0 && (
            <div className="space-y-3">
              <span className="text-[13px] text-gray-500 uppercase tracking-wider">Prompt Inputs</span>
              {deferredPopup.promptSteps.map((s) => (
                <div key={`${s.stepId}-${s.field}`}>
                  <label className="block text-sm text-gray-400 mb-1">
                    {s.stepName} — <span className="text-gray-500">{s.label}</span>
                  </label>
                  <textarea
                    value={deferredPrompts[s.stepId]?.[s.field] || ''}
                    onChange={(e) => setDeferredPrompts((prev) => ({
                      ...prev,
                      [s.stepId]: { ...prev[s.stepId], [s.field]: e.target.value },
                    }))}
                    rows={3}
                    className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y font-mono"
                    placeholder={`Enter ${s.label.toLowerCase()}...`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-white/[0.06] flex items-center gap-3">
          <button
            onClick={handleDeferredRun}
            disabled={
              !deferredPopup.agentSteps.every((s) => deferredAssignments[s.stepId]) ||
              !deferredPopup.promptSteps.every((s) => deferredPrompts[s.stepId]?.[s.field]?.trim())
            }
            className="text-sm px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md disabled:opacity-30 transition-colors"
          >
            Run Workflow
          </button>
          <button onClick={() => setDeferredPopup(null)} className="text-sm px-3 py-2 text-gray-500 hover:text-white transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );

  const displayName = wf.runNumber > 0
    ? `${templateName || wf.name} — Run #${wf.runNumber}`
    : wf.name || 'Untitled';

  if (compact) {
    return (
      <>
        <div className="flex items-center gap-3 px-3 py-2 glass-light rounded-lg text-xs group">
          {wf.templateId && (
            <span className={`font-medium ${statusColor}`}>{wf.status}</span>
          )}
          <button
            onClick={() => onOpen?.(wf.id)}
            className="text-gray-400 truncate flex-1 text-left hover:text-white transition-colors"
          >
            {displayName}
          </button>
          {wf.stepSummary && (
            <>
              <span className="text-gray-600 truncate max-w-[200px]" title={wf.stepSummary.stepNames?.join(' → ')}>
                {wf.stepSummary.stepNames?.join(' → ')}
              </span>
              <span className="text-gray-600 shrink-0">
                {wf.templateId
                  ? `${wf.stepSummary.completed}/${wf.stepSummary.total}`
                  : `${wf.stepSummary.total} steps`}
              </span>
            </>
          )}
          {wf.jiraTaskId && <span className="text-gray-500 font-mono shrink-0">{wf.jiraTaskId}</span>}
          {canRun && (
            <button
              onClick={handleRunFromList}
              disabled={starting}
              className="text-emerald-500 hover:text-emerald-400 opacity-0 group-hover:opacity-100 transition-all shrink-0 disabled:opacity-30"
              title="Run workflow"
            >
              {starting ? '...' : '▶'}
            </button>
          )}
          {confirmDelete ? (
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={handleDelete} className="text-[13px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-500/20">Delete</button>
              <button onClick={() => setConfirmDelete(false)} className="text-[13px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5">No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
              title="Delete workflow"
            >
              &times;
            </button>
          )}
        </div>
        {deferredPopupEl}
      </>
    );
  }

  return (
    <div className="glass rounded-xl p-4 space-y-3 border border-white/10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {wf.templateId && (
            <span className={`text-sm font-semibold ${statusColor}`}>{wf.status.toUpperCase()}</span>
          )}
          <button
            onClick={() => onOpen?.(wf.id)}
            className="text-sm text-gray-300 truncate hover:text-white transition-colors"
          >
            {displayName}
          </button>
          {typeof runCount === 'number' && runCount > 0 && (
            <span className="text-xs text-gray-600 shrink-0">{runCount} run{runCount !== 1 ? 's' : ''}</span>
          )}
          {wf.jiraTaskId && <span className="text-xs text-gray-500 font-mono shrink-0">{wf.jiraTaskId}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {wf.iteration > 1 && (
            <span className="text-xs text-gray-500">Iteration {wf.iteration}/{wf.maxIterations}</span>
          )}
          {canRun && (
            <button
              onClick={handleRunFromList}
              disabled={starting}
              className="text-xs text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded hover:bg-white/5 disabled:opacity-30"
            >
              {starting ? 'Starting...' : '▶ Run'}
            </button>
          )}
          {wf.status === 'running' && (
            <button onClick={handlePause} className="text-xs text-amber-400 hover:text-amber-300 px-2 py-1 rounded hover:bg-white/5">Pause</button>
          )}
          {wf.status === 'paused' && (
            <button onClick={handleResume} className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-white/5">Resume</button>
          )}
          {['running', 'paused'].includes(wf.status) && (
            <button onClick={handleCancel} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-white/5">Cancel</button>
          )}
          {!['running', 'paused'].includes(wf.status) && (
            confirmDelete ? (
              <div className="flex items-center gap-1">
                <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded bg-red-500/20">Delete</button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="text-xs text-gray-600 hover:text-red-400 px-2 py-1 rounded hover:bg-white/5 transition-colors">Delete</button>
            )
          )}
        </div>
      </div>

      {/* Step progress (V2 canvas) or Phase progress (V1) — templates don't show progress */}
      {wf.stepSummary && wf.templateId ? (
        <StepProgress summary={wf.stepSummary} />
      ) : wf.phases.length > 0 ? (
        <>
          <PhaseProgress phases={wf.phases} currentPhase={wf.currentPhase} />
          {wf.status === 'running' && wf.phases[wf.currentPhase] && (
            <PhaseDetails phase={wf.phases[wf.currentPhase]} players={wf.players} agents={agents} />
          )}
        </>
      ) : null}

      {/* Error */}
      {wf.error && (
        <div className="text-xs text-amber-400 bg-amber-900/20 rounded-lg px-3 py-2">{wf.error}</div>
      )}

      {/* Shared context viewer */}
      {wf.sharedContext && (
        <div>
          <button
            onClick={() => setShowContext(!showContext)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showContext ? 'Hide' : 'Show'} deliberation context
          </button>
          {showContext && (
            <pre className="mt-2 text-xs text-gray-400 bg-black/30 rounded-lg p-3 max-h-60 overflow-y-auto whitespace-pre-wrap font-mono">
              {wf.sharedContext}
            </pre>
          )}
        </div>
      )}

      {deferredPopupEl}
    </div>
  );
}

// ─── StepProgress (V2 Canvas workflows) ──────────────

function StepProgress({ summary }: { summary: StepSummary }) {
  const { total, completed, running, failed, pending } = summary;

  return (
    <div className="space-y-1.5">
      {/* Progress bar */}
      <div className="flex h-1.5 rounded-full overflow-hidden bg-white/5 gap-px">
        {completed > 0 && (
          <div className="bg-emerald-500/70 rounded-sm" style={{ flex: completed }} />
        )}
        {running > 0 && (
          <div className="bg-blue-500/70 animate-pulse rounded-sm" style={{ flex: running }} />
        )}
        {failed > 0 && (
          <div className="bg-red-500/60 rounded-sm" style={{ flex: failed }} />
        )}
        {pending > 0 && (
          <div className="bg-white/5 rounded-sm" style={{ flex: pending }} />
        )}
      </div>

      {/* Step names */}
      {summary.stepNames && summary.stepNames.length > 0 && (
        <div className="text-[13px] text-gray-500 truncate" title={summary.stepNames.join(' → ')}>
          {summary.stepNames.join(' → ')}
        </div>
      )}

      {/* Labels */}
      <div className="flex gap-3 text-[13px]">
        {completed > 0 && <span className="text-emerald-400">{completed} done</span>}
        {running > 0 && <span className="text-blue-400">{running} running</span>}
        {failed > 0 && <span className="text-red-400">{failed} failed</span>}
        {pending > 0 && <span className="text-gray-500">{pending} pending</span>}
        <span className="text-gray-600 ml-auto">{completed}/{total} steps</span>
      </div>
    </div>
  );
}

// ─── PhaseProgress (V1 workflows) ──────────────────

function PhaseProgress({ phases, currentPhase }: { phases: Workflow['phases']; currentPhase: number }) {
  return (
    <div className="flex gap-1">
      {phases.map((phase, i) => {
        const isActive = i === currentPhase && phase.status === 'running';
        const isDone = phase.status === 'completed';
        const isFailed = phase.status === 'failed';

        return (
          <div key={phase.phase} className="flex-1 space-y-1">
            <div className="flex items-center justify-between">
              <span className={`text-[13px] uppercase tracking-wider ${
                isActive ? 'text-blue-400' : isDone ? 'text-emerald-400' : isFailed ? 'text-red-400' : 'text-gray-600'
              }`}>
                {PHASE_LABELS[phase.phase]}
              </span>
              {isActive && phase.currentRound > 0 && (
                <span className="text-[13px] text-blue-400/60">
                  {ROUND_LABELS[phase.currentRound]}
                </span>
              )}
            </div>
            {/* Progress bar with 3 segments for rounds */}
            <div className="flex gap-px h-1.5 rounded-full overflow-hidden bg-white/5">
              {[1, 2, 3].map((round) => {
                const roundDone = phase.playerResults.some((r) => r.round === round);
                const roundActive = isActive && phase.currentRound === round;
                return (
                  <div
                    key={round}
                    className={`flex-1 rounded-sm transition-colors ${
                      roundDone ? 'bg-emerald-500/70'
                        : roundActive ? 'bg-blue-500/70 animate-pulse'
                        : isFailed ? 'bg-red-500/40'
                        : 'bg-white/5'
                    }`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── PhaseDetails ───────────────────────────────────

function PhaseDetails({ phase, players, agents }: { phase: Workflow['phases'][0]; players: Workflow['players']; agents?: Agent[] }) {
  const phasePlayers = players.filter((p) => p.roles.includes(phase.phase));
  const currentRound = phase.currentRound;

  return (
    <div className="space-y-1.5">
      {phasePlayers.map((player) => {
        const result = phase.playerResults.find(
          (r) => r.playerId === player.id && r.round === currentRound,
        );
        const hasResult = !!result;
        const hasError = result?.error;
        const agentData = player.agentId ? agents?.find((a) => a.id === player.agentId) : undefined;
        const isGridlight = agentData?.agentType === 'gridlight';

        const badge = player.playerType === 'vscode-agent'
          ? (isGridlight ? 'GL' : 'CC')
          : player.playerType === 'openai' ? 'OAI' : 'GL';

        const badgeColor = player.playerType === 'vscode-agent'
          ? (isGridlight ? 'text-pink-400' : 'text-blue-400')
          : player.playerType === 'openai' ? 'text-green-400'
          : 'text-pink-400';

        return (
          <div key={player.id} className="flex items-center gap-2 text-xs">
            <span className="w-4 text-center">
              {hasError ? (
                <span className="text-red-400">&#10005;</span>
              ) : hasResult && result?.fallbackModel ? (
                <span className="text-amber-400">&#9889;</span>
              ) : hasResult ? (
                <span className="text-emerald-400">&#10003;</span>
              ) : (
                <span className="text-blue-400 animate-spin inline-block">&#9696;</span>
              )}
            </span>
            <span className={`text-[13px] font-bold ${badgeColor}`}>
              {badge}
            </span>
            <span className="text-gray-300 truncate">{player.name}</span>
            {result?.fallbackModel && (
              <span className="text-amber-400/70 text-[13px] shrink-0" title={`Original player failed, completed by ${result.fallbackModel}`}>
                failover
              </span>
            )}
            {hasResult && !hasError && result.output && (
              <span className="text-gray-500 truncate ml-auto max-w-[200px]">
                {result.output.slice(0, 80)}...
              </span>
            )}
            {hasError && (
              <span className="text-red-400 truncate ml-auto max-w-[200px]">{result.error}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
