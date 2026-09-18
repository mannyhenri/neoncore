import { useState, useEffect, useCallback } from 'react';
import { useAgents } from './hooks/useAgents';
import { CartridgeGrid } from './components/CartridgeGrid';
import type { StatusFilter } from './components/CartridgeGrid';
import { ActivityDetailModal } from './components/ActivityDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { MachineLauncher } from './components/MachineLauncher';
import { NewRepoModal } from './components/NewRepoModal';
import { WorkflowPanel } from './components/WorkflowPanel';
import { NotificationCenter } from './components/NotificationCenter';
import { GoalsProvider, GoalsRail, GoalsWorkspace } from './components/GoalsPage';
import { parseGoalHash } from './lib/goalSelection';
import { TasksPage } from './components/TasksPage';
import { GuideModal } from './components/GuideModal';
import { ServerPicker } from './components/ServerPicker';
import { BurnRate } from './components/BurnRate';
import { TokensPage } from './components/TokensPage';
import { api } from './lib/api';
import type { AgentType, Activity, VirtualCartridge } from './types';

export default function App() {
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
    addServer,
    forgetServer,
    hideServer,
    applyFleetToken,
  } = useAgents(handleVirtualCartridgeUpdated);

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
  /* Agents is the default. A goal deep link overrides it, because addressing a goal without
     addressing the view that renders it is only half a link: `#goal/<id>` in a fresh tab
     otherwise opens Agents with the goal selected in a pane nobody is showing. */
  const [activeView, setActiveView] = useState<'agents' | 'goals' | 'tasks' | 'tokens'>(
    () => (typeof window !== 'undefined' && parseGoalHash(window.location.hash) ? 'goals' : 'agents'),
  );

  // The same link, followed while the app is already open, arrives as hashchange instead of
  // a load — so the view has to move here too, or a notification click silently does nothing.
  useEffect(() => {
    const onHash = () => {
      if (parseGoalHash(window.location.hash)) setActiveView('goals');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [newRepoOpen, setNewRepoOpen] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');
  const activeTaskCount = tasks.filter((t) => t.status === 'queued' || t.status === 'claimed' || t.status === 'in_progress').length;

  const filteredAgents = typeFilter === 'all' ? agents : agents.filter((a) => a.agentType === typeFilter);

  // Gridlight always shown; other types only when at least one online agent uses them
  const TYPE_ORDER: AgentType[] = ['gridlight', 'claude', 'codex'];
  const visibleTypeFilters: (AgentType | 'all')[] = [
    'all',
    ...TYPE_ORDER.filter((t) =>
      t === 'gridlight' || onlineAgents.some((a) => (a.agentType || 'claude') === t)
    ),
  ];

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-400">Connecting to orchestrator...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full text-white">
      {/* Header */}
      <header className="glass-light px-3 py-3 md:px-6 md:py-4 border-b border-white/[0.06] relative z-20">
        {/* THREE TRACKS, so the regions cannot collide.
            History, because this bar has now been fixed twice for the same symptom. The switcher
            was originally `md:absolute left-1/2 -translate-x-1/2` — out of flow, so nothing
            reserved space for it, and the in-flow right cluster grew leftward over it every time
            its width changed: "+ Launch bleeds into the 3 sections on and off". A grid fixed the
            overlap by giving each region its own column.
            `1fr auto 1fr` then CENTRED the switcher on the bar. That was fine until Confer joined
            the right cluster and widened it enough to close the gap again — the columns still did
            not overlap, but they touched, which reads as the same bug. Centring is what made the
            gap depend on the cluster's width at all.
            `1fr auto auto` ends it: the identity track absorbs all free space, so the switcher and
            the cluster sit together at the right edge, separated by the cluster's own `md:pl-8`.
            The spacing is now a constant instead of a residue, so no control added to the right
            can ever squeeze it. */}
        <div className="flex flex-wrap items-center justify-between gap-2 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-0 md:justify-normal">
          <div className="flex items-center gap-2 md:gap-3">
            <img src="/logo.png" alt="Gridlight" className="w-7 h-7 md:w-8 md:h-8" />
            <h1 className="font-pixel text-xs md:text-sm tracking-wide" style={{ imageRendering: 'pixelated' }}>
              <span className="text-gl-blue">Neon</span>
              <span className="text-gl-pink">Core</span>
            </h1>
            <span className="hidden sm:inline text-sm text-gray-500 border border-white/10 px-2.5 py-1 rounded-full uppercase tracking-wider">
              Orchestrator
            </span>
            {/* Asked for: the fleet burn rate reads first, right after the label. */}
            <BurnRate servers={servers} onOpen={() => setActiveView('tokens')} />
          </div>
          {/* The middle track, right-aligned against the chrome cluster rather than centred on
              the bar — asked for after Confer widened the cluster enough to touch it.
              Reading order is Goals → Agents → Tasks; Agents is where the dashboard opens. */}
            <div className="flex md:justify-self-end rounded-md overflow-hidden border border-white/10 w-fit">
              <button
                onClick={() => setActiveView('goals')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${activeView === 'goals' ? 'bg-violet-900/60 text-violet-300' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
              >
                Goals
              </button>
              <button
                onClick={() => setActiveView('agents')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${activeView === 'agents' ? 'bg-white/10 text-gray-200' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
              >
                Agents
              </button>
              <button
                onClick={() => setActiveView('tasks')}
                className={`px-3 py-1 text-xs font-medium transition-colors flex items-center gap-1.5 ${activeView === 'tasks' ? 'bg-violet-900/60 text-violet-300' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
              >
                Tasks
                {activeTaskCount > 0 && (
                  <span className="text-[10px] px-1.5 rounded-full bg-violet-500/30 text-violet-200">{activeTaskCount}</span>
                )}
              </button>
              <button
                onClick={() => setActiveView('tokens')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${activeView === 'tokens' ? 'bg-violet-900/60 text-violet-300' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
              >
                Tokens
              </button>
            </div>

          {/* The right edge of the bar, left to right: the two things you START a session
              with sit closest to the view switcher, then chrome, then status pinned to the
              far right where a glance goes for "is anything wrong" — bell last. */}
          <div className="flex items-center gap-2 md:gap-4 text-base ml-auto md:ml-0 md:pl-8 md:justify-self-end justify-end whitespace-nowrap">
            {/* Confer used to be a button here. It is a WORKFLOW TEMPLATE now ("Confer"), which
                is what it always was: cartridges working one task together. As a header button
                it was the only way of starting work with no run history, no project, no report
                and no place on the canvas — every one of which it gets for free as a template. */}
            {/* Launch a cartridge on any registered machine (local or remote) */}
            <MachineLauncher servers={servers} />
            {/* New repo — create a folder, git init, push to GitHub, launch an agent */}
            <button
              onClick={() => setNewRepoOpen(true)}
              className="text-sm text-gray-400 hover:text-gl-purple border border-white/10 hover:border-gl-purple/40 px-2.5 py-1 rounded-md transition-colors"
              title="Create a new folder, git init, push to GitHub, and start working"
            >
              + New Repo
            </button>
            {/* Settings gear */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-sm text-gray-400 hover:text-white border border-white/10 hover:border-white/25 px-2.5 py-1 rounded-md transition-colors flex items-center justify-center gap-1.5"
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.723 7.723 0 0 1 0 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
              Settings
            </button>
            {/* Guide button */}
            <button
              onClick={() => setGuideOpen(true)}
              className="text-sm text-gray-400 hover:text-violet-300 border border-white/10 hover:border-violet-500/40 px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5"
              title="How NeonCore works"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
              </svg>
              Guide
            </button>
            <span className="hidden lg:inline text-sm text-gray-500">
              {onlineAgents.length} online
            </span>
            <ServerPicker
              servers={servers}
              statuses={serverStatuses}
              onAdd={addServer}
              onForget={forgetServer}
              onHide={hideServer}
              onSetToken={applyFleetToken}
            />
            {/* Notification center — bell with dropdown */}
            <NotificationCenter
              pendingPermissions={pendingPermissions}
              stuckAlerts={stuckAlertsArray}
              workflowNotifications={workflowNotifications}
              agents={agents}
              onDecide={decidePermission}
              onDismissStuck={dismissStuckAlert}
              onDismissWorkflow={dismissWorkflowNotification}
            />
          </div>
        </div>
      </header>

      {/* Main content — a persistent command rail on the left, work on the right.
          Everything you ACT with lives in the rail and stays put while the cartridges
          scroll, so starting a confer no longer means scrolling back up to find the
          button. The rail is sticky and scrolls independently; below lg it stacks
          back to one column, where a sidebar would just be a header you scroll past. */}
      {/* The rail's contents are per-view, and the two never stack: Workflows on Agents,
          the goals list on Goals. GoalsProvider wraps the whole grid because its two
          surfaces land in different regions of it — see GoalsPage.tsx. It stays mounted
          across view switches and fetches only when Goals is active, so changing views
          neither refetches the hierarchy nor remounts the cartridge tree beside it. */}
      <GoalsProvider active={activeView === 'goals'} agents={agents}>
      <div className="p-3 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6 items-start">
        {/* `lg:pr-4`, not `pr-1`. The rail scrolls itself, so its scrollbar is drawn INSIDE this
            box — at 4px the template cards ran flush against it. The gutter is declared here and
            nowhere else: padding the workflow panel instead would fix the Agents view and leave
            the Goals rail a different width, so the rail edge would jump between views. */}
        <aside className="lg:col-span-1 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:pr-4 space-y-4 md:space-y-6">
          {/* Workflows live in the rail: they are something you START, not something
              you read alongside the cartridges. */}
          {activeView === 'agents' && (
            <section>
              <WorkflowPanel agents={agents} />
            </section>
          )}
          {/* Asked for: "the list of goals on the 1/3 section with the 2/3 the place where
              we work". The aside scrolls independently, so a long list of goals never
              pushes the working surface beside it down the page. */}
          {activeView === 'goals' && <GoalsRail />}
        </aside>

        <main className={`${activeView === 'tokens' ? 'lg:col-span-3' : 'lg:col-span-2'} space-y-4 md:space-y-6 min-w-0`}>
          {activeView === 'goals' ? (
            <GoalsWorkspace />
          ) : activeView === 'tokens' ? (
            /* Token reporting: burn over time, so a change in approach can be read off what
               it cost. Full width — it has no rail. */
            <TokensPage servers={servers} />
          ) : activeView === 'tasks' ? (
            /* ONE place for everything a cartridge will work through. "What is queued" and
               "what is running" are the same question, and splitting them across two tabs
               made the user ask why there were two Tasks sections — they were right. */
              <TasksPage tasks={tasks} agents={agents} createTask={createTask} cancelTask={cancelTask} updateTask={updateTask} dispatchTask={dispatchTask} completeTask={completeTask} />
          ) : (
            <section>
              {/* The type filter belongs WITH the cartridges it filters: it answers
                  "which of these am I looking at", which is a question you ask of the
                  grid, not a command you issue from the rail. */}
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3 md:mb-4">
                <h2 className="text-gray-400 text-sm md:text-base font-semibold uppercase tracking-wide">
                  Cartridges
                </h2>
                {/* Both filters together, so the row reads: title | how you are
                    slicing it. */}
                <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  {([
                    { key: 'all', label: 'All' },
                    { key: 'working', label: 'Working' },
                    { key: 'waiting', label: 'Waiting' },
                    { key: 'idle', label: 'Idle' },
                  ] as { key: StatusFilter; label: string }[]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setStatusFilter(key)}
                      className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium ${
                        statusFilter === key
                          ? 'bg-gl-purple/20 text-gl-purple border border-gl-purple/40'
                          : 'bg-white/[0.04] text-gray-400 border border-white/[0.06] hover:bg-white/[0.08] hover:text-gray-300'
                      }`}
                    >
                      {label}
                      {statusCounts[key] > 0 && (
                        <span className={`ml-1.5 text-[13px] px-1.5 py-0.5 rounded-full ${
                          statusFilter === key ? 'bg-gl-purple/30 text-gl-purple' : 'bg-white/[0.06] text-gray-500'
                        }`}>
                          {statusCounts[key]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="flex rounded-lg overflow-hidden border border-white/10">
                  {visibleTypeFilters.map((t) => {
                    const ACTIVE_COLORS: Partial<Record<AgentType | 'all', string>> = {
                      all:      'bg-white/10 text-gray-200',
                      gridlight:'bg-pink-900/60 text-pink-300',
                      claude:   'bg-blue-900/60 text-blue-300',
                      codex:    'bg-green-900/60 text-green-300',
                    };
                    const LABELS: Partial<Record<AgentType | 'all', string>> = {
                      all: 'All', gridlight: 'Gridlight', claude: 'Claude', codex: 'Codex',
                    };
                    return (
                      <button
                        key={t}
                        onClick={() => setTypeFilter(t)}
                        className={`px-3 py-1 text-xs font-medium transition-colors ${
                          typeFilter === t
                            ? (ACTIVE_COLORS[t] ?? 'bg-white/10 text-gray-200')
                            : 'bg-white/[0.04] text-gray-500 hover:text-gray-300 hover:bg-white/[0.08]'
                        }`}
                      >
                        {LABELS[t] ?? t}
                      </button>
                    );
                  })}
                </div>
                </div>
              </div>
            {/* The heading row owns the status SELECTION; the grid owns the derivation
                — dedup, dismissal and virtual cartridges all decide who is counted, and
                duplicating that here is how the chip counts would drift from the cards
                under them. Without these two props the control renders but changes
                nothing and its chips stay at zero: a switch wired to nothing. */}
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
          )}
        </main>
      </div>
      </GoalsProvider>

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
