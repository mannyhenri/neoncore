import type { Agent, AgentMode, PermissionRequest } from '../types';
import { AgentCard } from './AgentCard';

interface Props {
  agents: Agent[];
  pendingPermissions: PermissionRequest[];
  onDecidePermission: (id: string, decision: 'allowed' | 'denied') => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string) => void;
  onDelete: (agentId: string) => void;
}

export function AgentGrid({ agents, pendingPermissions, onDecidePermission, onSetMode, onSendCommand, onDelete }: Props) {
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-gray-500">
        <div className="text-5xl mb-4">~</div>
        <h3 className="text-lg font-medium text-gray-400 mb-2">No agents connected</h3>
        <p className="text-sm text-center max-w-md">
          Install the NeonCore hooks on your machines to connect Claude Code agents.
          <br />
          Run <code className="text-neon-400 bg-gray-800 px-1.5 py-0.5 rounded">./agent/install.sh</code> to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          permissions={pendingPermissions.filter((p) => p.agentId === agent.id)}
          onDecidePermission={onDecidePermission}
          onSetMode={onSetMode}
          onSendCommand={onSendCommand}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
