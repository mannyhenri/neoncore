import { useState, useEffect, useCallback, useRef } from 'react';
import { SectionTitle } from './SectionTitle';
import { AttachmentField, useAttachments } from './AttachmentPicker';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import { WorkflowCanvasEditor } from './WorkflowCanvasEditor';
import { ConferCard } from './ConferPanel';
import { isWaitingSession } from '../types';
import type { Agent, Workflow, StepSummary, WorkflowStep, Project, ConferSession, CommandAttachmentInput, QueueItem } from '../types';

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


const PHASE_LABELS = { research: 'Research', coding: 'Coding', review: 'Review' } as const;

type TemplateTab = 'all' | 'strategy' | 'development' | 'quality' | 'jira' | 'compound';

const TEMPLATE_CATEGORY: Record<string, TemplateTab> = {
  'Product Strategy Session':       'strategy',
  'Engineering Architecture Review':'strategy',
  'Deep Research':                  'strategy',
  'New Feature':                    'development',
  'Feature Validation':             'development',
  'Bug Investigation':              'development',
  'Code Review & Audit':            'development',
  'Full QA Review':                 'quality',
  'Bug Hunter':                     'quality',
  'CI/CD Pipeline':                 'quality',
  'Jira Tasks Validation':          'jira',
  'Jira Tasks Completion':          'jira',
  'CE: Phase 1 — Interrogate':      'compound',
  'CE: Phase 2 — Plan':             'compound',
  'CE: Phase 3 — Implement':        'compound',
  'CE: Phase 4 — Review':           'compound',
  'CE: Phase 5 — QA':               'compound',
  'CE: Phase 6 — Ship':             'compound',
  'CE: Phase 7 — Compound':         'compound',
  'CE: Full Delivery':              'compound',
};

const TAB_LABELS: Record<TemplateTab, string> = {
  all:      'All',
  strategy: 'Strategy',
  development: 'Dev',
  quality:  'Quality',
  jira:     'Jira',
  compound: 'Compound Eng',
};

const TAB_COLORS: Record<TemplateTab, string> = {
  all:         'bg-white/10 text-gray-200',
  strategy:    'bg-violet-900/60 text-violet-300',
  development: 'bg-blue-900/60 text-blue-300',
  quality:     'bg-emerald-900/60 text-emerald-300',
  jira:        'bg-orange-900/60 text-orange-300',
  compound:    'bg-cyan-900/60 text-cyan-300',
};
const ROUND_LABELS = ['', 'Work', 'Reflect', 'Converge'] as const;

// ─── WorkflowPanel ──────────────────────────────────

