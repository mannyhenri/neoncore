import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionTitle } from './SectionTitle';
import { QueuePanel } from './QueuePanel';
import { api } from '../lib/api';
import type { Task, TaskStatus, Agent, Goal, Project, QueueItem } from '../types';

interface TasksPageProps {
  tasks: Task[];
  agents: Agent[];
  createTask: (data: { title: string; prompt?: string; projectId?: string | null; priority?: number }) => Promise<Task>;
  cancelTask: (id: string) => Promise<void>;
  updateTask: (id: string, data: { title?: string; prompt?: string; projectId?: string | null; priority?: number }) => Promise<Task>;
  dispatchTask: (id: string, agentId?: string) => Promise<Task>;
  completeTask: (id: string, status?: 'done' | 'failed', result?: string) => Promise<Task>;
}

/** Cross-platform repo-path normalize, mirroring the server's resolve-agent. */
function normalizeRepoPath(p: string): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^([a-zA-Z]):\//, '/$1/').replace(/\/+$/, '').toLowerCase();
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

function CreateTaskModal({
  onClose,
  onCreate,
  goals,
  projects,
}: {
  onClose: () => void;
  onCreate: TasksPageProps['createTask'];
  goals: Goal[];
  projects: Project[];
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Group projects under their goal so the picker reads "assign to a goal → cartridge".
  const grouped = useMemo(() => {
    const byGoal = new Map<string | null, Project[]>();
    for (const p of projects) {
      const key = p.goalId ?? null;
      if (!byGoal.has(key)) byGoal.set(key, []);
      byGoal.get(key)!.push(p);
    }
    return byGoal;
  }, [projects]);

  const selected = projects.find((p) => p.id === projectId);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    try {
      await onCreate({ title: title.trim(), prompt: prompt.trim(), projectId: projectId || null, priority });
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

        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Cartridge / project</label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25 mb-1"
        >
          <option value="">— Any agent (unpinned) —</option>
          {[...grouped.entries()].map(([goalId, ps]) => {
            const goal = goals.find((g) => g.id === goalId);
            const label = goal ? goal.name : 'No goal';
            return (
              <optgroup key={goalId ?? 'none'} label={label}>
                {ps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.primaryRepo ? ` (${p.primaryRepo.split('/').filter(Boolean).pop()})` : ' — no repo'}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <p className="text-[11px] text-gray-600 mb-3">
          {selected
            ? selected.primaryRepo
              ? `Only an idle agent in ${selected.primaryRepo.split('/').filter(Boolean).pop()} can claim this — it waits until that agent is free.`
              : `This project has no repo set, so no agent can be matched. Set a codebase on the project first.`
            : 'Any idle agent can claim this task.'}
        </p>

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

function TaskDetailModal({
  task,
  agents,
  goals,
  projects,
  onClose,
  updateTask,
  dispatchTask,
  cancelTask,
  completeTask,
}: {
  task: Task;
  agents: Agent[];
  goals: Goal[];
  projects: Project[];
  onClose: () => void;
  updateTask: TasksPageProps['updateTask'];
  dispatchTask: TasksPageProps['dispatchTask'];
  cancelTask: TasksPageProps['cancelTask'];
  completeTask: TasksPageProps['completeTask'];
}) {
  const editable = task.status === 'queued';
  const isTerminal = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';

  const [title, setTitle] = useState(task.title);
  const [prompt, setPrompt] = useState(task.prompt);
  const [priority, setPriority] = useState(task.priority);
  const [projectId, setProjectId] = useState(task.projectId ?? '');
  const [saving, setSaving] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const project = projects.find((p) => p.id === (editable ? projectId : task.projectId));
  const assignedAgent = task.assignedAgentId ? agents.find((a) => a.id === task.assignedAgentId) : undefined;

  // Eligible dispatch targets: online agents, narrowed to those serving a pinned
  // project's repo (the server enforces the same pin and would 403 otherwise).
  const onlineAgents = agents.filter((a) => a.status !== 'offline');
  const pinRepo = task.projectId ? projects.find((p) => p.id === task.projectId)?.primaryRepo : undefined;
  const eligibleAgents = pinRepo
    ? onlineAgents.filter((a) => normalizeRepoPath(a.repoPath) === normalizeRepoPath(pinRepo))
    : onlineAgents;
  const [targetAgentId, setTargetAgentId] = useState('');
  useEffect(() => {
    if (!targetAgentId && eligibleAgents.length > 0) setTargetAgentId(eligibleAgents[0].id);
  }, [eligibleAgents, targetAgentId]);

  const grouped = useMemo(() => {
    const byGoal = new Map<string | null, Project[]>();
    for (const p of projects) {
      const key = p.goalId ?? null;
      if (!byGoal.has(key)) byGoal.set(key, []);
      byGoal.get(key)!.push(p);
    }
    return byGoal;
  }, [projects]);

  const dirty = editable && (
    title.trim() !== task.title || prompt !== task.prompt || priority !== task.priority || (projectId || null) !== task.projectId
  );

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    try {
      await updateTask(task.id, { title: title.trim(), prompt, priority, projectId: projectId || null });
      setNotice('Saved.');
      setTimeout(() => setNotice(''), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const markComplete = async (status: 'done' | 'failed') => {
    setError('');
    try {
      await completeTask(task.id, status);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    }
  };

  const dispatch = async () => {
    if (!targetAgentId) return;
    setDispatching(true);
    setError('');
    try {
      await dispatchTask(task.id, targetAgentId);
      setNotice('Sent to terminal.');
      setTimeout(onClose, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to dispatch');
      setDispatching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[#111] border border-white/10 rounded-xl p-5 w-full max-w-2xl max-h-[88vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <StatusBadge status={task.status} />
            <h3 className="text-sm font-semibold text-gray-200">{editable ? 'Edit task' : 'Task details'}</h3>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-600 hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Title</label>
        {editable ? (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25 mb-3"
          />
        ) : (
          <p className="text-sm text-gray-200 mb-3 whitespace-pre-wrap">{task.title}</p>
        )}

        <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Instructions for the agent</label>
        {editable ? (
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={8}
            placeholder="What should the agent that claims this task do?"
            className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/25 mb-3 resize-y"
          />
        ) : (
          <p className="text-[13px] text-gray-300 mb-3 whitespace-pre-wrap bg-black/30 border border-white/[0.06] rounded-md px-3 py-2">
            {task.prompt || <span className="text-gray-600">No instructions.</span>}
          </p>
        )}

        {editable && (
          <div className="flex flex-wrap gap-4 mb-3">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Cartridge / project</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
              >
                <option value="">— Any agent (unpinned) —</option>
                {[...grouped.entries()].map(([gid, ps]) => {
                  const goal = goals.find((g) => g.id === gid);
                  return (
                    <optgroup key={gid ?? 'none'} label={goal ? goal.name : 'No goal'}>
                      {ps.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.primaryRepo ? ` (${p.primaryRepo.split('/').filter(Boolean).pop()})` : ' — no repo'}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </div>
            <div className="w-28">
              <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Priority</label>
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
              />
            </div>
          </div>
        )}

        {!editable && project && (
          <p className="text-[12px] text-gray-500 mb-3">
            Pinned to <span className="text-gray-300">{project.name}</span>
            {project.primaryRepo ? ` (${project.primaryRepo.split('/').filter(Boolean).pop()})` : ''}
          </p>
        )}

        {task.result && (
          <>
            <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Result</label>
            <p className="text-[12px] text-emerald-400/90 bg-emerald-950/20 border border-emerald-900/30 rounded px-3 py-2 whitespace-pre-wrap mb-3">{task.result}</p>
          </>
        )}
        {task.error && (
          <>
            <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Error</label>
            <p className="text-[12px] text-red-400/90 bg-red-950/20 border border-red-900/30 rounded px-3 py-2 whitespace-pre-wrap mb-3">{task.error}</p>
          </>
        )}

        {/* Send to a terminal now */}
        {!isTerminal && (
          <div className="border-t border-white/[0.07] pt-3 mt-1 mb-3">
            <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">Send to agent</label>
            {eligibleAgents.length === 0 ? (
              <p className="text-[12px] text-gray-600">
                {pinRepo
                  ? 'No online agent is serving this cartridge’s repo right now.'
                  : 'No agents are online right now.'}
              </p>
            ) : (
              <div className="flex gap-2">
                <select
                  value={targetAgentId}
                  onChange={(e) => setTargetAgentId(e.target.value)}
                  className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-white/25"
                >
                  {eligibleAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.repoName || a.name} · {a.status}
                    </option>
                  ))}
                </select>
                <button
                  onClick={dispatch}
                  disabled={dispatching || !targetAgentId}
                  className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors whitespace-nowrap"
                >
                  {dispatching ? 'Sending…' : 'Send to terminal'}
                </button>
              </div>
            )}
            {assignedAgent && (
              <p className="text-[11px] text-gray-600 mt-1.5">Currently assigned to {assignedAgent.repoName || assignedAgent.name}.</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] text-gray-600 mb-4">
          <span>created {timeAgo(task.createdAt)}</span>
          {task.claimedAt && <span>claimed {timeAgo(task.claimedAt)}</span>}
          {task.completedAt && <span>finished {timeAgo(task.completedAt)}</span>}
        </div>

        {error && <p className="text-[12px] text-red-400 mb-3">{error}</p>}
        {notice && <p className="text-[12px] text-emerald-400 mb-3">{notice}</p>}

        <div className="flex items-center justify-end gap-2 flex-wrap">
          {!isTerminal && (
            <button
              onClick={() => { cancelTask(task.id); onClose(); }}
              className="px-4 py-1.5 mr-auto text-gray-500 hover:text-red-400 text-sm rounded-md transition-colors"
            >
              Cancel task
            </button>
          )}
          {!isTerminal && (
            <>
              <button
                onClick={() => markComplete('failed')}
                className="px-3 py-1.5 text-sm rounded-md border border-white/10 text-gray-400 hover:text-red-400 hover:border-red-800/50 transition-colors"
              >
                Mark failed
              </button>
              <button
                onClick={() => markComplete('done')}
                className="px-3 py-1.5 text-sm rounded-md border border-emerald-800/50 text-emerald-400 hover:bg-emerald-900/30 transition-colors"
              >
                Mark done
              </button>
            </>
          )}
          <button onClick={onClose} className="px-4 py-1.5 text-gray-400 hover:text-gray-200 text-sm rounded-md transition-colors">
            Close
          </button>
          {editable && (
            <button
              onClick={save}
              disabled={!title.trim() || !dirty || saving}
              className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, agents, projects, onCancel, onClear, onOpen }: { task: Task; agents: Agent[]; projects: Project[]; onCancel: (id: string) => void; onClear: (id: string) => void; onOpen: (id: string) => void }) {
  const agent = task.assignedAgentId ? agents.find((a) => a.id === task.assignedAgentId) : undefined;
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const isTerminal = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  return (
    <div
      onClick={() => onOpen(task.id)}
      className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex flex-col gap-2 cursor-pointer hover:border-white/20 hover:bg-white/[0.05] transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={task.status} />
            {task.priority > 0 && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.05] text-gray-400 border border-white/10">p{task.priority}</span>
            )}
            {project && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded border flex items-center gap-1"
                style={{ color: project.color, borderColor: `${project.color}55`, backgroundColor: `${project.color}11` }}
                title={project.primaryRepo || 'no repo'}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: project.color }} />
                {project.name}
              </span>
            )}
          </div>
          <h3 className="text-sm font-medium text-gray-200 mt-1.5 truncate">{task.title}</h3>
        </div>
        {/* Exclusive, same rule as a queue row: cancel while it is live, clear once it has
            finished. Never both, so there is nothing to guess between. */}
        {!isTerminal ? (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(task.id); }}
            className="shrink-0 text-[11px] px-2 py-1 rounded-md border border-white/10 text-gray-500 hover:text-red-400 hover:border-red-800/50 transition-colors"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onClear(task.id); }}
            title="Remove this task from the list"
            className="shrink-0 text-[11px] px-2 py-1 rounded-md border border-white/10 text-gray-500 hover:text-gray-300 hover:border-white/20 transition-colors"
          >
            Clear
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

/**
 * A queue item rendered as a task row. Deliberately the same visual weight as a TaskCard:
 * a queued prompt and a task are the same thing to the person reading the list.
 */
/**
 * A queue item, styled as the TaskCard it sits beside.
 *
 * Reuses STATUS_META and the card idiom from this same file rather than inventing a second
 * visual language for the same list — the whole point of merging the two views was that a
 * queued prompt and a task are the same thing to the person reading them.
 */
function QueueRow({ item, onChanged }: { item: QueueItem; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Queue statuses onto the task vocabulary the page already speaks.
  const asTask: TaskStatus =
    item.status === 'running' ? 'in_progress'
    : item.status === 'done' ? 'done'
    : item.status === 'queued' ? 'queued'
    : item.status === 'cancelled' ? 'cancelled'
    : 'failed';
  const meta = STATUS_META[asTask];

  const full =
    (item.payload?.text as string)
    || (item.payload?.task as string)
    || (item.payload?.workflowId as string)
    || item.kind;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); onChanged(); } finally { setBusy(false); }
  };
  const retryable = item.status === 'failed' || item.status === 'cancelled';
  const stoppable = item.status === 'queued' || item.status === 'running';
  // Exclusive by construction: a row is either live (cancel) or finished (clear). `blocked` is
  // neither — it is stopped and waiting on a human, so tidying it away would lose the reason.
  const clearable = ['done', 'failed', 'cancelled'].includes(item.status);

  return (
    <div
      onClick={() => setOpen((v) => !v)}
      className="bg-white/[0.03] border border-white/[0.07] rounded-lg p-4 flex flex-col gap-2 cursor-pointer hover:border-white/20 hover:bg-white/[0.05] transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full border bg-white/[0.04] text-gray-400 border-white/10">
            {item.kind}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {retryable && (
            <button
              onClick={() => void act(() => api.retryQueueItem(item.id))}
              disabled={busy}
              className="px-2 py-1 text-xs rounded transition-colors border bg-violet-900/40 hover:bg-violet-900/70 text-violet-300 border-violet-800/50 disabled:opacity-40"
            >
              Retry
            </button>
          )}
          {stoppable && (
            <button
              onClick={() => void act(() => api.cancelQueueItem(item.id))}
              disabled={busy}
              className="px-2 py-1 text-xs rounded transition-colors border bg-gray-800/60 hover:bg-gray-700/60 text-gray-400 border-gray-700/50 disabled:opacity-40"
            >
              Cancel
            </button>
          )}
          {clearable && (
            <button
              onClick={() => void act(() => api.removeQueueItem(item.id))}
              disabled={busy}
              title="Remove this row. Live work is never clearable."
              className="px-2 py-1 text-xs rounded transition-colors border bg-gray-800/60 hover:bg-gray-700/60 text-gray-500 border-gray-700/50 disabled:opacity-40"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <p className={`text-sm text-gray-300 whitespace-pre-wrap ${open ? '' : 'line-clamp-2'}`}>{full}</p>
      {full.length > 120 && (
        <span className="text-[11px] text-gray-600">{open ? 'Show less' : 'Show the whole request'}</span>
      )}

      <div className="flex items-center gap-2 text-[11px] text-gray-600">
        <span className="font-mono truncate">{item.lane}</span>
      </div>
      {item.error && (
        <p className="text-[11px] text-red-400/90 whitespace-pre-wrap border-t border-white/[0.06] pt-2">{item.error}</p>
      )}
    </div>
  );
}

export function TasksPage({ tasks, agents, createTask, cancelTask, updateTask, dispatchTask, completeTask }: TasksPageProps) {
  // Queue items are shown as rows in the SAME list as tasks. They are the same thing to a user:
  // work that is waiting, running, or finished on a cartridge.
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const refreshQueue = useCallback(() => {
    void api.getQueue().then((v) => setQueueItems(v.items)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const load = refreshQueue;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const [filter, setFilter] = useState<'all' | 'active' | TaskStatus>('active');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const selectedTask = selectedId ? tasks.find((t) => t.id === selectedId) ?? null : null;

  useEffect(() => {
    Promise.all([api.getGoals(), api.getGoalProjects()])
      .then(([g, p]) => { setGoals(g); setProjects(p); })
      .catch(() => { /* tasks still work unpinned if goals/projects fail to load */ });
  }, []);

  /**
   * Queue items under the SAME filter as tasks, by mapping their status onto the task
   * vocabulary. A user picking "Active" means the same thing for both, and asking them to learn
   * two status words for one idea is the duplication we just removed at the tab level.
   */
  const visibleQueue = useMemo(() => {
    const asTaskStatus = (q: QueueItem): TaskStatus =>
      q.status === 'running' ? 'in_progress'
      : q.status === 'done' ? 'done'
      : q.status === 'queued' ? 'queued'
      : q.status === 'cancelled' ? 'cancelled'
      : 'failed'; // failed | blocked
    const rows = [...queueItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    if (filter === 'all') return rows;
    if (filter === 'active') return rows.filter((q) => ['queued', 'running'].includes(q.status));
    return rows.filter((q) => asTaskStatus(q) === filter);
  }, [queueItems, filter]);

  const filtered = useMemo(() => {
    const sorted = [...tasks].sort(
      (a, b) => b.priority - a.priority || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    if (filter === 'all') return sorted;
    if (filter === 'active') return sorted.filter((t) => ['queued', 'claimed', 'in_progress'].includes(t.status));
    return sorted.filter((t) => t.status === filter);
  }, [tasks, filter]);

  /** Remove one finished task. The server refuses anything still live, so a stale list cannot
   *  delete work in flight. */
  const clearTask = useCallback((id: string) => {
    void api.removeTask(id).then(refreshQueue).catch(() => undefined);
  }, [refreshQueue]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    // Queue items count too. The header read "0 queued · 0 active · 1 done" with four queue
    // items listed directly beneath it — a summary that contradicts the list under it teaches
    // the reader to ignore the summary.
    for (const q of queueItems) {
      const k = q.status === 'running' ? 'in_progress'
        : q.status === 'blocked' ? 'failed'
        : q.status;
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [tasks, queueItems]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <SectionTitle>Task queue</SectionTitle>
          <p className="text-[12px] text-gray-600 mt-0.5">
            {(counts.queued || 0)} queued · {(counts.in_progress || 0) + (counts.claimed || 0)} active · {(counts.done || 0)} done
          </p>
        </div>
        {/* No create button, and no bulk clear. Each row carries its own controls: cancel it
            while it is live, clear it once it has finished. A sweep removes rows nobody
            looked at. */}
      </div>

      {/* Lanes only — and only when one has HALTED, which is the single case that needs a
          person. Queue ITEMS are rows in the list below, because a queued prompt is a task;
          giving it its own panel above the list was the same "two lists" complaint in a
          smaller box. */}
      <QueuePanel haltedOnly />

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

      {filtered.length === 0 && visibleQueue.length === 0 ? (
        <div className="text-center py-16 border border-white/[0.06] rounded-xl bg-white/[0.02]">
          <div className="text-3xl mb-3">🗂️</div>
          <h3 className="text-sm font-medium text-gray-400 mb-1">No tasks here</h3>
          <p className="text-[12px] text-gray-600 max-w-sm mx-auto">
            Prompt a cartridge, or start a confer or workflow. Anything aimed at a busy
            cartridge lands here and runs as soon as it is free.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {visibleQueue.map((q) => (
            <QueueRow key={q.id} item={q} onChanged={refreshQueue} />
          ))}
          {filtered.map((t) => (
            <TaskCard key={t.id} task={t} agents={agents} projects={projects} onCancel={cancelTask} onClear={clearTask} onOpen={setSelectedId} />
          ))}
        </div>
      )}

      {creating && <CreateTaskModal onClose={() => setCreating(false)} onCreate={createTask} goals={goals} projects={projects} />}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          agents={agents}
          goals={goals}
          projects={projects}
          onClose={() => setSelectedId(null)}
          updateTask={updateTask}
          dispatchTask={dispatchTask}
          cancelTask={cancelTask}
          completeTask={completeTask}
        />
      )}
    </div>
  );
}
