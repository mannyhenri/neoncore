import { useState, useRef, useEffect } from 'react';
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

function AgentPicker({
  agents,
  selected,
  onChange,
}: {
  agents: Agent[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const allSelected = agents.length > 0 && selected.length === agents.length;

  function toggle(id: string) {
    onChange(
      selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id],
    );
  }

  function toggleAll() {
    onChange(allSelected ? [] : agents.map((a) => a.id));
  }

  const agentLabel = (a: Agent) => {
    const name = a.repoName || a.name;
    return a.machine ? `${name} (${a.machine})` : name;
  };

  let label = 'Select agents...';
  if (allSelected && agents.length > 0) label = `All (${agents.length})`;
  else if (selected.length === 1) {
    const agent = agents.find((a) => a.id === selected[0]);
    label = agent ? agentLabel(agent) : '1 agent';
  } else if (selected.length > 1) label = `${selected.length} agents`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={selectClass + ' w-full sm:w-auto sm:min-w-[140px] text-left cursor-pointer flex items-center justify-between gap-2'}
      >
        <span className="truncate">{label}</span>
        <span className="text-gray-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 glass-dark border border-white/10 rounded-lg shadow-xl z-50 py-1 max-h-[260px] overflow-y-auto">
          <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer border-b border-white/5 mb-1">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="accent-purple-500"
            />
            <span className="text-sm text-gray-300 font-medium">All online ({agents.length})</span>
          </label>
          {agents.map((agent) => (
            <label key={agent.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(agent.id)}
                onChange={() => toggle(agent.id)}
                className="accent-purple-500"
              />
              <span className="text-sm text-gray-300 truncate">{agentLabel(agent)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function CommandBar({ agents, onSendCommand }: Props) {
  const [selectedCommand, setSelectedCommand] = useState('');
  const [commandAgents, setCommandAgents] = useState<string[]>([]);
  const [taskId, setTaskId] = useState('');
  const [taskAgents, setTaskAgents] = useState<string[]>([]);
  const [taskAction, setTaskAction] = useState<'start' | 'scope' | 'epic'>('scope');
  const [quickAction, setQuickAction] = useState<QuickAction>('full-review');
  const commandInitRef = useRef(false);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  // Only auto-select all on first mount; after that just prune offline agents
  useEffect(() => {
    const onlineIds = new Set(onlineAgents.map((a) => a.id));
    if (!commandInitRef.current && onlineIds.size > 0) {
      commandInitRef.current = true;
      setCommandAgents([...onlineIds]);
    } else {
      setCommandAgents((prev) => prev.filter((id) => onlineIds.has(id)));
    }
    setTaskAgents((prev) => prev.filter((id) => onlineIds.has(id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  function handleSendCommand() {
    if (!selectedCommand || commandAgents.length === 0) return;
    const text = `/${selectedCommand}`;
    for (const id of commandAgents) {
      onSendCommand(id, text, false);
    }
    setSelectedCommand('');
  }

  function handleTaskAction() {
    if (!taskId.trim() || taskAgents.length === 0) return;
    const id = taskId.trim();
    for (const agentId of taskAgents) {
      if (taskAction === 'scope') {
        onSendCommand(agentId, `/scoping\n\nScope type: Task\nTask ID: ${id}`, false);
      } else if (taskAction === 'epic') {
        onSendCommand(agentId, `/scoping\n\nScope type: Epic\nEpic Title: ${id}`, false);
      } else {
        onSendCommand(agentId, `/start-working ${id}`, false);
      }
    }
    setTaskId('');
  }

  function handleQuickAction() {
    if (taskAgents.length === 0) return;
    for (const agentId of taskAgents) {
      if (quickAction === 'full-review') {
        onSendCommand(agentId, '/full-review', false);
      } else if (quickAction === 'full-test') {
        onSendCommand(agentId, '/full-test', false);
      } else if (quickAction === 'research') {
        if (!taskId.trim()) return;
        onSendCommand(agentId, [
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
  }

  const quickActionDisabled = taskAgents.length === 0 || (quickAction === 'research' && !taskId.trim());

  return (
    <div className="border-b border-white/[0.06] px-3 py-2 md:px-6 md:py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        {/* Command Launcher */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedCommand}
            onChange={(e) => setSelectedCommand(e.target.value)}
            className={selectClass + ' w-full sm:w-auto sm:min-w-[180px]'}
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

          <AgentPicker
            agents={onlineAgents}
            selected={commandAgents}
            onChange={setCommandAgents}
          />

          <button
            onClick={handleSendCommand}
            disabled={!selectedCommand || commandAgents.length === 0}
            className={btnClass + ' w-full sm:w-auto gl-gradient text-white hover:opacity-90'}
          >
            Send
          </button>
        </div>

        {/* Jira Task Launcher */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-600 font-semibold">
            Jira
          </span>
          <input
            type="text"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTaskAction(); }}
            placeholder={taskAction === 'epic' ? 'Epic title...' : 'GRD-427'}
            className={`text-sm glass-input text-gray-300 rounded-md px-2.5 py-2 font-mono placeholder-gray-600 focus:outline-none focus:border-gl-purple w-full sm:w-auto ${taskAction === 'epic' ? 'sm:w-44' : 'sm:w-28'}`}
          />

          <AgentPicker
            agents={onlineAgents}
            selected={taskAgents}
            onChange={setTaskAgents}
          />

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
            disabled={!taskId.trim() || taskAgents.length === 0}
            className={btnClass + (taskAction === 'epic'
              ? ' bg-purple-600 text-white hover:bg-purple-500'
              : taskAction === 'scope'
              ? ' bg-violet-600 text-white hover:bg-violet-500'
              : ' bg-indigo-600 text-white hover:bg-indigo-500')}
          >
            Run
          </button>

          <span className="hidden sm:block w-px h-6 bg-white/10 mx-1" />

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
