import { useState, useEffect, useRef, useMemo } from 'react';
import { api, apiFor } from '../lib/api';
import { useSocket } from '../hooks/useSocket';
import type { Machine, ServerEntry } from '../types';
import { activeServers } from '../lib/servers';

/**
 * A machine plus the server that owns it.
 *
 * Machines are NOT gossiped between servers — a runner registers with exactly one. So the
 * launcher has to ask every server itself, and remember which answered, because launching
 * or editing folders has to go back to that same server. Dispatching to the page's own
 * server instead would target a box that has never heard of the machine.
 */
type FleetMachine = Machine & { origin: string };

interface Props {
  /** The fleet roster. Empty/omitted = just the server that served this page. */
  servers?: ServerEntry[];
}

// Agent types the remote runner can launch (it spawns the relay, which defaults to claude).
const AGENT_TYPES: { key: string; label: string; color: string }[] = [
  { key: 'claude', label: 'Claude', color: 'text-blue-400 hover:text-blue-300' },
  { key: 'gridlight', label: 'Gridlight', color: 'text-gl-purple hover:text-purple-300' },
  { key: 'codex', label: 'Codex', color: 'text-green-400 hover:text-green-300' },
];

const OS_LABEL: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * Launch a cartridge on any registered machine (local host or remote) running the runner
 * daemon. Repos come from each machine's allowlist and the launch is dispatched to that
 * machine's runner. Also supports editing a machine's exposed folders inline.
 */
