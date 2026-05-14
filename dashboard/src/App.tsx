import { useState, useEffect, useCallback } from 'react';
import { useAgents } from './hooks/useAgents';
import { CartridgeGrid } from './components/CartridgeGrid';
import { ActivityDetailModal } from './components/ActivityDetailModal';
import { SettingsModal } from './components/SettingsModal';
import { RepoPicker } from './components/RepoPicker';
import { WorkflowPanel } from './components/WorkflowPanel';
import { NotificationCenter } from './components/NotificationCenter';
import { GoalsPage } from './components/GoalsPage';
import { GuideModal } from './components/GuideModal';
import { api } from './lib/api';
import type { Agent, AgentType, Activity, VirtualCartridge, McpServer } from './types';

export default function App() {
  // Virtual cartridges & MCP servers
  const [virtualCartridges, setVirtualCartridges] = useState<VirtualCartridge[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);

  const refreshVirtualCartridges = useCallback(() => {
    api.getVirtualCartridges().then(setVirtualCartridges).catch(() => {});
  }, []);

  useEffect(() => {
    refreshVirtualCartridges();
    api.getMcpServers().then(setMcpServers).catch(() => {});
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
    connected,
    stuckAlertsArray,
    workflowNotifications,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
    dismissStuckAlert,
    dismissWorkflowNotification,
  } = useAgents(handleVirtualCartridgeUpdated);

  const [typeFilter, setTypeFilter] = useState<AgentType | 'all'>('all');
  const [activeView, setActiveView] = useState<'agents' | 'goals'>('agents');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  const filteredAgents = typeFilter === 'all' ? agents : agents.filter((a) => a.agentType === typeFilter);

  // Gridlight always shown; other types only when at least one online agent uses them
  const TYPE_ORDER: AgentType[] = ['gridlight', 'claude', 'gemini', 'amazonq', 'codex', 'cursor'];
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
        <div className="flex items-center justify-between flex-wrap gap-2 md:gap-0">
          <div className="flex items-center gap-2 md:gap-3">
            <img src="/logo.png" alt="Gridlight" className="w-7 h-7 md:w-8 md:h-8" />
            <h1 className="font-pixel text-xs md:text-sm tracking-wide" style={{ imageRendering: 'pixelated' }}>
              <span className="text-gl-blue">Neon</span>
              <span className="text-gl-pink">Core</span>
            </h1>
            <span className="hidden sm:inline text-[13px] text-gray-500 border border-white/10 px-2 py-0.5 rounded-full uppercase tracking-wider">
              Orchestrator
            </span>
          </div>
          <div className="flex items-center gap-2 md:gap-4 text-base">
            {/* View switcher */}
            <div className="flex rounded-md overflow-hidden border border-white/10">
              <button
                onClick={() => setActiveView('agents')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${activeView === 'agents' ? 'bg-white/10 text-gray-200' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
              >
                Agents
              </button>
              <button
                onClick={() => setActiveView('goals')}
                className={`px-3 py-1 text-xs font-medium transition-colors ${activeView === 'goals' ? 'bg-violet-900/60 text-violet-300' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300'}`}
              >
                Goals
              </button>
            </div>
            {/* Repo Picker */}
            <RepoPicker />
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
            {/* Settings gear */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-gray-400 hover:text-white transition-colors p-1"
              title="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a7.723 7.723 0 0 1 0 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            </button>
            <span className="text-sm text-gray-500">
              {onlineAgents.length} online
            </span>
            <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-[#00ff88] gl-glow-online' : 'bg-red-400 animate-pulse'}`} />
              {connected ? 'Live' : 'Polling'}
            </span>
          </div>
        </div>
      </header>


      {/* Main content */}
      <main className="p-3 md:p-6 space-y-4 md:space-y-6">
        {activeView === 'goals' ? (
          <GoalsPage />
        ) : (
        <>
        {/* Workflow Panel */}
        <section>
          <WorkflowPanel agents={agents} />
        </section>

        {/* Cartridge Grid (replaces Agent Grid + global Activity Feed) */}
        <section>
          <div className="flex items-center gap-3 md:gap-4 mb-3 md:mb-4">
            <h2 className="text-gray-400 text-sm md:text-base font-semibold uppercase tracking-wide">
              Cartridges
            </h2>
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              {visibleTypeFilters.map((t) => {
                const ACTIVE_COLORS: Partial<Record<AgentType | 'all', string>> = {
                  all:      'bg-white/10 text-gray-200',
                  gridlight:'bg-pink-900/60 text-pink-300',
                  claude:   'bg-blue-900/60 text-blue-300',
                  gemini:   'bg-teal-900/60 text-teal-300',
                  amazonq:  'bg-orange-900/60 text-orange-300',
                  codex:    'bg-green-900/60 text-green-300',
                  cursor:   'bg-violet-900/60 text-violet-300',
                };
                const LABELS: Partial<Record<AgentType | 'all', string>> = {
                  all: 'All', gridlight: 'Gridlight', claude: 'Claude',
                  gemini: 'Gemini', amazonq: 'Amazon Q', codex: 'Codex', cursor: 'Cursor',
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
          <CartridgeGrid
            agents={filteredAgents}
            activitiesByAgent={activitiesByAgent}
            pendingPermissions={pendingPermissions}
            stuckAlerts={stuckAlertsArray}
            onDecidePermission={decidePermission}
            onSetMode={setMode}
            onSendCommand={sendCommand}
            onDelete={deleteAgent}
            onDismissStuck={dismissStuckAlert}
            onActivityClick={setSelectedActivity}
            virtualCartridges={virtualCartridges}
            mcpServers={mcpServers}
            onVirtualCartridgeUpdate={handleVirtualCartridgeUpdated}
            onVirtualCartridgeDelete={(id) => {
              api.deleteVirtualCartridge(id).then(() => {
                setVirtualCartridges((prev) => prev.filter((c) => c.id !== id));
              }).catch(() => {});
            }}
          />
        </section>
        </>
        )}
      </main>

      {/* Guide Modal */}
      {guideOpen && (
        <GuideModal onClose={() => setGuideOpen(false)} />
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
