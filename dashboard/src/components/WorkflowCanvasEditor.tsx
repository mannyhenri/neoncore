import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type NodeProps,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import { WorkflowExecutionLog } from './WorkflowExecutionLog';
import type {
  Agent,
  WorkflowStep,
  WorkflowStepLog,
  StepExecutorType,
  StepStatus,
} from '../types';

// ─── Types ──────────────────────────────────────────

interface ExpertRole {
  id: string;
  name: string;
  color: string;
  bg: string;
  description: string;
}

interface Props {
  workflowId?: string;
  agents: Agent[];
  onClose: () => void;
  onSaved?: () => void;
}

interface StepNodeData {
  stepId: string;
  name: string;
  role: string;
  executorId: string;
  prompt: string;
  autoAdvance: boolean;
  waitForWebhook: boolean;
  status: StepStatus;
  isRunning: boolean;
  onSelect: (stepId: string) => void;
  onNameChange: (stepId: string, name: string) => void;
  onAutoAdvanceToggle: (stepId: string) => void;
  onAdvance: (stepId: string) => void;
  [key: string]: unknown;
}

type StepNode = Node<StepNodeData, 'stepNode'>;

interface LocalStep {
  id: string;
  name: string;
  description: string;
  positionX: number;
  positionY: number;
  executorType: StepExecutorType;
  executorId: string;
  executorConfig: Record<string, unknown>;
  autoAdvance: boolean;
  status: StepStatus;
  dependsOn: string[];
}

// ─── Constants ──────────────────────────────────────

const EXPERT_ROLES: ExpertRole[] = [
  { id: 'general',     name: 'General',          color: 'text-gray-400',    bg: 'bg-gray-500/20',    description: 'No specific role — send prompt as-is' },
  { id: 'architect',   name: 'Architect',        color: 'text-purple-400',  bg: 'bg-purple-500/20',  description: 'System design and implementation planning' },
  { id: 'backend',     name: 'Backend Dev',      color: 'text-blue-400',    bg: 'bg-blue-500/20',    description: 'Server logic, APIs, and databases' },
  { id: 'frontend',    name: 'Frontend Dev',     color: 'text-cyan-400',    bg: 'bg-cyan-500/20',    description: 'UI components and state management' },
  { id: 'reviewer',    name: 'Code Reviewer',    color: 'text-emerald-400', bg: 'bg-emerald-500/20', description: 'Identify improvements ranked by impact' },
  { id: 'security',    name: 'Security Auditor', color: 'text-red-400',     bg: 'bg-red-500/20',     description: 'Injection risks, auth, OWASP top 10' },
  { id: 'tester',      name: 'Test Writer',      color: 'text-amber-400',   bg: 'bg-amber-500/20',   description: 'Comprehensive tests and edge cases' },
  { id: 'performance', name: 'Performance',      color: 'text-orange-400',  bg: 'bg-orange-500/20',  description: 'N+1 queries, memory leaks, bottlenecks' },
  { id: 'researcher',  name: 'Researcher',       color: 'text-indigo-400',  bg: 'bg-indigo-500/20',  description: 'Investigate, compare, recommend' },
  { id: 'planner',     name: 'Planner',          color: 'text-violet-400',  bg: 'bg-violet-500/20',  description: 'Detailed step-by-step plans' },
];

const ROLE_MAP = new Map(EXPERT_ROLES.map((r) => [r.id, r]));
const DEFAULT_ROLE = EXPERT_ROLES[0]; // general

const STATUS_STYLES: Record<StepStatus, { dot: string; ring: string; node: string }> = {
  pending: { dot: 'bg-gray-500', ring: '', node: '' },
  running: { dot: 'bg-blue-500 animate-pulse', ring: 'ring-2 ring-blue-500/50', node: 'animate-glow-pulse' },
  completed: { dot: 'bg-emerald-500', ring: '', node: '' },
  failed: { dot: 'bg-red-500', ring: 'ring-2 ring-red-500/30', node: '' },
  skipped: { dot: 'bg-gray-600', ring: '', node: '' },
};

