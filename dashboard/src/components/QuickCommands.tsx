import { useState, useRef, useEffect } from 'react';
import type { Agent } from '../types';

interface Props {
  agents: Agent[];
  onSendCommand: (agentId: string, text: string) => void;
}

interface CommandCategory {
  label: string;
  color: string;
  commands: string[];
}

const CATEGORIES: CommandCategory[] = [
  {
    label: 'Git',
    color: 'text-green-400 border-green-800 bg-green-950',
    commands: [
      'commit-push', 'commit-push-pr', 'commit-push-pr-actions',
      'sync-branch', 'pull-branches', 'create-branch', 'checkout',
      'finish-branch', 'check-merge',
    ],
  },
  {
    label: 'Quality',
    color: 'text-blue-400 border-blue-800 bg-blue-950',
    commands: [
      'check-code', 'code-review', 'security-review', 'run-tests',
      'debug-check', 'mark-risk', 'list-risks',
    ],
  },
  {
    label: 'Worktree',
    color: 'text-purple-400 border-purple-800 bg-purple-950',
    commands: [
      'worktree-add', 'worktree-list', 'worktree-sync',
      'worktree-finish', 'worktree-remove', 'worktree-help',
    ],
  },
  {
    label: 'Other',
    color: 'text-gray-400 border-gray-700 bg-gray-900',
    commands: [
      'diagnose', 'challenge', 'scoping', 'start-working',
      'reduce-complexity', 'list-commands',
    ],
  },
];

export function QuickCommands({ agents, onSendCommand }: Props) {
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const popoverRef = useRef<HTMLDivElement>(null);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  // Close popover on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setActiveCommand(null);
        setSelectedAgents(new Set());
      }
    }
    if (activeCommand) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeCommand]);

  function handleChipClick(cmd: string) {
    if (activeCommand === cmd) {
      setActiveCommand(null);
      setSelectedAgents(new Set());
      return;
    }
    setActiveCommand(cmd);
    // Pre-select all online agents
    setSelectedAgents(new Set(onlineAgents.map((a) => a.id)));
  }

  function toggleAgent(agentId: string) {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  function toggleAll() {
    if (selectedAgents.size === onlineAgents.length) {
      setSelectedAgents(new Set());
    } else {
      setSelectedAgents(new Set(onlineAgents.map((a) => a.id)));
    }
  }

  function sendToSelected() {
    if (!activeCommand || selectedAgents.size === 0) return;
    const text = `/${activeCommand}`;
    for (const agentId of selectedAgents) {
      onSendCommand(agentId, text);
    }
    setActiveCommand(null);
    setSelectedAgents(new Set());
  }

  return (
    <div className="border-b border-gray-800 px-6 py-3 relative">
      <div className="flex items-center gap-4 overflow-x-auto scrollbar-hide">
        {CATEGORIES.map((cat) => (
          <div key={cat.label} className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] uppercase tracking-wider text-gray-600 font-semibold mr-1">
              {cat.label}
            </span>
            {cat.commands.map((cmd) => (
              <button
                key={cmd}
                onClick={() => handleChipClick(cmd)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors whitespace-nowrap ${
                  activeCommand === cmd
                    ? 'border-neon-500 text-neon-400 bg-neon-950'
                    : cat.color + ' hover:brightness-125'
                }`}
              >
                /{cmd}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Agent picker popover */}
      {activeCommand && (
        <div
          ref={popoverRef}
          className="absolute top-full left-6 mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 min-w-[260px]"
        >
          <div className="text-xs text-gray-400 mb-2">
            Send <span className="text-neon-400 font-mono">/{activeCommand}</span> to:
          </div>

          {onlineAgents.length === 0 ? (
            <div className="text-xs text-gray-600 py-2">No online agents</div>
          ) : (
            <>
              {/* Select All toggle */}
              <label className="flex items-center gap-2 text-xs text-gray-300 py-1 cursor-pointer hover:text-white">
                <input
                  type="checkbox"
                  checked={selectedAgents.size === onlineAgents.length}
                  onChange={toggleAll}
                  className="accent-neon-500"
                />
                <span className="font-medium">All agents ({onlineAgents.length})</span>
              </label>
              <div className="border-t border-gray-800 my-1" />

              {/* Individual agents */}
              {onlineAgents.map((agent) => (
                <label
                  key={agent.id}
                  className="flex items-center gap-2 text-xs text-gray-300 py-1 cursor-pointer hover:text-white"
                >
                  <input
                    type="checkbox"
                    checked={selectedAgents.has(agent.id)}
                    onChange={() => toggleAgent(agent.id)}
                    className="accent-neon-500"
                  />
                  <span className="font-mono">{agent.repoName || agent.name}</span>
                  <span className="text-gray-600 text-[10px]">{agent.machine.replace(/\.local$/, '')}</span>
                </label>
              ))}

              {/* Send button */}
              <div className="border-t border-gray-800 mt-2 pt-2">
                <button
                  onClick={sendToSelected}
                  disabled={selectedAgents.size === 0}
                  className="w-full text-xs px-3 py-1.5 bg-neon-600 text-white rounded-md hover:bg-neon-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  Send to {selectedAgents.size} agent{selectedAgents.size !== 1 ? 's' : ''}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
