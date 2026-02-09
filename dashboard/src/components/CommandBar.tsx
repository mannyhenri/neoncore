import { useState } from 'react';
import type { Agent } from '../types';

interface Props {
  agents: Agent[];
  onSendCommand: (agentId: string, text: string) => void;
}

interface CommandCategory {
  label: string;
  commands: string[];
}

const CATEGORIES: CommandCategory[] = [
  {
    label: 'Git',
    commands: [
      'commit-push', 'commit-push-pr', 'commit-push-pr-actions',
      'sync-branch', 'pull-branches', 'create-branch', 'checkout',
      'finish-branch', 'check-merge',
    ],
  },
  {
    label: 'Quality',
    commands: [
      'full-review', 'full-test', 'check-code', 'code-review', 'security-review',
      'run-tests', 'debug-check', 'mark-risk', 'list-risks',
    ],
  },
  {
    label: 'Worktree',
    commands: [
      'worktree-add', 'worktree-list', 'worktree-sync',
      'worktree-finish', 'worktree-remove', 'worktree-help',
    ],
  },
  {
    label: 'Other',
    commands: [
      'deploy-to-gridlight', 'diagnose', 'challenge', 'scoping',
      'start-working', 'reduce-complexity', 'list-commands',
    ],
  },
];

const selectClass = 'text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded-md px-2 py-1.5 focus:outline-none focus:border-neon-500';
const btnClass = 'text-xs px-3 py-1.5 rounded-md font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

export function CommandBar({ agents, onSendCommand }: Props) {
  const [selectedCommand, setSelectedCommand] = useState('');
  const [commandAgent, setCommandAgent] = useState('all');
  const [taskId, setTaskId] = useState('');
  const [taskAgent, setTaskAgent] = useState('');
  const [taskAction, setTaskAction] = useState<'start' | 'scope' | 'epic'>('scope');

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  function handleSendCommand() {
    if (!selectedCommand) return;
    const text = `/${selectedCommand}`;
    if (commandAgent === 'all') {
      for (const agent of onlineAgents) {
        onSendCommand(agent.id, text);
      }
    } else {
      onSendCommand(commandAgent, text);
    }
    setSelectedCommand('');
  }

  function handleTaskAction() {
    if (!taskId.trim() || !taskAgent) return;
    const id = taskId.trim();
    if (taskAction === 'scope') {
      onSendCommand(taskAgent, `/scoping\n\nScope type: Task\nTask ID: ${id}`);
    } else if (taskAction === 'epic') {
      onSendCommand(taskAgent, `/scoping\n\nScope type: Epic\nEpic Title: ${id}`);
    } else {
      onSendCommand(taskAgent, `/start-working ${id}`);
    }
    setTaskId('');
  }

  return (
    <div className="border-b border-gray-800 px-6 py-3">
      <div className="flex items-center justify-between gap-6 flex-wrap">
        {/* Command Launcher */}
        <div className="flex items-center gap-2">
          <select
            value={selectedCommand}
            onChange={(e) => setSelectedCommand(e.target.value)}
            className={selectClass + ' min-w-[180px]'}
          >
            <option value="">Select command...</option>
            {CATEGORIES.map((cat) => (
              <optgroup key={cat.label} label={cat.label}>
                {cat.commands.map((cmd) => (
                  <option key={cmd} value={cmd}>/{cmd}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <select
            value={commandAgent}
            onChange={(e) => setCommandAgent(e.target.value)}
            className={selectClass + ' min-w-[140px]'}
          >
            <option value="all">All online ({onlineAgents.length})</option>
            {onlineAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.repoName || agent.name}
              </option>
            ))}
          </select>

          <button
            onClick={handleSendCommand}
            disabled={!selectedCommand}
            className={btnClass + ' bg-neon-600 text-white hover:bg-neon-500'}
          >
            Send
          </button>
        </div>

        {/* Jira Task Launcher */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-gray-600 font-semibold">
            Jira
          </span>
          <input
            type="text"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTaskAction(); }}
            placeholder={taskAction === 'epic' ? 'Epic title...' : 'GRD-427'}
            className={`text-xs bg-gray-800 text-gray-300 border border-gray-700 rounded-md px-2 py-1.5 font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 ${taskAction === 'epic' ? 'w-40' : 'w-24'}`}
          />

          <select
            value={taskAgent}
            onChange={(e) => setTaskAgent(e.target.value)}
            className={selectClass + ' min-w-[140px]'}
          >
            <option value="">Select agent...</option>
            {onlineAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.repoName || agent.name}
              </option>
            ))}
          </select>

          <select
            value={taskAction}
            onChange={(e) => setTaskAction(e.target.value as 'start' | 'scope' | 'epic')}
            className={selectClass}
          >
            <option value="scope">Scope Task</option>
            <option value="start">Start Working</option>
            <option value="epic">Scope Epic</option>
          </select>

          <button
            onClick={handleTaskAction}
            disabled={!taskId.trim() || !taskAgent}
            className={btnClass + (taskAction === 'epic'
              ? ' bg-purple-600 text-white hover:bg-purple-500'
              : taskAction === 'scope'
              ? ' bg-violet-600 text-white hover:bg-violet-500'
              : ' bg-indigo-600 text-white hover:bg-indigo-500')}
          >
            {taskAction === 'epic' ? 'Scope Epic' : taskAction === 'scope' ? 'Scope' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
