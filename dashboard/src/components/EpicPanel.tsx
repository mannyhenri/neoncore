import { useState, useEffect, useCallback, useRef } from 'react';
import type { Agent, EpicRun, EpicRunConfig, EpicTaskState } from '../types';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';

interface Props {
  agents: Agent[];
}

const DEFAULT_CONFIG: EpicRunConfig = {
  idleThresholdMs: 45000,
  commitCommand: '/commit-push',
  taskPromptTemplate: '',
  skipCommitOnLast: false,
  autoEnableTrust: true,
  taskPrefix: '.claude/tasks/',
};

export function EpicPanel({ agents }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [runs, setRuns] = useState<EpicRun[]>([]);
  const [creating, setCreating] = useState(false);

  const loadRuns = useCallback(async () => {
    try {
      const data = await api.getEpicRuns();
      setRuns(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadRuns();
    const interval = setInterval(loadRuns, 10_000);
    return () => clearInterval(interval);
  }, [loadRuns]);

  useSocket({
    onEpicUpdated: (run) => {
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === run.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = run;
          return next;
        }
        return [run, ...prev];
      });
    },
    onReconnect: loadRuns,
  });

  const activeCount = runs.filter((r) => ['running', 'committing', 'paused'].includes(r.status)).length;

  return (
    <div className="glass rounded-xl md:rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 md:px-6 md:py-4 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
          </svg>
          <span className="text-gray-400 text-sm font-semibold uppercase tracking-wide">Epic Autopilot</span>
          {activeCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-900/50 text-purple-400 animate-pulse">
              {activeCount} active
            </span>
          )}
        </div>
        <span className="text-xs text-gray-600">
          {runs.length} run{runs.length !== 1 ? 's' : ''}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 md:px-6 md:pb-6 space-y-3">
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              className="text-xs px-3 py-1.5 gl-gradient hover:opacity-90 text-white rounded-md transition-opacity"
            >
              + Start Epic
            </button>
          )}

          {creating && (
            <EpicCreator
              agents={agents}
              onStart={async (data) => {
                await api.startEpic(data);
                setCreating(false);
                loadRuns();
              }}
              onCancel={() => setCreating(false)}
            />
          )}

          {runs.length === 0 && !creating && (
            <p className="text-sm text-gray-600 italic text-center py-4">No epic runs yet</p>
          )}

          {runs.map((run) => (
            <EpicRunCard key={run.id} run={run} agents={agents} onAction={loadRuns} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Create Epic Dialog ───────────────────────────────

interface DiscoveredTask {
  taskId: string;
  label: string;
  taskFilePath: string;
  selected: boolean;
}

interface CreatorProps {
  agents: Agent[];
  onStart: (data: { name: string; agentId: string; tasks: { taskId: string; label?: string; taskFilePath?: string }[]; config?: Partial<EpicRunConfig>; startPaused?: boolean }) => Promise<void>;
  onCancel: () => void;
}

function EpicCreator({ agents, onStart, onCancel }: CreatorProps) {
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [config, setConfig] = useState<Partial<EpicRunConfig>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Discovery state
  const [scanning, setScanning] = useState(false);
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [epics, setEpics] = useState<{ name: string; filename: string }[]>([]);
  const [selectedPrefix, setSelectedPrefix] = useState('');
  const [discoveredTasks, setDiscoveredTasks] = useState<DiscoveredTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  // Range selection for starting from a specific task
  const [startFrom, setStartFrom] = useState(0);

  // Worktree state
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [worktreeStatus, setWorktreeStatus] = useState<'idle' | 'creating' | 'opening' | 'waiting' | 'starting' | 'ready'>('idle');
  const [worktreePath, setWorktreePath] = useState('');
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  const pendingStartRef = useRef<{
    name: string;
    tasks: { taskId: string; label?: string; taskFilePath?: string }[];
    config?: Partial<EpicRunConfig>;
  } | null>(null);

  const onlineAgents = agents.filter((a) => a.status !== 'offline');

  // Scan agent's repo when agent is selected
  const handleAgentChange = async (newAgentId: string) => {
    setAgentId(newAgentId);
    setPrefixes([]);
    setEpics([]);
    setSelectedPrefix('');
    setDiscoveredTasks([]);
    setStartFrom(0);

    if (!newAgentId) return;

    setScanning(true);
    try {
      const result = await api.scanEpics(newAgentId);
      setPrefixes(result.prefixes);
      setEpics(result.epics);
    } catch {
      // Agent might not have a .claude directory — that's fine
    } finally {
      setScanning(false);
    }
  };

  // Load tasks when prefix is selected
  const handlePrefixChange = async (prefix: string) => {
    setSelectedPrefix(prefix);
    setDiscoveredTasks([]);
    setStartFrom(0);
    setWorktreeBranch(`epic/${prefix.toLowerCase()}`);

    if (!prefix || !agentId) return;

    setLoadingTasks(true);
    try {
      const result = await api.scanTasks(agentId, prefix);
      setDiscoveredTasks(result.tasks.map((t) => ({ ...t, selected: true })));
      if (!name) {
        setName(prefix);
      }
    } catch {
      setError('Failed to scan tasks');
    } finally {
      setLoadingTasks(false);
    }
  };

  const toggleTask = (idx: number) => {
    setDiscoveredTasks((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], selected: !next[idx].selected };
      return next;
    });
  };

  const selectAll = () => setDiscoveredTasks((prev) => prev.map((t) => ({ ...t, selected: true })));
  const selectNone = () => setDiscoveredTasks((prev) => prev.map((t) => ({ ...t, selected: false })));

  // Watch for new agent when waiting for worktree to connect
  useEffect(() => {
    if (worktreeStatus !== 'waiting' || !worktreePath || !pendingStartRef.current) return;

    const normalizedPath = worktreePath.replace(/\/+$/, '');
    const match = agents.find((a) => {
      const agentPath = (a.repoPath || '').replace(/\/+$/, '');
      return agentPath === normalizedPath && a.status !== 'offline';
    });

    if (match) {
      setWorktreeStatus('starting');
      const startData = pendingStartRef.current;
      // Start the epic in paused mode — user needs to open Claude Code first, then resume
      const timer = setTimeout(async () => {
        try {
          await onStartRef.current({ ...startData, agentId: match.id, startPaused: true });
          setWorktreeStatus('ready');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to start epic');
          setWorktreeStatus('idle');
          setSubmitting(false);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [agents, worktreeStatus, worktreePath]);

  // Timeout for waiting state
  useEffect(() => {
    if (worktreeStatus !== 'waiting') return;
    const timer = setTimeout(() => {
      setError('Timed out waiting for agent to connect. Make sure VS Code opened the worktree and the NeonCore extension is active.');
      setWorktreeStatus('idle');
      setSubmitting(false);
    }, 90_000);
    return () => clearTimeout(timer);
  }, [worktreeStatus]);

  const selectedTasks = discoveredTasks.filter((t) => t.selected);
  const tasksFromStart = selectedTasks.slice(startFrom);

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Epic name required'); return; }
    if (!agentId) { setError('Select an agent'); return; }
    if (tasksFromStart.length === 0) { setError('Select at least one task'); return; }

    setSubmitting(true);
    setError('');

    const taskData = tasksFromStart.map((t) => ({ taskId: t.taskId, label: t.label, taskFilePath: t.taskFilePath }));
    const epicConfig = Object.keys(config).length > 0 ? config : undefined;

    if (useWorktree) {
      if (!worktreeBranch.trim()) { setError('Branch name required'); setSubmitting(false); return; }

      try {
        // Step 1: Create worktree
        setWorktreeStatus('creating');
        const result = await api.createWorktree(agentId, worktreeBranch.trim());
        setWorktreePath(result.path);

        // Step 2: Open in VS Code
        setWorktreeStatus('opening');
        await api.openWorktree(agentId, result.path);

        // Step 3: Wait for agent to connect (useEffect handles detection + auto-start)
        setWorktreeStatus('waiting');
        pendingStartRef.current = { name: name.trim(), tasks: taskData, config: epicConfig };
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create worktree');
        setWorktreeStatus('idle');
        setSubmitting(false);
      }
    } else {
      try {
        await onStart({ name: name.trim(), agentId, tasks: taskData, config: epicConfig });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start epic');
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="glass-light rounded-lg p-3 space-y-3">
      <div className="text-sm font-medium text-gray-300">New Epic Run</div>

      {error && (
        <div className="text-xs text-red-400 bg-red-900/30 rounded px-2 py-1">{error}</div>
      )}

      <div className="space-y-2">
        {/* Step 1: Pick agent */}
        <select
          value={agentId}
          onChange={(e) => handleAgentChange(e.target.value)}
          className="w-full text-sm bg-black/30 border border-white/10 rounded-md px-3 py-1.5 text-gray-200 focus:outline-none focus:border-gl-purple/50"
        >
          <option value="">Select agent...</option>
          {onlineAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.status})
            </option>
          ))}
        </select>

        {scanning && (
          <div className="text-xs text-gray-500 animate-pulse">Scanning repo for epics and tasks...</div>
        )}

        {/* Step 2: Pick epic/prefix (auto-discovered) */}
        {agentId && !scanning && (prefixes.length > 0 || epics.length > 0) && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Select epic</div>
            <div className="flex flex-wrap gap-1.5">
              {prefixes.map((p) => (
                <button
                  key={p}
                  onClick={() => handlePrefixChange(p)}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    selectedPrefix === p
                      ? 'border-gl-purple/50 bg-gl-purple/20 text-gl-purple'
                      : 'border-white/10 text-gray-400 hover:border-white/20 hover:text-gray-300'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* No epics found — show manual prefix input */}
        {agentId && !scanning && prefixes.length === 0 && epics.length === 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-500">No .claude/tasks/ found. Enter task prefix manually:</div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Task prefix (e.g., D2V)"
                value={selectedPrefix}
                onChange={(e) => setSelectedPrefix(e.target.value)}
                className="flex-1 text-sm bg-black/30 border border-white/10 rounded-md px-3 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gl-purple/50 font-mono"
              />
              <button
                onClick={() => handlePrefixChange(selectedPrefix)}
                disabled={!selectedPrefix}
                className="text-xs px-3 py-1.5 gl-gradient hover:opacity-90 text-white rounded-md disabled:opacity-50"
              >
                Scan
              </button>
            </div>
          </div>
        )}

        {loadingTasks && (
          <div className="text-xs text-gray-500 animate-pulse">Loading tasks...</div>
        )}

        {/* Step 3: Review discovered tasks */}
        {discoveredTasks.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">
                Tasks ({selectedTasks.length} selected, starting from #{startFrom + 1})
              </div>
              <div className="flex gap-2">
                <button onClick={selectAll} className="text-[10px] text-gray-500 hover:text-gray-300">All</button>
                <button onClick={selectNone} className="text-[10px] text-gray-500 hover:text-gray-300">None</button>
              </div>
            </div>

            {/* Start from selector */}
            {selectedTasks.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-gray-500 shrink-0">Start from:</label>
                <select
                  value={startFrom}
                  onChange={(e) => setStartFrom(Number(e.target.value))}
                  className="text-xs bg-black/30 border border-white/10 rounded px-2 py-0.5 text-gray-300 focus:outline-none focus:border-gl-purple/50"
                >
                  {selectedTasks.map((t, i) => (
                    <option key={i} value={i}>#{i + 1} — {t.taskId}</option>
                  ))}
                </select>
                <span className="text-[10px] text-gray-600">
                  ({tasksFromStart.length} task{tasksFromStart.length !== 1 ? 's' : ''} will run)
                </span>
              </div>
            )}

            <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-md bg-black/20 p-1.5">
              {discoveredTasks.map((task, i) => {
                const isBeforeStart = task.selected && selectedTasks.indexOf(task) < startFrom;
                return (
                  <label
                    key={i}
                    className={`flex items-center gap-2 text-[11px] px-2 py-0.5 rounded cursor-pointer hover:bg-white/[0.04] ${
                      isBeforeStart ? 'opacity-40' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={task.selected}
                      onChange={() => toggleTask(i)}
                      className="rounded"
                    />
                    <span className="font-mono text-gray-300">{task.taskId}</span>
                    {task.label !== task.taskId && (
                      <span className="text-gray-500 truncate">{task.label.replace(`${task.taskId}: `, '')}</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Worktree setup */}
        {discoveredTasks.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-white/[0.06]">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
                className="rounded"
              />
              Create worktree for this epic
            </label>

            {useWorktree && (
              <div className="space-y-1.5 pl-5">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-gray-500 shrink-0">Branch</label>
                  <input
                    type="text"
                    value={worktreeBranch}
                    onChange={(e) => setWorktreeBranch(e.target.value)}
                    placeholder="epic/d2v"
                    className="flex-1 text-xs bg-black/30 border border-white/10 rounded px-2 py-1 text-gray-300 font-mono focus:outline-none focus:border-gl-purple/50"
                  />
                </div>
                <div className="text-[10px] text-gray-600">
                  Creates a worktree from {agents.find((a) => a.id === agentId)?.repoName || 'source repo'}, opens in VS Code, and starts the epic on the new agent
                </div>
              </div>
            )}
          </div>
        )}

        {/* Epic name */}
        {discoveredTasks.length > 0 && (
          <input
            type="text"
            placeholder="Epic name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full text-sm bg-black/30 border border-white/10 rounded-md px-3 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gl-purple/50"
          />
        )}

        {/* Advanced config — hidden while autopilot is disabled
        {discoveredTasks.length > 0 && (
          <>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-[10px] text-gray-500 hover:text-gray-400 transition-colors"
            >
              {showAdvanced ? '▼' : '▶'} Advanced config
            </button>

            {showAdvanced && (
              <div className="space-y-2 pl-2 border-l border-white/5">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-gray-500 w-24 shrink-0">Commit cmd</label>
                  <input
                    type="text"
                    value={config.commitCommand ?? DEFAULT_CONFIG.commitCommand}
                    onChange={(e) => setConfig({ ...config, commitCommand: e.target.value })}
                    className="flex-1 text-xs bg-black/30 border border-white/10 rounded px-2 py-1 text-gray-300 font-mono focus:outline-none focus:border-gl-purple/50"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-gray-500 w-24 shrink-0">Idle threshold</label>
                  <input
                    type="range"
                    min={15}
                    max={120}
                    value={(config.idleThresholdMs ?? DEFAULT_CONFIG.idleThresholdMs) / 1000}
                    onChange={(e) => setConfig({ ...config, idleThresholdMs: Number(e.target.value) * 1000 })}
                    className="flex-1"
                  />
                  <span className="text-[10px] text-gray-500 w-8 text-right">
                    {(config.idleThresholdMs ?? DEFAULT_CONFIG.idleThresholdMs) / 1000}s
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[10px] text-gray-500 w-24 shrink-0">Prompt template</label>
                  <textarea
                    placeholder="Custom prompt (use {{taskId}}, {{taskFilePath}}, {{label}})"
                    value={config.taskPromptTemplate ?? ''}
                    onChange={(e) => setConfig({ ...config, taskPromptTemplate: e.target.value })}
                    rows={2}
                    className="flex-1 text-xs bg-black/30 border border-white/10 rounded px-2 py-1 text-gray-300 font-mono focus:outline-none focus:border-gl-purple/50"
                  />
                </div>
                <label className="flex items-center gap-2 text-[10px] text-gray-500">
                  <input
                    type="checkbox"
                    checked={config.autoEnableTrust ?? DEFAULT_CONFIG.autoEnableTrust}
                    onChange={(e) => setConfig({ ...config, autoEnableTrust: e.target.checked })}
                    className="rounded"
                  />
                  Auto-enable trust mode
                </label>
                <label className="flex items-center gap-2 text-[10px] text-gray-500">
                  <input
                    type="checkbox"
                    checked={config.skipCommitOnLast ?? DEFAULT_CONFIG.skipCommitOnLast}
                    onChange={(e) => setConfig({ ...config, skipCommitOnLast: e.target.checked })}
                    className="rounded"
                  />
                  Skip commit on last task
                </label>
              </div>
            )}
          </>
        )}
        */}
      </div>

      {/* Worktree progress */}
      {worktreeStatus !== 'idle' && (
        <div className="space-y-1 p-2 rounded-md bg-black/20">
          <WorktreeProgress status={worktreeStatus} branch={worktreeBranch} />
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          disabled={worktreeStatus !== 'idle' && worktreeStatus !== 'starting' && worktreeStatus !== 'ready'}
          className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-30"
        >
          Cancel
        </button>
        {discoveredTasks.length > 0 && worktreeStatus === 'idle' && (
          <button
            onClick={handleSubmit}
            disabled={submitting || tasksFromStart.length === 0}
            className="text-xs px-3 py-1.5 gl-gradient hover:opacity-90 text-white rounded-md transition-opacity disabled:opacity-50"
          >
            {submitting
              ? 'Starting...'
              : useWorktree
                ? `Create Worktree & Start (${tasksFromStart.length} tasks)`
                : `Start Epic (${tasksFromStart.length} tasks)`
            }
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Epic Run Card ────────────────────────────────────

interface RunCardProps {
  run: EpicRun;
  agents: Agent[];
  onAction: () => void;
}

function EpicRunCard({ run, agents, onAction }: RunCardProps) {
  const agent = agents.find((a) => a.id === run.agentId);
  const completedCount = run.tasks.filter((t) => t.status === 'completed').length;
  const skippedCount = run.tasks.filter((t) => t.status === 'skipped').length;
  const [showTasks, setShowTasks] = useState(run.status !== 'completed' && run.status !== 'cancelled');

  const handleAction = async (action: () => Promise<unknown>) => {
    try { await action(); onAction(); } catch { /* ignore */ }
  };

  const statusBadge = () => {
    const styles: Record<string, string> = {
      running: 'bg-blue-900/50 text-blue-400 animate-pulse',
      committing: 'bg-yellow-900/50 text-yellow-400 animate-pulse',
      paused: 'bg-orange-900/50 text-orange-400',
      completed: 'bg-green-900/50 text-green-400',
      failed: 'bg-red-900/50 text-red-400',
      cancelled: 'bg-gray-700/50 text-gray-400',
      pending: 'bg-gray-700/50 text-gray-400',
    };
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${styles[run.status] || styles.pending}`}>
        {run.status}
      </span>
    );
  };

  return (
    <div className="glass-light rounded-lg p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-200 font-medium">{run.name}</span>
            {statusBadge()}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            {agent?.name || run.agentId.slice(0, 8)} · {completedCount}/{run.tasks.length} tasks
            {skippedCount > 0 && ` · ${skippedCount} skipped`}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 shrink-0">
          {run.status === 'running' || run.status === 'committing' ? (
            <button
              onClick={() => handleAction(() => api.pauseEpic(run.id))}
              className="text-[10px] px-2 py-0.5 text-orange-400 hover:bg-orange-900/30 rounded transition-colors"
            >
              Pause
            </button>
          ) : run.status === 'paused' ? (
            <button
              onClick={() => handleAction(() => api.resumeEpic(run.id))}
              className="text-[10px] px-2 py-0.5 text-blue-400 hover:bg-blue-900/30 rounded transition-colors"
            >
              Resume
            </button>
          ) : null}

          {['running', 'committing', 'failed'].includes(run.status) && (
            <button
              onClick={() => handleAction(() => api.skipEpicTask(run.id))}
              className="text-[10px] px-2 py-0.5 text-gray-400 hover:bg-white/[0.06] rounded transition-colors"
              title="Skip current task"
            >
              Skip
            </button>
          )}

          {run.status === 'failed' && (
            <button
              onClick={() => handleAction(() => api.retryEpicTask(run.id))}
              className="text-[10px] px-2 py-0.5 text-yellow-400 hover:bg-yellow-900/30 rounded transition-colors"
            >
              Retry
            </button>
          )}

          {!['completed', 'cancelled'].includes(run.status) && (
            <button
              onClick={() => handleAction(() => api.cancelEpic(run.id))}
              className="text-[10px] px-2 py-0.5 text-red-400 hover:bg-red-900/30 rounded transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden bg-black/30">
        {run.tasks.map((task, i) => {
          const colors: Record<string, string> = {
            completed: 'bg-green-500',
            running: 'bg-blue-500 animate-pulse',
            committing: 'bg-yellow-500 animate-pulse',
            failed: 'bg-red-500',
            skipped: 'bg-gray-600',
            pending: 'bg-gray-800',
          };
          return (
            <div
              key={i}
              className={`flex-1 ${colors[task.status] || colors.pending} transition-colors`}
              title={`${task.taskId}: ${task.status}`}
            />
          );
        })}
      </div>

      {/* Error */}
      {run.error && (
        <div className="text-[10px] text-red-400 bg-red-900/20 rounded px-2 py-1">{run.error}</div>
      )}

      {/* Expandable task list */}
      <button
        onClick={() => setShowTasks(!showTasks)}
        className="text-[10px] text-gray-500 hover:text-gray-400 transition-colors"
      >
        {showTasks ? '▼' : '▶'} Tasks ({run.tasks.length})
      </button>

      {showTasks && (
        <div className="space-y-0.5 max-h-48 overflow-y-auto">
          {run.tasks.map((task, i) => (
            <TaskRow key={i} task={task} isCurrent={i === run.currentTask && !['completed', 'cancelled'].includes(run.status)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Task Row ─────────────────────────────────────────

function TaskRow({ task, isCurrent }: { task: EpicTaskState; isCurrent: boolean }) {
  const icons: Record<string, string> = {
    pending: '○',
    running: '●',
    committing: '◐',
    completed: '✓',
    skipped: '⊘',
    failed: '✗',
  };

  const colors: Record<string, string> = {
    pending: 'text-gray-600',
    running: 'text-blue-400',
    committing: 'text-yellow-400',
    completed: 'text-green-400',
    skipped: 'text-gray-500',
    failed: 'text-red-400',
  };

  return (
    <div
      className={`flex items-center gap-2 text-[11px] px-2 py-0.5 rounded ${
        isCurrent ? 'bg-white/[0.04]' : ''
      }`}
    >
      <span className={`${colors[task.status]} ${task.status === 'running' || task.status === 'committing' ? 'animate-pulse' : ''}`}>
        {icons[task.status] || '○'}
      </span>
      <span className={`font-mono ${isCurrent ? 'text-gray-200' : 'text-gray-400'}`}>
        {task.taskId}
      </span>
      {task.label !== task.taskId && (
        <span className="text-gray-600 truncate">{task.label}</span>
      )}
      {task.status === 'committing' && (
        <span className="text-yellow-500/70 text-[9px] ml-auto">committing...</span>
      )}
      {task.error && (
        <span className="text-red-400 text-[9px] ml-auto truncate max-w-32" title={task.error}>
          {task.error}
        </span>
      )}
    </div>
  );
}

// ─── Worktree Progress ────────────────────────────────

function WorktreeProgress({ status, branch }: { status: string; branch: string }) {
  const steps = [
    { key: 'creating', label: `Creating worktree (${branch})` },
    { key: 'opening', label: 'Opening in VS Code' },
    { key: 'waiting', label: 'Waiting for agent to connect' },
    { key: 'starting', label: 'Agent connected — creating epic' },
    { key: 'ready', label: 'Open Claude Code in VS Code, then Resume the epic' },
  ];

  const currentIdx = steps.findIndex((s) => s.key === status);

  return (
    <>
      {steps.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        return (
          <div
            key={step.key}
            className={`flex items-center gap-2 text-[11px] ${
              isDone ? 'text-green-400' : isActive ? (step.key === 'ready' ? 'text-amber-400' : 'text-blue-400') : 'text-gray-600'
            }`}
          >
            <span className={isActive ? 'animate-pulse' : ''}>
              {isDone ? '✓' : isActive ? '●' : '○'}
            </span>
            <span>{step.label}{isActive && step.key !== 'ready' ? '...' : ''}</span>
          </div>
        );
      })}
    </>
  );
}
