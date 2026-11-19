import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Eyebrow, SegMeter } from './SectionTitle';
import { ConferModePicker, type ConferMode, type ConferIsolation } from './ConferModePicker';
import { AttachmentField, useAttachments } from './AttachmentPicker';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { browserNotificationsWanted } from '../lib/osNotify';
import { useSocket } from '../hooks/useSocket';
import { WorkflowCanvasEditor } from './WorkflowCanvasEditor';
import { ConferCard } from './ConferPanel';
import { activeStandaloneConfers, recentStandaloneConfers, armedSchedules, untilNextRun } from '@neoncore/client';
import { isWaitingSession } from '../types';
import type { Agent, Workflow, StepSummary, WorkflowStep, Project, ConferSession, CommandAttachmentInput, QueueItem, Heartbeat } from '../types';
import { AutonomyControl } from './AutonomyControl';
import { workflowAgentOptions, isOfflineOption, offlineOptionCount, conferOptionLabel } from '../lib/workflow-agent-options';
import { launchBlockers } from '../lib/launchReadiness';
import { conferLaunchContext } from '../lib/conferLaunch';
import { RunProgressStrip } from './RunProgress';
import { progressLine } from '../lib/runProgress';
import { searchTemplates } from '../lib/templateSearch';
import { LaunchSchedule, emptySchedule, isScheduledLaunch, scheduleRequest, launchButtonLabel, type LaunchScheduleValue } from './LaunchSchedule';
import {
  buildLaunchContext, defaultLaunchOptionValues, findWorkflowLaunchConfig, isLaunchOptionVisible,
  launchOptionErrors, renderLaunchCommand,
  type WorkflowLaunchConfig, type WorkflowLaunchOption, type WorkflowLaunchValues,
} from '../lib/workflowLaunchOptions';
import { useEscapeKey } from '../hooks/useEscapeKey';

