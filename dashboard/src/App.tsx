import { useActiveTheme } from './lib/activeTheme';
import { Fireworks } from './components/Fireworks';
import { LogsPage } from './components/LogsPage';
import { useState, useEffect, useCallback } from 'react';
import { SoundButton } from './components/SoundControls';
import { useSoundEvents } from './lib/sound/useSoundEvents';
import { useAgents } from './hooks/useAgents';
import { CartridgeGrid } from './components/CartridgeGrid';
import type { StatusFilter } from './components/CartridgeGrid';
import { ActivityDetailModal } from './components/ActivityDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { MachineLauncher } from './components/MachineLauncher';
import { NewRepoModal } from './components/NewRepoModal';
import { WorkflowPanel } from './components/WorkflowPanel';
import { NotificationCenter } from './components/NotificationCenter';
import { ProjectsProvider, ProjectPicker, ProjectsWorkspace } from './components/ProjectsPage';
import { BridgeCaptain, BridgeGauges } from './world/bridge/Bridge';
import { EngineerPost, FlowGauges, CorePost, TokenGauges, QuartermasterPost, TaskGauges, deckProps, isDeckView } from './world/bridge/Decks';
import { isProjectsHash } from './lib/projectSelection';
import { TasksPage } from './components/TasksPage';
import { GuideModal } from './components/GuideModal';
import { ServerPicker } from './components/ServerPicker';
import { BurnRate } from './components/BurnRate';
import { TokensPage } from './components/TokensPage';
import { QaPage } from './components/qa/QaPage';
import { TriagePage } from './components/triage/TriagePage';
import { api } from './lib/api';
import { useNeedsYou } from './hooks/useNeedsYou';
import type { AgentType, Activity, VirtualCartridge } from './types';
import { IS_DEMO } from './lib/api';
import { setDemoEnabled, resetDemoData } from './lib/demoMode';
import { WorldScene } from './world/WorldScene';
import { VIEW_TITLE, AGENTS_LAYOUTS, readAgentsLayout, writeAgentsLayout } from './lib/views';
import type { View, AgentsLayout } from './lib/views';

/** One entry of the left view bar (Projects · Agents · Workflows · Tasks · Tokens). */
function NavItem({ active, onClick, label, badge, children }: { active: boolean; onClick: () => void; label: string; badge?: number; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`relative flex flex-col items-center justify-center gap-1 w-14 py-2 rounded-[14px] text-[11px] font-semibold transition-colors ${
        active
          ? 'bg-neon-600/20 border border-neon-500/50 text-neon-200 shadow-[0_0_16px_rgba(77,163,255,0.35)]'
          : 'border border-transparent text-gray-400 hover:text-gray-100 hover:bg-white/[0.04]'
      }`}
    >
      {children}
      {label}
      {badge ? (
        <span className="absolute top-0.5 right-1 text-[10px] leading-4 px-1.5 rounded-full bg-neon-500 text-ink">{badge}</span>
      ) : null}
    </button>
  );
}

const ICON = 'w-[22px] h-[22px]';