export function MachineLauncher({ servers = [] }: Props) {
  const [machines, setMachines] = useState<FleetMachine[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null); // `${machineId}:${path}`
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Every server we should ask. '' is the server that served this page, and is the only
  // entry when no roster is supplied — which keeps single-server installs behaving exactly
  // as before.
  const bases = useMemo(() => {
    // Collapse aliases of ONE server before querying.
    //
    // The browser stores the server it is on as '' and, once gossip names it, ALSO as the
    // URL that server advertises ('localhost' vs 'mac.local'). Same box, one serverId, two
    // roster rows. Asking both turned a single launch click into two dispatches — and the
    // target machine dutifully opened two terminals.
    //
    // Prefer '' when it is one of the aliases: the same-origin client needs no token and is
    // the connection we already know works.
    const active = activeServers(servers);
    const byIdentity = new Map<string, string>();
    for (const s of active) {
      // No serverId yet (first poll hasn't answered) → key on the URL so it is still asked.
      const key = s.serverId || `url:${s.url}`;
      const existing = byIdentity.get(key);
      if (existing === undefined || (existing !== '' && s.url === '')) byIdentity.set(key, s.url);
    }
    const list = [...byIdentity.values()];
    return list.length > 0 ? list : [''];
  }, [servers]);
  // Primitive dep for the fetch effect: the array identity changes every render.
  const baseKey = bases.join('|');

  /** The client for one server. Mirrors useAgents' clientFor — '' means same-origin. */
  const clientFor = (base: string) => {
    if (!base) return api;
    return apiFor(base, servers.find((s) => s.url === base)?.token);
  };

  const onlineCount = machines.filter((m) => m.status === 'online').length;

  // Live status updates so a machine coming online/offline reflects without reopening.
  useSocket({
    onMachineUpdated: (m) =>
      setMachines((prev) => {
        const i = prev.findIndex((x) => x.id === m.id);
        if (i === -1) return [...prev, { ...m, origin: '' }];
        const next = prev.slice();
        next[i] = { ...m, origin: prev[i].origin };
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
    const fetchMachines = async () => {
      setLoading((prev) => (machines.length === 0 ? true : prev));
      // allSettled, not all: a sleeping laptop in the fleet must not blank the machines
      // from every healthy server. Same tolerance useAgents applies to agents.
      const results = await Promise.allSettled(
        bases.map((base) =>
          clientFor(base)
            .getMachines()
            .then((list) => list.map((m) => ({ ...m, origin: base }))),
        ),
      );
      // Collapse a machine that two servers both know about.
      //
      // A runner keeps ONE stable machineId, so re-pointing it at a different server leaves
      // the old server holding a stale row forever. Rendering both means the same laptop
      // appears twice — once live, once as "Runner not connected" with a frozen folder list
      // — which reads as a broken install rather than as a leftover.
      //
      // The ONLINE copy wins, because exactly one server can hold its live socket. A machine
      // nobody has online is still listed: genuinely offline is worth seeing and explaining,
      // and hiding it is what made folders look lost in the first place.
      const merged = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const byId = new Map<string, FleetMachine>();
      for (const m of merged) {
        const seen = byId.get(m.id);
        if (!seen || (seen.status !== 'online' && m.status === 'online')) byId.set(m.id, m);
      }
      setMachines([...byId.values()]);
      setLoading(false);
    };
    fetchMachines();
    const interval = setInterval(fetchMachines, 20000);
    return () => clearInterval(interval);
  }, [open, baseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setNotice({ kind, msg });
    setTimeout(() => setNotice(null), 5000);
  };

  const launch = async (machine: FleetMachine, repoPath: string, repoName: string, agentType: string) => {
    setOpen(false);
    setExpandedRepo(null);
    try {
      await clientFor(machine.origin).launchOnMachine(machine.id, repoPath, agentType);
      flash('ok', `Launching ${agentType} in ${repoName} on ${machine.hostname}…`);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Launch failed');
    }
  };

  // Push a new folder list to the machine's runner. It validates against its own disk, so
  // an added path that doesn't exist there is silently dropped; the list refreshes via the
  // machine_updated socket event.
  const setRepos = async (m: FleetMachine, repos: { path: string; name?: string }[]) => {
    try {
      await clientFor(m.origin).setMachineRepos(m.id, repos);
      flash('ok', 'Updated exposed folders');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Update failed');
    }
  };
  const removeRepo = (m: FleetMachine, path: string) =>
    setRepos(m, m.repos.filter((r) => r.path !== path).map((r) => ({ path: r.path, name: r.name })));
  const addRepo = (m: FleetMachine) => {
    const p = newPath.trim();
    if (!p) return;
    setNewPath('');
    setRepos(m, [...m.repos.map((r) => ({ path: r.path, name: r.name })), { path: p }]);
  };
  // Treat the input as a parent folder: the runner adds every git repo under it (on its disk).
  const scanFolder = async (m: FleetMachine) => {
    const root = newPath.trim();
    if (!root) return;
    setNewPath('');
    try {
      await clientFor(m.origin).scanMachineFolder(m.id, root);
      flash('ok', `Scanning ${root} on ${m.hostname}…`);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Scan failed');
    }
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
              <div key={`${m.origin}:${m.id}`} className="border-b border-white/5 last:border-0 pb-1 mb-1 last:mb-0 last:pb-0">
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
                  /*
                   * An offline machine used to render the bare word "Offline" and nothing
                   * else — no folder count, no cause, no remedy. That is how a perfectly
                   * good install reads as a broken one: the folders ARE registered and
                   * safe, but with the row silent about them they look lost, and the only
                   * conclusion available is "my repos are gone".
                   *
                   * A runner that is merely disconnected is recoverable, so say that, say
                   * what is still being held, and say how to get it back.
                   */
                  <div className="text-[11px] px-3 pb-1.5 pl-7 space-y-0.5">
                    <div className="text-gray-500">
                      Runner not connected
                      {m.repos.length > 0 && (
                        <> — {m.repos.length} folder{m.repos.length === 1 ? '' : 's'} still registered</>
                      )}
                    </div>
                    <div className="text-gray-600">
                      Start the runner on {m.hostname || 'that machine'} to launch here.
                    </div>
                  </div>
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
                        title="Add this exact folder"
                      >Add</button>
                      <button
                        onClick={() => scanFolder(m)}
                        className="text-[11px] px-2 py-1 rounded bg-white/[0.06] text-gray-300 hover:bg-white/[0.12] transition-colors"
                        title="Add every git repo under this folder"
                      >Scan</button>
                    </div>
                    <div className="text-[10px] text-gray-600 pt-0.5">
                      <b>Add</b> = this exact folder. <b>Scan</b> = every git repo under it. Paths are on that machine; missing ones are ignored.
                    </div>
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
