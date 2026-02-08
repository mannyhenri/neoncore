import type { Agent, AgentMode, PermissionRequest } from '../types';
import { AgentModeSelector } from './AgentModeSelector';
import { CommandInput } from './CommandInput';

interface Props {
  agent: Agent;
  permissions: PermissionRequest[];
  onDecidePermission: (id: string, decision: 'allowed' | 'denied') => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string) => void;
  onDelete: (agentId: string) => void;
}

const STATUS_CONFIG = {
  working: { color: 'bg-green-500', pulse: true, label: 'Working' },
  idle: { color: 'bg-gray-500', pulse: false, label: 'Idle' },
  waiting: { color: 'bg-yellow-500', pulse: true, label: 'Waiting' },
  offline: { color: 'bg-red-500', pulse: false, label: 'Offline' },
} as const;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function shortMachine(machine: string): string {
  return machine.replace(/\.local$/, '');
}

function InlinePermission({ permission, onAllow, onDeny }: {
  permission: PermissionRequest;
  onAllow: () => void;
  onDeny: () => void;
}) {
  // Plan approval card for ExitPlanMode
  if (permission.toolName === 'ExitPlanMode') {
    let allowedPrompts: { tool: string; prompt: string }[] = [];
    try {
      const input = typeof permission.toolInput === 'string' ? JSON.parse(permission.toolInput) : permission.toolInput;
      allowedPrompts = input?.allowedPrompts || [];
    } catch {
      // ignore parse errors
    }

    return (
      <div className="bg-violet-950/40 border border-violet-700 rounded-lg px-3 py-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-violet-300 text-xs font-semibold">Plan Ready for Review</span>
        </div>
        {allowedPrompts.length > 0 && (
          <div className="mb-2 space-y-1">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">Requested permissions:</span>
            {allowedPrompts.map((p, i) => (
              <div key={i} className="text-xs text-gray-400 font-mono pl-2 border-l border-violet-800">
                {p.tool}: {p.prompt}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onAllow}
            className="px-2.5 py-1 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-xs rounded-md transition-colors font-medium"
          >
            Approve Plan
          </button>
          <button
            onClick={onDeny}
            className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded-md transition-colors font-medium"
          >
            Reject Plan
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 gap-2">
      <div className="flex-1 min-w-0">
        <span className="text-yellow-400 text-xs font-mono">{permission.toolName}</span>
        <p className="text-gray-400 text-xs font-mono truncate" title={permission.description}>
          {permission.description}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onAllow}
          className="px-2.5 py-1 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-xs rounded-md transition-colors font-medium"
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className="px-2.5 py-1 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-xs rounded-md transition-colors font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export function AgentCard({ agent, permissions, onDecidePermission, onSetMode, onSendCommand, onDelete }: Props) {
  const status = STATUS_CONFIG[agent.status];

  return (
    <div className={`bg-gray-900 border rounded-xl p-5 md:p-6 transition-colors min-h-[14rem] flex flex-col ${
      agent.status === 'waiting' ? 'border-yellow-800' :
      agent.status === 'working' ? 'border-gray-800 hover:border-gray-700' :
      'border-gray-800 hover:border-gray-700'
    }`}>
      {/* Header: repo name is the title */}
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="relative">
            <div className={`w-3 h-3 rounded-full ${status.color}`} />
            {status.pulse && (
              <div className={`absolute inset-0 w-3 h-3 rounded-full ${status.color} animate-ping opacity-75`} />
            )}
          </div>
          <h3 className="text-neon-400 font-bold text-lg font-mono">{agent.repoName || 'unknown'}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            agent.status === 'working' ? 'bg-green-900/50 text-green-400' :
            agent.status === 'waiting' ? 'bg-yellow-900/50 text-yellow-400' :
            agent.status === 'idle' ? 'bg-gray-800 text-gray-400' :
            'bg-red-900/50 text-red-400'
          }`}>
            {status.label}
          </span>
          <button
            onClick={() => onDelete(agent.id)}
            className="text-gray-600 hover:text-red-400 transition-colors text-sm"
            title="Remove agent"
          >
            x
          </button>
        </div>
      </div>

      {/* Machine + branch subtitle */}
      <div className="text-xs text-gray-500 mb-3 ml-5">
        {shortMachine(agent.machine)}
        {agent.branch && <span className="text-gray-600"> / {agent.branch}</span>}
        <span className="text-gray-700 ml-2">{timeAgo(agent.lastSeen)}</span>
      </div>

      {/* Inline permission requests */}
      {permissions.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-1.5 text-xs text-yellow-400">
            <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
            Pending ({permissions.length})
          </div>
          {permissions.map((perm) => (
            <InlinePermission
              key={perm.id}
              permission={perm}
              onAllow={() => onDecidePermission(perm.id, 'allowed')}
              onDeny={() => onDecidePermission(perm.id, 'denied')}
            />
          ))}
        </div>
      )}

      {/* Input area - always visible; offline commands queue until agent reconnects */}
      <div className="mb-3 flex-1 flex flex-col">
        <CommandInput
          agentId={agent.id}
          placeholder={agent.status === 'waiting'
            ? 'Answer the question or give instructions...'
            : agent.status === 'offline'
            ? 'Agent offline — command will queue until reconnect...'
            : 'Send prompt, instructions, or /command...'}
          onSend={(text) => onSendCommand(agent.id, text)}
        />
      </div>

      {/* Footer: mode selector */}
      <div className="flex items-center justify-between mt-auto pt-2">
        <AgentModeSelector mode={agent.mode} onSetMode={(mode) => onSetMode(agent.id, mode)} />
      </div>
    </div>
  );
}
