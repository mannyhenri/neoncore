import { useState, useRef, useEffect } from 'react';
import { useAgents } from './hooks/useAgents';
import { AgentGrid } from './components/AgentGrid';
import { ActivityFeed } from './components/ActivityFeed';
import { CommandBar } from './components/CommandBar';
import { NotesModal } from './components/NotesModal';
import type { Agent } from './types';

export default function App() {
  const {
    agents,
    activities,
    pendingPermissions,
    loading,
    connected,
    stuckAlerts,
    decidePermission,
    setMode,
    sendCommand,
    deleteAgent,
    dismissStuckAlert,
  } = useAgents();

  const [notesAgent, setNotesAgent] = useState<Agent | null>(null);
  const [notesPickerOpen, setNotesPickerOpen] = useState(false);
  const notesPickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!notesPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (notesPickerRef.current && !notesPickerRef.current.contains(e.target as Node)) {
        setNotesPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [notesPickerOpen]);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

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
      <header className="glass-light px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="Gridlight" className="w-8 h-8" />
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-gl-blue">Neon</span>
              <span className="text-gl-pink">Core</span>
            </h1>
            <span className="text-[10px] text-gray-500 border border-white/10 px-2 py-0.5 rounded-full uppercase tracking-wider">
              Orchestrator
            </span>
          </div>
          <div className="flex items-center gap-4 text-base">
            {/* Notes button */}
            <div className="relative" ref={notesPickerRef}>
              <button
                onClick={() => setNotesPickerOpen(!notesPickerOpen)}
                className="text-sm text-gray-400 hover:text-white border border-white/10 hover:border-white/20 px-2.5 py-1 rounded-md transition-colors"
              >
                Notes
              </button>
              {notesPickerOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-50 glass rounded-xl shadow-2xl py-1.5 min-w-[200px]">
                  {onlineAgents.length === 0 ? (
                    <div className="text-xs text-gray-500 px-3 py-2">No online agents</div>
                  ) : (
                    onlineAgents.map((agent) => (
                      <button
                        key={agent.id}
                        onClick={() => {
                          setNotesAgent(agent);
                          setNotesPickerOpen(false);
                        }}
                        className="w-full text-left text-xs text-gray-300 hover:bg-white/5 hover:text-white px-3 py-1.5 transition-colors"
                      >
                        {agent.repoName || agent.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <span className="text-sm text-gray-500">
              {agents.length} agent{agents.length !== 1 ? 's' : ''}
            </span>
            {pendingPermissions.length > 0 && (
              <span className="bg-gl-pink/20 text-gl-pink px-2 py-0.5 rounded-full text-xs font-medium animate-pulse">
                {pendingPermissions.length} pending
              </span>
            )}
            <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-[#00ff88] gl-glow-online' : 'bg-red-400 animate-pulse'}`} />
              {connected ? 'Live' : 'Polling'}
            </span>
          </div>
        </div>
      </header>

      {/* Command Bar */}
      <CommandBar agents={agents} onSendCommand={sendCommand} />

      {/* Main content */}
      <main className="p-6 space-y-6">
        {/* Agent Grid */}
        <section>
          <h2 className="text-gray-400 text-base font-semibold uppercase tracking-wide mb-4">
            Agents
          </h2>
          <AgentGrid
            agents={agents}
            pendingPermissions={pendingPermissions}
            stuckAlerts={stuckAlerts}
            onDecidePermission={decidePermission}
            onSetMode={setMode}
            onSendCommand={sendCommand}
            onDelete={deleteAgent}
            onDismissStuck={dismissStuckAlert}
          />
        </section>

        {/* Activity Feed */}
        <section>
          <ActivityFeed activities={activities} agents={agents} />
        </section>
      </main>

      {/* Notes Modal */}
      {notesAgent && (
        <NotesModal agent={notesAgent} onClose={() => setNotesAgent(null)} />
      )}
    </div>
  );
}
