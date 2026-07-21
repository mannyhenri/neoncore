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
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Node,
  type Edge,
  type EdgeTypes,
  type EdgeProps,
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
  AgentType,
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
  executorType: StepExecutorType;
  executorId: string;
  agentName: string;
  agentType: AgentType | '';
  prompt: string;
  autoAdvance: boolean;
  waitForWebhook: boolean;
  useIntent: boolean;
  gateType: string;
  status: StepStatus;
  isRunning: boolean;
  recoveryStatus: string;
  onSelect: (stepId: string) => void;
  onNameChange: (stepId: string, name: string) => void;
  onAutoAdvanceToggle: (stepId: string) => void;
  onAdvance: (stepId: string) => void;
  onForceComplete: (stepId: string) => void;
  onSkip: (stepId: string) => void;
  onRecover: (stepId: string) => void;
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
  dispatchedPrompt: string;
  result?: string;
  error?: string;
  recoveryStatus?: string;
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

/** Resolve expert role from executorConfig */
function getStepRole(step: LocalStep): ExpertRole {
  const roleId = step.executorConfig.role as string | undefined;
  if (roleId && ROLE_MAP.has(roleId)) return ROLE_MAP.get(roleId)!;
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
        relative rounded-xl border transition-all duration-200 w-[300px]
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

      {/* Header bar: status dot + name */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusStyle.dot}`} />

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
            className="text-sm text-white font-semibold truncate cursor-text flex-1"
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            title="Double-click to edit"
          >
            {data.name}
          </span>
        )}
      </div>

      {/* Meta row: role + agent type + agent name + webhook */}
      <div className="flex items-center gap-1.5 px-3 pb-2 flex-wrap">
        <span className={`inline-block text-[13px] font-semibold px-2 py-0.5 rounded-full ${badge.bg} ${badge.color} uppercase tracking-wider`}>
          {badge.name}
        </span>
        {data.agentType === 'claude' && (
          <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-500/15 text-orange-400 uppercase tracking-wider">
            CC
          </span>
        )}
        {data.agentType === 'gridlight' && (
          <span className="text-[13px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 uppercase tracking-wider">
            GL
          </span>
        )}
        {data.agentName ? (
          <span className="text-[13px] text-cyan-400/80 font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/10 truncate max-w-[140px]" title={data.agentName}>
            {data.agentName}
          </span>
        ) : (
          <span className="text-[13px] text-gray-600 italic">no cartridge</span>
        )}
        {data.waitForWebhook && (
          <span className="text-[13px] text-amber-400/70 font-medium px-1.5 py-0.5 rounded-full bg-amber-500/10" title="Waits for external webhook to complete">
            webhook
          </span>
        )}
        {data.useIntent && (
          <span className="text-[13px] text-emerald-400/70 font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10">
            intent
          </span>
        )}
        {data.executorType === 'decision' && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-violet-400 bg-violet-900/40 px-1.5 py-0.5 rounded">Decision</span>
        )}
        {data.executorType === 'review-gate' && (
          <span className="text-[13px] text-rose-400/70 font-medium px-1.5 py-0.5 rounded-full bg-rose-500/10 uppercase">
            critic
          </span>
        )}
        {data.executorType === 'deliberation' && (
          <span className="text-[13px] text-violet-400/70 font-medium px-1.5 py-0.5 rounded-full bg-violet-500/10 uppercase">
            deliberation
          </span>
        )}
        {data.executorType === 'quality-gate' && (
          <span className="text-[13px] text-teal-400/70 font-medium px-1.5 py-0.5 rounded-full bg-teal-500/10 uppercase">
            {data.gateType || 'quality'}
          </span>
        )}
        {data.executorType === 'command' && (
          <span className="text-[13px] text-sky-400/70 font-medium px-1.5 py-0.5 rounded-full bg-sky-500/10 uppercase">
            command
          </span>
        )}
      </div>

      {/* Prompt body */}
      {data.prompt ? (
        <div className="px-3 pb-2">
          <p className="text-[13px] text-gray-400 leading-relaxed line-clamp-4 whitespace-pre-wrap">{data.prompt}</p>
        </div>
      ) : (
        <div className="px-3 pb-2">
          <p className="text-[13px] text-gray-600 italic">No prompt configured</p>
        </div>
      )}

      {/* Footer: controls */}
      <div className="px-3 pb-3 space-y-1.5">
        {/* Auto-advance toggle */}
        <label
          className="flex items-center gap-1.5 text-[13px] text-gray-500 cursor-pointer select-none"
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
            className="w-full text-[13px] font-medium px-2 py-1 rounded-md bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
          >
            Advance to next step
          </button>
        )}

        {/* Force complete — shown when step is running (and not interrupted) */}
        {data.status === 'running' && data.recoveryStatus !== 'interrupted' && data.recoveryStatus !== 'recovery_failed' && data.recoveryStatus !== 'recovering' && (
          <button
            onClick={(e) => { e.stopPropagation(); data.onForceComplete(data.stepId); }}
            className="w-full text-[13px] font-medium px-2 py-1 rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
          >
            Mark complete
          </button>
        )}

        {/* Recovery: the agent died mid-run. Resume replays the stored transcript. */}
        {(data.recoveryStatus === 'interrupted' || data.recoveryStatus === 'recovery_failed') && (
          <button
            onClick={(e) => { e.stopPropagation(); data.onRecover(data.stepId); }}
            className="w-full text-[13px] font-medium px-2 py-1 rounded-md bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
          >
            {data.recoveryStatus === 'recovery_failed' ? 'Retry recovery' : 'Resume interrupted step'}
          </button>
        )}
        {data.recoveryStatus === 'recovering' && (
          <div className="w-full text-[12px] text-amber-300/80 text-center py-1">Recovering…</div>
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

// ─── Custom edge with delete button ────────────────

function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const { deleteElements } = useReactFlow();

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const onDelete = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      deleteElements({ edges: [{ id }] });
    },
    [id, deleteElements],
  );

  return (
    <>
      {/* Invisible wider hit area for hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? '#c084fc' : '#a855f7',
          strokeWidth: selected || hovered ? 3 : 2,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            opacity: hovered || selected ? 1 : 0,
            transition: 'opacity 150ms',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <button
            onClick={onDelete}
            className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 border border-red-500/60 text-red-400 hover:bg-red-900 hover:text-red-200 hover:border-red-400 transition-colors text-xs leading-none cursor-pointer"
            title="Delete connection"
          >
            &times;
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ─── Routing edge (dashed amber, for conditional routing rules) ─────────────

interface RoutingRule {
  id: string;
  condition: 'contains' | 'not_contains' | 'starts_with' | 'matches_regex';
  value: string;
  nextStepId: string;
}

function RoutingEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps & { data?: { label?: string; onDelete?: (id: string) => void } }) {
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#fbbf24' : '#f59e0b',
          strokeWidth: selected || hovered ? 3 : 2,
          strokeDasharray: '6 3',
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            opacity: hovered || selected ? 1 : 0,
            transition: 'opacity 150ms',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div className="flex items-center gap-1.5">
            {data?.label && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-900/80 text-amber-300 border border-amber-500/30 whitespace-nowrap">
                {data.label}
              </span>
            )}
            {data?.onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); data.onDelete!(id); }}
                className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 border border-amber-500/60 text-amber-400 hover:bg-amber-900 hover:text-amber-200 hover:border-amber-400 transition-colors text-xs leading-none cursor-pointer"
                title="Remove routing rule"
              >
                &times;
              </button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes: EdgeTypes = {
  deletable: DeletableEdge,
  routing: RoutingEdge,
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
  const [deferredPopup, setDeferredPopup] = useState<{
    workflowId: string;
    agentSteps: { stepId: string; stepName: string }[];
    promptSteps: { stepId: string; stepName: string; field: string; label: string }[];
  } | null>(null);
  const [deferredAssignments, setDeferredAssignments] = useState<Record<string, string>>({});
  const [deferredPrompts, setDeferredPrompts] = useState<Record<string, Record<string, string>>>({});

  // Run mode: if this workflow is a run (has templateId), it's read-only
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [runNumber, setRunNumber] = useState(0);
  const isRunView = !!templateId;

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

  // ── Workflow-level cartridge ────────────────────
  // 99% of workflows run every step on the same cartridge, so rather than
  // picking one per step we pick it once for the whole workflow and fan it
  // out to all steps. Derived from the steps (single source of truth): if
  // every step shares one cartridge we show it, otherwise the selector reads
  // as unset until the user picks one (which then unifies all steps).
  const workflowCartridge = useMemo(() => {
    const ids = new Set(
      steps.map((s) => s.executorId).filter((id) => id && id !== '__deferred__'),
    );
    return ids.size === 1 ? [...ids][0] : '';
  }, [steps]);

  const setWorkflowCartridge = useCallback((executorId: string) => {
    setSteps((prev) => prev.map((s) => ({ ...s, executorId })));
  }, []);

  // ── Auto-zoom to running step ───────────────────
  const prevRunningIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isExecuting) { prevRunningIdRef.current = null; return; }
    const runningStep = steps.find((s) => s.status === 'running');
    if (!runningStep || prevRunningIdRef.current === runningStep.id) return;
    prevRunningIdRef.current = runningStep.id;
    const node = nodes.find((n) => n.id === runningStep.id);
    if (!node) return;
    reactFlowInstance.setCenter(node.position.x + 150, node.position.y + 110, { zoom: 0.85, duration: 600 });
  }, [steps, isExecuting, nodes, reactFlowInstance]);

  // ── Auto-layout: spread nodes vertically ───────
  const autoLayout = useCallback(() => {
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const sorted: string[] = [];
    function visit(id: string) {
      if (visited.has(id)) return;
      visited.add(id);
      const s = stepMap.get(id);
      if (s) for (const dep of s.dependsOn) visit(dep);
      sorted.push(id);
    }
    for (const s of steps) visit(s.id);
    const indexMap = new Map(sorted.map((id, i) => [id, i]));
    setSteps((prev) => prev.map((s) => ({
      ...s,
      positionX: 300,
      positionY: 50 + (indexMap.get(s.id) ?? 0) * 280,
    })));
  }, [steps]);

  // ── Listen for live execution logs ─────────────

  useSocket({
    // Keep the workflow-level status in sync. Without this, individual steps turn green via
    // onWorkflowStepUpdated but the run's own status (workflowStatus → isExecuting) was set
    // only on load and never flipped — so a finished run kept reading as "running" on the
    // canvas even though every step had completed.
    onWorkflowUpdated: (wf) => {
      if (savedWorkflowId && wf.id === savedWorkflowId) {
        setWorkflowStatus(wf.status);
        setRunNumber(wf.runNumber);
        setTemplateId(wf.templateId);
      }
    },
    onWorkflowStepLog: (log) => {
      if (savedWorkflowId && log.workflowId === savedWorkflowId) {
        setExecutionLogs((prev) => [...prev, log].slice(-500));
        setLogPanelCollapsed(false);
      }
    },
    onWorkflowStepUpdated: (step) => {
      if (savedWorkflowId && step.workflowId === savedWorkflowId) {
        setSteps((prev) => prev.map((s) =>
          s.id === step.id ? {
            ...s,
            status: step.status,
            autoAdvance: step.autoAdvance,
            dispatchedPrompt: step.dispatchedPrompt || s.dispatchedPrompt,
            result: step.result ?? s.result,
            error: step.error ?? s.error,
            recoveryStatus: step.recoveryStatus ?? s.recoveryStatus,
          } : s
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
    onWorkflowStepRecovery: (data) => {
      if (savedWorkflowId && data.workflowId === savedWorkflowId) {
        setSteps((prev) => prev.map((s) =>
          s.id === data.stepId ? { ...s, status: data.status as StepStatus, recoveryStatus: data.recoveryStatus } : s
        ));
        if (data.recoveryStatus === 'interrupted') {
          showToast(`"${data.name}" was interrupted — Resume to recover`);
        } else if (data.recoveryStatus === 'recovered') {
          showToast(`"${data.name}" recovery dispatched`);
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
      setTemplateId(workflow.templateId);
      setRunNumber(workflow.runNumber);

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
        dispatchedPrompt: s.dispatchedPrompt || '',
        result: s.result || '',
        error: s.error || '',
        recoveryStatus: s.recoveryStatus || '',
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

  const handleForceComplete = useCallback(async (stepId: string) => {
    if (!savedWorkflowId) return;
    try {
      await api.completeWorkflowStep(savedWorkflowId, stepId, 'Force-completed manually');
      setSteps((prev) => prev.map((s) =>
        s.id === stepId ? { ...s, status: 'completed' } : s,
      ));
      showToast('Step marked as completed');
    } catch { /* silent */ }
  }, [savedWorkflowId, showToast]);

  const handleRecover = useCallback(async (stepId: string) => {
    try {
      // Optimistic: show "Recovering…" immediately.
      setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, recoveryStatus: 'recovering' } : s)));
      const res = await api.recoverStep(stepId);
      if (res.ok) {
        setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, status: 'running', recoveryStatus: 'recovered' } : s)));
        showToast('Recovery dispatched — replaying transcript to the agent');
      } else {
        setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, recoveryStatus: res.recoveryStatus || 'recovery_failed' } : s)));
        showToast(`Recovery failed: ${res.reason}`);
      }
    } catch (err) {
      setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, recoveryStatus: 'recovery_failed' } : s)));
      showToast(err instanceof Error ? err.message : 'Recovery failed');
    }
  }, [showToast]);

  const handleSkipStep = useCallback(async (stepId: string) => {
    if (!savedWorkflowId) return;
    try {
      await api.skipWorkflowStep(savedWorkflowId, stepId);
      setSteps((prev) => prev.map((s) =>
        s.id === stepId ? { ...s, status: 'skipped' } : s,
      ));
      showToast('Step skipped');
    } catch { /* silent */ }
  }, [savedWorkflowId, showToast]);

  const handleCompleteWorkflow = useCallback(async () => {
    if (!savedWorkflowId) return;
    try {
      await api.completeWorkflowV2(savedWorkflowId);
      setWorkflowStatus('completed');
      showToast('Workflow completed — remaining steps skipped');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete workflow');
    }
  }, [savedWorkflowId, showToast]);

  // Build agent lookup: id -> { name, type }
  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; type: AgentType }>();
    for (const a of agents) {
      map.set(a.id, { name: a.repoName || a.name, type: a.agentType });
    }
    return map;
  }, [agents]);

  useEffect(() => {
    const newNodes: StepNode[] = steps.map((step) => {
      const agent = step.executorId ? agentMap.get(step.executorId) : undefined;
      return {
        id: step.id,
        type: 'stepNode' as const,
        position: { x: step.positionX, y: step.positionY },
        selected: step.id === selectedStepId,
        data: {
          stepId: step.id,
          name: step.name,
          role: getStepRole(step).id,
          executorType: step.executorType,
          executorId: step.executorId,
          agentName: agent?.name || '',
          agentType: agent?.type || '',
          prompt: (step.executorConfig.prompt as string) || step.description || '',
          autoAdvance: step.autoAdvance,
          waitForWebhook: !!step.executorConfig.waitForWebhook,
          useIntent: !!step.executorConfig.useIntent,
          gateType: (step.executorConfig.gateType as string) || '',
          status: step.status,
          isRunning: isExecuting,
          recoveryStatus: step.recoveryStatus || '',
          onSelect: handleSelectStep,
          onNameChange: handleNameChange,
          onAutoAdvanceToggle: handleAutoAdvanceToggle,
          onAdvance: handleAdvance,
          onForceComplete: handleForceComplete,
          onSkip: handleSkipStep,
          onRecover: handleRecover,
        },
      };
    });

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

    // Build edges from dependsOn + routing rules
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
      // Routing rule edges (dashed amber)
      const routingRules = (step.executorConfig.routingRules as RoutingRule[]) || [];
      for (const rule of routingRules) {
        if (!rule.nextStepId) continue;
        const condLabel = `if ${rule.condition.replace(/_/g, ' ')} "${rule.value.slice(0, 20)}${rule.value.length > 20 ? '…' : ''}"`;
        newEdges.push({
          id: `r-${step.id}-${rule.id}`,
          source: step.id,
          target: rule.nextStepId,
          type: 'routing',
          animated: false,
          data: {
            label: condLabel,
            onDelete: (edgeId: string) => {
              // edgeId format: r-{sourceStepId}-{ruleId}
              const parts = edgeId.split('-');
              if (parts.length < 3) return;
              const sourceId = parts[1];
              const ruleId = parts.slice(2).join('-');
              setSteps((prev) => prev.map((s) => {
                if (s.id !== sourceId) return s;
                const rules = (s.executorConfig.routingRules as RoutingRule[]) || [];
                return { ...s, executorConfig: { ...s.executorConfig, routingRules: rules.filter((r) => r.id !== ruleId) } };
              }));
            },
          },
        });
      }
    }
    setEdges(newEdges);
  }, [steps, selectedStepId, isExecuting, agentMap, handleSelectStep, handleNameChange, handleAutoAdvanceToggle, handleAdvance, handleForceComplete, handleSkipStep, handleRecover, setNodes, setEdges]);

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
          // Routing edges (r-*) are managed via their onDelete data callback — skip here
          if (edgeId.startsWith('r-')) continue;
          // Dependency edge id format: e-{sourceId}-{targetId}
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
      executorId: workflowCartridge,
      executorConfig: { role: 'general' },
      autoAdvance: true,
      status: 'pending',
      dependsOn: [],
      dispatchedPrompt: '',
    };

    setSteps((prev) => [...prev, newStep]);
    setSelectedStepId(id);
  }, [steps.length, reactFlowInstance, workflowCartridge]);

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

      // Fetch fresh steps from server to check for deferred assignments and prompts
      const { steps: freshSteps } = await api.getWorkflowV2(id);

      // Deferred cartridge assignments
      const agentSteps = freshSteps.filter((s) => {
        if (s.executorId === '__deferred__') return true;
        const cfg = s.executorConfig as Record<string, unknown>;
        if (s.executorType === 'review-gate' && cfg.reviewAgentId === '__deferred__') return true;
        return false;
      }).map((s) => ({ stepId: s.id, stepName: s.name }));

      // Deferred prompt inputs (empty prompt fields)
      const promptSteps: { stepId: string; stepName: string; field: string; label: string }[] = [];
      for (const s of freshSteps) {
        const cfg = s.executorConfig as Record<string, unknown>;
        if (s.executorType === 'claude-code' || s.executorType === undefined) {
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
        setDeferredPopup({ workflowId: id, agentSteps, promptSteps });
        setDeferredAssignments({});
        setDeferredPrompts({});
        setRunning(false);
        return;
      }

      const result = await api.startWorkflowV2(id);
      // If a new run was created (clone), switch to viewing it
      if (result.workflow.id !== id) {
        setSavedWorkflowId(result.workflow.id);
        setTemplateId(result.workflow.templateId);
        setRunNumber(result.workflow.runNumber);
        setSteps(result.steps.map((s) => ({
          id: s.id, name: s.name, description: s.description,
          positionX: s.positionX, positionY: s.positionY,
          executorType: s.executorType, executorId: s.executorId,
          executorConfig: s.executorConfig, autoAdvance: s.autoAdvance,
          status: s.status, dependsOn: s.dependsOn, dispatchedPrompt: s.dispatchedPrompt || '',
          result: s.result || '', error: s.error || '',
        })));
      }
      setWorkflowStatus(result.workflow.status);
      showToast(`Run #${result.workflow.runNumber || ''} started — watching step progress below`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setRunning(false);
    }
  }, [saveWorkflow, showToast]);

  const handleDeferredRun = useCallback(async () => {
    if (!deferredPopup) return;
    // Validate all deferred agents have assignments
    const allAgentsAssigned = deferredPopup.agentSteps.every((s) => deferredAssignments[s.stepId]);
    // Validate all deferred prompts have values
    const allPromptsAssigned = deferredPopup.promptSteps.every((s) => deferredPrompts[s.stepId]?.[s.field]?.trim());
    if (!allAgentsAssigned || !allPromptsAssigned) return;

    setRunning(true);
    setDeferredPopup(null);
    try {
      const result = await api.startWorkflowV2(
        deferredPopup.workflowId,
        deferredPopup.agentSteps.length > 0 ? deferredAssignments : undefined,
        deferredPopup.promptSteps.length > 0 ? deferredPrompts : undefined,
      );
      if (result.workflow.id !== deferredPopup.workflowId) {
        setSavedWorkflowId(result.workflow.id);
        setTemplateId(result.workflow.templateId);
        setRunNumber(result.workflow.runNumber);
        setSteps(result.steps.map((s) => ({
          id: s.id, name: s.name, description: s.description,
          positionX: s.positionX, positionY: s.positionY,
          executorType: s.executorType, executorId: s.executorId,
          executorConfig: s.executorConfig, autoAdvance: s.autoAdvance,
          status: s.status, dependsOn: s.dependsOn, dispatchedPrompt: s.dispatchedPrompt || '',
          result: s.result || '', error: s.error || '',
        })));
      }
      setWorkflowStatus(result.workflow.status);
      showToast(`Run #${result.workflow.runNumber || ''} started`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setRunning(false);
    }
  }, [deferredPopup, deferredAssignments, deferredPrompts, showToast]);

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
    return [
      { id: '__deferred__', label: 'Choose when running' },
      ...onlineAgents.map((a) => ({ id: a.id, label: a.repoName || a.name })),
    ];
  }, [selectedStep, onlineAgents]);

  // ── Assigned projects (agents with real executor IDs) ──
  const assignedProjects = useMemo(() => {
    const names = steps
      .filter((s) => s.executorId && s.executorId !== '__deferred__')
      .map((s) => agents.find((a) => a.id === s.executorId))
      .filter(Boolean)
      .map((a) => a!.repoName || a!.name);
    return [...new Set(names)].filter(Boolean);
  }, [steps, agents]);

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
          {isRunView ? (
            <>
              <span className="text-sm font-semibold text-white px-1">{workflowName}</span>
              <span className="text-xs text-gl-purple font-medium px-2 py-0.5 rounded-full bg-gl-purple/15">
                Run #{runNumber}
              </span>
              {assignedProjects.length > 0 && assignedProjects.map((p) => (
                <span key={p} className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.06] text-gray-400 border border-white/[0.06]">
                  {p}
                </span>
              ))}
              {workflowDescription && (
                <span className="text-xs text-gray-500 truncate max-w-xs">{workflowDescription}</span>
              )}
            </>
          ) : (
            <>
              <input
                type="text"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
                placeholder="Workflow name"
                className="text-sm font-semibold text-white bg-transparent border-b border-transparent hover:border-white/20 focus:border-gl-purple outline-none px-1 py-0.5 w-48 transition-colors"
              />
              <input
                type="text"
                value={workflowDescription}
                onChange={(e) => setWorkflowDescription(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                onFocus={(e) => e.stopPropagation()}
                placeholder="Description (optional)"
                className="text-xs text-gray-400 bg-transparent border-b border-transparent hover:border-white/20 focus:border-gl-purple outline-none px-1 py-0.5 flex-1 max-w-sm transition-colors"
              />
              {/* One cartridge for the whole workflow — every step runs on it */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] text-gray-500">Cartridge</span>
                <select
                  value={workflowCartridge}
                  onChange={(e) => setWorkflowCartridge(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  disabled={isExecuting}
                  title="Every step in this workflow runs on this cartridge"
                  className="text-xs glass-input text-gray-300 rounded-md px-2 py-1 max-w-[180px] focus:outline-none focus:border-gl-purple disabled:opacity-50"
                >
                  <option value="">-- Select cartridge --</option>
                  {onlineAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="flex-1" />

          {/* Error display */}
          {error && (
            <span className="text-xs text-red-400 max-w-xs truncate">{error}</span>
          )}

          {/* Auto-layout */}
          <button
            onClick={autoLayout}
            disabled={steps.length === 0}
            className="text-xs px-3 py-1.5 rounded-md glass-light border border-white/10 hover:border-white/20 text-gray-300 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Spread steps evenly (280px apart)"
          >
            Auto-layout
          </button>

          {/* Add Step — templates only */}
          {!isRunView && (
            <>
              <button
                onClick={addStep}
                disabled={isExecuting}
                className="text-xs px-3 py-1.5 rounded-md glass-light border border-white/10 hover:border-white/20 text-gray-300 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                + Add Step
              </button>
              <button
                onClick={() => {
                  const id = crypto.randomUUID();
                  const maxY = steps.reduce((m, s) => Math.max(m, s.positionY), 0);
                  const newStep: LocalStep = {
                    id,
                    name: 'Decision',
                    description: '',
                    positionX: 300,
                    positionY: maxY + 175,
                    executorType: 'decision',
                    executorId: '',
                    executorConfig: { question: '', options: [] },
                    autoAdvance: true,
                    status: 'pending',
                    dispatchedPrompt: '',
                    dependsOn: [],
                  };
                  setSteps((prev) => [...prev, newStep]);
                  setSelectedStepId(id);
                }}
                disabled={isExecuting}
                className="text-xs px-3 py-1.5 rounded-md border border-violet-700/40 text-violet-400 hover:text-violet-300 hover:border-violet-600/60 bg-violet-900/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                + Decision
              </button>
              <button
                onClick={() => {
                  const id = crypto.randomUUID();
                  const maxY = steps.reduce((m, s) => Math.max(m, s.positionY), 0);
                  const newStep: LocalStep = {
                    id,
                    name: 'Capture Learnings',
                    description: 'Save workflow results to project memory',
                    positionX: 300,
                    positionY: maxY + 175,
                    executorType: 'connector',
                    executorId: '',
                    executorConfig: { connectorType: 'capture-learnings' },
                    autoAdvance: true,
                    status: 'pending',
                    dispatchedPrompt: '',
                    dependsOn: [],
                  };
                  setSteps((prev) => [...prev, newStep]);
                  setSelectedStepId(id);
                }}
                disabled={isExecuting}
                className="text-xs px-3 py-1.5 rounded-md border border-emerald-700/40 text-emerald-400 hover:text-emerald-300 hover:border-emerald-600/60 bg-emerald-900/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                + Learnings
              </button>
            </>
          )}

          {/* Save — templates only */}
          {!isRunView && (
            <button
              onClick={handleSave}
              disabled={saving || isExecuting}
              className="text-xs px-4 py-1.5 rounded-md gl-gradient text-white font-medium hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}

          {/* Run — templates only (runs already started) */}
          {!isRunView && (
            <button
              onClick={handleRun}
              disabled={running || steps.length === 0 || !savedWorkflowId || isExecuting}
              className="text-xs px-4 py-1.5 rounded-md font-medium text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-emerald-600 hover:bg-emerald-500"
            >
              {running ? 'Starting...' : 'Run'}
            </button>
          )}

          {/* Execution controls — visible only while running */}
          {isExecuting && (
            <>
              <div className="w-px h-5 bg-white/10" />
              <button
                onClick={handleCompleteWorkflow}
                className="text-xs px-3 py-1.5 rounded-md font-medium text-amber-400 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/20 transition-colors"
                title="Mark workflow as done — complete running steps and skip pending ones"
              >
                Complete
              </button>
            </>
          )}

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
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              deleteKeyCode="Delete"
              snapToGrid
              snapGrid={[16, 16]}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{
                type: 'deletable',
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
                steps={steps}
                agentOptions={agentOptions}
                isExecuting={isExecuting}
                workflowId={savedWorkflowId}
                onUpdate={(patch) => updateStep(selectedStep.id, patch)}
                onDelete={() => deleteStep(selectedStep.id)}
                onClose={() => setSelectedStepId(null)}
                onAdvance={() => handleAdvance(selectedStep.id)}
                onForceComplete={() => handleForceComplete(selectedStep.id)}
                onSkip={() => handleSkipStep(selectedStep.id)}
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
        <div className="flex items-center gap-4 px-4 py-1.5 border-t border-white/[0.06] text-[13px] text-gray-600 shrink-0">
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

      {/* Deferred assignment popup (cartridges + prompts) */}
      {deferredPopup && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0d0f12] border border-white/[0.08] rounded-xl shadow-2xl w-[520px] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
              <div>
                <h2 className="text-sm font-semibold text-white">Configure & Run</h2>
                <p className="text-[13px] text-gray-500 mt-0.5">Fill in the required fields before running</p>
              </div>
              <button onClick={() => setDeferredPopup(null)} className="text-gray-500 hover:text-white text-lg">&times;</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* One cartridge for every deferred step — all steps run on the same one */}
              {deferredPopup.agentSteps.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[13px] text-gray-500 uppercase tracking-wider">Cartridge</span>
                  <select
                    value={deferredAssignments[deferredPopup.agentSteps[0].stepId] || ''}
                    onChange={(e) => {
                      const agentId = e.target.value;
                      setDeferredAssignments(
                        Object.fromEntries(deferredPopup.agentSteps.map((s) => [s.stepId, agentId])),
                      );
                    }}
                    className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none"
                  >
                    <option value="">Select cartridge...</option>
                    {onlineAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>
                    ))}
                  </select>
                  <p className="text-[13px] text-gray-600">
                    Runs all {deferredPopup.agentSteps.length} step{deferredPopup.agentSteps.length > 1 ? 's' : ''} on this cartridge
                    {deferredPopup.agentSteps.length <= 6 && `: ${deferredPopup.agentSteps.map((s) => s.stepName).join(', ')}`}
                  </p>
                </div>
              )}

              {/* Deferred prompt inputs */}
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
        </div>
      )}
    </div>
  );
}

// ─── Intent Editor ──────────────────────────────────

function IntentEditor({
  step,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const intent = (step.executorConfig.intent as {
    objective?: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
    context?: string;
  }) || {};

  const updateIntent = (patch: Record<string, unknown>) => {
    onUpdate({
      executorConfig: {
        ...step.executorConfig,
        intent: { ...intent, ...patch },
      },
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Objective <span className="text-red-400">*</span></label>
        <textarea
          value={intent.objective || ''}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => updateIntent({ objective: e.target.value })}
          disabled={isExecuting}
          rows={3}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-50"
          placeholder="What should be accomplished?"
        />
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Acceptance Criteria</label>
        {(intent.acceptanceCriteria || []).map((criterion, i) => (
          <div key={i} className="flex items-center gap-1 mb-1">
            <span className="text-[13px] text-gray-600 w-4">{i + 1}.</span>
            <input
              type="text"
              value={criterion}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const updated = [...(intent.acceptanceCriteria || [])];
                updated[i] = e.target.value;
                updateIntent({ acceptanceCriteria: updated });
              }}
              disabled={isExecuting}
              className="flex-1 text-xs glass-input text-gray-300 rounded px-2 py-1 placeholder-gray-600 focus:outline-none disabled:opacity-50"
              placeholder="Criterion..."
            />
            <button
              onClick={() => {
                const updated = (intent.acceptanceCriteria || []).filter((_, j) => j !== i);
                updateIntent({ acceptanceCriteria: updated });
              }}
              disabled={isExecuting}
              className="text-gray-600 hover:text-red-400 text-xs disabled:opacity-30"
            >&times;</button>
          </div>
        ))}
        <button
          onClick={() => updateIntent({ acceptanceCriteria: [...(intent.acceptanceCriteria || []), ''] })}
          disabled={isExecuting}
          className="text-[13px] text-emerald-400/70 hover:text-emerald-400 transition-colors disabled:opacity-30"
        >
          + Add criterion
        </button>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Constraints</label>
        {(intent.constraints || []).map((constraint, i) => (
          <div key={i} className="flex items-center gap-1 mb-1">
            <span className="text-[13px] text-gray-600 w-4">-</span>
            <input
              type="text"
              value={constraint}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const updated = [...(intent.constraints || [])];
                updated[i] = e.target.value;
                updateIntent({ constraints: updated });
              }}
              disabled={isExecuting}
              className="flex-1 text-xs glass-input text-gray-300 rounded px-2 py-1 placeholder-gray-600 focus:outline-none disabled:opacity-50"
              placeholder="Constraint..."
            />
            <button
              onClick={() => {
                const updated = (intent.constraints || []).filter((_, j) => j !== i);
                updateIntent({ constraints: updated });
              }}
              disabled={isExecuting}
              className="text-gray-600 hover:text-red-400 text-xs disabled:opacity-30"
            >&times;</button>
          </div>
        ))}
        <button
          onClick={() => updateIntent({ constraints: [...(intent.constraints || []), ''] })}
          disabled={isExecuting}
          className="text-[13px] text-emerald-400/70 hover:text-emerald-400 transition-colors disabled:opacity-30"
        >
          + Add constraint
        </button>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Context</label>
        <textarea
          value={intent.context || ''}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => updateIntent({ context: e.target.value })}
          disabled={isExecuting}
          rows={2}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-50"
          placeholder="Additional context, relevant files, etc."
        />
      </div>
    </div>
  );
}

