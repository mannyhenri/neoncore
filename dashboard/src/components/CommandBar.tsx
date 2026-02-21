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

const dropdownBtnClass = 'text-sm glass-input text-gray-300 rounded-md px-2.5 py-2 focus:outline-none text-left cursor-pointer flex items-center justify-between gap-2';
const btnClass = 'text-sm px-3.5 py-2 rounded-md font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

// ─── Custom dropdown (no native <select>) ──────────────
interface GlassSelectOption {
  value: string;
  label: string;
  group?: string;
}

function GlassSelect({
  value,
  onChange,
  options,
  placeholder,
  className,
}: {
  value: string;
  onChange: (val: string) => void;
  options: GlassSelectOption[];
  placeholder?: string;
  className?: string;
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

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? 'Select...';

  // Group options by group key (if present)
  const groups: { group: string; items: GlassSelectOption[] }[] = [];
  for (const opt of options) {
    const g = opt.group || '';
    const existing = groups.find((gr) => gr.group === g);
    if (existing) existing.items.push(opt);
    else groups.push({ group: g, items: [opt] });
  }

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={dropdownBtnClass}
      >
        <span className="truncate">{label}</span>
        <span className="text-gray-500 text-xs shrink-0">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-full w-max glass-dark border border-white/10 rounded-lg shadow-xl z-50 py-1 max-h-[300px] overflow-y-auto">
          {groups.map((g) => (
            <div key={g.group}>
              {g.group && (
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                  {g.group}
                </div>
              )}
              {g.items.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                    opt.value === value
                      ? 'text-purple-400 bg-white/[0.06]'
                      : 'text-gray-300 hover:bg-white/5'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent multi-select picker ─────────────────────────
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
        className={dropdownBtnClass + ' w-full sm:w-auto sm:min-w-[140px]'}
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

// ─── Build command options with groups ──────────────────
const COMMAND_OPTIONS: GlassSelectOption[] = CATEGORIES.flatMap((cat) =>
  cat.commands.map((cmd) => ({ value: cmd, label: `/${cmd}`, group: cat.label })),
);


// ─── CommandBar ────────────────────────────────────────
export function CommandBar({ agents, onSendCommand }: Props) {
  const [selectedCommand, setSelectedCommand] = useState('');
  const [commandAgents, setCommandAgents] = useState<string[]>([]);
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

  return (
    <div className="border-b border-white/[0.06] px-3 py-2 md:px-6 md:py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        {/* Command Launcher */}
        <div className="flex flex-wrap items-center gap-2">
          <GlassSelect
            value={selectedCommand}
            onChange={setSelectedCommand}
            options={COMMAND_OPTIONS}
            placeholder="Select command..."
            className="w-full sm:w-auto sm:min-w-[180px]"
          />

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
      </div>
    </div>
  );
}