// ─── Browser notification helper ────────────────────

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title: string, body: string, tag?: string) {
  // The server shows desktop notifications on this machine already — see lib/osNotify.ts.
  if (!browserNotificationsWanted()) return;
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

type TemplateTab = 'all' | 'strategy' | 'planning' | 'development' | 'quality' | 'delivery' | 'learning';

const TEMPLATE_CATEGORY: Record<string, TemplateTab> = {
  'Product Strategy Session':       'strategy',
  'Deep Research':                  'strategy',
  'CE: Phase 1 — Interrogate':      'strategy',
  'Engineering Architecture Review':'planning',
  'CE: Phase 2 — Plan':             'planning',
  'Confer':                         'development',
  'Bug Investigation':              'development',
  'Epic: Task by Task':             'development',
  'Epic: Two Repos':                'development',
  'CE Develop and Optimize':        'development',
  'CE: Phase 3 — Implement':        'development',
  'QA Testing Guide':               'quality',
  'Feature Validation':             'quality',
  'Super QA':                       'quality',
  'Bug Hunter':                     'quality',
  'Jira Tasks Validation':          'quality',
  'CE: Phase 4 — Review':           'quality',
  'CE: Phase 5 — QA':               'quality',
  // The shippable half of delivery — the documents that go OUT with a release, as opposed to
  // Document Release inside Phase 6, which keeps the internal ones current.
  'Release Documentation':          'delivery',
  'CE: Phase 6 — Ship':             'delivery',
  'CE: Phase 7 — Compound':         'learning',
};

/**
 * Templates that cannot start without launch context — the feature to validate, or for Confer the
 * task or the Jira epic (either one; see conferLaunchContext).
 */
const REQUIRES_CONTEXT: readonly string[] = ['Feature Validation', 'Confer'];

const TAB_LABELS: Record<TemplateTab, string> = {
  all:      'All',
  strategy: 'Strategy',
  planning: 'Plan',
  development: 'Dev',
  quality:  'Quality',
  delivery: 'Delivery',
  learning: 'Learn',
};

const ROUND_LABELS = ['', 'Work', 'Reflect', 'Converge'] as const;

// ─── WorkflowPanel ──────────────────────────────────

export function WorkflowPanel({ agents }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [confers, setConfers] = useState<ConferSession[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | undefined>();
  const [showAllRecent, setShowAllRecent] = useState(false);
  // Templates have no collapsed state at all: they are what the panel is FOR, and a
  // default-open disclosure still lets one stray click hide them for the session.
  const [showRecentRuns, setShowRecentRuns] = useState(false);
  const [templateTab, setTemplateTab] = useState<TemplateTab>('all');
  const [templateQuery, setTemplateQuery] = useState('');

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

  /**
   * Poll schedules, so a run you set for later is visible HERE.
   *
   * Reported as "I tried to start a daily scheduled task with repeat on, but it doesn't even
   * show in the list". Nothing was broken: the heartbeat was created, armed, fired on time and
   * re-armed. It was invisible — schedules were listed only in a per-project modal on
   * GoalsPage and in the per-template popover that made them, and neither is the list you are
   * looking at after clicking Run. Slower than the 4s confer poll on purpose: a schedule
   * changes when it fires, not continuously.
   */
  useEffect(() => {
    let alive = true;
    const load = () => api.getHeartbeats().then((h) => { if (alive) setHeartbeats(h); }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
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
  /**
   * The template list, searched then filtered by tab — in that order.
   *
   * Search first and by the WHOLE library, so a match in another category is still found; the
   * tab narrows what is shown afterwards. Reversing the two would make the active tab silently
   * scope the search, which answers "we don't have one" for a workflow that exists.
   */
  const searchedTemplates = searchTemplates(templates.filter((t) => t.stepSummary), templateQuery);
  const visibleTemplates = searchedTemplates.filter(
    (t) => templateTab === 'all' || (TEMPLATE_CATEGORY[t.name] ?? 'development') === templateTab,
  );

  const pendingRuns = runs.filter((w) => w.status === 'pending');
  const completedRuns = runs.filter((w) => !['running', 'paused', 'pending'].includes(w.status));
  const recentRunsAll = completedRuns;
  const recentRuns = showAllRecent ? recentRunsAll : recentRunsAll.slice(0, 5);
  // Also include V1 workflows (no steps, no templateId) that are running
  const activeV1 = templates.filter((w) => ['running', 'paused'].includes(w.status) && !w.stepSummary);

  // Confers: running ones live under Active Runs; finished ones (last 10 min) archive under
  // Recent Runs. STANDALONE ones only — a confer created by a workflow step is already in this
  // list as its run, and showing the session too made one confer read as two. See
  // standaloneConfers (@neoncore/client, confer-view.ts), which the phone uses as well.
  const activeConfers = activeStandaloneConfers(confers);
  // Waiting to start, because a target cartridge is busy. isWaitingSession keys on `handle`,
  // not status: a dispatched item carries the id of the session it created, and that session's
  // card owns the rendering from then on. Filtering on status alone showed one confer twice —
  // once as its own running queue item, once as the real ConferCard.
  const waiting = queue.filter(isWaitingSession);
  const queuedConfers = waiting.filter((q) => q.kind === 'confer');
  const queuedWorkflows = waiting.filter((q) => q.kind === 'workflow');
  const recentConfers = recentStandaloneConfers(confers);

  // Schedules that will still fire, soonest first. Deliberately NOT part of `totalActive`:
  // "3 active" must keep meaning "3 things running right now", and a schedule is not running.
  const upcoming = armedSchedules(heartbeats);

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
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-display text-xl font-semibold text-gray-100 flex items-center gap-2">
          Workflows
          {totalActive > 0 && (
            <span className="font-sans text-[12px] font-semibold px-2 py-0.5 rounded-full bg-neon-500/15 text-neon-300">
              {totalActive} active
            </span>
          )}
        </h2>
        <button
          onClick={() => { setEditingWorkflowId(undefined); setCanvasOpen(true); }}
          className="text-sm font-semibold text-neon-400 hover:text-neon-200 transition-colors"
        >
          + New Workflow
        </button>
        {/* Confer used to sit here. It moved to the header alongside Launch and New Repo:
            this panel renders only on the Agents view, which silently made starting a
            confer impossible from Goals and Tasks. */}
      </div>

        <div className="space-y-4">
          {/* Active runs */}
          {(activeRuns.length > 0 || activeConfers.length > 0) && (
            <div className="space-y-3">
              <Eyebrow>Active runs · {activeRuns.length + activeConfers.length}</Eyebrow>
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
                <div key={q.id} className="glass-light rounded-[14px] px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.06] text-gray-300">{q.kind}</span>
                    <span className="text-[12px] text-ember-300">waiting — cartridge busy</span>
                  </div>
                  <p className="text-[13px] text-gray-300 line-clamp-2">
                    {q.description || (q.payload?.task as string) || q.kind}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-1 font-mono truncate">{q.lane}</p>
                </div>
              ))}
            </div>
          )}

          {/* Scheduled — set for later, nothing running yet. This is the section whose absence
              made a freshly created schedule look like it had not been created at all. */}
          {upcoming.length > 0 && (
            <div className="space-y-2">
              <Eyebrow>Scheduled · {upcoming.length}</Eyebrow>
              {upcoming.map((h) => (
                <div key={h.id} className="glass-light rounded-[14px] px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-gray-100 flex-1 truncate">
                      {h.label || h.templateName || 'Scheduled run'}
                    </span>
                    <span className="text-[12px] text-neon-300 whitespace-nowrap">
                      {untilNextRun(h) || 'scheduled'}
                    </span>
                  </div>
                  <p className="text-[12px] text-gray-400 mt-0.5">
                    {h.scheduleLabel}
                    {h.agentName ? ` · ${h.agentName}` : ''}
                    {h.lastRunAt ? ` · last ran ${new Date(h.lastRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ' · not run yet'}
                  </p>
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
            <div className="space-y-3">
              <Eyebrow>Pending · {pendingRuns.length}</Eyebrow>
              {pendingRuns.map((wf) => (
                <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                  templateName={templates.find((t) => t.id === wf.templateId)?.name} />
              ))}
            </div>
          )}

          {/* Templates */}
          {templates.filter((t) => t.stepSummary).length > 0 && (
            <div className="space-y-3">
              <Eyebrow className="pt-1.5">Templates · {templates.filter((t) => t.stepSummary).length}</Eyebrow>
              {/* Search. Deliberately OUTSIDE the category tabs: it spans the whole library,
                  so typing "canary" on the Quality tab still finds the Ship workflow. */}
              <label className="flex items-center gap-2 h-10 px-3 rounded-[10px] bg-gl-surface/70 border border-white/[0.1] text-gray-400 focus-within:border-neon-500/70">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <input
                  value={templateQuery}
                  onChange={(e) => setTemplateQuery(e.target.value)}
                  placeholder="Search templates…"
                  aria-label="Search workflow templates"
                  className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-gray-100 placeholder:text-gray-500"
                />
                {templateQuery && (
                  <button
                    onClick={() => setTemplateQuery('')}
                    className="text-gray-500 hover:text-gray-200 text-base shrink-0"
                    title="Clear search"
                  >
                    &times;
                  </button>
                )}
              </label>
                  {/* Category tabs */}
                  <div role="tablist" aria-label="Template categories" className="flex flex-wrap gap-1.5">
                    {(Object.keys(TAB_LABELS) as TemplateTab[]).map((tab) => {
                      // Counts are taken AFTER the search, so a tab never advertises rows the
                      // list below will not show — a "Quality 6" chip over an empty list is the
                      // same lie as a search that silently ignores you.
                      const count = tab === 'all'
                        ? searchedTemplates.length
                        : searchedTemplates.filter((t) => (TEMPLATE_CATEGORY[t.name] ?? 'development') === tab).length;
                      return (
                        <button
                          key={tab}
                          role="tab"
                          aria-selected={templateTab === tab}
                          onClick={() => setTemplateTab(tab)}
                          className={`h-8 px-3 rounded-lg text-[13px] font-semibold transition-colors flex items-center gap-1.5 ${
                            templateTab === tab
                              ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]'
                              : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]'
                          }`}
                        >
                          {TAB_LABELS[tab]}
                          <span className={`text-[11px] ${templateTab === tab ? 'opacity-80' : 'opacity-60'}`}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  {/* Filtered template list */}
                  {visibleTemplates.length === 0 && (
                    // Stated, not an empty container — an empty list looks identical to a
                    // broken filter, which is how a search box loses trust.
                    <p className="text-[13px] text-gray-400 py-3">
                      No template matches “{templateQuery}”
                      {templateTab !== 'all' && <> in {TAB_LABELS[templateTab]}</>}.{' '}
                      <button onClick={() => { setTemplateQuery(''); setTemplateTab('all'); }}
                        className="underline underline-offset-2 hover:text-gray-200">
                        Clear
                      </button>
                    </p>
                  )}
                  <div className="space-y-2">
                  {visibleTemplates
                    .map((wf) => (
                      <WorkflowRunCard key={wf.id} workflow={wf} onAction={loadWorkflows} onOpen={openWorkflow} agents={agents}
                        onRunCreated={handleRunCreated}
                        runCount={runs.filter((r) => r.templateId === wf.id).length} />
                    ))
                  }
                  </div>
            </div>
          )}

          {/* Recent runs */}
          {(recentRunsAll.length > 0 || recentConfers.length > 0) && (
            <div className="space-y-2">
              <button
                onClick={() => setShowRecentRuns((v) => !v)}
                aria-expanded={showRecentRuns}
                className="w-full h-10 px-3.5 rounded-[10px] border border-dashed border-white/[0.18] text-left text-[13px] font-semibold text-gray-400 hover:text-gray-200 hover:border-white/30 transition-colors"
              >
                {showRecentRuns ? '▾' : '▸'} Recent runs ({recentRunsAll.length + recentConfers.length})
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
                      className="text-[12px] text-gray-400 hover:text-gray-200 transition-colors pl-1"
                    >
                      {showAllRecent ? 'Show less' : `Show all ${recentRunsAll.length}`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

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

/**
 * The cartridge options, with the offline ones under their own heading.
 *
 * Both selectors in this file render the identical list, and it was written out twice — which
 * is how one of them ended up without the offline grouping. `<optgroup>` rather than a sorted
 * flat list because the complaint was not the order, it was that twenty-odd dead checkouts
 * read as equal choices beside the ten live ones; a label is what makes the distinction
 * survive a glance.
 */
/**
 * The way back to a sleeping cartridge.
 *
 * The launch list is live-only so it agrees with the cartridge count on the app header. That
 * exact filter was reverted once before (894144d) because a disconnected cartridge SILENTLY
 * disappeared and launching onto it became impossible with no explanation. This is the
 * difference: the offline ones are folded away behind a count, not missing.
 */
function OfflineReveal({ count, onShow }: { count: number; onShow: () => void }) {
  if (count < 1) return null;
  return (
    <>
      {' '}
      <button
        type="button"
        onClick={onShow}
        className="underline underline-offset-2 hover:text-gray-400"
      >
        Show {count} offline
      </button>
    </>
  );
}

/**
 * Put THIS template on a repeating schedule, from the template itself.
 *
 * Scheduling already existed, but only under Projects → Heartbeats — so automating a workflow
 * meant knowing that heartbeats exist, that they live under a project, and that they take a
 * template id. "Schedule or put on automation ALL workflow templates" is answered by the
 * control being where the template is.
 *
 * A schedule needs a CARTRIDGE and nothing else. It deliberately does not require a project:
 * requiring one would mean a template has to belong to something before it can repeat.
 */
function ScheduleControl({ templateId, templateName, agents, onClose }: {
  templateId: string;
  templateName: string;
  agents?: Agent[];
  onClose: () => void;
}) {
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly' | 'quarterly' | 'hourly'>('daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [agentId, setAgentId] = useState('');
  // More cartridges = the schedule runs as a CONFER on all of them. Confer needs at least two.
  const [withIds, setWithIds] = useState<string[]>([]);
  const teamNeeded = templateName === 'Confer';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [existing, setExisting] = useState<Heartbeat[]>([]);

  const options = workflowAgentOptions(agents || []);

  useEffect(() => {
    api.getHeartbeats().then((hb) => setExisting(hb.filter((h) => h.templateId === templateId))).catch(() => {});
  }, [templateId]);

  async function save() {
    // A scheduled run has nobody to ask at 09:00, so the cartridge is not optional — the
    // server refuses a heartbeat without one rather than firing a run that cannot dispatch.
    if (!agentId) { setError('Pick a cartridge — a scheduled run has nobody to ask at 09:00.'); return; }
    const team = [agentId, ...withIds.filter((id) => id !== agentId)];
    if (teamNeeded && team.length < 2) { setError('Confer is worked by two or more cartridges — add at least one more.'); return; }
    setSaving(true); setError('');
    try {
      await api.createHeartbeat({
        templateId,
        agentId,
        ...(team.length >= 2 ? { conferAgentIds: team } : {}),
        label: templateName,
        schedule: {
          type: cadence,
          ...(cadence !== 'hourly' ? { time } : {}),
          ...(cadence === 'weekly' ? { day: weekday } : {}),
          ...(cadence === 'monthly' || cadence === 'quarterly' ? { dayOfMonth } : {}),
        },
      });
      const hb = await api.getHeartbeats();
      setExisting(hb.filter((h) => h.templateId === templateId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the schedule.');
    } finally { setSaving(false); }
  }

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const sel = 'h-9 text-[13px] glass-input text-gray-100 rounded-lg px-2.5 focus:outline-none';

  return (
    <div className="mt-1.5 px-3.5 py-3 rounded-[14px] bg-[rgba(4,8,20,0.7)] border border-neon-500/30 space-y-2.5">
      {existing.length > 0 && (
        <div className="space-y-1">
          {existing.map((h) => (
            <div key={h.id} className="flex items-center gap-2 text-[12px]">
              <span className={h.active ? 'text-emerald-300' : 'text-gray-500'}>{h.active ? '●' : '○'}</span>
              <span className="text-gray-300 flex-1">{h.scheduleLabel || 'scheduled'}</span>
              <button
                onClick={() => api.deleteHeartbeat(h.id).then(() => setExisting((p) => p.filter((x) => x.id !== h.id))).catch(() => {})}
                className="text-gray-400 hover:text-red-300"
              >remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} className={sel}>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
        </select>
        {cadence === 'weekly' && (
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={sel}>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        )}
        {(cadence === 'monthly' || cadence === 'quarterly') && (
          <select value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))} className={sel}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>day {d}</option>)}
          </select>
        )}
        {cadence !== 'hourly' && (
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={sel} />
        )}
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={sel}>
          <option value="">Cartridge…</option>
          {options.map((a) => <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>)}
        </select>
        {agentId && (
          <select
            value=""
            onChange={(e) => { const id = e.target.value; if (id) setWithIds((w) => (w.includes(id) ? w : [...w, id])); }}
            className={sel}
            aria-label="Work it together with"
            title="Several cartridges work the run together (a confer)"
          >
            <option value="">{teamNeeded ? 'With… (needs 1+ more)' : 'With… (optional)'}</option>
            {options.filter((a) => a.id !== agentId && !withIds.includes(a.id)).map((a) => (
              <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>
            ))}
          </select>
        )}
        {withIds.filter((id) => id !== agentId).map((id) => {
          const a = options.find((o) => o.id === id);
          return (
            <button key={id} onClick={() => setWithIds((w) => w.filter((x) => x !== id))}
              className="h-9 text-[12px] px-2.5 rounded-lg bg-white/[0.06] text-gray-300 hover:text-red-300" title="Remove">
              + {a ? (a.repoName || a.name) : id.slice(0, 8)} ×
            </button>
          );
        })}
        <button onClick={save} disabled={saving}
          className="h-9 text-[13px] font-semibold px-3 rounded-lg btn-primary disabled:opacity-30 disabled:shadow-none">
          {saving ? '…' : 'Schedule'}
        </button>
        <button onClick={onClose} className="h-9 text-[13px] font-semibold px-3 rounded-lg btn-ghost">Close</button>
      </div>
      {error && <p className="text-[12px] text-red-300">{error}</p>}
    </div>
  );
}

function CartridgeOptions({ live, offline }: {
  live: { id: string; repoName?: string; name: string; agentType?: string }[];
  offline: { id: string; repoName?: string; name: string; agentType?: string }[];
}) {
  const opt = (a: { id: string; repoName?: string; name: string; agentType?: string }) => (
    <option key={a.id} value={a.id}>{a.repoName || a.name} · {a.agentType}</option>
  );
  return (
    <>
      {live.map(opt)}
      {offline.length > 0 && (
        <optgroup label={`Offline — will queue until it reconnects (${offline.length})`}>
          {offline.map(opt)}
        </optgroup>
      )}
    </>
  );
}

function WorkflowLaunchOptionField({ option, value, onChange }: {
  option: WorkflowLaunchOption;
  value: string | boolean | string[];
  onChange: (value: string | boolean | string[]) => void;
}) {
  switch (option.type) {
    case 'boolean':
      return (
        <label className="flex items-start gap-2 text-[13px] text-gray-300 cursor-pointer">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)}
            className="mt-0.5 accent-emerald-500" />
          <span>{option.label}{option.description && <small className="block text-gray-600">{option.description}</small>}</span>
        </label>
      );
    case 'select':
      return (
        <>
          <label className="text-[12px] text-gray-400">{option.label}</label>
          <select value={String(value)} onChange={(event) => onChange(event.target.value)}
            className="w-full h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 focus:outline-none">
            {option.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
          {option.description && <p className="text-[11px] text-gray-600">{option.description}</p>}
        </>
      );
    case 'multi-select':
      return (
        <fieldset>
          <legend className="text-[12px] text-gray-400 mb-1">{option.label}</legend>
          <div className="grid grid-cols-2 gap-1.5">
            {option.choices?.map((choice) => {
              const selected = Array.isArray(value) && value.includes(choice.value);
              return (
                <label key={choice.value} className="flex items-center gap-2 text-[12px] text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={selected} onChange={() => {
                    const before = Array.isArray(value) ? value : [];
                    onChange(selected ? before.filter((item) => item !== choice.value) : [...before, choice.value]);
                  }} className="accent-emerald-500" />
                  {choice.label}
                </label>
              );
            })}
          </div>
          {option.description && <p className="text-[11px] text-gray-600 mt-1">{option.description}</p>}
        </fieldset>
      );
    case 'text':
      return (
        <>
          <label className="text-[12px] text-gray-400">{option.label}{option.required ? ' *' : ''}</label>
          <input type="text" value={String(value)} placeholder={option.placeholder}
            onChange={(event) => onChange(event.target.value)}
            className="w-full h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 focus:outline-none" />
          {option.description && <p className="text-[11px] text-gray-600">{option.description}</p>}
        </>
      );
  }
}

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
    launchConfig: WorkflowLaunchConfig | null;
    launchConfigError: string | null;
  } | null>(null);
  useEscapeKey(() => setDeferredPopup(null), !!deferredPopup);
  const [deferredAssignments, setDeferredAssignments] = useState<Record<string, string>>({});
  // One cartridge for the whole run — the common case. Per-step assignment is the opt-in
  // exception, not the default the modal is built around.
  const [runAgentId, setRunAgentId] = useState('');
  const [perStepAgents, setPerStepAgents] = useState(false);
  /**
   * Run-level confer: two or more cartridges work EVERY agent step together.
   *
   * Deliberately a THIRD choice beside "one cartridge" and "one per step", not a variation of
   * either — it answers a different question. One cartridge asks where the work runs; per step
   * asks who owns which step; this asks who works the whole thing together, and lets them
   * decide per step which repo owns the code.
   */
  const [conferAgents, setConferAgents] = useState<string[]>([]);
  const [conferMode, setConferMode] = useState<ConferMode>('divide');
  const [conferIsolation, setConferIsolation] = useState<ConferIsolation>('shared');
  /**
   * The cartridges offered for a confer: the SAME set the rest of the app shows.
   *
   * This used to map the raw `agents` array, so the confer picker listed dismissed rows, stale
   * checkouts and superseded duplicates that no other selector shows — "the list of items
   * available for confer in the workflow should reflect what I see in the app, nothing more
   * nothing less". Anything already picked is kept, so a selection cannot vanish mid-edit.
   */
  const conferCandidates = useMemo(
    () => workflowAgentOptions(agents ?? [], { keepIds: conferAgents }),
    [agents, conferAgents],
  );
  const [deferredPrompts, setDeferredPrompts] = useState<Record<string, Record<string, string>>>({});
  const [launchOptionValues, setLaunchOptionValues] = useState<WorkflowLaunchValues>({});
  const [initialContext, setInitialContext] = useState('');
  // Confer only: an optional Jira epic. Its first step looks the epic up and lists every task.
  const [conferEpic, setConferEpic] = useState('');
  /** What this launch hands the run as context — for Confer, the epic line plus the task. */
  const launchContext = wf.name === 'Confer' ? conferLaunchContext(initialContext, conferEpic) : initialContext;
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

  // Off by default so this list matches the cartridge count on the app's own header. The
  // reveal is a control, not a hidden behaviour — see workflow-agent-options.ts.
  const [showOffline, setShowOffline] = useState(false);
  // Scheduling lives on the template card itself — see ScheduleControl.
  const [scheduling, setScheduling] = useState(false);
  // The two options beside the Run button. See components/LaunchSchedule.tsx.
  const [launchSchedule, setLaunchSchedule] = useState<LaunchScheduleValue>(emptySchedule);
  /** A TEMPLATE is a workflow with no templateId — a run points at the template it came from. */
  const isTemplate = !wf.templateId;
  const isV2 = !!wf.stepSummary;
  const canRun = isV2 && !['running', 'paused'].includes(wf.status);
  /**
   * Offline cartridges are OFFERED, not hidden.
   *
   * Filtering them out meant a disconnected cartridge silently vanished from the dropdown, so
   * launching a workflow onto it was impossible with no explanation — reported as the workflow
   * "not sending". Offline is now a queueable state: the run waits for the cartridge to come
   * back, and the queue halts the lane with a reason if it never does. Sorted so live ones lead.
   */
  // Sorting, age-out, duplicate collapsing and the live-only default all live in
  // workflowAgentOptions now — a second copy of any of it here is how the two selectors
  // drifted into disagreeing about which cartridges exist.
  //
  // keepIds: whatever this run's steps are already pinned to stays listed even if it is
  // offline, or the <select> renders blank and the next save unassigns the step.
  const pinnedIds = useMemo(
    () => Object.values(deferredAssignments).filter(Boolean),
    [deferredAssignments],
  );
  const onlineAgents = useMemo(
    () => workflowAgentOptions(agents || [], { includeOffline: showOffline, keepIds: pinnedIds }),
    [agents, showOffline, pinnedIds],
  );
  const hiddenOfflineCount = useMemo(
    () => (showOffline ? 0 : offlineOptionCount(agents || [], { keepIds: pinnedIds })),
    [agents, showOffline, pinnedIds],
  );
  const liveAgents = onlineAgents.filter((a) => !isOfflineOption(a));
  const offlineAgents = onlineAgents.filter(isOfflineOption);

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
        } else if (s.executorType === 'confer') {
          if (!cfg.prompt && !s.description) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'prompt', label: 'Shared Objective' });
        } else if (s.executorType === 'quality-gate') {
          if (cfg.gateType === 'custom' && !cfg.customPrompt) promptSteps.push({ stepId: s.id, stepName: s.name, field: 'customPrompt', label: 'Custom Quality Check' });
        }
      }

      const { config: launchConfig, error: launchConfigError } = findWorkflowLaunchConfig(
        steps.map((workflowStep) => workflowStep.executorConfig as Record<string, unknown>),
      );
      const launchOptions = launchConfig?.options ?? [];

      // Always show the popup — either for deferred fields or just for the context input
      setDeferredPopup({
        agentSteps,
        promptSteps,
        launchConfig,
        launchConfigError,
      });
      setDeferredAssignments({});
      setDeferredPrompts({});
      setLaunchOptionValues(defaultLaunchOptionValues(launchOptions));
      setInitialContext('');
      setConferEpic('');
      setSelectedProjectId('');
      setRunError('');
      clearAttachments();
      api.getGoalProjects().then(setProjects).catch(() => {});
      setStarting(false);
    } catch { /* silent */ }
    finally { setStarting(false); }
  }

  /**
   * Everything standing between this launch and starting — ONE answer, used by both the button
   * and the handler below.
   *
   * These were two separate expressions. The button's knew that a confer supplies its own
   * cartridges; the handler's did not, and returned silently on its first line. That is the
   * "turns green but doesn't start" bug: both halves working exactly as written, disagreeing.
   */
  const blockers = deferredPopup
    ? [...launchBlockers({
        projectId: selectedProjectId || '',
        agentStepCount: deferredPopup.agentSteps.length,
        perStepAgents,
        assignments: deferredAssignments,
        runAgentId,
        conferAgents,
        promptSteps: deferredPopup.promptSteps,
        prompts: deferredPrompts,
        requiresContext: REQUIRES_CONTEXT.includes(wf.name),
        initialContext: launchContext,
      }), ...(deferredPopup.launchConfigError ? [deferredPopup.launchConfigError] : []),
        ...launchOptionErrors(deferredPopup.launchConfig?.options ?? [], launchOptionValues)]
    : [];

  async function handleDeferredRun() {
    if (!deferredPopup) return;
    // Refuse OUT LOUD. The old guard was a bare `return` — correct often enough, and completely
    // silent, which is why a dead button took three reports to diagnose.
    if (blockers.length > 0) {
      setRunError(blockers.join(' '));
      return;
    }

    let effectiveInitialContext = launchContext.trim();
    if (deferredPopup.launchConfig) {
      try {
        const command = renderLaunchCommand(deferredPopup.launchConfig, launchOptionValues);
        effectiveInitialContext = [
          effectiveInitialContext,
          buildLaunchContext(command, deferredPopup.launchConfig.options, launchOptionValues),
        ].filter(Boolean).join('\n\n');
      } catch (err) {
        setRunError(err instanceof Error ? err.message : 'The QA command could not be built.');
        return;
      }
    }

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

    // SCHEDULED instead of started. Everything the form collected still applies — the
    // cartridge, the context, the posture — it just happens later. A separate control outside
    // this form could not carry any of that.
    if (isScheduledLaunch(launchSchedule)) {
      try {
        const agentId = conferAgents.length >= 2 ? conferAgents[0]
          : (perStepAgents ? Object.values(deferredAssignments).find(Boolean) : runAgentId) || '';
        const req = scheduleRequest(launchSchedule);
        await api.createHeartbeat({
          templateId: wf.id,
          agentId,
          projectId: selectedProjectId || null,
          label: wf.name,
          initialContext: effectiveInitialContext || undefined,
          // A scheduled confer keeps ALL its cartridges. It used to keep only the first, and the
          // run died at its confer step every time it fired.
          ...(conferAgents.length >= 2 ? { conferAgentIds: conferAgents, conferMode, conferIsolation } : {}),
          ...req,
        });
        setDeferredPopup(null);
        setLaunchSchedule(emptySchedule());
        onAction();
      } catch (err) {
        setRunError(err instanceof Error ? err.message : 'Could not schedule this run.');
      } finally { setStarting(false); }
      return;
    }

    // The modal stays up until the server accepts the run. Attachments are the first thing
    // here that can be rejected server-side (missing repo path, oversized batch) — closing
    // first would drop that message on the floor along with everything the user typed.
    try {
      const result = await api.startWorkflowV2(
        wf.id,
        // Confer mode replaces per-step assignment: the whole point is that no single
        // cartridge owns a step.
        conferAgents.length >= 2
          ? undefined
          : perStepAgents && deferredPopup.agentSteps.length > 0 ? deferredAssignments : undefined,
        deferredPopup.promptSteps.length > 0 ? deferredPrompts : undefined,
        effectiveInitialContext || undefined,
        selectedProjectId || null,
        // The run-level cartridge fills every unassigned step server-side, so we don't have to
        // fan it out into a per-step map here.
        conferAgents.length >= 2 ? undefined : (!perStepAgents ? runAgentId || undefined : undefined),
        payloads.length > 0 ? payloads : undefined,
        conferAgents.length >= 2 ? conferAgents : undefined,
        conferAgents.length >= 2 ? conferMode : undefined,
        conferAgents.length >= 2 ? conferIsolation : undefined,
      );
      setDeferredPopup(null);
      // Queued, not started: the cartridge was mid-task. Say so — without this the modal just
      // closes and nothing appears to happen, which reads exactly like the bug this fixes.
      if (result?.queued) {
        onAction();
        return;
      }
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
      <div className="glass-dark rounded-[22px] shadow-[0_30px_80px_rgba(0,0,0,0.6)] w-[640px] max-w-[calc(100vw-32px)] max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between px-[26px] pt-[26px] pb-2">
          <div>
            <h2 className="font-display text-[22px] font-semibold text-gray-100">Configure &amp; Run — {wf.name}</h2>
            <p className="text-[13px] text-gray-400 mt-1">Fill in the required fields before running.</p>
          </div>
          <button onClick={() => setDeferredPopup(null)} aria-label="Close" className="w-10 h-10 rounded-[10px] btn-ghost text-lg leading-none">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto px-[26px] py-4 space-y-[18px]">
          <div className="space-y-2">
            {wf.name === 'Feature Validation' ? (
              <>
                <span className="text-[13px] text-gray-200 font-medium">Feature Specification</span>
                <p className="text-[12px] text-gray-400">
                  Describe the feature you want to validate. Include: what it does functionally, how it should work architecturally, acceptance criteria, and any edge cases or error states that must be handled. Optionally add a Jira epic key (e.g. GRD-500) to pull in task requirements.
                </p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={8}
                  className="w-full text-sm glass-input text-gray-100 rounded-[10px] px-3 py-2.5 focus:outline-none resize-y"
                  placeholder={"Feature: [name]\n\nWhat it should do:\n- \n\nArchitecture (components/routes/DB tables involved):\n- \n\nAcceptance criteria:\n- [ ] \n\nEdge cases / error states:\n- \n\nJira epic (optional): GRD-"}
                />
              </>
            ) : wf.name === 'Epic: Task by Task' ? (
              <>
                {/* The template resolves a path OR a tracker key, so the prompt must not
                    imply that only one of them works. */}
                <span className="text-[13px] text-gray-200 font-medium">Which epic?</span>
                <p className="text-[12px] text-gray-400">A path to an epic markdown file, or a tracker key. Every task in it gets worked and committed, one at a time, until none are left.</p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={2}
                  className="w-full text-sm glass-input text-gray-100 rounded-[10px] px-3 py-2.5 focus:outline-none resize-y"
                  placeholder="docs/plans/EPIC-search.md   ·   or   GRD-1712"
                />
              </>
            ) : wf.name === 'Confer' ? (
              <>
                <span className="text-[13px] text-gray-200 font-medium">What should they work on?</span>
                <p className="text-[12px] text-gray-400">Describe the task — or give a Jira epic below and the cartridges work every task in it. With both, the text is extra direction for the epic.</p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={3}
                  className="w-full text-sm glass-input text-gray-100 rounded-[10px] px-3 py-2.5 focus:outline-none resize-y"
                  placeholder="e.g. Add refunds: the ledger API in harbour-ledger and the refund screen in frontdesk"
                />
                <span className="text-[13px] text-gray-300 font-medium block pt-1">Jira epic <span className="text-gray-600 font-normal">(optional)</span></span>
                <p className="text-[12px] text-gray-400">The epic is looked up first; the run keeps going until every task in it is done.</p>
                <input
                  type="text"
                  value={conferEpic}
                  onChange={(e) => setConferEpic(e.target.value)}
                  aria-label="Jira epic"
                  className="w-full h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 focus:outline-none"
                  placeholder="GRD-1712  ·  or the epic's Jira URL"
                />
              </>
            ) : wf.name === 'Jira Tasks Validation' ? (
              <>
                <span className="text-[13px] text-gray-200 font-medium">Which Jira epic?</span>
                <p className="text-[12px] text-gray-400">Enter the epic name or key (e.g. "Document Generation" or "GRD-1712").</p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={2}
                  className="w-full text-sm glass-input text-gray-100 rounded-[10px] px-3 py-2.5 focus:outline-none resize-y"
                  placeholder="e.g. GRD-1712 or Document Generation"
                />
              </>
            ) : (
              <>
                <span className="text-[13px] text-gray-400 font-medium">Initial Context</span>
                <p className="text-[12px] text-gray-400">Optional — passed to the first step(s) of this workflow run.</p>
                <textarea
                  value={initialContext}
                  onChange={(e) => setInitialContext(e.target.value)}
                  rows={3}
                  className="w-full text-sm glass-input text-gray-100 rounded-[10px] px-3 py-2.5 focus:outline-none resize-y"
                  placeholder="Describe what this run should focus on…"
                />
              </>
            )}
          </div>
          {(deferredPopup.launchConfig?.options.length ?? 0) > 0 && (
            <div className="space-y-3 border border-emerald-500/20 bg-emerald-500/[0.04] rounded-lg p-3">
              <div>
                <span className="text-[13px] text-emerald-300 font-medium">Gridlight QA options</span>
                <p className="text-[12px] text-gray-500 mt-0.5">These selections are passed directly to the QA script.</p>
              </div>
              {deferredPopup.launchConfig!.options
                .filter((option) => isLaunchOptionVisible(option, launchOptionValues))
                .map((option) => (
                  <div key={option.key} className="space-y-1.5">
                    <WorkflowLaunchOptionField
                      option={option}
                      value={launchOptionValues[option.key] ?? option.defaultValue}
                      onChange={(value) => setLaunchOptionValues((current) => ({ ...current, [option.key]: value }))}
                    />
                  </div>
                ))}
            </div>
          )}
          {/* Project assignment — required */}
          <div className="space-y-1.5">
            <span className="text-[13px] text-gray-400 font-medium">Project</span>
            {projects.length === 0 ? (
              <p className="text-[12px] text-gray-400">
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
                className="w-full h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 focus:outline-none"
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
                <span className="text-[13px] text-gray-400 font-medium">Run on</span>
                {/* The escape hatch. Almost nobody wants a different cartridge per step, so
                    that's opt-in rather than the default the whole modal is built around. */}
                {deferredPopup.agentSteps.length > 1 && conferAgents.length === 0 && (
                  <button
                    onClick={() => setPerStepAgents((v) => !v)}
                    className="text-[12px] text-gray-400 hover:text-neon-300 transition-colors"
                  >
                    {perStepAgents ? '← use one cartridge' : 'assign per step →'}
                  </button>
                )}
              </div>

              {/* Confer mode. Picking two or more cartridges here overrides both of the other
                  modes: every agent step becomes a confer among them, and "which repo owns
                  this" is answered by the participants at each step rather than by whoever
                  filled in this modal. */}
              <div className="mb-2">
                <label className="text-[13px] text-gray-400 block mb-2">
                  Confer across repos — pick 2+ cartridges to work every step together
                </label>
                <div className="flex flex-wrap gap-2">
                  {conferCandidates.map((a) => {
                    const on = conferAgents.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        onClick={() => setConferAgents((prev) =>
                          prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id])}
                        aria-pressed={on}
                        className={`h-10 px-3.5 rounded-full border font-mono text-[13px] font-semibold transition-colors ${
                          on
                            ? 'border-neon-500 bg-neon-500/20 text-neon-50'
                            : 'border-white/[0.18] text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        {on ? '✓ ' : ''}{conferOptionLabel(a)}
                      </button>
                    );
                  })}
                </div>
                {conferAgents.length >= 2 && (
                  <ConferModePicker value={conferMode} onChange={setConferMode} isolation={conferIsolation} onIsolationChange={setConferIsolation} />
                )}
                {conferAgents.length === 1 && (
                  <p className="text-[11px] text-amber-400/70 mt-1">
                    Pick at least one more — a one-cartridge confer is an ordinary run.
                  </p>
                )}
              </div>

              {conferAgents.length >= 2 ? (
                <p className="text-[11px] text-gray-500">
                  Every agent step will be worked by {conferAgents.length} cartridges together.
                </p>
              ) : !perStepAgents ? (
                <>
                  <select
                    value={runAgentId}
                    onChange={(e) => setRunAgentId(e.target.value)}
                    className="w-full h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 focus:outline-none"
                  >
                    <option value="">Select cartridge...</option>
                    <CartridgeOptions live={liveAgents} offline={offlineAgents} />
                  </select>
                  <p className="text-[11px] text-gray-600">
                    All {deferredPopup.agentSteps.length} step
                    {deferredPopup.agentSteps.length === 1 ? '' : 's'} run here.
                    <OfflineReveal count={hiddenOfflineCount} onShow={() => setShowOffline(true)} />
                  </p>
                </>
              ) : (
                deferredPopup.agentSteps.map((s) => (
                  <div key={s.stepId}>
                    <label className="block text-sm text-gray-400 mb-1">{s.stepName}</label>
                    <select
                      value={deferredAssignments[s.stepId] || ''}
                      onChange={(e) => setDeferredAssignments((prev) => ({ ...prev, [s.stepId]: e.target.value }))}
                      className="w-full h-[42px] text-sm glass-input text-gray-100 rounded-[10px] px-3 focus:outline-none"
                    >
                      <option value="">Select cartridge...</option>
                      <CartridgeOptions live={liveAgents} offline={offlineAgents} />
                    </select>
                  </div>
                ))
              )}
              {perStepAgents && (
                <p className="text-[11px] text-gray-600">
                  <OfflineReveal count={hiddenOfflineCount} onShow={() => setShowOffline(true)} />
                </p>
              )}
            </div>
          )}
          {deferredPopup.promptSteps.length > 0 && (
            <div className="space-y-3">
              <span className="text-[13px] text-gray-400 font-medium">Prompt Inputs</span>
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
                    className="w-full text-sm glass-input text-gray-100 rounded-[10px] px-3 py-2.5 focus:outline-none resize-y"
                    placeholder={`Enter ${s.label.toLowerCase()}...`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {runError && <p className="px-[26px] pb-2 text-[13px] text-red-300">{runError}</p>}
        {!runError && blockers.length > 0 && (
          // A disabled button with nothing beside it is the same dead end as a silent handler:
          // the user can see they cannot start and not why.
          <p className="px-[26px] pb-2 text-[13px] text-gray-400">{blockers.join(' ')}</p>
        )}
        <div className="px-[26px] pb-2">
          <LaunchSchedule value={launchSchedule} onChange={setLaunchSchedule} />
        </div>
        <div className="px-[26px] pt-2 pb-[22px] flex items-center justify-end gap-2.5">
          <button onClick={() => setDeferredPopup(null)} className="h-11 px-4 rounded-[10px] btn-ghost text-sm font-semibold">
            Cancel
          </button>
          <button
            onClick={handleDeferredRun}
            disabled={starting || blockers.length > 0}
            title={blockers.join(' ')}
            className="h-11 px-[22px] rounded-[10px] btn-primary text-sm font-semibold disabled:opacity-35 disabled:shadow-none transition-colors"
          >
            {launchButtonLabel(launchSchedule, starting)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );

  // "Epic: Task by Task — Run #11" says which template and which run, and nothing about WHAT.
  // The subject is what a person scanning the list is actually looking for, so it goes on the row
  // rather than only in the detail view.
  const runTitle = wf.runNumber > 0
    ? `${templateName || wf.name} — Run #${wf.runNumber}`
    : wf.name || 'Untitled';
  const displayName = wf.contextLabel
    ? `${runTitle} · ${wf.contextLabel}`
    : runTitle;

  if (compact) {
    return (
      <>
        <div className="flex items-center gap-3 px-3.5 py-2.5 glass-light rounded-xl text-[13px] group">
          {wf.templateId && (
            <span className={`font-medium ${statusColor}`}>{wf.status}</span>
          )}
          <button
            onClick={() => onOpen?.(wf.id)}
            className="text-gray-200 truncate flex-1 text-left hover:text-white transition-colors"
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
              <span className="text-gray-400 shrink-0">
                {wf.templateId
                  ? `${wf.stepSummary.completed}/${wf.stepSummary.total}`
                  : `${wf.stepSummary.total} steps`}
              </span>
              {wf.progress && (
                <span className="text-neon-300 shrink-0 hidden sm:inline" title={progressLine(wf.progress)}>
                  {wf.progress.total !== null ? `${wf.progress.done}/${wf.progress.total} tasks` : `${wf.progress.done} tasks`}
                </span>
              )}
            </>
          )}
          {wf.jiraTaskId && <span className="text-gray-500 font-mono shrink-0">{wf.jiraTaskId}</span>}
          {canRun && (
            <button
              onClick={handleRunFromList}
              disabled={starting}
              className="text-neon-400 hover:text-neon-200 opacity-0 group-hover:opacity-100 transition-all shrink-0 disabled:opacity-30"
              title="Run workflow"
            >
              {starting ? '...' : '▶'}
            </button>
          )}
          {isTemplate && (
            <button
              onClick={() => setScheduling((v) => !v)}
              className={`shrink-0 transition-all ${scheduling ? 'text-neon-300' : 'text-gray-400 hover:text-neon-300 opacity-0 group-hover:opacity-100'}`}
              title="Repeat this workflow on a schedule"
            >
              ⏱
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
              className="text-gray-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-all shrink-0"
              title="Delete workflow"
            >
              &times;
            </button>
          )}
        </div>
        {scheduling && isTemplate && (
          <ScheduleControl
            templateId={wf.id}
            templateName={wf.name}
            agents={agents}
            onClose={() => setScheduling(false)}
          />
        )}
        {deferredPopupEl}
      </>
    );
  }

  // ── Template row: a compact entry in the library, not a card. ──
  if (isTemplate) {
    const category = TAB_LABELS[TEMPLATE_CATEGORY[wf.name] ?? 'development'];
    const total = wf.stepSummary?.total ?? 0;
    return (
      <>
        <div className="group flex items-center gap-2.5 px-3.5 py-3 rounded-[14px] glass-light hover:border-white/[0.2] transition-colors">
          <button
            onClick={() => onOpen?.(wf.id)}
            title={wf.description || undefined}
            className="flex-1 min-w-0 flex flex-col gap-0.5 text-left"
          >
            <span className="text-sm font-semibold text-gray-100 truncate">{displayName}</span>
            <span className="text-[12px] text-gray-400 truncate">
              {category} · {total} step{total === 1 ? '' : 's'}
              {typeof runCount === 'number' ? ` · ${runCount} run${runCount === 1 ? '' : 's'}` : ''}
            </span>
          </button>
          {canRun && (
            <button
              onClick={handleRunFromList}
              disabled={starting}
              aria-label={`Run ${wf.name}`}
              className="h-9 px-3 rounded-[9px] bg-neon-500/15 border border-neon-500/45 text-neon-100 text-[13px] font-semibold hover:bg-neon-500/25 disabled:opacity-40 transition-colors shrink-0"
            >
              {starting ? 'Starting…' : '▶ Run'}
            </button>
          )}
          <button
            onClick={() => setScheduling((v) => !v)}
            aria-label={`Schedule ${wf.name}`}
            title="Repeat this workflow on a schedule"
            className={`w-9 h-9 rounded-[9px] border flex items-center justify-center shrink-0 transition-colors ${
              scheduling ? 'border-neon-500/60 text-neon-300 bg-neon-500/10' : 'border-white/[0.14] text-gray-400 hover:text-gray-100'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" /></svg>
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-1 shrink-0">
              <button onClick={handleDelete} className="h-9 px-2.5 rounded-[9px] text-[12px] font-semibold text-red-300 bg-red-500/15 border border-red-400/40">Delete</button>
              <button onClick={() => setConfirmDelete(false)} className="h-9 px-2 text-[12px] text-gray-400 hover:text-gray-200">No</button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${wf.name}`}
              title="Delete workflow"
              className="w-7 h-9 text-gray-500 hover:text-red-300 opacity-60 group-hover:opacity-100 transition-all shrink-0 text-lg leading-none"
            >
              &times;
            </button>
          )}
        </div>
        {scheduling && (
          <ScheduleControl
            templateId={wf.id}
            templateName={wf.name}
            agents={agents}
            onClose={() => setScheduling(false)}
          />
        )}
        {deferredPopupEl}
      </>
    );
  }

  // ── Run card. Running = the live neon card; blocked on you = the ember card. ──
  const live = wf.status === 'running' || wf.status === 'paused';
  const sum = wf.stepSummary;
  const pct = sum && sum.total > 0 ? Math.round(((sum.completed + sum.running * 0.5) / sum.total) * 100) : 0;
  const currentStepName = sum?.stepNames?.length
    ? sum.stepNames[Math.min(sum.completed, sum.stepNames.length - 1)]
    : undefined;
  const statusText = {
    pending: 'text-gray-400',
    running: 'text-neon-300',
    paused: 'text-ember-300',
    completed: wf.error ? 'text-ember-300' : 'text-emerald-300',
    failed: 'text-red-300',
    cancelled: 'text-gray-400',
  }[wf.status] || 'text-gray-400';
  const cardTone = wf.needsAttention ? 'panel-ask' : live ? 'panel-live' : 'glass-light';
  const subtitle = [
    sum?.projects?.join(' · '),
    wf.iteration > 1 ? `Iteration ${wf.iteration}/${wf.maxIterations}` : '',
    typeof runCount === 'number' && runCount > 0 ? `${runCount} run${runCount !== 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');
  const btn = 'flex-1 h-10 rounded-[10px] text-[13px] font-semibold transition-colors';

  return (
    <article className={`${cardTone} rounded-[18px] p-[18px] space-y-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex flex-col gap-0.5">
          <button
            onClick={() => onOpen?.(wf.id)}
            className="text-[15px] font-semibold text-gray-100 text-left hover:text-white transition-colors"
          >
            {displayName}
          </button>
          {subtitle && <span className="text-[13px] text-gray-400 truncate">{subtitle}</span>}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {/* A run blocked on a person reads as RUNNING otherwise — which is how a decision
              gate sat for half an hour looking exactly like work in progress. */}
          {wf.needsAttention ? (
            <span title={wf.needsAttention.detail} className="text-[11px] font-bold tracking-[0.08em] text-ember-300">
              NEEDS YOU
            </span>
          ) : (
            <span className={`text-[11px] font-bold tracking-[0.08em] ${statusText}`}>{wf.status.toUpperCase()}</span>
          )}
          {wf.jiraTaskId && <span className="text-[11px] text-gray-400 font-mono">{wf.jiraTaskId}</span>}
        </div>
      </div>
      {!wf.templateId && wf.description && (
        <p className="text-xs leading-relaxed text-gray-400">{wf.description}</p>
      )}

      {/* Step progress (V2 canvas) or Phase progress (V1) */}
      {sum && wf.templateId ? (
        <>
          <div className="flex items-baseline justify-between font-display">
            <span className="text-[15px] font-semibold neon-text truncate">
              {currentStepName ?? `${sum.completed}/${sum.total} steps`}
              {live && <span className="text-gray-600">....</span>}
            </span>
            <span className="text-[22px] font-bold neon-text">{pct}%</span>
          </div>
          <SegMeter pct={pct} cells={30} height={20} label={`${pct} percent — ${sum.completed} of ${sum.total} steps`} />
          <StepProgress summary={sum} />
          {/* A task-list run: how many tasks are done, its progress document, and — when it
              stopped with tasks open — the choice only you can make. */}
          <RunProgressStrip wf={wf} onAction={onAction} />
        </>
      ) : wf.phases.length > 0 ? (
        <>
          <PhaseProgress phases={wf.phases} currentPhase={wf.currentPhase} />
          {wf.status === 'running' && wf.phases[wf.currentPhase] && (
            <PhaseDetails phase={wf.phases[wf.currentPhase]} players={wf.players} agents={agents} />
          )}
        </>
      ) : null}

      {wf.needsAttention && (
        <div className="text-[13px] text-ember-300">
          <span className="uppercase tracking-[0.08em] text-[11px] mr-1.5 opacity-80">
            {wf.needsAttention.reason.replace('-', ' ')}
          </span>
          {wf.needsAttention.detail}
        </div>
      )}

      {/* Error */}
      {wf.error && (
        <div className="text-[13px] text-ember-300 bg-ember-500/10 border border-ember-500/30 rounded-[10px] px-3 py-2">{wf.error}</div>
      )}

      {/* Chips: who works it, and how much of it is yours to drive. */}
      {(live || (sum?.projects && sum.projects.length > 0)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {sum?.projects?.map((p) => (
            <span key={p} className="text-[12px] px-2 py-0.5 rounded-full bg-white/[0.07] text-gray-300 font-mono">{p}</span>
          ))}
          {/* The automate control sits WITH pause and cancel: they are the same question —
              how much of this run is yours to drive right now. */}
          {live && <AutonomyControl workflowId={wf.id} />}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {wf.templateId && (
          <button onClick={() => onOpen?.(wf.id)} className={`${btn} btn-ghost`}>
            {wf.needsAttention ? 'Open run' : 'Progress'}
          </button>
        )}
        {canRun && (
          <button onClick={handleRunFromList} disabled={starting} className={`${btn} btn-primary disabled:opacity-40`}>
            {starting ? 'Starting...' : '▶ Run'}
          </button>
        )}
        {wf.status === 'running' && (
          <button onClick={handlePause} className={`${btn} btn-ghost`}>Pause</button>
        )}
        {wf.status === 'paused' && (
          <button onClick={handleResume} className={`${btn} btn-ghost`}>Resume</button>
        )}
        {live && (
          <button onClick={handleCancel} className={`${btn} border border-red-400/40 text-red-200 hover:bg-red-500/10`}>Cancel</button>
        )}
        {!live && (
          confirmDelete ? (
            <>
              <button onClick={handleDelete} className={`${btn} border border-red-400/50 bg-red-500/15 text-red-200`}>Delete</button>
              <button onClick={() => setConfirmDelete(false)} className={`${btn} btn-ghost`}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className={`${btn} border border-white/[0.12] text-gray-400 hover:text-red-300 hover:border-red-400/40`}>Delete</button>
          )
        )}
      </div>

      {/* Shared context viewer */}
      {wf.sharedContext && (
        <div>
          <button
            onClick={() => setShowContext(!showContext)}
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
          >
            {showContext ? 'Hide' : 'Show'} deliberation context
          </button>
          {showContext && (
            <pre className="mt-2 text-xs text-gray-300 bg-gl-code rounded-[10px] border border-white/[0.08] p-3 max-h-60 overflow-y-auto whitespace-pre-wrap font-mono">
              {wf.sharedContext}
            </pre>
          )}
        </div>
      )}

      {deferredPopupEl}
    </article>
  );
}

// ─── StepProgress (V2 Canvas workflows) ──────────────

function StepProgress({ summary }: { summary: StepSummary }) {
  const { total, completed, running, failed, pending } = summary;
  // The meter above carries the proportion; this line names the steps and the counts.
  return (
    <div className="space-y-1">
      {summary.stepNames && summary.stepNames.length > 0 && (
        <div className="text-[12px] text-gray-400 truncate" title={summary.stepNames.join(' → ')}>
          {summary.stepNames.join(' → ')}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
        {completed > 0 && <span className="text-emerald-300">{completed} done</span>}
        {running > 0 && <span className="text-neon-300">{running} running</span>}
        {failed > 0 && <span className="text-red-300">{failed} failed</span>}
        {pending > 0 && <span className="text-gray-400">{pending} pending</span>}
        <span className="text-gray-500 ml-auto">{completed}/{total} steps</span>
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