// ─── Review Gate Config ─────────────────────────────

function ReviewGateConfig({
  step,
  agentOptions,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  agentOptions: { id: string; label: string }[];
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const reviewAgentId = (step.executorConfig.reviewAgentId as string) || '';
  const criteria = (step.executorConfig.criteria as string) || '';
  const maxRetries = (step.executorConfig.maxRetries as number) || 3;

  return (
    <>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Review Cartridge</label>
        <select
          value={reviewAgentId}
          onChange={(e) =>
            onUpdate({
              executorId: e.target.value,
              executorConfig: { ...step.executorConfig, reviewAgentId: e.target.value },
            })
          }
          disabled={isExecuting}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
        >
          <option value="">-- Select critic cartridge --</option>
          {agentOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
        <p className="text-[13px] text-gray-600 mt-1">This cartridge evaluates the output from dependency steps</p>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Review Criteria</label>
        <textarea
          value={criteria}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) =>
            onUpdate({
              executorConfig: { ...step.executorConfig, criteria: e.target.value },
            })
          }
          disabled={isExecuting}
          rows={4}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-50"
          placeholder="What should the critic evaluate? e.g. code quality, acceptance criteria, security..."
        />
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Max Retries</label>
        <input
          type="number"
          min={1}
          max={5}
          value={maxRetries}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) =>
            onUpdate({
              executorConfig: { ...step.executorConfig, maxRetries: parseInt(e.target.value) || 3 },
            })
          }
          disabled={isExecuting}
          className="w-20 text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
        />
        <p className="text-[13px] text-gray-600 mt-1">
          If FAIL, resets dependency steps and re-runs up to {maxRetries} time(s)
        </p>
      </div>
    </>
  );
}