/** Resolve expert role from executorConfig, with legacy fallbacks */
function getStepRole(step: LocalStep): ExpertRole {
  const roleId = step.executorConfig.role as string | undefined;
  if (roleId && ROLE_MAP.has(roleId)) return ROLE_MAP.get(roleId)!;
  // Legacy: map old modes/executor types
  const mode = step.executorConfig.mode as string | undefined;
  if (mode === 'plan' || step.executorType === 'claude-plan') return ROLE_MAP.get('planner')!;
  if (mode === 'review' || step.executorType === 'claude-review') return ROLE_MAP.get('reviewer')!;
  return DEFAULT_ROLE;
}

// ─── StepNode (custom React Flow node) ─────────────

function StepNode({ data, selected }: NodeProps<StepNode>) {
  const [editing, setEditing] = useState(false);
  const [localName, setLocalName] = useState(data.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalName(data.name);
  }, [data.name]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const badge = ROLE_MAP.get(data.role) || DEFAULT_ROLE;
  const statusStyle = STATUS_STYLES[data.status];
  const preview = data.prompt ? data.prompt.slice(0, 60) + (data.prompt.length > 60 ? '...' : '') : '';

  function commitName() {
    setEditing(false);
    const trimmed = localName.trim();
    if (trimmed && trimmed !== data.name) {
      data.onNameChange(data.stepId, trimmed);
    } else {
      setLocalName(data.name);
    }
  }

  return (
    <div
      className={`
        relative rounded-xl border transition-all duration-200 w-[220px]
        ${selected ? 'border-gl-purple/60 shadow-lg shadow-purple-900/30' : 'border-white/10 hover:border-white/20'}
        ${statusStyle.ring} ${statusStyle.node}
        glass
      `}
      onClick={() => data.onSelect(data.stepId)}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-gl-purple !border-2 !border-gl-surface !-top-1.5"
      />

      <div className="p-3 space-y-2">
        {/* Header: name + status */}
        <div className="flex items-center gap-2">
          {data.isRunning && (
            <span className={`w-2 h-2 rounded-full shrink-0 ${statusStyle.dot}`} />
          )}

          {editing ? (
            <input
              ref={inputRef}
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') { setLocalName(data.name); setEditing(false); }
              }}
              className="text-sm text-white bg-transparent border-b border-gl-purple/50 outline-none w-full font-medium"
            />
          ) : (
            <span
              className="text-sm text-white font-medium truncate cursor-text"
              onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
              title="Double-click to edit"
            >
              {data.name}
            </span>
          )}
        </div>

        {/* Role badge + webhook indicator */}
        <div className="flex items-center gap-1.5">
          <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.bg} ${badge.color} uppercase tracking-wider`}>
            {badge.name}
          </span>
          {data.waitForWebhook && (
            <span className="text-[9px] text-amber-400/70 font-medium" title="Waits for external webhook to complete">
              webhook
            </span>
          )}
        </div>

        {/* Prompt preview */}
        {preview && (
          <p className="text-[11px] text-gray-500 leading-snug line-clamp-2">{preview}</p>
        )}

        {/* Auto-advance toggle */}
        <label
          className="flex items-center gap-1.5 text-[10px] text-gray-500 cursor-pointer select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={data.autoAdvance}
            onChange={() => data.onAutoAdvanceToggle(data.stepId)}
            className="accent-purple-500 w-3 h-3"
          />
          auto-advance
        </label>

        {/* Advance button — shown when step completed but autoAdvance is off */}
        {data.status === 'completed' && !data.autoAdvance && (
          <button
            onClick={(e) => { e.stopPropagation(); data.onAdvance(data.stepId); }}
            className="w-full text-[10px] font-medium px-2 py-1 rounded-md bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
          >
            Advance to next step
          </button>
        )}
      </div>

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-gl-blue !border-2 !border-gl-surface !-bottom-1.5"
      />
    </div>
  );
}

// ─── Node type registry ─────────────────────────────

const nodeTypes: NodeTypes = {
  stepNode: StepNode,
};

// ─── Inner canvas (needs ReactFlowProvider) ─────────

function CanvasInner({ workflowId, agents, onClose, onSaved }: Props) {
  const reactFlowInstance = useReactFlow();

  // Workflow metadata
  const [workflowName, setWorkflowName] = useState('Untitled Workflow');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [workflowStatus, setWorkflowStatus] = useState<string>('pending');

  // Steps local store (source of truth)
  const [steps, setSteps] = useState<LocalStep[]>([]);

  // React Flow nodes/edges
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Side panel
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // UI state
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [savedWorkflowId, setSavedWorkflowId] = useState<string | undefined>(workflowId);

  // Execution log
  const [executionLogs, setExecutionLogs] = useState<WorkflowStepLog[]>([]);
  const [logPanelCollapsed, setLogPanelCollapsed] = useState(true);

  // Toast notification
  const [toast, setToast] = useState<string | null>(null);

  const backdropRef = useRef<HTMLDivElement>(null);

  const isExecuting = ['running', 'paused'].includes(workflowStatus);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const selectedStep = useMemo(
    () => (selectedStepId ? steps.find((s) => s.id === selectedStepId) ?? null : null),
    [selectedStepId, steps],
  );

  const runningStepNames = useMemo(
    () => steps.filter((s) => s.status === 'running').map((s) => s.name),
    [steps],
  );

  // ── Listen for live execution logs ─────────────

  useSocket({
    onWorkflowStepLog: (log) => {
      if (savedWorkflowId && log.workflowId === savedWorkflowId) {
        setExecutionLogs((prev) => [...prev, log].slice(-500));
        setLogPanelCollapsed(false);
      }
    },
    onWorkflowStepUpdated: (step) => {
      if (savedWorkflowId && step.workflowId === savedWorkflowId) {
        setSteps((prev) => prev.map((s) =>
          s.id === step.id ? { ...s, status: step.status, autoAdvance: step.autoAdvance } : s
        ));

        // Show toast when a step completes or fails
        if (step.status === 'completed' && !step.autoAdvance) {
          showToast(`"${step.name}" completed — advance to continue`);
        } else if (step.status === 'completed') {
          showToast(`"${step.name}" completed`);
        } else if (step.status === 'failed') {
          showToast(`"${step.name}" failed`);
        }
      }
    },
  });

  // ── Load existing workflow ──────────────────────

  useEffect(() => {
    if (!workflowId) return;
    api.getWorkflowV2(workflowId).then(({ workflow, steps: fetchedSteps }) => {
      setWorkflowName(workflow.name);
      setWorkflowDescription(workflow.description);
      setWorkflowStatus(workflow.status);
      setSavedWorkflowId(workflow.id);

      const localSteps: LocalStep[] = fetchedSteps.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        positionX: s.positionX,
        positionY: s.positionY,
        executorType: s.executorType,
        executorId: s.executorId,
        executorConfig: s.executorConfig,
        autoAdvance: s.autoAdvance,
        status: s.status,
        dependsOn: s.dependsOn,
      }));

      setSteps(localSteps);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load workflow');
    });
  }, [workflowId]);

  // ── Sync steps -> nodes/edges ───────────────────

  const handleSelectStep = useCallback((stepId: string) => {
    setSelectedStepId(stepId);
  }, []);

  const handleNameChange = useCallback((stepId: string, name: string) => {
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, name } : s)));
  }, []);

  const handleAutoAdvanceToggle = useCallback((stepId: string) => {
    setSteps((prev) => prev.map((s) =>
      s.id === stepId ? { ...s, autoAdvance: !s.autoAdvance } : s,
    ));
  }, []);

  const handleAdvance = useCallback(async (stepId: string) => {
    if (!savedWorkflowId) return;
    try {
      await api.advanceWorkflowStep(savedWorkflowId, stepId);
      setSteps((prev) => prev.map((s) =>
        s.id === stepId ? { ...s, autoAdvance: true } : s,
      ));
      showToast('Step advanced — dependents will start on next cycle');
    } catch { /* silent */ }
  }, [savedWorkflowId, showToast]);

  useEffect(() => {
    const newNodes: StepNode[] = steps.map((step) => ({
      id: step.id,
      type: 'stepNode' as const,
      position: { x: step.positionX, y: step.positionY },
      selected: step.id === selectedStepId,
      data: {
        stepId: step.id,
        name: step.name,
        role: getStepRole(step).id,
        executorId: step.executorId,
        prompt: (step.executorConfig.prompt as string) || step.description || '',
        autoAdvance: step.autoAdvance,
        waitForWebhook: !!step.executorConfig.waitForWebhook,
        status: step.status,
        isRunning: isExecuting,
        onSelect: handleSelectStep,
        onNameChange: handleNameChange,
        onAutoAdvanceToggle: handleAutoAdvanceToggle,
        onAdvance: handleAdvance,
      },
    }));

    // Preserve existing node positions when they were dragged
    setNodes((prevNodes) => {
      const posMap = new Map(prevNodes.map((n) => [n.id, n.position]));
      return newNodes.map((n) => {
        const existing = posMap.get(n.id);
        if (existing) {
          return { ...n, position: existing };
        }
        return n;
      });
    });

    // Build edges from dependsOn
    const newEdges: Edge[] = [];
    for (const step of steps) {
      for (const depId of step.dependsOn) {
        newEdges.push({
          id: `e-${depId}-${step.id}`,
          source: depId,
          target: step.id,
          animated: isExecuting,
          style: { stroke: '#a855f7', strokeWidth: 2 },
        });
      }
    }
    setEdges(newEdges);
  }, [steps, selectedStepId, isExecuting, handleSelectStep, handleNameChange, handleAutoAdvanceToggle, handleAdvance, setNodes, setEdges]);

  // ── Node drag -> update step positions ──────────

  const handleNodesChange: OnNodesChange<StepNode> = useCallback(
    (changes: NodeChange<StepNode>[]) => {
      onNodesChange(changes);

      // Capture position changes
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          const { id } = change;
          const pos = change.position;
          setSteps((prev) => prev.map((s) =>
            s.id === id ? { ...s, positionX: Math.round(pos.x), positionY: Math.round(pos.y) } : s,
          ));
        }
      }
    },
    [onNodesChange],
  );

  const handleEdgesChange: OnEdgesChange<Edge> = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);

      // Handle edge removal
      for (const change of changes) {
        if (change.type === 'remove') {
          const edgeId = change.id;
          // Edge id format: e-{sourceId}-{targetId}
          const parts = edgeId.split('-');
          if (parts.length >= 3) {
            setEdges((currentEdges) => {
              const removedEdge = currentEdges.find((e) => e.id === edgeId);
              if (removedEdge) {
                setSteps((prev) => prev.map((s) =>
                  s.id === removedEdge.target
                    ? { ...s, dependsOn: s.dependsOn.filter((d) => d !== removedEdge.source) }
                    : s,
                ));
              }
              return currentEdges;
            });
          }
        }
      }
    },
    [onEdgesChange, setEdges],
  );

  // ── Edge connect ────────────────────────────────

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // Prevent self-connections
      if (connection.source === connection.target) return;
      // Prevent duplicate connections
      const exists = steps.find(
        (s) => s.id === connection.target && s.dependsOn.includes(connection.source!),
      );
      if (exists) return;

      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            animated: isExecuting,
            style: { stroke: '#a855f7', strokeWidth: 2 },
          },
          eds,
        ),
      );

      setSteps((prev) =>
        prev.map((s) =>
          s.id === connection.target
            ? { ...s, dependsOn: [...s.dependsOn, connection.source!] }
            : s,
        ),
      );
    },
    [steps, isExecuting, setEdges],
  );

  // ── Add step ────────────────────────────────────

  const addStep = useCallback(() => {
    const id = crypto.randomUUID();
    const viewport = reactFlowInstance.getViewport();
    const centerX = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
    const centerY = (-viewport.y + window.innerHeight / 2) / viewport.zoom;

    const newStep: LocalStep = {
      id,
      name: `Step ${steps.length + 1}`,
      description: '',
      positionX: Math.round(centerX - 110),
      positionY: Math.round(centerY - 60),
      executorType: 'claude-code',
      executorId: '',
      executorConfig: { role: 'general' },
      autoAdvance: true,
      status: 'pending',
      dependsOn: [],
    };

    setSteps((prev) => [...prev, newStep]);
    setSelectedStepId(id);
  }, [steps.length, reactFlowInstance]);

  // ── Delete step ─────────────────────────────────

  const deleteStep = useCallback((stepId: string) => {
    setSteps((prev) => {
      // Remove step and clean up dependsOn references
      return prev
        .filter((s) => s.id !== stepId)
        .map((s) => ({
          ...s,
          dependsOn: s.dependsOn.filter((d) => d !== stepId),
        }));
    });
    if (selectedStepId === stepId) {
      setSelectedStepId(null);
    }
  }, [selectedStepId]);

  // ── Update step field ───────────────────────────

  const updateStep = useCallback((stepId: string, patch: Partial<LocalStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, ...patch } : s)));
  }, []);

  // ── Save helpers ────────────────────────────────

  /** Build save payload from current canvas state */
  const buildPayload = useCallback(() => ({
    name: workflowName.trim(),
    description: workflowDescription.trim(),
    steps: steps.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      positionX: s.positionX,
      positionY: s.positionY,
      executorType: s.executorType,
      executorId: s.executorId || undefined,
      executorConfig: Object.keys(s.executorConfig).length > 0 ? s.executorConfig : undefined,
      autoAdvance: s.autoAdvance,
      dependsOn: s.dependsOn.length > 0 ? s.dependsOn : undefined,
    })),
  }), [workflowName, workflowDescription, steps]);

  /** Persist current state to server. Returns workflow ID on success, null on failure. */
  const saveWorkflow = useCallback(async (): Promise<string | null> => {
    if (!workflowName.trim()) {
      setError('Workflow name is required');
      return null;
    }
    if (steps.length === 0) {
      setError('Add at least one step');
      return null;
    }

    const payload = buildPayload();
    const result = savedWorkflowId
      ? await api.updateWorkflowV2(savedWorkflowId, payload)
      : await api.createWorkflowV2(payload);
    setSavedWorkflowId(result.workflow.id);
    return result.workflow.id;
  }, [workflowName, steps, savedWorkflowId, buildPayload]);

  // ── Save workflow ───────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      const id = await saveWorkflow();
      if (id) {
        showToast(savedWorkflowId ? 'Workflow updated' : 'Workflow created');
        onSaved?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  }, [saveWorkflow, savedWorkflowId, showToast, onSaved]);

  // ── Run workflow ────────────────────────────────

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError('');
    setExecutionLogs([]);
    setLogPanelCollapsed(false);

    try {
      // Always save before running so the executor has the latest config
      const id = await saveWorkflow();
      if (!id) {
        setRunning(false);
        return;
      }

      const wf = await api.startWorkflowV2(id);
      setWorkflowStatus(wf.status);
      showToast('Workflow saved & started — watching step progress below');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setRunning(false);
    }
  }, [saveWorkflow, showToast]);

  // ── Click on canvas background -> deselect ──────

  const onPaneClick = useCallback(() => {
    setSelectedStepId(null);
  }, []);

  // ── Backdrop click -> close ─────────────────────

  const handleBackdropClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target === backdropRef.current) {
      onClose();
    }
  }, [onClose]);

  // ── Agent options for side panel ────────────────

  const agentOptions = useMemo(() => {
    if (!selectedStep) return [];
    return onlineAgents.map((a) => ({ id: a.id, label: a.repoName || a.name }));
  }, [selectedStep, onlineAgents]);

  // ── Render ──────────────────────────────────────

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col"
    >
      {/* Main container — stop propagation so clicks inside don't trigger backdrop close */}
      <div
        className="flex-1 flex flex-col m-2 md:m-4 rounded-2xl overflow-hidden glass border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >

        {/* ── Toolbar ─────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
          {/* Name — stop key propagation so React Flow / parent handlers don't intercept typing */}
          <input
            type="text"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
            placeholder="Workflow name"
            className="text-sm font-semibold text-white bg-transparent border-b border-transparent hover:border-white/20 focus:border-gl-purple outline-none px-1 py-0.5 w-48 transition-colors"
          />

          {/* Description */}
          <input
            type="text"
            value={workflowDescription}
            onChange={(e) => setWorkflowDescription(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.stopPropagation()}
            placeholder="Description (optional)"
            className="text-xs text-gray-400 bg-transparent border-b border-transparent hover:border-white/20 focus:border-gl-purple outline-none px-1 py-0.5 flex-1 max-w-sm transition-colors"
          />

          <div className="flex-1" />

          {/* Error display */}
          {error && (
            <span className="text-xs text-red-400 max-w-xs truncate">{error}</span>
          )}

          {/* Add Step */}
          <button
            onClick={addStep}
            disabled={isExecuting}
            className="text-xs px-3 py-1.5 rounded-md glass-light border border-white/10 hover:border-white/20 text-gray-300 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            + Add Step
          </button>

          {/* Save */}
          <button
            onClick={handleSave}
            disabled={saving || isExecuting}
            className="text-xs px-4 py-1.5 rounded-md gl-gradient text-white font-medium hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>

          {/* Run */}
          <button
            onClick={handleRun}
            disabled={running || steps.length === 0 || !savedWorkflowId || isExecuting}
            className="text-xs px-4 py-1.5 rounded-md font-medium text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-500"
          >
            {running ? 'Starting...' : 'Run'}
          </button>

          {/* Close */}
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-xl leading-none px-1 transition-colors"
            title="Close"
          >
            &times;
          </button>
        </div>

        {/* ── Canvas + Side Panel ─────────────── */}
        <div className="flex-1 flex overflow-hidden relative">

          {/* React Flow Canvas */}
          <div className="flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onPaneClick={onPaneClick}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              deleteKeyCode="Delete"
              snapToGrid
              snapGrid={[16, 16]}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{
                animated: isExecuting,
                style: { stroke: '#a855f7', strokeWidth: 2 },
              }}
            >
              <Background color="#ffffff08" gap={20} />
              <Controls
                showInteractive={false}
                className="!bg-gl-surface !border-white/10 !rounded-lg !shadow-xl [&>button]:!bg-gl-surface [&>button]:!border-white/10 [&>button]:!text-gray-400 [&>button:hover]:!text-white [&>button:hover]:!bg-white/10"
              />
              <MiniMap
                style={{ background: 'rgba(15, 15, 35, 0.8)', borderRadius: 8 }}
                nodeColor={() => '#a855f7'}
                maskColor="rgba(0, 0, 0, 0.4)"
                className="!border-white/10"
              />
            </ReactFlow>
          </div>

          {/* ── Side Panel ─────────────────────── */}
          <div
            className={`
              absolute top-0 right-0 h-full w-80 glass-dark border-l border-white/[0.06]
              transition-transform duration-300 ease-in-out z-10
              ${selectedStep ? 'translate-x-0' : 'translate-x-full'}
            `}
          >
            {selectedStep && (
              <SidePanel
                step={selectedStep}
                agentOptions={agentOptions}
                isExecuting={isExecuting}
                onUpdate={(patch) => updateStep(selectedStep.id, patch)}
                onDelete={() => deleteStep(selectedStep.id)}
                onClose={() => setSelectedStepId(null)}
                onAdvance={() => handleAdvance(selectedStep.id)}
              />
            )}
          </div>
        </div>

        {/* ── Execution Log Panel ──────────────── */}
        {(isExecuting || executionLogs.length > 0) && (
          <WorkflowExecutionLog
            logs={executionLogs}
            collapsed={logPanelCollapsed}
            onToggle={() => setLogPanelCollapsed((c) => !c)}
            onClear={() => setExecutionLogs([])}
          />
        )}

        {/* ── Status bar ──────────────────────── */}
        <div className="flex items-center gap-4 px-4 py-1.5 border-t border-white/[0.06] text-[10px] text-gray-600 shrink-0">
          <span>{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
          <span>{edges.length} connection{edges.length !== 1 ? 's' : ''}</span>
          {savedWorkflowId && (
            <span className="font-mono">{savedWorkflowId.slice(0, 8)}</span>
          )}
          {isExecuting && runningStepNames.length > 0 ? (
            <span className="text-blue-400 animate-pulse">
              Running: {runningStepNames.join(', ')}
            </span>
          ) : isExecuting ? (
            <span className="text-blue-400 animate-pulse">Executing</span>
          ) : null}
          <span className="ml-auto">Drag to connect nodes. Double-click name to rename.</span>
        </div>

        {/* ── Toast notification ──────────────── */}
        {toast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-lg bg-emerald-600/90 text-white text-xs font-medium shadow-lg animate-fade-in">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Side Panel Component ───────────────────────────

function SidePanel({
  step,
  agentOptions,
  isExecuting,
  onUpdate,
  onDelete,
  onClose,
  onAdvance,
}: {
  step: LocalStep;
  agentOptions: { id: string; label: string }[];
  isExecuting: boolean;
  onUpdate: (patch: Partial<LocalStep>) => void;
  onDelete: () => void;
  onClose: () => void;
  onAdvance: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset confirm when step changes
  useEffect(() => {
    setConfirmDelete(false);
  }, [step.id]);

  const currentPrompt = (step.executorConfig.prompt as string) || step.description || '';
  const currentRole = getStepRole(step);

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
        <h3 className="text-sm font-semibold text-white">Edit Step</h3>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-white text-lg leading-none transition-colors"
        >
          &times;
        </button>
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Step name */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Name</label>
          <input
            type="text"
            value={step.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={isExecuting}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none disabled:opacity-50"
            placeholder="Step name"
          />
        </div>

        {/* Expert role selector */}
        <div>
          <label className="block text-xs text-gray-500 mb-1.5">Expert Role</label>
          <div className="grid grid-cols-2 gap-1.5 max-h-52 overflow-y-auto pr-0.5">
            {EXPERT_ROLES.map((role) => {
              const isActive = currentRole.id === role.id;
              return (
                <button
                  key={role.id}
                  onClick={() =>
                    onUpdate({
                      executorType: 'claude-code',
                      executorConfig: { ...step.executorConfig, role: role.id },
                    })
                  }
                  disabled={isExecuting}
                  className={`text-left rounded-lg px-2.5 py-2 border transition-colors disabled:opacity-50 ${
                    isActive
                      ? `${role.bg} ${role.color} border-current/30`
                      : 'bg-white/[0.02] border-white/[0.06] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="text-[11px] font-medium leading-tight">{role.name}</div>
                  <div className="text-[9px] leading-snug mt-0.5 opacity-60">{role.description}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent selector */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Agent</label>
          <select
            value={step.executorId}
            onChange={(e) => onUpdate({ executorId: e.target.value })}
            disabled={isExecuting}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
          >
            <option value="">-- Select agent --</option>
            {agentOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          {agentOptions.length === 0 && (
            <p className="text-[10px] text-gray-600 mt-1 italic">No online agents</p>
          )}
        </div>

        {/* Prompt */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">What should this agent do?</label>
          <textarea
            value={currentPrompt}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              onUpdate({
                description: e.target.value,
                executorConfig: { ...step.executorConfig, prompt: e.target.value },
              });
            }}
            disabled={isExecuting}
            rows={6}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-50"
            placeholder="Describe the task in natural language..."
          />
        </div>

        {/* Auto-advance */}
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={step.autoAdvance}
            onChange={() => onUpdate({ autoAdvance: !step.autoAdvance })}
            disabled={isExecuting}
            className="accent-purple-500"
          />
          Auto-advance to next step
        </label>

        {/* Wait for webhook */}
        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!step.executorConfig.waitForWebhook}
            onChange={() =>
              onUpdate({
                executorConfig: { ...step.executorConfig, waitForWebhook: !step.executorConfig.waitForWebhook },
              })
            }
            disabled={isExecuting}
            className="accent-amber-500"
          />
          Wait for external webhook
        </label>
        {!!step.executorConfig.waitForWebhook && (
          <div className="text-[10px] text-gray-500 bg-black/20 rounded-md px-3 py-2 font-mono break-all select-all">
            <div className="text-amber-400/70 mb-1 font-sans">
              Step won't auto-complete. Call this when done:
            </div>
            curl -X POST {window.location.origin}/api/workflows/webhook/{step.id}/complete
          </div>
        )}

        {/* Dependencies display */}
        {step.dependsOn.length > 0 && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Depends on</label>
            <div className="flex flex-wrap gap-1">
              {step.dependsOn.map((depId) => (
                <span
                  key={depId}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-mono"
                >
                  {depId.slice(0, 8)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Status (during execution) */}
        {isExecuting && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Status</label>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${STATUS_STYLES[step.status].dot}`} />
              <span className="text-xs text-gray-300 capitalize">{step.status}</span>
            </div>
            {step.status === 'completed' && !step.autoAdvance && (
              <button
                onClick={onAdvance}
                className="mt-2 w-full text-xs font-medium px-3 py-2 rounded-md bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/20 transition-colors"
              >
                Advance to next step
              </button>
            )}
          </div>
        )}
      </div>

      {/* Panel footer */}
      <div className="px-4 py-3 border-t border-white/[0.06] shrink-0">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-400">Delete this step?</span>
            <button
              onClick={onDelete}
              className="text-xs px-3 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs px-3 py-1 rounded text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={isExecuting}
            className="text-xs text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Delete step
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Exported Component (wraps with ReactFlowProvider) ──

export function WorkflowCanvasEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
