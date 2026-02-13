import { useState, useEffect, useCallback } from 'react';
import type { Agent, AgentMode, AgentMemory, PermissionRequest, StuckAlert } from '../types';
import { AgentModeSelector } from './AgentModeSelector';
import { CommandInput } from './CommandInput';
import { GitPanel } from './GitPanel';
import { api } from '../lib/api';

interface Props {
  agent: Agent;
  permissions: PermissionRequest[];
  stuckAlert?: StuckAlert;
  onDecidePermission: (id: string, decision: 'allowed' | 'denied') => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean) => void;
  onDelete: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
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
          <span className="text-violet-300 text-sm font-semibold">Plan Ready for Review</span>
        </div>
        {allowedPrompts.length > 0 && (
          <div className="mb-2 space-y-1">
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">Requested permissions:</span>
            {allowedPrompts.map((p, i) => (
              <div key={i} className="text-sm text-gray-400 font-mono pl-2 border-l border-violet-800">
                {p.tool}: {p.prompt}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onAllow}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-sm rounded-md transition-colors font-medium"
          >
            Approve Plan
          </button>
          <button
            onClick={onDeny}
            className="px-3 py-1.5 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-sm rounded-md transition-colors font-medium"
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
        <span className="text-yellow-400 text-sm font-mono">{permission.toolName}</span>
        <p className="text-gray-400 text-sm font-mono truncate" title={permission.description}>
          {permission.description}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onAllow}
          className="px-3 py-1.5 bg-green-700 hover:bg-green-600 active:bg-green-500 text-white text-sm rounded-md transition-colors font-medium"
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className="px-3 py-1.5 bg-red-800 hover:bg-red-700 active:bg-red-600 text-white text-sm rounded-md transition-colors font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  common_error: 'bg-red-900/50 text-red-400',
  failed_approach: 'bg-orange-900/50 text-orange-400',
  file_impact: 'bg-blue-900/50 text-blue-400',
  working_pattern: 'bg-green-900/50 text-green-400',
  dependency_quirk: 'bg-yellow-900/50 text-yellow-400',
  test_setup: 'bg-cyan-900/50 text-cyan-400',
  build_deploy: 'bg-purple-900/50 text-purple-400',
  architecture: 'bg-indigo-900/50 text-indigo-400',
};

const CATEGORY_OPTIONS = [
  'common_error', 'failed_approach', 'working_pattern', 'file_impact',
  'dependency_quirk', 'test_setup', 'build_deploy', 'architecture',
];

function categoryBadge(category: string) {
  const cls = CATEGORY_COLORS[category] || 'bg-gray-800 text-gray-400';
  return `text-[10px] px-1.5 py-0.5 rounded ${cls}`;
}

export function AgentCard({ agent, permissions, stuckAlert, onDecidePermission, onSetMode, onSendCommand, onDelete, onDismissStuck }: Props) {
  const status = STATUS_CONFIG[agent.status];
  const [gitOpen, setGitOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [addingMemory, setAddingMemory] = useState(false);
  const [newCategory, setNewCategory] = useState('common_error');
  const [newContent, setNewContent] = useState('');
  const [useMemory, setUseMemory] = useState(false);

  const loadMemories = useCallback(() => {
    api.getMemory(agent.id).then(setMemories).catch(() => {});
  }, [agent.id]);

  useEffect(() => {
    if (memoryOpen) loadMemories();
  }, [memoryOpen, loadMemories]);

  // Listen for memory_updated refresh (parent triggers re-render via socket)
  useEffect(() => {
    if (memoryOpen) loadMemories();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.lastSeen]);

  const handleAddMemory = () => {
    if (!newContent.trim()) return;
    api.addMemory(agent.id, { category: newCategory, content: newContent.trim() })
      .then(() => { setNewContent(''); setAddingMemory(false); loadMemories(); })
      .catch(() => {});
  };

  const handleToggleMemory = (memoryId: string) => {
    api.toggleMemory(agent.id, memoryId)
      .then((updated) => {
        setMemories((prev) => prev.map((m) => m.id === updated.id ? updated : m));
      })
      .catch(() => {});
  };

  const handleDeleteMemory = (memoryId: string) => {
    api.deleteMemory(agent.id, memoryId)
      .then(loadMemories)
      .catch(() => {});
  };

  const borderExtra = stuckAlert
    ? 'border-amber-700'
    : agent.status === 'waiting' ? 'border-yellow-800/60'
    : '';

  return (
    <div className={`glass rounded-xl md:rounded-2xl p-4 md:p-5 lg:p-6 transition-colors flex flex-col ${borderExtra}`}>
      {/* Header: repo name is the title */}
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="relative">
            <div className={`w-3 h-3 rounded-full ${status.color}`} />
            {status.pulse && (
              <div className={`absolute inset-0 w-3 h-3 rounded-full ${status.color} animate-ping opacity-75`} />
            )}
          </div>
          <h3 className="text-gl-purple font-bold text-lg md:text-xl font-mono">{agent.repoName || 'unknown'}</h3>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium tracking-wide ${
            agent.agentType === 'gridlight'
              ? 'bg-pink-900/50 text-pink-400'
              : 'bg-blue-900/50 text-blue-400'
          }`}>
            {agent.agentType === 'gridlight' ? 'Gridlight' : 'Claude'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-sm px-2.5 py-0.5 rounded-full ${
            agent.status === 'working' ? 'bg-green-900/50 text-green-400' :
            agent.status === 'waiting' ? 'bg-yellow-900/50 text-yellow-400' :
            agent.status === 'idle' ? 'bg-gray-800 text-gray-400' :
            'bg-red-900/50 text-red-400'
          }`}>
            {status.label}
          </span>
          <button
            onClick={() => setGitOpen(true)}
            className="text-gray-600 hover:text-gl-purple transition-colors"
            title="Git worktrees & status"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
            </svg>
          </button>
          <button
            onClick={() => api.focusAgent(agent.id).catch(() => {})}
            className="text-gray-600 hover:text-gl-purple transition-colors text-xs"
            title="Bring VS Code window to front"
          >
            ^
          </button>
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
      <div className="text-xs md:text-sm text-gray-500 mb-2 md:mb-3 ml-5">
        {shortMachine(agent.machine)}
        {agent.branch && <span className="text-gray-600"> / {agent.branch}</span>}
        <span className="text-gray-700 ml-2">{timeAgo(agent.lastSeen)}</span>
      </div>

      {/* Stuck alert banner */}
      {stuckAlert && (
        <div className="bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2.5 mb-3">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-amber-400 text-xs">!</span>
              <span className="text-amber-300 text-sm font-semibold">
                {stuckAlert.severity === 'high' ? 'Stuck' : 'Possibly stuck'}
              </span>
            </div>
            <button
              onClick={() => onDismissStuck(agent.id)}
              className="text-gray-500 hover:text-gray-300 text-xs"
            >
              dismiss
            </button>
          </div>
          <p className="text-sm text-gray-400 mb-2">{stuckAlert.pattern}</p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onSendCommand(agent.id, stuckAlert.suggestion)}
              className="px-2 py-1 bg-amber-800 hover:bg-amber-700 text-white text-xs rounded-md transition-colors"
            >
              Send Hint
            </button>
          </div>
        </div>
      )}

      {/* Inline permission requests */}
      {permissions.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-1.5 text-sm text-yellow-400">
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
          mode={agent.mode}
          placeholder={agent.status === 'waiting'
            ? 'Answer the question or give instructions...'
            : agent.status === 'offline'
            ? 'Agent offline — command will queue until reconnect...'
            : 'Send prompt, instructions, or /command...'}
          onSend={(text) => {
            const planSuffix = agent.mode === 'plan'
              ? '\n\nIMPORTANT: Enter plan mode first. Use the EnterPlanMode tool to create an implementation plan and get my approval before writing any code.'
              : '';
            onSendCommand(agent.id, text + planSuffix, useMemory);
          }}
          memoryEnabled={useMemory}
          onToggleMemory={() => setUseMemory((v) => !v)}
        />
      </div>

      {/* Memory panel */}
      <div className="mb-2">
        <button
          onClick={() => setMemoryOpen(!memoryOpen)}
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors uppercase tracking-wider"
        >
          {memoryOpen ? '- ' : '+ '}Memory{memories.length > 0 ? ` (${memories.filter(m => m.active).length}/${memories.length})` : ''}
        </button>

        {memoryOpen && (
          <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
            {memories.length === 0 && (
              <p className="text-xs text-gray-600 italic">No memories yet</p>
            )}
            {memories.map((m) => (
              <div key={m.id} className={`flex items-start gap-1.5 group ${m.active ? '' : 'opacity-40'}`}>
                <button
                  onClick={() => handleToggleMemory(m.id)}
                  className={`shrink-0 w-3.5 h-3.5 mt-0.5 rounded border transition-colors ${
                    m.active
                      ? 'bg-gl-purple border-gl-purple'
                      : 'bg-gray-800 border-gray-600 hover:border-gray-500'
                  }`}
                  title={m.active ? 'Active — click to disable' : 'Inactive — click to enable'}
                />
                <span className={categoryBadge(m.category)}>{m.category}</span>
                <span className="text-xs text-gray-400 flex-1 break-words">{m.content}</span>
                <span className="text-[9px] text-gray-600">{m.source === 'auto' ? 'auto' : ''}</span>
                <button
                  onClick={() => handleDeleteMemory(m.id)}
                  className="text-gray-700 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                >
                  x
                </button>
              </div>
            ))}

            {addingMemory ? (
              <div className="space-y-1.5 pt-1">
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded px-1.5 py-1 w-full"
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="What did you learn?"
                  className="text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded px-2 py-1.5 w-full resize-none h-14"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={handleAddMemory}
                    disabled={!newContent.trim()}
                    className="text-xs px-2 py-1 gl-gradient hover:opacity-90 text-white rounded disabled:opacity-30"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setAddingMemory(false); setNewContent(''); }}
                    className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingMemory(true)}
                className="text-[10px] text-gray-600 hover:text-gl-purple transition-colors"
              >
                + Add memory
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer: mode selector */}
      <div className="flex items-center justify-between mt-auto pt-2">
        <AgentModeSelector mode={agent.mode} onSetMode={(mode) => onSetMode(agent.id, mode)} />
      </div>

      {/* Git Panel Modal */}
      {gitOpen && <GitPanel agent={agent} onClose={() => setGitOpen(false)} />}
    </div>
  );
}