// ─── Deliberation Config ────────────────────────────

function DeliberationConfig({
  step,
  agentOptions,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  agentOptions: { id: string; label: string }[];
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const autoLaunch = !!step.executorConfig.autoLaunch;
  const panelAgentIds = (step.executorConfig.panelAgentIds as string[]) || [];
  const synthesisAgentId = (step.executorConfig.synthesisAgentId as string) || '';
  const repoPath = (step.executorConfig.repoPath as string) || '';
  const panelSize = (step.executorConfig.panelSize as number) || 2;
  const prompt = (step.executorConfig.prompt as string) || '';

  return (
    <>
      {/* Mode toggle */}
      <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={autoLaunch}
          onChange={() =>
            onUpdate({
              executorConfig: { ...step.executorConfig, autoLaunch: !autoLaunch },
            })
          }
          disabled={isExecuting}
          className="accent-violet-500"
        />
        Auto-launch VS Code windows
      </label>

      {autoLaunch ? (
        <>
          {/* Auto-launch config */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Repo Path</label>
            <input
              value={repoPath}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                onUpdate({ executorConfig: { ...step.executorConfig, repoPath: e.target.value } })
              }
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none disabled:opacity-50"
              placeholder="/path/to/project"
            />
            <p className="text-[13px] text-gray-600 mt-1">Each window opens this repo with its own Claude Code session</p>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Panel Size</label>
            <select
              value={panelSize}
              onChange={(e) =>
                onUpdate({ executorConfig: { ...step.executorConfig, panelSize: Number(e.target.value) } })
              }
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            >
              {[2, 3, 4].map((n) => (
                <option key={n} value={n}>{n} cartridges</option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <>
          {/* Manual agent selection */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Panel Cartridges (2-4)</label>
            <p className="text-[13px] text-gray-600 mb-1.5">Each cartridge receives the same prompt independently</p>
            {panelAgentIds.map((agentId, i) => (
              <div key={i} className="flex items-center gap-1 mb-1">
                <select
                  value={agentId}
                  onChange={(e) => {
                    const updated = [...panelAgentIds];
                    updated[i] = e.target.value;
                    onUpdate({ executorConfig: { ...step.executorConfig, panelAgentIds: updated } });
                  }}
                  disabled={isExecuting}
                  className="flex-1 text-xs glass-input text-gray-300 rounded px-2 py-1.5 focus:outline-none disabled:opacity-50"
                >
                  <option value="">-- Select --</option>
                  {agentOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const updated = panelAgentIds.filter((_, j) => j !== i);
                    onUpdate({ executorConfig: { ...step.executorConfig, panelAgentIds: updated } });
                  }}
                  disabled={isExecuting}
                  className="text-gray-600 hover:text-red-400 text-xs disabled:opacity-30"
                >&times;</button>
              </div>
            ))}
            {panelAgentIds.length < 4 && (
              <button
                onClick={() =>
                  onUpdate({ executorConfig: { ...step.executorConfig, panelAgentIds: [...panelAgentIds, ''] } })
                }
                disabled={isExecuting}
                className="text-[13px] text-violet-400/70 hover:text-violet-400 transition-colors disabled:opacity-30"
              >
                + Add panel cartridge
              </button>
            )}
          </div>
        </>
      )}

      <div>
        <label className="block text-xs text-gray-500 mb-1">Synthesis Cartridge</label>
        <select
          value={synthesisAgentId}
          onChange={(e) =>
            onUpdate({
              executorId: e.target.value,
              executorConfig: { ...step.executorConfig, synthesisAgentId: e.target.value },
            })
          }
          disabled={isExecuting}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
        >
          <option value="">-- Select synthesis cartridge --</option>
          {agentOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
        <p className="text-[13px] text-gray-600 mt-1">Combines all panel responses into a unified consensus</p>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Shared Prompt</label>
        <textarea
          value={prompt}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) =>
            onUpdate({
              description: e.target.value,
              executorConfig: { ...step.executorConfig, prompt: e.target.value },
            })
          }
          disabled={isExecuting}
          rows={5}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-50"
          placeholder="The prompt all panel cartridges will analyze..."
        />
      </div>
    </>
  );
}

// ─── Quality Gate Config ────────────────────────────

const QUALITY_GATE_PRESETS = [
  { id: 'test',        label: 'Test Suite',       color: 'text-amber-400',   bg: 'bg-amber-500/20',  description: 'Run all tests, gate on pass/fail' },
  { id: 'lint',        label: 'Lint & Type Check', color: 'text-cyan-400',    bg: 'bg-cyan-500/20',   description: 'Formatting, linting, type checking' },
  { id: 'security',    label: 'Security Scan',    color: 'text-red-400',     bg: 'bg-red-500/20',    description: 'Secrets, OWASP, dependency audit' },
  { id: 'build',       label: 'Build Check',      color: 'text-blue-400',    bg: 'bg-blue-500/20',   description: 'Verify the project builds cleanly' },
  { id: 'full-review', label: 'Full Code Review', color: 'text-emerald-400', bg: 'bg-emerald-500/20', description: 'Lint + security + quality + tests' },
  { id: 'custom',      label: 'Custom Gate',      color: 'text-gray-400',    bg: 'bg-gray-500/20',   description: 'Write your own quality check' },
];

function CommandStepConfig({
  step,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const [templates, setTemplates] = useState<{ id: string; name: string; content: string; category: string }[]>([]);

  useEffect(() => {
    api.getCommandTemplates().then(setTemplates).catch(() => {});
  }, []);

  const selectedId = (step.executorConfig.commandTemplateId as string) || '';
  const selectedTemplate = templates.find((t) => t.id === selectedId);

  // Group by category
  const grouped: Record<string, typeof templates> = {};
  for (const t of templates) {
    (grouped[t.category] ??= []).push(t);
  }

  return (
    <>
      {/* Cartridge is selected once at the workflow level (toolbar). */}

      {/* Command template selector */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Command Template</label>
        <select
          value={selectedId}
          onChange={(e) => onUpdate({ executorConfig: { ...step.executorConfig, commandTemplateId: e.target.value } })}
          disabled={isExecuting}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
        >
          <option value="">Select template...</option>
          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([category, items]) => (
            <optgroup key={category} label={category}>
              {items.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Preview */}
      {selectedTemplate && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">Preview</label>
          <pre className="text-[13px] text-gray-400 bg-white/[0.02] border border-white/[0.06] rounded-lg p-2.5 max-h-[120px] overflow-y-auto whitespace-pre-wrap font-mono">
            {selectedTemplate.content.slice(0, 500)}
          </pre>
        </div>
      )}

      {templates.length === 0 && (
        <p className="text-[13px] text-gray-500">No command templates yet. Create them via the Commands button in the header.</p>
      )}
    </>
  );
}

function QualityGateConfig({
  step,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const gateType = (step.executorConfig.gateType as string) || 'test';
  const maxRetries = (step.executorConfig.maxRetries as number) || 2;
  const customPrompt = (step.executorConfig.customPrompt as string) || '';

  return (
    <>
      {/* Gate type preset selector */}
      <div>
        <label className="block text-xs text-gray-500 mb-1.5">Quality Check</label>
        <div className="grid grid-cols-2 gap-1.5">
          {QUALITY_GATE_PRESETS.map((preset) => {
            const isActive = gateType === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() =>
                  onUpdate({
                    executorConfig: { ...step.executorConfig, gateType: preset.id },
                  })
                }
                disabled={isExecuting}
                className={`text-left rounded-lg px-2.5 py-2 border transition-colors disabled:opacity-50 ${
                  isActive
                    ? `${preset.bg} ${preset.color} border-current/30`
                    : 'bg-white/[0.02] border-white/[0.06] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]'
                }`}
              >
                <div className="text-[13px] font-medium leading-tight">{preset.label}</div>
                <div className="text-[13px] leading-snug mt-0.5 opacity-60">{preset.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Cartridge is selected once at the workflow level (toolbar). */}

      {/* Custom prompt (only for 'custom' gate type) */}
      {gateType === 'custom' && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">Custom Quality Check Prompt</label>
          <textarea
            value={customPrompt}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              onUpdate({
                executorConfig: { ...step.executorConfig, customPrompt: e.target.value },
              })
            }
            disabled={isExecuting}
            rows={6}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none resize-none disabled:opacity-50"
            placeholder="Describe your quality check. The cartridge must respond with PASS or FAIL on the first line..."
          />
        </div>
      )}

      {/* Max retries */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Max Retries</label>
        <input
          type="number"
          min={0}
          max={5}
          value={maxRetries}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) =>
            onUpdate({
              executorConfig: { ...step.executorConfig, maxRetries: parseInt(e.target.value) || 2 },
            })
          }
          disabled={isExecuting}
          className="w-20 text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
        />
        <p className="text-[13px] text-gray-600 mt-1">
          If FAIL, resets upstream steps with feedback and re-runs (up to {maxRetries} time(s))
        </p>
      </div>
    </>
  );
}

// ─── Routing Rules Editor ───────────────────────────

const CONDITION_LABELS: Record<string, string> = {
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  matches_regex: 'matches regex',
};

function RoutingRulesEditor({
  step,
  steps,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  steps: LocalStep[];
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const [addingRule, setAddingRule] = useState(false);
  const [newCondition, setNewCondition] = useState<RoutingRule['condition']>('contains');
  const [newValue, setNewValue] = useState('STATUS: FAIL');
  const [newTarget, setNewTarget] = useState('');

  const rules = (step.executorConfig.routingRules as RoutingRule[]) || [];
  const maxCycles = (step.executorConfig.maxCycles as number) || 5;
  const otherSteps = steps.filter((s) => s.id !== step.id);

  const saveRule = () => {
    if (!newTarget || !newValue.trim()) return;
    const rule: RoutingRule = {
      id: crypto.randomUUID(),
      condition: newCondition,
      value: newValue.trim(),
      nextStepId: newTarget,
    };
    onUpdate({ executorConfig: { ...step.executorConfig, routingRules: [...rules, rule] } });
    setAddingRule(false);
    setNewValue('STATUS: FAIL');
    setNewTarget('');
  };

  const deleteRule = (ruleId: string) => {
    onUpdate({ executorConfig: { ...step.executorConfig, routingRules: rules.filter((r) => r.id !== ruleId) } });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-500">Routing Rules</label>
        <span className="text-[11px] text-amber-400/60">dashed edges</span>
      </div>

      {rules.length === 0 && !addingRule && (
        <p className="text-[13px] text-gray-600 italic">No routing rules — step always advances normally.</p>
      )}

      {rules.map((rule) => {
        const target = steps.find((s) => s.id === rule.nextStepId);
        return (
          <div key={rule.id} className="flex items-start gap-2 p-2 rounded-md bg-amber-500/5 border border-amber-500/20">
            <div className="flex-1 min-w-0">
              <span className="text-[13px] text-amber-300">
                if {CONDITION_LABELS[rule.condition]} <span className="font-mono bg-black/20 px-1 rounded">{rule.value}</span>
              </span>
              <div className="text-[13px] text-gray-400 mt-0.5">
                → reset <span className="text-amber-200">{target?.name || rule.nextStepId.slice(0, 8)}</span>
              </div>
            </div>
            <button
              onClick={() => deleteRule(rule.id)}
              disabled={isExecuting}
              className="text-gray-600 hover:text-red-400 transition-colors text-xs shrink-0 mt-0.5"
            >
              ✕
            </button>
          </div>
        );
      })}

      {addingRule && (
        <div className="p-2 rounded-md bg-white/[0.03] border border-white/[0.08] space-y-2">
          <select
            value={newCondition}
            onChange={(e) => setNewCondition(e.target.value as RoutingRule['condition'])}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-2 py-1.5 focus:outline-none"
          >
            {Object.entries(CONDITION_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <input
            type="text"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder='e.g. STATUS: FAIL'
            className="w-full text-sm glass-input text-gray-300 rounded-md px-2 py-1.5 focus:outline-none"
          />
          <select
            value={newTarget}
            onChange={(e) => setNewTarget(e.target.value)}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-2 py-1.5 focus:outline-none"
          >
            <option value="">→ Reset step to pending…</option>
            {otherSteps.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={saveRule}
              disabled={!newTarget || !newValue.trim()}
              className="flex-1 text-xs px-2 py-1.5 rounded-md bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-40"
            >
              Add Rule
            </button>
            <button
              onClick={() => setAddingRule(false)}
              className="text-xs px-2 py-1.5 rounded-md text-gray-500 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!addingRule && (
        <button
          onClick={() => setAddingRule(true)}
          disabled={isExecuting}
          className="text-xs text-amber-400/60 hover:text-amber-400 transition-colors disabled:opacity-30"
        >
          + Add routing rule
        </button>
      )}

      {rules.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 whitespace-nowrap">Max cycles</label>
          <input
            type="number"
            min={1}
            max={20}
            value={maxCycles}
            onChange={(e) =>
              onUpdate({ executorConfig: { ...step.executorConfig, maxCycles: parseInt(e.target.value) || 5 } })
            }
            disabled={isExecuting}
            className="w-16 text-sm glass-input text-gray-300 rounded-md px-2 py-1 focus:outline-none disabled:opacity-50"
          />
          <span className="text-[13px] text-gray-600">before normal flow resumes</span>
        </div>
      )}
    </div>
  );
}

// ─── Connector Step Config ───────────────────────────

const CONNECTOR_TEMPLATE_VARS = '{{result}} {{stepName}} {{workflowName}} {{agentName}} {{timestamp}}';

function ConnectorStepConfig({
  step,
  onUpdate,
  isExecuting,
}: {
  step: LocalStep;
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
}) {
  const cfg = step.executorConfig;
  const connectorType = (cfg.connectorType as string) || 'slack';

  const update = (patch: Record<string, unknown>) =>
    onUpdate({ executorConfig: { ...cfg, ...patch } });

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Connector Type</label>
        <select
          value={connectorType}
          onChange={(e) => update({ connectorType: e.target.value })}
          disabled={isExecuting}
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
        >
          <option value="slack">Slack</option>
          <option value="discord">Discord</option>
          <option value="github">GitHub</option>
          <option value="linear">Linear</option>
          <option value="http">Generic HTTP</option>
          <option value="system-notify">System Notify</option>
          <option value="capture-learnings">Capture Learnings</option>
          <option value="save-to-project">Save to Project</option>
        </select>
      </div>

      <div className="text-[11px] text-gray-600">
        Available: <span className="font-mono text-gray-500">{CONNECTOR_TEMPLATE_VARS}</span>
      </div>

      {(connectorType === 'slack' || connectorType === 'discord') && (
        <>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Incoming Webhook URL</label>
            <input
              type="text"
              value={(cfg.webhookUrl as string) || ''}
              onChange={(e) => update({ webhookUrl: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="https://hooks.slack.com/..."
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Message Template</label>
            <textarea
              value={(cfg.messageTemplate as string) || '{{workflowName}} — {{stepName}} completed:\n{{result}}'}
              onChange={(e) => update({ messageTemplate: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              rows={3}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y disabled:opacity-50"
            />
          </div>
        </>
      )}

      {connectorType === 'github' && (
        <>
          <div>
            <label className="block text-xs text-gray-500 mb-1">GitHub Token</label>
            <input
              type="password"
              value={(cfg.githubToken as string) || ''}
              onChange={(e) => update({ githubToken: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="ghp_..."
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Repository (owner/repo)</label>
            <input
              type="text"
              value={(cfg.githubRepo as string) || ''}
              onChange={(e) => update({ githubRepo: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="owner/repo"
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Action</label>
            <select
              value={(cfg.githubAction as string) || 'create_issue'}
              onChange={(e) => update({ githubAction: e.target.value })}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            >
              <option value="create_issue">Create Issue</option>
              <option value="comment_pr">Comment on PR</option>
              <option value="trigger_workflow">Trigger Workflow</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Title Template</label>
            <input
              type="text"
              value={(cfg.githubTitle as string) || '{{workflowName}}: {{stepName}}'}
              onChange={(e) => update({ githubTitle: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Body Template</label>
            <textarea
              value={(cfg.githubBody as string) || '{{result}}'}
              onChange={(e) => update({ githubBody: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              rows={3}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y disabled:opacity-50"
            />
          </div>
          {(cfg.githubAction as string) === 'comment_pr' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">PR Number</label>
              <input
                type="text"
                value={(cfg.githubPrNumber as string) || ''}
                onChange={(e) => update({ githubPrNumber: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="123"
                disabled={isExecuting}
                className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}
          {(cfg.githubAction as string) === 'trigger_workflow' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Workflow ID / filename</label>
              <input
                type="text"
                value={(cfg.githubWorkflowId as string) || ''}
                onChange={(e) => update({ githubWorkflowId: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="ci.yml"
                disabled={isExecuting}
                className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}
        </>
      )}

      {connectorType === 'linear' && (
        <>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Linear API Key</label>
            <input
              type="password"
              value={(cfg.linearApiKey as string) || ''}
              onChange={(e) => update({ linearApiKey: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="lin_api_..."
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Team ID</label>
            <input
              type="text"
              value={(cfg.linearTeamId as string) || ''}
              onChange={(e) => update({ linearTeamId: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="TEAM-ID"
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Action</label>
            <select
              value={(cfg.linearAction as string) || 'create_issue'}
              onChange={(e) => update({ linearAction: e.target.value })}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            >
              <option value="create_issue">Create Issue</option>
              <option value="update_issue">Update Issue</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Title Template</label>
            <input
              type="text"
              value={(cfg.linearTitle as string) || '{{workflowName}}: {{stepName}}'}
              onChange={(e) => update({ linearTitle: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Description Template</label>
            <textarea
              value={(cfg.linearDescription as string) || '{{result}}'}
              onChange={(e) => update({ linearDescription: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              rows={3}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y disabled:opacity-50"
            />
          </div>
          {(cfg.linearAction as string) === 'update_issue' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Issue ID</label>
              <input
                type="text"
                value={(cfg.linearIssueId as string) || ''}
                onChange={(e) => update({ linearIssueId: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="TEAM-123"
                disabled={isExecuting}
                className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}
        </>
      )}

      {connectorType === 'http' && (
        <>
          <div>
            <label className="block text-xs text-gray-500 mb-1">URL</label>
            <input
              type="text"
              value={(cfg.httpUrl as string) || ''}
              onChange={(e) => update({ httpUrl: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="https://api.example.com/webhook"
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Method</label>
            <select
              value={(cfg.httpMethod as string) || 'POST'}
              onChange={(e) => update({ httpMethod: e.target.value })}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            >
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="GET">GET</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Body Template (JSON)</label>
            <textarea
              value={(cfg.httpBodyTemplate as string) || '{"message": "{{result}}"}'}
              onChange={(e) => update({ httpBodyTemplate: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              rows={4}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y font-mono text-[13px] disabled:opacity-50"
            />
          </div>
        </>
      )}

      {connectorType === 'capture-learnings' && (
        <>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Captures all completed step results from this workflow run and stores them as a project learning entry. No config required — it works automatically when the workflow is assigned to a project.
          </p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Content Override (optional)</label>
            <textarea
              value={(cfg.content as string) || ''}
              onChange={(e) => update({ content: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              rows={4}
              placeholder="Leave blank to auto-synthesize from step results. Supports {{workflowName}}, {{result}}, {{stepName}}."
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tags (JSON array, optional)</label>
            <input
              type="text"
              value={(cfg.tags as string) || ''}
              onChange={(e) => update({ tags: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder='["review", "backend"]'
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none font-mono text-[13px] disabled:opacity-50"
            />
          </div>
        </>
      )}

      {connectorType === 'save-to-project' && (
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Writes all completed step results from this run as a Markdown file to{' '}
          <span className="font-mono text-gray-400">{'{primary_repo}/.neoncore/docs/'}</span>. No config required — it works automatically when the workflow is assigned to a project with a primary repo.
        </p>
      )}
    </div>
  );
}

// ─── Side Panel Component ───────────────────────────

// ── Typed Result Panel ────────────────────────────────────────────────────────

type OutputSchema = 'test_results' | 'code_review' | 'design_doc' | 'free_text';

interface TestResultsData {
  status: 'PASS' | 'FAIL';
  passed: number;
  failed: number;
  failedTests: { name: string; error: string }[];
}

interface CodeReviewData {
  status: 'PASS' | 'FAIL';
  critical: number;
  high: number;
  medium: number;
  low: number;
  issues: { severity: string; location: string; description: string }[];
}

function parseTestResults(result: string): TestResultsData | null {
  const block = result.match(/---TEST RESULTS---([\s\S]*?)---END TEST RESULTS---/i)?.[1];
  if (!block) return null;
  const status = /STATUS:\s*(PASS|FAIL)/i.exec(block)?.[1]?.toUpperCase() as 'PASS' | 'FAIL';
  const passed = parseInt(/PASSED:\s*(\d+)/i.exec(block)?.[1] || '0', 10);
  const failed = parseInt(/FAILED:\s*(\d+)/i.exec(block)?.[1] || '0', 10);
  const failedTests: { name: string; error: string }[] = [];
  const testLines = block.match(/^-\s+(.+?):\s+(.+)$/gm) || [];
  for (const l of testLines) {
    const m = /^-\s+(.+?):\s+(.+)$/.exec(l);
    if (m) failedTests.push({ name: m[1].trim(), error: m[2].trim() });
  }
  return { status, passed, failed, failedTests };
}

function parseCodeReview(result: string): CodeReviewData | null {
  const block = result.match(/---CODE REVIEW---([\s\S]*?)---END CODE REVIEW---/i)?.[1];
  if (!block) return null;
  const status = /STATUS:\s*(PASS|FAIL)/i.exec(block)?.[1]?.toUpperCase() as 'PASS' | 'FAIL';
  const critical = parseInt(/CRITICAL:\s*(\d+)/i.exec(block)?.[1] || '0', 10);
  const high = parseInt(/HIGH:\s*(\d+)/i.exec(block)?.[1] || '0', 10);
  const medium = parseInt(/MEDIUM:\s*(\d+)/i.exec(block)?.[1] || '0', 10);
  const low = parseInt(/LOW:\s*(\d+)/i.exec(block)?.[1] || '0', 10);
  const issues: { severity: string; location: string; description: string }[] = [];
  const issueLines = block.match(/^-\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)$/gm) || [];
  for (const l of issueLines) {
    const m = /^-\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)$/.exec(l);
    if (m) issues.push({ severity: m[1], location: m[2].trim(), description: m[3].trim() });
  }
  return { status, critical, high, medium, low, issues };
}

function TypedResultPanel({ result, schema }: { result: string; schema: OutputSchema }) {
  if (!result?.trim()) {
    return <p className="text-[12px] text-gray-600 italic">No result yet.</p>;
  }

  if (schema === 'test_results') {
    const data = parseTestResults(result);
    if (data) {
      const passBg = data.status === 'PASS' ? 'bg-emerald-900/30 border-emerald-800/40' : 'bg-red-900/30 border-red-800/40';
      const passText = data.status === 'PASS' ? 'text-emerald-400' : 'text-red-400';
      return (
        <div className="space-y-3">
          <div className={`rounded-lg p-3 border ${passBg}`}>
            <div className="flex items-center gap-3">
              <span className={`text-lg font-bold ${passText}`}>{data.status}</span>
              <span className="text-[12px] text-gray-400">{data.passed} passed</span>
              {data.failed > 0 && <span className="text-[12px] text-red-400">{data.failed} failed</span>}
            </div>
          </div>
          {data.failedTests.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-gray-500 uppercase tracking-wider">Failed tests</p>
              {data.failedTests.map((t, i) => (
                <div key={i} className="bg-red-900/20 border border-red-900/40 rounded p-2">
                  <p className="text-[12px] text-red-300 font-medium">{t.name}</p>
                  <p className="text-[11px] text-red-400/70 mt-0.5">{t.error}</p>
                </div>
              ))}
            </div>
          )}
          <details className="text-[11px]">
            <summary className="text-gray-600 cursor-pointer hover:text-gray-400">Full output</summary>
            <pre className="mt-2 text-gray-500 bg-black/30 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">{result}</pre>
          </details>
        </div>
      );
    }
  }

  if (schema === 'code_review') {
    const data = parseCodeReview(result);
    if (data) {
      const SEVERITY_COLORS: Record<string, string> = {
        CRITICAL: 'text-red-400 bg-red-900/30',
        HIGH: 'text-orange-400 bg-orange-900/30',
        MEDIUM: 'text-yellow-400 bg-yellow-900/30',
        LOW: 'text-gray-400 bg-gray-900/30',
      };
      return (
        <div className="space-y-3">
          <div className={`rounded-lg p-3 border ${data.status === 'PASS' ? 'bg-emerald-900/30 border-emerald-800/40' : 'bg-red-900/30 border-red-800/40'}`}>
            <div className="flex items-center gap-3 flex-wrap">
              <span className={`text-lg font-bold ${data.status === 'PASS' ? 'text-emerald-400' : 'text-red-400'}`}>{data.status}</span>
              {data.critical > 0 && <span className="text-[11px] text-red-400 font-semibold">{data.critical} critical</span>}
              {data.high > 0 && <span className="text-[11px] text-orange-400">{data.high} high</span>}
              {data.medium > 0 && <span className="text-[11px] text-yellow-400">{data.medium} medium</span>}
              {data.low > 0 && <span className="text-[11px] text-gray-400">{data.low} low</span>}
            </div>
          </div>
          {data.issues.length > 0 && (
            <div className="space-y-1.5">
              {data.issues.map((issue, i) => {
                const cls = SEVERITY_COLORS[issue.severity.toUpperCase()] || 'text-gray-400 bg-gray-900/30';
                return (
                  <div key={i} className={`rounded p-2 ${cls.split(' ')[1]}`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-[10px] font-bold uppercase ${cls.split(' ')[0]}`}>{issue.severity}</span>
                      <span className="text-[11px] text-gray-500 font-mono">{issue.location}</span>
                    </div>
                    <p className="text-[12px] text-gray-300">{issue.description}</p>
                  </div>
                );
              })}
            </div>
          )}
          <details className="text-[11px]">
            <summary className="text-gray-600 cursor-pointer hover:text-gray-400">Full output</summary>
            <pre className="mt-2 text-gray-500 bg-black/30 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">{result}</pre>
          </details>
        </div>
      );
    }
  }

  if (schema === 'design_doc') {
    return (
      <div className="prose prose-invert prose-sm max-w-none">
        <pre className="text-[12px] text-gray-300 bg-black/20 rounded-lg p-3 overflow-auto max-h-96 whitespace-pre-wrap leading-relaxed">{result}</pre>
      </div>
    );
  }

  // Fallback: raw text
  return (
    <pre className="text-[12px] text-gray-400 bg-black/20 rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap leading-relaxed">{result}</pre>
  );
}

// ── Decision Step Components ──────────────────────────────────────────────────

interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  pros?: string[];
  cons?: string[];
}

interface DecisionConfig {
  question?: string;
  eli10?: string;
  stakes?: string;
  recommendation?: string;
  options?: DecisionOption[];
}

function DecisionStepConfig({ step, onUpdate, isExecuting }: {
  step: LocalStep;
  onUpdate: (patch: Partial<LocalStep>) => void;
  isExecuting: boolean;
  steps: LocalStep[];
}) {
  const cfg = (step.executorConfig || {}) as DecisionConfig & Record<string, unknown>;
  const options: DecisionOption[] = (cfg.options as DecisionOption[]) || [];

  const updateCfg = (patch: Partial<DecisionConfig>) =>
    onUpdate({ executorConfig: { ...cfg, ...patch } });

  const updateOption = (idx: number, patch: Partial<DecisionOption>) => {
    const next = options.map((o, i) => (i === idx ? { ...o, ...patch } : o));
    updateCfg({ options: next });
  };

  const addOption = () => {
    const id = `opt${Date.now()}`;
    updateCfg({ options: [...options, { id, label: '', description: '' }] });
  };

  const removeOption = (idx: number) => {
    updateCfg({ options: options.filter((_, i) => i !== idx) });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Decision question</label>
        <input
          type="text"
          value={(cfg.question as string) || ''}
          onChange={(e) => updateCfg({ question: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={isExecuting}
          placeholder="Which approach should we take?"
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none disabled:opacity-50"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">ELI10 — plain English context (optional)</label>
        <textarea
          value={(cfg.eli10 as string) || ''}
          onChange={(e) => updateCfg({ eli10: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={isExecuting}
          rows={2}
          placeholder="Explain the trade-off in plain English…"
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none disabled:opacity-50 resize-none"
        />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Stakes — what breaks if we pick wrong? (optional)</label>
        <input
          type="text"
          value={(cfg.stakes as string) || ''}
          onChange={(e) => updateCfg({ stakes: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          disabled={isExecuting}
          placeholder="e.g. Performance degrades under load"
          className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none disabled:opacity-50"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500">Options</label>
          <button
            onClick={addOption}
            disabled={isExecuting}
            className="text-[11px] text-violet-400 hover:text-violet-300 transition-colors disabled:opacity-40"
          >
            + Add option
          </button>
        </div>
        <div className="space-y-3">
          {options.map((opt, idx) => (
            <div key={opt.id} className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-3 space-y-2">
              <div className="flex gap-2 items-start">
                <input
                  type="text"
                  value={opt.label}
                  onChange={(e) => updateOption(idx, { label: e.target.value })}
                  onKeyDown={(e) => e.stopPropagation()}
                  disabled={isExecuting}
                  placeholder={`Option ${String.fromCharCode(65 + idx)} label`}
                  className="flex-1 text-xs glass-input text-gray-300 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none disabled:opacity-50"
                />
                <button
                  onClick={() => {
                    const id = opt.id;
                    const recommended = (cfg.recommendation as string) === id ? '' : id;
                    updateCfg({ recommendation: recommended });
                  }}
                  disabled={isExecuting}
                  title="Mark as recommended"
                  className={`text-[11px] px-2 py-1.5 rounded border transition-colors disabled:opacity-40 ${
                    (cfg.recommendation as string) === opt.id
                      ? 'bg-violet-900/40 text-violet-300 border-violet-700/50'
                      : 'text-gray-600 border-white/[0.07] hover:text-gray-300'
                  }`}
                >
                  ★
                </button>
                <button
                  onClick={() => removeOption(idx)}
                  disabled={isExecuting}
                  className="text-gray-600 hover:text-red-400 transition-colors p-1 disabled:opacity-40"
                >
                  ×
                </button>
              </div>
              <input
                type="text"
                value={opt.description || ''}
                onChange={(e) => updateOption(idx, { description: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={isExecuting}
                placeholder="Brief description of this option"
                className="w-full text-xs glass-input text-gray-400 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none disabled:opacity-50"
              />
            </div>
          ))}
          {options.length === 0 && (
            <p className="text-[11px] text-gray-600">No options yet — add at least 2 before running.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function DecisionBrief({ step, workflowId }: { step: LocalStep; workflowId: string }) {
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decided, setDecided] = useState(false);

  const cfg = (step.executorConfig || {}) as DecisionConfig & Record<string, unknown>;
  const options: DecisionOption[] = (cfg.options as DecisionOption[]) || [];
  const recommendation = cfg.recommendation as string | undefined;

  const handleDecide = async (optionId: string) => {
    if (deciding || decided) return;
    setDeciding(optionId);
    try {
      await api.decideWorkflowStep(workflowId, step.id, optionId);
      setDecided(true);
    } catch {
      setDeciding(null);
    }
  };

  if (decided) {
    return (
      <div className="mt-3 p-3 rounded-lg bg-emerald-900/20 border border-emerald-800/40 text-[12px] text-emerald-400">
        Decision recorded — workflow advancing.
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      {/* Question */}
      <div className="bg-violet-900/20 border border-violet-800/30 rounded-lg p-3">
        <p className="text-[11px] text-violet-400 uppercase tracking-wider font-semibold mb-1">Decision Required</p>
        <p className="text-sm text-gray-200 font-medium">{cfg.question || 'Make a choice'}</p>
        {cfg.eli10 && (
          <p className="text-[12px] text-gray-500 mt-1.5 leading-relaxed">{cfg.eli10 as string}</p>
        )}
        {cfg.stakes && (
          <p className="text-[11px] text-amber-500/80 mt-1.5">
            <span className="font-medium">Stakes: </span>{cfg.stakes as string}
          </p>
        )}
      </div>

      {/* Options */}
      <div className="space-y-2">
        {options.map((opt) => {
          const isRecommended = opt.id === recommendation;
          const isDeciding = deciding === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => handleDecide(opt.id)}
              disabled={!!deciding}
              className={`w-full text-left rounded-lg p-3 border transition-all disabled:opacity-60 ${
                isRecommended
                  ? 'bg-violet-900/30 border-violet-700/50 hover:bg-violet-900/50'
                  : 'bg-white/[0.02] border-white/[0.07] hover:bg-white/[0.05]'
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className={`text-[13px] font-medium ${isRecommended ? 'text-violet-200' : 'text-gray-300'}`}>
                  {opt.label}
                  {isRecommended && <span className="ml-1.5 text-[10px] text-violet-400">(recommended)</span>}
                </span>
                {isDeciding && (
                  <span className="text-[11px] text-violet-400">Choosing…</span>
                )}
              </div>
              {opt.description && (
                <p className="text-[11px] text-gray-500 leading-relaxed">{opt.description}</p>
              )}
            </button>
          );
        })}
        {options.length === 0 && (
          <p className="text-[12px] text-gray-600">No options configured for this decision step.</p>
        )}
      </div>
    </div>
  );
}

function DispatchedPromptSection({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = prompt.slice(0, 120).replace(/\n/g, ' ');
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors w-full text-left mb-1"
      >
        <svg className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="uppercase tracking-wider font-semibold">Message sent to agent</span>
        <span className="text-gray-700 ml-auto">{prompt.length} chars</span>
      </button>
      {expanded ? (
        <pre className="text-[11px] text-gray-400 bg-black/30 rounded-md p-2 overflow-auto max-h-64 whitespace-pre-wrap break-words font-mono leading-relaxed">
          {prompt}
        </pre>
      ) : (
        <p className="text-[11px] text-gray-600 font-mono truncate">{preview}{prompt.length > 120 ? '…' : ''}</p>
      )}
    </div>
  );
}

function SidePanel({
  step,
  steps,
  agentOptions,
  isExecuting,
  workflowId,
  onUpdate,
  onDelete,
  onClose,
  onAdvance,
  onForceComplete,
  onSkip,
}: {
  step: LocalStep;
  steps: LocalStep[];
  agentOptions: { id: string; label: string }[];
  isExecuting: boolean;
  workflowId?: string;
  onUpdate: (patch: Partial<LocalStep>) => void;
  onDelete: () => void;
  onClose: () => void;
  onAdvance: () => void;
  onForceComplete: () => void;
  onSkip: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [steerMsg, setSteerMsg] = useState('');
  const [steering, setSteering] = useState(false);
  const [steerResult, setSteerResult] = useState<'ok' | 'err' | null>(null);

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

        {/* Step type selector */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">Step Type</label>
          <select
            value={step.executorType}
            onChange={(e) => {
              const newType = e.target.value as StepExecutorType;
              onUpdate({ executorType: newType, executorConfig: { ...step.executorConfig } });
            }}
            disabled={isExecuting}
            className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
          >
            <option value="claude-code">Standard (Cartridge Step)</option>
            <option value="command">Command Template</option>
            <option value="quality-gate">Quality Gate (Test / Lint / Security)</option>
            <option value="review-gate">Critic / Review Gate</option>
            <option value="deliberation">Multi-Cartridge Deliberation</option>
            <option value="connector">External Connector (Slack / GitHub / Linear / HTTP)</option>
            <option value="decision">Decision Checkpoint (Human Choice)</option>
          </select>
        </div>

        {/* ── Command template step config ── */}
        {step.executorType === 'command' && (
          <CommandStepConfig step={step} onUpdate={onUpdate} isExecuting={isExecuting} />
        )}

        {/* ── Output Schema — typed result rendering ── */}
        {(step.executorType === 'claude-code' || !step.executorType) && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Output format (optional)</label>
            <select
              value={(step.executorConfig.outputSchema as string) || 'free_text'}
              onChange={(e) => {
                const schema = e.target.value === 'free_text' ? undefined : e.target.value;
                onUpdate({ executorConfig: { ...step.executorConfig, outputSchema: schema } });
              }}
              disabled={isExecuting}
              className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
            >
              <option value="free_text">Free text (default)</option>
              <option value="test_results">Test Results (pass/fail + counts)</option>
              <option value="code_review">Code Review (severity breakdown)</option>
              <option value="design_doc">Design Doc (rendered markdown)</option>
            </select>
            {(step.executorConfig.outputSchema as string | undefined) && (
              <p className="text-[11px] text-gray-600 mt-1">Format instructions will be appended to the agent prompt.</p>
            )}
          </div>
        )}

        {/* ── Decision step config ── */}
        {step.executorType === 'decision' && (
          <DecisionStepConfig step={step} onUpdate={onUpdate} isExecuting={isExecuting} steps={steps} />
        )}

        {/* ── Standard step config ── */}
        {step.executorType !== 'review-gate' && step.executorType !== 'deliberation' && step.executorType !== 'quality-gate' && step.executorType !== 'command' && step.executorType !== 'connector' && step.executorType !== 'decision' && (
          <>
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
                      <div className="text-[13px] font-medium leading-tight">{role.name}</div>
                      <div className="text-[13px] leading-snug mt-0.5 opacity-60">{role.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Per-step engine + branch — fan one workflow across tools, each isolated
                on its own branch. Engine resolves to a LIVE cartridge of that type in the
                repo at launch (leave on "Inherit" to use the run-level cartridge); Branch
                spins up a git worktree the step works in so parallel steps don't collide. */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tool</label>
                <select
                  value={(step.executorConfig.agentType as string) || ''}
                  onChange={(e) =>
                    onUpdate({
                      executorConfig: { ...step.executorConfig, agentType: e.target.value || undefined },
                    })
                  }
                  disabled={isExecuting}
                  className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none disabled:opacity-50"
                >
                  <option value="">Default (project's tool)</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="gridlight">Gridlight</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Branch (optional)</label>
                <input
                  type="text"
                  value={(step.executorConfig.branch as string) || ''}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onUpdate({
                      executorConfig: { ...step.executorConfig, branch: e.target.value.trim() || undefined },
                    })
                  }
                  disabled={isExecuting}
                  className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 placeholder-gray-600 focus:outline-none disabled:opacity-50"
                  placeholder="feature/step-a"
                />
              </div>
            </div>
            {(step.executorConfig.agentType || step.executorConfig.branch) ? (
              <p className="text-[11px] text-gray-600 -mt-1">
                {step.executorConfig.agentType
                  ? `Runs on a ${String(step.executorConfig.agentType)} cartridge in the repo`
                  : 'Runs on the run cartridge'}
                {step.executorConfig.branch ? ` · isolated in worktree ${String(step.executorConfig.branch)}` : ''}.
              </p>
            ) : null}

            {/* Intent toggle */}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!step.executorConfig.useIntent}
                onChange={() =>
                  onUpdate({
                    executorConfig: { ...step.executorConfig, useIntent: !step.executorConfig.useIntent },
                  })
                }
                disabled={isExecuting}
                className="accent-emerald-500"
              />
              Use structured intent
            </label>

            {/* Prompt — free text or structured intent */}
            {step.executorConfig.useIntent ? (
              <IntentEditor step={step} onUpdate={onUpdate} isExecuting={isExecuting} />
            ) : (
              <div>
                <label className="block text-xs text-gray-500 mb-1">What should this cartridge do?</label>
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
            )}
          </>
        )}

        {/* ── Review gate config ── */}
        {step.executorType === 'review-gate' && (
          <ReviewGateConfig step={step} agentOptions={agentOptions} onUpdate={onUpdate} isExecuting={isExecuting} />
        )}

        {/* ── Deliberation config ── */}
        {step.executorType === 'deliberation' && (
          <DeliberationConfig step={step} agentOptions={agentOptions} onUpdate={onUpdate} isExecuting={isExecuting} />
        )}

        {/* ── Quality gate config ── */}
        {step.executorType === 'quality-gate' && (
          <QualityGateConfig step={step} onUpdate={onUpdate} isExecuting={isExecuting} />
        )}

        {/* Loop */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!step.executorConfig.loopCount && (step.executorConfig.loopCount as number) > 1}
              onChange={() =>
                onUpdate({
                  executorConfig: {
                    ...step.executorConfig,
                    loopCount: step.executorConfig.loopCount && (step.executorConfig.loopCount as number) > 1 ? 1 : 3,
                  },
                })
              }
              disabled={isExecuting}
              className="accent-cyan-500"
            />
            Loop this step multiple times
          </label>
          {!!step.executorConfig.loopCount && (step.executorConfig.loopCount as number) > 1 && (
            <div className="flex items-center gap-2 pl-6">
              <label className="text-[13px] text-gray-500">Iterations:</label>
              <input
                type="number"
                min={2}
                max={10}
                value={(step.executorConfig.loopCount as number) || 3}
                onChange={(e) =>
                  onUpdate({
                    executorConfig: { ...step.executorConfig, loopCount: Math.max(2, Math.min(10, parseInt(e.target.value) || 2)) },
                  })
                }
                disabled={isExecuting}
                className="w-16 text-sm glass-input text-gray-300 rounded-md px-2 py-1 focus:outline-none disabled:opacity-50"
              />
            </div>
          )}
        </div>

        {/* Include output from previous step */}
        {step.dependsOn.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!step.executorConfig.includeDepOutput}
              onChange={() =>
                onUpdate({
                  executorConfig: { ...step.executorConfig, includeDepOutput: !step.executorConfig.includeDepOutput },
                })
              }
              disabled={isExecuting}
              className="accent-blue-500"
            />
            Include output from previous step
          </label>
        )}

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
        {(
          <>
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
              <div className="text-[13px] text-gray-500 bg-black/20 rounded-md px-3 py-2 font-mono break-all select-all">
                <div className="text-amber-400/70 mb-1 font-sans">
                  Step won't auto-complete. Call this when done:
                </div>
                curl -X POST {window.location.origin}/api/workflows/webhook/{step.id}/complete
              </div>
            )}
          </>
        )}

        {/* Connector config */}
        {step.executorType === 'connector' && (
          <ConnectorStepConfig step={step} onUpdate={onUpdate} isExecuting={isExecuting} />
        )}

        {/* Routing rules (for standard + command steps) */}
        {(step.executorType === 'claude-code' || step.executorType === 'command' || !step.executorType) && (
          <RoutingRulesEditor step={step} steps={steps} onUpdate={onUpdate} isExecuting={isExecuting} />
        )}

        {/* Dependencies display */}
        {step.dependsOn.length > 0 && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Depends on</label>
            <div className="flex flex-wrap gap-1">
              {step.dependsOn.map((depId) => (
                <span
                  key={depId}
                  className="text-[13px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 font-mono"
                >
                  {depId.slice(0, 8)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Message sent to agent */}
        {step.dispatchedPrompt && (
          <DispatchedPromptSection prompt={step.dispatchedPrompt} />
        )}

        {/* Step result — shown when completed or failed */}
        {(step.status === 'completed' || step.status === 'failed') && step.result && step.executorType !== 'decision' && (
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">
              Result
              {step.status === 'failed' && <span className="ml-1.5 text-red-400">— {step.error}</span>}
            </label>
            <TypedResultPanel
              result={step.result}
              schema={(step.executorConfig.outputSchema as OutputSchema) || 'free_text'}
            />
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
            {step.status === 'running' && (
              <>
                {/* Decision step — structured choice UI */}
                {step.executorType === 'decision' && workflowId && (
                  <DecisionBrief step={step} workflowId={workflowId} />
                )}

                {/* Mid-task steering — only for running claude-code steps with an assigned agent */}
                {step.executorType !== 'decision' && step.executorType === 'claude-code' && step.executorId && step.executorId !== '__deferred__' && workflowId && (
                  <div className="mt-3">
                    <label className="block text-xs text-gray-500 mb-1">Steer agent</label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={steerMsg}
                        onChange={(e) => setSteerMsg(e.target.value)}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && steerMsg.trim() && !steering) {
                            setSteering(true);
                            setSteerResult(null);
                            try {
                              await api.steerWorkflowStep(workflowId, step.id, steerMsg.trim());
                              setSteerMsg('');
                              setSteerResult('ok');
                              setTimeout(() => setSteerResult(null), 3000);
                            } catch { setSteerResult('err'); }
                            finally { setSteering(false); }
                          }
                        }}
                        placeholder="Send a hint or correction…"
                        className="flex-1 text-xs glass-input text-gray-200 rounded px-2 py-1.5 focus:outline-none placeholder-gray-600"
                        disabled={steering}
                      />
                      <button
                        onClick={async () => {
                          if (!steerMsg.trim() || steering) return;
                          setSteering(true);
                          setSteerResult(null);
                          try {
                            await api.steerWorkflowStep(workflowId, step.id, steerMsg.trim());
                            setSteerMsg('');
                            setSteerResult('ok');
                            setTimeout(() => setSteerResult(null), 3000);
                          } catch { setSteerResult('err'); }
                          finally { setSteering(false); }
                        }}
                        disabled={!steerMsg.trim() || steering}
                        className="text-xs px-2.5 py-1.5 rounded bg-teal-500/20 text-teal-400 hover:bg-teal-500/30 border border-teal-500/20 disabled:opacity-40 transition-colors"
                      >
                        {steering ? '…' : '↵'}
                      </button>
                    </div>
                    {steerResult === 'ok' && <p className="text-[11px] text-green-400 mt-1">Sent</p>}
                    {steerResult === 'err' && <p className="text-[11px] text-red-400 mt-1">Failed to send</p>}
                  </div>
                )}

                {step.executorType !== 'decision' && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={onForceComplete}
                      className="flex-1 text-xs font-medium px-3 py-2 rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/20 transition-colors"
                    >
                      Mark complete
                    </button>
                    <button
                      onClick={onSkip}
                      className="flex-1 text-xs font-medium px-3 py-2 rounded-md bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 border border-gray-500/20 transition-colors"
                    >
                      Skip
                    </button>
                  </div>
                )}
              </>
            )}
            {step.status === 'pending' && (
              <button
                onClick={onSkip}
                className="mt-2 w-full text-xs font-medium px-3 py-2 rounded-md bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 border border-gray-500/20 transition-colors"
              >
                Skip step
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
