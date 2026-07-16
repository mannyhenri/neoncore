import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import type { Machine } from '../types';

// Agent types the remote runner can launch (it spawns the relay, which defaults to claude).
const AGENT_TYPES: { key: string; label: string; color: string }[] = [
  { key: 'claude', label: 'Claude', color: 'text-blue-400 hover:text-blue-300' },
  { key: 'gridlight', label: 'Gridlight', color: 'text-gl-purple hover:text-purple-300' },
  { key: 'gemini', label: 'Gemini', color: 'text-teal-400 hover:text-teal-300' },
  { key: 'codex', label: 'Codex', color: 'text-green-400 hover:text-green-300' },
];

const OS_LABEL: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * Launch a cartridge on any registered machine (local host or remote) running the runner
 * daemon. Repos come from each machine's allowlist and the launch is dispatched to that
 * machine's runner. Also supports editing a machine's exposed folders inline.
 */
export function MachineLauncher() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null); // `${machineId}:${path}`
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const onlineCount = machines.filter((m) => m.status === 'online').length;

  // Live status updates so a machine coming online/offline reflects without reopening.
  useSocket({
    onMachineUpdated: (m) =>
      setMachines((prev) => {
        const i = prev.findIndex((x) => x.id === m.id);
        if (i === -1) return [...prev, m];
        const next = prev.slice();
        next[i] = m;
        return next;
      }),
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedRepo(null);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const fetchMachines = () => {
      setLoading((prev) => (machines.length === 0 ? true : prev));
      api.getMachines().then(setMachines).catch(() => setMachines([])).finally(() => setLoading(false));
    };
    fetchMachines();
    const interval = setInterval(fetchMachines, 20000);
    return () => clearInterval(interval);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setNotice({ kind, msg });
    setTimeout(() => setNotice(null), 5000);
  };

  const launch = async (machine: Machine, repoPath: string, repoName: string, agentType: string) => {
    setOpen(false);
    setExpandedRepo(null);
    try {
      await api.launchOnMachine(machine.id, repoPath, agentType);
      flash('ok', `Launching ${agentType} in ${repoName} on ${machine.hostname}…`);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Launch failed');
    }
  };

  // Push a new folder list to the machine's runner. It validates against its own disk, so
  // an added path that doesn't exist there is silently dropped; the list refreshes via the
  // machine_updated socket event.
  const setRepos = async (m: Machine, repos: { path: string; name?: string }[]) => {
    try {
      await api.setMachineRepos(m.id, repos);
      flash('ok', 'Updated exposed folders');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Update failed');
    }
  };
  const removeRepo = (m: Machine, path: string) =>
    setRepos(m, m.repos.filter((r) => r.path !== path).map((r) => ({ path: r.path, name: r.name })));
  const addRepo = (m: Machine) => {
    const p = newPath.trim();
    if (!p) return;
    setNewPath('');
    setRepos(m, [...m.repos.map((r) => ({ path: r.path, name: r.name })), { path: p }]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); setExpandedRepo(null); }}
        className="text-sm text-gray-400 hover:text-white border border-white/10 hover:border-white/20 px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5"
        title="Launch a cartridge on a registered machine"
      >
        + Launch
        {onlineCount > 0 && (
          <span className="text-[10px] px-1.5 rounded-full bg-emerald-500/25 text-emerald-300">{onlineCount}</span>
        )}
      </button>

      {notice && (
        <div className={`absolute right-0 top-full mt-1.5 z-50 text-xs rounded-lg px-3 py-2 max-w-xs border ${
          notice.kind === 'ok'
            ? 'bg-emerald-900/90 border-emerald-700 text-emerald-200'
            : 'bg-red-900/90 border-red-700 text-red-300'
        }`}>
          {notice.msg}
        </div>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 glass rounded-xl shadow-2xl py-1.5 min-w-[260px] max-h-[440px] overflow-y-auto">
          {loading ? (
            <div className="text-xs text-gray-500 px-3 py-2">Loading…</div>
          ) : machines.length === 0 ? (
            <div className="text-xs text-gray-500 px-3 py-2 leading-relaxed">
              No machines registered. Run the <span className="text-gray-300">runner</span> daemon
              on a computer (see <span className="text-gray-300">agent/runner</span>) to launch there.
            </div>
          ) : (
            machines.map((m) => {
              const editing = editingId === m.id;
              return (
              <div key={m.id} className="border-b border-white/5 last:border-0 pb-1 mb-1 last:mb-0 last:pb-0">
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.status === 'online' ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                  <span className="text-xs text-gray-200 font-medium flex-1 truncate">{m.hostname || m.id.slice(0, 8)}</span>
                  {m.status === 'online' && (
                    <button
                      onClick={() => { setEditingId(editing ? null : m.id); setExpandedRepo(null); setNewPath(''); }}
                      className="text-[10px] text-gray-500 hover:text-violet-300 transition-colors"
                    >
                      {editing ? 'Done' : 'Edit folders'}
                    </button>
                  )}
                  <span className="text-[10px] text-gray-500">{OS_LABEL[m.platform] || m.platform}</span>
                </div>

                {m.status !== 'online' ? (
                  <div className="text-[11px] text-gray-600 px-3 pb-1 pl-7">Offline</div>
                ) : editing ? (
                  <div className="px-3 pb-2 pl-7 space-y-1">
                    {m.repos.length === 0 && <div className="text-[11px] text-gray-600">No folders yet — add one below.</div>}
                    {m.repos.map((repo) => (
                      <div key={repo.path} className="flex items-center gap-2 text-xs text-gray-300">
                        <span className="flex-1 truncate" title={repo.path}>{repo.name}</span>
                        <button
                          onClick={() => removeRepo(m, repo.path)}
                          className="text-gray-600 hover:text-red-400 transition-colors px-1"
                          title={`Remove ${repo.path}`}
                        >×</button>
                      </div>
                    ))}
                    <div className="flex items-center gap-1 pt-1">
                      <input
                        value={newPath}
                        onChange={(e) => setNewPath(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addRepo(m); }}
                        placeholder={m.platform === 'win32' ? 'C:\\code\\project' : '/path/to/project'}
                        className="flex-1 text-[11px] glass-input text-gray-300 rounded px-2 py-1 placeholder-gray-600 focus:outline-none"
                      />
                      <button
                        onClick={() => addRepo(m)}
                        className="text-[11px] px-2 py-1 rounded bg-violet-900/40 text-violet-300 hover:bg-violet-900/70 transition-colors"
                      >Add</button>
                    </div>
                    <div className="text-[10px] text-gray-600 pt-0.5">A path that doesn’t exist on that machine is ignored.</div>
                  </div>
                ) : m.repos.length === 0 ? (
                  <div className="text-[11px] text-gray-600 px-3 pb-1 pl-7">No folders — click “Edit folders”.</div>
                ) : (
                  m.repos.map((repo) => {
                    const rid = `${m.id}:${repo.path}`;
                    return (
                      <div key={rid}>
                        <button
                          onClick={() => setExpandedRepo(expandedRepo === rid ? null : rid)}
                          className="w-full text-left text-xs text-gray-300 hover:bg-white/5 hover:text-white px-3 py-1.5 pl-7 transition-colors flex items-center gap-2"
                        >
                          <span className="flex-1 truncate">{repo.name}</span>
                          <span className={`text-gray-600 text-[13px] transition-transform ${expandedRepo === rid ? 'rotate-90' : ''}`}>▶</span>
                        </button>
                        {expandedRepo === rid && (
                          <div className="flex flex-wrap gap-1 px-3 pb-1.5 pl-9">
                            {AGENT_TYPES.map((t) => (
                              <button
                                key={t.key}
                                onClick={() => launch(m, repo.path, repo.name, t.key)}
                                className={`text-[13px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors ${t.color}`}
                              >
                                {t.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
