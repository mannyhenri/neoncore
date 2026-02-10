import { useState } from 'react';
import type { Agent } from '../types';

interface Props {
  agents: Agent[];
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean) => void;
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

const selectClass = 'text-sm glass-input text-gray-300 rounded-md px-2.5 py-2 focus:outline-none focus:border-gl-purple';
const btnClass = 'text-sm px-3.5 py-2 rounded-md font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

type QuickAction = 'full-review' | 'full-test' | 'research';

export function CommandBar({ agents, onSendCommand }: Props) {
  const [selectedCommand, setSelectedCommand] = useState('');
  const [commandAgent, setCommandAgent] = useState('all');
  const [taskId, setTaskId] = useState('');
  const [taskAgent, setTaskAgent] = useState('');
  const [taskAction, setTaskAction] = useState<'start' | 'scope' | 'epic'>('scope');
  const [quickAction, setQuickAction] = useState<QuickAction>('full-review');

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  function handleSendCommand() {
    if (!selectedCommand) return;
    const text = `/${selectedCommand}`;
    if (commandAgent === 'all') {
      for (const agent of onlineAgents) {
        onSendCommand(agent.id, text, false);
      }
    } else {
      onSendCommand(commandAgent, text, false);
    }
    setSelectedCommand('');
  }

  function handleTaskAction() {
    if (!taskId.trim() || !taskAgent) return;
    const id = taskId.trim();
    if (taskAction === 'scope') {
      onSendCommand(taskAgent, `/scoping\n\nScope type: Task\nTask ID: ${id}`, false);
    } else if (taskAction === 'epic') {
      onSendCommand(taskAgent, `/scoping\n\nScope type: Epic\nEpic Title: ${id}`, false);
    } else {
      onSendCommand(taskAgent, `/start-working ${id}`, false);
    }
    setTaskId('');
  }

  function handleQuickAction() {
    if (!taskAgent) return;
    if (quickAction === 'full-review') {
      onSendCommand(taskAgent, '/full-review', false);
    } else if (quickAction === 'full-test') {
      onSendCommand(taskAgent, '/full-test', false);
    } else if (quickAction === 'research') {
      if (!taskId.trim()) return;
      onSendCommand(taskAgent, [
        `Research task ${taskId.trim()} and provide a recommended implementation plan.`,
        '',
        'Steps:',
        `1. Look up task ${taskId.trim()} in Jira using /start-working to get the full task details and acceptance criteria`,
        '2. Based on the task requirements, research current best practices, patterns, and approaches using web search',
        '3. Analyze the existing codebase to understand current architecture and conventions',
        '4. Produce a detailed implementation plan that includes:',
        '   - Recommended approach with rationale',
        '   - Key files that will need changes',
        '   - Libraries or patterns to use (with links to docs)',
        '   - Potential risks or edge cases to watch for',
        '   - Estimated complexity and suggested breakdown into subtasks',
        '',
        'Present the plan in a clear, actionable format. Do NOT start implementing — research and plan only.',
      ].join('\n'), false);
    }
  }

  const quickActionDisabled = !taskAgent || (quickAction === 'research' && !taskId.trim());

  return (
    <div className="border-b border-white/[0.06] px-6 py-3">
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
            className={btnClass + ' gl-gradient text-white hover:opacity-90'}
          >
            Send
          </button>
        </div>

        {/* Jira Task Launcher */}
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-600 font-semibold">
            Jira
          </span>
          <input
            type="text"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTaskAction(); }}
            placeholder={taskAction === 'epic' ? 'Epic title...' : 'GRD-427'}
            className={`text-sm glass-input text-gray-300 rounded-md px-2.5 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple ${taskAction === 'epic' ? 'w-44' : 'w-28'}`}
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
            Run
          </button>

          <span className="w-px h-6 bg-white/10 mx-1" />

          {/* Quick Actions */}
          <select
            value={quickAction}
            onChange={(e) => setQuickAction(e.target.value as QuickAction)}
            className={selectClass}
          >
            <option value="full-review">Full Review</option>
            <option value="full-test">Full Test</option>
            <option value="research">Research</option>
          </select>

          <button
            onClick={handleQuickAction}
            disabled={quickActionDisabled}
            className={btnClass + (quickAction === 'research'
              ? ' bg-amber-600 text-white hover:bg-amber-500'
              : quickAction === 'full-test'
              ? ' bg-teal-600 text-white hover:bg-teal-500'
              : ' bg-rose-600 text-white hover:bg-rose-500')}
          >
            {quickAction === 'research' ? 'Research' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
