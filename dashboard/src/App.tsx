import { useAgents } from './hooks/useAgents';
import { AgentGrid } from './components/AgentGrid';
import { ActivityFeed } from './components/ActivityFeed';
import { CommandBar } from './components/CommandBar';

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

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-500">Connecting to orchestrator...</div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-neon-500" />
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-neon-400">Neon</span>
              <span className="text-gray-300">Core</span>
            </h1>
            <span className="text-xs text-gray-600 border border-gray-800 px-2 py-0.5 rounded">
              Orchestrator
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-500">
              {agents.length} agent{agents.length !== 1 ? 's' : ''}
            </span>
            {pendingPermissions.length > 0 && (
              <span className="bg-yellow-900/50 text-yellow-400 px-2 py-0.5 rounded-full text-xs font-medium animate-pulse">
                {pendingPermissions.length} pending
              </span>
            )}
            <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-green-500' : 'text-red-400'}`}>
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-400 animate-pulse'}`} />
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
          <h2 className="text-gray-400 text-sm font-semibold uppercase tracking-wide mb-4">
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
    </div>
  );
}