export function WorkflowPanel({ agents }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [confers, setConfers] = useState<ConferSession[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | undefined>();
  const [showAllRecent, setShowAllRecent] = useState(false);
  // Open on arrival: templates you cannot see are templates you do not use, and the
  // panel's whole purpose is to start one. Behind a disclosure it read as an empty
  // section. (setShowTemplates still collapses it for anyone who wants the room.)
  const [showTemplates, setShowTemplates] = useState(true);
  const [showRecentRuns, setShowRecentRuns] = useState(false);
  const [templateTab, setTemplateTab] = useState<TemplateTab>('all');

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

  // Poll confer sessions so running confers can sit under Active Runs and
  // finished ones archive into Recent Runs.
  useEffect(() => {
    let alive = true;
    const load = () => api.getConfers().then((c) => { if (alive) setConfers(c); }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Poll the queue too. A confer or workflow started against a busy cartridge does NOT become
  // `running` — it waits as a queued item. Without this it is invisible here, so you start one
  // and the main screen shows nothing, which reads as "it did not work".
  useEffect(() => {
    let alive = true;
    const load = () => api.getQueue().then((v) => { if (alive) setQueue(v.items); }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);

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
  const pendingRuns = runs.filter((w) => w.status === 'pending');
  const completedRuns = runs.filter((w) => !['running', 'paused', 'pending'].includes(w.status));
  const recentRunsAll = completedRuns;
  const recentRuns = showAllRecent ? recentRunsAll : recentRunsAll.slice(0, 5);
  // Also include V1 workflows (no steps, no templateId) that are running
  const activeV1 = templates.filter((w) => ['running', 'paused'].includes(w.status) && !w.stepSummary);

  // Confers: running ones live under Active Runs; finished ones (last 10 min) archive under Recent Runs.
  const activeConfers = confers.filter((c) => c.status === 'running');
  // Waiting to start, because a target cartridge is busy. isWaitingSession keys on `handle`,
  // not status: a dispatched item carries the id of the session it created, and that session's
  // card owns the rendering from then on. Filtering on status alone showed one confer twice —
  // once as its own running queue item, once as the real ConferCard.
  const waiting = queue.filter(isWaitingSession);
  const queuedConfers = waiting.filter((q) => q.kind === 'confer');
  const queuedWorkflows = waiting.filter((q) => q.kind === 'workflow');
  const recentConfers = confers.filter(
    (c) => c.status !== 'running' && c.completedAt && Date.now() - new Date(c.completedAt).getTime() < 10 * 60 * 1000,
  );

  const totalActive = activeRuns.length + activeV1.length + activeConfers.length;

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
        <SectionTitle>Workflows</SectionTitle>
        {totalActive > 0 && (
          <span className="bg-gl-blue/20 text-gl-blue px-2 py-0.5 rounded-full text-xs font-medium">
            {totalActive} active
          </span>
        )}
      </button>

      {expanded && (
        <div className="space-y-4">
          {/* Action buttons */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => { setEditingWorkflowId(undefined); setCanvasOpen(true); }}
              className="text-sm px-4 py-2 rounded-lg gl-gradient text-white hover:opacity-90 transition-opacity font-medium"
            >
              + New Workflow
            </button>
          </div>

          {/* Active runs */}
          {(activeRuns.length > 0 || activeConfers.length > 0) && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Active Runs</div>
              {activeRuns.map((wf) => (
                <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                  templateName={templates.find((t) => t.id === wf.templateId)?.name} />
              ))}
              {/* Active confers — milestone progress for collaborating cartridges */}
              {activeConfers.map((c) => (
                <ConferCard key={c.id} confer={c} agents={agents} />
              ))}
              {/* Queued sessions — started, waiting on a busy cartridge */}
              {[...queuedConfers, ...queuedWorkflows].map((q) => (
                <div key={q.id} className="border border-white/[0.06] rounded-xl bg-white/[0.02] p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-gray-400">{q.kind}</span>
                    <span className="text-[11px] text-amber-300/90">waiting — cartridge busy</span>
                  </div>
                  <p className="text-[13px] text-gray-300 line-clamp-2">
                    {(q.payload?.task as string) || (q.payload?.workflowId as string) || q.kind}
                  </p>
                  <p className="text-[10px] text-gray-600 mt-1 font-mono truncate">{q.lane}</p>
                </div>
              ))}
            </div>
          )}

          {/* Active V1 workflows */}
          {activeV1.map((wf) => (
            <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents} />
          ))}

          {/* Pending runs */}
          {pendingRuns.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-2">
                Pending
                <span className="bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded text-[10px]">
                  {pendingRuns.length}
                </span>
              </div>
              {pendingRuns.map((wf) => (
                <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                  templateName={templates.find((t) => t.id === wf.templateId)?.name} />
              ))}
            </div>
          )}

          {/* Templates */}
          {templates.filter((t) => t.stepSummary).length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowTemplates((v) => !v)}
                className="flex items-center gap-1.5 group w-full text-left"
              >
                <span className={`text-[10px] text-gray-600 transition-transform ${showTemplates ? 'rotate-90' : ''}`}>&#9654;</span>
                <span className="text-xs text-gray-500 uppercase tracking-wider group-hover:text-gray-400 transition-colors">
                  Templates
                </span>
                <span className="text-[11px] text-gray-600 ml-1">
                  {templates.filter((t) => t.stepSummary).length}
                </span>
              </button>
              {showTemplates && (
                <>
                  {/* Category tabs */}
                  <div className="flex rounded-md overflow-hidden border border-white/10 w-fit">
                    {(Object.keys(TAB_LABELS) as TemplateTab[]).map((tab) => {
                      const count = tab === 'all'
                        ? templates.filter((t) => t.stepSummary).length
                        : templates.filter((t) => t.stepSummary && (TEMPLATE_CATEGORY[t.name] ?? 'development') === tab).length;
                      return (
                        <button
                          key={tab}
                          onClick={() => setTemplateTab(tab)}
                          className={`px-2.5 py-1 text-[11px] font-medium transition-colors flex items-center gap-1 ${
                            templateTab === tab
                              ? TAB_COLORS[tab]
                              : 'bg-white/[0.04] text-gray-500 hover:text-gray-300 hover:bg-white/[0.08]'
                          }`}
                        >
                          {TAB_LABELS[tab]}
                          <span className={`text-[10px] ${templateTab === tab ? 'opacity-70' : 'opacity-40'}`}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Filtered template list */}
                  {templates
                    .filter((t) => t.stepSummary)
                    .filter((t) => templateTab === 'all' || (TEMPLATE_CATEGORY[t.name] ?? 'development') === templateTab)
                    .map((wf) => (
                      <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                        onRunCreated={handleRunCreated}
                        runCount={runs.filter((r) => r.templateId === wf.id).length} />
                    ))
                  }
                </>
              )}
            </div>
          )}

          {/* Recent runs */}
          {(recentRunsAll.length > 0 || recentConfers.length > 0) && (
            <div className="space-y-2">
              <button
                onClick={() => setShowRecentRuns((v) => !v)}
                className="flex items-center gap-1.5 group w-full text-left"
              >
                <span className={`text-[10px] text-gray-600 transition-transform ${showRecentRuns ? 'rotate-90' : ''}`}>&#9654;</span>
                <span className="text-xs text-gray-500 uppercase tracking-wider group-hover:text-gray-400 transition-colors">
                  Recent Runs
                </span>
                <span className="text-[11px] text-gray-600 ml-1">{recentRunsAll.length + recentConfers.length}</span>
              </button>
              {showRecentRuns && (
                <>
                  {/* Finished confers — archived alongside recent workflow runs */}
                  {recentConfers.map((c) => (
                    <ConferCard key={c.id} confer={c} agents={agents} />
                  ))}
                  {recentRuns.map((wf) => (
                    <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} compact agents={agents}
                      templateName={templates.find((t) => t.id === wf.templateId)?.name} />
                  ))}
                  {recentRunsAll.length > 5 && (
                    <button
                      onClick={() => setShowAllRecent((v) => !v)}
                      className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors pl-4"
                    >
                      {showAllRecent ? 'Show less' : `Show all ${recentRunsAll.length}`}
                    </button>
                  )}
                </>
              )}
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


// ─── PlayerRow ──────────────────────────────────────


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
  // One cartridge for the whole run — the common case. Per-step assignment is the opt-in
  // exception, not the default the modal is built around.
  const [runAgentId, setRunAgentId] = useState('');
  const [perStepAgents, setPerStepAgents] = useState(false);
  const [deferredPrompts, setDeferredPrompts] = useState<Record<string, Record<string, string>>>({});
  const [initialContext, setInitialContext] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [runError, setRunError] = useState('');
  const {
    attachments,
    error: attachmentError,
    setError: setAttachmentError,
    addFiles,
    removeAttachment,
    clear: clearAttachments,
    encode: encodeAttachments,
  } = useAttachments();

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

      // Always show the popup — either for deferred fields or just for the context input
      setDeferredPopup({ agentSteps, promptSteps });
      setDeferredAssignments({});
      setDeferredPrompts({});
      setInitialContext('');
      setSelectedProjectId('');
      setRunError('');
      clearAttachments();
      api.getGoalProjects().then(setProjects).catch(() => {});
      setStarting(false);
    } catch { /* silent */ }
    finally { setStarting(false); }
  }

  async function handleDeferredRun() {
    if (!deferredPopup) return;
    const allAgentsAssigned =
      deferredPopup.agentSteps.length === 0 ||
      (perStepAgents
        ? deferredPopup.agentSteps.every((s) => deferredAssignments[s.stepId])
        : !!runAgentId);
    const allPromptsAssigned = deferredPopup.promptSteps.every((s) => deferredPrompts[s.stepId]?.[s.field]?.trim());
    if (!allAgentsAssigned || !allPromptsAssigned) return;

    setStarting(true);
    setAttachmentError('');
    setRunError('');

    // Encode before tearing the modal down — a read failure has to leave the popup up with
    // the user's inputs intact, not silently drop the run.
    let payloads: CommandAttachmentInput[] = [];
    try {
      payloads = await encodeAttachments();
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Could not read attachment.');
      setStarting(false);
      return;
    }

    // The modal stays up until the server accepts the run. Attachments are the first thing
    // here that can be rejected server-side (missing repo path, oversized batch) — closing
    // first would drop that message on the floor along with everything the user typed.
    try {
      const result = await api.startWorkflowV2(
        wf.id,
        perStepAgents && deferredPopup.agentSteps.length > 0 ? deferredAssignments : undefined,
        deferredPopup.promptSteps.length > 0 ? deferredPrompts : undefined,
        initialContext.trim() || undefined,
        selectedProjectId || null,
        // The run-level cartridge fills every unassigned step server-side, so we don't have to
        // fan it out into a per-step map here.
        !perStepAgents ? runAgentId || undefined : undefined,
        payloads.length > 0 ? payloads : undefined,
      );
      setDeferredPopup(null);
      const runId = result?.workflow?.id;
      if (runId && runId !== wf.id && onRunCreated) {
        onRunCreated(runId);
      } else {
        onAction();
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Could not start this run.');
    }
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
            <SectionTitle>Configure & Run</SectionTitle>
            <p className="text-[13px] text-gray-500 mt-0.5">Fill in the required fields before running</p>
          </div>
          <button onClick={() => setDeferredPopup(null)} className="text-gray-500 hover:text-white text-lg">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-2">
            {wf.name === 'Feature Validation' ? (
              <>
                <span className="text-[13px] text-gray-300 font-medium">Feature Specification</span>
                <p className="text-[12px] text-gray-600">
                  Describe the feature you want to validate. Include: what it does functionally, how it should work architecturally, acceptance criteria, and any edge cases or error states that must be handled. Optionally add a Jira epic key (e.g. GRD-500) to pull in task requirements.
                </p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={8}
                  className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y font-mono"
                  placeholder={"Feature: [name]\n\nWhat it should do:\n- \n\nArchitecture (components/routes/DB tables involved):\n- \n\nAcceptance criteria:\n- [ ] \n\nEdge cases / error states:\n- \n\nJira epic (optional): GRD-"}
                />
              </>
            ) : wf.name === 'Jira Tasks Validation' || wf.name === 'Jira Tasks Completion' ? (
              <>
                <span className="text-[13px] text-gray-300 font-medium">Which Jira epic?</span>
                <p className="text-[12px] text-gray-600">Enter the epic name or key (e.g. "Document Generation" or "GRD-1712").</p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={2}
                  className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y font-mono"
                  placeholder="e.g. GRD-1712 or Document Generation"
                />
              </>
            ) : (
              <>
                <span className="text-[13px] text-gray-500 uppercase tracking-wider">Initial Context</span>
                <p className="text-[12px] text-gray-600">Optional — passed to the first step(s) of this workflow run.</p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={3}
                  className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none resize-y font-mono"
                  placeholder="Describe what this run should focus on…"
                />
              </>
            )}
          </div>
          {/* Project assignment — required */}
          <div className="space-y-1.5">
            <span className="text-[13px] text-gray-500 uppercase tracking-wider">Project</span>
            {projects.length === 0 ? (
              <p className="text-[12px] text-gray-600">
                No projects yet.{' '}
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); setDeferredPopup(null); }}
                  className="text-violet-400 hover:text-violet-300"
                >
                  Create one in Goals first →
                </a>
              </p>
            ) : (
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none"
              >
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.goalName ? `${p.goalName} / ` : ''}{p.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <AttachmentField
            attachments={attachments}
            error={attachmentError}
            onAddFiles={addFiles}
            onRemove={removeAttachment}
            hint="Optional — copied into the repo of every cartridge this run touches, and referenced in each step's prompt."
          />

          {deferredPopup.agentSteps.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-gray-500 uppercase tracking-wider">Run on</span>
                {/* The escape hatch. Almost nobody wants a different cartridge per step, so
                    that's opt-in rather than the default the whole modal is built around. */}
                {deferredPopup.agentSteps.length > 1 && (
                  <button
                    onClick={() => setPerStepAgents((v) => !v)}
                    className="text-[11px] text-gray-500 hover:text-gl-purple transition-colors"
                  >
                    {perStepAgents ? '← use one cartridge' : 'assign per step →'}
                  </button>
                )}
              </div>

              {!perStepAgents ? (
                <>
                  <select
                    value={runAgentId}
                    onChange={(e) => setRunAgentId(e.target.value)}
                    className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none"
                  >
                    <option value="">Select cartridge...</option>
                    {onlineAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-gray-600">
                    All {deferredPopup.agentSteps.length} step
                    {deferredPopup.agentSteps.length === 1 ? '' : 's'} run here.
                  </p>
                </>
              ) : (
                deferredPopup.agentSteps.map((s) => (
                  <div key={s.stepId}>
                    <label className="block text-sm text-gray-400 mb-1">{s.stepName}</label>
                    <select
                      value={deferredAssignments[s.stepId] || ''}
                      onChange={(e) => setDeferredAssignments((prev) => ({ ...prev, [s.stepId]: e.target.value }))}
                      className="w-full text-sm glass-input text-gray-300 rounded-md px-3 py-2 focus:outline-none"
                    >
                      <option value="">Select cartridge...</option>
                      {onlineAgents.map((a) => (
                        <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>
                      ))}
                    </select>
                  </div>
                ))
              )}
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
        {runError && <p className="px-4 pb-2 text-[13px] text-red-400">{runError}</p>}
        <div className="px-4 py-3 border-t border-white/[0.06] flex items-center gap-3">
          <button
            onClick={handleDeferredRun}
            disabled={
              starting ||
              !selectedProjectId ||
              !(
                deferredPopup.agentSteps.length === 0 ||
                (perStepAgents
                  ? deferredPopup.agentSteps.every((s) => deferredAssignments[s.stepId])
                  : !!runAgentId)
              ) ||
              !deferredPopup.promptSteps.every((s) => deferredPrompts[s.stepId]?.[s.field]?.trim()) ||
              (wf.name === 'Feature Validation' && !initialContext.trim())
            }
            className="text-sm px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-md disabled:opacity-30 transition-colors"
          >
            {starting ? 'Starting…' : 'Run Workflow'}
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
              {wf.stepSummary.projects && wf.stepSummary.projects.length > 0 && (
                <span className="text-gray-500 shrink-0 hidden sm:inline" title={wf.stepSummary.projects.join(', ')}>
                  {wf.stepSummary.projects.join(', ')}
                </span>
              )}
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
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
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
          {wf.stepSummary?.projects && wf.stepSummary.projects.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {wf.stepSummary.projects.map((p) => (
                <span key={p} className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.06] text-gray-400 border border-white/[0.06]">
                  {p}
                </span>
              ))}
            </div>
          )}
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
