import { useMemo, useState } from 'react';
import type { Task, TaskStatus, Agent } from '../types';

interface TasksPageProps {
  tasks: Task[];
  agents: Agent[];
  createTask: (data: { title: string; prompt?: string; priority?: number }) => Promise<Task>;
  cancelTask: (id: string) => Promise<void>;
}

const STATUS_META: Record<TaskStatus, { label: string; cls: string }> = {
  queued:      { label: 'Queued',      cls: 'bg-gray-900/40 text-gray-400 border-gray-800/50' },
  claimed:     { label: 'Claimed',     cls: 'bg-blue-900/40 text-blue-400 border-blue-800/50' },
  in_progress: { label: 'In Progress', cls: 'bg-violet-900/40 text-violet-400 border-violet-800/50' },
  done:        { label: 'Done',        cls: 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50' },
  failed:      { label: 'Failed',      cls: 'bg-red-900/40 text-red-400 border-red-800/50' },
  cancelled:   { label: 'Cancelled',   cls: 'bg-yellow-900/40 text-yellow-400 border-yellow-800/50' },
};

const FILTERS: Array<{ key: 'all' | 'active' | TaskStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'queued', label: 'Queued' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
];

function StatusBadge({ status }: { status: TaskStatus }) {
  const { label, cls } = STATUS_META[status];
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${cls}`}>{label}</span>;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function CreateTaskModal({ onClose, onCreate }: { onClose: () => void; onCreate: TasksPageProps['createTask'] }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onCreate({ title: title.trim(), prompt: prompt.trim(), priority });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create task');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#111] border border-white/10 rounded-xl p-5 w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-200">New task</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Title</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Fix the 500 on /login"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 mb-3"
        />

        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Instructions for the agent</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder="What should the agent that claims this task do?"
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 mb-3 resize-y"
        />

        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Priority</label>
        <input
          type="number"
          value={priority}
          onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
          className="w-28 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25 mb-4"
        />

        {error && <p className="text-[12px] text-red-400 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-1.5 text-gray-400 hover:text-gray-200 text-sm rounded-md transition-colors">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!title.trim() || saving}
            className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
          >
            {saving ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, agents, onCancel }: { task: Task; agents: Agent[]; onCancel: (id: string) => void }) {
  const agent = task.assignedAgentId ? agents.find((a) => a.id === task.assignedAgentId) : undefined;
  const isTerminal = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={task.status} />
            {task.priority > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.05] text-gray-400 border border-white/10">p{task.priority}</span>
            )}
          </div>
          <h3 className="text-sm font-medium text-gray-200 mt-1.5 truncate">{task.title}</h3>
        </div>
        {!isTerminal && (
          <button
            onClick={() => onCancel(task.id)}
            className="shrink-0 text-[11px] px-2 py-1 rounded-md border border-white/10 text-gray-500 hover:text-red-400 hover:border-red-800/50 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      {task.prompt && <p className="text-[12px] text-gray-500 line-clamp-2 whitespace-pre-wrap">{task.prompt}</p>}

      {task.result && (
        <p className="text-[12px] text-emerald-400/80 bg-emerald-950/20 border border-emerald-900/30 rounded px-2 py-1.5 whitespace-pre-wrap line-clamp-3">
          {task.result}
        </p>
      )}
      {task.error && (
        <p className="text-[12px] text-red-400/80 bg-red-950/20 border border-red-900/30 rounded px-2 py-1.5 whitespace-pre-wrap line-clamp-3">
          {task.error}
        </p>
      )}

      <div className="flex items-center gap-3 text-[11px] text-gray-600 mt-0.5">
        <span>created {timeAgo(task.createdAt)}</span>
        {agent && <span className="text-gray-500">→ {agent.repoName || agent.name}</span>}
        {!agent && task.assignedAgentId && <span className="text-gray-500">→ {task.assignedAgentId.slice(0, 8)}</span>}
        {task.completedAt && <span>finished {timeAgo(task.completedAt)}</span>}
      </div>
    </div>
  );
}

export function TasksPage({ tasks, agents, createTask, cancelTask }: TasksPageProps) {
  const [filter, setFilter] = useState<'all' | 'active' | TaskStatus>('active');
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const sorted = [...tasks].sort(
      (a, b) => b.priority - a.priority || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    if (filter === 'all') return sorted;
    if (filter === 'active') return sorted.filter((t) => ['queued', 'claimed', 'in_progress'].includes(t.status));
    return sorted.filter((t) => t.status === filter);
  }, [tasks, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [tasks]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-semibold text-gray-200">Task queue</h2>
          <p className="text-[12px] text-gray-600 mt-0.5">
            {(counts.queued || 0)} queued · {(counts.in_progress || 0) + (counts.claimed || 0)} active · {(counts.done || 0)} done
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-md transition-colors"
        >
          + New task
        </button>
      </div>

      <div className="flex gap-1.5 mb-4 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
              filter === f.key ? 'bg-white/10 text-gray-200' : 'bg-white/[0.03] text-gray-500 hover:text-gray-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 border border-white/[0.06] rounded-xl bg-white/[0.02]">
          <div className="text-3xl mb-3">🗂️</div>
          <h3 className="text-sm font-medium text-gray-400 mb-1">No tasks here</h3>
          <p className="text-[12px] text-gray-600 max-w-xs mx-auto">
            Queue work for your agents — they'll claim and complete it via NeonCore's coordination tools.
          </p>
          <button
            onClick={() => setCreating(true)}
            className="mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-md transition-colors"
          >
            Create first task
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((t) => (
            <TaskCard key={t.id} task={t} agents={agents} onCancel={cancelTask} />
          ))}
        </div>
      )}

      {creating && <CreateTaskModal onClose={() => setCreating(false)} onCreate={createTask} />}
    </div>
  );
}