export default function App() {
  // The theme in use for everyone (Settings → Themes) decides how this browser draws NeonCore.
  useActiveTheme();
  // Virtual cartridges
  const [virtualCartridges, setVirtualCartridges] = useState<VirtualCartridge[]>([]);

  const refreshVirtualCartridges = useCallback(() => {
    api.getVirtualCartridges().then(setVirtualCartridges).catch(() => {});
  }, []);

  useEffect(() => {
    refreshVirtualCartridges();
  }, [refreshVirtualCartridges]);

  const handleVirtualCartridgeUpdated = useCallback((vc: VirtualCartridge) => {
    setVirtualCartridges((prev) => {
      const exists = prev.some((c) => c.id === vc.id);
      return exists ? prev.map((c) => (c.id === vc.id ? vc : c)) : [...prev, vc];
    });
  }, []);

  const {
    agents,
    activitiesByAgent,
    pendingPermissions,
    loading,
    stuckAlertsArray,
    workflowNotifications,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
    dismissAgent,
    restoreAgent,
    dismissStuckAlert,
    dismissWorkflowNotification,
    tasks,
    createTask,
    cancelTask,
    updateTask,
    dispatchTask,
    completeTask,
    servers,
    serverStatuses,
    applyFleetToken,
  } = useAgents(handleVirtualCartridgeUpdated);
  // SOUND (lib/sound): one cue per kind of thing that just happened, and the interface sounds.
  useSoundEvents({ agents, pendingPermissions, stuckAlerts: stuckAlertsArray, workflowNotifications, tasks });
  // What waits on you, from state — the bell's events can be missed (server lib/needs-you.ts).
  const needsYou = useNeedsYou(workflowNotifications[0]?.id);

  const [typeFilter, setTypeFilter] = useState<AgentType | 'all'>('all');
  // Status selection lives here so it can render in the rail; the counts come back up
  // from the grid, which is the only place that knows who survives dedup and dismissal.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [statusCounts, setStatusCounts] = useState<Record<StatusFilter, number>>({ all: 0, working: 0, waiting: 0, idle: 0 });
  const handleStatusCounts = useCallback((c: Record<StatusFilter, number>) => {
    setStatusCounts((prev) =>
      prev.all === c.all && prev.working === c.working && prev.waiting === c.waiting && prev.idle === c.idle ? prev : c
    );
  }, []);
  /* Agents is the default. A project or feature deep link (`#project/…`, or the older `#goal/<id>`) overrides it, because addressing a goal without
     addressing the view that renders it is only half a link: `#goal/<id>` in a fresh tab
     otherwise opens Agents with the goal selected in a pane nobody is showing. */
  const [activeView, setActiveView] = useState<View>(
    () => (typeof window !== 'undefined' && isProjectsHash(window.location.hash) ? 'projects' : 'agents'),
  );

  // The same link, followed while the app is already open, arrives as hashchange instead of
  // a load — so the view has to move here too, or a notification click silently does nothing.
  useEffect(() => {
    const onHash = () => {
      if (isProjectsHash(window.location.hash)) setActiveView('projects');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // V3: the Agents screen is a scene by default. The list of cartridge cards is still one
  // click away (and remembered), because a scene is the wrong tool when you need to read
  // twelve logs at once — and hidden and virtual cartridges only exist in the list.
  const [agentsLayout, setAgentsLayoutState] = useState<AgentsLayout>(readAgentsLayout);
  const setAgentsLayout = useCallback((layout: AgentsLayout) => {
    setAgentsLayoutState(layout);
    writeAgentsLayout(layout);
  }, []);
  const sceneOpen = activeView === 'agents' && agentsLayout === 'scene';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [newRepoOpen, setNewRepoOpen] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');
  const activeTaskCount = tasks.filter((t) => t.status === 'queued' || t.status === 'claimed' || t.status === 'in_progress').length;

  const filteredAgents = typeFilter === 'all' ? agents : agents.filter((a) => a.agentType === typeFilter);

  // A type's chip shows only when at least one online agent uses it.
  const TYPE_ORDER: AgentType[] = ['claude', 'codex'];
  const visibleTypeFilters: (AgentType | 'all')[] = [
    'all',
    ...TYPE_ORDER.filter((t) => onlineAgents.some((a) => (a.agentType || 'claude') === t)),
  ];

  // Demo mode is visible at all times. A person walking past a screen showing invented
  // cartridges must be able to tell — and so must the operator, after the demo ends.
  const demoBanner = IS_DEMO ? (
    <div className="bg-amber-500/15 border-b border-amber-400/30 px-4 py-1.5 flex items-center justify-center gap-3 text-[12px] text-amber-300">
      <span aria-hidden="true">●</span>
      <span>Demo mode — showing invented data. Your real cartridges and workflows are running normally.</span>
      <button
        onClick={() => { setDemoEnabled(false); resetDemoData(); window.location.reload(); }}
        className="underline underline-offset-2 hover:text-amber-200"
      >
        Turn off
      </button>
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-400">Connecting to orchestrator...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full text-gray-100 bg-ink flex flex-col md:flex-row">
      {/* THE VIEW BAR. Night Glass moves navigation out of the top bar into a slim left bar
          (a bottom tab bar below md), Projects first, then Agents (still the default view).
          Guide and Settings are chrome, so they sit at the bar's foot. */}
      <nav
        aria-label="Views"
        className="order-last md:order-first fixed md:sticky bottom-0 md:top-0 inset-x-0 md:inset-x-auto z-30 md:h-screen md:w-[76px] flex-shrink-0 flex md:flex-col items-center justify-around md:justify-start gap-2 px-2 py-2 md:py-[18px] border-t md:border-t-0 md:border-r border-white/[0.08] bg-gray-950"
      >
        <NavItem active={activeView === 'projects'} onClick={() => setActiveView('projects')} label="Projects">
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        </NavItem>
        <NavItem active={activeView === 'agents'} onClick={() => setActiveView('agents')} label="Agents">
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
        </NavItem>
        <NavItem active={activeView === 'workflows'} onClick={() => setActiveView('workflows')} label="Flows">
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="6" height="5" rx="1.2" /><rect x="15" y="4" width="6" height="5" rx="1.2" /><rect x="9" y="15" width="6" height="5" rx="1.2" /><path d="M6 9v2.5a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V9M12 13v2" /></svg>
        </NavItem>
        <NavItem active={activeView === 'tasks'} onClick={() => setActiveView('tasks')} label="Tasks" badge={activeTaskCount}>
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>
        </NavItem>
        <NavItem active={activeView === 'tokens'} onClick={() => setActiveView('tokens')} label="Tokens">
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V10M10 19V5M16 19v-7M22 19H2" /></svg>
        </NavItem>
        <NavItem active={activeView === 'logs'} onClick={() => setActiveView('logs')} label="Logs">
          {/* A terminal window: every session's log and NeonCore's own. */}
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>
        </NavItem>
        <NavItem active={activeView === 'qa'} onClick={() => setActiveView('qa')} label="QA">
          {/* A flask with a check: testing the app. */}
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6.5L4.8 18.2A1.8 1.8 0 0 0 6.4 21h11.2a1.8 1.8 0 0 0 1.6-2.8L14 9.5V3" /><path d="M9.5 15l1.8 1.8 3.4-3.6" /></svg>
        </NavItem>
        <NavItem active={activeView === 'triage'} onClick={() => setActiveView('triage')} label="Triage">
          {/* A bug: incoming reports, worked into fixes. */}
          <svg className={ICON} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0z" /><path d="M12 10v8M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2M10 6.5L9 4M14 6.5L15 4" /></svg>
        </NavItem>
        <div className="hidden md:block flex-1" />
        <button
          onClick={() => setGuideOpen(true)}
          className="hidden md:flex w-11 h-11 rounded-xl items-center justify-center text-gray-400 hover:text-gray-100 hover:bg-white/[0.05]"
          title="How NeonCore works"
          aria-label="Guide"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" /></svg>
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="hidden md:flex w-11 h-11 rounded-xl items-center justify-center text-gray-400 hover:text-gray-100 hover:bg-white/[0.05]"
          title="Settings"
          aria-label="Settings"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.723 7.723 0 0 1 0 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
        {/* The release this dashboard is — read from the root package.json at build time. */}
        <span className="hidden md:block text-[11px] font-mono font-semibold text-gray-500 tracking-wide" title={`NeonCore ${__APP_VERSION__}`}>
          V{__APP_VERSION__.split('.').slice(0, 2).join('.')}
        </span>
      </nav>

      <div className="flex-1 min-w-0 flex flex-col pb-20 md:pb-0">
      {demoBanner}
      {/* THE TOP BAR: what you are looking at, the one number you read (burn), then the things
          you START a session with, then fleet status and the bell pinned to the far right. */}
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 px-4 md:px-6 py-3.5 border-b border-white/[0.08] bg-gray-950/85 backdrop-blur">
        <h1 className="font-display text-2xl font-semibold mr-1">{VIEW_TITLE[activeView]}</h1>
        <BurnRate servers={servers} onOpen={() => setActiveView('tokens')} />
        <div className="flex-1" />
        <MachineLauncher servers={servers} />
        <button
          onClick={() => setNewRepoOpen(true)}
          className="btn-ghost h-10 px-3.5 rounded-[10px] text-sm font-semibold transition-colors"
          title="Create a new folder, git init, push to GitHub, and start working"
        >
          + New Repo
        </button>
        <span className="hidden xl:inline text-[13px] text-gray-400">{onlineAgents.length} online</span>
        <ServerPicker statuses={serverStatuses} onSetToken={applyFleetToken} />
        <SoundButton />
        <NotificationCenter
          pendingPermissions={pendingPermissions}
          needsYou={needsYou}
          stuckAlerts={stuckAlertsArray}
          workflowNotifications={workflowNotifications}
          agents={agents}
          onDecide={decidePermission}
          onDismissStuck={dismissStuckAlert}
          onDismissWorkflow={dismissWorkflowNotification}
        />
      </header>

      {/* Work area. Every view is one column, the full width: Projects chooses its project from a
          dropdown in the bar at its top (it used to keep a list down the left side, which took
          the width the project itself needs). The Agents scene is full BLEED: no
          padding, edge to edge, from the top bar to the bottom of the window. */}
      <ProjectsProvider active={activeView === 'projects'} agents={agents} servers={servers}>
      <div
        id="work-area"
        className={`${sceneOpen ? '' : 'p-4 md:p-6'} grid grid-cols-1 gap-6 items-start ${isDeckView(activeView) ? deckProps(activeView).className : ''}`}
        style={isDeckView(activeView) ? deckProps(activeView).style : undefined}
      >
        <main className="space-y-5 min-w-0">
          {activeView === 'projects' ? (
            <>
              {/* The Projects bridge: the captain stands at the left, full size, across the picker's
                  bar and the head of the project's page — which both move over to make room for him
                  (index.css .projects-stage). Everything under the head has the full width. */}
              <div className="projects-stage" data-projects-stage>
                <div className="stage-captain"><BridgeCaptain height={236} /></div>
                <div className="bridge-panel projects-bar flex items-center gap-5 flex-wrap" data-projects-bar>
                  <ProjectPicker />
                </div>
                <div className="bridge-panel bridge-console"><ProjectsWorkspace /></div>
              </div>
              <BridgeGauges />
            </>
          ) : activeView === 'tokens' ? (
            /* The power core: the reactor and the quota tank beside the same tokens page. */
            <div className="bridge-split">
              <aside><CorePost /></aside>
              <div className="min-w-0"><div className="bridge-panel bridge-console"><TokensPage servers={servers} /></div><TokenGauges /></div>
            </div>
          ) : activeView === 'logs' ? (
            /* Logs: every session's events, background terminal output and NeonCore's own console (server lib/log-stream.ts). */
            <div className="bridge-panel bridge-console h-full"><LogsPage /></div>
          ) : activeView === 'qa' ? (
            /* QA: tests a web app with no hand-written scripts (components/qa, docs/plans/qa-section.md). */
            <QaPage agents={agents} />
          ) : activeView === 'triage' ? (
            /* Triage: every new Jira bug checked, reproduced, fixed as a PR for review (components/triage, docs/plans/bug-triage.md). */
            <TriagePage agents={agents} />
          ) : activeView === 'tasks' ? (
            /* The cargo bay: the quartermaster beside the same task queue. */
            <div className="bridge-split">
              <aside><QuartermasterPost tasks={tasks} /></aside>
              <div className="min-w-0"><div className="bridge-panel bridge-console"><TasksPage tasks={tasks} agents={agents} createTask={createTask} cancelTask={cancelTask} updateTask={updateTask} dispatchTask={dispatchTask} completeTask={completeTask} /></div><TaskGauges tasks={tasks} /></div>
            </div>
          ) : activeView === 'workflows' ? (
            /* V3: the workflow templates and runs, on their own screen. */
            /* The engine deck: the engineer beside the same workflow panel. */
            <div className="bridge-split">
              <aside><EngineerPost /></aside>
              <div className="min-w-0"><div className="bridge-panel bridge-console"><WorkflowPanel agents={agents} /></div><FlowGauges /></div>
            </div>
          ) : (() => {
            // The same controls drive both layouts, so they are built once: over the scene
            // they float as its HUD, above the list they sit in its header.
            const groupCls = `flex items-center gap-1 p-1 rounded-xl border border-white/[0.1] ${sceneOpen ? 'bg-[rgba(10,16,32,0.92)]' : 'bg-gl-surface/70'}`;
            const chipCls = (on: boolean) => `h-8 px-3 rounded-lg text-[13px] font-semibold transition-colors ${
              on ? 'bg-neon-500/20 text-neon-50 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.6)]' : 'text-gray-400 hover:text-gray-200'
            }`;
            const filters = (
              <>
                <div role="group" aria-label="Status" className={groupCls}>
                  {([
                    { key: 'all', label: 'All' },
                    { key: 'working', label: 'Working' },
                    { key: 'waiting', label: 'Waiting' },
                    { key: 'idle', label: 'Idle' },
                  ] as { key: StatusFilter; label: string }[]).map(({ key, label }) => (
                    <button key={key} onClick={() => setStatusFilter(key)} aria-pressed={statusFilter === key} className={chipCls(statusFilter === key)}>
                      {label}
                      {statusCounts[key] > 0 && <span className="ml-1 opacity-80">· {statusCounts[key]}</span>}
                    </button>
                  ))}
                </div>
                <div role="group" aria-label="Engine" className={groupCls}>
                  {visibleTypeFilters.map((t) => {
                    const LABELS: Partial<Record<AgentType | 'all', string>> = {
                      all: 'All', claude: 'Claude', codex: 'Codex',
                    };
                    return (
                      <button key={t} onClick={() => setTypeFilter(t)} aria-pressed={typeFilter === t} className={chipCls(typeFilter === t)}>
                        {LABELS[t] ?? t}
                      </button>
                    );
                  })}
                </div>
                <div role="group" aria-label="Layout" className={`${groupCls} ${sceneOpen ? 'ml-auto' : ''}`}>
                  {AGENTS_LAYOUTS.map((l) => (
                    <button key={l} onClick={() => setAgentsLayout(l)} aria-pressed={agentsLayout === l} className={chipCls(agentsLayout === l)}>
                      {l === 'scene' ? 'Scene' : 'List'}
                    </button>
                  ))}
                </div>
              </>
            );
            return sceneOpen ? (
              <WorldScene
                agents={filteredAgents}
                statusFilter={statusFilter}
                onStatusCounts={handleStatusCounts}
                activitiesByAgent={activitiesByAgent}
                pendingPermissions={pendingPermissions}
                stuckAlerts={stuckAlertsArray}
                onDecidePermission={decidePermission}
                onSetMode={setMode}
                onSendCommand={sendCommand}
                onDelete={deleteAgent}
                onDismiss={dismissAgent}
                onRestore={restoreAgent}
                onDismissStuck={dismissStuckAlert}
                onActivityClick={setSelectedActivity}
                hud={filters}
                offSceneCount={filteredAgents.filter((a) => a.dismissedAt).length + virtualCartridges.length}
                onOpenList={() => setAgentsLayout('list')}
              />
            ) : (
            <section>
              <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                <h2 className="font-display text-xl font-semibold text-gray-100">Cartridges</h2>
                <div className="flex items-center gap-2.5 flex-wrap">{filters}</div>
              </div>
            <CartridgeGrid
              agents={filteredAgents}
              statusFilter={statusFilter}
              onStatusCounts={handleStatusCounts}
              activitiesByAgent={activitiesByAgent}
              pendingPermissions={pendingPermissions}
              stuckAlerts={stuckAlertsArray}
              onDecidePermission={decidePermission}
              onSetMode={setMode}
              onSendCommand={sendCommand}
              onDelete={deleteAgent}
              onDismiss={dismissAgent}
              onRestore={restoreAgent}
              onDismissStuck={dismissStuckAlert}
              onActivityClick={setSelectedActivity}
              virtualCartridges={virtualCartridges}
              onVirtualCartridgeUpdate={handleVirtualCartridgeUpdated}
              onVirtualCartridgeDelete={(id) => {
                api.deleteVirtualCartridge(id).then(() => {
                  setVirtualCartridges((prev) => prev.filter((c) => c.id !== id));
                }).catch(() => {});
              }}
            />
            </section>
            );
          })()}
        </main>
      </div>
      </ProjectsProvider>
      </div>

      {/* A feature marked done: fireworks (lib/celebrate.ts). */}
      <Fireworks />

      {/* Guide Modal */}
      {guideOpen && (
        <GuideModal onClose={() => setGuideOpen(false)} />
      )}

      {/* New Repo Modal */}
      {newRepoOpen && (
        <NewRepoModal onClose={() => setNewRepoOpen(false)} />
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}


      {/* Activity Detail Modal */}
      {selectedActivity && (
        <ActivityDetailModal
          activity={selectedActivity}
          agent={agents.find((a) => a.id === selectedActivity.agentId)}
          agents={agents}
          onClose={() => setSelectedActivity(null)}
        />
      )}
    </div>
  );
}
